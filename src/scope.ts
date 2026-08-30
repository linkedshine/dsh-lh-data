/**
 * 作用域与路径解析（设计文档 §2.4 / §7.4）。
 *
 * - scopeKey：默认取调用 agent 的 `session.cwd`（规范化后的绝对路径）；
 *   `perWorkspace` 时提升为 `WorkspaceId`（`ws:<id>`），不可用时回落 cwd。
 * - 路径：导入文件必须解析后落在 scope 目录内（防 `../` 穿越）+ 扩展名白名单。
 */

import { stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import type { ToolExec } from './tooling'

export interface ScopeContext {
  /** 数据集归属键（写入 `datasets.scope_key`）。 */
  scopeKey: string
  /** 解析相对路径用的工作区目录。 */
  cwd: string
  /** `perWorkspace` 模式下的 WorkspaceId。 */
  workspaceId?: string
}

export const FILE_EXTENSIONS = ['.xlsx', '.xls', '.csv'] as const

export const DEFAULT_SCOPE = 'default'

export class ScopeError extends Error {
  readonly code = 'SCOPE_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'ScopeError'
  }
}

/** 规范化目录：解析为绝对路径，并在 Windows 上把盘符小写化（便于比较）。 */
export function normalizeDirectory(input: string): string {
  const resolved = resolve(input)
  return process.platform === 'win32'
    ? resolved.replace(/^([a-zA-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`)
    : resolved
}

function sessionCwdOf(exec: ToolExec): string | undefined {
  const cwd: unknown = exec?.agent?.session?.cwd
  return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined
}

/** 可选能力：把 cwd 提升为 WorkspaceId（duck-typed，缺失即回落）。 */
function lookupWorkspaceId(ctx: unknown, cwd: string): string | undefined {
  const registry: unknown = (ctx as { workspaceRegistry?: unknown } | null)?.workspaceRegistry
  if (typeof registry !== 'object' || registry === null) return undefined
  const resolveByPath: unknown = (registry as { resolveByPath?: unknown }).resolveByPath
  if (typeof resolveByPath !== 'function') return undefined
  let found: unknown
  try {
    found = (resolveByPath as (path: string) => unknown).call(registry, cwd)
  } catch {
    return undefined
  }
  if (typeof found === 'string') return found.length > 0 ? found : undefined
  if (typeof found === 'object' && found !== null) {
    const record = found as { id?: unknown; workspaceId?: unknown }
    const id = record.id ?? record.workspaceId
    if (typeof id === 'string' && id.length > 0) return id
  }
  return undefined
}

/**
 * 从一次工具执行解析 scope。无 cwd 时回落 `process.cwd()`；
 * `perWorkspace` 且拿不到 WorkspaceId 时仍用 cwd（headless 场景可运行）。
 */
export function resolveScope(ctx: unknown, cfg: { perWorkspace: boolean }, exec: ToolExec): ScopeContext {
  const cwd = normalizeDirectory(sessionCwdOf(exec) ?? process.cwd())
  if (!cfg.perWorkspace) return { scopeKey: cwd, cwd }
  const workspaceId = lookupWorkspaceId(ctx, cwd)
  return workspaceId === undefined ? { scopeKey: cwd, cwd } : { scopeKey: `ws:${workspaceId}`, cwd, workspaceId }
}

/** target 是否位于 baseDir 之内（含子目录）。 */
export function isInside(baseDir: string, target: string): boolean {
  const rel = relative(baseDir, target)
  if (rel.length === 0 || rel.startsWith('..')) return false
  return !isAbsolute(rel)
}

/** 解析导入路径：相对路径以 cwd 为基，越界或扩展名不在白名单即拒绝。 */
export function resolveInputFile(cwd: string, input: string): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw.length === 0) throw new ScopeError('path 不能为空')
  const target = normalizeDirectory(isAbsolute(raw) ? raw : resolve(cwd, raw))
  if (!isInside(cwd, target)) throw new ScopeError(`文件必须在工作区目录内：${raw}`)
  const ext = extname(target).toLowerCase()
  if (!(FILE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ScopeError(`不支持的文件类型：${ext || '(无扩展名)'}，仅支持 ${FILE_EXTENSIONS.join(' / ')}`)
  }
  return target
}

/** 读取前校验：必须是普通文件、非空且不超过 `maxBytes`。 */
export async function assertReadableFile(path: string, maxBytes: number): Promise<{ size: number }> {
  let info
  try {
    info = await stat(path)
  } catch {
    throw new ScopeError(`文件不存在或不可读取：${path}`)
  }
  if (!info.isFile()) throw new ScopeError(`不是文件：${path}`)
  if (info.size === 0) throw new ScopeError(`文件为空：${path}`)
  if (info.size > maxBytes) throw new ScopeError(`文件过大：${info.size} 字节，上限 ${maxBytes} 字节`)
  return { size: info.size }
}
