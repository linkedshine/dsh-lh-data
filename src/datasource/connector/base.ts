/**
 * 数据库连接器抽象基类。
 *
 * 只定义方言无关的能力：连通性测试、schema / 表 / 列元数据、分块取数据。
 * 标识符引号化与类型映射由各子类实现，基类不写任何方言分支。
 */

import type { ColumnType } from '../../parse'
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

  // ── 写能力（把本地数据集推到远端） ───────────────────────────────────────

  /** 执行写语句（建表 / 插数 / 删表），忽略返回行。 */
  abstract run(sql: string, params?: unknown[]): Promise<void>

  /** 把本地列类型映射成本方言的建表类型（text/numeric/boolean/date）。 */
  abstract nativeType(type: ColumnType): string

  /** 第 `index` 个（0 基）参数占位符：MySQL 为 `?`，PG 为 `$n`。 */
  abstract placeholder(index: number): string

  // ── 方言相关的标识符引号化 ─────────────────────────────────────────────────

  /** 标识符引号化（表名 / 列名 / schema），沿用各子类转义规则，供上传编排拼接 SQL。 */
  abstract quoteIdent(name: string): string

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
