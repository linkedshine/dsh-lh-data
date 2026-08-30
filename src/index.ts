/**
 * 插件入口：`name` / `inject` / `Config` / `apply`。
 *
 * 装载链路与 `dsh-lh-judge` 完全一致：
 * `pnpm run build` → `pnpm dsh plugin --profile web add D:\fastwork\projects\node\dsh-lh-data`
 *
 * 职责（设计文档 §7.2 / §9）：
 * - 注册八个 `dataset_*` 工具（句柄化，物理表名不外泄）；
 * - `tools/pre-execute` 给写工具加 `ask` 门禁（无审批通道即拒绝，fail-closed）；
 * - `ctx.tools.guard()` 单调兜底：写工具缺少归属句柄一律拒绝；
 * - `ctx.systemPrompt.section()` 注入使用引导（可选依赖）；
 * - `ctx.effect()` 在 HMR / 卸载时关闭 libSQL 连接。
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { closeAllDatabases } from './db'
import { resolveScope } from './scope'
import { createStore, type DataConfig, type DataServices } from './store'
import { createToolDefinitions, WRITE_TOOLS } from './tools/registry'
import { PLUGIN_NAME, type PreToolDecision, type ToolDefinition, type ToolExec, type ToolRegistry } from './tooling'

/** cordis 用于加载/去重的唯一标识。 */
export const name: string = PLUGIN_NAME

/** 等 `ctx.tools` 就绪后才 apply。 */
export const inject: string[] = ['tools']

/** 插件与 dsh 运行时交互的最小上下文（duck-typed：只声明实际用到的成员）。 */
export interface PluginContext {
  tools: ToolRegistry
  // cordis 的中间件签名随事件变化，这里只保留插件需要的通用形状。
  on(event: string, handler: (...args: any[]) => any): void
  effect?(setup: () => (() => void) | void): () => void
  inject?(deps: string[], callback: (injected: unknown) => void): unknown
  logger?: { info?(message: string): void; warn?(message: string): void }
}

/** 系统提示词段落（可选依赖 `systemPrompt`）。 */
interface PromptSection {
  name: string
  order: number
  text: string
}

/**
 * 插件配置。类型与 `store.ts` 的 DataConfig 同源（在此只做具名导出），
 * 避免 tools → index 的类型循环。
 */
export interface Config extends DataConfig {}

// Config 必须是 schemastery（Standard Schema）实例，否则 cordis 校验阶段抛
// `Config.validate is undefined`（见 dsh-lh-judge/src/index.ts 的记录）。
export const Config: Schema<Config> = Schema.object({
  dbPath: Schema.string().default('').description('libSQL 库路径；空 → $DSH_HOME/lh-data/data.db'),
  dbUrl: Schema.string().default('').description('非空则覆盖 dbPath，可为 file: 或 libsql://（远程 Turso）'),
  authToken: Schema.string().default('').description('远程 Turso token；建议留空并走环境变量 TURSO_AUTH_TOKEN'),
  perWorkspace: Schema.boolean().default(false).description('true 时 scope 用 WorkspaceId 且每个工作区独立库文件'),
  requireApprovalForWrites: Schema.boolean().default(true).description('写类工具是否走 ctx.approval 人工确认'),
  allowRawSql: Schema.boolean().default(true).description('dataset_query 是否接受原始 sql；关闭后仅结构化查询'),
  maxFileBytes: Schema.number().default(209715200).description('单个导入文件的字节上限'),
  maxInsertRows: Schema.number().default(500).description('dataset_insert 单次插入行数上限'),
  maxQueryRows: Schema.number().default(200).description('dataset_query 返回行数上限'),
  batchSize: Schema.number().default(100).description('导入批量插入的批次大小'),
  backgroundThresholdRows: Schema.number().default(20000).description('超过该行数自动转后台导入'),
  previewSampleRows: Schema.number().default(100).description('类型推断的采样行数'),
  readOnly: Schema.boolean().default(false).description('只读模式：写类工具直接 deny'),
})

/** 注入系统提示词的使用引导（替代 v1 的 SKILL.md）。 */
const USAGE_SECTION = [
  '## 本地表格库（dsh-lh-data）',
  '',
  '- `dataset_import` 把工作区内的 .xlsx / .xls / .csv 落库；大文件自动转后台任务。',
  '- 先 `dataset_list` 确认目标，再 `dataset_schema` 看列名与类型，然后 `dataset_query` 查询。',
  '- 查询优先用结构化参数（columns / where / orderBy / limit）；只有在需要聚合或连接时才传 `sql`。',
  '- `dataset_insert` / `dataset_update` / `dataset_delete` / `dataset_drop` 是写操作，会触发人工确认。',
  '- 所有工具用 datasetId 或登记名指代数据集；不要猜测或拼接物理表名。',
].join('\n')

const USAGE_SECTION_ORDER = 900

/**
 * 非 cordis 环境（如 `examples/run-import.mjs` 直接调用 apply）的轻量校验/默认值合并。
 * cordis 装载时配置已由 `Config` schema 校验并合并。
 */
/** 从 schema 读取默认值（schema 的 default() 是唯一真源，避免两处漂移）。 */
function schemaDefaults(): Config {
  const permissive = Config as unknown as (data?: unknown) => Config
  return permissive(undefined)
}

export function validateConfig(cfg: Partial<DataConfig> = {}): Config {
  if (cfg === null || typeof cfg !== 'object') throw new Error('config must be an object')
  const source = cfg as Partial<DataConfig>
  const merged: Config = { ...schemaDefaults(), ...source }
  for (const key of ['maxFileBytes', 'maxInsertRows', 'maxQueryRows', 'batchSize', 'backgroundThresholdRows', 'previewSampleRows'] as const) {
    const value = merged[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${key} must be a non-negative number`)
    }
  }
  for (const key of ['perWorkspace', 'requireApprovalForWrites', 'allowRawSql', 'readOnly'] as const) {
    if (typeof merged[key] !== 'boolean') throw new Error(`${key} must be a boolean`)
  }
  for (const key of ['dbPath', 'dbUrl', 'authToken'] as const) {
    if (typeof merged[key] !== 'string') throw new Error(`${key} must be a string`)
  }
  return merged
}

/** 从一次写调用中提取归属句柄，供审批理由与单调守卫使用。 */
function targetOf(exec: ToolExec): string {
  const args: unknown = exec.arguments
  if (typeof args !== 'object' || args === null) return ''
  const record = args as Record<string, unknown>
  if (typeof record.dataset === 'string' && record.dataset.trim().length > 0) return record.dataset.trim()
  if (typeof record.path === 'string' && record.path.trim().length > 0) return record.path.trim()
  return ''
}

/** `tools/pre-execute` 的 next() 兜底：缺失或返回空值都按 allow 处理。 */
async function delegate(next: (() => Promise<PreToolDecision>) | undefined): Promise<PreToolDecision> {
  if (typeof next !== 'function') return { kind: 'allow' }
  return (await next()) ?? { kind: 'allow' }
}

// ── 工具调用日志 ──────────────────────────────────────────────────────────

/** 单个字符串参数的预览上限（dataset_insert 的 rows 可能很大，禁止整包进日志）。 */
const MAX_ARG_PREVIEW = 80

function previewText(value: string): string {
  return value.length > MAX_ARG_PREVIEW ? `${value.slice(0, MAX_ARG_PREVIEW)}…(${value.length})` : value
}

/** 参数摘要：只记键名与规模，避免把整表数据写进日志。 */
function summarizeArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return String(args)
  const record = args as Record<string, unknown>
  const parts = Object.keys(record).map(key => {
    const value = record[key]
    if (typeof value === 'string') return `${key}=${previewText(value)}`
    if (Array.isArray(value)) return `${key}[${value.length}]`
    if (typeof value === 'object' && value !== null) return `${key}{${Object.keys(value).length}}`
    return `${key}=${String(value)}`
  })
  return parts.length > 0 ? parts.join(' ') : '(no args)'
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * 给工具的 `execute` 包一层开始/结束日志（成功、失败、取消各一条，含耗时）。
 * 只观测不介入：异常原样向上抛，返回值原样传出。
 */
function withCallLogging(
  definition: ToolDefinition,
  log: (message: string) => void,
  warn: (message: string) => void,
): ToolDefinition {
  const execute = definition.execute
  return {
    ...definition,
    async execute(args: unknown, exec: ToolExec): Promise<unknown> {
      const startedAt = Date.now()
      log(`${definition.name} start ${summarizeArgs(args)}`)
      try {
        const value = await execute(args, exec)
        const elapsed = Date.now() - startedAt
        if (exec.signal?.aborted === true) warn(`${definition.name} end aborted in ${elapsed}ms`)
        else log(`${definition.name} end ok in ${elapsed}ms`)
        return value
      } catch (error) {
        warn(`${definition.name} end error in ${Date.now() - startedAt}ms: ${errorMessage(error)}`)
        throw error
      }
    },
  }
}

export function apply(ctx: Context, config: Config): void {
  const rt = ctx as unknown as PluginContext
  const cfg = config
  const log = (message: string): void => {
    rt.logger?.info?.(message)
  }
  const warn = (message: string): void => {
    rt.logger?.warn?.(message)
  }

  const services: DataServices = {
    cfg,
    store: createStore(cfg),
    scopeOf: exec => resolveScope(rt, cfg, exec),
  }

  // 可选依赖：jobs（后台导入）与 systemPrompt（使用引导）。缺失即降级，不影响装载。
  if (typeof rt.inject === 'function') {
    rt.inject(['jobs'], (injected: unknown) => {
      const jobs = (injected as { jobs?: DataServices['jobs'] } | null | undefined)?.jobs
      if (jobs !== undefined) services.jobs = jobs
    })
    rt.inject(['systemPrompt'], (injected: unknown) => {
      const systemPrompt = (injected as {
        systemPrompt?: { section?(section: PromptSection): () => void }
      } | null | undefined)?.systemPrompt
      systemPrompt?.section?.({
        name: `${PLUGIN_NAME}:usage`,
        order: USAGE_SECTION_ORDER,
        text: USAGE_SECTION,
      })
    })
  }

  // 注册即副作用：把 disposer 挂到插件 fiber，保证 HMR / 卸载时注销工具。
  const unregister = createToolDefinitions(services)
    .map(definition => withCallLogging(definition, log, warn))
    .map(definition => rt.tools.register(definition))
  if (typeof rt.effect === 'function') {
    rt.effect(() => () => {
      for (const dispose of unregister) dispose()
    })
  }

  // 破坏性门禁：写工具 → ask（ctx.approval）；只读模式下直接 deny。
  rt.on('tools/pre-execute', async (exec: ToolExec, next?: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    if (!WRITE_TOOLS.has(exec.name)) return await delegate(next)
    if (cfg.readOnly) {
      return { kind: 'deny', reason: 'dsh-lh-data 处于只读模式（readOnly=true），写操作已禁用' }
    }
    if (!cfg.requireApprovalForWrites) return await delegate(next)
    const target = targetOf(exec)
    return {
      kind: 'ask',
      reason: `${exec.name} 会修改本地表格库${target.length > 0 ? `（目标：${target}）` : ''}`,
    }
  })

  // 单调守卫：写工具缺少归属句柄一律拒绝（后续监听器无法撤销）。
  const unguard = rt.tools.guard?.(exec => {
    if (!WRITE_TOOLS.has(exec.name)) return undefined
    const target = targetOf(exec)
    if (target.length === 0) {
      return `${exec.name} 必须指定 ${exec.name === 'dataset_import' ? 'path' : 'dataset'}（datasetId 或登记名）`
    }
    return undefined
  })
  if (unguard !== undefined && typeof rt.effect === 'function') rt.effect(() => () => unguard())

  // 非 cordis 管理的资源（libSQL 客户端）挂到插件 fiber，卸载时确定性释放。
  if (typeof rt.effect === 'function') rt.effect(() => () => closeAllDatabases())

  log(`${PLUGIN_NAME} applied (readOnly=${String(cfg.readOnly)}, approval=${String(cfg.requireApprovalForWrites)})`)
}

// ── 测试/调试导出（不参与插件装载） ────────────────────────────────────────
export { closeAllDatabases } from './db'
export {
  inferColumnType,
  isCodeOrIdField,
  isLargeNumber,
  parseCSV,
  parseXLSX,
  sanitizeColumnName,
} from './parse'
export { isInside, normalizeDirectory, resolveInputFile } from './scope'
export { SqlError, buildStructuredQuery, substituteDatasetAlias, validateReadOnlyQuery } from './sql'
export { PHYSICAL_TABLE_PATTERN, assertPhysicalTableName, generateTableName } from './store'
export { PLUGIN_NAME } from './tooling'
