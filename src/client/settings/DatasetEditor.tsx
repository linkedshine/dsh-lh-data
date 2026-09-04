/**
 * 数据集详情与编辑面板。
 *
 * 可改：名称 / 描述 / 来源路径，以及列结构里的**说明与样例**（纯元数据）。
 * 不可改：列名 / 类型 / 可空性——它们对应物理表 DDL，由导入时推断确定。
 * 删除走二次确认。写操作受 `writable` 控制（只读模式或接口关闭时置灰）。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import {
  ADMIN_COLUMN_TYPE_LABELS,
  ADMIN_MAX_SAMPLE_VALUES,
  type DatasetColumnPatch,
  type DatasetDetailView,
  type PatchDatasetRequest,
} from '../../admin-contract'
import { patchDataset, deleteDataset } from './api'
import { c, s } from './styles'

/** 样例分隔符：展示用全角顿号，输入同时接受半角与全角逗号。 */
const SAMPLE_SEPARATORS = /[、,，]/
/** 空值的展示记号，与 `sampleToText` 互逆。 */
const NULL_MARK = '∅'

interface ColumnDraft {
  description: string
  sampleText: string
}

function sampleToText(sample: unknown[]): string {
  if (!Array.isArray(sample)) return ''
  return sample
    .slice(0, ADMIN_MAX_SAMPLE_VALUES)
    .map(value => (value === null ? NULL_MARK : String(value)))
    .join('、')
}

function textToSample(text: string): (string | null)[] {
  return text
    .split(SAMPLE_SEPARATORS)
    .map(value => value.trim())
    .filter(value => value.length > 0)
    .map(value => (value === NULL_MARK ? null : value))
}

function initialDrafts(columns: DatasetDetailView['columns']): Record<string, ColumnDraft> {
  const drafts: Record<string, ColumnDraft> = {}
  for (const column of columns) {
    drafts[column.sanitizedName] = {
      description: column.description ?? '',
      sampleText: sampleToText(column.sample),
    }
  }
  return drafts
}

export interface DatasetEditorProps {
  detail: DatasetDetailView
  writable: boolean
  onChanged: (detail: DatasetDetailView) => void
  onDeleted: (id: string) => void
  onError: (error: Error) => void
}

export function DatasetEditor(props: DatasetEditorProps): ReactElement {
  const { detail, writable, onChanged, onDeleted, onError } = props
  const [name, setName] = useState(detail.name)
  const [description, setDescription] = useState(detail.description ?? '')
  const [sourcePath, setSourcePath] = useState(detail.sourcePath ?? '')
  const [columnDrafts, setColumnDrafts] = useState<Record<string, ColumnDraft>>(() => initialDrafts(detail.columns))
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirming, setConfirming] = useState(false)

  function updateColumnDraft(key: string, patch: Partial<ColumnDraft>): void {
    setColumnDrafts(previous => ({ ...previous, [key]: { ...previous[key], ...patch } }))
  }

  const columnDirty = detail.columns.some(column => {
    const draft = columnDrafts[column.sanitizedName]
    if (draft === undefined) return false
    return draft.description !== (column.description ?? '') || draft.sampleText !== sampleToText(column.sample)
  })
  const dirty =
    name !== detail.name ||
    description !== (detail.description ?? '') ||
    sourcePath !== (detail.sourcePath ?? '') ||
    columnDirty

  /** 只提交改动的列；未改动的列连同样例一并原样保留，不参与往返。 */
  function buildColumnPatches(): DatasetColumnPatch[] {
    const patches: DatasetColumnPatch[] = []
    for (const column of detail.columns) {
      const draft = columnDrafts[column.sanitizedName]
      if (draft === undefined) continue
      const patch: DatasetColumnPatch = { sanitizedName: column.sanitizedName }
      let changed = false
      if (draft.description !== (column.description ?? '')) {
        patch.description = draft.description
        changed = true
      }
      if (draft.sampleText !== sampleToText(column.sample)) {
        patch.sample = textToSample(draft.sampleText)
        changed = true
      }
      if (changed) patches.push(patch)
    }
    return patches
  }

  async function handleSave(): Promise<void> {
    if (!dirty || saving) return
    const columnPatches = buildColumnPatches()
    const body: PatchDatasetRequest = { name, description, sourcePath }
    if (columnPatches.length > 0) body.columns = columnPatches
    setSaving(true)
    try {
      const updated = await patchDataset(detail.id, detail.scopeKey, body)
      onChanged(updated)
    } catch (error) {
      onError(error instanceof Error ? error : new Error('保存失败'))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(): Promise<void> {
    if (deleting) return
    setDeleting(true)
    try {
      await deleteDataset(detail.id, detail.scopeKey)
      onDeleted(detail.id)
    } catch (error) {
      onError(error instanceof Error ? error : new Error('删除失败'))
      setConfirming(false)
    } finally {
      setDeleting(false)
    }
  }

  const disabled = !writable || saving

  return (
    <div style={s.panel}>
      <div style={{ ...s.head, display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <strong style={{ fontSize: 13 }}>数据集详情</strong>
        <span style={s.muted}>工作区：{detail.scopeKey}</span>
      </div>

      <div style={s.grid2}>
        <div style={s.field}>
          <label style={s.label}>名称</label>
          <input style={s.input} value={name} disabled={disabled} onChange={e => setName(e.target.value)} />
        </div>
        <div style={s.field}>
          <label style={s.label}>来源路径</label>
          <input style={s.input} value={sourcePath} disabled={disabled} onChange={e => setSourcePath(e.target.value)} />
        </div>
      </div>
      <div style={s.field}>
        <label style={s.label}>描述</label>
        <textarea style={s.textarea} value={description} disabled={disabled} onChange={e => setDescription(e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          style={{ ...s.primaryButton, ...(disabled || !dirty ? s.disabledButton : null) }}
          disabled={disabled || !dirty}
          onClick={() => void handleSave()}
        >{saving ? '保存中…' : '保存修改'}</button>

        {!confirming
          ? (
            <button
              type="button"
              style={{ ...s.dangerButton, ...(!writable ? s.disabledButton : null) }}
              disabled={!writable}
              onClick={() => setConfirming(true)}
            >删除数据集</button>
            )
          : (
            <>
              <span style={{ color: c.danger }}>确认删除「{detail.name}」及其全部数据？</span>
              <button
                type="button"
                style={{ ...s.dangerButton, ...(deleting ? s.disabledButton : null) }}
                disabled={deleting}
                onClick={() => void handleDelete()}
              >{deleting ? '删除中…' : '确认删除'}</button>
              <button type="button" style={s.button} disabled={deleting} onClick={() => setConfirming(false)}>取消</button>
            </>
            )}
        {!writable ? <span style={s.muted}>（只读模式或接口已关闭，不可修改）</span> : null}
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ ...s.label, marginBottom: 6 }}>
          列结构 · 共 {detail.columns.length} 列　（列名 / 类型 / 可空性由导入时推断，不可修改；说明与样例可编辑）
        </div>
        <div style={{ ...s.scroll, maxHeight: 240 }}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>列名</th>
                <th style={s.th}>类型</th>
                <th style={s.th}>可空</th>
                <th style={s.th}>说明</th>
                <th style={s.th}>样例</th>
              </tr>
            </thead>
            <tbody>
              {detail.columns.map(column => (
                <tr key={column.sanitizedName}>
                  <td style={s.td} title={column.name}>{column.name}</td>
                  <td style={s.td}>{ADMIN_COLUMN_TYPE_LABELS[column.type] ?? column.type}</td>
                  <td style={s.td}>{column.nullable ? '是' : '否'}</td>
                  <td style={{ ...s.td, overflow: 'visible' }}>
                    <input
                      style={s.input}
                      value={columnDrafts[column.sanitizedName]?.description ?? ''}
                      disabled={disabled}
                      placeholder="补充说明，便于 agent 理解该列"
                      onChange={event => updateColumnDraft(column.sanitizedName, { description: event.target.value })}
                    />
                  </td>
                  <td style={{ ...s.td, overflow: 'visible' }}>
                    <input
                      style={s.input}
                      value={columnDrafts[column.sanitizedName]?.sampleText ?? ''}
                      disabled={disabled}
                      placeholder="多个值用 、 分隔"
                      onChange={event => updateColumnDraft(column.sanitizedName, { sampleText: event.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
