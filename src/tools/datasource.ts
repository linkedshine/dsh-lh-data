/**
 * `datasource_*`：数据源的列表 / 连通性测试 / 远端表浏览 / 导入。
 *
 * 与 `dataset_*` 的关系：数据源只是**数据来源**的另一种形态——导入完成后的数据集
 * 与 Excel 导入的完全同权，之后一律用 `dataset_*` 工具操作。
 *
 * 脱敏红线：四个工具的返回值与渲染文本里都不出现密码、连接串与本地物理表名。
 */

import { connectSource, testSource } from '../datasource/connection'
import { isDataSourceError } from '../datasource/errors'
import { importRemoteTable, type RemoteImportResult } from '../datasource/importer'
import type { DataSourceRecord, ConnectionTestResult } from '../datasource/types'
import {
  renderColumns,
  renderConnectionTest,
  renderSourceList,
  renderSourceTables,
  type SourceListItem,
  type SourceTableItem,
} from '../render'
import type { DataServices } from '../store'
import { toolDef, ToolError, type ToolDefinition, type ToolExec } from '../tooling'

const SOURCE_PARAM = {
  type: 'string',
  required: true,
  description: '数据源的 sourceId 或登记名（来自 datasource_list）。',
} as const

/** `DataSourceError` → `ToolError`（保留 code），其余错误原样上抛。 */
function asToolFailure(error: unknown): unknown {
  return isDataSourceError(error) ? new ToolError(error.message, error.code) : error
}

function toListItem(record: DataSourceRecord): SourceListItem {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    host: record.host,
    port: record.port,
    database: record.database,
    status: record.status,
    lastError: record.lastError,
    lastCheckedAt: record.lastCheckedAt,
  }
}

// ── datasource_list ──────────────────────────────────────────────────────────

const COLUMN_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      type: { type: 'string' },
      nullable: { type: 'boolean' },
      description: { type: 'string' },
    },
  },
} as const

export function createSourceListTool(services: DataServices): ToolDefinition {
  return toolDef({
    name: 'datasource_list',
    description: [
      '列出已登记的数据库数据源：sourceId、登记名、类型（mysql / postgresql）、地址、库名、连通状态。',
      '数据源是全局登记的，不按工作区隔离。返回内容不含密码等凭据。',
      '只读工具，不修改任何数据。后续 datasource_* 工具都用这里的 sourceId 或登记名指代数据源。',
    ].join(' '),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', description: '数据源数量' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                type: { type: 'string' },
                host: { type: 'string' },
                port: { type: 'integer' },
                database: { type: 'string' },
                status: { type: 'string', description: 'unknown / connected / error' },
                lastError: { type: 'string' },
                lastCheckedAt: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value: { count: number; sources: SourceListItem[] }) => [
        { type: 'text', text: renderSourceList(value.sources) },
      ],
    },
    execute: async (): Promise<{ count: number; sources: SourceListItem[] }> => {
      const records = await services.sources.list()
      return { count: records.length, sources: records.map(toListItem) }
    },
  })
}

// ── datasource_test ──────────────────────────────────────────────────────────

interface TestOutput {
  sourceId: string
  name: string
  type: string
  success: boolean
  latency: number
  version: string | null
  error: string | null
}

export function createSourceTestTool(services: DataServices): ToolDefinition {
  return toolDef({
    name: 'datasource_test',
    description: [
      '测试一个已登记数据源的连通性，返回是否成功、延迟毫秒数与数据库版本。',
      '失败时给出脱敏后的错误原因；检测结果会写回数据源的 status / lastError。',
      '只读工具（不读业务数据），但会真正发起一次连接。',
    ].join(' '),
    parameters: { source: SOURCE_PARAM },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceId: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string' },
          success: { type: 'boolean' },
          latency: { type: 'integer', description: '毫秒' },
          version: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: TestOutput) => [
        {
          type: 'text',
          text: renderConnectionTest({
            name: value.name,
            success: value.success,
            latency: value.latency,
            version: value.version,
            error: value.error,
          }),
        },
      ],
    },
    execute: async (args): Promise<TestOutput> => {
      try {
        const record = await services.sources.require(args.source)
        const result: ConnectionTestResult = await testSource(services.cfg, record)
        await services.sources.recordCheck(record.id, result.success, result.error)
        return {
          sourceId: record.id,
          name: record.name,
          type: record.type,
          success: result.success,
          latency: result.latency,
          version: result.version,
          error: result.error,
        }
      } catch (error: unknown) {
        throw asToolFailure(error)
      }
    },
  })
}

// ── datasource_tables ────────────────────────────────────────────────────────

interface TablesOutput {
  sourceId: string
  name: string
  schema: string | null
  count: number
  tables: {
    tableName: string
    schemaName: string | null
    rowCount: number
    primaryKey: string | null
    columns: { name: string; type: string; nullable: boolean; description: string | null }[]
  }[]
}

export function createSourceTablesTool(services: DataServices): ToolDefinition {
  return toolDef({
    name: 'datasource_tables',
    description: [
      '浏览一个数据源里可用的表：表名、估计行数、主键与列结构（列名 / 推断类型 / 是否可空 / 注释）。',
      '可选 schema（PostgreSQL 默认 public，MySQL 无 schema 概念）；可选 q 按表名关键字过滤。',
      '只读工具。看中某张表后用 datasource_import 把它导入当前工作区。',
    ].join(' '),
    parameters: {
      source: SOURCE_PARAM,
      schema: { type: 'string', description: '可选：schema 名；PostgreSQL 默认 public。' },
      q: { type: 'string', description: '可选：按表名关键字过滤。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceId: { type: 'string' },
          name: { type: 'string' },
          schema: { type: 'string' },
          count: { type: 'integer' },
          tables: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tableName: { type: 'string' },
                schemaName: { type: 'string' },
                rowCount: { type: 'integer', description: '估计行数；-1 表示未知' },
                primaryKey: { type: 'string' },
                columns: COLUMN_SCHEMA,
              },
            },
          },
        },
      },
      render: (_args, value: TablesOutput) => {
        const items: SourceTableItem[] = value.tables.map(table => ({
          tableName: table.tableName,
          schemaName: table.schemaName,
          rowCount: table.rowCount,
          columnCount: table.columns.length,
          primaryKey: table.primaryKey,
        }))
        return [{ type: 'text', text: renderSourceTables(value.name, value.schema, items) }]
      },
    },
    execute: async (args): Promise<TablesOutput> => {
      try {
        const record = await services.sources.require(args.source)
        const connector = await connectSource(services.cfg, record)
        const tables = await connector.getTables(args.schema)
        const keyword = (args.q ?? '').trim().toLowerCase()
        const matched = keyword.length === 0
          ? tables
          : tables.filter(table => table.tableName.toLowerCase().includes(keyword))
        return {
          sourceId: record.id,
          name: record.name,
          schema: args.schema ?? null,
          count: matched.length,
          tables: matched.map(table => ({
            tableName: table.tableName,
            schemaName: table.schemaName,
            rowCount: table.rowCount,
            primaryKey: table.primaryKey,
            columns: table.columns.map(column => ({
              name: column.name,
              type: column.nativeType,
              nullable: column.nullable,
              description: column.comment,
            })),
          })),
        }
      } catch (error: unknown) {
        throw asToolFailure(error)
      }
    },
  })
}

// ── datasource_import ────────────────────────────────────────────────────────

type ImportOutput = RemoteImportResult

export function createSourceImportTool(services: DataServices): ToolDefinition {
  return toolDef({
    name: 'datasource_import',
    description: [
      '把远端数据源里的一张表全量导入当前工作区，产出标准数据集（之后用 dataset_* 工具操作）。',
      'source 指定数据源，table 指定远端表名（PostgreSQL 可再加 schema）；name 指定登记名，缺省取表名。',
      'limit 只导入前 N 行；大表会自动转后台任务并返回 jobId，完成后回注通知。',
      '导入后的数据集与 Excel 导入的完全同权：dataset_query / dataset_insert 等照常使用。',
      '这是写操作，会触发人工确认。',
    ].join(' '),
    parameters: {
      source: SOURCE_PARAM,
      table: { type: 'string', required: true, description: '远端表名（先用 datasource_tables 确认）。' },
      schema: { type: 'string', description: '可选：PostgreSQL 的 schema 名。' },
      name: { type: 'string', description: '可选：数据集登记名；默认取远端表名。' },
      limit: { type: 'integer', description: '可选：只导入前 N 行。' },
      background: { type: 'boolean', description: '可选：true 强制后台导入；默认大表自动转后台。' },
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
        return [{ type: 'text', text: [head, '', renderColumns(value.columns)].join('\n') }]
      },
    },
    presentCall: args => ({
      card: 'generic',
      title: `导入远端表 ${args.table}`,
      kind: 'write',
    }),
    execute: async (args, exec: ToolExec): Promise<ImportOutput> => {
      if (services.cfg.readOnly) {
        throw new ToolError('dsh-lh-data 处于只读模式（readOnly=true），已拒绝导入', 'READ_ONLY')
      }
      try {
        const scope = await services.scopeOf(exec)
        const record = await services.sources.require(args.source)
        exec.signal.throwIfAborted()
        const result = await importRemoteTable(services, {
          scopeKey: scope.scopeKey,
          source: record,
          tableName: args.table,
          schemaName: args.schema ?? null,
          name: args.name ?? null,
          limit: args.limit ?? null,
        }, {
          signal: exec.signal,
          exec,
          background: args.background === true,
        })
        return result
      } catch (error: unknown) {
        throw asToolFailure(error)
      }
    },
  })
}

/** 供 registry 聚合。 */
export function createDataSourceTools(services: DataServices): ToolDefinition[] {
  return [
    createSourceListTool(services),
    createSourceTestTool(services),
    createSourceTablesTool(services),
    createSourceImportTool(services),
  ]
}
