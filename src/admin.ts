/**
 * 设置页管理接口的主机侧服务层（模块级函数，无类）。
 *
 * 负责跨工作区聚合、单条详情、新建/改名改描述改来源/删除等纯业务逻辑，
 * 不含任何 HTTP 细节（路由在 `admin-http.ts`）。所有错误都收敛成
 * `AdminServiceError`，由路由层映射到统一脱敏的 JSON 错误体。
 *
 * 关键约束：
 * - 写操作先过 `assertWritable`（readOnly / adminEnabled 门禁）；
 * - 写与读都先校验 scope 是否「已知」（来自工作区注册表），拒绝凭空造工作区；
 * - 物理表名一律由 `generateTableName` 生成并经 `assertPhysicalTableName` 白名单，
 *   错误信息不回显表名与 SQL。
 */

import type { DataServices } from './store'
import { assertPhysicalTableName, generateTableName, makeDatasetId, type DatasetRecord } from './store'
import { shortHash } from './db'
import { countRows, createDatasetTable, dropDatasetTable } from './table'
import { quoteIdentifier } from './sql'
import {
  ADMIN_ROW_ID_COLUMN,
  type AdminErrorCode,
  type AdminWarning,
  type CreateDatasetRequest,
  type DatasetAdminView,
  type DatasetDetailView,
  type DatasetRowsResult,
  type ListDatasetsResult,
  type PatchDatasetRequest,
  type ScopeView,
} from './admin-contract'
import {
  type ParsedListQuery,
  type ParsedRowsQuery,
  validateColumnPatches,
  validateColumnSpecs,
  validateDatasetName,
  validateDescription,
  validateScopeKey,
  validateSourcePath,
  parseListQuery,
  parseRowsQuery,
} from './admin-validate'

/** 业务错误：携带 HTTP 状态码与脱敏后的错误信息。 */
export class AdminServiceError extends Error {
  constructor(
    public readonly code: AdminErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AdminServiceError'
  }
}

/** 只读模式或接口关闭时拒绝写操作。 */
export function assertWritable(services: DataServices): void {
  if (services.cfg.readOnly) {
    throw new AdminServiceError('READ_ONLY', 403, '插件处于只读模式（readOnly=true），管理接口拒绝写操作')
  }
  if (services.cfg.adminEnabled === false) {
    throw new AdminServiceError('ADMIN_DISABLED', 403, '管理接口已关闭（adminEnabled=false）')
  }
}

export async function listScopes(services: DataServices): Promise<ScopeView[]> {
  const entries = await services.store.scopes.list()
  return entries.map(entry => ({ scopeKey: entry.scopeKey, lastSeen: entry.lastSeen }))
}

function recordToView(record: DatasetRecord): DatasetAdminView {
  return {
    id: record.id,
    scopeKey: record.scopeKey,
    name: record.name,
    description: record.description,
    sourcePath: record.sourcePath,
    rowCount: record.rowCount,
    columnCount: record.columns.length,
    status: record.status,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function recordToDetail(record: DatasetRecord): DatasetDetailView {
  return {
    ...recordToView(record),
    columns: record.columns.map(column => ({
      name: column.name,
      sanitizedName: column.sanitizedName,
      type: column.type,
      nullable: column.nullable,
      description: column.description ?? '',
      sample: column.sample,
    })),
  }
}

function matchesQuery(view: DatasetAdminView, needle: string): boolean {
  return (
    view.name.toLowerCase().includes(needle) ||
    (view.sourcePath ?? '').toLowerCase().includes(needle) ||
    view.scopeKey.toLowerCase().includes(needle) ||
    (view.description ?? '').toLowerCase().includes(needle)
  )
}

/**
 * 聚合所有工作区的数据集：逐 scope 拉取后内存过滤、排序、分页。
 * 单个工作区读取失败降级为一条 warning 而不阻断整页。
 */
export async function listDatasets(
  services: DataServices,
  rawQuery: Record<string, string | undefined>,
): Promise<ListDatasetsResult> {
  const query: ParsedListQuery = parseListQuery(rawQuery)
  const scopes = await services.store.scopes.list()
  const all: DatasetAdminView[] = []
  const warnings: AdminWarning[] = []
  let scanned = 0
  let truncated = false

  for (const entry of scopes) {
    try {
      const records = await services.store.list(entry.scopeKey)
      for (const record of records) {
        if (scanned >= services.cfg.adminMaxDatasets) {
          truncated = true
          break
        }
        scanned += 1
        all.push(recordToView(record))
      }
    } catch (error) {
      warnings.push({ scopeKey: entry.scopeKey, message: `该工作区读取失败：${messageOf(error)}` })
    }
    if (truncated) break
  }

  const needle = query.q.toLowerCase()
  const filtered = needle.length === 0 ? all : all.filter(view => matchesQuery(view, needle))
  filtered.sort((a, b) => b.updatedAt - a.updatedAt)

  const start = (query.page - 1) * query.pageSize
  const items = filtered.slice(start, start + query.pageSize)
  return {
    items,
    total: filtered.length,
    page: query.page,
    pageSize: query.pageSize,
    truncated,
    warnings,
  }
}

export async function getDataset(
  services: DataServices,
  scopeKey: string,
  id: string,
): Promise<DatasetDetailView> {
  if (!(await services.store.scopes.has(scopeKey))) {
    throw new AdminServiceError('SCOPE_UNKNOWN', 404, `未知工作区：${scopeKey}`)
  }
  const record = await services.store.find(scopeKey, id)
  if (record === undefined) throw new AdminServiceError('NOT_FOUND', 404, `未找到数据集：${id}`)
  return recordToDetail(record)
}

/**
 * 只读分页读取某个数据集的物理表行。
 *
 * 只按 `_row_id` 升序翻页（稳定、不重不漏），列名取自元数据登记的业务列，
 * 系统列（`_row_id` / `_uploaded_at`）不进 `columns`，但 `_row_id` 会出现在
 * 每行里，供前端做稳定行键。页码由 `COUNT(*)` 反推后夹紧，越界返回末页。
 */
export async function listDatasetRows(
  services: DataServices,
  scopeKey: string,
  id: string,
  rawQuery: Record<string, string | undefined>,
): Promise<DatasetRowsResult> {
  if (!(await services.store.scopes.has(scopeKey))) {
    throw new AdminServiceError('SCOPE_UNKNOWN', 404, `未知工作区：${scopeKey}`)
  }
  const record = await services.store.find(scopeKey, id)
  if (record === undefined) throw new AdminServiceError('NOT_FOUND', 404, `未找到数据集：${id}`)
  assertPhysicalTableName(record.tableName)

  const query: ParsedRowsQuery = parseRowsQuery(rawQuery)
  const db = await services.store.database(scopeKey)
  const total = await countRows(db, record.tableName)
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize))
  const page = Math.min(query.page, totalPages)
  const offset = (page - 1) * query.pageSize

  const names = record.columns.map(column => column.sanitizedName)
  const projection = names.length === 0
    ? quoteIdentifier(ADMIN_ROW_ID_COLUMN)
    : [ADMIN_ROW_ID_COLUMN, ...names].map(quoteIdentifier).join(', ')
  const rows = await db
    .prepare(
      `SELECT ${projection} FROM ${quoteIdentifier(record.tableName)}`
      + ` ORDER BY ${quoteIdentifier(ADMIN_ROW_ID_COLUMN)} ASC LIMIT ? OFFSET ?`,
    )
    .all(query.pageSize, offset)

  return {
    columns: names,
    rows: rows.map(row => ({ ...row })),
    page,
    pageSize: query.pageSize,
    total,
    totalPages,
  }
}

/** 新建一张空物理表并登记元数据；列结构在提交时冻结。 */
export async function createDataset(
  services: DataServices,
  raw: CreateDatasetRequest,
): Promise<DatasetDetailView> {
  assertWritable(services)
  const scopeKey = validateScopeKey(raw.scopeKey)
  if (!(await services.store.scopes.has(scopeKey))) {
    throw new AdminServiceError('SCOPE_UNKNOWN', 404, `未知工作区：${scopeKey}（请从下拉里选）`)
  }
  const name = validateDatasetName(raw.name)
  const description = validateDescription(raw.description)
  const sourcePath = validateSourcePath(raw.sourcePath)
  const columns = validateColumnSpecs(raw.columns)

  // 同工作区内名称唯一（先于建表与落库，避免触发 UNIQUE 约束变成 500）。
  const conflict = await services.store.find(scopeKey, name)
  if (conflict !== undefined) {
    throw new AdminServiceError('DUPLICATE_NAME', 409, `工作区内已存在同名数据集：${name}`)
  }

  const tableName = generateTableName(name, shortHash(scopeKey))
  assertPhysicalTableName(tableName)
  const now = Date.now()
  const record: DatasetRecord = {
    id: makeDatasetId(),
    scopeKey,
    name,
    tableName,
    sourcePath,
    description,
    rowCount: 0,
    columns,
    status: 'ready',
    error: null,
    createdAt: now,
    updatedAt: now,
  }
  const db = await services.store.database(scopeKey)
  await createDatasetTable(db, tableName, columns)
  await services.store.create(record)
  return recordToDetail(record)
}

/** 改名 / 改描述 / 改来源 / 改列的说明与样例；未提供的字段保持不变；同工作区内名称唯一。 */
export async function patchDataset(
  services: DataServices,
  scopeKey: string,
  id: string,
  raw: PatchDatasetRequest,
): Promise<DatasetDetailView> {
  assertWritable(services)
  if (!(await services.store.scopes.has(scopeKey))) {
    throw new AdminServiceError('SCOPE_UNKNOWN', 404, `未知工作区：${scopeKey}`)
  }
  const record = await services.store.find(scopeKey, id)
  if (record === undefined) throw new AdminServiceError('NOT_FOUND', 404, `未找到数据集：${id}`)

  const patch: Partial<Pick<DatasetRecord, 'name' | 'description' | 'sourcePath' | 'columns'>> = {}
  if (raw.name !== undefined) {
    const name = validateDatasetName(raw.name)
    if (name !== record.name) {
      const conflict = await services.store.find(scopeKey, name)
      if (conflict !== undefined && conflict.id !== record.id) {
        throw new AdminServiceError('DUPLICATE_NAME', 409, `工作区内已存在同名数据集：${name}`)
      }
    }
    patch.name = name
  }
  if (raw.description !== undefined) patch.description = validateDescription(raw.description)
  if (raw.sourcePath !== undefined) patch.sourcePath = validateSourcePath(raw.sourcePath)
  // 列的说明与样例是纯元数据，可改；列名/类型/可空性由校验层从既有列原样带出，改不了。
  if (raw.columns !== undefined) patch.columns = validateColumnPatches(raw.columns, record.columns)
  if (Object.keys(patch).length === 0) return recordToDetail(record)

  await services.store.update(scopeKey, record.id, patch)
  const updated = await services.store.find(scopeKey, record.id)
  if (updated === undefined) throw new AdminServiceError('NOT_FOUND', 404, `数据集在更新后丢失：${id}`)
  return recordToDetail(updated)
}

export interface DeleteDatasetResult {
  id: string
  name: string
  dropped: boolean
}

/** 连同物理表与元数据一起删除（等同 dataset_drop）。 */
export async function deleteDataset(
  services: DataServices,
  scopeKey: string,
  id: string,
): Promise<DeleteDatasetResult> {
  assertWritable(services)
  if (!(await services.store.scopes.has(scopeKey))) {
    throw new AdminServiceError('SCOPE_UNKNOWN', 404, `未知工作区：${scopeKey}`)
  }
  const record = await services.store.find(scopeKey, id)
  if (record === undefined) throw new AdminServiceError('NOT_FOUND', 404, `未找到数据集：${id}`)
  const db = await services.store.database(scopeKey)
  await dropDatasetTable(db, record.tableName)
  await services.store.remove(scopeKey, record.id)
  return { id: record.id, name: record.name, dropped: true }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0]
  return String(error)
}
