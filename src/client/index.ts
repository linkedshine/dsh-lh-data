/**
 * 浏览器半身：`dataset_query` 的结果表格卡片 —— 设计文档 §7。
 *
 * 它接管 `tool.call.toolview` 上 key = `dataset_query` 的渲染位，按工具结果里的
 * `meta`（`output.presentationMeta` 产出，模型不可见）自动拉取并展示完整结果：
 * 翻页、排序、过期提示，全部只带 `viewId`，不接触任何 SQL 或物理表名。
 *
 * 构建契约（与 dsh 的 client bundle preset 一致）：
 * - 产物是 CJS 工厂，由 `window.__ModuleLoader__.load({ id, factory })` 注册；
 * - `react` 是平台 seed 词，运行时由模块表提供，打包时保持 external；
 * - 只能用基线能力（React + cordis slots），不请求任何额外工作区包。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ADMIN_SECTION_ID, ADMIN_SECTION_LABEL, ADMIN_SECTION_ORDER } from '../admin-contract'
import { DatasetSettingsSection } from './settings/Section'

/** 本插件注册的工具名，也是 `tool.call.toolview` 的 keyed 派发键。 */
const TOOL_KEY = 'dataset_query'
const TOOLVIEW_SLOT = 'tool.call.toolview'

// ── 平台面（只声明本组件实际用到的部分） ──────────────────────────────────

interface SlotRegistry {
  inject(slot: string, setup: () => () => void): void
  // spec 是开放对象：toolview 用 key，settings.section 用 id/order/label 等。
  register(spec: { name: string; [key: string]: unknown }, component: unknown): () => void
}

interface ToolCallViewProps {
  toolName: string
  /** 冻结中的调用或已落地的结果节点。 */
  block: {
    meta?: unknown
    content?: { type: string; text?: string }[]
  }
}

// ── 视图元数据契约（与 view.ts 的 ViewDescriptor 对齐） ───────────────────

interface ViewColumn { name: string; type: string }

interface DatasetViewMeta {
  kind: string
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

interface PagePayload {
  columns: string[]
  rows: Record<string, unknown>[]
  page: number
  pageSize: number
  totalRows: number
  totalPages: number
}

function asViewMeta(value: unknown): DatasetViewMeta | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const meta = value as Partial<DatasetViewMeta>
  if (meta.kind !== 'dataset-view') return undefined
  if (typeof meta.viewId !== 'string' || typeof meta.endpoint !== 'string') return undefined
  return meta as DatasetViewMeta
}

// ── 样式（内联，避免引入 CSS 管线） ────────────────────────────────────────

const styles = {
  wrap: { margin: '8px 0', fontSize: 12, color: 'var(--dsw-fg-secondary, #666)' },
  head: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  title: { fontWeight: 600, color: 'var(--dsw-fg, inherit)' },
  scroll: { maxHeight: 420, overflow: 'auto', border: '1px solid var(--dsw-border, #e5e5e5)', borderRadius: 6 },
  table: { borderCollapse: 'collapse', width: '100%', fontSize: 12 },
  th: {
    position: 'sticky', top: 0, background: 'var(--dsw-bg-subtle, #fafafa)',
    textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--dsw-border, #e5e5e5)',
    whiteSpace: 'nowrap',
  } as const,
  thButton: { background: 'none', border: 'none', cursor: 'pointer', font: 'inherit', padding: 0, color: 'inherit' },
  td: { padding: '4px 8px', borderBottom: '1px solid var(--dsw-border, #eee)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const,
  bar: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  button: { border: '1px solid var(--dsw-border, #ddd)', background: 'transparent', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 12 },
  muted: { opacity: 0.7 },
  error: { color: 'var(--dsw-danger, #c0392b)' },
} as const

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return '[object]'
    }
  }
  return String(value)
}

// ── CSV 导出（纯字符串构造，不引入任何依赖） ─────────────────────────────

/** 命中即需要加引号转义的字符：逗号、双引号、回车、换行。 */
const CSV_NEEDS_QUOTE = /[",\r\n]/
/** Excel 公式注入的高危前缀；只对文本值生效，负数等数值原样导出。 */
const CSV_RISKY_PREFIX = /^[=+\-@\t\r]/

function toCsvCell(value: unknown): string {
  let text = formatCell(value)
  if (text.length === 0) return ''
  // 前置单引号：Excel 会把它当公式执行，内容本身不变。
  if (typeof value === 'string' && CSV_RISKY_PREFIX.test(text)) text = `'${text}`
  if (CSV_NEEDS_QUOTE.test(text)) text = `"${text.replace(/"/g, '""')}"`
  return text
}

function toCsvRow(cells: unknown[]): string {
  return cells.map(cell => toCsvCell(cell)).join(',')
}

/** 表头 + 数据行；行分隔用 `\r\n` 且末行收尾，Excel / Numbers 都不会串列。 */
function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [toCsvRow(columns)]
  for (const row of rows) lines.push(toCsvRow(columns.map(column => row[column])))
  return `${lines.join('\r\n')}\r\n`
}

/** 只拼数据行：导出逐页追加时用（表头由 `toCsv` 的首页分片带出）。 */
function toCsvRows(columns: string[], rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  return `${rows.map(row => toCsvRow(columns.map(column => row[column]))).join('\r\n')}\r\n`
}

/** 文件名 `名称-YYYYMMDD-HHmmss.csv`，剔除文件系统不接受与控制字符。 */
function buildCsvFileName(name: string, now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const safe = name.replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim()
  return `${safe.length > 0 ? safe : 'dataset'}-${stamp}.csv`
}

/** Blob + 临时 `<a download>` 触发下载；前置 BOM 让 Excel 认成 UTF-8。 */
function downloadCsv(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([`\uFEFF${text}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 立刻回收会让部分浏览器来不及取流，延后一拍释放。
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

// ── 卡片 ──────────────────────────────────────────────────────────────────

interface CardState {
  status: 'loading' | 'ready' | 'error'
  payload?: PagePayload
  message?: string
}

/** 导出进度与结果（与分页取数状态分开，互不覆盖）。 */
interface ExportState {
  running: boolean
  progress?: { done: number; total: number }
  error?: string
}

function DatasetViewCard(props: ToolCallViewProps): React.ReactElement | null {
  const meta = useMemo(() => asViewMeta(props.block?.meta), [props.block])
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<{ column: string; order: 'asc' | 'desc' } | undefined>(undefined)
  const [state, setState] = useState<CardState>({ status: 'loading' })
  const requestId = useRef(0)
  // 导出走独立通道：翻页不打断它，只有卸载与排序变更才中止。
  const exportAbort = useRef<AbortController | undefined>(undefined)
  const [exportState, setExportState] = useState<ExportState>({ running: false })

  useEffect(() => () => exportAbort.current?.abort(), [])

  useEffect(() => {
    if (meta === undefined) return
    const controller = new AbortController()
    const id = requestId.current + 1
    requestId.current = id
    setState(previous => previous.status === 'ready' ? { ...previous, status: 'loading' } : previous)

    const url = new URL(meta.endpoint, window.location.origin)
    url.searchParams.set('page', String(page))
    url.searchParams.set('pageSize', String(meta.pageSize))
    if (sort !== undefined) {
      url.searchParams.set('sort', sort.column)
      url.searchParams.set('order', sort.order)
    }

    void (async () => {
      try {
        const response = await fetch(url.toString(), { signal: controller.signal, credentials: 'same-origin' })
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: { code?: string } } | null
          if (id === requestId.current) {
            setState({
              status: 'error',
              message: body?.error?.code === 'VIEW_NOT_FOUND' || response.status === 404
                ? '结果已过期，请重新查询'
                : `取数失败（HTTP ${response.status}）`,
            })
          }
          return
        }
        const payload = await response.json() as PagePayload
        if (id === requestId.current) setState({ status: 'ready', payload })
      } catch (error) {
        if (controller.signal.aborted) return
        if (id === requestId.current) setState({ status: 'error', message: `取数失败：${String(error)}` })
      }
    })()

    return () => controller.abort()
  }, [meta, page, sort])

  const toggleSort = useCallback((column: string) => {
    if (meta === undefined || !meta.sortable.includes(column)) return
    // 顺序变了，正在导出的那份行序就作废。
    if (exportAbort.current !== undefined) {
      exportAbort.current.abort()
      exportAbort.current = undefined
      setExportState({ running: false })
    }
    setPage(1)
    setSort(previous => previous?.column === column
      ? { column, order: previous.order === 'asc' ? 'desc' : 'asc' }
      : { column, order: 'asc' })
  }, [meta])

  /**
   * 导出全部可浏览行为 CSV：把 `pageSize` 顶到 `maxPageSize`，从第 1 页顺序翻到
   * 末页，不受当前页码/每页行数限制。每页转成字符串分片后即丢掉行对象，
   * 避免几万行对象同时常驻；最后拼一次 Blob 触发下载。
   */
  const exportCsv = useCallback(() => {
    if (meta === undefined) return
    exportAbort.current?.abort()
    const controller = new AbortController()
    exportAbort.current = controller
    setExportState({ running: true, progress: { done: 0, total: meta.totalRows } })

    void (async () => {
      try {
        const base = new URL(meta.endpoint, window.location.origin)
        base.searchParams.set('pageSize', String(Math.max(1, Math.floor(meta.maxPageSize > 0 ? meta.maxPageSize : meta.pageSize))))
        if (sort !== undefined) {
          base.searchParams.set('sort', sort.column)
          base.searchParams.set('order', sort.order)
        }

        const chunks: string[] = []
        let exportColumns = meta.columns.map(column => column.name)
        let totalRows = meta.totalRows
        let totalPages = 1
        let done = 0

        for (let index = 1; index <= totalPages; index += 1) {
          if (controller.signal.aborted) return
          const url = new URL(base.toString())
          url.searchParams.set('page', String(index))
          const response = await fetch(url.toString(), { signal: controller.signal, credentials: 'same-origin' })
          if (!response.ok) {
            const body = await response.json().catch(() => null) as { error?: { code?: string } } | null
            if (controller.signal.aborted) return
            throw new Error(body?.error?.code === 'VIEW_NOT_FOUND' || response.status === 404
              ? '结果已过期，请重新查询'
              : `导出失败（HTTP ${response.status}）`)
          }
          const current = await response.json() as PagePayload
          if (controller.signal.aborted) return
          if (index === 1) {
            // 列集合与总页数只认首屏，避免中途数据变化导致串列。
            exportColumns = current.columns.length > 0 ? current.columns : exportColumns
            totalRows = current.totalRows
            totalPages = Math.max(1, current.totalPages)
            chunks.push(toCsv(exportColumns, current.rows))
          } else {
            chunks.push(toCsvRows(exportColumns, current.rows))
          }
          done += current.rows.length
          setExportState({ running: true, progress: { done, total: totalRows } })
        }

        downloadCsv(buildCsvFileName(meta.name), chunks.join(''))
        if (exportAbort.current === controller) exportAbort.current = undefined
        setExportState({ running: false })
      } catch (error) {
        if (controller.signal.aborted) return
        if (exportAbort.current === controller) exportAbort.current = undefined
        setExportState({ running: false, error: error instanceof Error ? error.message : `导出失败：${String(error)}` })
      }
    })()
  }, [meta, sort])

  // 无视图（小结果集 / 主机未启用视图）：退化为纯文本，不发起任何请求。
  if (meta === undefined) {
    const text = (props.block?.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('\n')
    return React.createElement('div', { style: styles.wrap }, React.createElement('pre', { style: { margin: 0, whiteSpace: 'pre-wrap' } }, text))
  }

  const payload = state.payload
  const columns = payload?.columns ?? meta.columns.map(column => column.name)
  const rows = payload?.rows ?? []
  const totalPages = payload?.totalPages ?? Math.max(1, Math.ceil(meta.totalRows / meta.pageSize))
  const busy = state.status === 'loading' && payload === undefined
  // 服务端把 page 夹到分页边界内，首屏拿到 totalPages 后即可反推可浏览的行数上限。
  const servableRows = payload === undefined ? meta.totalRows : payload.totalPages * payload.pageSize

  const head = React.createElement('tr', null, ...columns.map(column => React.createElement(
    'th',
    { key: column, style: styles.th },
    meta.sortable.includes(column)
      ? React.createElement('button', {
        type: 'button',
        style: styles.thButton,
        onClick: () => toggleSort(column),
        title: '按该列排序',
      }, `${column}${sort?.column === column ? (sort.order === 'asc' ? ' ↑' : ' ↓') : ''}`)
      : column,
  )))

  const body = rows.map((row, index) => React.createElement('tr', { key: String(row._row_id ?? index) },
    ...columns.map(column => React.createElement('td', { key: column, style: styles.td, title: formatCell(row[column]) }, formatCell(row[column])))))

  return React.createElement('div', { style: styles.wrap },
    React.createElement('div', { style: styles.head },
      React.createElement('span', { style: styles.title }, `数据集 ${meta.name}`),
      React.createElement('span', null, `共 ${meta.totalRows} 行 · ${meta.columns.length} 列`),
      servableRows < meta.totalRows
        ? React.createElement('span', { style: styles.muted }, `（仅可浏览前 ${servableRows} 行）`)
        : null,
      state.status === 'error' ? React.createElement('span', { style: styles.error }, state.message ?? '') : null,
      busy ? React.createElement('span', { style: styles.muted }, '加载中…') : null,
    ),
    React.createElement('div', { style: styles.scroll },
      React.createElement('table', { style: styles.table },
        React.createElement('thead', null, head),
        React.createElement('tbody', null, ...body))),
    React.createElement('div', { style: styles.bar },
      React.createElement('button', { type: 'button', style: styles.button, disabled: page <= 1, onClick: () => setPage(1) }, '« 首页'),
      React.createElement('button', { type: 'button', style: styles.button, disabled: page <= 1, onClick: () => setPage(current => Math.max(1, current - 1)) }, '上一页'),
      React.createElement('span', null, `第 ${payload?.page ?? page} / ${totalPages} 页`),
      React.createElement('button', {
        type: 'button',
        style: styles.button,
        disabled: !meta.stable || page >= totalPages,
        onClick: () => setPage(current => Math.min(totalPages, current + 1)),
      }, '下一页'),
      !meta.stable ? React.createElement('span', { style: styles.muted }, '（该查询未声明稳定排序，仅展示首页）') : null,
      React.createElement('button', {
        type: 'button',
        style: styles.button,
        disabled: exportState.running || state.status === 'error',
        title: `按当前排序导出全部可浏览行（${servableRows} 行）为 CSV`,
        onClick: exportCsv,
      }, exportState.running
        ? `导出中…（${exportState.progress?.done ?? 0} / ${exportState.progress?.total ?? servableRows} 行）`
        : '导出 CSV'),
      exportState.error === undefined
        ? null
        : React.createElement('span', { style: styles.error }, exportState.error),
    ))
}

// ── cordis 插件（浏览器半身） ─────────────────────────────────────────────

export const name = 'dsh-lh-data'
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  const slots = (ctx as unknown as { slots?: SlotRegistry }).slots
  if (slots === undefined) return
  slots.inject(TOOLVIEW_SLOT, () => slots.register({ name: TOOLVIEW_SLOT, key: TOOL_KEY }, DatasetViewCard))
  // 设置面板新增「数据集」菜单（外部插件可自由注册该 list slot）。
  slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: ADMIN_SECTION_ID, order: ADMIN_SECTION_ORDER, label: ADMIN_SECTION_LABEL },
      DatasetSettingsSection,
    ))
}
