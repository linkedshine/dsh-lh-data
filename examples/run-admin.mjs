/**
 * 设置页管理接口验证脚本：构造带假 `webServer` / `connection` 的最小 ctx，
 * 跑通「聚合列表 / 新建空表 / 改名改描述改来源 / 删除」与门禁（鉴权、只读、未知工作区、重名）。
 *
 * 运行：先 `pnpm run build`，再 `node examples/run-admin.mjs`
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply, closeAllDatabases, validateConfig } from '../lib/index.js'

process.on('uncaughtException', (error) => {
  console.error('[uncaught]', error?.message, '\n', error?.stack)
  process.exit(1)
})

let passed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
    return
  }
  failures.push(label)
  console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

// ── 临时工作区与一份样本 CSV ────────────────────────────────────────────────

const workspace = resolve(mkdtempSync(join(tmpdir(), 'dsh-lh-data-admin-')))
writeFileSync(join(workspace, 'sales.csv'), '产品,数量,地区\n手机,100,华东\n笔记本,50,华北\n平板,30,华南\n')

// ── 假 ctx ──────────────────────────────────────────────────────────────────

function makeCtx(options = {}) {
  const listeners = new Map()
  const tools = new Map()
  const disposers = []
  const routes = new Map()
  const guards = []
  let rejection = undefined

  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const connection = { requestRejection() { return rejection } }
  const injected = []

  return {
    listeners,
    routes,
    toolsByName: tools,
    guards,
    disposers,
    logger: { info() {}, warn: message => console.warn('  [warn]', message) },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    effect(setup) {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => (typeof dispose === 'function' ? dispose() : undefined)
    },
    inject(deps, callback) {
      if (deps.includes('webServer') && options.webServer !== false) callback({ webServer, connection })
      if (deps.includes('jobs') && options.jobs !== undefined) callback({ jobs: options.jobs })
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      guard(guard) {
        guards.push(guard)
        return () => {
          const index = guards.indexOf(guard)
          if (index >= 0) guards.splice(index, 1)
        }
      },
    },
    setRejection(status) { rejection = status },
    injected,
  }
}

function makeExec(toolName, args) {
  return {
    name: toolName,
    arguments: args,
    agent: { id: 'agent-1', session: { header: { cwd: workspace, id: 'session-1' } }, inject() {} },
    signal: new AbortController().signal,
    deferContext() {},
  }
}

async function call(targetCtx, toolName, args) {
  const definition = targetCtx.toolsByName.get(toolName)
  if (definition === undefined) throw new Error(`未注册工具：${toolName}`)
  const value = await definition.execute(args, makeExec(toolName, args))
  const text = definition.output.render(args, value).map(block => block.text).join('\n')
  const meta = definition.output.presentationMeta?.(args, value) ?? null
  return { value, text, meta }
}

/** 最小可发 body 的假请求（readJsonBody 依赖 data/end 事件）。 */
function makeRequestObject(method, url, body) {
  const handlers = {}
  const req = {
    method,
    url,
    headers: {},
    on(event, handler) {
      (handlers[event] ??= []).push(handler)
      return req
    },
    destroy() {},
  }
  const payload = typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body)
  setImmediate(() => {
    if (payload.length > 0) handlers['data']?.forEach(h => h(Buffer.from(payload)))
    handlers['end']?.forEach(h => h())
  })
  return req
}

async function request(targetCtx, url, { method = 'GET', reject, body } = {}) {
  targetCtx.setRejection(reject)
  let status = 0
  let raw = ''
  const response = {
    writeHead(code) { status = code },
    end(b) { raw = b ?? '' },
  }
  const pathname = url.split('?')[0]
  const route = [...targetCtx.routes.values()].find(entry => pathname.startsWith(entry.path))
  if (route === undefined) {
    targetCtx.setRejection(undefined)
    return { status: 404, body: { error: { code: 'NO_ROUTE' } } }
  }
  await route.handler(makeRequestObject(method, url, body), response)
  targetCtx.setRejection(undefined)
  return { status, body: raw.length > 0 ? JSON.parse(raw) : null }
}

// ── 阶段 1：装载并导入一份样本（注册工作区） ─────────────────────────────────

const ctx = makeCtx()
apply(ctx, validateConfig({
  dbPath: join(workspace, 'admin.db'),
  requireApprovalForWrites: false,
}))

section('装载')
check('工具已注册', ctx.toolsByName.size === 8, `实际 ${ctx.toolsByName.size}`)
check('管理路由已挂载', [...ctx.routes.keys()].includes('/api/lh-data/admin'), [...ctx.routes.keys()].join(','))

const imported = await call(ctx, 'dataset_import', { path: 'sales.csv', name: '销售表' })
check('导入样本数据集', imported.value.rowCount === 3, `实际 ${imported.value.rowCount}`)

// ── 阶段 2：聚合列表与工作区 ────────────────────────────────────────────────

section('聚合列表与工作区')
const scopes = await request(ctx, '/api/lh-data/admin/scopes')
check('GET /scopes → 200', scopes.status === 200, JSON.stringify(scopes.body))
check('工作区列表非空（含刚导入的工作区）', scopes.body.scopes.length >= 1, JSON.stringify(scopes.body))
const scopeKey = scopes.body.scopes[0].scopeKey

const listed = await request(ctx, '/api/lh-data/admin/datasets')
check('GET /datasets → 200', listed.status === 200, JSON.stringify(listed.body))
check('聚合列表含导入的数据集', listed.body.items.some(item => item.name === '销售表'), JSON.stringify(listed.body.items))
check('列表带工作区列', listed.body.items.some(item => item.scopeKey === scopeKey))

const found = listed.body.items.find(item => item.name === '销售表')
const detail = await request(ctx, `/api/lh-data/admin/datasets/${found.id}?scope=${encodeURIComponent(scopeKey)}`)
check('GET /datasets/:id?scope= → 200', detail.status === 200, JSON.stringify(detail.body))
check('详情含物理无关的列结构（3 列）', detail.body.columns.length === 3, JSON.stringify(detail.body.columns))

// ── 阶段 3：新建空数据集 ─────────────────────────────────────────────────────

section('新建空数据集')
const newBody = {
  scopeKey,
  name: '空白台账',
  description: '由设置页创建的空表',
  sourcePath: null,
  columns: [
    { name: '销售额', type: 'numeric' },
    { name: '地区', type: 'text' },
  ],
}
const created = await request(ctx, '/api/lh-data/admin/datasets', { method: 'POST', body: newBody })
check('POST /datasets → 201', created.status === 201, JSON.stringify(created.body))
check('新表列结构已冻结（2 列）', created.body.columns.length === 2, JSON.stringify(created.body.columns))
check('描述已落盘', created.body.description === '由设置页创建的空表', JSON.stringify(created.body.description))
const newId = created.body.id

const afterCreate = await request(ctx, '/api/lh-data/admin/datasets')
check('列表新增后数量 +1', afterCreate.body.items.length === listed.body.items.length + 1, `${listed.body.items.length} → ${afterCreate.body.items.length}`)

// ── 阶段 4：改名 / 改描述 / 改来源 ─────────────────────────────────────────

section('改名 / 改描述 / 改来源')
const patched = await request(ctx, `/api/lh-data/admin/datasets/${newId}?scope=${encodeURIComponent(scopeKey)}`, {
  method: 'PATCH',
  body: { name: '台账改名', description: '改后的说明', sourcePath: '/tmp/from-console.csv' },
})
check('PATCH → 200', patched.status === 200, JSON.stringify(patched.body))
check('名称已更新', patched.body.name === '台账改名', patched.body.name)
check('来源已更新', patched.body.sourcePath === '/tmp/from-console.csv', patched.body.sourcePath)

const dup = await request(ctx, '/api/lh-data/admin/datasets', {
  method: 'POST',
  body: { scopeKey, name: '台账改名', columns: [{ name: 'x', type: 'text' }] },
})
check('同工作区重名 → 409 DUPLICATE_NAME', dup.status === 409 && dup.body.error.code === 'DUPLICATE_NAME', JSON.stringify(dup.body))

// ── 阶段 5：改列的说明与样例 ────────────────────────────────────────────────

section('改列的说明与样例')
const first = detail.body.columns[0]
const second = detail.body.columns[1]
const urlOf = id => `/api/lh-data/admin/datasets/${id}?scope=${encodeURIComponent(scopeKey)}`
const pick = (body, key) => body.columns.find(column => column.sanitizedName === key)

const colPatch = await request(ctx, urlOf(found.id), {
  method: 'PATCH',
  body: { columns: [{ sanitizedName: first.sanitizedName, description: '产品名（人工补充说明）', sample: ['手机', '笔记本'] }] },
})
check('PATCH 列说明/样例 → 200', colPatch.status === 200, JSON.stringify(colPatch.body))
check('列说明已更新', pick(colPatch.body, first.sanitizedName)?.description === '产品名（人工补充说明）', JSON.stringify(pick(colPatch.body, first.sanitizedName)))
check('列样例已更新', JSON.stringify(pick(colPatch.body, first.sanitizedName)?.sample) === JSON.stringify(['手机', '笔记本']), JSON.stringify(pick(colPatch.body, first.sanitizedName)?.sample))

const reloaded = await request(ctx, urlOf(found.id))
const saved = pick(reloaded.body, first.sanitizedName)
check('列说明已落盘', saved?.description === '产品名（人工补充说明）', JSON.stringify(saved))
check('列名 / 类型 / 可空性未被改动', saved?.name === first.name && saved?.type === first.type && saved?.nullable === first.nullable, JSON.stringify(saved))
const untouched = pick(reloaded.body, second.sanitizedName)
check('未改动的列连同样例原样保留', untouched?.description === second.description && JSON.stringify(untouched?.sample) === JSON.stringify(second.sample), JSON.stringify(untouched))

const clamped = await request(ctx, urlOf(found.id), {
  method: 'PATCH',
  body: { columns: [{ sanitizedName: first.sanitizedName, sample: ['1', '2', '3', '4', '5', '6', '7'] }] },
})
check('样例个数被夹到 5', pick(clamped.body, first.sanitizedName)?.sample.length === 5, JSON.stringify(pick(clamped.body, first.sanitizedName)?.sample))

const nulled = await request(ctx, urlOf(found.id), {
  method: 'PATCH',
  body: { columns: [{ sanitizedName: first.sanitizedName, sample: ['甲', null, '丙'] }] },
})
check('样例支持 null', JSON.stringify(pick(nulled.body, first.sanitizedName)?.sample) === JSON.stringify(['甲', null, '丙']), JSON.stringify(pick(nulled.body, first.sanitizedName)?.sample))

const unknownColumn = await request(ctx, urlOf(found.id), {
  method: 'PATCH',
  body: { columns: [{ sanitizedName: '不存在的列', description: 'x' }] },
})
check('未知列 → 400 INVALID_COLUMNS', unknownColumn.status === 400 && unknownColumn.body.error.code === 'INVALID_COLUMNS', JSON.stringify(unknownColumn.body))

const badSample = await request(ctx, urlOf(found.id), {
  method: 'PATCH',
  body: { columns: [{ sanitizedName: first.sanitizedName, sample: 'not-an-array' }] },
})
check('样例非数组 → 400', badSample.status === 400, JSON.stringify(badSample.body))

// ── 阶段 6：删除 ────────────────────────────────────────────────────────────

section('删除')
const dropped = await request(ctx, `/api/lh-data/admin/datasets/${newId}?scope=${encodeURIComponent(scopeKey)}`, { method: 'DELETE' })
check('DELETE → 200 dropped=true', dropped.status === 200 && dropped.body.dropped === true, JSON.stringify(dropped.body))
const afterDelete = await request(ctx, `/api/lh-data/admin/datasets/${newId}?scope=${encodeURIComponent(scopeKey)}`)
check('删除后再取详情 → 404', afterDelete.status === 404, JSON.stringify(afterDelete.body))

// ── 阶段 7：错误与门禁 ──────────────────────────────────────────────────────

section('错误与门禁')
const unknownScope = await request(ctx, '/api/lh-data/admin/datasets', {
  method: 'POST',
  body: { scopeKey: '/no/such/workspace', name: 'x', columns: [{ name: 'x', type: 'text' }] },
})
check('未知工作区 → 404 SCOPE_UNKNOWN', unknownScope.status === 404 && unknownScope.body.error.code === 'SCOPE_UNKNOWN', JSON.stringify(unknownScope.body))

const badJson = await request(ctx, '/api/lh-data/admin/datasets', { method: 'POST', body: '{not-json' })
check('非法 JSON 请求体 → 400', badJson.status === 400, JSON.stringify(badJson.body))

const unauthorized = await request(ctx, '/api/lh-data/admin/scopes', { reject: 401 })
check('未通过浏览器鉴权 → 401', unauthorized.status === 401, JSON.stringify(unauthorized))
const forbidden = await request(ctx, '/api/lh-data/admin/scopes', { reject: 403 })
check('Host/Origin 不通过 → 403', forbidden.status === 403, JSON.stringify(forbidden))

const wrongMethod = await request(ctx, '/api/lh-data/admin/scopes', { method: 'PUT' })
check('非允许方法 → 405', wrongMethod.status === 405, JSON.stringify(wrongMethod))
const notFoundPath = await request(ctx, '/api/lh-data/admin/other')
check('路由外路径 → 404', notFoundPath.status === 404, JSON.stringify(notFoundPath))

// ── 阶段 8：只读模式与关闭接口 ──────────────────────────────────────────────

section('只读模式 / 关闭接口')
const roCtx = makeCtx()
apply(roCtx, validateConfig({ dbPath: join(workspace, 'admin.db'), readOnly: true }))
const roCreate = await request(roCtx, '/api/lh-data/admin/datasets', {
  method: 'POST',
  body: { scopeKey, name: '只读下尝试新建', columns: [{ name: 'x', type: 'text' }] },
})
check('只读模式 POST → 403 READ_ONLY', roCreate.status === 403 && roCreate.body.error.code === 'READ_ONLY', JSON.stringify(roCreate.body))
for (const dispose of roCtx.disposers) dispose()

const offCtx = makeCtx()
apply(offCtx, validateConfig({ dbPath: join(workspace, 'admin-off.db'), adminEnabled: false }))
const offScopes = await request(offCtx, '/api/lh-data/admin/scopes')
check('adminEnabled=false → 路由不注册 → 404', offScopes.status === 404, JSON.stringify(offScopes.body))
for (const dispose of offCtx.disposers) dispose()

// ── 收尾 ────────────────────────────────────────────────────────────────────

section('生命周期')
for (const dispose of ctx.disposers) dispose()
check('卸载后路由已注销', ctx.routes.size === 0, `剩余 ${ctx.routes.size}`)
closeAllDatabases()
try {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
} catch (error) {
  console.log(`  ! 临时目录清理失败（可手动删除 ${workspace}）：${error.message}`)
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('验证完成。')
