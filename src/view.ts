/**
 * 查询结果视图注册中心 —— 设计文档 §6。
 *
 * 视图是**主机侧的句柄**：`viewId` 之外的一切（物理表名、count/page 语句）都留在这里，
 * 既不出现在模型上下文里，也不出现在 HTTP 响应里。前端只能拿 `viewId` + 分页参数换页。
 *
 * 生命周期：视图元数据持久化到数据库表（`lh_views`，与 `datasets` 同库同 scope），
 * 进程重启 / 插件重载 / 热更新后仍能继续翻页查看，永不过期、不被容量淘汰。
 * 翻页行数据始终实时查询原始数据表，因此底层数据可能被并发写入改变
 * （前端卡片常驻软警告「数据可能已发生变化」）。
 *
 * 内部仍保留 `Map` 作为热缓存，`get()` / `page()` / `revoke()` 同步操作缓存（翻页 O(1)），
 * 仅 `create` / `revoke` 会写库，启动时 `loadAll()` 从各库预载一次。
 */

import { randomBytes } from 'node:crypto'
import { debugLog } from './tooling'
import { validateOrderBy } from './sql'
import type { Database, Row } from './db'
import type { ScopeRegistry } from './scope-registry'

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
}

export interface ViewOptions {
  /** HTTP 路由前缀，用于拼 `endpoint`。 */
  routePrefix: string
  defaultPageSize: number
  maxPageSize: number
  /** 视图可服务行数的硬上限。 */
  maxViewRows: number
}

/** 持久化所需的外部依赖（以回调注入，避免与 store 形成值循环依赖）。 */
export interface ViewDeps {
  /** 已登记工作区枚举（`loadAll` 遍历用）。 */
  scopes: ScopeRegistry
  /** 按 scope 取得对应业务库连接。 */
  database: (scopeKey: string) => Promise<Database>
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
    readonly code: 'VIEW_NOT_FOUND' | 'BAD_REQUEST',
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message)
    this.name = 'ViewError'
  }
}

const VIEW_ID_BYTES = 12

/** 持久化视图表的建表语句（与 datasets 同库，per-scope）。 */
const LH_VIEWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS lh_views (
  view_id    TEXT PRIMARY KEY,
  scope_key  TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  table_name TEXT NOT NULL,
  base_sql   TEXT NOT NULL,
  base_order TEXT,
  tie        TEXT,
  count_sql  TEXT NOT NULL,
  columns    TEXT NOT NULL,
  total_rows INTEGER NOT NULL,
  row_cap    INTEGER NOT NULL,
  sortable   TEXT NOT NULL,
  stable     INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lh_views_scope ON lh_views(scope_key);
`

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
  private readonly deps: ViewDeps

  // 注意：本仓库的构建链（tsdown/rolldown）在「类含 getter + 构造函数参数属性」的
  // 组合下会丢掉参数属性的赋值，因此这里显式声明字段并在构造函数里赋值。
  constructor(options: ViewOptions, deps: ViewDeps) {
    this.options = options
    this.deps = deps
  }

  /** 当前存活视图数（测试与日志用）。 */
  get size(): number {
    return this.views.size
  }

  /** 确保某 scope 的业务库已存在视图表（幂等），返回库连接。 */
  private async ensureTable(scopeKey: string): Promise<Database> {
    const db = await this.deps.database(scopeKey)
    await db.exec(LH_VIEWS_SCHEMA)
    return db
  }

  /** 把一行 DB 记录还原成内部视图对象。 */
  private static fromRow(row: Row): RegisteredView {
    let columns: ViewColumn[] = []
    try {
      const parsed: unknown = JSON.parse(String(row.columns ?? '[]'))
      if (Array.isArray(parsed)) columns = parsed as ViewColumn[]
    } catch {
      columns = []
    }
    let sortable: string[] = []
    try {
      const parsed: unknown = JSON.parse(String(row.sortable ?? '[]'))
      if (Array.isArray(parsed)) sortable = parsed as string[]
    } catch {
      sortable = []
    }
    return {
      viewId: String(row.view_id),
      scopeKey: String(row.scope_key),
      datasetId: String(row.dataset_id),
      name: String(row.name),
      tableName: String(row.table_name),
      baseSql: String(row.base_sql),
      baseOrder: row.base_order === null || row.base_order === undefined ? undefined : String(row.base_order),
      tie: row.tie === null || row.tie === undefined ? undefined : String(row.tie),
      countSql: String(row.count_sql),
      columns,
      totalRows: Number(row.total_rows ?? 0),
      rowCap: Number(row.row_cap ?? 0),
      sortable,
      stable: Number(row.stable ?? 0) === 1,
      createdAt: Number(row.created_at ?? 0),
    }
  }

  /** 注册一个视图：双写内存缓存与数据库表，返回给前端的描述符。 */
  async create(input: CreateViewInput): Promise<ViewDescriptor> {
    const viewId = makeViewId()
    const now = Date.now()
    const total = Math.max(0, Math.floor(input.totalRows))
    const view: RegisteredView = {
      ...input,
      totalRows: total,
      viewId,
      createdAt: now,
    }
    // 先写内存，保证创建后立即可读（如本会话内翻页）。
    this.views.set(viewId, view)

    const db = await this.ensureTable(input.scopeKey)
    await db.prepare(
      `INSERT INTO lh_views
        (view_id, scope_key, dataset_id, name, table_name, base_sql, base_order, tie, count_sql, columns, total_rows, row_cap, sortable, stable, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      view.viewId,
      view.scopeKey,
      view.datasetId,
      view.name,
      view.tableName,
      view.baseSql,
      view.baseOrder ?? null,
      view.tie ?? null,
      view.countSql,
      JSON.stringify(view.columns),
      view.totalRows,
      view.rowCap,
      JSON.stringify(view.sortable),
      view.stable ? 1 : 0,
      view.createdAt,
    )
    debugLog('view:create', {
      viewId,
      scopeKey: view.scopeKey,
      totalRows: view.totalRows,
      rowCap: input.rowCap,
      maxViewRows: this.options.maxViewRows,
    })
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
    }
  }

  /** 取一个已注册的视图（同步读内存缓存；启动已 loadAll 预载）。 */
  get(viewId: string): RegisteredView | undefined {
    return this.views.get(viewId)
  }

  /** 主动释放（前端卸载卡片 / DELETE）。双删：内存缓存 + 数据库行。 */
  async revoke(viewId: string): Promise<boolean> {
    const view = this.views.get(viewId)
    if (view === undefined) return false
    this.views.delete(viewId)
    const db = await this.ensureTable(view.scopeKey)
    await db.prepare('DELETE FROM lh_views WHERE view_id = ?').run(viewId)
    return true
  }

  /** 仅清空内存热缓存（不删库表，否则持久化失效）。 */
  clear(): void {
    this.views.clear()
  }

  /**
   * 启动时预载：遍历所有已登记 scope，把各库 `lh_views` 表读进内存。
   * 必须在注册路由前完成，避免早期请求漏命中。
   */
  async loadAll(): Promise<void> {
    const entries = await this.deps.scopes.list()
    for (const entry of entries) {
      const db = await this.ensureTable(entry.scopeKey)
      const rows = await db.prepare('SELECT * FROM lh_views WHERE scope_key = ?').all(entry.scopeKey)
      for (const row of rows) {
        const view = ViewRegistry.fromRow(row)
        this.views.set(view.viewId, view)
      }
    }
    debugLog('view:loadAll', { scopes: entries.length, views: this.views.size })
  }

  /**
   * 解析分页参数并产出可直接执行的语句。
   * 排序只接受视图创建时登记的白名单列，越界一律 `BAD_REQUEST`。
   */
  page(viewId: string, request: PageRequest = {}): PageStatement {
    const view = this.get(viewId)
    if (view === undefined) {
      throw new ViewError('VIEW_NOT_FOUND', 404, '视图不存在或接口不可用（请重新查询）')
    }
    const maxPageSize = Math.max(1, Math.floor(this.options.maxPageSize))
    const pageSize = Math.min(Math.max(1, clampInteger(request.pageSize, this.options.defaultPageSize)), maxPageSize)
    const totalRows = view.totalRows
    // 分页边界：命中数、模型声明的上限（rowCap）、全局硬上限三者取小。
    const servable = Math.max(0, Math.min(totalRows, view.rowCap, this.options.maxViewRows))
    const totalPages = Math.max(1, Math.ceil(servable / pageSize))
    const page = Math.min(Math.max(1, clampInteger(request.page, 1)), totalPages)
    debugLog('view:page', {
      viewId,
      page,
      pageSize,
      totalRows,
      servable,
      totalPages,
    })

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
}

/** 视图注册中心的构造入口（`DataServices.views`）。 */
export function createViewRegistry(options: ViewOptions, deps: ViewDeps): ViewRegistry {
  return new ViewRegistry(options, deps)
}
