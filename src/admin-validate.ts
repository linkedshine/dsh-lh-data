/**
 * 设置页管理接口的入参校验（纯函数，无 IO）。
 *
 * 所有校验失败都抛 `AdminValidationError`，由 `admin-http.ts` 统一转成 400。
 * 校验目标：把浏览器传来的任意字符串收口成「类型正确、长度受控、范围合法」
 * 的值——写库前最后一道闸门，尤其要防止凭空造工作区、列结构越界、字段溢出。
 */

import { deduplicateColumnNames, sanitizeColumnName, type ColumnInfo } from './parse'
import type { DataSourceInput, DataSourcePatch, DataSourceType } from './datasource/types'
import type { ConnectionDraft } from './datasource/connection'
import {
  ADMIN_COLUMN_TYPES,
  ADMIN_MAX_COLUMNS,
  ADMIN_MAX_DATABASE_LENGTH,
  ADMIN_MAX_DESCRIPTION_LENGTH,
  ADMIN_MAX_HOST_LENGTH,
  ADMIN_MAX_NAME_LENGTH,
  ADMIN_MAX_PAGE_SIZE,
  ADMIN_MAX_PASSWORD_LENGTH,
  ADMIN_MAX_POOL_MAX,
  ADMIN_MAX_PORT,
  ADMIN_MAX_QUERY_LENGTH,
  ADMIN_MAX_SAMPLE_LENGTH,
  ADMIN_MAX_SAMPLE_VALUES,
  ADMIN_MAX_SOURCE_LENGTH,
  ADMIN_MAX_SOURCE_NAME_LENGTH,
  ADMIN_MAX_USERNAME_LENGTH,
  ADMIN_MIN_PORT,
  ADMIN_PAGE_SIZE,
  ADMIN_ROW_MAX_PAGE_SIZE,
  ADMIN_ROW_PAGE_SIZE,
  ADMIN_SOURCE_DEFAULT_PORTS,
  ADMIN_SOURCE_TYPES,
  type AdminColumnType,
  type AdminErrorCode,
} from './admin-contract'

/** 校验失败：对应 HTTP 400。 */
export class AdminValidationError extends Error {
  constructor(
    public readonly code: AdminErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AdminValidationError'
  }
}

/** 一个可空、可缺省的文本字段（描述 / 来源路径）。 */
function validateOptionalText(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new AdminValidationError('BAD_REQUEST', `${field}必须是字符串`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > max) throw new AdminValidationError('BAD_REQUEST', `${field}不超过 ${max} 字`)
  return trimmed
}

export function validateScopeKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AdminValidationError('BAD_REQUEST', '缺少工作区标识（scopeKey）')
  }
  return value.trim()
}

export function validateDatasetName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AdminValidationError('BAD_REQUEST', '数据集名称不能为空')
  }
  const name = value.trim()
  if (name.length > ADMIN_MAX_NAME_LENGTH) {
    throw new AdminValidationError('BAD_REQUEST', `名称不超过 ${ADMIN_MAX_NAME_LENGTH} 字`)
  }
  return name
}

export function validateDescription(value: unknown): string | null {
  return validateOptionalText(value, ADMIN_MAX_DESCRIPTION_LENGTH, '描述')
}

export function validateSourcePath(value: unknown): string | null {
  return validateOptionalText(value, ADMIN_MAX_SOURCE_LENGTH, '来源路径')
}

/**
 * 校验列定义：非空数组、数量受控、类型白名单、列名消毒并去重。
 * 返回可直接交给 `createDatasetTable` 的 `ColumnInfo[]`。
 */
export function validateColumnSpecs(raw: unknown): ColumnInfo[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AdminValidationError('INVALID_COLUMNS', '至少需要定义一列')
  }
  if (raw.length > ADMIN_MAX_COLUMNS) {
    throw new AdminValidationError('INVALID_COLUMNS', `列数不超过 ${ADMIN_MAX_COLUMNS}`)
  }
  const columns: ColumnInfo[] = raw.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new AdminValidationError('INVALID_COLUMNS', `第 ${index + 1} 列格式错误`)
    }
    const spec = item as Record<string, unknown>
    const name = typeof spec.name === 'string' ? spec.name.trim() : ''
    if (name.length === 0) throw new AdminValidationError('INVALID_COLUMNS', `第 ${index + 1} 列缺少列名`)
    if (!ADMIN_COLUMN_TYPES.includes(spec.type as AdminColumnType)) {
      throw new AdminValidationError('INVALID_COLUMNS', `第 ${index + 1} 列类型非法`)
    }
    const description = typeof spec.description === 'string' ? spec.description.slice(0, ADMIN_MAX_DESCRIPTION_LENGTH) : ''
    return {
      name,
      sanitizedName: sanitizeColumnName(name),
      type: spec.type as AdminColumnType,
      nullable: spec.nullable === true,
      sample: [],
      description,
    }
  })
  deduplicateColumnNames(columns)
  return columns
}

/** 样例值只允许 JSON 标量（columns 是 TEXT 列，不能塞对象 / NaN）。 */
function sanitizeSampleValue(value: unknown): string | number | boolean | null {
  if (value === null) return null
  if (typeof value === 'string') return value.slice(0, ADMIN_MAX_SAMPLE_LENGTH)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  return String(value)
}

/**
 * 校验列的「说明 / 样例」补丁，返回合并后的完整 `ColumnInfo[]`。
 *
 * 只从补丁里读 `description` 与 `sample` 两项，其余字段（name / sanitizedName /
 * type / nullable）一律沿用既有列——它们对应物理表 DDL，设置页改不了。
 * 按 `sanitizedName` 定位列：原始表头 `name` 在重名列上会重复，不能当键。
 */
export function validateColumnPatches(raw: unknown, existing: ColumnInfo[]): ColumnInfo[] {
  if (!Array.isArray(raw)) {
    throw new AdminValidationError('INVALID_COLUMNS', '列补丁必须是数组')
  }
  const merged = existing.map(column => ({ ...column }))
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      throw new AdminValidationError('INVALID_COLUMNS', '列补丁格式错误')
    }
    const patch = entry as Record<string, unknown>
    const key = typeof patch.sanitizedName === 'string' ? patch.sanitizedName : ''
    const target = merged.find(column => column.sanitizedName === key)
    if (target === undefined) {
      throw new AdminValidationError('INVALID_COLUMNS', `未找到列：${key}`)
    }
    if (patch.description !== undefined) {
      if (typeof patch.description !== 'string') {
        throw new AdminValidationError('INVALID_COLUMNS', `列「${key}」的说明必须是字符串`)
      }
      target.description = patch.description.slice(0, ADMIN_MAX_DESCRIPTION_LENGTH)
    }
    if (patch.sample !== undefined) {
      if (!Array.isArray(patch.sample)) {
        throw new AdminValidationError('INVALID_COLUMNS', `列「${key}」的样例必须是数组`)
      }
      target.sample = patch.sample.slice(0, ADMIN_MAX_SAMPLE_VALUES).map(sanitizeSampleValue)
    }
  }
  return merged
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

export interface ParsedListQuery {
  q: string
  page: number
  pageSize: number
}

/** 解析并夹紧列表查询参数（关键字裁剪、页码与页大小封顶）。 */
export function parseListQuery(params: Record<string, string | undefined>): ParsedListQuery {
  const q = typeof params.q === 'string' ? params.q.trim().slice(0, ADMIN_MAX_QUERY_LENGTH) : ''
  const page = clampInt(params.page, 1, 1, 100000)
  const pageSize = clampInt(params.pageSize, ADMIN_PAGE_SIZE, 1, ADMIN_MAX_PAGE_SIZE)
  return { q, page, pageSize }
}

export interface ParsedRowsQuery {
  page: number
  pageSize: number
}

/**
 * 解析并夹紧表数据分页参数。页码上限只是防御（真实边界由 `COUNT(*)` 决定），
 * 页大小封顶避免一次捞走整表。
 */
export function parseRowsQuery(params: Record<string, string | undefined>): ParsedRowsQuery {
  const page = clampInt(params.page, 1, 1, 100000)
  const pageSize = clampInt(params.pageSize, ADMIN_ROW_PAGE_SIZE, 1, ADMIN_ROW_MAX_PAGE_SIZE)
  return { page, pageSize }
}

// ── 数据源 ───────────────────────────────────────────────────────────────

/** 必填文本：trim 后非空、长度受控。 */
function requireText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AdminValidationError('BAD_REQUEST', `${field}不能为空`)
  }
  const text = value.trim()
  if (text.length > max) throw new AdminValidationError('BAD_REQUEST', `${field}不超过 ${max} 字`)
  return text
}

export function validateSourceName(value: unknown): string {
  return requireText(value, ADMIN_MAX_SOURCE_NAME_LENGTH, '数据源名称')
}

export function validateSourceType(value: unknown): DataSourceType {
  if (typeof value !== 'string' || !ADMIN_SOURCE_TYPES.includes(value)) {
    throw new AdminValidationError('BAD_REQUEST', '数据源类型必须是 mysql 或 postgresql')
  }
  return value as DataSourceType
}

export function validateHost(value: unknown): string {
  return requireText(value, ADMIN_MAX_HOST_LENGTH, '主机地址')
}

export function validatePort(value: unknown, type: DataSourceType): number {
  if (value === undefined || value === null) return ADMIN_SOURCE_DEFAULT_PORTS[type]
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
    throw new AdminValidationError('BAD_REQUEST', '端口必须是整数')
  }
  if (parsed < ADMIN_MIN_PORT || parsed > ADMIN_MAX_PORT) {
    throw new AdminValidationError('BAD_REQUEST', `端口必须在 ${ADMIN_MIN_PORT} – ${ADMIN_MAX_PORT} 之间`)
  }
  return parsed
}

export function validateDatabaseName(value: unknown): string {
  return requireText(value, ADMIN_MAX_DATABASE_LENGTH, '数据库名')
}

export function validateUsername(value: unknown): string {
  return requireText(value, ADMIN_MAX_USERNAME_LENGTH, '用户名')
}

/** 密码允许为空串（部分库无口令），但不能超过上限。 */
export function validatePassword(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new AdminValidationError('BAD_REQUEST', '密码必须是字符串')
  if (value.length > ADMIN_MAX_PASSWORD_LENGTH) {
    throw new AdminValidationError('BAD_REQUEST', `密码不超过 ${ADMIN_MAX_PASSWORD_LENGTH} 字`)
  }
  return value
}

function validateSslMode(value: unknown): string | null {
  return validateOptionalText(value, 32, 'SSL 模式')
}

function validatePoolMax(value: unknown): number | null {
  if (value === undefined || value === null) return null
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 1) {
    throw new AdminValidationError('BAD_REQUEST', '连接池上限必须是正整数')
  }
  return Math.min(ADMIN_MAX_POOL_MAX, parsed)
}

export interface ParsedCreateSource extends DataSourceInput {
  test: boolean
}

export function parseCreateDataSource(raw: unknown): ParsedCreateSource {
  if (typeof raw !== 'object' || raw === null) {
    throw new AdminValidationError('BAD_REQUEST', '请求体必须是对象')
  }
  const body = raw as Record<string, unknown>
  const type = validateSourceType(body.type)
  return {
    name: validateSourceName(body.name),
    type,
    host: validateHost(body.host),
    port: validatePort(body.port, type),
    database: validateDatabaseName(body.database),
    username: validateUsername(body.username),
    password: validatePassword(body.password),
    sslMode: validateSslMode(body.sslMode),
    poolMax: validatePoolMax(body.poolMax),
    description: validateDescription(body.description),
    test: body.test !== false,
  }
}

export interface ParsedPatchSource extends DataSourcePatch {
  test: boolean
}

/** 只校验出现的字段；`password` 给了字符串才替换。 */
export function parsePatchDataSource(raw: unknown): ParsedPatchSource {
  if (typeof raw !== 'object' || raw === null) {
    throw new AdminValidationError('BAD_REQUEST', '请求体必须是对象')
  }
  const body = raw as Record<string, unknown>
  const patch: ParsedPatchSource = { test: body.test !== false }
  if (body.name !== undefined) patch.name = validateSourceName(body.name)
  if (body.host !== undefined) patch.host = validateHost(body.host)
  if (body.database !== undefined) patch.database = validateDatabaseName(body.database)
  if (body.username !== undefined) patch.username = validateUsername(body.username)
  if (body.password !== undefined) patch.password = validatePassword(body.password)
  if (body.sslMode !== undefined) patch.sslMode = validateSslMode(body.sslMode)
  if (body.poolMax !== undefined) patch.poolMax = validatePoolMax(body.poolMax)
  if (body.description !== undefined) patch.description = validateDescription(body.description)
  const type = body.type === undefined ? undefined : validateSourceType(body.type)
  if (type !== undefined) patch.type = type
  if (body.port !== undefined) patch.port = validatePort(body.port, type ?? 'mysql')
  return patch
}

export interface ParsedTestSource {
  /** 测已登记的数据源（id 或登记名）。 */
  reference?: string
  /** 测未保存的草稿。 */
  draft?: ConnectionDraft
}

/** `source` 与「完整连接参数」二选一。 */
export function parseTestDataSource(raw: unknown): ParsedTestSource {
  if (typeof raw !== 'object' || raw === null) {
    throw new AdminValidationError('BAD_REQUEST', '请求体必须是对象')
  }
  const body = raw as Record<string, unknown>
  if (typeof body.source === 'string' && body.source.trim().length > 0) {
    return { reference: body.source.trim() }
  }
  const type = validateSourceType(body.type)
  return {
    draft: {
      type,
      host: validateHost(body.host),
      port: validatePort(body.port, type),
      database: validateDatabaseName(body.database),
      username: validateUsername(body.username),
      password: validatePassword(body.password),
      sslMode: validateSslMode(body.sslMode),
      poolMax: validatePoolMax(body.poolMax),
    },
  }
}

export interface ParsedTablesQuery {
  schema: string | null
  q: string
}

export function parseTablesQuery(params: Record<string, string | undefined>): ParsedTablesQuery {
  const schema = typeof params.schema === 'string' && params.schema.trim().length > 0 ? params.schema.trim() : null
  const q = typeof params.q === 'string' ? params.q.trim().slice(0, ADMIN_MAX_QUERY_LENGTH) : ''
  return { schema, q }
}

export interface ParsedImportRequest {
  scopeKey: string
  tableName: string
  schemaName: string | null
  name: string | null
  limit: number | null
}

export function parseImportRequest(raw: unknown): ParsedImportRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new AdminValidationError('BAD_REQUEST', '请求体必须是对象')
  }
  const body = raw as Record<string, unknown>
  const tableName = requireText(body.tableName, ADMIN_MAX_DATABASE_LENGTH, '表名')
  const limit = typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0 ? body.limit : null
  return {
    scopeKey: validateScopeKey(body.scopeKey),
    tableName,
    schemaName: validateOptionalText(body.schemaName, ADMIN_MAX_DATABASE_LENGTH, 'schema'),
    name: validateDatasetNameSafe(body.name),
    limit,
  }
}

/** 数据集登记名可缺省（缺省时取远端表名）。 */
function validateDatasetNameSafe(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return validateDatasetName(value)
}

export interface ParsedExportRequest {
  datasets: { id: string; scopeKey: string; tableName: string | null }[]
  schemaName: string | null
  overwrite: boolean
}

/**
 * 校验「数据集 → 数据源」导出请求：datasets 非空数组，每项含 id 与 scopeKey，
 * tableName 可选（远端表名，缺省取数据集名），schemaName 可选，overwrite 布尔默认 false。
 */
export function parseExportRequest(raw: unknown): ParsedExportRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new AdminValidationError('BAD_REQUEST', '请求体必须是对象')
  }
  const body = raw as Record<string, unknown>
  if (!Array.isArray(body.datasets) || body.datasets.length === 0) {
    throw new AdminValidationError('BAD_REQUEST', 'datasets 不能为空')
  }
  if (body.datasets.length > 100) {
    throw new AdminValidationError('BAD_REQUEST', '单次最多导出 100 个数据集')
  }
  const datasets = body.datasets.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new AdminValidationError('BAD_REQUEST', `第 ${index + 1} 个数据集格式错误`)
    }
    const entry = item as Record<string, unknown>
    return {
      id: requireText(entry.id, 128, `第 ${index + 1} 个数据集的 id`),
      scopeKey: validateScopeKey(entry.scopeKey),
      tableName: validateOptionalText(entry.tableName, ADMIN_MAX_DATABASE_LENGTH, '目标表名'),
    }
  })
  const overwrite = typeof body.overwrite === 'boolean' ? body.overwrite : false
  return {
    datasets,
    schemaName: validateOptionalText(body.schemaName, ADMIN_MAX_DATABASE_LENGTH, 'schema'),
    overwrite,
  }
}
