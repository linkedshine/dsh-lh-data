/**
 * 设置页管理接口的**双半身契约**。
 *
 * 主机半身（`admin.ts` / `admin-http.ts`）与浏览器半身（`client/settings/*`）
 * 共用本文件，因此有两条硬约束：
 *
 * 1. **禁止 import 任何 node 内置模块** —— 本文件会被打进浏览器 bundle
 *    （`tsdown.config.ts` 的 client 产物）；
 * 2. **只有常量与类型**，不含任何运行时逻辑 —— 浏览器 bundle 是 CJS 工厂包，
 *    多引一个模块就多一份内联体积。
 *
 * 存在理由：浏览器拿不到主机的 `Config`。`viewRoutePrefix` 之类是用户在 dsh
 * 配置里改的，如果路由前缀两边各写一份字面量，改配置就会让设置页悄悄失联。
 * 下面的常量是唯一真源，主机注册路由和浏览器拼 URL 都从这里取。
 */

// ── 路由 ─────────────────────────────────────────────────────────────────

/** 管理接口的路由前缀。与视图接口（可配置）解耦，固定不变。 */
export const ADMIN_ROUTE_PREFIX = '/api/lh-data'

/** 管理接口的固定挂载点：`${ADMIN_ROUTE_PREFIX}/admin`。 */
export const ADMIN_API_BASE: string = `${ADMIN_ROUTE_PREFIX}/admin`

// ── 设置菜单 ─────────────────────────────────────────────────────────────

/**
 * `settings.section` 的注册 id。既有分区用的是 0（general）/ 10（models）/
 * 15（plugins）/ 20（agent-presets），这里取 100 排在最后。
 */
export const ADMIN_SECTION_ID = 'lh-data'
export const ADMIN_SECTION_ORDER = 100
export const ADMIN_SECTION_LABEL = '数据集'

// ── 列表分页 ─────────────────────────────────────────────────────────────

export const ADMIN_PAGE_SIZE = 20
export const ADMIN_MAX_PAGE_SIZE = 100

// ── 表数据分页（查看某个数据集的行） ───────────────────────────────────────

/** 表数据默认每页行数。 */
export const ADMIN_ROW_PAGE_SIZE = 20
/** 表数据每页行数的上限。 */
export const ADMIN_ROW_MAX_PAGE_SIZE = 100
/** 行号列：物理表的自增主键，只用于稳定排序与前端行键，不算业务列。 */
export const ADMIN_ROW_ID_COLUMN = '_row_id'

// ── 录入上限（前端 maxLength 与后端校验共用） ─────────────────────────────

export const ADMIN_MAX_NAME_LENGTH = 80
export const ADMIN_MAX_DESCRIPTION_LENGTH = 500
export const ADMIN_MAX_SOURCE_LENGTH = 1024
export const ADMIN_MAX_COLUMNS = 64
export const ADMIN_MAX_QUERY_LENGTH = 80
/** 单列样例值的个数上限（前端拼接与后端夹紧共用）。 */
export const ADMIN_MAX_SAMPLE_VALUES = 5
/** 单个样例值的字符上限。 */
export const ADMIN_MAX_SAMPLE_LENGTH = 40

// ── 数据源录入上限 ───────────────────────────────────────────────────────

export const ADMIN_MAX_SOURCE_NAME_LENGTH = 80
export const ADMIN_MAX_HOST_LENGTH = 255
export const ADMIN_MAX_DATABASE_LENGTH = 128
export const ADMIN_MAX_USERNAME_LENGTH = 128
export const ADMIN_MAX_PASSWORD_LENGTH = 256
export const ADMIN_MIN_PORT = 1
export const ADMIN_MAX_PORT = 65535
export const ADMIN_MAX_POOL_MAX = 100

/** 数据源类型下拉的可选项（顺序即展示顺序）。 */
export const ADMIN_SOURCE_TYPES: readonly string[] = ['mysql', 'postgresql']

export const ADMIN_SOURCE_TYPE_LABELS: Readonly<Record<string, string>> = {
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
}

/** 各类型的默认端口（前端带出与后端兜底共用）。 */
export const ADMIN_SOURCE_DEFAULT_PORTS: Readonly<Record<string, number>> = {
  mysql: 3306,
  postgresql: 5432,
}

// ── 类型 ─────────────────────────────────────────────────────────────────

/** 与 `parse.ts` 的 `ColumnType` 同构（本文件不能 import 主机侧的 parse）。 */
export type AdminColumnType = 'text' | 'numeric' | 'boolean' | 'date'

/** 人类可读的类型名：前端下拉与列结构表共用，避免两处各写一份中文。 */
export const ADMIN_COLUMN_TYPE_LABELS: Readonly<Record<AdminColumnType, string>> = {
  text: '文本',
  numeric: '数值',
  boolean: '布尔',
  date: '日期',
}

/** 列类型下拉的可选项（顺序即展示顺序）。 */
export const ADMIN_COLUMN_TYPES: readonly AdminColumnType[] = ['text', 'numeric', 'boolean', 'date']

export type DatasetStatus = 'importing' | 'ready' | 'failed'

/** 设置页可见的一列。列名是业务表头（可含中文），不含任何物理表信息。 */
export interface DatasetColumnView {
  /** 原始表头。 */
  name: string
  /** SQL 中使用的列名（重名时追加 `_2`）。 */
  sanitizedName: string
  type: AdminColumnType
  nullable: boolean
  description: string
  sample: unknown[]
}

/** 新建数据集时提交的一列。 */
export interface DatasetColumnSpec {
  name: string
  type: AdminColumnType
  nullable?: boolean
  description?: string
}

/** 列表里的一条数据集（跨工作区聚合；不含列结构，避免列表响应膨胀）。 */
export interface DatasetAdminView {
  id: string
  scopeKey: string
  name: string
  description: string | null
  sourcePath: string | null
  rowCount: number
  columnCount: number
  status: DatasetStatus
  error: string | null
  createdAt: number
  updatedAt: number
}

/** 详情 = 列表项 + 只读列结构。 */
export interface DatasetDetailView extends DatasetAdminView {
  columns: DatasetColumnView[]
}

/**
 * 一页表数据（只读）。`columns` 只含业务列，`rows` 每行额外带 `_row_id`
 * （`ADMIN_ROW_ID_COLUMN`）作为稳定行键；`page` 由服务端夹到分页边界内。
 */
export interface DatasetRowsResult {
  columns: string[]
  rows: Record<string, unknown>[]
  page: number
  pageSize: number
  /** `COUNT(*)` 得到的真实行数（元数据里的 rowCount 可能与之不符）。 */
  total: number
  totalPages: number
}

/** 设置页可见的一个工作区。 */
export interface ScopeView {
  scopeKey: string
  lastSeen: number
}

/** 单个工作区读取失败时的降级提示（不阻断整页）。 */
export interface AdminWarning {
  scopeKey: string
  message: string
}

export interface ListDatasetsResult {
  items: DatasetAdminView[]
  total: number
  page: number
  pageSize: number
  /** 命中 `adminMaxDatasets` 上限被截断。 */
  truncated: boolean
  warnings: AdminWarning[]
}

/** 新建空数据集：列名 / 类型 / 可空性提交后冻结，说明与样例仍可改。 */
export interface CreateDatasetRequest {
  scopeKey: string
  name: string
  description?: string
  sourcePath?: string | null
  columns: DatasetColumnSpec[]
}

/**
 * 列定义的补丁：只改「说明」与「样例」这两项纯元数据。
 * 列名 / 类型 / 可空性对应物理表 DDL，设置页不可改。
 * 用 `sanitizedName` 定位列——原始表头 `name` 在重名列上会重复，不能当键。
 */
export interface DatasetColumnPatch {
  /** 列的 SQL 名（去重后唯一）。 */
  sanitizedName: string
  description?: string
  sample?: unknown[]
}

// ── 数据源 ───────────────────────────────────────────────────────────────

/**
 * 设置页可见的一条数据源。
 * **密码永不回显**：只给 `hasPassword`，前端据此显示「已设置 · 不可查看」。
 */
export interface DataSourceView {
  id: string
  name: string
  type: string
  host: string
  port: number
  database: string
  username: string
  hasPassword: boolean
  sslMode: string | null
  poolMax: number | null
  description: string | null
  status: string
  lastError: string | null
  lastCheckedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface ConnectionTestView {
  success: boolean
  latency: number
  version: string | null
  error: string | null
}

/** 新建数据源。`test` 为 true 时先测连，不通就不落库。 */
export interface CreateDataSourceRequest {
  name: string
  type: string
  host: string
  port?: number | null
  database: string
  username: string
  password?: string
  sslMode?: string | null
  poolMax?: number | null
  description?: string | null
  test?: boolean
}

/** 改数据源：字段缺省表示不改；`password` 给了字符串就替换（空串表示置空）。 */
export interface PatchDataSourceRequest {
  name?: string
  type?: string
  host?: string
  port?: number | null
  database?: string
  username?: string
  password?: string
  sslMode?: string | null
  poolMax?: number | null
  description?: string | null
  test?: boolean
}

/** `POST /sources/test` 的请求体：给 `source` 就测已登记的，给全参数就测未保存的草稿。 */
export interface TestDataSourceRequest {
  source?: string
  type?: string
  host?: string
  port?: number | null
  database?: string
  username?: string
  password?: string
  sslMode?: string | null
  poolMax?: number | null
}

export interface SourceTableView {
  tableName: string
  schemaName: string | null
  /** 远端估计行数；-1 表示未知。 */
  rowCount: number
  primaryKey: string | null
  columns: {
    name: string
    type: AdminColumnType
    nullable: boolean
    description: string | null
  }[]
}

export interface ListSourceTablesResult {
  /** 实际使用的 schema（MySQL 为库名，PostgreSQL 默认 public）。 */
  schema: string | null
  /** 可选 schema 列表（PostgreSQL 多个，MySQL 一个）。 */
  schemas: string[]
  tables: SourceTableView[]
}

/** `POST /sources/:id/import`。 */
export interface ImportSourceTableRequest {
  scopeKey: string
  tableName: string
  schemaName?: string | null
  name?: string | null
  limit?: number | null
}

export interface ImportSourceTableResult {
  datasetId: string
  name: string
  rowCount: number
  columnCount: number
  status: 'ready' | 'running'
  jobId?: string
}

// ── 数据集导出到数据源 ───────────────────────────────────────────────────────

/** 导出请求里指向某一个数据集的引用（datasetId + 所属工作区）。 */
export interface ExportDatasetRef {
  id: string
  scopeKey: string
  /** 远端表名；缺省时取数据集显示名。改名后同名即视为冲突。 */
  tableName?: string | null
}

export interface ExportDatasetsRequest {
  datasets: ExportDatasetRef[]
  /** 目标 schema（PostgreSQL 用；MySQL 忽略，固定写已配置的库）。 */
  schemaName?: string | null
  /** 同名表是否覆盖（DROP 后重建）。默认 false：有冲突时整体拒绝并列出冲突表名。 */
  overwrite?: boolean
}

export interface ExportDatasetResult {
  id: string
  name: string
  remoteTable: string
  rowCount: number
  columnCount: number
  status: 'ok' | 'failed'
  error?: string
}

export interface ExportDatasetsResult {
  /** 有同名表且未确认覆盖时的冲突表名列表（用于前端提示）。 */
  conflicts: string[]
  results: ExportDatasetResult[]
}

/** 字段缺省表示不改动。 */
export interface PatchDatasetRequest {
  name?: string
  description?: string | null
  sourcePath?: string | null
  columns?: DatasetColumnPatch[]
}

export type AdminErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'BAD_REQUEST'
  | 'PAYLOAD_TOO_LARGE'
  | 'READ_ONLY'
  | 'ADMIN_DISABLED'
  | 'SCOPE_UNKNOWN'
  | 'DUPLICATE_NAME'
  | 'INVALID_COLUMNS'
  | 'QUERY_FAILED'
  | 'SOURCE_DISABLED'
  | 'DRIVER_MISSING'
  | 'SOURCE_UNREACHABLE'
  | 'IMPORT_FAILED'

/** 错误响应体。主机侧统一脱敏：不回显 SQL 与物理表名。 */
export interface AdminErrorBody {
  error: { code: AdminErrorCode; message: string }
}

/** 管理接口是否可写（前端据此置灰按钮）。 */
export interface AdminCapabilities {
  writable: boolean
  reason: string
}
