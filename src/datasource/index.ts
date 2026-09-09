/**
 * 数据源模块对外入口。
 *
 * 主机侧（工具 / 管理接口）只从这里导入；连接器与驱动加载属于内部实现，不直接暴露。
 */

// 错误
export { DataSourceError, dataSourceErrorStatus, isDataSourceError, type DataSourceErrorCode } from './errors'

// 类型
export type {
  ConnectionConfig,
  ConnectionTestResult,
  DataSourceConfig,
  DataSourceInput,
  DataSourcePatch,
  DataSourceRecord,
  DataSourceStatus,
  DataSourceType,
  FetchRange,
  ImportRequest,
  RemoteColumn,
  RemoteTable,
  SchemaSummary,
} from './types'

// 加解密
export { decryptPassword, encryptPassword, isValidEncryptedFormat, resolveEncryptKey, usingDefaultEncryptKey } from './crypto'

// 驱动
export { DRIVER_INSTALL_HINTS } from './driver'

// 连接
export {
  closeAllConnectors,
  closeConnector,
  connectSource,
  createConnector,
  DEFAULT_PORTS,
  testDraft,
  testSource,
  type ConnectionDraft,
} from './connection'

// 连接器基类
export { DatabaseConnector } from './connector/base'

// 持久化
export { createSourceStore, DataSourceStore } from './source-store'
export { makeSourceId, SOURCE_SCHEMA_SQL } from './source-sql'

// 列映射
export { buildColumns, fillSamples, mapRowKeys } from './columns'

// 导入
export {
  importRemoteTable,
  REMOTE_IMPORT_JOB_KIND,
  type RemoteImportContext,
  type RemoteImportParams,
  type RemoteImportResult,
} from './importer'
