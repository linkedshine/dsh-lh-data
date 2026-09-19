/**
 * MySQL 连接器。
 *
 * 元数据一次查完（`tables` LEFT JOIN `columns`），避免逐表 N+1 查询。
 * 类型映射依据 `information_schema.COLUMN_TYPE`：远端已有权威声明，不再采样推断。
 */

import { loadMysqlDriver, type MysqlPoolLike } from '../driver'
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
  TABLE_NAME: string
  TABLE_ROWS: number | string | null
  COLUMN_NAME: string | null
  COLUMN_TYPE: string | null
  IS_NULLABLE: string | null
  COLUMN_COMMENT: string | null
  COLUMN_KEY: string | null
}

const TABLE_COLUMNS_SQL = `
SELECT t.TABLE_NAME, t.TABLE_ROWS,
       c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_COMMENT, c.COLUMN_KEY
FROM information_schema.tables t
LEFT JOIN information_schema.columns c
  ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
WHERE t.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'
ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION`

const ONE_TABLE_COLUMNS_SQL = `
SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_COMMENT, c.COLUMN_KEY
FROM information_schema.columns c
WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?
ORDER BY c.ORDINAL_POSITION`

function poolOptions(config: ConnectionConfig): Record<string, unknown> {
  const options: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    connectionLimit: config.poolMax ?? 5,
    waitForConnections: true,
    queueLimit: 0,
    connectTimeout: config.connectTimeoutMs,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000,
  }
  if (config.sslMode !== null && config.sslMode !== 'disabled') {
    options.ssl = { rejectUnauthorized: config.sslMode === 'verify_ca' || config.sslMode === 'verify_identity' }
  }
  return options
}

function mapMySQLType(columnType: string): ColumnType {
  const type = columnType.toLowerCase()
  if (type === 'tinyint(1)' || type === 'bool' || type === 'boolean') return 'boolean'
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|dec|numeric|float|double|real|fixed)/.test(type)) {
    return 'numeric'
  }
  if (type.startsWith('date') || type.startsWith('time') || type.startsWith('year')) return 'date'
  return 'text'
}

function toRemoteColumn(row: ColumnRow): RemoteColumn {
  const comment = row.COLUMN_COMMENT === null ? null : String(row.COLUMN_COMMENT)
  return {
    name: String(row.COLUMN_NAME ?? ''),
    nativeType: mapMySQLType(String(row.COLUMN_TYPE ?? '')),
    nullable: row.IS_NULLABLE === 'YES',
    comment: comment === null || comment.length === 0 ? null : comment,
  }
}

function groupTables(rows: readonly ColumnRow[], schemaName: string): RemoteTable[] {
  const byName = new Map<string, RemoteTable>()
  for (const row of rows) {
    const tableName = row.TABLE_NAME
    let table = byName.get(tableName)
    if (table === undefined) {
      table = {
        tableName,
        schemaName,
        rowCount: Number(row.TABLE_ROWS ?? -1),
        primaryKey: null,
        columns: [],
      }
      byName.set(tableName, table)
    }
    if (row.COLUMN_NAME !== null) {
      const column = toRemoteColumn(row)
      table.columns.push(column)
      if (row.COLUMN_KEY === 'PRI' && table.primaryKey === null) table.primaryKey = column.name
    }
  }
  return [...byName.values()]
}

export class MySQLConnector extends DatabaseConnector {
  private pool: MysqlPoolLike | null = null

  async connect(): Promise<void> {
    if (this.pool !== null) return
    const mysql = await loadMysqlDriver()
    this.pool = mysql.createPool(poolOptions(this.config))
  }

  async disconnect(): Promise<void> {
    const pool = this.pool
    this.pool = null
    if (pool !== null) await pool.end()
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const startedAt = Date.now()
    try {
      const mysql = await loadMysqlDriver()
      const conn = await mysql.createConnection({
        ...poolOptions(this.config),
        connectionLimit: undefined,
        connectTimeout: this.config.connectTimeoutMs,
      })
      const [rows] = await conn.execute('SELECT VERSION() AS version')
      await conn.end()
      const version = (rows as { version?: unknown }[])[0]?.version
      return { success: true, latency: Date.now() - startedAt, version: version === undefined ? null : String(version), error: null }
    } catch (error) {
      return { success: false, latency: Date.now() - startedAt, version: null, error: describe(error) }
    }
  }

  async getSchemas(): Promise<SchemaSummary[]> {
    const rows = await this.query(
      'SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = ? AND table_type = \'BASE TABLE\'',
      [this.config.database],
    )
    const total = Number((rows[0] as { total?: unknown } | undefined)?.total ?? 0)
    return [{ schemaName: this.config.database, tableCount: total }]
  }

  async getTables(schemaName?: string): Promise<RemoteTable[]> {
    void schemaName
    const rows = await this.query(TABLE_COLUMNS_SQL, [this.config.database])
    return groupTables(rows as ColumnRow[], this.config.database)
  }

  async getTableColumns(tableName: string, schemaName?: string): Promise<RemoteColumn[]> {
    void schemaName
    const rows = await this.query(ONE_TABLE_COLUMNS_SQL, [this.config.database, tableName])
    return (rows as ColumnRow[]).map(toRemoteColumn)
  }

  async getTableData(tableName: string, schemaName?: string, range?: { limit?: number; offset?: number }): Promise<Record<string, unknown>[]> {
    return await this.query(this.buildSelectQuery(tableName, schemaName, range)) as Record<string, unknown>[]
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.query(sql, params)
  }

  nativeType(type: ColumnType): string {
    switch (type) {
      case 'numeric': return 'DOUBLE'
      case 'boolean': return 'TINYINT(1)'
      case 'date': return 'TEXT'
      default: return 'TEXT'
    }
  }

  placeholder(index: number): string {
    return '?'
  }

  quoteIdent(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``
  }

  private async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    const pool = this.pool
    if (pool === null) throw new DataSourceError('UNREACHABLE', 'MySQL 连接尚未建立，请先调用 connect()')
    try {
      const [rows] = await pool.execute(sql, params)
      return (rows ?? []) as unknown[]
    } catch (error: unknown) {
      throw wrapConnectionError(error, this.config.host, this.config.port)
    }
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // 去掉驱动可能附带的连接串（含密码）。
  return message.replace(/(mysql:\/\/)[^\s'"]*/gi, '$1***').slice(0, 300)
}
