/**
 * 跨工作区聚合的数据集列表表格。列：名称 / 工作区 / 行数 / 列数 / 状态 / 来源 / 更新时间。
 * 列表与详情/编辑是上下分区的：本组件只负责表格与分页，选中回调上抛给 Section。
 */

import type { ReactElement } from 'react'
import type { DatasetAdminView } from '../../admin-contract'
import { c, s, STATUS_COLOR } from './styles'

const STATUS_TEXT: Record<string, string> = { ready: '就绪', importing: '导入中', failed: '失败' }

export function fmtAgo(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function ellipsis(value: string | null, max = 32): string {
  if (value === null) return '—'
  return value.length > max ? `${value.slice(0, max)}…` : value
}

export interface DatasetTableProps {
  items: DatasetAdminView[]
  page: number
  pageSize: number
  total: number
  selectedId: string | null
  loading: boolean
  selectedIds: Set<string>
  onSelect: (item: DatasetAdminView) => void
  onToggleSelect: (id: string) => void
  onToggleAll: () => void
  onPageChange: (page: number) => void
}

export function DatasetTable(props: DatasetTableProps): ReactElement {
  const { items, page, pageSize, total, selectedId, loading, selectedIds, onSelect, onToggleSelect, onToggleAll, onPageChange } = props
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const allSelected = items.length > 0 && items.every(item => selectedIds.has(item.id))

  const rows = items.length === 0 && !loading
    ? (
      <tr>
        <td style={{ ...s.td, color: c.fg2, padding: '18px 8px', textAlign: 'center' }} colSpan={8}>
          还没有数据集，用 agent 的 dataset_import 导入，或直接点击「新建数据集」
        </td>
      </tr>
      )
    : items.map(item => (
      <tr
        key={`${item.scopeKey}:${item.id}`}
        style={{
          ...s.row,
          ...(item.id === selectedId ? s.selectedRow : null),
          ...(selectedIds.has(item.id) ? { background: c.subtle } : null),
        }}
        onClick={() => onSelect(item)}
      >
        <td style={{ ...s.td, textAlign: 'center', width: 32 }} onClick={event => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={selectedIds.has(item.id)}
            onChange={() => onToggleSelect(item.id)}
          />
        </td>
        <td style={s.td} title={item.name}>{ellipsis(item.name, 40)}</td>
        <td style={s.td} title={item.scopeKey}>{ellipsis(item.scopeKey, 36)}</td>
        <td style={s.td}>{item.rowCount}</td>
        <td style={s.td}>{item.columnCount}</td>
        <td style={s.td}>
          <span style={{ ...s.dot, background: STATUS_COLOR[item.status] ?? c.fg2 }} />
          {STATUS_TEXT[item.status] ?? item.status}
        </td>
        <td style={s.td} title={item.sourcePath ?? ''}>{ellipsis(item.sourcePath, 40)}</td>
        <td style={{ ...s.td, color: c.fg2 }}>{fmtAgo(item.updatedAt)}</td>
      </tr>
    ))

  return (
    <div>
      <div style={s.scroll}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={{ ...s.th, textAlign: 'center', width: 32 }}>
                <input type="checkbox" checked={allSelected} onChange={onToggleAll} />
              </th>
              <th style={s.th}>名称</th>
              <th style={s.th}>工作区</th>
              <th style={s.th}>行数</th>
              <th style={s.th}>列数</th>
              <th style={s.th}>状态</th>
              <th style={s.th}>来源</th>
              <th style={s.th}>更新时间</th>
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
      <div style={{ ...s.bar, display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <button
          type="button"
          style={{ ...s.button, ...(page <= 1 ? s.disabledButton : null) }}
          disabled={page <= 1}
          onClick={() => onPageChange(1)}
        >« 首页</button>
        <button
          type="button"
          style={{ ...s.button, ...(page <= 1 ? s.disabledButton : null) }}
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >上一页</button>
        <span>第 {Math.min(page, totalPages)} / {totalPages} 页 · 共 {total} 个</span>
        <button
          type="button"
          style={{ ...s.button, ...(page >= totalPages ? s.disabledButton : null) }}
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >下一页</button>
        {loading ? <span style={s.muted}>加载中…</span> : null}
      </div>
    </div>
  )
}
