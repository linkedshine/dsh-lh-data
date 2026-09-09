/**
 * 数据源的持久化：catalog 库 `lh_data_sources` 的 CRUD。
 *
 * 密码在这一层加密落库；改 / 删数据源会顺带关掉对应的连接池，避免缓存里残留
 * 旧凭据。`list()` / `find()` 返回的是含密文的完整记录——**绝不能直接序列化
 * 给前端或模型**，边界处必须过 `toView()` / 工具侧的脱敏。
 */

import { resolveCatalogDatabase, type Database, type DbConfig } from '../db'
import { closeConnector } from './connection'
import { encryptPassword, resolveEncryptKey } from './crypto'
import { DataSourceError } from './errors'
import { makeSourceId, rowToSource, SOURCE_SCHEMA_SQL } from './source-sql'
import type { DataSourceConfig, DataSourceInput, DataSourcePatch, DataSourceRecord } from './types'

export class DataSourceStore {
  private initialized = false

  constructor(private readonly cfg: DataSourceConfig & DbConfig) {}

  private async db(): Promise<Database> {
    const database = resolveCatalogDatabase(this.cfg)
    if (!this.initialized) {
      await database.exec(SOURCE_SCHEMA_SQL)
      this.initialized = true
    }
    return database
  }

  async list(): Promise<DataSourceRecord[]> {
    const rows = await (await this.db()).prepare('SELECT * FROM lh_data_sources ORDER BY name ASC').all()
    return rows.map(rowToSource)
  }

  /** 按 id 或登记名查找；找不到返回 undefined（不抛错）。 */
  async find(reference: string): Promise<DataSourceRecord | undefined> {
    const key = reference.trim()
    if (key.length === 0) return undefined
    const row = await (await this.db())
      .prepare('SELECT * FROM lh_data_sources WHERE id = ? OR name = ? LIMIT 1')
      .get(key, key)
    return row === undefined ? undefined : rowToSource(row)
  }

  async require(reference: string): Promise<DataSourceRecord> {
    const record = await this.find(reference)
    if (record === undefined) {
      throw new DataSourceError('NOT_FOUND', `未找到数据源：${reference}（先用 datasource_list 查看可用数据源）`)
    }
    return record
  }

  /** 全局唯一的名字：已存在则追加 `_2` / `_3`。 */
  async uniqueName(name: string): Promise<string> {
    const base = name.trim().length > 0 ? name.trim() : 'source'
    const taken = new Set((await this.list()).map(record => record.name))
    if (!taken.has(base)) return base
    for (let index = 2; index < 1000; index += 1) {
      if (!taken.has(`${base}_${index}`)) return `${base}_${index}`
    }
    throw new DataSourceError('BAD_REQUEST', `无法为数据源生成唯一名称：${base}`)
  }

  async create(input: DataSourceInput): Promise<DataSourceRecord> {
    const key = resolveEncryptKey(this.cfg.datasourceEncryptKey)
    const now = Date.now()
    const record: DataSourceRecord = {
      id: makeSourceId(),
      name: await this.uniqueName(input.name),
      type: input.type,
      host: input.host,
      port: input.port,
      database: input.database,
      username: input.username,
      passwordEnc: encryptPassword(input.password, key),
      sslMode: input.sslMode ?? null,
      poolMax: input.poolMax ?? null,
      description: input.description ?? null,
      status: 'unknown',
      lastError: null,
      lastCheckedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.insert(record)
    return record
  }

  async update(id: string, patch: DataSourcePatch): Promise<DataSourceRecord> {
    const current = await this.require(id)
    const assignments: string[] = ['updated_at = ?']
    const params: unknown[] = [Date.now()]
    const assign = (column: string, value: unknown): void => {
      assignments.push(`${column} = ?`)
      params.push(value)
    }
    if (patch.name !== undefined) assign('name', patch.name)
    if (patch.type !== undefined) assign('type', patch.type)
    if (patch.host !== undefined) assign('host', patch.host)
    if (patch.port !== undefined) assign('port', patch.port)
    if (patch.database !== undefined) assign('database_name', patch.database)
    if (patch.username !== undefined) assign('username', patch.username)
    if (typeof patch.password === 'string') {
      assign('password_enc', encryptPassword(patch.password, resolveEncryptKey(this.cfg.datasourceEncryptKey)))
    }
    if (patch.sslMode !== undefined) assign('ssl_mode', patch.sslMode)
    if (patch.poolMax !== undefined) assign('pool_max', patch.poolMax)
    if (patch.description !== undefined) assign('description', patch.description)
    if (patch.status !== undefined) assign('status', patch.status)
    if (patch.lastError !== undefined) assign('last_error', patch.lastError)
    if (patch.lastCheckedAt !== undefined) assign('last_checked_at', patch.lastCheckedAt)
    params.push(current.id)
    await (await this.db()).prepare(`UPDATE lh_data_sources SET ${assignments.join(', ')} WHERE id = ?`).run(...params)
    // 连接参数可能已变，缓存里的旧连接池必须作废。
    await closeConnector(current.id)
    return await this.require(current.id)
  }

  /** 记录一次连通性检测的结果。 */
  async recordCheck(id: string, success: boolean, error: string | null): Promise<void> {
    await this.update(id, {
      status: success ? 'connected' : 'error',
      lastError: success ? null : error,
      lastCheckedAt: Date.now(),
    })
  }

  async remove(id: string): Promise<void> {
    const current = await this.require(id)
    await closeConnector(current.id)
    await (await this.db()).prepare('DELETE FROM lh_data_sources WHERE id = ?').run(current.id)
  }

  private async insert(record: DataSourceRecord): Promise<void> {
    await (await this.db())
      .prepare(
        `INSERT INTO lh_data_sources
         (id, name, type, host, port, database_name, username, password_enc, ssl_mode, pool_max,
          description, status, last_error, last_checked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id, record.name, record.type, record.host, record.port, record.database, record.username,
        record.passwordEnc, record.sslMode, record.poolMax, record.description, record.status,
        record.lastError, record.lastCheckedAt, record.createdAt, record.updatedAt,
      )
  }
}

export function createSourceStore(cfg: DataSourceConfig & DbConfig): DataSourceStore {
  return new DataSourceStore(cfg)
}
