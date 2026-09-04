/**
 * 只读工具：`dataset_list` / `dataset_schema` / `dataset_query`。
 *
 * 三个工具都不修改数据，因此走 `allow`（不触发审批）；返回值只出现 datasetId 与登记名，
 * 物理表名留在 `store.ts` 内部（设计文档 §7.1）。
 */

import { renderColumns, renderDatasetList, renderQueryPreview } from '../render'
import type { ColumnInfo } from '../parse'
import type { Row } from '../db'
import { resolveDataset, type DataServices } from '../store'
import { selectRows } from '../table'
import {
  planRawQuery,
  planStructuredQuery,
  substituteDatasetAlias,
  validateReadOnlyQuery,
} from '../sql'
import {
  buildPreviewSlice,
  previewSlicePlan,
  summarizeColumns,
  type ColumnSummary,
  type PreviewOptions,
} from '../preview'
import { debugLog, toolDef, ToolError, type ToolDefinition, type ToolExec } from '../tooling'

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
  description: string | null
  rowCount: number
  status: string
  columns: ColumnInfo[]
}

/** 结果视图的定位信息（设计文档 §5.1 / §5.4）。 */
export interface QueryViewInfo {
  viewId: string
  endpoint: string
  pageSize: number
  maxPageSize: number
  /** 排序是否稳定（false 时前端只展示首页）。 */
  stable: boolean
  /** 允许前端排序的列名白名单。 */
  sortable: string[]
  expiresAt: number
}

export interface QueryOutput {
  datasetId: string
  name: string
  columns: { name: string; type: string }[]
  /** 实际命中的行数（不受上限收敛影响）。 */
  matchedRows: number
  /** 本次可服务的行数（已按 maxQueryRows / maxViewRows 收敛）。 */
  totalRows: number
  preview: {
    rows: Row[]
    columns: string[]
    /** 头段行数（`gap` 为真时其后是尾段）。 */
    headCount: number
    gap: boolean
    skipped: number
    cellTruncated: boolean
    columnTruncated: boolean
    hiddenColumns: number
  }
  summary: ColumnSummary[]
  limit: number
  offset: number
  /** 预览只是结果的一部分。 */
  truncated: boolean
  /** 存在前端视图（完整结果由前端分页拉取）。 */
  view?: QueryViewInfo
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
          description: { oneOf: [{ type: 'string' }, { type: 'null' }] },
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
        description: record.description,
        rowCount: record.rowCount,
        status: record.status,
        columns: record.columns,
      }
    },
  })
}

/** 从插件配置里取出片段相关的选项。 */
function previewOptionsOf(cfg: DataServices['cfg']): PreviewOptions {
  return {
    previewRows: cfg.previewRows,
    previewStrategy: cfg.previewStrategy,
    previewColumns: cfg.previewColumns,
    summaryEnabled: cfg.summaryEnabled,
    summaryMaxColumns: cfg.summaryMaxColumns,
    summaryMaxTextColumns: cfg.summaryMaxTextColumns,
  }
}

const COLUMN_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    type: { type: 'string' },
  },
} as const

export function createQueryTool(services: DataServices): ToolDefinition {
  return toolDef({
    name: 'dataset_query',
    description: [
      '只读查询数据集，返回列名与行。推荐用结构化参数：columns（列名数组，空表示全部）、where（SQL 布尔表达式，如 "单价 > 100 AND 城市 = \'深圳\'"）、orderBy（如 "单价 DESC"）、limit、offset。',
      '需要聚合/分组时才用 sql：只允许单条 SELECT / WITH / EXPLAIN 语句，用保留别名 ds 指代本数据集（如 `SELECT 状态, COUNT(*) c FROM ds GROUP BY 状态`），'
      + '其它表引用必须来自本工作区已登记的数据集，且不允许出现写操作与 DDL 关键字。',
      '系统列 _row_id 是行的定位键，结果里会返回，写操作（update/delete）需要它。只读工具，不会修改数据。',
      '结果较大时只返回「少量预览行 + 全量统计摘要」：完整结果会在前端表格里展示，你不需要逐页读取。',
      '要下结论请用更精确的 where 或聚合 SQL 再查一次（例如 SELECT 状态, COUNT(*) c FROM ds GROUP BY 状态），而不是把全表读进来。',
    ].join(' '),
    parameters: {
      dataset: DATASET_PARAM,
      sql: { type: 'string', description: '可选：原始只读 SQL（单条 SELECT / WITH / EXPLAIN）。与 columns/where/orderBy 互斥，优先使用结构化参数。' },
      columns: { type: 'array', items: { type: 'string' }, description: '可选：要返回的列名；省略或传空数组表示全部列。' },
      where: { type: 'string', description: '可选：SQL 布尔表达式（不含 WHERE 关键字），如 "数量 >= 10 AND 名称 LIKE \'%钢%\'"。' },
      orderBy: { type: 'string', description: '可选：排序，如 "单价 DESC, 名称 ASC"。' },
      limit: { type: 'integer', description: '可选：可服务行数的上限（不做分页取数，只影响片段与视图上限）。' },
      offset: { type: 'integer', description: '可选：预览片段从第 N 行开始，默认 0；视图始终从第一行开始。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          datasetId: { type: 'string' },
          name: { type: 'string' },
          columns: { type: 'array', items: COLUMN_ITEM_SCHEMA },
          matchedRows: { type: 'integer' },
          totalRows: { type: 'integer' },
          preview: {
            type: 'object',
            additionalProperties: false,
            properties: {
              rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
              columns: { type: 'array', items: { type: 'string' } },
              headCount: { type: 'integer' },
              gap: { type: 'boolean' },
              skipped: { type: 'integer' },
              cellTruncated: { type: 'boolean' },
              columnTruncated: { type: 'boolean' },
              hiddenColumns: { type: 'integer' },
            },
          },
          summary: { type: 'array', items: { type: 'object', additionalProperties: true } },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          truncated: { type: 'boolean' },
          view: {
            type: 'object',
            additionalProperties: false,
            properties: {
              viewId: { type: 'string' },
              endpoint: { type: 'string' },
              pageSize: { type: 'integer' },
              maxPageSize: { type: 'integer' },
              stable: { type: 'boolean' },
              sortable: { type: 'array', items: { type: 'string' } },
              expiresAt: { type: 'integer' },
            },
          },
        },
      },
      render: (_args, value: QueryOutput) => [
        {
          type: 'text',
          text: renderQueryPreview({
            name: value.name,
            datasetId: value.datasetId,
            columnCount: value.columns.length,
            totalRows: value.totalRows,
            matchedRows: value.matchedRows,
            preview: value.preview,
            summary: value.summary,
            truncated: value.truncated,
            ...value.view === undefined
              ? {}
              : { view: { pageSize: value.view.pageSize, stable: value.view.stable } },
          }),
        },
      ],
      /**
       * 只给前端的视图描述符（模型不可见）。
       * 必须是 (args, value) 的纯函数（平台会重放），所以 viewId 随规范值携带、由 render 刻意不打印。
       */
      presentationMeta: (_args, value: QueryOutput) => {
        if (value.view === undefined) return null
        const meta = {
          kind: 'dataset-view',
          viewId: value.view.viewId,
          endpoint: value.view.endpoint,
          datasetId: value.datasetId,
          name: value.name,
          columns: value.columns,
          totalRows: value.matchedRows,
          pageSize: value.view.pageSize,
          maxPageSize: value.view.maxPageSize,
          stable: value.view.stable,
          sortable: value.view.sortable,
          expiresAt: value.view.expiresAt,
        }
        debugLog('read:meta', meta)
        return meta
      },
    },
    presentCall: args => ({ card: 'generic', title: `查询数据集：${args.dataset}`, kind: 'read' }),
    execute: async (args, exec): Promise<QueryOutput> => {
      const { scope, record, db } = await resolveDataset(services, exec, args.dataset, { requireReady: true })
      const cfg = services.cfg
      const maxRows = cfg.maxQueryRows
      const raw = typeof args.sql === 'string' && args.sql.trim().length > 0
      // 视图可用时模型不必声明 limit：未声明即按 maxQueryRows 取上限，
      // 声明了才是「我只要这么多行」的显式收敛。
      const canView = services.views !== undefined

      if (raw && !cfg.allowRawSql) {
        throw new ToolError('当前配置禁用了原始 SQL（allowRawSql=false），请改用结构化参数', 'RAW_SQL_DISABLED')
      }
      const allowedTables = raw ? await services.store.tableNames(scope.scopeKey) : []

      // 模型只写 `ds`，物理表名由插件替换进去（句柄化：表名从不出现在参数里）。
      const plan = raw
        ? planRawQuery(substituteDatasetAlias(String(args.sql), record.tableName), { allowedTables, maxRows })
        : planStructuredQuery({
          table: record.tableName,
          columns: args.columns,
          where: args.where,
          orderBy: args.orderBy,
          // 有视图时不设默认上限（未声明 limit 即取到 maxQueryRows，前端按页取）；
          // 降级路径沿用旧的默认 50 行，避免无前端时突然多返回几倍数据。
          limit: canView ? args.limit : args.limit ?? DEFAULT_QUERY_LIMIT,
          offset: args.offset,
          allowedColumns: record.columns.map(column => column.sanitizedName),
          maxRows,
        })

      exec.signal.throwIfAborted()

      // EXPLAIN 不产生结果集：按原样执行，不走计数/视图。
      if (plan.explain) {
        const sql = validateReadOnlyQuery(substituteDatasetAlias(String(args.sql), record.tableName), { allowedTables, maxRows })
        const { rows, columns } = await selectRows(db, sql, [])
        return {
          datasetId: record.id,
          name: record.name,
          columns: columns.map(name => ({ name, type: 'text' })),
          matchedRows: rows.length,
          totalRows: rows.length,
          preview: {
            rows,
            columns,
            headCount: rows.length,
            gap: false,
            skipped: 0,
            cellTruncated: false,
            columnTruncated: false,
            hiddenColumns: 0,
          },
          summary: [],
          limit: rows.length,
          offset: 0,
          truncated: false,
        }
      }

      const previewOptions = previewOptionsOf(cfg)

      const countRow = await db.prepare(plan.countSql).get()
      const matched = Number(countRow?._total ?? 0)
      const maxViewRows = Math.max(1, Math.floor(cfg.maxViewRows))
      // 有视图时视图能翻到的行数由 maxViewRows 约束（模型显式 limit 再收敛一次）；
      // 降级路径沿用 maxQueryRows 语义（plan.rowCap）。
      const rowCap = canView ? Math.min(plan.declaredLimit ?? maxViewRows, maxViewRows) : plan.rowCap
      const totalRows = Math.max(0, Math.min(matched, rowCap))
      const previewOffset = Math.max(0, plan.previewOffset)
      debugLog('read:plan', {
        canView,
        matched,
        rowCap,
        maxViewRows,
        declaredLimit: plan.declaredLimit,
        totalRows,
      })

      // 探针：覆盖「建视图时的头段」；降级（无视图）时退化为旧行为，最多取满 rowCap。
      const probeLimit = canView
        ? Math.min(totalRows, Math.max(cfg.previewRows, cfg.viewThresholdRows))
        : Math.min(totalRows, rowCap)
      const probe = probeLimit > 0
        ? await selectRows(db, plan.pageSql, [probeLimit, previewOffset])
        : { rows: [] as Row[], columns: [] as string[] }
      exec.signal.throwIfAborted()

      const resultColumns = probe.columns.length > 0
        ? probe.columns
        : record.columns.map(column => column.sanitizedName)

      const estimatedBytes = JSON.stringify(probe.rows).length
      const useView = canView && (cfg.viewMode === 'always'
        || (cfg.viewMode === 'auto' && (totalRows > cfg.viewThresholdRows || estimatedBytes > cfg.viewThresholdBytes)))

      let headRows = probe.rows
      let tailRows: Row[] = []
      if (useView) {
        const slicePlan = previewSlicePlan(totalRows, previewOptions)
        headRows = probe.rows.slice(0, slicePlan.head)
        if (slicePlan.tail > 0 && totalRows > headRows.length) {
          const tailOffset = Math.max(0, totalRows - slicePlan.tail)
          tailRows = (await selectRows(db, plan.pageSql, [slicePlan.tail, tailOffset])).rows
        }
      }
      exec.signal.throwIfAborted()

      const slice = buildPreviewSlice(headRows, tailRows, resultColumns, totalRows, previewOptions)
      // 「还有行没展示」以真实命中数判定：上限收敛过的 totalRows 不能把它抹掉。
      const truncated = matched > slice.rows.length

      // 摘要基于全表聚合：只在「有视图」或「片段不完整」时才做，避免小结果集多跑一次扫描。
      const typeByName = new Map(record.columns.map(column => [column.sanitizedName, column.type]))
      const displayNameOf = new Map(record.columns.map(column => [column.sanitizedName, column.name]))
      const summary = cfg.summaryEnabled && (useView || truncated)
        ? (await summarizeColumns(
          db,
          record.tableName,
          record.columns.map(column => ({ name: column.sanitizedName, type: column.type })),
          previewOptions,
        )).map(entry => ({ ...entry, name: displayNameOf.get(entry.name) ?? entry.name }))
        : []

      const columns = resultColumns.map(name => ({ name, type: typeByName.get(name) ?? 'text' }))

      let view: QueryViewInfo | undefined
      if (useView && services.views !== undefined) {
        const registered = new Set(record.columns.map(column => column.sanitizedName))
        const descriptor = services.views.create({
          scopeKey: scope.scopeKey,
          datasetId: record.id,
          name: record.name,
          tableName: record.tableName,
          columns,
          countSql: plan.countSql,
          totalRows: matched,
          rowCap,
          sortable: resultColumns.filter(name => registered.has(name)),
          stable: plan.stable,
          baseSql: plan.baseSql,
          ...plan.baseOrder === undefined ? {} : { baseOrder: plan.baseOrder },
          ...plan.tie === undefined ? {} : { tie: plan.tie },
        })
        debugLog('read:view', {
          viewId: descriptor.viewId,
          totalRows: descriptor.totalRows,
          rowCap,
          matched,
        })
        view = {
          viewId: descriptor.viewId,
          endpoint: descriptor.endpoint,
          pageSize: descriptor.pageSize,
          maxPageSize: descriptor.maxPageSize,
          stable: descriptor.stable,
          sortable: descriptor.sortable,
          expiresAt: descriptor.expiresAt,
        }
      }

      return {
        datasetId: record.id,
        name: record.name,
        columns,
        matchedRows: matched,
        totalRows,
        preview: {
          rows: slice.rows,
          columns: slice.columns,
          headCount: headRows.length,
          gap: slice.gap,
          skipped: slice.skipped,
          cellTruncated: slice.rows.some(row => slice.columns.some((column) => {
            const value = row[column]
            return value !== null && value !== undefined && String(value).length > cfg.previewCellChars
          })),
          columnTruncated: slice.columnTruncated,
          hiddenColumns: Math.max(0, resultColumns.length - slice.columns.length),
        },
        summary,
        limit: rowCap,
        offset: previewOffset,
        truncated,
        ...view === undefined ? {} : { view },
      }
    },
  })
}
