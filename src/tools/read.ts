/**
 * 只读工具：`dataset_list` / `dataset_schema` / `dataset_query`。
 *
 * 三个工具都不修改数据，因此走 `allow`（不触发审批）；返回值只出现 datasetId 与登记名，
 * 物理表名留在 `store.ts` 内部（设计文档 §7.1）。
 */

import { renderColumns, renderDatasetList, renderRows } from '../render'
import type { ColumnInfo } from '../parse'
import type { Row } from '../db'
import { resolveDataset, type DataServices } from '../store'
import { selectRows } from '../table'
import { buildStructuredQuery, substituteDatasetAlias, validateReadOnlyQuery } from '../sql'
import { toolDef, ToolError, type ToolDefinition, type ToolExec } from '../tooling'

const DATASET_PARAM = {
  type: 'string',
  required: true,
  description: '数据集的 datasetId 或登记名（来自 dataset_list）。不要传物理表名。',
} as const

export interface DatasetSummary {
  datasetId: string
  name: string
  rowCount: number
  columnCount: number
  status: string
  sourcePath: string | null
  createdAt: number
  updatedAt: number
}

export interface ListOutput {
  count: number
  datasets: DatasetSummary[]
}

export interface SchemaOutput {
  datasetId: string
  name: string
  rowCount: number
  status: string
  columns: ColumnInfo[]
}

export interface QueryOutput {
  datasetId: string
  name: string
  columns: string[]
  rows: Row[]
  rowCount: number
  limit: number
  offset: number
  truncated: boolean
}

const DEFAULT_QUERY_LIMIT = 50

export function createListTool(services: DataServices): ToolDefinition {
  return toolDef({
    name: 'dataset_list',
    description: [
      '列出当前工作区（会话 cwd）已导入的数据集：datasetId、登记名、行数、列数、状态、来源文件、创建时间。',
      '只读工具，不会修改任何数据。后续所有 dataset_* 工具都用这里的 datasetId 或登记名指代数据集。',
      '数据集按工作区隔离：看不到其它工作区的数据集。',
    ].join(' '),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', description: '数据集数量' },
          datasets: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                datasetId: { type: 'string' },
                name: { type: 'string' },
                rowCount: { type: 'integer' },
                columnCount: { type: 'integer' },
                status: { type: 'string', description: 'importing / ready / failed' },
                sourcePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                createdAt: { type: 'integer' },
                updatedAt: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value: ListOutput) => [{ type: 'text', text: renderDatasetList(value.datasets) }],
    },
    presentCall: () => ({ card: 'generic', title: '列出数据集', kind: 'read' }),
    execute: async (_args, exec: ToolExec): Promise<ListOutput> => {
      exec.signal.throwIfAborted()
      const scope = await services.scopeOf(exec)
      const records = await services.store.list(scope.scopeKey)
      exec.signal.throwIfAborted()
      return {
        count: records.length,
        datasets: records.map(record => ({
          datasetId: record.id,
          name: record.name,
          rowCount: record.rowCount,
          columnCount: record.columns.length,
          status: record.status,
          sourcePath: record.sourcePath,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })),
      }
    },
  })
}

export function createSchemaTool(services: DataServices): ToolDefinition {
  return toolDef({
    name: 'dataset_schema',
    description: [
      '查看数据集的列信息：列名（保留原始表头，含中文）、推断类型、是否可空、样例值与说明。',
      '只读工具。写操作前先用它确认列名与类型；列名必须与这里列出的完全一致。',
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
          rowCount: { type: 'integer' },
          status: { type: 'string' },
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
      render: (_args, value: SchemaOutput) => [
        {
          type: 'text',
          text: [
            `数据集 ${value.name}（${value.datasetId}）：${value.columns.length} 列，${value.rowCount} 行，状态 ${value.status}`,
            '',
            renderColumns(value.columns),
          ].join('\n'),
        },
      ],
    },
    presentCall: args => ({ card: 'generic', title: `查看列信息：${args.dataset}`, kind: 'read' }),
    execute: async (args, exec): Promise<SchemaOutput> => {
      const { record } = await resolveDataset(services, exec, args.dataset, { requireReady: true })
      exec.signal.throwIfAborted()
      return {
        datasetId: record.id,
        name: record.name,
        rowCount: record.rowCount,
        status: record.status,
        columns: record.columns,
      }
    },
  })
}

export function createQueryTool(services: DataServices): ToolDefinition {
  return toolDef({
    name: 'dataset_query',
    description: [
      '只读查询数据集，返回列名与行。推荐用结构化参数：columns（列名数组，空表示全部）、where（SQL 布尔表达式，如 "单价 > 100 AND 城市 = \'深圳\'"）、orderBy（如 "单价 DESC"）、limit、offset。',
      '需要聚合/分组时才用 sql：只允许单条 SELECT / WITH / EXPLAIN 语句，用保留别名 ds 指代本数据集（如 `SELECT 状态, COUNT(*) c FROM ds GROUP BY 状态`），'
      + '其它表引用必须来自本工作区已登记的数据集，且不允许出现写操作与 DDL 关键字。',
      '系统列 _row_id 是行的定位键，结果里会返回，写操作（update/delete）需要它。只读工具，不会修改数据。',
    ].join(' '),
    parameters: {
      dataset: DATASET_PARAM,
      sql: { type: 'string', description: '可选：原始只读 SQL（单条 SELECT / WITH / EXPLAIN）。与 columns/where/orderBy 互斥，优先使用结构化参数。' },
      columns: { type: 'array', items: { type: 'string' }, description: '可选：要返回的列名；省略或传空数组表示全部列。' },
      where: { type: 'string', description: '可选：SQL 布尔表达式（不含 WHERE 关键字），如 "数量 >= 10 AND 名称 LIKE \'%钢%\'"。' },
      orderBy: { type: 'string', description: '可选：排序，如 "单价 DESC, 名称 ASC"。' },
      limit: { type: 'integer', description: '可选：返回行数上限，默认 50。' },
      offset: { type: 'integer', description: '可选：跳过前 N 行，默认 0。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          datasetId: { type: 'string' },
          name: { type: 'string' },
          columns: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
          rowCount: { type: 'integer' },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value: QueryOutput) => [
        {
          type: 'text',
          text: [
            `${value.name}（${value.datasetId}）：返回 ${value.rowCount} 行${value.truncated ? `（已达上限 ${value.limit}）` : ''}`,
            '',
            renderRows(value.columns, value.rows),
          ].join('\n'),
        },
      ],
    },
    presentCall: args => ({ card: 'generic', title: `查询数据集：${args.dataset}`, kind: 'read' }),
    execute: async (args, exec): Promise<QueryOutput> => {
      const { scope, record, db } = await resolveDataset(services, exec, args.dataset, { requireReady: true })
      const maxRows = services.cfg.maxQueryRows
      let sql: string
      let params: unknown[]

      if (typeof args.sql === 'string' && args.sql.trim().length > 0) {
        if (!services.cfg.allowRawSql) {
          throw new ToolError('当前配置禁用了原始 SQL（allowRawSql=false），请改用结构化参数', 'RAW_SQL_DISABLED')
        }
        const allowedTables = await services.store.tableNames(scope.scopeKey)
        // 模型只写 `ds`，物理表名由插件替换进去（句柄化：表名从不出现在参数里）。
        sql = validateReadOnlyQuery(substituteDatasetAlias(args.sql, record.tableName), { allowedTables, maxRows })
        params = []
      } else {
        const built = buildStructuredQuery({
          table: record.tableName,
          columns: args.columns,
          where: args.where,
          orderBy: args.orderBy,
          limit: args.limit ?? DEFAULT_QUERY_LIMIT,
          offset: args.offset,
          allowedColumns: record.columns.map(column => column.sanitizedName),
          maxRows,
        })
        sql = built.sql
        params = built.params
      }

      exec.signal.throwIfAborted()
      const { rows, columns } = await selectRows(db, sql, params)
      const limit = typeof args.limit === 'number' ? args.limit : (params[0] as number | undefined ?? DEFAULT_QUERY_LIMIT)
      return {
        datasetId: record.id,
        name: record.name,
        columns,
        rows,
        rowCount: rows.length,
        limit: Number(limit),
        offset: Number(args.offset ?? 0),
        truncated: rows.length >= maxRows,
      }
    },
  })
}
