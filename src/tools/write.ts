/**
 * 写工具：`dataset_insert` / `dataset_update` / `dataset_delete` / `dataset_drop`。
 *
 * 四个工具都是破坏性的，默认由 `src/index.ts` 的 `tools/pre-execute` 监听器返回
 * `{ kind: 'ask' }` 交给 `ctx.approval` 人工确认（无审批通道即拒绝，fail-closed）。
 * 这里再兜一层 `readOnly` 检查，避免门禁被绕过时的静默写入。
 */

import { resolveDataset, type DataServices } from '../store'
import { countRows, deleteRow, dropDatasetTable, insertRows, sanitizeRowData, updateRow } from '../table'
import { toolDef, ToolError, type ToolDefinition, type ToolExec } from '../tooling'

const DATASET_PARAM = {
  type: 'string',
  required: true,
  description: '数据集的 datasetId 或登记名（来自 dataset_list）。不要传物理表名。',
} as const

export interface InsertOutput {
  datasetId: string
  name: string
  inserted: number
  rowCount: number
}

export interface UpdateOutput {
  datasetId: string
  rowId: number
  updated: boolean
  changedColumns: string[]
  rowCount: number
}

export interface DeleteOutput {
  datasetId: string
  rowId: number
  deleted: boolean
  rowCount: number
}

export interface DropOutput {
  datasetId: string
  name: string
  dropped: boolean
}

/** 门禁之外再兜一层：只读模式下任何写操作都必须是错误。 */
function assertWritable(services: DataServices): void {
  if (services.cfg.readOnly) {
    throw new ToolError('dsh-lh-data 处于只读模式（readOnly=true），已拒绝写操作', 'READ_ONLY')
  }
}

export function createInsertTool(services: DataServices): ToolDefinition {
  return toolDef({
    name: 'dataset_insert',
    description: [
      '向数据集批量追加行。rows 是对象数组，键必须与 dataset_schema 列出的列名一致（未知列会被拒绝，_row_id / _uploaded_at 由系统维护，不要传）。',
      '写入前建议先 dataset_schema 确认列名与类型；值会按列类型自动转换（布尔→0/1、数值→数字、日期→ISO 字符串、对象→JSON）。',
      '这是写操作，会触发人工确认。',
    ].join(' '),
    parameters: {
      dataset: DATASET_PARAM,
      rows: {
        type: 'array',
        required: true,
        items: { type: 'object', additionalProperties: true },
        description: '要插入的行；键为列名，值为单元格内容。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          datasetId: { type: 'string' },
          name: { type: 'string' },
          inserted: { type: 'integer' },
          rowCount: { type: 'integer' },
        },
      },
      render: (_args, value: InsertOutput) => [
        { type: 'text', text: `已向 ${value.name}（${value.datasetId}）插入 ${value.inserted} 行，当前共 ${value.rowCount} 行。` },
      ],
    },
    presentCall: args => ({ card: 'generic', title: `插入 ${args.rows.length} 行`, kind: 'write' }),
    execute: async (args, exec: ToolExec): Promise<InsertOutput> => {
      assertWritable(services)
      if (args.rows.length === 0) throw new ToolError('rows 不能为空', 'EMPTY_ROWS')
      if (args.rows.length > services.cfg.maxInsertRows) {
        throw new ToolError(`单次最多插入 ${services.cfg.maxInsertRows} 行，本次 ${args.rows.length} 行`, 'TOO_MANY_ROWS')
      }
      const { scope, record, db } = await resolveDataset(services, exec, args.dataset, { requireReady: true })

      const rows: Record<string, unknown>[] = []
      const unknown = new Set<string>()
      for (const row of args.rows) {
        const { values, unknownColumns } = sanitizeRowData(row, record.columns)
        for (const column of unknownColumns) unknown.add(column)
        rows.push(values)
      }
      if (unknown.size > 0) {
        throw new ToolError(`未知列：${[...unknown].join(', ')}（用 dataset_schema 查看可用列名）`, 'UNKNOWN_COLUMN')
      }

      const inserted = await insertRows(db, record.tableName, record.columns, rows, {
        batchSize: services.cfg.batchSize,
        signal: exec.signal,
      })
      const rowCount = await countRows(db, record.tableName)
      await services.store.update(scope.scopeKey, record.id, { rowCount })
      return { datasetId: record.id, name: record.name, inserted, rowCount }
    },
  })
}

export function createUpdateTool(services: DataServices): ToolDefinition {
  return toolDef({
    name: 'dataset_update',
    description: [
      '按系统列 _row_id 更新单行（_row_id 来自 dataset_query 的结果）。data 是要修改的列及其新值，键必须是 dataset_schema 中已存在的列名。',
      '只更新这一行；批量修改请逐行调用。这是写操作，会触发人工确认。',
    ].join(' '),
    parameters: {
      dataset: DATASET_PARAM,
      rowId: { type: 'integer', required: true, description: '要更新的行的 _row_id（来自 dataset_query）。' },
      data: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description: '要写入的列值对象，如 { "单价": 12.5, "备注": "已核" }。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          datasetId: { type: 'string' },
          rowId: { type: 'integer' },
          updated: { type: 'boolean' },
          changedColumns: { type: 'array', items: { type: 'string' } },
          rowCount: { type: 'integer' },
        },
      },
      render: (_args, value: UpdateOutput) => [
        {
          type: 'text',
          text: `已更新 ${value.datasetId} 的第 ${value.rowId} 行（${value.changedColumns.join(', ')}）。数据集共 ${value.rowCount} 行。`,
        },
      ],
    },
    presentCall: args => ({ card: 'generic', title: `更新行 ${args.rowId}`, kind: 'write' }),
    execute: async (args, exec): Promise<UpdateOutput> => {
      assertWritable(services)
      const { record, db } = await resolveDataset(services, exec, args.dataset, { requireReady: true })
      const changes = await updateRow(db, record.tableName, record.columns, args.rowId, args.data)
      if (changes === 0) throw new ToolError(`未找到 _row_id = ${args.rowId} 的行`, 'ROW_NOT_FOUND')
      const rowCount = await countRows(db, record.tableName)
      await services.store.update(record.scopeKey, record.id, { rowCount })
      const changedColumns = Object.keys(args.data).filter(
        key => !(key === '_row_id' || key === '_uploaded_at') && record.columns.some(column => column.sanitizedName === key),
      )
      return { datasetId: record.id, rowId: args.rowId, updated: true, changedColumns, rowCount }
    },
  })
}

export function createDeleteTool(services: DataServices): ToolDefinition {
  return toolDef({
    name: 'dataset_delete',
    description: [
      '按系统列 _row_id 删除单行（_row_id 来自 dataset_query 的结果）。删除不可恢复。',
      '这是写操作，会触发人工确认；清空整个数据集请用 dataset_drop。',
    ].join(' '),
    parameters: {
      dataset: DATASET_PARAM,
      rowId: { type: 'integer', required: true, description: '要删除的行的 _row_id（来自 dataset_query）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          datasetId: { type: 'string' },
          rowId: { type: 'integer' },
          deleted: { type: 'boolean' },
          rowCount: { type: 'integer' },
        },
      },
      render: (_args, value: DeleteOutput) => [
        { type: 'text', text: `已删除 ${value.datasetId} 的第 ${value.rowId} 行，剩余 ${value.rowCount} 行。` },
      ],
    },
    presentCall: args => ({ card: 'generic', title: `删除行 ${args.rowId}`, kind: 'write' }),
    execute: async (args, exec): Promise<DeleteOutput> => {
      assertWritable(services)
      const { record, db } = await resolveDataset(services, exec, args.dataset, { requireReady: true })
      const changes = await deleteRow(db, record.tableName, args.rowId)
      if (changes === 0) throw new ToolError(`未找到 _row_id = ${args.rowId} 的行`, 'ROW_NOT_FOUND')
      const rowCount = await countRows(db, record.tableName)
      await services.store.update(record.scopeKey, record.id, { rowCount })
      return { datasetId: record.id, rowId: args.rowId, deleted: true, rowCount }
    },
  })
}

export function createDropTool(services: DataServices): ToolDefinition {
  return toolDef({
    name: 'dataset_drop',
    description: [
      '删除整个数据集：连同物理表与元数据一起删除，不可恢复。',
      '只影响当前工作区；删除前建议 dataset_list 确认目标，误删需重新导入源文件。这是写操作，会触发人工确认。',
    ].join(' '),
    parameters: {
      dataset: DATASET_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          datasetId: { type: 'string' },
          name: { type: 'string' },
          dropped: { type: 'boolean' },
        },
      },
      render: (_args, value: DropOutput) => [
        { type: 'text', text: `已删除数据集 ${value.name}（${value.datasetId}）。` },
      ],
    },
    presentCall: args => ({ card: 'generic', title: `删除数据集：${args.dataset}`, kind: 'write' }),
    execute: async (args, exec): Promise<DropOutput> => {
      assertWritable(services)
      const { scope, record, db } = await resolveDataset(services, exec, args.dataset)
      await dropDatasetTable(db, record.tableName)
      await services.store.remove(scope.scopeKey, record.id)
      return { datasetId: record.id, name: record.name, dropped: true }
    },
  })
}
