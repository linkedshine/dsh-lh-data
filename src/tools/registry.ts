/**
 * 八个工具的聚合导出（设计文档 §5.1）。
 */

import type { DataServices } from '../store'
import type { ToolDefinition } from '../tooling'
import { createImportTool } from './import'
import { createListTool, createQueryTool, createSchemaTool } from './read'
import { createDeleteTool, createDropTool, createInsertTool, createUpdateTool } from './write'

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
])

/** 破坏性工具：写类，默认走 `ctx.approval` 人工确认（fail-closed）。 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'dataset_import',
  'dataset_insert',
  'dataset_update',
  'dataset_delete',
  'dataset_drop',
])

export function createToolDefinitions(services: DataServices): ToolDefinition[] {
  return [
    createListTool(services),
    createSchemaTool(services),
    createQueryTool(services),
    createImportTool(services),
    createInsertTool(services),
    createUpdateTool(services),
    createDeleteTool(services),
    createDropTool(services),
  ]
}
