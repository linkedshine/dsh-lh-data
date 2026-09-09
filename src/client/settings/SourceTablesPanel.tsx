/**
 * 远端表浏览与导入：选 schema（PostgreSQL）→ 过滤 / 点选一张表 → 选目标工作区并导入。
 *
 * 只读浏览（GET /sources/:id/tables），导入是写操作（POST /sources/:id/import）。
 * 导入完成后产出的是普通数据集，之后一律回到「数据集」页签用既有能力操作。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  ADMIN_COLUMN_TYPE_LABELS,
  type DataSourceView,
  type ImportSourceTableResult,
  type ScopeView,
  type SourceTableView,
} from '../../admin-contract'
import { importSourceTable, listSourceTables } from './api'
import { c, s } from './styles'

export interface SourceTablesPanelProps {
  source: DataSourceView
  scopes: ScopeView[]
  onError: (error: Error) => void
}

function formatRows(count: number): string {
  if (count < 0) return '未知'
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

export function SourceTablesPanel(props: SourceTablesPanelProps): ReactElement {
  const { source, scopes, onError } = props
  const [schemas, setSchemas] = useState<string[]>([])
  const [schema, setSchema] = useState('')
  const [keyword, setKeyword] = useState('')
  const [tables, setTables] = useState<SourceTableView[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [scopeKey, setScopeKey] = useState('')
  const [name, setName] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportSourceTableResult | null>(null)
  const requestId = useRef(0)

  const load = useCallback(async (schemaArg: string, q: string): Promise<void> => {
    const id = requestId.current + 1
    requestId.current = id
    setLoading(true)
    try {
      const loaded = await listSourceTables(source.id, schemaArg, q)
      if (id !== requestId.current) return
      setSchemas(loaded.schemas)
      setTables(loaded.tables)
      setSelected(null)
    } catch (failure) {
      if (id !== requestId.current) return
      onError(failure instanceof Error ? failure : new Error('加载远端表失败'))
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [source.id, onError])

  // 切换数据源或 schema 立即重载；关键字走 300ms 防抖。
  useEffect(() => {
    const timer = setTimeout(() => void load(schema, keyword), keyword.trim().length > 0 ? 300 : 0)
    return () => clearTimeout(timer)
  }, [load, schema, keyword])

  useEffect(() => {
    if (scopeKey.length === 0 && scopes.length > 0) setScopeKey(scopes[0].scopeKey)
  }, [scopes, scopeKey])

  const current = tables.find(table => table.tableName === selected) ?? null

  async function handleImport(): Promise<void> {
    if (selected === null || scopeKey.length === 0 || importing) return
    setImporting(true)
    setResult(null)
    try {
      const imported = await importSourceTable(source.id, {
        scopeKey,
        tableName: selected,
        schemaName: schema.trim().length > 0 ? schema.trim() : null,
        name: name.trim().length > 0 ? name.trim() : null,
      })
      setResult(imported)
    } catch (failure) {
      onError(failure instanceof Error ? failure : new Error('导入失败'))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div style={{ ...s.panel, background: 'transparent', borderTop: `1px solid ${c.border}`, borderRadius: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>远端表</strong>
        <span style={s.muted}>{loading ? '加载中…' : `共 ${tables.length} 张`}</span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <select
          style={s.select}
          value={schema}
          disabled={loading || schemas.length <= 1}
          onChange={e => setSchema(e.target.value)}
        >
          {schemas.length === 0
            ? <option value="">（默认）</option>
            : schemas.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <input
          style={{ ...s.search, flex: 1, minWidth: 140 }}
          placeholder="按表名过滤…"
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
        />
        <button type="button" style={s.button} disabled={loading} onClick={() => void load(schema, keyword)}>刷新</button>
      </div>

      <div style={{ ...s.scroll, maxHeight: 240 }}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>表名</th>
              <th style={s.th}>行数</th>
              <th style={s.th}>列数</th>
              <th style={s.th}>主键</th>
            </tr>
          </thead>
          <tbody>
            {tables.length === 0 && !loading
              ? (
                <tr>
                  <td style={{ ...s.td, color: c.fg2, textAlign: 'center', padding: '16px 8px' }} colSpan={4}>
                    没有匹配的表
                  </td>
                </tr>
                )
              : tables.map(table => (
                <tr
                  key={table.tableName}
                  style={{ ...s.row, ...(table.tableName === selected ? s.selectedRow : null) }}
                  onClick={() => setSelected(table.tableName === selected ? null : table.tableName)}
                >
                  <td style={s.td} title={table.tableName}>{table.tableName}</td>
                  <td style={s.td}>{formatRows(table.rowCount)}</td>
                  <td style={s.td}>{table.columns.length}</td>
                  <td style={s.td}>{table.primaryKey ?? '—'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {current !== null
        ? (
          <div style={{ marginTop: 10 }}>
            <div style={s.label}>{current.tableName} 的列结构（{current.columns.length}）</div>
            <div style={{ ...s.scroll, maxHeight: 180 }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>列名</th>
                    <th style={s.th}>类型</th>
                    <th style={s.th}>可空</th>
                    <th style={s.th}>注释</th>
                  </tr>
                </thead>
                <tbody>
                  {current.columns.map(column => (
                    <tr key={column.name}>
                      <td style={s.td} title={column.name}>{column.name}</td>
                      <td style={s.td}>{ADMIN_COLUMN_TYPE_LABELS[column.type] ?? column.type}</td>
                      <td style={s.td}>{column.nullable ? '是' : '否'}</td>
                      <td style={{ ...s.td, color: c.fg2 }} title={column.description ?? ''}>{column.description ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          )
        : null}

      <div style={{ ...s.bar, marginTop: 12 }}>
        <select
          style={s.select}
          value={scopeKey}
          disabled={importing || selected === null}
          onChange={e => setScopeKey(e.target.value)}
        >
          {scopes.length === 0
            ? <option value="">（暂无可用工作区）</option>
            : scopes.map(scope => <option key={scope.scopeKey} value={scope.scopeKey}>{scope.scopeKey}</option>)}
        </select>
        <input
          style={{ ...s.search, flex: 1, minWidth: 120 }}
          placeholder="数据集名称（默认取表名）"
          value={name}
          disabled={importing}
          onChange={e => setName(e.target.value)}
        />
        <button
          type="button"
          style={{ ...s.primaryButton, ...(selected === null || scopeKey.length === 0 || importing ? s.disabledButton : null) }}
          disabled={selected === null || scopeKey.length === 0 || importing}
          onClick={() => void handleImport()}
        >{importing ? '导入中…' : '导入到工作区'}</button>
      </div>

      {result !== null
        ? (
          <div style={{ ...s.banner, marginTop: 8, marginBottom: 0, borderColor: c.ok, color: c.ok }}>
            <span>
              已导入 {result.name}（datasetId: {result.datasetId}）：{result.rowCount} 行 / {result.columnCount} 列
              {result.status === 'running' ? '（后台导入中，完成后会通知）' : ''}
            </span>
          </div>
          )
        : null}
    </div>
  )
}
