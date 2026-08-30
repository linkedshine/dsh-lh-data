/**
 * 数据集元数据（替代参考实现的 drizzle `dataset_metadata`）+ 归属断言。
 *
 * 设计文档 §5.3：`datasets` 表是插件自有的元数据表，物理表名只在本模块生成与持有，
 * 对外只暴露 `datasetId` / 登记名。所有读写都带 `scope_key` 过滤（`assertOwned`）。
 */

import { resolveDatabase, shortHash, type Database, type Row } from './db'
import type { ColumnInfo } from './parse'
import type { ScopeContext } from './scope'
import type { ToolExec } from './tooling'

/** 插件配置（结构子集由 index.ts 的 `Config` 复用，避免 tools → index 的类型循环）。 */
export interface DataConfig {
  /** libSQL 库路径；空 → `$DSH_HOME/lh-data/data.db`。 */
  dbPath: string
  /** 非空则覆盖 dbPath，可为 `file:` 或 `libsql://`。 */
  dbUrl: string
  /** 远程 Turso token；建议留空并走 `TURSO_AUTH_TOKEN`。 */
  authToken: string
  /** true 时 scope 用 WorkspaceId 且每个工作区独立库文件。 */
  perWorkspace: boolean
  requireApprovalForWrites: boolean
  allowRawSql: boolean
  maxFileBytes: number
  maxInsertRows: number
  maxQueryRows: number
  batchSize: number
  backgroundThresholdRows: number
  previewSampleRows: number
  readOnly: boolean
}

export type DatasetStatus = 'importing' | 'ready' | 'failed'

export interface DatasetRecord {
  id: string
  scopeKey: string
  name: string
  tableName: string
  sourcePath: string | null
  rowCount: number
  columns: ColumnInfo[]
  status: DatasetStatus
  error: string | null
  createdAt: number
  updatedAt: number
}

export class DatasetError extends Error {
  readonly code = 'DATASET_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'DatasetError'
  }
}

/** 物理表名形状：`d_<scopeHash8>_<base40>_<ts36>`。 */
export const PHYSICAL_TABLE_PATTERN: RegExp = /^d_[a-z0-9]{8}_[a-z0-9_]{1,40}_[a-z0-9]+$/

export function assertPhysicalTableName(tableName: string): void {
  if (!PHYSICAL_TABLE_PATTERN.test(tableName)) {
    throw new DatasetError(`非法的数据表标识：${tableName}（拒绝拼进 SQL）`)
  }
}

/** 物理表名生成：只由插件调用，去掉参考实现的 userId，改用 scope 哈希。 */
export function generateTableName(base: string, scopeHash: string): string {
  const normalized = base
    .replace(/\.(csv|xlsx|xls)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return `d_${scopeHash.slice(0, 8)}_${normalized.length > 0 ? normalized : 'table'}_${Date.now().toString(36)}`
}

export function makeDatasetId(): string {
  return `ds_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  name TEXT NOT NULL,
  table_name TEXT NOT NULL UNIQUE,
  source_path TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  columns TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'importing',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_datasets_scope_name ON datasets(scope_key, name);
CREATE INDEX IF NOT EXISTS idx_datasets_scope_created ON datasets(scope_key, created_at DESC);
`

function rowToRecord(row: Row): DatasetRecord {
  let columns: ColumnInfo[] = []
  try {
    const parsed: unknown = JSON.parse(String(row.columns ?? '[]'))
    if (Array.isArray(parsed)) columns = parsed as ColumnInfo[]
  } catch {
    columns = []
  }
  return {
    id: String(row.id),
    scopeKey: String(row.scope_key),
    name: String(row.name),
    tableName: String(row.table_name),
    sourcePath: row.source_path === null || row.source_path === undefined ? null : String(row.source_path),
    rowCount: Number(row.row_count ?? 0),
    columns,
    status: String(row.status ?? 'ready') as DatasetStatus,
    error: row.error === null || row.error === undefined ? null : String(row.error),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  }
}

export class DatasetStore {
  private readonly initialized = new Set<string>()

  constructor(private readonly cfg: DataConfig) {}

  /** 该 scope 对应的库连接（幂等建表）。 */
  async database(scopeKey: string): Promise<Database> {
    const db = resolveDatabase(this.cfg, scopeKey)
    if (!this.initialized.has(scopeKey)) {
      await db.exec(SCHEMA_SQL)
      this.initialized.add(scopeKey)
    }
    return db
  }

  async list(scopeKey: string): Promise<DatasetRecord[]> {
    const db = await this.database(scopeKey)
    const rows = await db
      .prepare('SELECT * FROM datasets WHERE scope_key = ? ORDER BY created_at DESC, name ASC')
      .all(scopeKey)
    return rows.map(rowToRecord)
  }

  /** 按 datasetId 或登记名查找；找不到返回 undefined（不抛错）。 */
  async find(scopeKey: string, reference: string): Promise<DatasetRecord | undefined> {
    const db = await this.database(scopeKey)
    const key = typeof reference === 'string' ? reference.trim() : ''
    if (key.length === 0) return undefined
    const row = await db
      .prepare('SELECT * FROM datasets WHERE scope_key = ? AND (id = ? OR name = ?) LIMIT 1')
      .get(scopeKey, key, key)
    return row === undefined ? undefined : rowToRecord(row)
  }

  /** 当前 scope 已登记的物理表名集合（dataset_query 的 sql 白名单）。 */
  async tableNames(scopeKey: string): Promise<string[]> {
    return (await this.list(scopeKey)).map(record => record.tableName)
  }

  /** 解析句柄 + 归属断言（defense-in-depth）。 */
  async require(scopeKey: string, reference: string, options: { requireReady?: boolean } = {}): Promise<DatasetRecord> {
    const record = await this.find(scopeKey, reference)
    if (record === undefined) {
      throw new DatasetError(`未找到数据集：${reference}（先用 dataset_list 查看当前工作区可用的数据集）`)
    }
    if (record.scopeKey !== scopeKey) throw new DatasetError(`数据集 "${record.name}" 不属于当前工作区`)
    assertPhysicalTableName(record.tableName)
    if (options.requireReady === true && record.status !== 'ready') {
      throw new DatasetError(`数据集 "${record.name}" 当前状态为 ${record.status}${record.error === null ? '' : `：${record.error}`}`)
    }
    return record
  }

  /** scope 内唯一的名字：已存在则追加 `_2` / `_3`。 */
  async uniqueName(scopeKey: string, name: string): Promise<string> {
    const base = name.trim().length > 0 ? name.trim() : 'dataset'
    const taken = new Set((await this.list(scopeKey)).map(record => record.name))
    if (!taken.has(base)) return base
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base}_${index}`
      if (!taken.has(candidate)) return candidate
    }
    throw new DatasetError(`无法为数据集生成唯一名称：${base}`)
  }

  async create(record: DatasetRecord): Promise<void> {
    const db = await this.database(record.scopeKey)
    assertPhysicalTableName(record.tableName)
    await db
      .prepare(
        `INSERT INTO datasets (id, scope_key, name, table_name, source_path, row_count, columns, status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.scopeKey,
        record.name,
        record.tableName,
        record.sourcePath,
        record.rowCount,
        JSON.stringify(record.columns),
        record.status,
        record.error,
        record.createdAt,
        record.updatedAt,
      )
  }

  async update(scopeKey: string, id: string, patch: Partial<Pick<DatasetRecord,
    'name' | 'rowCount' | 'columns' | 'status' | 'error' | 'sourcePath'>>): Promise<void> {
    const db = await this.database(scopeKey)
    const assignments: string[] = ['updated_at = ?']
    const params: unknown[] = [Date.now()]
    if (patch.name !== undefined) {
      assignments.push('name = ?')
      params.push(patch.name)
    }
    if (patch.rowCount !== undefined) {
      assignments.push('row_count = ?')
      params.push(patch.rowCount)
    }
    if (patch.columns !== undefined) {
      assignments.push('columns = ?')
      params.push(JSON.stringify(patch.columns))
    }
    if (patch.status !== undefined) {
      assignments.push('status = ?')
      params.push(patch.status)
    }
    if (patch.error !== undefined) {
      assignments.push('error = ?')
      params.push(patch.error)
    }
    if (patch.sourcePath !== undefined) {
      assignments.push('source_path = ?')
      params.push(patch.sourcePath)
    }
    params.push(id, scopeKey)
    await db.prepare(`UPDATE datasets SET ${assignments.join(', ')} WHERE id = ? AND scope_key = ?`).run(...params)
  }

  async remove(scopeKey: string, id: string): Promise<void> {
    const db = await this.database(scopeKey)
    await db.prepare('DELETE FROM datasets WHERE id = ? AND scope_key = ?').run(id, scopeKey)
  }
}

export function createStore(cfg: DataConfig): DatasetStore {
  return new DatasetStore(cfg)
}

/** 后台任务注册表的最小视图（`ctx.jobs` 可选依赖）。 */
export interface JobRegistryLike {
  start(spec: {
    kind: string
    label: string
    owner?: unknown
    run(): { cancel(reason?: string): void; done: Promise<unknown> }
  }): string
}

/** 注入给工具的运行时依赖。 */
export interface DataServices {
  cfg: DataConfig
  store: DatasetStore
  /** 解析一次调用的工作区；拿不到会话 cwd 时会 reject（`ScopeError`）。 */
  scopeOf(exec: ToolExec): Promise<ScopeContext>
  /** 可选：`ctx.jobs` 不可用时后台导入降级为前台执行。 */
  jobs?: JobRegistryLike
}

export interface ResolvedDataset {
  scope: ScopeContext
  record: DatasetRecord
  db: Database
}

/** 工具的统一入口：解析 scope → 断言归属 → 拿到库连接。 */
export async function resolveDataset(
  services: DataServices,
  exec: ToolExec,
  reference: string,
  options: { requireReady?: boolean } = {},
): Promise<ResolvedDataset> {
  const scope = await services.scopeOf(exec)
  const record = await services.store.require(scope.scopeKey, reference, options)
  const db = await services.store.database(scope.scopeKey)
  return { scope, record, db }
}
