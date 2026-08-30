/**
 * 模型可见文本的渲染（对齐 `dsh-lh-judge` 的 render.ts 定位）。
 *
 * 约定：`output.render` 只做纯函数渲染，不读状态；物理表名绝不出现在这里。
 */

import type { Row } from './db'
import type { ColumnInfo } from './parse'

export interface DatasetListItem {
  datasetId: string
  name: string
  rowCount: number
  columnCount: number
  status: string
  sourcePath: string | null
  createdAt: number
}

export const MAX_RENDER_CELL = 40
export const MAX_RENDER_ROWS = 50

export function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 单元格转义：去掉换行与竖线，避免破坏 markdown 表格。 */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Uint8Array) return `<${value.length} bytes>`
  if (typeof value === 'object') {
    try {
      return truncateText(JSON.stringify(value), MAX_RENDER_CELL)
    } catch {
      return '[object]'
    }
  }
  return truncateText(String(value), MAX_RENDER_CELL)
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function renderTable(header: string[], rows: string[][]): string {
  if (header.length === 0) return '(无内容)'
  const lines = [
    `| ${header.map(escapeCell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(escapeCell).join(' | ')} |`),
  ]
  return lines.join('\n')
}

export function formatTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '-'
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19)
}

export function renderDatasetList(items: DatasetListItem[]): string {
  if (items.length === 0) return '当前工作区还没有数据集。用 `dataset_import` 导入工作区内的 .xlsx / .xls / .csv 文件。'
  const rows = items.map(item => [
    item.datasetId,
    item.name,
    String(item.rowCount),
    String(item.columnCount),
    item.status,
    item.sourcePath ?? '-',
    formatTimestamp(item.createdAt),
  ])
  return `当前工作区共有 ${items.length} 个数据集：\n\n${renderTable(
    ['datasetId', '名称', '行数', '列数', '状态', '来源文件', '创建时间'],
    rows,
  )}`
}

export function renderColumns(columns: ColumnInfo[]): string {
  if (columns.length === 0) return '(该数据集没有列信息)'
  const rows = columns.map(column => [
    column.name,
    column.type,
    column.nullable ? '是' : '否',
    column.sample.map(formatValue).filter(value => value.length > 0).slice(0, 3).join(' / ') || '-',
    column.description ?? '-',
  ])
  return renderTable(['列名', '类型', '可空', '样例', '说明'], rows)
}

export function renderRows(columns: string[], rows: Row[], maxRows: number = MAX_RENDER_ROWS): string {
  if (rows.length === 0) return '(没有匹配的行)'
  const shown = rows.slice(0, maxRows)
  const body = shown.map(row => columns.map(column => formatValue(row[column])))
  const table = renderTable(columns, body)
  return rows.length > shown.length
    ? `${table}\n\n（仅展示前 ${shown.length} 行，共 ${rows.length} 行）`
    : table
}

/** 包装成 dsh 的回注用户消息（带 source 标记，便于去重/追踪）。 */
export interface UserMessage {
  role: 'user'
  content: { type: 'text'; text: string }[]
  source: { kind: 'plugin'; plugin: string }
}

export function toUserMessage(text: string, plugin: string): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin },
  }
}
