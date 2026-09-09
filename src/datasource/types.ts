/**
 * 数据源（DataSource）的类型定义。
 *
 * 数据源 = 一条远程关系型数据库的连接配置，全局登记在 catalog 库，跨工作区共享；
 * 导入产出的数据集仍落在**当前工作区**的 scope 库里。
 */

import type { ColumnType } from '../parse'

/** 支持的关系型数据库类型。 */
export type DataSourceType = 'mysql' | 'postgresql'

/** 连通状态：从未检测 / 最近一次成功 / 最近一次失败。 */
export type DataSourceStatus = 'unknown' | 'connected' | 'error'

/**
 * 与 `DataConfig` 结构同源的最小视图。
 * 只声明本模块真正读取的键，避免 `datasource/*` → `store.ts` 的循环依赖。
 */
export interface DataSourceConfig {
  datasourceEnabled: boolean
  datasourceFetchBatchSize: number
  datasourceConnectTimeoutMs: number
  datasourceMaxImportRows: number
  datasourceEncryptKey: string
}

/** catalog 库 `lh_data_sources` 的一行。`passwordEnc` 恒为密文。 */
export interface DataSourceRecord {
  id: string
  name: string
  type: DataSourceType
  host: string
  port: number
  database: string
  username: string
  passwordEnc: string
  sslMode: string | null
  poolMax: number | null
  description: string | null
  status: DataSourceStatus
  lastError: string | null
  lastCheckedAt: number | null
  createdAt: number
  updatedAt: number
}

/** 新建一条数据源需要的字段（密码为明文，落库前加密）。 */
export interface DataSourceInput {
  name: string
  type: DataSourceType
  host: string
  port: number
  database: string
  username: string
  password: string
  sslMode?: string | null
  poolMax?: number | null
  description?: string | null
}

/** 改一条数据源：字段缺省表示不改；`password` 给空串表示清空。 */
export interface DataSourcePatch {
  name?: string
  type?: DataSourceType
  host?: string
  port?: number
  database?: string
  username?: string
  password?: string | null
  sslMode?: string | null
  poolMax?: number | null
  description?: string | null
  status?: DataSourceStatus
  lastError?: string | null
  lastCheckedAt?: number | null
}

/** 明文连接参数：只在内存里流转，绝不落库、绝不回显给前端或模型。 */
export interface ConnectionConfig {
  host: string
  port: number
  database: string
  username: string
  password: string
  sslMode: string | null
  poolMax: number | null
  connectTimeoutMs: number
}

/** 连接器返回的列元数据（方言无关，已把远端类型映射成本项目的列类型）。 */
export interface RemoteColumn {
  name: string
  nativeType: ColumnType
  nullable: boolean
  comment: string | null
}

export interface RemoteTable {
  tableName: string
  schemaName: string | null
  /** 远端的估计行数（MySQL `TABLE_ROWS` / PG `reltuples`），可能为 -1（未知）。 */
  rowCount: number
  primaryKey: string | null
  columns: RemoteColumn[]
}

export interface SchemaSummary {
  schemaName: string
  tableCount: number
}

export interface ConnectionTestResult {
  success: boolean
  latency: number
  version: string | null
  error: string | null
}

/** 分块拉取的区间。 */
export interface FetchRange {
  limit?: number
  offset?: number
}

/** 导入一张远端表的请求（`datasource_import` 与设置页共用）。 */
export interface ImportRequest {
  scopeKey: string
  tableName: string
  schemaName?: string | null
  name?: string | null
  limit?: number | null
}
