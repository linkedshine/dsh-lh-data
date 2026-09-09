/**
 * 数据源验证脚本：构造最小 dsh 运行时上下文（假 ctx），跑通
 * 「单元（加解密 / 列映射）→ 装载与门禁 → 工具（列表 / 测试 / 浏览 / 导入）
 * → 管理接口（增删改查 / 脱敏 / 鉴权 / 降级）→ 生命周期」。
 *
 * 脚本**不要求真的有 MySQL / PostgreSQL**：连接类断言同时接受「驱动未安装」
 * 与「连不上」两种结果。创建数据源一律带 `test: false`，因此可以在没有数据库
 * 的环境里验证持久化与脱敏。
 *
 * 运行：先 `pnpm run build`，再 `node examples/run-datasource.mjs`
 * 想跑真实导入：装上驱动（`pnpm add mysql2` 或 `pnpm add pg`），把脚本里的
 * `DEMO` 连接参数改成你的库，再执行 `node examples/run-datasource.mjs --live`。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  apply,
  buildColumns,
  closeAllConnectors,
  closeAllDatabases,
  decryptPassword,
  encryptPassword,
  isValidEncryptedFormat,
  mapRowKeys,
  resolveEncryptKey,
  validateConfig,
} from '../lib/index.js'

process.on('uncaughtException', (error) => {
  console.error('[uncaught]', error?.message, '\n', error?.stack)
  process.exit(1)
})

const LIVE = process.argv.includes('--live')
/** --live 模式下改成你自己的库；默认指向一个必然连不上的地址。 */
const DEMO = {
  name: 'demo-mysql',
  type: 'mysql',
  host: '127.0.0.1',
  port: 3399,
  database: 'demo',
  username: 'root',
  password: 'secret',
}

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

const workspace = resolve(mkdtempSync(join(tmpdir(), 'dsh-lh-data-ds-')))

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
      if (routes.has(route.path)) throw new Error(`webserver: duplicate route "${route.path}"`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const connection = { requestRejection() { return rejection } }

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

async function callTool(targetCtx, toolName, args) {
  const definition = targetCtx.toolsByName.get(toolName)
  if (definition === undefined) throw new Error(`未注册工具：${toolName}`)
  const value = await definition.execute(args, makeExec(toolName, args))
  const text = definition.output.render(args, value).map(block => block.text).join('\n')
  return { value, text }
}

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
  const response = { writeHead(code) { status = code }, end(b) { raw = b ?? '' } }
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

// ── 阶段 1：单元 ────────────────────────────────────────────────────────────

section('单元：密码加解密（datasource/crypto.ts）')
const key = resolveEncryptKey('unit-test-key')
const cipher = encryptPassword('p@ssw0rd!', key)
check('加密后是 iv:authTag:data 三段', isValidEncryptedFormat(cipher), cipher.slice(0, 24))
check('解密可还原明文', decryptPassword(cipher, key) === 'p@ssw0rd!')
check('空密码也能往返', decryptPassword(encryptPassword('', key), key) === '')
let decryptFailed = false
try {
  decryptPassword('not-a-cipher', key)
} catch {
  decryptFailed = true
}
check('密文格式非法时报错而非抛裸栈', decryptFailed)
check('未配置密钥时回落到内置默认密钥', resolveEncryptKey('').length > 0)

section('单元：远端列 → ColumnInfo（datasource/columns.ts）')
const columns = buildColumns([
  { name: '订单号', nativeType: 'text', nullable: false, comment: '业务主键' },
  { name: '金额', nativeType: 'numeric', nullable: true, comment: null },
  { name: '订单号', nativeType: 'text', nullable: false, comment: null },
])
check('列数 = 3', columns.length === 3)
check('重名列被去重为 _2', columns[2].sanitizedName === '订单号_2', columns[2].sanitizedName)
check('远端类型被直接采用', columns[1].type === 'numeric')
check('注释落到 description', columns[0].description === '业务主键')
// 重名列会被改写成 `原名_1` / `原名_2`，行键必须跟着改（`insertRows` 按 sanitizedName 取值）。
const mapped = mapRowKeys([{ 订单号: 'A-1', 金额: 12.5 }], columns)
check('行键改写为 sanitizedName', mapped[0]['订单号_1'] === 'A-1' && mapped[0]['金额'] === 12.5, JSON.stringify(mapped[0]))

// ── 阶段 2：装载与门禁 ──────────────────────────────────────────────────────

section('装载')
const ctx = makeCtx()
apply(ctx, validateConfig({
  dbPath: join(workspace, 'datasource.db'),
  requireApprovalForWrites: true,
  datasourceEncryptKey: 'example-key',
}))
check('8 个 dataset_* + 4 个 datasource_* 全部注册', ctx.toolsByName.size === 12, `实际 ${ctx.toolsByName.size}`)
check('数据源工具名齐全', ['datasource_list', 'datasource_test', 'datasource_tables', 'datasource_import']
  .every(name => ctx.toolsByName.has(name)))

section('门禁：tools/pre-execute')
const gate = (ctx.listeners.get('tools/pre-execute') ?? [])[0]
const allowNext = async () => ({ kind: 'allow' })
check('写工具 datasource_import → ask',
  (await gate(makeExec('datasource_import', { source: 'x', table: 't' }), allowNext))?.kind === 'ask')
check('读工具 datasource_list → allow',
  (await gate(makeExec('datasource_list', {}), allowNext))?.kind === 'allow')
check('datasource_import 缺 source 被单调守卫拒绝',
  ctx.guards.some(guard => typeof guard(makeExec('datasource_import', { table: 't' })) === 'string'))

const readOnlyCtx = makeCtx()
apply(readOnlyCtx, validateConfig({ dbPath: join(workspace, 'ro.db'), readOnly: true, datasourceEncryptKey: 'k' }))
const roDecision = await ((readOnlyCtx.listeners.get('tools/pre-execute') ?? [])[0])(
  makeExec('datasource_import', { source: 'x', table: 't' }), allowNext)
check('readOnly 模式 → deny', roDecision?.kind === 'deny', JSON.stringify(roDecision))
let roToolRejected = false
try {
  await callTool(readOnlyCtx, 'datasource_import', { source: 'x', table: 't' })
} catch (error) {
  roToolRejected = error.code === 'READ_ONLY'
}
check('readOnly 下工具自身也拒绝（READ_ONLY）', roToolRejected)
// readOnlyCtx 的路由还要在下面的「降级」阶段用，等到最后再 dispose。

// ── 阶段 3：工具（无真实数据库） ────────────────────────────────────────────

section('工具：datasource_list / test（空库）')
const emptyList = await callTool(ctx, 'datasource_list', {})
check('空列表返回 count=0', emptyList.value.count === 0)
check('空列表渲染出引导文案', emptyList.text.includes('还没有登记任何数据源'))

let notFoundCode = ''
try {
  await callTool(ctx, 'datasource_test', { source: 'nope' })
} catch (error) {
  notFoundCode = error.code
}
check('测试不存在的数据源 → NOT_FOUND', notFoundCode === 'NOT_FOUND', notFoundCode)

// ── 阶段 4：管理接口 ────────────────────────────────────────────────────────

section('管理接口：数据源 CRUD')
const empty = await request(ctx, '/api/lh-data/admin/sources')
check('GET /sources → 200 空列表', empty.status === 200 && empty.body.sources.length === 0, JSON.stringify(empty.body))

const created = await request(ctx, '/api/lh-data/admin/sources', {
  method: 'POST',
  body: { ...DEMO, test: false },
})
check('POST /sources（test:false）→ 201', created.status === 201, JSON.stringify(created.body))
const sourceId = created.body?.id ?? ''
check('返回体不含 password 字段', !('password' in (created.body ?? {})))
check('返回 hasPassword=true', created.body?.hasPassword === true)
check('类型与端口正确', created.body?.type === 'mysql' && created.body?.port === 3399)
check('状态为 unknown（还没测过）', created.body?.status === 'unknown')

const listed = await request(ctx, '/api/lh-data/admin/sources')
check('GET /sources → 1 条', listed.body.sources.length === 1)

const detail = await request(ctx, `/api/lh-data/admin/sources/${sourceId}`)
check('GET /sources/:id → 200', detail.status === 200 && detail.body.id === sourceId)
check('详情也不回显密码', !('password' in (detail.body ?? {})) && !('passwordEnc' in (detail.body ?? {})))

const renamed = await request(ctx, `/api/lh-data/admin/sources/${sourceId}`, {
  method: 'PATCH',
  body: { name: 'demo-renamed', description: '示例数据源', test: false },
})
check('PATCH 改名 → 200 且生效', renamed.status === 200 && renamed.body.name === 'demo-renamed')

const toolList = await callTool(ctx, 'datasource_list', {})
check('工具侧 datasource_list 能看到它', toolList.value.count === 1 && toolList.value.sources[0].id === sourceId)
check('工具侧也不回显密码', !('password' in toolList.value.sources[0]))

section('管理接口：连接失败与驱动缺失')
const badCreate = await request(ctx, '/api/lh-data/admin/sources', {
  method: 'POST',
  body: { ...DEMO, name: 'demo-bad', test: true },
})
check('POST（test:true）连不通 → 502/503',
  badCreate.status === 502 || badCreate.status === 503, JSON.stringify(badCreate.body))
check('错误码是 SOURCE_UNREACHABLE 或 DRIVER_MISSING',
  ['SOURCE_UNREACHABLE', 'DRIVER_MISSING'].includes(badCreate.body?.error?.code ?? ''), JSON.stringify(badCreate.body))
if (!LIVE && (badCreate.body?.error?.code ?? '') === 'DRIVER_MISSING') {
  check('驱动缺失时给出安装提示', badCreate.body.error.message.includes('pnpm add'), badCreate.body.error.message)
}

let tablesError = ''
try {
  await callTool(ctx, 'datasource_tables', { source: sourceId })
} catch (error) {
  tablesError = `${error.code}: ${error.message}`
}
check('datasource_tables 连不上 → 可读错误',
  tablesError.startsWith('DRIVER_MISSING') || tablesError.startsWith('UNREACHABLE') || tablesError.startsWith('BAD_REQUEST'),
  tablesError)

section('管理接口：校验与鉴权')
const badBody = await request(ctx, '/api/lh-data/admin/sources', {
  method: 'POST',
  body: { ...DEMO, name: 'x', type: 'oracle', test: false },
})
check('非法类型 → 400 BAD_REQUEST', badStatus(badBody), JSON.stringify(badBody.body))

const noScope = await request(ctx, `/api/lh-data/admin/sources/${sourceId}/import`, {
  method: 'POST',
  body: { tableName: 't' },
})
check('导入缺 scopeKey → 400', badStatus(noScope), JSON.stringify(noScope.body))

const unknownImport = await request(ctx, '/api/lh-data/admin/sources/nope/import', {
  method: 'POST',
  body: { scopeKey: 'whatever', tableName: 't' },
})
check('导入未知数据源 → 404 NOT_FOUND',
  unknownImport.status === 404 && unknownImport.body?.error?.code === 'NOT_FOUND', JSON.stringify(unknownImport.body))

const unauthorized = await request(ctx, '/api/lh-data/admin/sources', { reject: 401 })
check('未鉴权 → 401 UNAUTHORIZED', unauthorized.status === 401)

function badStatus(response) {
  return response.status === 400 && response.body?.error?.code === 'BAD_REQUEST'
}

section('降级：datasourceEnabled=false / readOnly')
const offCtx = makeCtx()
apply(offCtx, validateConfig({ dbPath: join(workspace, 'off.db'), datasourceEnabled: false }))
const offSources = await request(offCtx, '/api/lh-data/admin/sources')
check('GET /sources → 403 SOURCE_DISABLED',
  offSources.status === 403 && offSources.body?.error?.code === 'SOURCE_DISABLED', JSON.stringify(offSources.body))
check('数据源工具未注册', !offCtx.toolsByName.has('datasource_list'))
for (const dispose of offCtx.disposers) dispose()

const roCreate = await request(readOnlyCtx, '/api/lh-data/admin/sources', {
  method: 'POST',
  body: { ...DEMO, name: 'ro', test: false },
})
check('readOnly 下新建 → 403 READ_ONLY',
  roCreate.status === 403 && roCreate.body?.error?.code === 'READ_ONLY', JSON.stringify(roCreate.body))
for (const dispose of readOnlyCtx.disposers) dispose()

// ── 阶段 5：删除与生命周期 ──────────────────────────────────────────────────

section('删除与生命周期')
const removed = await request(ctx, `/api/lh-data/admin/sources/${sourceId}`, { method: 'DELETE' })
check('DELETE /sources/:id → 200', removed.status === 200 && removed.body.deleted === true)
const afterDelete = await request(ctx, '/api/lh-data/admin/sources')
check('删除后列表为空', afterDelete.body.sources.length === 0)

if (LIVE) {
  section('真实导入（--live）')
  const live = await request(ctx, '/api/lh-data/admin/sources', { method: 'POST', body: { ...DEMO, test: true } })
  check('POST（test:true）连上真实库 → 201', live.status === 201, JSON.stringify(live.body))
  const liveId = live.body?.id ?? ''
  const liveTables = await request(ctx, `/api/lh-data/admin/sources/${liveId}/tables`)
  check('GET tables → 200 且有表', liveTables.status === 200 && liveTables.body.tables.length > 0, JSON.stringify(liveTables.body).slice(0, 200))
  const first = liveTables.body.tables[0]?.tableName
  if (first !== undefined) {
    const imported = await request(ctx, `/api/lh-data/admin/sources/${liveId}/import`, {
      method: 'POST',
      body: { scopeKey: workspace, tableName: first, schemaName: liveTables.body.schema },
    })
    check('POST import → 201 且返回 datasetId', imported.status === 201 && typeof imported.body.datasetId === 'string', JSON.stringify(imported.body))
  }
}

for (const dispose of ctx.disposers) dispose()
closeAllDatabases()
await closeAllConnectors()

try {
  rmSync(workspace, { recursive: true, force: true })
} catch {
  console.log(`  ! 临时目录清理失败（可手动删除 ${workspace}）`)
}

console.log(`\nRESULT passed=${passed} failed=${failures.length}`)
if (failures.length > 0) {
  console.log('失败项：', failures.join(' / '))
  process.exitCode = 1
}
