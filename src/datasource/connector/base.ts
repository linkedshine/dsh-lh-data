/**
 * 数据库连接器抽象基类。
 *
 * 只定义方言无关的能力：连通性测试、schema / 表 / 列元数据、分块取数据。
 * 标识符引号化与类型映射由各子类实现，基类不写任何方言分支。
 */

import type {
  ConnectionConfig,
  ConnectionTestResult,
  FetchRange,
  RemoteColumn,
  RemoteTable,
  SchemaSummary,
} from '../types'

export abstract class DatabaseConnector {
  protected readonly config: ConnectionConfig

  constructor(config: ConnectionConfig) {
    this.config = config
  }

  // ── 连接 ───────────────────────────────────────────────────────────────────

  abstract connect(): Promise<void>
  abstract disconnect(): Promise<void>
  abstract testConnection(): Promise<ConnectionTestResult>

  // ── 元数据 ─────────────────────────────────────────────────────────────────

  abstract getSchemas(): Promise<SchemaSummary[]>
  abstract getTables(schemaName?: string): Promise<RemoteTable[]>
  abstract getTableColumns(tableName: string, schemaName?: string): Promise<RemoteColumn[]>
  abstract getTableData(tableName: string, schemaName?: string, range?: FetchRange): Promise<Record<string, unknown>[]>

  // ── 方言相关的标识符引号化 ─────────────────────────────────────────────────

  protected abstract quoteIdent(name: string): string

  protected tableRef(tableName: string, schemaName?: string | null): string {
    const schema = schemaName === undefined || schemaName === null ? '' : schemaName.trim()
    return schema.length > 0
      ? `${this.quoteIdent(schema)}.${this.quoteIdent(tableName)}`
      : this.quoteIdent(tableName)
  }

  protected buildSelectQuery(tableName: string, schemaName?: string | null, range?: FetchRange): string {
    let sql = `SELECT * FROM ${this.tableRef(tableName, schemaName)}`
    if (range?.limit !== undefined) sql += ` LIMIT ${Math.max(0, Math.trunc(range.limit))}`
    if (range?.offset !== undefined && range.offset > 0) sql += ` OFFSET ${Math.trunc(range.offset)}`
    return sql
  }
}
