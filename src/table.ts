/**
 * 物理表的建/插/删 —— 移植自 `agentic-data-mini` 的 `src/lib/utils/tableManager.ts`。
 *
 * 保留的关键行为：`_row_id` 自增主键 + 业务列 + `_uploaded_at`；批量插入 100 行/批，
 * 并按列类型做转换（boolean→0/1、numeric→Number、date→ISO、对象/数组→JSON）。
 * 插件侧新增：批次之间的 `signal.throwIfAborted()` 检查点。
 */

import type { Database, Row } from './db'
import type { ColumnInfo, ColumnType } from './parse'
import { quoteIdentifier } from './sql'

/** 系统列：插入/更新时必须剔除。 */
export const SYSTEM_COLUMNS = ['_row_id', '_uploaded_at'] as const

export const DEFAULT_BATCH_SIZE = 100

export function columnTypeToSqlite(type: ColumnType): string {
  switch (type) {
    case 'numeric': return 'REAL'
    case 'boolean': return 'INTEGER'
    case 'date': return 'TEXT'
    default: return 'TEXT'
  }
}

export async function createDatasetTable(db: Database, tableName: string, columns: ColumnInfo[]): Promise<void> {
  const definitions = columns.map(column => `  ${quoteIdentifier(column.sanitizedName)} ${columnTypeToSqlite(column.type)}`)
  const sql = [
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (`,
    '  _row_id INTEGER PRIMARY KEY AUTOINCREMENT,',
    definitions.join(',\n'),
    "  _uploaded_at INTEGER DEFAULT (strftime('%s', 'now'))",
    ')',
  ].join('\n')
  await db.prepare(sql).run()
}

/** 按列类型转换一个值（批量插入与单行更新共用）。 */
export function coerceValue(raw: unknown, type: ColumnType): unknown {
  if (raw === null || raw === undefined || raw === '') return null
  switch (type) {
    case 'boolean':
      return raw === true || raw === 'true' || raw === '1' || raw === 1 || raw === 't' || raw === 'yes' ? 1 : 0
    case 'numeric': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      return Number.isFinite(n) ? n : null
    }
    case 'date': {
      if (raw instanceof Date) return raw.toISOString()
      if (typeof raw === 'string') {
        const parsed = new Date(raw)
        return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString()
      }
      return String(raw)
    }
    default: {
      if (raw instanceof Date) return raw.toISOString()
      if (typeof raw === 'boolean') return raw ? 1 : 0
      if (typeof raw === 'object') return Buffer.isBuffer(raw) ? raw : JSON.stringify(raw)
      return String(raw)
    }
  }
}

export interface InsertOptions {
  batchSize?: number
  signal?: AbortSignal
}

/** 批量插入，返回实际插入行数；每批之间检查取消信号。 */
export async function insertRows(
  db: Database,
  tableName: string,
  columns: ColumnInfo[],
  rows: Record<string, unknown>[],
  options: InsertOptions = {},
): Promise<number> {
  if (rows.length === 0) return 0
  if (columns.length === 0) throw new Error('没有可插入的列')
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE))
  const names = columns.map(column => quoteIdentifier(column.sanitizedName)).join(', ')
  let inserted = 0
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    options.signal?.throwIfAborted()
    const batch = rows.slice(offset, offset + batchSize)
    const placeholders: string[] = []
    const values: unknown[] = []
    for (const row of batch) {
      placeholders.push(`(${columns.map(() => '?').join(', ')})`)
      for (const column of columns) values.push(coerceValue(row[column.sanitizedName], column.type))
    }
    await db.prepare(`INSERT INTO ${quoteIdentifier(tableName)} (${names}) VALUES ${placeholders.join(', ')}`).run(...values)
    inserted += batch.length
  }
  return inserted
}

export async function dropDatasetTable(db: Database, tableName: string): Promise<void> {
  await db.prepare(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`).run()
}

export async function countRows(db: Database, tableName: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get()
  return Number(row?.count ?? 0)
}

/** 剔除系统列，并报告未登记的列（写操作要明确拒绝未知列）。 */
export function sanitizeRowData(
  data: Record<string, unknown>,
  columns: ColumnInfo[],
): { values: Record<string, unknown>; unknownColumns: string[] } {
  const known = new Set(columns.map(column => column.sanitizedName))
  const values: Record<string, unknown> = {}
  const unknownColumns: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if ((SYSTEM_COLUMNS as readonly string[]).includes(key)) continue
    if (!known.has(key)) {
      unknownColumns.push(key)
      continue
    }
    values[key] = value
  }
  return { values, unknownColumns }
}

/** 单行更新：按 `_row_id` 定位，返回受影响行数。 */
export async function updateRow(
  db: Database,
  tableName: string,
  columns: ColumnInfo[],
  rowId: number,
  data: Record<string, unknown>,
): Promise<number> {
  const { values, unknownColumns } = sanitizeRowData(data, columns)
  if (unknownColumns.length > 0) throw new Error(`未知列：${unknownColumns.join(', ')}`)
  const keys = Object.keys(values)
  if (keys.length === 0) throw new Error('没有需要更新的列')
  const byName = new Map(columns.map(column => [column.sanitizedName, column]))
  const assignments = keys.map(key => `${quoteIdentifier(key)} = ?`)
  const params = keys.map(key => coerceValue(values[key], byName.get(key)!.type))
  const result = await db
    .prepare(`UPDATE ${quoteIdentifier(tableName)} SET ${assignments.join(', ')} WHERE _row_id = ?`)
    .run(...params, rowId)
  return result.changes
}

/** 单行删除：按 `_row_id` 定位，返回受影响行数。 */
export async function deleteRow(db: Database, tableName: string, rowId: number): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM ${quoteIdentifier(tableName)} WHERE _row_id = ?`)
    .run(rowId)
  return result.changes
}

/** 读取查询结果（列信息从首行推导）。 */
export async function selectRows(db: Database, sql: string, params: unknown[] = []): Promise<{ rows: Row[]; columns: string[] }> {
  const rows = await db.prepare(sql).all(...params)
  return { rows, columns: rows.length > 0 ? Object.keys(rows[0]!) : [] }
}
