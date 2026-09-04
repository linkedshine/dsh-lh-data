/**
 * 工作区（scope）注册表 —— 设置页「聚合展示全部工作区」的枚举来源。
 *
 * 为什么需要这张表：`perWorkspace=false`（默认）时所有 scope 共用一个库文件，
 * `SELECT DISTINCT scope_key FROM datasets` 就能枚举；但 `perWorkspace=true`
 * 时每个 scope 是独立的 `<hash>.db`，库文件名是 scope 的单向哈希，
 * **没有任何办法反查「这台机器上有哪些工作区」**。
 *
 * 因此把见过的 scope 记在**目录库**里：一个不做 scope 分片的固定库
 * （`perWorkspace=false` 时与业务库是同一个文件，不额外占地方）。
 *
 * 与 `DatasetStore` 分开，是为了让 store 保持单一职责（数据集元数据）并守住
 * 200 行的类体积上限。
 */

import { resolveCatalogDatabase, type Database, type DbConfig } from './db'

const CATALOG_SQL = `
CREATE TABLE IF NOT EXISTS dataset_scopes (
  scope_key TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
`

/** 把已登记数据集的 scope 补进注册表（升级前遗留的数据靠它进来）。 */
const BACKFILL_SQL = `
INSERT OR IGNORE INTO dataset_scopes (scope_key, first_seen, last_seen)
SELECT DISTINCT scope_key, ?, ? FROM datasets
`

export interface ScopeEntry {
  /** 规范化后的工作区目录（默认模式）或 `ws:<id>`（perWorkspace 模式）。 */
  scopeKey: string
  firstSeen: number
  lastSeen: number
}

export class ScopeRegistry {
  private ready = false

  constructor(private readonly cfg: DbConfig) {}

  /**
   * 记录一次 scope 使用：新建数据集时调用，已存在则刷新 `last_seen`。
   * 目录库要么与业务库同一个连接，要么是同目录下的兄弟文件，
   * 因此这里的失败一律向上抛 —— 静默吞掉会让工作区从设置页里凭空消失。
   */
  async record(scopeKey: string): Promise<void> {
    const db = await this.catalog()
    const now = Date.now()
    await db
      .prepare(
        `INSERT INTO dataset_scopes (scope_key, first_seen, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .run(scopeKey, now, now)
  }

  /** 全部已知工作区，按最近使用倒序。 */
  async list(): Promise<ScopeEntry[]> {
    const db = await this.catalog()
    const rows = await db
      .prepare('SELECT scope_key, first_seen, last_seen FROM dataset_scopes ORDER BY last_seen DESC')
      .all()
    return rows.map(row => ({
      scopeKey: String(row.scope_key),
      firstSeen: Number(row.first_seen ?? 0),
      lastSeen: Number(row.last_seen ?? 0),
    }))
  }

  /**
   * 该 scope 是否已知。写操作的准入校验：设置页的请求带不到会话上下文，
   * 若放行任意字符串，浏览器就能凭空造工作区、造库文件。
   */
  async has(scopeKey: string): Promise<boolean> {
    const db = await this.catalog()
    const row = await db
      .prepare('SELECT 1 AS ok FROM dataset_scopes WHERE scope_key = ? LIMIT 1')
      .get(scopeKey)
    return row !== undefined
  }

  /** 目录库连接：幂等建表，且只回填一次。 */
  private async catalog(): Promise<Database> {
    const db = resolveCatalogDatabase(this.cfg)
    if (this.ready) return db
    await db.exec(CATALOG_SQL)
    await this.backfill(db)
    this.ready = true
    return db
  }

  /**
   * 回填：`perWorkspace=true` 时目录库里没有 `datasets` 表，语句会失败 ——
   * 那是预期情况，此时注册表本就只靠 `record()` 累积，静默跳过即可。
   */
  private async backfill(db: Database): Promise<void> {
    const now = Date.now()
    try {
      await db.prepare(BACKFILL_SQL).run(now, now)
    } catch {
      // 目录库里没有 datasets 表：perWorkspace 模式下正常。
    }
  }
}

export function createScopeRegistry(cfg: DbConfig): ScopeRegistry {
  return new ScopeRegistry(cfg)
}
