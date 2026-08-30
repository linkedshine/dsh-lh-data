/**
 * 模型可见文本的渲染（对齐 `dsh-lh-judge` 的 render.ts 定位）。
 *
 * 约定：`output.render` 只做纯函数渲染，不读状态；物理表名绝不出现在这里。
 */

import type { Row } from './db'
import type { ColumnInfo } from './parse'
import { truncateCell, type ColumnSummary } from './preview'

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

// ── 查询结果片段（设计文档 §5.3） ────────────────────────────────────────

/** 片段渲染的输入（结构化而非 import 工具类型，避免 render → tools 的循环）。 */
export interface QueryPreviewInput {
  name: string
  datasetId: string
  columnCount: number
  /** 实际命中行数。 */
  matchedRows: number
  /** 本次可服务行数（已按上限收敛）。 */
  totalRows: number
  preview: {
    rows: Row[]
    columns: string[]
    /** 头段行数；`gap` 为真时其后是尾段。 */
    headCount: number
    gap: boolean
    skipped: number
    columnTruncated: boolean
    hiddenColumns: number
  }
  summary: ColumnSummary[]
  /** 有小节被省略（预览只是结果的一部分）。 */
  truncated: boolean
  /** 存在前端视图。 */
  view?: { pageSize: number; stable: boolean }
}

function renderPreviewTable(columns: string[], rows: Row[], maxCell: number): string {
  const body = rows.map(row => columns.map(column => {
    const { text } = truncateCell(row[column], maxCell)
    return text
  }))
  return renderTable(columns, body)
}

function formatSummaryValue(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'number') return String(Number(value.toFixed(4)))
  return truncateText(String(value), 24)
}

function renderSummaryLine(summary: ColumnSummary, totalRows: number): string {
  const label = `${summary.name} ${summary.type}`
  if (summary.type === 'boolean') {
    return `- ${label}：真 ${summary.trueCount ?? 0} / 非空 ${summary.count} / 共 ${totalRows}`
  }
  if (summary.type === 'text') {
    const distinct = summary.distinct ?? 0
    const top = summary.top
    if (top !== undefined && top.length > 0) {
      const parts = top.map(entry => `${entry.value} ${entry.count}`).join(' / ')
      return `- ${label}：distinct ${distinct} → ${parts}${distinct > top.length ? ' …' : ''}`
    }
    return `- ${label}：distinct ${distinct}（取值过于分散，已省略明细）/ 非空 ${summary.count}`
  }
  const parts = [`min ${formatSummaryValue(summary.min)}`, `max ${formatSummaryValue(summary.max)}`]
  if (summary.type === 'numeric') {
    parts.push(`avg ${formatSummaryValue(summary.avg)}`, `sum ${formatSummaryValue(summary.sum)}`)
  }
  parts.push(`空 ${Math.max(0, totalRows - summary.count)}`)
  return `- ${label}：${parts.join(' / ')}`
}

/**
 * 渲染查询结果的模型可见片段：行数概览 + 少量预览行 + 类型化摘要 + 视图提示。
 * 目标是把上下文占用压到常量级，同时保留「足以下结论」的统计信息。
 */
export function renderQueryPreview(input: QueryPreviewInput): string {
  const { preview } = input
  const scope = input.matchedRows === input.totalRows
    ? `共 ${input.totalRows} 行`
    : `命中 ${input.matchedRows} 行（本次可服务 ${input.totalRows} 行）`
  const lines: string[] = [
    `数据集 ${input.name}（${input.datasetId}）：${scope} × ${input.columnCount} 列，返回 ${preview.rows.length} 行预览。`,
    '',
  ]

  if (preview.rows.length === 0) {
    lines.push('(没有匹配的行)')
  } else if (preview.gap && preview.headCount > 0 && preview.headCount < preview.rows.length) {
    lines.push(
      renderPreviewTable(preview.columns, preview.rows.slice(0, preview.headCount), MAX_RENDER_CELL),
      '',
      `（… 省略 ${preview.skipped} 行 …）`,
      '',
      renderPreviewTable(preview.columns, preview.rows.slice(preview.headCount), MAX_RENDER_CELL),
    )
  } else {
    lines.push(renderPreviewTable(preview.columns, preview.rows, MAX_RENDER_CELL))
  }

  if (preview.columnTruncated) {
    lines.push('', `（仅展示前 ${preview.columns.length} 列，另有 ${preview.hiddenColumns} 列）`)
  }

  if (input.summary.length > 0) {
    lines.push('', '摘要：', ...input.summary.map(summary => renderSummaryLine(summary, input.totalRows)))
  }

  if (input.view !== undefined) {
    lines.push(
      '',
      `完整结果（${input.totalRows} 行）已在结果表格中展示${input.view.stable ? '' : '（该查询未声明稳定排序，仅展示首页）'}。`,
      '若需据此下结论，请用更精确的 where 或聚合 SQL 再查一次；不要试图逐页读取全量。',
    )
  } else if (input.truncated) {
    lines.push('', '（结果已按上限截断；需要完整数据请用更精确的 where 或聚合查询）')
  }

  return lines.join('\n')
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
