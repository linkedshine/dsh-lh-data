/**
 * 查询结果视图注册中心 —— 设计文档 §6。
 *
 * 视图是**主机侧的句柄**：`viewId` 之外的一切（物理表名、count/page 语句）都留在这里，
 * 既不出现在模型上下文里，也不出现在 HTTP 响应里。前端只能拿 `viewId` + 分页参数换页。
 *
 * 生命周期：滑动 TTL（`viewTtlMs`）到期即失效，容量上限（`maxViews`）按 LRU 淘汰，
 * 插件卸载时 `clear()`。失效是惰性的（访问时判定），不额外占用定时器。
 */

import { randomBytes } from 'node:crypto'
import { validateOrderBy } from './sql'

/** 视图能看到的列（列名保持原始表头，含中文）。 */
export interface ViewColumn {
  name: string
  type: string
}

/** 派生分页语句所需的三件套，排序可按前端请求重排。 */
export interface ViewSqlParts {
  /** 已校验、无 LIMIT/OFFSET 的基础语句。 */
  baseSql: string
  /** 模型（或结构化参数）给出的排序项，已引号化。 */
  baseOrder?: string
  /** 兜底排序键（通常 `_row_id`）；拿不到时为空，此时不保证翻页稳定。 */
  tie?: string
}

export interface CreateViewInput extends ViewSqlParts {
  scopeKey: string
  datasetId: string
  name: string
  /** 物理表名：只在本模块内部持有，绝不外发。 */
  tableName: string
  columns: ViewColumn[]
  countSql: string
  totalRows: number
  /** 该视图最多可翻到的行数（已与 maxQueryRows 取小）。 */
  rowCap: number
  /** 允许前端排序的列名（已登记列的白名单）。 */
  sortable: string[]
  stable: boolean
}

/** 注册后的视图（内部形态）。 */
export interface RegisteredView extends CreateViewInput {
  viewId: string
  createdAt: number
  expiresAt: number
}

/** 交给前端的描述符（`output.presentationMeta` 的载荷）。 */
export interface ViewDescriptor {
  kind: 'dataset-view'
  viewId: string
  endpoint: string
  datasetId: string
  name: string
  columns: ViewColumn[]
  totalRows: number
  pageSize: number
  maxPageSize: number
  stable: boolean
  sortable: string[]
  expiresAt: number
}

export interface ViewOptions {
  /** HTTP 路由前缀，用于拼 `endpoint`。 */
  routePrefix: string
  defaultPageSize: number
  maxPageSize: number
  /** 视图可服务行数的硬上限。 */
  maxViewRows: number
  viewTtlMs: number
  maxViews: number
}

export type SortOrder = 'asc' | 'desc'

export interface PageRequest {
  page?: number
  pageSize?: number
  sort?: string
  order?: SortOrder
}

/** 一次分页查询的 SQL 与参数（执行仍由调用方持库连接完成）。 */
export interface PageStatement {
  sql: string
  params: [number, number]
  page: number
  pageSize: number
  totalRows: number
  totalPages: number
  stable: boolean
}

export class ViewError extends Error {
  constructor(
    readonly code: 'VIEW_NOT_FOUND' | 'VIEW_EXPIRED' | 'BAD_REQUEST',
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message)
    this.name = 'ViewError'
  }
}

const VIEW_ID_BYTES = 12

function makeViewId(): string {
  return `vw_${randomBytes(VIEW_ID_BYTES).toString('hex')}`
}

function clampInteger(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.floor(n)
}

/** 拼排序子句：前端排序 > 模型排序 > 兜底键。 */
export function composeOrderBy(parts: ViewSqlParts, sort?: { column: string; order: SortOrder }): string {
  const terms: string[] = []
  if (sort !== undefined) terms.push(validateOrderBy(`${sort.column} ${sort.order}`))
  if (parts.baseOrder !== undefined && parts.baseOrder.length > 0) terms.push(parts.baseOrder)
  if (parts.tie !== undefined && parts.tie.length > 0) terms.push(parts.tie)
  return terms.join(', ')
}

export class ViewRegistry {
  private readonly views = new Map<string, RegisteredView>()
  private readonly options: ViewOptions

  // 注意：本仓库的构建链（tsdown/rolldown）在「类含 getter + 构造函数参数属性」的
  // 组合下会丢掉参数属性的赋值，因此这里显式声明字段并在构造函数里赋值。
  constructor(options: ViewOptions) {
    this.options = options
  }

  /** 当前存活视图数（测试与日志用）。 */
  get size(): number {
    return this.views.size
  }

  /** 注册一个视图并返回给前端的描述符。 */
  create(input: CreateViewInput): ViewDescriptor {
    this.evictIfNeeded()
    const viewId = makeViewId()
    const now = Date.now()
    const view: RegisteredView = {
      ...input,
      totalRows: Math.max(0, Math.min(Math.floor(input.totalRows), input.rowCap, this.options.maxViewRows)),
      viewId,
      createdAt: now,
      expiresAt: now + Math.max(1, Math.floor(this.options.viewTtlMs)),
    }
    this.views.set(viewId, view)
    return {
      kind: 'dataset-view',
      viewId,
      endpoint: `${this.options.routePrefix}/views/${viewId}/rows`,
      datasetId: view.datasetId,
      name: view.name,
      columns: view.columns,
      totalRows: view.totalRows,
      pageSize: this.options.defaultPageSize,
      maxPageSize: this.options.maxPageSize,
      stable: view.stable,
      sortable: view.sortable,
      expiresAt: view.expiresAt,
    }
  }

  /** 取一个未过期的视图；命中会刷新 TTL 与 LRU 位置。 */
  get(viewId: string): RegisteredView | undefined {
    const view = this.views.get(viewId)
    if (view === undefined) return undefined
    if (view.expiresAt <= Date.now()) {
      this.views.delete(viewId)
      return undefined
    }
    // Map 保序：先删再插 = 移到最新。
    this.views.delete(viewId)
    view.expiresAt = Date.now() + Math.max(1, Math.floor(this.options.viewTtlMs))
    this.views.set(viewId, view)
    return view
  }

  /** 主动释放（前端卸载卡片）。 */
  revoke(viewId: string): boolean {
    return this.views.delete(viewId)
  }

  clear(): void {
    this.views.clear()
  }

  /**
   * 解析分页参数并产出可直接执行的语句。
   * 排序只接受视图创建时登记的白名单列，越界一律 `BAD_REQUEST`。
   */
  page(viewId: string, request: PageRequest = {}): PageStatement {
    const view = this.get(viewId)
    if (view === undefined) {
      throw new ViewError('VIEW_NOT_FOUND', 404, '视图不存在或已过期（请重新查询）')
    }
    const maxPageSize = Math.max(1, Math.floor(this.options.maxPageSize))
    const pageSize = Math.min(Math.max(1, clampInteger(request.pageSize, this.options.defaultPageSize)), maxPageSize)
    const totalRows = view.totalRows
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
    const page = Math.min(Math.max(1, clampInteger(request.page, 1)), totalPages)

    let sort: { column: string; order: SortOrder } | undefined
    if (typeof request.sort === 'string' && request.sort.length > 0) {
      if (!view.sortable.includes(request.sort)) {
        throw new ViewError('BAD_REQUEST', 400, `不允许按该列排序：${request.sort}`)
      }
      const order: SortOrder = request.order === 'desc' ? 'desc' : 'asc'
      sort = { column: request.sort, order }
    }

    const orderBy = composeOrderBy(view, sort)
    const sql = `${view.baseSql}${orderBy.length > 0 ? ` ORDER BY ${orderBy}` : ''} LIMIT ? OFFSET ?`
    return {
      sql,
      params: [pageSize, (page - 1) * pageSize],
      page,
      pageSize,
      totalRows,
      totalPages,
      stable: view.stable,
    }
  }

  /** 容量上限时淘汰最久未使用的视图。 */
  private evictIfNeeded(): void {
    const max = Math.max(1, Math.floor(this.options.maxViews))
    while (this.views.size >= max) {
      const oldest = this.views.keys().next()
      if (oldest.done === true) return
      this.views.delete(oldest.value)
    }
  }
}

/** 视图注册中心的构造入口（`DataServices.views`）。 */
export function createViewRegistry(options: ViewOptions): ViewRegistry {
  return new ViewRegistry(options)
}
