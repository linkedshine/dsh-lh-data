/**
 * 新建空数据集表单：选工作区 + 填名称/描述/来源 + 逐行定义列。
 * 列结构提交后即冻结（设置页不支持改列）。提交走 `createDataset`。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import {
  ADMIN_COLUMN_TYPES,
  ADMIN_COLUMN_TYPE_LABELS,
  ADMIN_MAX_COLUMNS,
  type DatasetColumnSpec,
  type ScopeView,
} from '../../admin-contract'
import { createDataset } from './api'
import { c, s } from './styles'

export interface CreateFormProps {
  scopes: ScopeView[]
  onCreated: (detail: unknown) => void
  onCancel: () => void
  onError: (error: Error) => void
}

interface ColumnDraft {
  name: string
  type: string
  nullable: boolean
  description: string
}

const EMPTY_COLUMN: ColumnDraft = { name: '', type: 'text', nullable: false, description: '' }

export function CreateForm(props: CreateFormProps): ReactElement {
  const { scopes, onCreated, onCancel, onError } = props
  const [scopeKey, setScopeKey] = useState(scopes[0]?.scopeKey ?? '')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [columns, setColumns] = useState<ColumnDraft[]>([{ ...EMPTY_COLUMN }])
  const [submitting, setSubmitting] = useState(false)

  const canSubmit =
    scopeKey.length > 0 &&
    name.trim().length > 0 &&
    columns.length > 0 &&
    columns.length <= ADMIN_MAX_COLUMNS &&
    columns.every(column => column.name.trim().length > 0)

  function updateColumn(index: number, patch: Partial<ColumnDraft>): void {
    setColumns(previous => previous.map((column, i) => (i === index ? { ...column, ...patch } : column)))
  }

  async function handleSubmit(): Promise<void> {
    if (!canSubmit || submitting) return
    const body = {
      scopeKey,
      name: name.trim(),
      description: description.trim().length > 0 ? description.trim() : undefined,
      sourcePath: sourcePath.trim().length > 0 ? sourcePath.trim() : null,
      columns: columns.map<{ name: string; type: DatasetColumnSpec['type']; nullable: boolean; description?: string }>(column => ({
        name: column.name.trim(),
        type: column.type as DatasetColumnSpec['type'],
        nullable: column.nullable,
        description: column.description.trim().length > 0 ? column.description.trim() : undefined,
      })),
    }
    setSubmitting(true)
    try {
      const created = await createDataset(body)
      onCreated(created)
    } catch (error) {
      onError(error instanceof Error ? error : new Error('新建失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={s.panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <strong style={{ fontSize: 13 }}>新建数据集</strong>
        <span style={s.muted}>空表，建好后用 agent 工具灌入数据</span>
      </div>

      <div style={s.grid2}>
        <div style={s.field}>
          <label style={s.label}>工作区</label>
          <select style={s.input} value={scopeKey} disabled={submitting} onChange={e => setScopeKey(e.target.value)}>
            {scopes.length === 0
              ? <option value="">（暂无可用工作区）</option>
              : scopes.map(scope => <option key={scope.scopeKey} value={scope.scopeKey}>{scope.scopeKey}</option>)}
          </select>
        </div>
        <div style={s.field}>
          <label style={s.label}>名称</label>
          <input style={s.input} value={name} disabled={submitting} onChange={e => setName(e.target.value)} />
        </div>
      </div>
      <div style={s.grid2}>
        <div style={s.field}>
          <label style={s.label}>描述</label>
          <input style={s.input} value={description} disabled={submitting} onChange={e => setDescription(e.target.value)} />
        </div>
        <div style={s.field}>
          <label style={s.label}>来源路径（可选）</label>
          <input style={s.input} value={sourcePath} disabled={submitting} onChange={e => setSourcePath(e.target.value)} />
        </div>
      </div>

      <div style={s.label}>列定义（{columns.length} / {ADMIN_MAX_COLUMNS}）</div>
      <div style={{ ...s.scroll, maxHeight: 220, marginBottom: 10 }}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>列名</th>
              <th style={s.th}>类型</th>
              <th style={s.th}>可空</th>
              <th style={s.th}>说明</th>
              <th style={s.th} />
            </tr>
          </thead>
          <tbody>
            {columns.map((column, index) => (
              <tr key={index}>
                <td style={s.td}>
                  <input
                    style={{ ...s.input, border: column.name.trim().length === 0 ? `1px solid ${c.danger}` : s.input.border }}
                    value={column.name}
                    disabled={submitting}
                    onChange={e => updateColumn(index, { name: e.target.value })}
                  />
                </td>
                <td style={s.td}>
                  <select
                    style={s.input}
                    value={column.type}
                    disabled={submitting}
                    onChange={e => updateColumn(index, { type: e.target.value })}
                  >
                    {ADMIN_COLUMN_TYPES.map(type => (
                      <option key={type} value={type}>{ADMIN_COLUMN_TYPE_LABELS[type]}</option>
                    ))}
                  </select>
                </td>
                <td style={s.td}>
                  <input
                    type="checkbox"
                    checked={column.nullable}
                    disabled={submitting}
                    onChange={e => updateColumn(index, { nullable: e.target.checked })}
                  />
                </td>
                <td style={s.td}>
                  <input style={s.input} value={column.description} disabled={submitting} onChange={e => updateColumn(index, { description: e.target.value })} />
                </td>
                <td style={s.td}>
                  <span
                    style={{ ...s.link, ...(columns.length <= 1 || submitting ? s.disabledButton : null) }}
                    onClick={() => { if (columns.length > 1 && !submitting) setColumns(previous => previous.filter((_, i) => i !== index)) }}
                  >删除</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        style={{ ...s.button, ...(columns.length >= ADMIN_MAX_COLUMNS || submitting ? s.disabledButton : null) }}
        disabled={columns.length >= ADMIN_MAX_COLUMNS || submitting}
        onClick={() => setColumns(previous => [...previous, { ...EMPTY_COLUMN }])}
      >添加一列</button>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          type="button"
          style={{ ...s.primaryButton, ...(!canSubmit || submitting ? s.disabledButton : null) }}
          disabled={!canSubmit || submitting}
          onClick={() => void handleSubmit()}
        >{submitting ? '提交中…' : '提交'}</button>
        <button type="button" style={s.button} disabled={submitting} onClick={onCancel}>取消</button>
      </div>
    </div>
  )
}
