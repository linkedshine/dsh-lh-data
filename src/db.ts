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

export type Row = Record<string, unknown>

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
      all: (...params: unknown[]) => this.run(sql, params, result => result.rows as Row[]),
      get: (...params: unknown[]) => this.run(sql, params, result => (result.rows[0] as Row | undefined) ?? undefined),
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
