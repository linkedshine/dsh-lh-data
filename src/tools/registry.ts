/**
 * 八个工具的聚合导出（设计文档 §5.1）。
 */

import type { DataServices } from '../store'
import type { ToolDefinition } from '../tooling'
import { createImportTool } from './import'
import { createListTool, createQueryTool, createSchemaTool } from './read'
import { createDataSourceTools } from './datasource'
import { createDeleteTool, createDropTool, createInsertTool, createUpdateTool } from './write'

/** 数据源工具（`datasourceEnabled=false` 时整体不注册）。 */
export const DATA_SOURCE_TOOLS: ReadonlySet<string> = new Set([
  'datasource_list',
  'datasource_test',
  'datasource_tables',
  'datasource_import',
])

/** 本插件注册的全部工具名。 */
export const DATASET_TOOLS: ReadonlySet<string> = new Set([
  'dataset_list',
  'dataset_schema',
  'dataset_query',
  'dataset_import',
  'dataset_insert',
  'dataset_update',
  'dataset_delete',
  'dataset_drop',
  ...DATA_SOURCE_TOOLS,
])

/** 破坏性工具：写类，默认走 `ctx.approval` 人工确认（fail-closed）。 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'dataset_import',
  'dataset_insert',
  'dataset_update',
  'dataset_delete',
  'dataset_drop',
  'datasource_import',
])

export function createToolDefinitions(services: DataServices): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createListTool(services),
    createSchemaTool(services),
    createQueryTool(services),
    createImportTool(services),
    createInsertTool(services),
    createUpdateTool(services),
    createDeleteTool(services),
    createDropTool(services),
  ]
  if (services.cfg.datasourceEnabled) tools.push(...createDataSourceTools(services))
  return tools
}
