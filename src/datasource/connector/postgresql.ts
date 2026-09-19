/**
 * PostgreSQL 连接器。
 *
 * 元数据走 `pg_catalog`：一次查询拿到 schema 内所有表的列、类型、注释与主键，
 * 行数取 `reltuples`（规划器估计值，未分析过的表为 -1）。
 */

import { loadPgDriver, type PgPoolLike } from '../driver'
import { DataSourceError, wrapConnectionError } from '../errors'
import type { ColumnType } from '../../parse'
import type {
  ConnectionConfig,
  ConnectionTestResult,
  RemoteColumn,
  RemoteTable,
  SchemaSummary,
} from '../types'
import { DatabaseConnector } from './base'

interface ColumnRow {
  table_name: string
  estimate: number | string | null
  column_name: string | null
  column_type: string | null
  is_nullable: boolean | null
  column_comment: string | null
  is_primary: boolean | null
}

/** 只取普通表 / 分区表 / 物化视图：排除系统目录与索引。 */
const RELKINDS = "'r','p','m','v','f'"

const TABLE_COLUMNS_SQL = `
SELECT c.relname AS table_name,
       c.reltuples::bigint AS estimate,
       a.attname AS column_name,
       format_type(a.atttypid, a.atttypmod) AS column_type,
       NOT a.attnotnull AS is_nullable,
       col_description(a.attrelid, a.attnum) AS column_comment,
       pk.attnum IS NOT NULL AS is_primary
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN (SELECT i.indrelid, i.indkey[0] AS attnum FROM pg_index i WHERE i.indisprimary) pk
  ON pk.indrelid = c.oid AND pk.attnum = a.attnum
WHERE n.nspname = $1 AND c.relkind IN (${RELKINDS})
ORDER BY c.relname, a.attnum`

const ONE_TABLE_COLUMNS_SQL = `
SELECT a.attname AS column_name,
       format_type(a.atttypid, a.atttypmod) AS column_type,
       NOT a.attnotnull AS is_nullable,
       col_description(a.attrelid, a.attnum) AS column_comment,
       pk.attnum IS NOT NULL AS is_primary
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN (SELECT i.indrelid, i.indkey[0] AS attnum FROM pg_index i WHERE i.indisprimary) pk
  ON pk.indrelid = c.oid AND pk.attnum = a.attnum
WHERE n.nspname = $1 AND c.relname = $2
ORDER BY a.attnum`

function poolOptions(config: ConnectionConfig): Record<string, unknown> {
  const options: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    max: config.poolMax ?? 5,
    connectionTimeoutMillis: config.connectTimeoutMs,
  }
  if (config.sslMode !== null && config.sslMode !== 'disable') {
    options.ssl = { rejectUnauthorized: config.sslMode === 'verify-full' || config.sslMode === 'verify-ca' }
  }
  return options
}

/** `format_type` 的输出形如 `character varying(255)` / `timestamp with time zone`。 */
function mapPgType(formatType: string): ColumnType {
  const base = formatType.split('(')[0].trim().split(' ')[0].toLowerCase()
  if (base === 'bool' || base === 'boolean') return 'boolean'
  if (['int2', 'int4', 'int8', 'smallint', 'int', 'integer', 'bigint', 'serial', 'bigserial'].includes(base)) return 'numeric'
  if (['numeric', 'decimal', 'real', 'float', 'float4', 'float8', 'double', 'money'].includes(base)) return 'numeric'
  if (['date', 'time', 'timestamp', 'timestamptz', 'interval'].includes(base)) return 'date'
  return 'text'
}

function toRemoteColumn(row: ColumnRow): RemoteColumn {
  const comment = row.column_comment === null || row.column_comment === undefined ? null : String(row.column_comment)
  return {
    name: String(row.column_name ?? ''),
    nativeType: mapPgType(String(row.column_type ?? '')),
    nullable: row.is_nullable === true,
    comment: comment === null || comment.length === 0 ? null : comment,
  }
}

function groupTables(rows: readonly ColumnRow[], schemaName: string): RemoteTable[] {
  const byName = new Map<string, RemoteTable>()
  for (const row of rows) {
    let table = byName.get(row.table_name)
    if (table === undefined) {
      table = {
        tableName: row.table_name,
        schemaName,
        rowCount: Number(row.estimate ?? -1),
        primaryKey: null,
        columns: [],
      }
      byName.set(row.table_name, table)
    }
    if (row.column_name !== null) {
      const column = toRemoteColumn(row)
      table.columns.push(column)
      if (row.is_primary === true && table.primaryKey === null) table.primaryKey = column.name
    }
  }
  return [...byName.values()]
}

export class PostgreSQLConnector extends DatabaseConnector {
  private pool: PgPoolLike | null = null

  async connect(): Promise<void> {
    if (this.pool !== null) return
    const pg = await loadPgDriver()
    this.pool = new pg.Pool(poolOptions(this.config))
  }

  async disconnect(): Promise<void> {
    const pool = this.pool
    this.pool = null
    if (pool !== null) await pool.end()
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const startedAt = Date.now()
    let pool: PgPoolLike | null = null
    try {
      const pg = await loadPgDriver()
      pool = new pg.Pool({ ...poolOptions(this.config), max: 1 })
      const result = await pool.query('SELECT version() AS version')
      const version = (result.rows[0] as { version?: unknown } | undefined)?.version
      return {
        success: true,
        latency: Date.now() - startedAt,
        version: version === undefined ? null : String(version),
        error: null,
      }
    } catch (error) {
      return { success: false, latency: Date.now() - startedAt, version: null, error: describe(error) }
    } finally {
      if (pool !== null) await pool.end().catch(() => undefined)
    }
  }

  async getSchemas(): Promise<SchemaSummary[]> {
    const rows = await this.query(`
      SELECT n.nspname AS schema_name, COUNT(c.oid)::int AS total
      FROM pg_namespace n
      LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN (${RELKINDS})
      WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
      GROUP BY n.nspname
      ORDER BY n.nspname`)
    return (rows as { schema_name: string; total: number | string }[]).map(row => ({
      schemaName: String(row.schema_name),
      tableCount: Number(row.total ?? 0),
    }))
  }

  async getTables(schemaName?: string): Promise<RemoteTable[]> {
    const schema = schemaName === undefined || schemaName.trim().length === 0 ? 'public' : schemaName.trim()
    const rows = await this.query(TABLE_COLUMNS_SQL, [schema])
    return groupTables(rows as ColumnRow[], schema)
  }

  async getTableColumns(tableName: string, schemaName?: string): Promise<RemoteColumn[]> {
    const schema = schemaName === undefined || schemaName.trim().length === 0 ? 'public' : schemaName.trim()
    const rows = await this.query(ONE_TABLE_COLUMNS_SQL, [schema, tableName])
    return (rows as ColumnRow[]).map(toRemoteColumn)
  }

  async getTableData(
    tableName: string,
    schemaName?: string,
    range?: { limit?: number; offset?: number },
  ): Promise<Record<string, unknown>[]> {
    const schema = schemaName === undefined || schemaName.trim().length === 0 ? 'public' : schemaName.trim()
    return await this.query(this.buildSelectQuery(tableName, schema, range)) as Record<string, unknown>[]
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.query(sql, params)
  }

  nativeType(type: ColumnType): string {
    switch (type) {
      case 'numeric': return 'DOUBLE PRECISION'
      case 'boolean': return 'BOOLEAN'
      case 'date': return 'TEXT'
      default: return 'TEXT'
    }
  }

  placeholder(index: number): string {
    return `$${index + 1}`
  }

  quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
  }

  private async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    const pool = this.pool
    if (pool === null) throw new DataSourceError('UNREACHABLE', 'PostgreSQL 连接尚未建立，请先调用 connect()')
    try {
      const result = await pool.query(sql, params)
      return result.rows
    } catch (error: unknown) {
      throw wrapConnectionError(error, this.config.host, this.config.port)
    }
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/(postgres(?:ql)?:\/\/)[^\s'"]*/gi, '$1***').slice(0, 300)
}
