/**
 * 文件解析与类型推断 —— 移植自 `agentic-data-mini` 的 `src/lib/utils/fileParser.ts`。
 *
 * 保留的关键行为（设计文档 §4）：
 * - XLSX：`XLSX.read({ type: 'buffer', cellDates: true })` + `sheet_to_json({ raw: true, defval: null })`，
 *   Date → `YYYY-MM-DD`；默认第一个 sheet。
 * - CSV：`Papa.parse({ header: true, skipEmptyLines: true, dynamicTyping: true, transformHeader: trim })`。
 * - 列名：**保留原名（含中文）**，SQL 中双引号包裹；空列名 → `column`；重名追加 `_2`。
 * - 类型推断：编码/号码类列名强制 text；13+ 位整数或 `xE+12` 科学计数法强制 text（防精度丢失）；
 *   其余 numeric>80% / boolean>90% / date 正则>70%。
 */

import Papa from 'papaparse'
import * as XLSX from 'xlsx'

export type ColumnType = 'text' | 'numeric' | 'boolean' | 'date'

export interface ColumnInfo {
  /** 原始表头（如「物料编码」）。 */
  name: string
  /** SQL 中使用的列名（与 name 相同，或去重后加 `_2`）。 */
  sanitizedName: string
  type: ColumnType
  nullable: boolean
  sample: unknown[]
  description?: string
}

export interface ParsedFile {
  headers: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  columns: ColumnInfo[]
}

export const DEFAULT_SAMPLE_ROWS = 100

/** 列名消毒：trim，空列名回落 `column`，其余保留原名。 */
export function sanitizeColumnName(name: string): string {
  const trimmed = name.trim()
  return trimmed.length === 0 ? 'column' : trimmed
}

/** 重名列追加 `_2` / `_3`（原地修改）。 */
export function deduplicateColumnNames(columns: ColumnInfo[]): void {
  const nameCounts = new Map<string, number>()
  for (const column of columns) {
    nameCounts.set(column.sanitizedName, (nameCounts.get(column.sanitizedName) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  for (const column of columns) {
    const name = column.sanitizedName
    if ((nameCounts.get(name) ?? 0) > 1) {
      const index = (seen.get(name) ?? 0) + 1
      seen.set(name, index)
      column.sanitizedName = `${name}_${index}`
    }
  }
}

function generateColumnDescription(name: string, type: ColumnType, sample: unknown[]): string {
  const typeDesc: Record<ColumnType, string> = {
    text: '文本字段',
    numeric: '数值字段',
    boolean: '布尔字段',
    date: '日期字段',
  }
  let description: string = typeDesc[type] ?? '字段'
  const first = sample[0]
  if (first !== null && first !== undefined) {
    description += `，示例: "${String(first).slice(0, 30)}"`
  }
  void name
  return description
}

const CHINESE_CODE_PATTERNS = ['编码', '编号', '代码', '代号', '账号', '证件号', '邮编', '区号']
const ENGLISH_CODE_PATTERNS = ['code', 'sku', 'ean', 'upc', 'isbn', 'issn', 'postal', 'zip']

/** 编码/号码类列：即使值是数字也应存 text（无数学含义）。 */
export function isCodeOrIdField(columnName: string): boolean {
  const name = columnName.toLowerCase().trim()
  for (const pattern of CHINESE_CODE_PATTERNS) {
    if (name.includes(pattern)) return true
  }
  for (const pattern of ENGLISH_CODE_PATTERNS) {
    if (new RegExp(`(^|_)${pattern}(_|$)`, 'i').test(name) || name === pattern) return true
  }
  if (name.includes('phone') || name.includes('tel') || name.includes('mobile')
    || name.includes('电话') || name.includes('手机')) {
    return true
  }
  return false
}

/** 大数判定：13+ 位整数或 `1.78E+12` 这类科学计数法。 */
export function isLargeNumber(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1e12) return true
  const text = String(value)
  if (/^\d{13,}$/.test(text)) return true
  const sci = text.match(/^(\d+\.?\d*)E\+(\d+)$/i)
  if (sci !== null && Number.parseInt(sci[2]!, 10) >= 12) return true
  return false
}

/** 把行内的 Date 对象格式化为 `YYYY-MM-DD`。 */
function formatDateValues(rows: Record<string, unknown>[]): void {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (row[key] instanceof Date) {
        row[key] = (row[key] as Date).toISOString().slice(0, 10)
      }
    }
  }
}

/** 从采样值 + 列名推断列类型；列名优先级最高。 */
export function inferColumnType(values: unknown[], columnName?: string): ColumnType {
  if (columnName !== undefined && isCodeOrIdField(columnName)) return 'text'
  const nonNull = values.filter(value => value !== null && value !== undefined && value !== '')
  if (nonNull.length === 0) return 'text'
  if (nonNull.some(value => isLargeNumber(value))) return 'text'

  const numericCount = nonNull.filter((value) => {
    const n = Number(value)
    return !Number.isNaN(n) && value !== '' && value !== true && value !== false
  }).length
  if (numericCount / nonNull.length > 0.8) return 'numeric'

  const boolCount = nonNull.filter(
    value => value === true || value === false || value === 'true' || value === 'false' || value === '1' || value === '0',
  ).length
  if (boolCount / nonNull.length > 0.9) return 'boolean'

  const datePattern = /^\d{4}[-/]\d{2}[-/]\d{2}|^\d{2}[-/]\d{2}[-/]\d{4}/
  const dateCount = nonNull.filter(value => typeof value === 'string' && datePattern.test(value)).length
  if (dateCount / nonNull.length > 0.7) return 'date'

  return 'text'
}

function buildColumns(
  headers: string[],
  rows: Record<string, unknown>[],
  sampleRows: number,
): ColumnInfo[] {
  const columns: ColumnInfo[] = headers.map((header) => {
    const sample = rows.map(row => row[header]).slice(0, sampleRows)
    const type = inferColumnType(sample, header)
    const allValues = rows.map(row => row[header])
    const nullCount = allValues.filter(value => value === null || value === undefined || value === '').length
    const sanitizedName = sanitizeColumnName(header)
    return {
      name: header,
      sanitizedName,
      type,
      // 有空值或采样不足都按可空处理。
      nullable: nullCount > 0 || allValues.length < rows.length,
      sample: sample.slice(0, 5),
      description: generateColumnDescription(header, type, sample.slice(0, 5)),
    }
  })
  deduplicateColumnNames(columns)
  return columns
}

/** 用去重后的列名重写行键。 */
function renameRows(headers: string[], rows: Record<string, unknown>[], columns: ColumnInfo[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const next: Record<string, unknown> = {}
    headers.forEach((header, index) => {
      next[columns[index]!.sanitizedName] = row[header]
    })
    return next
  })
}

export function parseCSV(buffer: Buffer, sampleRows: number = DEFAULT_SAMPLE_ROWS): ParsedFile {
  const content = buffer.toString('utf-8')
  const result = Papa.parse<Record<string, unknown>>(content, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
    transformHeader: header => header.trim(),
  })
  if (result.errors.length > 0 && result.data.length === 0) {
    throw new Error(`CSV parse error: ${result.errors[0]?.message ?? 'unknown'}`)
  }
  const headers = result.meta.fields ?? []
  const rows = result.data
  if (headers.length === 0) return { headers, rows: [], rowCount: 0, columns: [] }
  const columns = buildColumns(headers, rows, sampleRows)
  return { headers, rows: renameRows(headers, rows, columns), rowCount: rows.length, columns }
}

export function parseXLSX(buffer: Buffer, sheetName?: string, sampleRows: number = DEFAULT_SAMPLE_ROWS): ParsedFile {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const selected = sheetName === undefined || sheetName.trim().length === 0
    ? workbook.SheetNames[0]
    : workbook.SheetNames.find(name => name === sheetName || name.toLowerCase() === sheetName.trim().toLowerCase())
  if (selected === undefined) {
    throw new Error(`工作表不存在：${sheetName}（可用：${workbook.SheetNames.join(', ') || '(空)'}）`)
  }
  const worksheet = workbook.Sheets[selected]
  if (worksheet === undefined) throw new Error(`工作表不可读取：${selected}`)
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { raw: true, defval: null })
  formatDateValues(rows)
  if (rows.length === 0) return { headers: [], rows: [], rowCount: 0, columns: [] }
  const headers = Object.keys(rows[0] as Record<string, unknown>)
  const columns = buildColumns(headers, rows, sampleRows)
  return { headers, rows: renameRows(headers, rows, columns), rowCount: rows.length, columns }
}
