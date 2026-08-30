/**
 * 模型可见片段的构造 —— 设计文档 §5.3。
 *
 * 这里只做两件事：把结果裁成「前几行 + 可选尾几行」的预览，以及基于**全量数据**
 * 生成类型化摘要（不是只看预览行）。摘要让模型在不读全表的情况下也能下结论，
 * 从而不再需要逐页翻数据。
 */

import type { Database, Row } from './db'
import type { ColumnType } from './parse'
import { quoteIdentifier } from './sql'

export type PreviewStrategy = 'head' | 'head-tail'

export interface PreviewOptions {
  previewRows: number
  previewStrategy: PreviewStrategy
  previewColumns: number
  summaryEnabled: boolean
  /** 参与摘要的列数上限（宽表保护）。 */
  summaryMaxColumns: number
  /** 文本列取 top 值的列数上限。 */
  summaryMaxTextColumns: number
}

/** 一列的统计摘要；字段按类型给出，缺失即不适用。 */
export interface ColumnSummary {
  name: string
  type: ColumnType
  /** 非空值个数。 */
  count: number
  min?: number | string | null
  max?: number | string | null
  avg?: number | null
  sum?: number | null
  /** distinct 取值数（文本列）。 */
  distinct?: number
  /** 高频取值（文本列，distinct 过多时省略）。 */
  top?: { value: string; count: number }[]
  /** 布尔列为真的行数。 */
  trueCount?: number
}

export interface PreviewSlice {
  rows: Row[]
  columns: string[]
  /** 是否折叠了列（结果列数超过 previewColumns）。 */
  columnTruncated: boolean
  /** 头尾之间是否跳过了行。 */
  gap: boolean
  /** 被跳过的行数。 */
  skipped: number
}

/** 头/尾各取多少行；`tail > 0` 时渲染层会在中间插入省略提示。 */
export function previewSlicePlan(totalRows: number, options: PreviewOptions): { head: number; tail: number } {
  const limit = Math.max(1, Math.floor(options.previewRows))
  const rows = Math.max(0, Math.floor(totalRows))
  if (rows <= limit || options.previewStrategy !== 'head-tail') {
    return { head: Math.min(limit, rows), tail: 0 }
  }
  const tail = Math.ceil(limit / 2)
  const head = Math.max(1, limit - tail)
  return { head, tail }
}

/** 裁剪预览列（超宽表只保留前 N 列）。 */
export function previewColumns(columns: string[], options: PreviewOptions): { columns: string[]; truncated: boolean } {
  const limit = Math.max(1, Math.floor(options.previewColumns))
  if (columns.length <= limit) return { columns, truncated: false }
  return { columns: columns.slice(0, limit), truncated: true }
}

/** 拼装一次预览切片（头行 + 可选尾行），同时报告跳过了多少行。 */
export function buildPreviewSlice(
  headRows: Row[],
  tailRows: Row[],
  columns: string[],
  totalRows: number,
  options: PreviewOptions,
): PreviewSlice {
  const { head, tail } = previewSlicePlan(totalRows, options)
  const rows = tail > 0 ? [...headRows, ...tailRows] : headRows
  const skipped = Math.max(0, Math.floor(totalRows) - rows.length)
  const projected = previewColumns(columns, options)
  const sliced = projected.columns.length === columns.length
    ? rows
    : rows.map(row => {
      const picked: Row = {}
      for (const name of projected.columns) picked[name] = row[name]
      return picked
    })
  return {
    rows: sliced,
    columns: projected.columns,
    columnTruncated: projected.truncated,
    gap: tail > 0 && skipped > 0,
    skipped,
  }
}

/** 单元格按字符数截断，返回文本与被截断标记。 */
export function truncateCell(value: unknown, max: number): { text: string; truncated: boolean } {
  if (value === null || value === undefined) return { text: '', truncated: false }
  if (value instanceof Uint8Array) return { text: `<${value.length} bytes>`, truncated: false }
  const raw = typeof value === 'object'
    ? safeStringify(value)
    : String(value)
  const flat = raw.replace(/\r?\n/g, ' ')
  if (flat.length <= max) return { text: flat, truncated: false }
  return { text: `${flat.slice(0, Math.max(0, max - 1))}…`, truncated: true }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return '[object]'
  }
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * 基于全表生成列摘要：numeric/date/boolean 走一次聚合扫描，
 * 文本列额外做 distinct 计数与 top 取值（受列数上限保护）。
 */
export async function summarizeColumns(
  db: Database,
  tableName: string,
  columns: { name: string; type: ColumnType }[],
  options: PreviewOptions,
): Promise<ColumnSummary[]> {
  if (!options.summaryEnabled || columns.length === 0) return []
  const targets = columns.slice(0, Math.max(1, Math.floor(options.summaryMaxColumns)))
  const table = quoteIdentifier(tableName)

  const projections: string[] = ['COUNT(*) AS _rows']
  targets.forEach((column, index) => {
    const col = quoteIdentifier(column.name)
    const base = `c${index}`
    if (column.type === 'boolean') {
      projections.push(`COUNT(${col}) AS cnt_${base}`)
      projections.push(`SUM(CASE WHEN ${col} = 1 THEN 1 ELSE 0 END) AS true_${base}`)
      return
    }
    projections.push(`COUNT(${col}) AS cnt_${base}`)
    projections.push(`MIN(${col}) AS min_${base}`)
    projections.push(`MAX(${col}) AS max_${base}`)
    if (column.type === 'numeric') {
      projections.push(`AVG(${col}) AS avg_${base}`)
      projections.push(`SUM(${col}) AS sum_${base}`)
    }
  })

  const aggregate = await db.prepare(`SELECT ${projections.join(', ')} FROM ${table}`).get()
  const totalRows = toNumber(aggregate?._rows) ?? 0

  const summaries: ColumnSummary[] = targets.map((column, index) => {
    const base = `c${index}`
    const count = toNumber(aggregate?.[`cnt_${base}`]) ?? 0
    const summary: ColumnSummary = { name: column.name, type: column.type, count }
    if (column.type === 'boolean') {
      summary.trueCount = toNumber(aggregate?.[`true_${base}`]) ?? 0
      return summary
    }
    const min = aggregate?.[`min_${base}`]
    const max = aggregate?.[`max_${base}`]
    if (min !== null && min !== undefined) summary.min = min as number | string
    if (max !== null && max !== undefined) summary.max = max as number | string
    if (column.type === 'numeric') {
      summary.avg = toNumber(aggregate?.[`avg_${base}`])
      summary.sum = toNumber(aggregate?.[`sum_${base}`])
    }
    return summary
  })

  // 文本列的取值分布：每列两次查询，受 summaryMaxTextColumns 限制。
  const textColumns = summaries.filter(summary => summary.type === 'text')
  for (const summary of textColumns.slice(0, Math.max(0, Math.floor(options.summaryMaxTextColumns)))) {
    const col = quoteIdentifier(summary.name)
    const distinctRow = await db.prepare(`SELECT COUNT(DISTINCT ${col}) AS d FROM ${table}`).get()
    const distinct = toNumber(distinctRow?.d) ?? 0
    summary.distinct = distinct
    // 高基数列（编码/姓名/备注）给 top 值没有信息量，还浪费上下文。
    if (distinct === 0 || distinct > Math.max(20, totalRows * 0.3)) continue
    const topRows = await db
      .prepare(`SELECT ${col} AS v, COUNT(*) AS n FROM ${table} WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY n DESC, v ASC LIMIT 5`)
      .all()
    summary.top = topRows.map(row => ({ value: String(row.v), count: toNumber(row.n) ?? 0 }))
  }

  return summaries
}
