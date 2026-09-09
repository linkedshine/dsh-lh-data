/**
 * 数据源新建 / 编辑表单。
 *
 * 两步提交：**先测连、后保存**。连接参数（类型 / 主机 / 端口 / 库 / 用户 / 密码）任一改动
 * 都会把测试结果打回「未测试」，未测通时保存按钮禁用；服务端在保存时也会再测一次，
 * 避免前端被绕过。编辑态下密码留空表示「保留原密码」。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import {
  ADMIN_SOURCE_DEFAULT_PORTS,
  ADMIN_SOURCE_TYPES,
  ADMIN_SOURCE_TYPE_LABELS,
  type ConnectionTestView,
  type DataSourceView,
  type TestDataSourceRequest,
} from '../../admin-contract'
import { createDataSource, patchDataSource, testDataSource } from './api'
import { c, s } from './styles'

export interface DataSourceFormProps {
  /** 传入即编辑态；null / undefined 为新建。 */
  initial?: DataSourceView | null
  onSaved: (view: DataSourceView) => void
  onCancel: () => void
  onError: (error: Error) => void
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail'

/** 连接参数的具体形态：测连、新建、编辑三处共用同一份草稿。 */
interface ConnectionFields {
  type: string
  host: string
  port: number
  database: string
  username: string
  password: string
  sslMode: string | null
  poolMax: number | null
}

export function DataSourceForm(props: DataSourceFormProps): ReactElement {
  const { initial, onSaved, onCancel, onError } = props
  const editing = initial !== null && initial !== undefined
  const defaultType = initial?.type ?? 'mysql'

  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState(defaultType)
  const [host, setHost] = useState(initial?.host ?? '127.0.0.1')
  const [port, setPort] = useState(String(initial?.port ?? ADMIN_SOURCE_DEFAULT_PORTS[defaultType]))
  const [database, setDatabase] = useState(initial?.database ?? '')
  const [username, setUsername] = useState(initial?.username ?? '')
  const [password, setPassword] = useState('')
  const [sslMode, setSslMode] = useState(initial?.sslMode ?? '')
  const [poolMax, setPoolMax] = useState(initial?.poolMax === null ? '' : String(initial?.poolMax ?? ''))
  const [description, setDescription] = useState(initial?.description ?? '')
  const [testState, setTestState] = useState<TestState>('idle')
  const [testResult, setTestResult] = useState<ConnectionTestView | null>(null)
  const [saving, setSaving] = useState(false)

  const requiredFilled =
    name.trim().length > 0 && host.trim().length > 0 && database.trim().length > 0 && username.trim().length > 0

  /** 连接参数变了，之前的测试结论就作废。 */
  function changeConnection(next: () => void): void {
    next()
    setTestState('idle')
    setTestResult(null)
  }

  function draft(): ConnectionFields {
    const parsedPort = Number.parseInt(port, 10)
    const parsedPool = Number.parseInt(poolMax, 10)
    return {
      type,
      host: host.trim(),
      port: Number.isFinite(parsedPort) ? parsedPort : ADMIN_SOURCE_DEFAULT_PORTS[type],
      database: database.trim(),
      username: username.trim(),
      password,
      sslMode: sslMode.trim().length > 0 ? sslMode.trim() : null,
      poolMax: Number.isFinite(parsedPool) ? parsedPool : null,
    }
  }

  async function handleTest(): Promise<void> {
    if (!requiredFilled || testState === 'testing') return
    setTestState('testing')
    try {
      const result = await testDataSource(draft())
      setTestResult(result)
      setTestState(result.success ? 'ok' : 'fail')
    } catch (error) {
      setTestState('fail')
      onError(error instanceof Error ? error : new Error('测试连接失败'))
    }
  }

  async function handleSave(): Promise<void> {
    if (testState !== 'ok' || saving) return
    setSaving(true)
    try {
      const connection = draft()
      const saved = editing
        ? await patchDataSource(initial.id, {
          name: name.trim(),
          ...connection,
          // 密码留空 = 保留原密码；填了才替换。
          ...(password.length > 0 ? {} : { password: undefined }),
          description: description.trim().length > 0 ? description.trim() : null,
          test: true,
        })
        : await createDataSource({
          ...connection,
          name: name.trim(),
          description: description.trim().length > 0 ? description.trim() : null,
          test: true,
        })
      onSaved(saved)
    } catch (error) {
      onError(error instanceof Error ? error : new Error('保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const testHint = testState === 'ok'
    ? `连接成功（${testResult?.latency ?? 0}ms${testResult?.version === null ? '' : ` · ${testResult?.version}`}）`
    : testState === 'fail'
      ? (testResult?.error ?? '连接失败')
      : '保存前请先测试连接'

  return (
    <div style={s.panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <strong style={{ fontSize: 13 }}>{editing ? '编辑数据源' : '新建数据源'}</strong>
        <span style={s.muted}>
          {editing && initial.hasPassword ? '已保存过密码，留空即保留' : '密码加密存储，不会回显'}
        </span>
      </div>

      <div style={s.grid2}>
        <div style={s.field}>
          <label style={s.label}>名称</label>
          <input style={s.input} value={name} disabled={saving} onChange={e => setName(e.target.value)} />
        </div>
        <div style={s.field}>
          <label style={s.label}>类型</label>
          <select
            style={s.input}
            value={type}
            disabled={saving}
            onChange={e => changeConnection(() => {
              setType(e.target.value)
              setPort(String(ADMIN_SOURCE_DEFAULT_PORTS[e.target.value]))
            })}
          >
            {ADMIN_SOURCE_TYPES.map(item => (
              <option key={item} value={item}>{ADMIN_SOURCE_TYPE_LABELS[item]}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={s.grid2}>
        <div style={s.field}>
          <label style={s.label}>主机</label>
          <input
            style={s.input}
            value={host}
            disabled={saving}
            onChange={e => changeConnection(() => setHost(e.target.value))}
          />
        </div>
        <div style={s.field}>
          <label style={s.label}>端口</label>
          <input
            style={s.input}
            value={port}
            inputMode="numeric"
            disabled={saving}
            onChange={e => changeConnection(() => setPort(e.target.value))}
          />
        </div>
      </div>

      <div style={s.grid2}>
        <div style={s.field}>
          <label style={s.label}>数据库名</label>
          <input
            style={s.input}
            value={database}
            disabled={saving}
            onChange={e => changeConnection(() => setDatabase(e.target.value))}
          />
        </div>
        <div style={s.field}>
          <label style={s.label}>用户名</label>
          <input
            style={s.input}
            value={username}
            disabled={saving}
            onChange={e => changeConnection(() => setUsername(e.target.value))}
          />
        </div>
      </div>

      <div style={s.grid2}>
        <div style={s.field}>
          <label style={s.label}>{editing ? '重设密码（留空保留）' : '密码'}</label>
          <input
            style={s.input}
            type="password"
            value={password}
            disabled={saving}
            onChange={e => changeConnection(() => setPassword(e.target.value))}
          />
        </div>
        <div style={s.field}>
          <label style={s.label}>SSL 模式（可选）</label>
          <input
            style={s.input}
            value={sslMode}
            disabled={saving}
            placeholder={type === 'mysql' ? 'disabled / preferred / required' : 'disable / require / verify-full'}
            onChange={e => changeConnection(() => setSslMode(e.target.value))}
          />
        </div>
      </div>

      <div style={s.grid2}>
        <div style={s.field}>
          <label style={s.label}>连接池上限（可选）</label>
          <input
            style={s.input}
            value={poolMax}
            inputMode="numeric"
            disabled={saving}
            onChange={e => changeConnection(() => setPoolMax(e.target.value))}
          />
        </div>
        <div style={s.field}>
          <label style={s.label}>描述（可选）</label>
          <input style={s.input} value={description} disabled={saving} onChange={e => setDescription(e.target.value)} />
        </div>
      </div>

      <div
        style={{
          ...s.banner,
          marginBottom: 10,
          borderColor: testState === 'ok' ? c.ok : testState === 'fail' ? c.danger : c.border,
          color: testState === 'ok' ? c.ok : testState === 'fail' ? c.danger : c.fg2,
        }}
      >
        <span>{testHint}</span>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          style={{ ...s.button, ...(!requiredFilled || testState === 'testing' ? s.disabledButton : null) }}
          disabled={!requiredFilled || testState === 'testing'}
          onClick={() => void handleTest()}
        >{testState === 'testing' ? '测试中…' : '测试连接'}</button>
        <button
          type="button"
          style={{ ...s.primaryButton, ...(testState !== 'ok' || saving ? s.disabledButton : null) }}
          disabled={testState !== 'ok' || saving}
          onClick={() => void handleSave()}
        >{saving ? '保存中…' : '保存'}</button>
        <button type="button" style={s.button} disabled={saving} onClick={onCancel}>取消</button>
      </div>
    </div>
  )
}
