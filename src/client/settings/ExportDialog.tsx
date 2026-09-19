/**
 * 「上传到数据源」弹窗：选目标数据源（PostgreSQL 额外选 schema）→ 提交批量导出。
 *
 * 后端若检测到同名表且未确认覆盖，会以 `DUPLICATE_NAME`（409）返回冲突表名；
 * 此时弹窗展示覆盖警告与「确认覆盖并上传」按钮，二次提交带 `overwrite: true`。
 * 写操作受只读模式 / 接口关闭 / 数据源功能关闭闸门控制（按钮置灰 + 错误提示）。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { DataSourceView, ExportDatasetResult } from '../../admin-contract'
import { AdminApiError, exportDatasets, listDataSources, listSourceTables } from './api'
import { c, s } from './styles'

export interface ExportDialogProps {
  selected: { id: string; name: string; scopeKey: string }[]
  onClose: () => void
  onError: (error: Error) => void
}

export function ExportDialog(props: ExportDialogProps): ReactElement {
  const { selected, onClose, onError } = props
  const [sources, setSources] = useState<DataSourceView[]>([])
  const [sourceId, setSourceId] = useState('')
  const [schema, setSchema] = useState('')
  const [schemas, setSchemas] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const [results, setResults] = useState<ExportDatasetResult[] | null>(null)
  const [genericError, setGenericError] = useState<string | null>(null)
  const [tableNames, setTableNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(selected.map(item => [item.id, item.name])),
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setSources((await listDataSources()).sources)
      } catch (failure) {
        if (!cancelled) onError(failure instanceof Error ? failure : new Error('加载数据源失败'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [onError])

  const source = sources.find(item => item.id === sourceId) ?? null
  const isPostgres = source?.type === 'postgresql'

  const loadSchemas = useCallback(async (id: string): Promise<void> => {
    try {
      const loaded = await listSourceTables(id, '', '')
      const list = loaded.schemas
      setSchemas(list)
      setSchema(list.includes('public') ? 'public' : (list[0] ?? ''))
    } catch {
      setSchemas([])
      setSchema('')
    }
  }, [])

  const chooseSource = useCallback((id: string): void => {
    setSourceId(id)
    setConflict(null)
    setResults(null)
    const picked = sources.find(item => item.id === id)
    if (picked?.type === 'postgresql') void loadSchemas(id)
    else { setSchemas([]); setSchema('') }
  }, [sources, loadSchemas])

  const submit = useCallback(async (overwrite: boolean): Promise<void> => {
    if (sourceId.length === 0 || busy) return
    setBusy(true)
    setConflict(null)
    setGenericError(null)
    try {
      const result = await exportDatasets(sourceId, {
        datasets: selected.map(item => ({
          id: item.id,
          scopeKey: item.scopeKey,
          tableName: (tableNames[item.id] ?? '').trim() || null,
        })),
        schemaName: isPostgres ? (schema.trim() || null) : null,
        overwrite,
      })
      setResults(result.results)
    } catch (failure) {
      const error = failure instanceof Error ? failure : new Error('上传失败')
      if (failure instanceof AdminApiError && failure.code === 'DUPLICATE_NAME') {
        setConflict(error.message)
      } else {
        setGenericError(error.message)
        onError(error)
      }
    } finally {
      setBusy(false)
    }
  }, [sourceId, busy, selected, isPostgres, schema, tableNames, onError])

  return (
    <div style={s.modalOverlay} onClick={onClose}>
      <div style={s.modal} onClick={event => event.stopPropagation()}>
        <div style={{ ...s.head, marginBottom: 12 }}>
          <span style={s.modalTitle}>上传到数据源</span>
          <span style={{ ...s.muted, fontSize: 12 }}>已选 {selected.length} 个数据集</span>
          <button type="button" style={s.modalClose} onClick={onClose} title="关闭">×</button>
        </div>

        {results !== null
          ? (
            <>
              <div style={s.okBanner}>上传完成，结果如下：</div>
              <ul style={s.resultList}>
                {results.map(item => (
                  <li key={item.id} style={s.resultItem}>
                    <span title={item.remoteTable || item.name}>{item.remoteTable || item.name}</span>
                    <span style={{ color: item.status === 'ok' ? c.ok : c.danger }}>
                      {item.status === 'ok'
                        ? `${item.rowCount} 行 / ${item.columnCount} 列`
                        : `失败：${item.error ?? '未知错误'}`}
                    </span>
                  </li>
                ))}
              </ul>
              <div style={s.modalFoot}>
                <button type="button" style={s.primaryButton} onClick={onClose}>完成</button>
              </div>
            </>
            )
          : (
            <>
              {loading
                ? <div style={s.muted}>加载数据源中…</div>
                : sources.length === 0
                  ? <div style={s.muted}>还没有可用的数据源，请先在「数据源」页签登记一个。</div>
                  : (
                    <>
                      <div style={s.field}>
                        <label style={s.label}>目标数据源</label>
                        <select style={s.select} value={sourceId} onChange={e => chooseSource(e.target.value)}>
                          <option value="">（请选择）</option>
                          {sources.map(item => (
                            <option key={item.id} value={item.id}>{item.name}（{item.type}）</option>
                          ))}
                        </select>
                      </div>

                      {isPostgres
                        ? (
                          <div style={s.field}>
                            <label style={s.label}>目标 schema</label>
                            <select style={s.select} value={schema} onChange={e => setSchema(e.target.value)}>
                              {schemas.length === 0
                                ? <option value="">（默认 public）</option>
                                : schemas.map(item => <option key={item} value={item}>{item}</option>)}
                            </select>
                          </div>
                          )
                        : null}

                      <div style={s.field}>
                        <label style={s.label}>待上传的数据集（可修改远端表名）</label>
                        <div style={s.selectedList}>
                          {selected.map(item => (
                            <div
                              key={item.id}
                              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}
                            >
                              <span
                                style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                title={`${item.name} · ${item.scopeKey}`}
                              >
                                {item.name} <span style={s.muted}>· {item.scopeKey}</span>
                              </span>
                              <input
                                style={{ ...s.input, width: 150, flex: 'none' }}
                                value={tableNames[item.id] ?? ''}
                                placeholder={item.name}
                                onChange={e => {
                                  setTableNames(previous => ({ ...previous, [item.id]: e.target.value }))
                                  setConflict(null)
                                }}
                              />
                            </div>
                          ))}
                        </div>
                      </div>

                      {conflict !== null
                        ? (
                          <div style={s.confirmBanner}>
                            <span>{conflict}。确认要覆盖这些表吗？</span>
                            <button
                              type="button"
                              style={{ ...s.dangerButton, marginLeft: 'auto' }}
                              disabled={busy}
                              onClick={() => void submit(true)}
                            >确认覆盖并上传</button>
                          </div>
                          )
                        : null}

                      {genericError !== null
                        ? <div style={s.banner}><span>{genericError}</span></div>
                        : null}

                      <div style={s.modalFoot}>
                        <button type="button" style={s.button} onClick={onClose} disabled={busy}>取消</button>
                        <button
                          type="button"
                          style={{ ...s.primaryButton, ...(sourceId.length === 0 || busy ? s.disabledButton : null) }}
                          disabled={sourceId.length === 0 || busy}
                          onClick={() => void submit(false)}
                        >{busy ? '上传中…' : '上传'}</button>
                      </div>
                    </>
                    )}
            </>
            )}
      </div>
    </div>
  )
}
