/**
 * 「数据集」页签：顶部工具条（搜索 / 新建 / 刷新）+ 聚合列表表格 + 详情/编辑或新建面板 +
 * 表数据分页面板。所有数据来自 `api.ts`，跨工作区聚合与表数据读取由主机侧完成。
 *
 * 状态以「列表 / 详情 / 新建」分区呈现：表格常驻，选中行在下方展开详情与
 * 只读的表数据分页，「新建」时详情区替换为新建表单（此时没有表数据可看）。
 * 写操作的只读/关闭判定由错误码驱动。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  ADMIN_PAGE_SIZE,
  type DatasetAdminView,
  type DatasetDetailView,
  type ScopeView,
} from '../../admin-contract'
import { AdminApiError, getDataset, listDatasets, listScopes } from './api'
import { DatasetTable } from './DatasetTable'
import { DatasetEditor } from './DatasetEditor'
import { RowsPanel } from './RowsPanel'
import { CreateForm } from './CreateForm'
import { ExportDialog } from './ExportDialog'
import { s } from './styles'

type Mode = 'browse' | 'create'

export function DatasetsPanel(): ReactElement {
  const [scopes, setScopes] = useState<ScopeView[]>([])
  const [items, setItems] = useState<DatasetAdminView[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [mode, setMode] = useState<Mode>('browse')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DatasetDetailView | null>(null)
  const [loadingList, setLoadingList] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [writable, setWritable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedItems, setSelectedItems] = useState<Map<string, DatasetAdminView>>(new Map())
  const [exportOpen, setExportOpen] = useState(false)
  const requestId = useRef(0)

  const selectedIdSet = useMemo(() => new Set(selectedItems.keys()), [selectedItems])

  const toggleSelect = useCallback((id: string): void => {
    const item = items.find(entry => entry.id === id)
    if (item === undefined) return
    setSelectedItems(previous => {
      const next = new Map(previous)
      if (next.has(id)) next.delete(id); else next.set(id, item)
      return next
    })
  }, [items])

  const toggleAll = useCallback((): void => {
    setSelectedItems(previous => {
      const next = new Map(previous)
      const allOnPage = items.length > 0 && items.every(item => next.has(item.id))
      if (allOnPage) {
        for (const item of items) next.delete(item.id)
      } else {
        for (const item of items) next.set(item.id, item)
      }
      return next
    })
  }, [items])

  const clearSelection = useCallback((): void => setSelectedItems(new Map()), [])

  const closeExport = useCallback((): void => {
    setExportOpen(false)
    setSelectedItems(new Map())
  }, [])

  const loadScopes = useCallback(async (): Promise<void> => {
    try {
      const result = await listScopes()
      setScopes(result.scopes)
    } catch (failure) {
      // 路由未挂载等同无可用工作区；列表加载会给出更具体的错误。
      if (failure instanceof AdminApiError && (failure.code === 'READ_ONLY' || failure.code === 'ADMIN_DISABLED')) {
        setWritable(false)
      }
    }
  }, [])

  const loadList = useCallback(async (q: string, p: number): Promise<void> => {
    const id = requestId.current + 1
    requestId.current = id
    setLoadingList(true)
    try {
      const result = await listDatasets(q, p, ADMIN_PAGE_SIZE)
      if (id !== requestId.current) return
      setItems(result.items)
      setTotal(result.total)
      const warning = result.warnings.map(w => `${w.scopeKey}: ${w.message}`).join('；')
      setError(warning.length > 0 ? warning : null)
    } catch (failure) {
      if (id !== requestId.current) return
      setError(failure instanceof Error ? failure.message : '加载失败')
    } finally {
      if (id === requestId.current) setLoadingList(false)
    }
  }, [])

  // 初次挂载：工作区列表 + 首屏列表。
  useEffect(() => {
    void loadScopes()
    void loadList('', 1)
  }, [loadScopes, loadList])

  // 关键字防抖：停止输入 300ms 后回到第一页重新拉取。
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1)
      void loadList(query, 1)
    }, 300)
    return () => clearTimeout(timer)
  }, [query, loadList])

  const openDetail = useCallback(async (item: DatasetAdminView): Promise<void> => {
    setSelectedId(item.id)
    setMode('browse')
    setDetail(null)
    setLoadingDetail(true)
    try {
      const fetched = await getDataset(item.id, item.scopeKey)
      setDetail(fetched)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '加载详情失败')
    } finally {
      setLoadingDetail(false)
    }
  }, [])

  const handleWriteError = useCallback((failure: Error): void => {
    setError(failure.message)
    if (failure instanceof AdminApiError && (failure.code === 'READ_ONLY' || failure.code === 'ADMIN_DISABLED')) {
      setWritable(false)
    }
  }, [])

  const handleChanged = useCallback((updated: DatasetDetailView): void => {
    setDetail(updated)
    void loadList(query, page)
  }, [query, page, loadList])

  const handleDeleted = useCallback(async (id: string): Promise<void> => {
    setSelectedId(null)
    setDetail(null)
    await loadScopes()
    await loadList(query, page)
    void id
  }, [query, page, loadList, loadScopes])

  const handleCreated = useCallback(async (created: unknown): Promise<void> => {
    setMode('browse')
    await loadScopes()
    await loadList(query, page)
    const record = created as DatasetDetailView
    setSelectedId(record.id)
    setDetail(record)
  }, [query, page, loadList, loadScopes])

  return (
    <div>
      <div style={s.toolbar}>
        <input
          style={s.search}
          placeholder="按名称 / 来源 / 工作区搜索…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <button
          type="button"
          style={{ ...s.primaryButton, ...(!writable ? s.disabledButton : null) }}
          disabled={!writable}
          onClick={() => setMode('create')}
          title={writable ? '新建空数据集' : '只读模式或接口已关闭'}
        >+ 新建数据集</button>
        <button type="button" style={s.button} disabled={loadingList} onClick={() => void loadList(query, page)}>刷新</button>
        {selectedIdSet.size > 0
          ? (
            <>
              <button
                type="button"
                style={{ ...s.primaryButton, ...(!writable ? s.disabledButton : null) }}
                disabled={!writable}
                onClick={() => setExportOpen(true)}
                title={writable ? '把选中的数据集上传到数据源' : '只读模式或接口已关闭'}
              >上传到数据源</button>
              <span style={s.muted}>
                已选 {selectedIdSet.size} 项 ·{' '}
                <span style={s.link} onClick={clearSelection}>清空</span>
              </span>
            </>
            )
          : null}
      </div>

      {error !== null
        ? (
          <div style={s.banner}>
            <span>{error}</span>
            <span style={{ ...s.link, marginLeft: 'auto' }} onClick={() => setError(null)}>忽略</span>
          </div>
          )
        : null}

      <DatasetTable
        items={items}
        page={page}
        pageSize={ADMIN_PAGE_SIZE}
        total={total}
        selectedId={selectedId}
        loading={loadingList}
        selectedIds={selectedIdSet}
        onSelect={item => void openDetail(item)}
        onToggleSelect={toggleSelect}
        onToggleAll={toggleAll}
        onPageChange={p => { setPage(p); void loadList(query, p) }}
      />

      {exportOpen
        ? (
          <ExportDialog
            selected={[...selectedItems.values()].map(item => ({ id: item.id, name: item.name, scopeKey: item.scopeKey }))}
            onClose={closeExport}
            onError={handleWriteError}
          />
          )
        : null}

      {mode === 'create'
        ? (
          <CreateForm
            scopes={scopes}
            onCreated={detail => void handleCreated(detail)}
            onCancel={() => setMode('browse')}
            onError={handleWriteError}
          />
          )
        : detail !== null
          ? (
            <>
              <DatasetEditor
                detail={detail}
                writable={writable}
                onChanged={handleChanged}
                onDeleted={id => void handleDeleted(id)}
                onError={handleWriteError}
              />
              {/* key 让切换数据集时重置分页状态，避免残留上一张表的页码。 */}
              <RowsPanel
                key={`${detail.scopeKey}:${detail.id}`}
                datasetId={detail.id}
                scopeKey={detail.scopeKey}
                recordedRows={detail.rowCount}
                status={detail.status}
              />
            </>
            )
          : (
            <div style={{ ...s.muted, marginTop: 12 }}>
              {loadingDetail ? '加载详情中…' : '选择一个数据集查看详情，或点击「新建数据集」创建空表。'}
            </div>
            )}
    </div>
  )
}
