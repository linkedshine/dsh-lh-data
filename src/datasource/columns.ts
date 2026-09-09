/**
 * 远端列 → 本地 `ColumnInfo` 的映射，以及行键改写。
 *
 * 与文件导入的区别：远端已有权威类型声明，所以**不做采样推断**（`parse.ts` 的
 * `inferColumnType` 只在解析 Excel/CSV 时用），直接采用连接器映射出的类型。
 */

import { deduplicateColumnNames, sanitizeColumnName, type ColumnInfo } from '../parse'
import type { RemoteColumn } from './types'

/** 设置页展示用的样例值个数。 */
const MAX_SAMPLE_VALUES = 5

export function buildColumns(remote: readonly RemoteColumn[]): ColumnInfo[] {
  const columns: ColumnInfo[] = remote.map(column => {
    const info: ColumnInfo = {
      name: column.name,
      sanitizedName: sanitizeColumnName(column.name),
      type: column.nativeType,
      nullable: column.nullable,
      sample: [],
    }
    if (column.comment !== null && column.comment.length > 0) info.description = column.comment
    return info
  })
  deduplicateColumnNames(columns)
  return columns
}

/** `insertRows` 按 `sanitizedName` 取值，远端行的原始列键必须改写一次。 */
export function mapRowKeys(
  rows: readonly Record<string, unknown>[],
  columns: readonly ColumnInfo[],
): Record<string, unknown>[] {
  return rows.map(row => {
    const mapped: Record<string, unknown> = {}
    for (const column of columns) {
      mapped[column.sanitizedName] = row[column.name] ?? null
    }
    return mapped
  })
}

/** 从首批行里取几个非空值填进 `sample`（原地修改）。 */
export function fillSamples(columns: readonly ColumnInfo[], rows: readonly Record<string, unknown>[]): void {
  for (const column of columns) {
    const sample: unknown[] = []
    for (const row of rows) {
      const value = row[column.name]
      if (value === null || value === undefined) continue
      sample.push(value)
      if (sample.length >= MAX_SAMPLE_VALUES) break
    }
    if (sample.length > 0) column.sample = sample
  }
}
