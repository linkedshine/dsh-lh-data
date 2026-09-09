/**
 * `lh_data_sources` 的 DDL 与行映射。
 *
 * 数据源是**全局**的（catalog 库，跨工作区共享），与 `dataset_scopes` 同库。
 * DDL 与行映射单独放这里，`source-store.ts` 只留 CRUD，避免类膨胀。
 */

import type { Row } from '../db'
import type { DataSourceRecord, DataSourceStatus, DataSourceType } from './types'

export const SOURCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lh_data_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  database_name TEXT NOT NULL,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  ssl_mode TEXT,
  pool_max INTEGER,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_error TEXT,
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lh_data_sources_name ON lh_data_sources(name);
`

export function makeSourceId(): string {
  return `dsrc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

export function rowToSource(row: Row): DataSourceRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    type: String(row.type ?? 'mysql') as DataSourceType,
    host: String(row.host ?? ''),
    port: Number(row.port ?? 0),
    database: String(row.database_name ?? ''),
    username: String(row.username ?? ''),
    passwordEnc: String(row.password_enc ?? ''),
    sslMode: nullableString(row.ssl_mode),
    poolMax: nullableNumber(row.pool_max),
    description: nullableString(row.description),
    status: String(row.status ?? 'unknown') as DataSourceStatus,
    lastError: nullableString(row.last_error),
    lastCheckedAt: nullableNumber(row.last_checked_at),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  }
}
