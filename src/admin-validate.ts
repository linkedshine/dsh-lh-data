/**
 * 设置页管理接口的入参校验（纯函数，无 IO）。
 *
 * 所有校验失败都抛 `AdminValidationError`，由 `admin-http.ts` 统一转成 400。
 * 校验目标：把浏览器传来的任意字符串收口成「类型正确、长度受控、范围合法」
 * 的值——写库前最后一道闸门，尤其要防止凭空造工作区、列结构越界、字段溢出。
 */

import { deduplicateColumnNames, sanitizeColumnName, type ColumnInfo } from './parse'
import {
  ADMIN_COLUMN_TYPES,
  ADMIN_MAX_COLUMNS,
  ADMIN_MAX_DESCRIPTION_LENGTH,
  ADMIN_MAX_NAME_LENGTH,
  ADMIN_MAX_PAGE_SIZE,
  ADMIN_MAX_QUERY_LENGTH,
  ADMIN_MAX_SAMPLE_LENGTH,
  ADMIN_MAX_SAMPLE_VALUES,
  ADMIN_MAX_SOURCE_LENGTH,
  ADMIN_PAGE_SIZE,
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
