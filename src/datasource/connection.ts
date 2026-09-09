/**
 * 连接器的工厂与缓存。
 *
 * key 是 `sourceId`：同一数据源在一次插件生命周期内复用同一个连接池。
 * 数据源被改 / 删时必须先 `closeConnector`，否则缓存里会残留旧凭据的连接。
 */

import { MySQLConnector } from './connector/mysql'
import { PostgreSQLConnector } from './connector/postgresql'
import type { DatabaseConnector } from './connector/base'
import { decryptPassword, resolveEncryptKey } from './crypto'
import { wrapConnectionError } from './errors'
import type {
  ConnectionConfig,
  ConnectionTestResult,
  DataSourceConfig,
  DataSourceRecord,
  DataSourceType,
} from './types'

export const DEFAULT_PORTS: Readonly<Record<DataSourceType, number>> = {
  mysql: 3306,
  postgresql: 5432,
}

/** 未保存的连接参数（设置页「先测试再保存」用）。 */
export interface ConnectionDraft {
  type: DataSourceType
  host: string
  port: number | null
  database: string
  username: string
  password: string
  sslMode?: string | null
  poolMax?: number | null
}

const connectors = new Map<string, DatabaseConnector>()

export function createConnector(type: DataSourceType, config: ConnectionConfig): DatabaseConnector {
  if (type === 'mysql') return new MySQLConnector(config)
  return new PostgreSQLConnector(config)
}

/** 已登记数据源 → 明文连接参数（解密只发生在这一刻，结果不出本模块）。 */
export function connectionOf(cfg: DataSourceConfig, record: DataSourceRecord): ConnectionConfig {
  return {
    host: record.host,
    port: record.port,
    database: record.database,
    username: record.username,
    password: decryptPassword(record.passwordEnc, resolveEncryptKey(cfg.datasourceEncryptKey)),
    sslMode: record.sslMode,
    poolMax: record.poolMax,
    connectTimeoutMs: cfg.datasourceConnectTimeoutMs,
  }
}

/** 未保存草稿 → 明文连接参数。 */
export function draftToConfig(cfg: DataSourceConfig, draft: ConnectionDraft): ConnectionConfig {
  return {
    host: draft.host,
    port: draft.port ?? DEFAULT_PORTS[draft.type],
    database: draft.database,
    username: draft.username,
    password: draft.password,
    sslMode: draft.sslMode ?? null,
    poolMax: draft.poolMax ?? null,
    connectTimeoutMs: cfg.datasourceConnectTimeoutMs,
  }
}

/** 取（或建）一个已连通的连接器；连接失败会抛出，并把失败状态留给调用方记录。 */
export async function connectSource(cfg: DataSourceConfig, record: DataSourceRecord): Promise<DatabaseConnector> {
  const cached = connectors.get(record.id)
  if (cached !== undefined) return cached
  const connector = createConnector(record.type, connectionOf(cfg, record))
  try {
    await connector.connect()
  } catch (error: unknown) {
    throw wrapConnectionError(error,record.host, record.port)
  }
  connectors.set(record.id, connector)
  return connector
}

/** 用一次性连接器测连接：测完立刻关闭，不进缓存。 */
export async function testDraft(cfg: DataSourceConfig, draft: ConnectionDraft): Promise<ConnectionTestResult> {
  const connector = createConnector(draft.type, draftToConfig(cfg, draft))
  try {
    return await connector.testConnection()
  } catch (error: unknown) {
    throw wrapConnectionError(error,draft.host, draft.port ?? DEFAULT_PORTS[draft.type])
  } finally {
    await connector.disconnect()
  }
}

/** 测一条已登记的数据源：命中缓存就复用，否则建一次性连接。 */
export async function testSource(cfg: DataSourceConfig, record: DataSourceRecord): Promise<ConnectionTestResult> {
  const cached = connectors.get(record.id)
  if (cached !== undefined) return await cached.testConnection()
  const connector = createConnector(record.type, connectionOf(cfg, record))
  try {
    return await connector.testConnection()
  } catch (error: unknown) {
    throw wrapConnectionError(error,record.host, record.port)
  } finally {
    await connector.disconnect()
  }
}

export async function closeConnector(sourceId: string): Promise<void> {
  const connector = connectors.get(sourceId)
  if (connector === undefined) return
  connectors.delete(sourceId)
  await connector.disconnect().catch(() => undefined)
}

export async function closeAllConnectors(): Promise<void> {
  const entries = [...connectors.entries()]
  connectors.clear()
  await Promise.all(entries.map(([, connector]) => connector.disconnect().catch(() => undefined)))
}
