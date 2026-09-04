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

// ── 卡片 ──────────────────────────────────────────────────────────────────

interface CardState {
  status: 'loading' | 'ready' | 'error'
  payload?: PagePayload
  message?: string
}

function DatasetViewCard(props: ToolCallViewProps): React.ReactElement | null {
  const meta = useMemo(() => asViewMeta(props.block?.meta), [props.block])
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<{ column: string; order: 'asc' | 'desc' } | undefined>(undefined)
  const [state, setState] = useState<CardState>({ status: 'loading' })
  const requestId = useRef(0)

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
    setPage(1)
    setSort(previous => previous?.column === column
      ? { column, order: previous.order === 'asc' ? 'desc' : 'asc' }
      : { column, order: 'asc' })
  }, [meta])

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
