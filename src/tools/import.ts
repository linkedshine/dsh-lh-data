/**
 * `dataset_import`：解析工作区 Excel/CSV → 建表 → 批量插入 → 登记元数据。
 *
 * 大文件（≥ `backgroundThresholdRows`，或显式 `background: true`）走后台分支：
 * 立即返回 `{ status: 'running', jobId }`，插入在 `ctx.jobs` 任务里跑完后回注通知
 * （设计文档 §5.2）。任何失败都会删掉半截的物理表并把元数据标记为 `failed`。
 */

import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { shortHash } from '../db'
import { parseCSV, parseXLSX, type ColumnInfo, type ParsedFile } from '../parse'
import { renderColumns } from '../render'
import { assertReadableFile, resolveInputFile, type ScopeContext } from '../scope'
import {
  assertPhysicalTableName,
  generateTableName,
  makeDatasetId,
  type DataServices,
  type DatasetRecord,
} from '../store'
import { countRows, createDatasetTable, dropDatasetTable, insertRows } from '../table'
import { ToolError, toolDef, PLUGIN_NAME, type ToolDefinition, type ToolExec } from '../tooling'

export const IMPORT_JOB_KIND = 'dataset-import'

export interface ImportOutput {
  datasetId: string
  name: string
  rowCount: number
  columnCount: number
  status: string
  jobId?: string
  columns: ColumnInfo[]
}

/** 后台任务的终态（对应 dsh-jobs 的 `JobOutcome`）。 */
interface JobOutcome {
  status: 'completed' | 'killed' | 'failed'
  detail?: string
  output?: string
}

function parseFile(path: string, buffer: Buffer, sheet: string | undefined, sampleRows: number): ParsedFile {
  return extname(path).toLowerCase() === '.csv'
    ? parseCSV(buffer, sampleRows)
    : parseXLSX(buffer, sheet, sampleRows)
}

/** 失败清理：删掉半截物理表 + 元数据标记 failed（后续工具会拒绝非 ready 的数据集）。 */
async function cleanupFailedImport(
  services: DataServices,
  scope: ScopeContext,
  record: DatasetRecord,
  message: string,
): Promise<void> {
  try {
    const db = await services.store.database(scope.scopeKey)
    await dropDatasetTable(db, record.tableName)
  } catch {
    // 清理失败不应掩盖原始错误。
  }
  try {
    await services.store.update(scope.scopeKey, record.id, {
      status: 'failed',
      error: message.slice(0, 500),
      rowCount: 0,
    })
  } catch {
    // 同上。
  }
}

/** 后台导入：注册任务并返回 jobId；不可用时返回 undefined（降级为前台）。 */
function startBackgroundImport(
  services: DataServices,
  exec: ToolExec,
  scope: ScopeContext,
  record: DatasetRecord,
  columns: ColumnInfo[],
  rows: Record<string, unknown>[],
): string | undefined {
  const jobs = services.jobs
  if (jobs === undefined) return undefined

  const controller = new AbortController()
  const notify = (text: string): void => {
    try {
      exec.agent?.inject?.({
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: PLUGIN_NAME },
      })
    } catch {
      // agent 已 dispose（会话结束）时静默跳过，不能让通知失败影响任务本身。
    }
  }

  try {
    return jobs.start({
      kind: IMPORT_JOB_KIND,
      label: `导入 ${record.name}（${rows.length} 行）`,
      owner: exec.agent,
      run: () => {
        // 任务自有的取消信号：外层调用被取消不会终止已发布的工作。
        const done = (async (): Promise<JobOutcome> => {
          try {
            const db = await services.store.database(scope.scopeKey)
            const inserted = await insertRows(db, record.tableName, columns, rows, {
              batchSize: services.cfg.batchSize,
              signal: controller.signal,
            })
            await services.store.update(scope.scopeKey, record.id, { rowCount: inserted, status: 'ready' })
            const text = `数据集导入完成：${record.name}（${inserted} 行，datasetId: ${record.id}）`
            notify(text)
            return { status: 'completed', detail: `${inserted} rows`, output: text }
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            await cleanupFailedImport(services, scope, record, message)
            const aborted = controller.signal.aborted
            const text = `数据集导入${aborted ? '已取消' : '失败'}：${record.name} — ${message}`
            notify(text)
            return { status: aborted ? 'killed' : 'failed', detail: message.slice(0, 500), output: text }
          }
        })()
        return {
          cancel: (reason?: string) => controller.abort(reason),
          done,
        }
      },
    })
  } catch {
    // 任务注册表不可用/预检失败：降级为前台导入。
    return undefined
  }
}

export function createImportTool(services: DataServices): ToolDefinition {
  return toolDef({
    name: 'dataset_import',
    description: [
      '把工作区内的 Excel/CSV 导入本地表格库：解析文件、建表、批量插入并登记为数据集。',
      'path 相对路径以当前工作区目录为基准，且必须位于工作区内（禁止 ../ 穿越）；仅支持 .xlsx / .xls / .csv。',
      '可选：name 指定登记名（重复会自动加后缀）、sheet 指定工作表名（默认第一个）、limit 只导入前 N 行。',
      '大文件会自动转后台任务并立即返回 jobId，完成后回注通知；小文件同步完成并返回行数与列信息。',
      '这是写操作，会触发人工确认。导入后用 dataset_list / dataset_schema / dataset_query 查看。',
    ].join(' '),
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '工作区内的文件绝对路径，或相对当前工作区目录的相对路径。',
      },
      name: { type: 'string', description: '可选：数据集登记名；默认取文件名（不含扩展名）。' },
      sheet: { type: 'string', description: '可选：Excel 工作表名；默认第一个工作表。' },
      limit: { type: 'integer', description: '可选：只导入前 N 行。' },
      background: { type: 'boolean', description: '可选：true 强制后台导入；默认大文件自动转后台。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          datasetId: { type: 'string' },
          name: { type: 'string' },
          rowCount: { type: 'integer' },
          columnCount: { type: 'integer' },
          status: { type: 'string', description: 'ready / running' },
          jobId: { type: 'string' },
          columns: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                sanitizedName: { type: 'string' },
                type: { type: 'string' },
                nullable: { type: 'boolean' },
                description: { type: 'string' },
                sample: { type: 'array', items: { type: 'json' } },
              },
            },
          },
        },
      },
      render: (_args, value: ImportOutput) => {
        const head = value.status === 'running'
          ? `已在后台开始导入 ${value.name}（datasetId: ${value.datasetId}，jobId: ${value.jobId ?? '-'}），完成后会回注通知。`
          : `已导入 ${value.name}（datasetId: ${value.datasetId}）：${value.rowCount} 行 / ${value.columnCount} 列。`
        return [
          {
            type: 'text',
            text: [head, '', renderColumns(value.columns)].join('\n'),
          },
        ]
      },
    },
    presentCall: args => ({
      card: 'generic',
      title: `导入 ${basename(args.path)}`,
      kind: 'write',
      locations: [{ path: args.path }],
    }),
    execute: async (args, exec: ToolExec): Promise<ImportOutput> => {
      if (services.cfg.readOnly) {
        throw new ToolError('dsh-lh-data 处于只读模式（readOnly=true），已拒绝导入', 'READ_ONLY')
      }
      const scope = await services.scopeOf(exec)
      const absolutePath = resolveInputFile(scope.cwd, args.path)
      await assertReadableFile(absolutePath, services.cfg.maxFileBytes)
      exec.signal.throwIfAborted()

      const buffer = await readFile(absolutePath)
      exec.signal.throwIfAborted()
      const parsed = parseFile(absolutePath, buffer, args.sheet, services.cfg.previewSampleRows)
      if (parsed.columns.length === 0) throw new ToolError('文件没有可识别的列（表头为空？）', 'EMPTY_COLUMNS')
      const rows = args.limit !== undefined && args.limit > 0 ? parsed.rows.slice(0, args.limit) : parsed.rows

      const base = (args.name?.trim().length ?? 0) > 0 ? args.name!.trim() : basename(absolutePath, extname(absolutePath))
      const name = await services.store.uniqueName(scope.scopeKey, base)
      const tableName = generateTableName(base, shortHash(scope.scopeKey))
      assertPhysicalTableName(tableName)

      const now = Date.now()
      const record: DatasetRecord = {
        id: makeDatasetId(),
        scopeKey: scope.scopeKey,
        name,
        tableName,
        sourcePath: absolutePath,
        rowCount: 0,
        columns: parsed.columns,
        status: 'importing',
        error: null,
        createdAt: now,
        updatedAt: now,
      }
      await services.store.create(record)
      const db = await services.store.database(scope.scopeKey)

      try {
        await createDatasetTable(db, tableName, parsed.columns)
        const wantsBackground = args.background === true || rows.length >= services.cfg.backgroundThresholdRows
        if (wantsBackground) {
          const jobId = startBackgroundImport(services, exec, scope, record, parsed.columns, rows)
          if (jobId !== undefined) {
            return {
              datasetId: record.id,
              name,
              rowCount: 0,
              columnCount: parsed.columns.length,
              status: 'running',
              jobId,
              columns: parsed.columns,
            }
          }
        }
        const inserted = await insertRows(db, tableName, parsed.columns, rows, {
          batchSize: services.cfg.batchSize,
          signal: exec.signal,
        })
        const rowCount = await countRows(db, tableName)
        await services.store.update(scope.scopeKey, record.id, { rowCount: inserted, status: 'ready' })
        return {
          datasetId: record.id,
          name,
          rowCount: Number.isFinite(rowCount) ? rowCount : inserted,
          columnCount: parsed.columns.length,
          status: 'ready',
          columns: parsed.columns,
        }
      } catch (error: unknown) {
        await cleanupFailedImport(services, scope, record, error instanceof Error ? error.message : String(error))
        throw error
      }
    },
  })
}
