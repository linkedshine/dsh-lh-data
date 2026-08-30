/**
 * 作用域与路径解析（设计文档 §2.4 / §7.4）。
 *
 * - scopeKey：默认取调用 agent 的会话工作目录（规范化后的绝对路径），即
 *   `exec.agent.session.header.cwd`（`SessionHeader`）；`perWorkspace` 时提升为
 *   `WorkspaceId`（`ws:<id>`），不可用时回落 cwd。
 * - 拿不到会话 cwd 时 fail-loud（抛 `ScopeError`）：不拿 `process.cwd()` 顶替，
 *   否则数据集会静默登记到 dsh 进程的启动目录。
 * - 路径：导入文件必须解析后落在 scope 目录内（防 `../` 穿越）+ 扩展名白名单。
 */

import { realpathSync } from 'node:fs'
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

/**
 * 目录的文件系统身份：`realpath` 后再规范化。
 *
 * Windows 的 junction / 符号链接、macOS 的 `/var` → `/private/var` 都会让纯词法
 * 比较误判归属，因此 scope 目录与导入目标一律按文件系统身份比较。与 dsh 的
 * `canonicalPath`（packages/sandbox/sandbox/src/roots.ts）同思路：用
 * `realpathSync.native` 逐段跟随链接；路径不存在时原样返回，由后续的存在性校验
 * （`assertReadableFile`）给出真正的错误。
 */
export function canonicalDirectory(input: string): string {
  try {
    return normalizeDirectory(realpathSync.native(input))
  } catch {
    return normalizeDirectory(input)
  }
}

/**
 * 取会话工作目录。
 *
 * 真实 dsh 运行时挂在 `exec.agent.session.header.cwd`（`Agent.session` 是 `Session`，
 * cwd 属于它的 `SessionHeader`）；`session.cwd` 是早期约定的扁平形状，仅作
 * headless / 自测兼容位保留。
 */
function sessionCwdOf(exec: ToolExec): string | undefined {
  const session: unknown = exec?.agent?.session
  if (typeof session !== 'object' || session === null) return undefined
  const header: unknown = (session as { header?: unknown }).header
  const fromHeader: unknown = (header as { cwd?: unknown } | null | undefined)?.cwd
  if (typeof fromHeader === 'string' && fromHeader.trim().length > 0) return fromHeader
  const flat: unknown = (session as { cwd?: unknown }).cwd
  return typeof flat === 'string' && flat.trim().length > 0 ? flat : undefined
}

/** 可选能力：把 cwd 提升为 WorkspaceId（duck-typed，缺失即回落）。 */
async function lookupWorkspaceId(ctx: unknown, cwd: string): Promise<string | undefined> {
  const registry: unknown = (ctx as { workspaceRegistry?: unknown } | null)?.workspaceRegistry
  if (typeof registry !== 'object' || registry === null) return undefined
  const resolveByPath: unknown = (registry as { resolveByPath?: unknown }).resolveByPath
  if (typeof resolveByPath !== 'function') return undefined
  try {
    // `WorkspaceRegistry.resolveByPath()` 是异步的，返回 `Promise<Workspace | undefined>`。
    const found: unknown = await (resolveByPath as (path: string) => Promise<unknown>).call(registry, cwd)
    if (typeof found === 'string') return found.length > 0 ? found : undefined
    if (typeof found === 'object' && found !== null) {
      const record = found as { id?: unknown; workspaceId?: unknown }
      const id = record.id ?? record.workspaceId
      if (typeof id === 'string' && id.length > 0) return id
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * 从一次工具执行解析 scope。
 *
 * 拿不到会话 cwd 时 fail-loud（抛 `ScopeError`）：宁可让这次调用失败，也不能静默用
 * `process.cwd()` 顶替 —— 后者是 dsh 进程的启动目录，数据集会登记到错误的工作区
 * （换回正确 cwd 后 `dataset_list` 就看不见它们）。
 * `perWorkspace` 且拿不到 WorkspaceId 时仍用 cwd。
 */
export async function resolveScope(
  ctx: unknown,
  cfg: { perWorkspace: boolean },
  exec: ToolExec,
): Promise<ScopeContext> {
  const raw = sessionCwdOf(exec)
  if (raw === undefined) {
    throw new ScopeError('无法解析工作区目录：exec.agent.session.header.cwd 缺失（本次调用没有 agent 会话？）')
  }
  const cwd = canonicalDirectory(raw)
  if (!cfg.perWorkspace) return { scopeKey: cwd, cwd }
  const workspaceId = await lookupWorkspaceId(ctx, cwd)
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
  // 两侧都取文件系统身份，保证与 canonical 化的 scope 目录可比。
  const base = canonicalDirectory(cwd)
  const target = canonicalDirectory(isAbsolute(raw) ? raw : resolve(base, raw))
  if (!isInside(base, target)) throw new ScopeError(`文件必须在工作区目录内：${raw}`)
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
