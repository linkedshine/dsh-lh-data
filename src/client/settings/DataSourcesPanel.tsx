/**
 * 「数据源」页签：列表（名称 / 类型 / 地址 / 库名 / 连通状态 / 最近检测）+ 工具条
 * （搜索 / 新建 / 刷新）+ 选中项的详情面板。
 *
 * 详情面板上部位只读连接摘要（密码位只显示「已设置 · 不可查看」），下部位
 * `SourceTablesPanel`：浏览远端表并把选中的表导入到某个工作区。
 *
 * 写操作（新建 / 编辑 / 删除 / 导入）在只读模式或接口关闭时整体置灰 —— 判定由服务端
 * 返回的 `READ_ONLY` / `ADMIN_DISABLED` / `SOURCE_DISABLED` 错误码驱动，不靠前端猜。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  ADMIN_SOURCE_TYPE_LABELS,
  type DataSourceView,
  type ScopeView,
} from '../../admin-contract'
import { AdminApiError, deleteDataSource, listDataSources, listScopes, testDataSource } from './api'
import { DataSourceForm } from './DataSourceForm'
import { SourceTablesPanel } from './SourceTablesPanel'
import { fmtAgo } from './DatasetTable'
import { c, s, SOURCE_STATUS_COLOR, SOURCE_STATUS_TEXT, TYPE_BADGE } from './styles'

type Mode = 'browse' | 'create' | 'edit'

const READ_ONLY_CODES = ['READ_ONLY', 'ADMIN_DISABLED', 'SOURCE_DISABLED']

export function DataSourcesPanel(): ReactElement {
  const [items, setItems] = useState<DataSourceView[]>([])
  const [scopes, setScopes] = useState<ScopeView[]>([])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('browse')
  const [loading, setLoading] = useState(false)
  const [writable, setWritable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const loadScopes = useCallback(async (): Promise<void> => {
    try {
      setScopes((await listScopes()).scopes)
    } catch {
      // 工作区列表拿不到不阻断数据源浏览；导入时再提示。
    }
  }, [])

  const loadList = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setItems((await listDataSources()).sources)
      setError(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '加载数据源失败')
      if (failure instanceof AdminApiError && READ_ONLY_CODES.includes(failure.code)) setWritable(false)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadScopes()
    void loadList()
  }, [loadScopes, loadList])

  const selected = items.find(item => item.id === selectedId) ?? null
  const needle = query.trim().toLowerCase()
  const visible = needle.length === 0
    ? items
    : items.filter(item => (
      item.name.toLowerCase().includes(needle)
      || item.type.toLowerCase().includes(needle)
      || item.host.toLowerCase().includes(needle)
      || item.database.toLowerCase().includes(needle)
    ))

  async function handleTest(id: string): Promise<void> {
    if (testingId !== null) return
    setTestingId(id)
    setNotice(null)
    try {
      const result = await testDataSource({ source: id })
      setNotice(result.success
        ? `连接成功（${result.latency}ms${result.version === null ? '' : ` · ${result.version}`}）`
        : `连接失败：${result.error ?? '未知错误'}`)
      await loadList()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '测试连接失败')
    } finally {
      setTestingId(null)
    }
  }

  async function handleDelete(id: string): Promise<void> {
    setConfirmId(null)
    try {
      await deleteDataSource(id)
      if (selectedId === id) {
        setSelectedId(null)
        setMode('browse')
      }
      await loadList()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '删除失败')
    }
  }

  async function handleSaved(view: DataSourceView): Promise<void> {
    setMode('browse')
    setNotice(`已保存数据源「${view.name}」`)
    await loadList()
    setSelectedId(view.id)
  }

  function handleError(failure: Error): void {
    setError(failure.message)
    if (failure instanceof AdminApiError && READ_ONLY_CODES.includes(failure.code)) setWritable(false)
  }

  return (
    <div>
      <div style={s.toolbar}>
        <input
          style={s.search}
          placeholder="按名称 / 类型 / 主机 / 库名搜索…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <button
          type="button"
          style={{ ...s.primaryButton, ...(!writable ? s.disabledButton : null) }}
          disabled={!writable}
          onClick={() => { setMode('create'); setSelectedId(null) }}
          title={writable ? '新建数据源' : '只读模式、接口已关闭或数据源功能未启用'}
        >+ 新建数据源</button>
        <button type="button" style={s.button} disabled={loading} onClick={() => void loadList()}>刷新</button>
      </div>

      {error !== null
        ? (
          <div style={s.banner}>
            <span>{error}</span>
            <span style={{ ...s.link, marginLeft: 'auto' }} onClick={() => setError(null)}>忽略</span>
          </div>
          )
        : null}

      {notice !== null
        ? (
          <div style={{ ...s.banner, borderColor: c.ok, color: c.ok }}>
            <span>{notice}</span>
            <span style={{ ...s.link, marginLeft: 'auto' }} onClick={() => setNotice(null)}>忽略</span>
          </div>
          )
        : null}

      {confirmId !== null
        ? (
          <div style={s.banner}>
            <span>确认删除这个数据源？该操作不可恢复。</span>
            <button type="button" style={{ ...s.dangerButton, marginLeft: 'auto' }} onClick={() => void handleDelete(confirmId)}>删除</button>
            <button type="button" style={s.button} onClick={() => setConfirmId(null)}>取消</button>
          </div>
          )
        : null}

      <div style={s.scroll}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>名称</th>
              <th style={s.th}>类型</th>
              <th style={s.th}>地址</th>
              <th style={s.th}>库名</th>
              <th style={s.th}>状态</th>
              <th style={s.th}>最近检测</th>
              <th style={s.th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && !loading
              ? (
                <tr>
                  <td style={{ ...s.td, color: c.fg2, textAlign: 'center', padding: '18px 8px' }} colSpan={7}>
                    还没有数据源，点击「新建数据源」登记一个 MySQL / PostgreSQL 连接
                  </td>
                </tr>
                )
              : visible.map(item => (
                <tr
                  key={item.id}
                  style={{ ...s.row, ...(item.id === selectedId ? s.selectedRow : null) }}
                  onClick={() => { setSelectedId(item.id); setMode('browse') }}
                >
                  <td style={s.td} title={item.description ?? ''}>{item.name}</td>
                  <td style={s.td}>
                    <span
                      style={{
                        display: 'inline-block', padding: '0 6px', borderRadius: 4, fontSize: 11,
                        color: TYPE_BADGE[item.type] ?? c.fg2, border: `1px solid ${TYPE_BADGE[item.type] ?? c.border}`,
                      }}
                    >{ADMIN_SOURCE_TYPE_LABELS[item.type] ?? item.type}</span>
                  </td>
                  <td style={s.td} title={`${item.host}:${item.port}`}>{item.host}:{item.port}</td>
                  <td style={s.td}>{item.database}</td>
                  <td style={s.td}>
                    <span style={{ ...s.dot, background: SOURCE_STATUS_COLOR[item.status] ?? c.fg2 }} />
                    {SOURCE_STATUS_TEXT[item.status] ?? item.status}
                  </td>
                  <td style={{ ...s.td, color: c.fg2 }}>
                    {item.lastCheckedAt === null ? '—' : fmtAgo(item.lastCheckedAt)}
                  </td>
                  <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                    <span
                      style={{ ...s.link, marginRight: 8, ...(testingId !== null ? s.disabledButton : null) }}
                      onClick={event => {
                        event.stopPropagation()
                        if (testingId === null) void handleTest(item.id)
                      }}
                    >{testingId === item.id ? '测试中…' : '测试'}</span>
                    <span
                      style={{ ...s.link, marginRight: 8, ...(!writable ? s.disabledButton : null) }}
                      onClick={event => {
                        event.stopPropagation()
                        if (!writable) return
                        setSelectedId(item.id)
                        setMode('edit')
                      }}
                    >编辑</span>
                    <span
                      style={{ ...s.link, color: c.danger, ...(!writable ? s.disabledButton : null) }}
                      onClick={event => {
                        event.stopPropagation()
                        if (writable) setConfirmId(item.id)
                      }}
                    >删除</span>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {mode === 'create'
        ? (
          <DataSourceForm
            onSaved={view => void handleSaved(view)}
            onCancel={() => setMode('browse')}
            onError={handleError}
          />
          )
        : mode === 'edit' && selected !== null
          ? (
            <DataSourceForm
              initial={selected}
              onSaved={view => void handleSaved(view)}
              onCancel={() => setMode('browse')}
              onError={handleError}
            />
            )
          : selected !== null
            ? (
              <>
                <div style={s.panel}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <strong style={{ fontSize: 13 }}>{selected.name}</strong>
                    <span style={s.muted}>
                      {ADMIN_SOURCE_TYPE_LABELS[selected.type] ?? selected.type} · 最近更新 {fmtAgo(selected.updatedAt)}
                    </span>
                  </div>
                  <div style={s.grid2}>
                    <div><span style={s.muted}>地址：</span>{selected.host}:{selected.port}</div>
                    <div><span style={s.muted}>库名：</span>{selected.database}</div>
                    <div><span style={s.muted}>用户名：</span>{selected.username}</div>
                    <div>
                      <span style={s.muted}>密码：</span>
                      {selected.hasPassword ? '已设置 · 不可查看' : '未设置'}
                    </div>
                    <div><span style={s.muted}>SSL：</span>{selected.sslMode ?? '—'}</div>
                    <div><span style={s.muted}>连接池上限：</span>{selected.poolMax ?? '—'}</div>
                  </div>
                  {selected.description !== null
                    ? <div style={{ ...s.muted, marginTop: 6 }}>{selected.description}</div>
                    : null}
                  {selected.lastError !== null
                    ? <div style={{ ...s.muted, marginTop: 6, color: c.danger }}>最近错误：{selected.lastError}</div>
                    : null}
                </div>
                <SourceTablesPanel source={selected} scopes={scopes} onError={handleError} />
              </>
              )
            : (
              <div style={{ ...s.muted, marginTop: 12 }}>
                {loading ? '加载中…' : '选择一个数据源查看详情与远端表，或点击「新建数据源」。'}
              </div>
              )}
    </div>
  )
}
