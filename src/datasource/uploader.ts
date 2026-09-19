/**
 * 本地数据集 → 远端数据源的推送（即 `importRemoteTable` 的反向操作）。
 *
 * 复用 `connectSource` 取得已连通的连接器，按 schema 取现有表名做同名冲突检测；
 * 然后对每个数据集：建远端表（覆盖时先 DROP）→ 分块读取本地行 → 按方言占位符批量写入。
 * 只依赖 connection / store / table / parse / sql，不引入 admin.ts，避免循环依赖。
 */

import type { Database } from '../db'
import type { ColumnInfo, ColumnType } from '../parse'
import type { DatasetRecord, DataServices } from '../store'
import { ADMIN_ROW_ID_COLUMN } from '../admin-contract'
import { coerceValue, selectRows } from '../table'
import { quoteIdentifier } from '../sql'
import { connectSource } from './connection'
import type { DatabaseConnector } from './connector/base'
import type { DataSourceRecord } from './types'

export interface ExportItemRef {
  id: string
  scopeKey: string
  /** 远端表名；缺省时取数据集显示名。 */
  tableName?: string | null
}

export interface ExportToSourceParams {
  datasets: ExportItemRef[]
  schemaName?: string | null
  overwrite: boolean
}

export interface ExportDatasetOutcome {
  id: string
  name: string
  remoteTable: string
  rowCount: number
  columnCount: number
  status: 'ok' | 'failed'
  error?: string
}

export interface ExportToSourceOutcome {
  conflicts: string[]
  results: ExportDatasetOutcome[]
}

const PAGE_SIZE = 500

export async function exportDatasetsToSource(
  services: DataServices,
  source: DataSourceRecord,
  params: ExportToSourceParams,
): Promise<ExportToSourceOutcome> {
  const connector = await connectSource(services.cfg, source)
  const schema = params.schemaName?.trim() || undefined
  const existing = new Set((await connector.getTables(schema)).map(table => table.tableName))

  // 先定位全部记录并确认冲突集合；此时尚未写入任何数据。
  const records: (DatasetRecord | null)[] = []
  const targets: string[] = []
  for (const ref of params.datasets) {
    const record = await services.store.find(ref.scopeKey, ref.id)
    records.push(record ?? null)
    targets.push(ref.tableName?.trim() || record?.name || '')
  }
  const conflicts = collectConflicts(targets, existing)

  if (conflicts.length > 0 && !params.overwrite) {
    return { conflicts, results: [] }
  }

  const tasks: Promise<ExportDatasetOutcome>[] = []
  params.datasets.forEach((ref, index) => {
    const record = records[index]
    const target = targets[index]
    if (record == null) {
      tasks.push(Promise.resolve({
        id: ref.id, name: '', remoteTable: target, rowCount: 0, columnCount: 0,
        status: 'failed', error: '未找到数据集',
      }))
      return
    }
    tasks.push(exportOne(connector, services, record, schema, target, params.overwrite && existing.has(target)))
  })
  return { conflicts: [], results: await Promise.all(tasks) }
}

/**
 * 冲突集合：目标表名命中远端已有表，或批次内改名后撞车（无论是否确认覆盖都不允许）。
 * 返回展示用表名（脱敏，不回显 SQL / 物理库名）。
 */
function collectConflicts(targets: string[], existing: Set<string>): string[] {
  const conflicts: string[] = []
  const seen = new Map<string, number>()
  for (const target of targets) {
    if (target.length === 0) continue
    if (existing.has(target) && !conflicts.includes(target)) conflicts.push(target)
    const count = (seen.get(target) ?? 0) + 1
    seen.set(target, count)
    if (count > 1 && !conflicts.includes(target)) conflicts.push(target)
  }
  return conflicts
}

async function exportOne(
  connector: DatabaseConnector,
  services: DataServices,
  record: DatasetRecord,
  schema: string | undefined,
  targetTable: string,
  dropFirst: boolean,
): Promise<ExportDatasetOutcome> {
  const base: ExportDatasetOutcome = {
    id: record.id,
    name: record.name,
    remoteTable: targetTable,
    rowCount: 0,
    columnCount: record.columns.length,
    status: 'failed',
  }
  try {
    const tableRef = remoteRef(connector, targetTable, schema)
    if (dropFirst) await connector.run(`DROP TABLE IF EXISTS ${tableRef}`)
    await connector.run(buildCreateSql(connector, tableRef, record.columns))
    const db = await services.store.database(record.scopeKey)
    const inserted = await writeChunks(connector, db, tableRef, record.tableName, record.columns)
    return { ...base, rowCount: inserted, status: 'ok' }
  } catch (error: unknown) {
    return { ...base, error: messageOf(error) }
  }
}

function remoteRef(connector: DatabaseConnector, table: string, schema: string | undefined): string {
  const quoted = connector.quoteIdent(table)
  return schema !== undefined && schema.length > 0
    ? `${connector.quoteIdent(schema)}.${quoted}`
    : quoted
}

function buildCreateSql(connector: DatabaseConnector, tableRef: string, columns: ColumnInfo[]): string {
  const definitions = columns.map(column => {
    const nullability = column.nullable ? '' : ' NOT NULL'
    return `  ${connector.quoteIdent(column.sanitizedName)} ${connector.nativeType(column.type)}${nullability}`
  })
  return `CREATE TABLE ${tableRef} (\n${definitions.join(',\n')}\n)`
}

async function writeChunks(
  connector: DatabaseConnector,
  db: Database,
  tableRef: string,
  localTable: string,
  columns: ColumnInfo[],
): Promise<number> {
  if (columns.length === 0) return 0
  const projection = columns.map(column => quoteIdentifier(column.sanitizedName)).join(', ')
  const orderBy = quoteIdentifier(ADMIN_ROW_ID_COLUMN)
  let inserted = 0
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { rows } = await selectRows(
      db,
      `SELECT ${projection} FROM ${quoteIdentifier(localTable)} ORDER BY ${orderBy} ASC LIMIT ? OFFSET ?`,
      [PAGE_SIZE, offset],
    )
    if (rows.length === 0) break
    await insertChunk(connector, tableRef, columns, rows)
    inserted += rows.length
    if (rows.length < PAGE_SIZE) break
  }
  return inserted
}

async function insertChunk(
  connector: DatabaseConnector,
  tableRef: string,
  columns: ColumnInfo[],
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return
  const columnSql = columns.map(column => connector.quoteIdent(column.sanitizedName)).join(', ')
  let index = 0
  const values: unknown[] = []
  const rowPlaceholders: string[] = []
  for (const row of rows) {
    const cells: string[] = []
    for (const column of columns) {
      cells.push(connector.placeholder(index))
      index += 1
      values.push(toRemoteValue(row[column.sanitizedName], column.type))
    }
    rowPlaceholders.push(`(${cells.join(', ')})`)
  }
  const sql = `INSERT INTO ${tableRef} (${columnSql}) VALUES ${rowPlaceholders.join(', ')}`
  await connector.run(sql, values)
}

/** 本地 SQLite 把布尔存成 0/1，推到远端时还原成方言能识别的真布尔值。 */
function toRemoteValue(raw: unknown, type: ColumnType): unknown {
  if (type === 'boolean') return coerceValue(raw, 'boolean') === 1
  return coerceValue(raw, type)
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
  return message.slice(0, 300)
}
