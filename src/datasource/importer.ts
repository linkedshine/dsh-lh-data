/**
 * 远端表 → 本地数据集的导入。
 *
 * 落库完全复用文件导入的那一套（`createDatasetTable` / `insertRows` / `DatasetStore`），
 * 因此导进来的数据集与 Excel 导入的**结构完全一致**，八个 `dataset_*` 工具零改动可用。
 * 远端表名只出现在发往远端的 SQL 里，本地表名仍走 `generateTableName` 白名单。
 */

import { shortHash, type Database } from '../db'
import { fillSamples, buildColumns, mapRowKeys } from './columns'
import { connectSource } from './connection'
import type { DatabaseConnector } from './connector/base'
import { DataSourceError } from './errors'
import type { ColumnInfo } from '../parse'
import {
  assertPhysicalTableName,
  generateTableName,
  makeDatasetId,
  type DataServices,
  type DatasetRecord,
} from '../store'
import { countRows, createDatasetTable, dropDatasetTable, insertRows } from '../table'
import { PLUGIN_NAME, type ToolExec } from '../tooling'
import type { DataSourceRecord } from './types'

export const REMOTE_IMPORT_JOB_KIND = 'datasource-import'

/** 采样式预览：只为了给设置页与 `dataset_schema` 填样例值。 */
const SAMPLE_ROWS = 5

export interface RemoteImportParams {
  scopeKey: string
  source: DataSourceRecord
  tableName: string
  schemaName?: string | null
  /** 数据集登记名；缺省取远端表名。 */
  name?: string | null
  /** 只导入前 N 行；配合 `datasourceMaxImportRows` 双重夹紧。 */
  limit?: number | null
}

export interface RemoteImportContext {
  signal: AbortSignal
  /** 有 agent 才能回注后台任务的完成通知；设置页导入时传 undefined。 */
  exec?: ToolExec
  background?: boolean
}

export interface RemoteImportResult {
  datasetId: string
  name: string
  rowCount: number
  columnCount: number
  columns: ColumnInfo[]
  status: 'ready' | 'running'
  jobId?: string
}

interface PreparedImport {
  scopeKey: string
  record: DatasetRecord
  db: Database
  columns: ColumnInfo[]
  connector: DatabaseConnector
  remoteTable: string
  remoteSchema: string | null
  /** 0 表示不限。 */
  maxRows: number
  estimate: number
}

function resolveMaxRows(services: DataServices, limit?: number | null): number {
  const ceiling = services.cfg.datasourceMaxImportRows
  const requested = limit !== undefined && limit !== null && limit > 0 ? Math.trunc(limit) : 0
  if (requested === 0) return ceiling > 0 ? ceiling : 0
  return ceiling > 0 ? Math.min(requested, ceiling) : requested
}

/** 远端的脱敏定位串：`<schema>.<table>`（MySQL 无 schema 时为 `<table>`）。 */
function sourceRefOf(params: RemoteImportParams): string {
  const schema = params.schemaName?.trim() ?? ''
  return schema.length > 0 ? `${schema}.${params.tableName}` : params.tableName
}

async function prepareImport(services: DataServices, params: RemoteImportParams): Promise<PreparedImport> {
  const connector = await connectSource(services.cfg, params.source)
  const schema = params.schemaName?.trim() || undefined
  const tables = await connector.getTables(schema)
  const remote = tables.find(table => table.tableName === params.tableName)
  if (remote === undefined) {
    throw new DataSourceError('NOT_FOUND', `数据源「${params.source.name}」里没有表 ${params.tableName}`)
  }
  if (remote.columns.length === 0) {
    throw new DataSourceError('BAD_REQUEST', `表 ${params.tableName} 没有可导入的列`)
  }

  const columns = buildColumns(remote.columns)
  const preview = await connector.getTableData(params.tableName, remote.schemaName ?? undefined, { limit: SAMPLE_ROWS })
  fillSamples(columns, preview)

  const base = params.name?.trim() || params.tableName
  const now = Date.now()
  const record: DatasetRecord = {
    id: makeDatasetId(),
    scopeKey: params.scopeKey,
    name: await services.store.uniqueName(params.scopeKey, base),
    tableName: generateTableName(base, shortHash(params.scopeKey)),
    sourcePath: `db:${params.source.name}`,
    sourceId: params.source.id,
    sourceRef: sourceRefOf(params),
    description: null,
    rowCount: 0,
    columns,
    status: 'importing',
    error: null,
    createdAt: now,
    updatedAt: now,
  }
  assertPhysicalTableName(record.tableName)
  await services.store.create(record)
  const db = await services.store.database(params.scopeKey)
  await createDatasetTable(db, record.tableName, columns)
  return {
    scopeKey: params.scopeKey,
    record,
    db,
    columns,
    connector,
    remoteTable: params.tableName,
    remoteSchema: remote.schemaName,
    maxRows: resolveMaxRows(services, params.limit),
    estimate: remote.rowCount,
  }
}

/** 分块拉取 → 键改写 → 批量插入，直到拉空或达到上限。 */
async function pullAndInsert(services: DataServices, prepared: PreparedImport, signal: AbortSignal): Promise<number> {
  const fetchSize = Math.max(1, services.cfg.datasourceFetchBatchSize)
  let inserted = 0
  let offset = 0
  for (;;) {
    signal.throwIfAborted()
    const remaining = prepared.maxRows > 0 ? prepared.maxRows - inserted : fetchSize
    const limit = Math.min(fetchSize, remaining > 0 ? remaining : 0)
    if (limit <= 0) break
    const rows = await prepared.connector.getTableData(prepared.remoteTable, prepared.remoteSchema ?? undefined, { limit, offset })
    if (rows.length === 0) break
    await insertRows(prepared.db, prepared.record.tableName, prepared.columns, mapRowKeys(rows, prepared.columns), {
      batchSize: services.cfg.batchSize,
      signal,
    })
    inserted += rows.length
    offset += rows.length
    if (rows.length < limit) break
  }
  return inserted
}

async function finalize(services: DataServices, prepared: PreparedImport, inserted: number): Promise<number> {
  const rowCount = await countRows(prepared.db, prepared.record.tableName)
  const total = Number.isFinite(rowCount) ? rowCount : inserted
  await services.store.update(prepared.scopeKey, prepared.record.id, { rowCount: total, status: 'ready' })
  return total
}

async function cleanupFailedImport(services: DataServices, prepared: PreparedImport, message: string): Promise<void> {
  try {
    await dropDatasetTable(prepared.db, prepared.record.tableName)
  } catch {
    // 清理失败不应掩盖原始错误。
  }
  try {
    await services.store.update(prepared.scopeKey, prepared.record.id, {
      status: 'failed',
      error: message.slice(0, 500),
      rowCount: 0,
    })
  } catch {
    // 同上。
  }
}

function startBackgroundImport(services: DataServices, exec: ToolExec, prepared: PreparedImport): string | undefined {
  const jobs = services.jobs
  if (jobs === undefined) return undefined
  const controller = new AbortController()
  const notify = (text: string): void => {
    try {
      exec.agent?.inject?.({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: PLUGIN_NAME } })
    } catch {
      // agent 已 dispose 时静默跳过。
    }
  }
  try {
    return jobs.start({
      kind: REMOTE_IMPORT_JOB_KIND,
      label: `导入远端表 ${prepared.remoteTable} → ${prepared.record.name}`,
      owner: exec.agent,
      run: () => {
        const done = (async (): Promise<{ status: string; detail: string; output: string }> => {
          try {
            const inserted = await pullAndInsert(services, prepared, controller.signal)
            const total = await finalize(services, prepared, inserted)
            const text = `远端表导入完成：${prepared.record.name}（${total} 行，datasetId: ${prepared.record.id}）`
            notify(text)
            return { status: 'completed', detail: `${total} rows`, output: text }
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            await cleanupFailedImport(services, prepared, message)
            const aborted = controller.signal.aborted
            const text = `远端表导入${aborted ? '已取消' : '失败'}：${prepared.record.name} — ${message}`
            notify(text)
            return { status: aborted ? 'killed' : 'failed', detail: message.slice(0, 500), output: text }
          }
        })()
        return { cancel: (reason?: string) => controller.abort(reason), done }
      },
    })
  } catch {
    return undefined
  }
}

export async function importRemoteTable(
  services: DataServices,
  params: RemoteImportParams,
  context: RemoteImportContext,
): Promise<RemoteImportResult> {
  const prepared = await prepareImport(services, params)
  try {
    const wantsBackground = context.background === true
      || (context.exec !== undefined && prepared.estimate >= services.cfg.backgroundThresholdRows)
    if (wantsBackground && context.exec !== undefined) {
      const jobId = startBackgroundImport(services, context.exec, prepared)
      if (jobId !== undefined) {
        return {
          datasetId: prepared.record.id,
          name: prepared.record.name,
          rowCount: 0,
          columnCount: prepared.columns.length,
          columns: prepared.columns,
          status: 'running',
          jobId,
        }
      }
    }
    const inserted = await pullAndInsert(services, prepared, context.signal)
    const total = await finalize(services, prepared, inserted)
    return {
      datasetId: prepared.record.id,
      name: prepared.record.name,
      rowCount: total,
      columnCount: prepared.columns.length,
      columns: prepared.columns,
      status: 'ready',
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    await cleanupFailedImport(services, prepared, message)
    throw error
  }
}
