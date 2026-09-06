/**
 * 数据集的「表数据」分区：分页查看该数据集物理表里的数据行。
 *
 * 只读组件，不发任何写请求。取数走 `api.ts` 的 `listDatasetRows`，物理表与
 * SQL 都不出现在前端：只带 datasetId / scope 与分页参数。列顺序与列集合由
 * 服务端从元数据登记的业务列给出，`_row_id` 只当行键与行号展示。
 *
 * 翻页是「整页重取」而非增量累加：每页 20–100 行，页码由服务端按
 * `COUNT(*)` 夹紧，删除尾部行后停留在越界页码会自动落到末页。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  ADMIN_ROW_ID_COLUMN,
  ADMIN_ROW_MAX_PAGE_SIZE,
  ADMIN_ROW_PAGE_SIZE,
  type DatasetRowsResult,
} from '../../admin-contract'
import { listDatasetRows } from './api'
import { c, s } from './styles'

/** 每页条数可选项：默认 20，最大取契约上限。 */
const PAGE_SIZE_OPTIONS = [...new Set([ADMIN_ROW_PAGE_SIZE, 50, ADMIN_ROW_MAX_PAGE_SIZE])].sort((a, b) => a - b)

/** 单个单元格的展示字符上限（超长省略，完整值放 title）。 */
const CELL_MAX_LENGTH = 80

function cellText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value)
    } catch {
      return '[object]'
    }
  }
  return String(value)
}

function Cell(props: { value: unknown }): ReactElement {
  const { value } = props
  if (value === null || value === undefined) {
    return <span style={{ color: c.fg2 }}>—</span>
  }
  const text = cellText(value)
  return <span title={text}>{text.length > CELL_MAX_LENGTH ? `${text.slice(0, CELL_MAX_LENGTH)}…` : text}</span>
}

export interface RowsPanelProps {
  datasetId: string
  scopeKey: string
  /** 元数据登记的行数，只用于与真实行数比对后给出提示。 */
  recordedRows: number
  /** 数据集状态：非就绪时给出提示，但不阻断查看。 */
  status: string
}

export function RowsPanel(props: RowsPanelProps): ReactElement {
  const { datasetId, scopeKey, recordedRows, status } = props
  const [data, setData] = useState<DatasetRowsResult | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(ADMIN_ROW_PAGE_SIZE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  const load = useCallback(async (target: number, size: number): Promise<void> => {
    const id = requestId.current + 1
    requestId.current = id
    setLoading(true)
    setError(null)
    try {
      const result = await listDatasetRows(datasetId, scopeKey, target, size)
      if (id !== requestId.current) return
      setData(result)
      // 服务端会把页码夹到分页边界内，以它返回的为准。
      setPage(result.page)
    } catch (failure) {
      if (id !== requestId.current) return
      setError(failure instanceof Error ? failure.message : '加载数据失败')
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [datasetId, scopeKey])

  // 换数据集（外层用 key 重挂载）或改每页条数：回到第一页重取。
  useEffect(() => {
    setData(null)
    void load(1, pageSize)
  }, [load, pageSize])

  const total = data?.total ?? 0
  const totalPages = data?.totalPages ?? 1
  const columns = data?.columns ?? []
  const rows = data?.rows ?? []

  return (
    <div style={s.panel}>
      <div style={{ ...s.head, display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <strong style={{ fontSize: 13 }}>表数据</strong>
        <span style={s.muted}>{loading ? '加载中…' : `共 ${total} 行`}</span>
      </div>

      {status !== 'ready' ? <div style={{ ...s.muted, marginBottom: 8 }}>数据集当前状态为 {status}，数据可能不完整。</div> : null}
      {error !== null ? <div style={{ ...s.banner, marginTop: 0 }}><span>{error}</span></div> : null}
      {recordedRows !== total && error === null && data !== null
        ? <div style={{ ...s.muted, marginBottom: 8 }}>元数据登记 {recordedRows} 行，实际 {total} 行。</div>
        : null}

      {columns.length > 0
        ? (
          <div style={{ ...s.scroll, maxHeight: 320 }}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>#</th>
                  {columns.map(column => <th key={column} style={s.th} title={column}>{column}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={String(row[ADMIN_ROW_ID_COLUMN] ?? '')}>
                    <td style={{ ...s.td, color: c.fg2, maxWidth: 60 }}>{String(row[ADMIN_ROW_ID_COLUMN] ?? '')}</td>
                    {columns.map(column => (
                      <td key={column} style={s.td}><Cell value={row[column]} /></td>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 && !loading
                  ? (
                    <tr>
                      <td style={{ ...s.td, color: c.fg2, padding: '16px 8px', textAlign: 'center' }} colSpan={columns.length + 1}>
                        {total === 0 ? '该数据集还没有数据行' : '这一页没有数据'}
                      </td>
                    </tr>
                    )
                  : null}
              </tbody>
            </table>
          </div>
          )
        : loading
          ? <div style={s.muted}>加载中…</div>
          : error === null
            ? <div style={s.muted}>该数据集没有已登记的列，无法展示数据。</div>
            : null}

      <div style={{ ...s.bar, display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <button
          type="button"
          style={{ ...s.button, ...(page <= 1 || loading ? s.disabledButton : null) }}
          disabled={page <= 1 || loading}
          onClick={() => void load(1, pageSize)}
        >« 首页</button>
        <button
          type="button"
          style={{ ...s.button, ...(page <= 1 || loading ? s.disabledButton : null) }}
          disabled={page <= 1 || loading}
          onClick={() => void load(page - 1, pageSize)}
        >上一页</button>
        <span>第 {page} / {totalPages} 页</span>
        <button
          type="button"
          style={{ ...s.button, ...(page >= totalPages || loading ? s.disabledButton : null) }}
          disabled={page >= totalPages || loading}
          onClick={() => void load(page + 1, pageSize)}
        >下一页</button>
        <button
          type="button"
          style={{ ...s.button, ...(page >= totalPages || loading ? s.disabledButton : null) }}
          disabled={page >= totalPages || loading}
          onClick={() => void load(totalPages, pageSize)}
        >末页 »</button>
        <label style={{ ...s.muted, display: 'flex', alignItems: 'center', gap: 4 }}>
          每页
          <select
            style={s.select}
            value={pageSize}
            disabled={loading}
            onChange={event => setPageSize(Number(event.target.value))}
          >
            {PAGE_SIZE_OPTIONS.map(size => <option key={size} value={size}>{size}</option>)}
          </select>
          行
        </label>
        <button
          type="button"
          style={{ ...s.button, ...(loading ? s.disabledButton : null) }}
          disabled={loading}
          onClick={() => void load(page, pageSize)}
        >刷新</button>
      </div>
    </div>
  )
}
