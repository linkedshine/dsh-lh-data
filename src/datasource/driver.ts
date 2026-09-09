/**
 * 数据库驱动的运行时加载。
 *
 * `mysql2` / `pg` 已随插件默认安装（`dependencies`），但仍走**动态 import**：
 * 用到哪个才加载哪个，CLI 剖面与只用文件导入的用户不会被这两个包拖慢启动。
 * 万一运行环境里缺包（裁剪安装、pnpm 过滤等），抛 `DataSourceError('DRIVER_MISSING')`
 * 并在消息里带上安装命令，而不是崩在裸栈上。
 *
 * 导入说明符必须走变量，不能用字面量——字面量会让 TypeScript 与打包器在解析期
 * 就去解析这两个包，缺包时 typecheck / build 直接失败。
 */

import { DataSourceError } from './errors'
import type { DataSourceType } from './types'

export const DRIVER_INSTALL_HINTS: Readonly<Record<DataSourceType, string>> = {
  mysql: 'pnpm add mysql2',
  postgresql: 'pnpm add pg',
}

const DRIVER_SPECS: Readonly<Record<DataSourceType, string>> = {
  mysql: 'mysql2/promise',
  postgresql: 'pg',
}

// ── 驱动的最小结构（只声明本模块用到的成员，不引第三方 .d.ts） ──────────────

interface MysqlLike {
  createPool(options: Record<string, unknown>): MysqlPoolLike
  createConnection(options: Record<string, unknown>): Promise<MysqlConnLike>
}

export interface MysqlPoolLike {
  execute(sql: string, params?: unknown[]): Promise<[unknown[], unknown]>
  end(): Promise<void>
}

interface MysqlConnLike {
  execute(sql: string, params?: unknown[]): Promise<[unknown[], unknown]>
  end(): Promise<void>
}

interface PgLike {
  Pool: new (options: Record<string, unknown>) => PgPoolLike
}

export interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>
  end(): Promise<void>
}

// ── 加载 ─────────────────────────────────────────────────────────────────────

const cache = new Map<DataSourceType, unknown>()

const MODULE_MISSING_CODES: readonly string[] = [
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
]

function isModuleMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && MODULE_MISSING_CODES.includes(code)
}

/** CJS 互操作：`await import('pg')` 拿到的是带 `default` 的命名空间。 */
function unwrapDefault(loaded: unknown): Record<string, unknown> {
  if (typeof loaded === 'object' && loaded !== null && 'default' in loaded) {
    const fallback = (loaded as { default?: unknown }).default
    if (typeof fallback === 'object' && fallback !== null) return fallback as Record<string, unknown>
  }
  return (loaded ?? {}) as Record<string, unknown>
}

async function load(type: DataSourceType): Promise<Record<string, unknown>> {
  const cached = cache.get(type)
  if (cached !== undefined) return cached as Record<string, unknown>
  const spec = DRIVER_SPECS[type]
  let loaded: unknown
  try {
    loaded = await import(spec)
  } catch (error) {
    if (isModuleMissing(error)) {
      throw new DataSourceError(
        'DRIVER_MISSING',
        `未安装 ${type === 'mysql' ? 'MySQL' : 'PostgreSQL'} 驱动，请执行：${DRIVER_INSTALL_HINTS[type]}`,
      )
    }
    throw error
  }
  const mod = unwrapDefault(loaded)
  cache.set(type, mod)
  return mod
}

/** 仅供测试：清掉模块级缓存。 */
export function resetDriverCache(): void {
  cache.clear()
}

export async function loadMysqlDriver(): Promise<MysqlLike> {
  return (await load('mysql')) as unknown as MysqlLike
}

export async function loadPgDriver(): Promise<PgLike> {
  return (await load('postgresql')) as unknown as PgLike
}
