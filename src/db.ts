/**
 * libSQL 客户端与生命周期。
 *
 * 移植自 `agentic-data-mini` 的 `src/lib/primitives/db.ts`，保留其关键行为：
 * URL 优先级、裸路径补 `file:`、启动 PRAGMA（WAL + 外键）、日志不打印 authToken。
 * 插件侧新增：按 scope 解析库文件（`perWorkspace`）+ `closeAllDatabases()` 供
 * `ctx.effect()` 在 HMR / 卸载时确定性释放（设计文档 §8）。
 */

import { createClient, type Client, type ResultSet } from '@libsql/client'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 无损 JSON 值（与 dsh 的 `snapshotJsonValue` 边界一致）。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** 一行查询结果：键为列名，值保证是无损 JSON。 */
export type Row = { [key: string]: JsonValue }

export interface RunResult {
  changes: number
  lastInsertRowid: number
}

export interface PreparedStatement {
  all(...params: unknown[]): Promise<Row[]>
  get(...params: unknown[]): Promise<Row | undefined>
  run(...params: unknown[]): Promise<RunResult>
}

/** 本模块需要的配置子集（由 `store.ts` 的 DataConfig 提供）。 */
export interface DbConfig {
  dbPath: string
  dbUrl: string
  authToken: string
  perWorkspace: boolean
}

type ExecuteInput = Parameters<Client['execute']>[0]

const PRAGMAS = ['PRAGMA journal_mode = WAL', 'PRAGMA foreign_keys = ON']

/** 近似 bun:sqlite 的兼容层：封装 @libsql/client。 */
export class Database {
  private initPromise: Promise<void> | null = null

  constructor(
    private readonly client: Client,
    readonly url: string,
    readonly remote: boolean,
  ) {}

  prepare(sql: string): PreparedStatement {
    return {
      all: async (...params: unknown[]) => (await this.run(sql, params, result => result.rows)).map(toJsonRow),
      get: async (...params: unknown[]) => {
        const row = await this.run(sql, params, result => result.rows[0] as Row | undefined)
        return row === undefined ? undefined : toJsonRow(row)
      },
      run: (...params: unknown[]) => this.run(sql, params, result => ({
        changes: Number(result.rowsAffected ?? 0),
        lastInsertRowid: result.lastInsertRowid != null ? Number(result.lastInsertRowid) : 0,
      })),
    }
  }

  /** 执行多条语句（建表 / 建索引）。 */
  async exec(sql: string): Promise<void> {
    await this.ensureInit()
    await this.client.executeMultiple(sql)
  }

  close(): void {
    this.client.close()
  }

  private async run<T>(sql: string, params: unknown[], map: (result: ResultSet) => T): Promise<T> {
    await this.ensureInit()
    const args = params.map(toSqlArg)
    const result = await this.client.execute({ sql, args } as unknown as ExecuteInput)
    return map(result)
  }

  /** PRAGMA 只做一次；远程库不支持时忽略。 */
  private ensureInit(): Promise<void> {
    if (this.initPromise === null) {
      this.initPromise = (async () => {
        for (const pragma of PRAGMAS) {
          try {
            await this.client.execute(pragma)
          } catch {
            // 远程 libsql:// 不支持本地 PRAGMA，忽略即可。
          }
        }
      })().catch((error: unknown) => {
        this.initPromise = null
        throw error
      })
    }
    return this.initPromise
  }
}

// ── 返回值规整（无损 JSON 边界） ─────────────────────────────────────────

/** 嵌套上限：防御性兜底（数据库返回值不会真的这么深）。 */
const MAX_JSON_DEPTH = 32

/**
 * 把 libSQL 的返回值规整成无损 JSON。
 *
 * libSQL 的行对象同时挂着具名列与**不可枚举**的数字索引 `0..n` 和 `length`
 * （行既能按名也能按位置访问）。dsh 的 `snapshotJsonValue` 把「存在不可枚举的
 * 自有属性」判为有损 —— 工具返回值会被直接拒为 `INVALID_TOOL_OUTPUT`
 * （`value is not lossless JSON`）。这里统一重建为只含可枚举字符串键的纯对象；
 * 顺带把 JSON 无法无损表达的值转成 JSON 安全形式：
 * BigInt（超安全整数范围转字符串）、BLOB（base64）、NaN / ±Infinity（null）、
 * `-0`（0）、Date（ISO 字符串）、function / symbol（null）。
 */
export function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (value === null || value === undefined) return null
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return value as JsonValue
  if (kind === 'number') {
    const number = value as number
    if (!Number.isFinite(number)) return null
    return Object.is(number, -0) ? 0 : number
  }
  if (kind === 'bigint') {
    const big = value as bigint
    const min = BigInt(Number.MIN_SAFE_INTEGER)
    const max = BigInt(Number.MAX_SAFE_INTEGER)
    return big >= min && big <= max ? Number(big) : big.toString()
  }
  if (depth > MAX_JSON_DEPTH) return null
  if (kind !== 'object') return null
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value).toString('base64')
  }
  if (Array.isArray(value)) return value.map(entry => toJsonValue(entry, depth + 1))
  const record = value as Record<string, unknown>
  const out: { [key: string]: JsonValue } = {}
  // 只遍历可枚举的字符串键：libSQL 的不可枚举数字索引与 length 会被自然丢弃。
  for (const key of Object.keys(record)) out[key] = toJsonValue(record[key], depth + 1)
  return out
}

/** 一行 → 只含可枚举字符串键的纯对象。 */
export function toJsonRow(row: unknown): Row {
  const value = toJsonValue(row)
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Row
    : {}
}

/** libSQL 只能绑定 number/string/bigint/Buffer/Date/null，其余序列化为 JSON。 */
function toSqlArg(value: unknown): unknown {
  if (value === undefined || value === null) return null
  const kind = typeof value
  if (kind === 'string' || kind === 'number' || kind === 'bigint') return value
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Date) return value
  if (kind === 'boolean') return value ? 1 : 0
  return JSON.stringify(value)
}

// ── 连接解析 ──────────────────────────────────────────────────────────────

/** 稳定短哈希：物理表名前缀与 perWorkspace 库文件后缀都用它。 */
export function shortHash(input: string, length = 8): string {
  return createHash('sha1').update(input).digest('hex').slice(0, length)
}

/** 仅用于兜底消毒的标识符（保留中文）：移植自参考实现的 `sanitizeId`。 */
export function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_')
}

function isRemoteUrl(url: string): boolean {
  return /^(libsql:|https?:\/\/)/i.test(url)
}

function normalizeDbUrl(url: string): string {
  return /^(file:|libsql:|https?:\/\/)/i.test(url) ? url : `file:${toPosix(url)}`
}

function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

/** `file:` 库的本地路径（不猜测 `file://` 的主机/路径语义）。 */
function localPathOf(url: string): string | undefined {
  if (!url.startsWith('file:')) return undefined
  const rest = url.slice('file:'.length)
  return rest.startsWith('//') ? undefined : rest
}

function withScopeSuffix(url: string, hash: string): string {
  return url.endsWith('.db') ? `${url.slice(0, -'.db'.length)}-${hash}.db` : `${url}-${hash}.db`
}

/** 默认库目录：`$DSH_HOME/lh-data`。 */
export function defaultDbDirectory(): string {
  const configured = process.env.DSH_HOME?.trim()
  const home = configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.dsh')
  return join(home, 'lh-data')
}

/**
 * 连接优先级：`dbUrl` > `dbPath` > `SQLITE_PATH` > `TURSO_DATABASE_URL` > 默认本地文件。
 * `perWorkspace` 且是本地库时，为每个 scope 派生独立库文件。
 */
export function resolveDbUrl(cfg: DbConfig, scopeKey: string): string {
  const explicit = cfg.dbUrl.trim() || cfg.dbPath.trim()
  const fromEnv = process.env.SQLITE_PATH || process.env.TURSO_DATABASE_URL || ''
  const raw = explicit || fromEnv
  const url = raw.length > 0 ? normalizeDbUrl(raw) : `file:${toPosix(join(defaultDbDirectory(), 'data.db'))}`
  if (isRemoteUrl(url)) return url
  return cfg.perWorkspace ? withScopeSuffix(url, shortHash(scopeKey)) : url
}

function resolveAuthToken(cfg: DbConfig): string | undefined {
  return cfg.authToken.trim() || process.env.TURSO_AUTH_TOKEN || undefined
}

const databases = new Map<string, Database>()

/** 惰性建立连接（不在 apply() 里同步建立），按 url 缓存单例。 */
export function resolveDatabase(cfg: DbConfig, scopeKey: string): Database {
  const url = resolveDbUrl(cfg, scopeKey)
  const existing = databases.get(url)
  if (existing !== undefined) return existing
  const localPath = localPathOf(url)
  if (localPath !== undefined && localPath.length > 0) mkdirSync(dirname(localPath), { recursive: true })
  const client = createClient({ url, authToken: resolveAuthToken(cfg) })
  const database = new Database(client, url, isRemoteUrl(url))
  databases.set(url, database)
  return database
}

/** 关闭全部连接：`ctx.effect()` 的 disposer 调用它。 */
export function closeAllDatabases(): void {
  for (const database of databases.values()) {
    try {
      database.close()
    } catch {
      // 关闭失败不应阻塞卸载流程。
    }
  }
  databases.clear()
}
