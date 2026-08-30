/**
 * 结果视图验证脚本（设计文档 §12）：构造带假 `webServer` / `connection` 的最小 ctx，
 * 跑通「大结果集 → 模型只拿片段 → 前端按 viewId 分页取完全量 → 鉴权/过期/降级」。
 *
 * 运行：先 `pnpm run build`，再 `node examples/run-view.mjs`
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

const sleep = ms => new Promise(done => setTimeout(done, ms))

// ── 准备临时工作区与大结果集 ──────────────────────────────────────────────

const workspace = resolve(mkdtempSync(join(tmpdir(), 'dsh-lh-data-view-')))
const ROW_COUNT = 1234
const rows = ['名称,数量,分组']
for (let index = 1; index <= ROW_COUNT; index += 1) {
  rows.push(`物料${index},${index},${index % 3 === 0 ? '甲' : index % 3 === 1 ? '乙' : '丙'}`)
}
writeFileSync(join(workspace, 'big.csv'), `${rows.join('\n')}\n`)

// ── 假 ctx：webServer 路由表 + connection 鉴权 ────────────────────────────

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
  const connection = {
    requestRejection() {
      return rejection
    },
  }
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
    // 测试钩子
    setRejection(status) {
      rejection = status
    },
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

/** 走假路由发一次 HTTP 请求（GET/DELETE）。 */
async function request(targetCtx, url, { method = 'GET', reject } = {}) {
  targetCtx.setRejection(reject)
  let status = 0
  let raw = ''
  const response = {
    writeHead(code) {
      status = code
    },
    end(body) {
      raw = body ?? ''
    },
  }
  const pathname = url.split('?')[0]
  const route = [...targetCtx.routes.values()].find(entry => pathname.startsWith(entry.path))
  if (route === undefined) {
    targetCtx.setRejection(undefined)
    return { status: 404, body: { error: { code: 'NO_ROUTE' } } }
  }
  await route.handler({ method, url, headers: {} }, response)
  targetCtx.setRejection(undefined)
  return { status, body: raw.length > 0 ? JSON.parse(raw) : null }
}

// ── 阶段 1：装配并导入大结果集 ────────────────────────────────────────────

const ctx = makeCtx()
apply(ctx, validateConfig({
  dbPath: join(workspace, 'view.db'),
  requireApprovalForWrites: false,
  previewRows: 5,
  defaultPageSize: 100,
}))

section('装载')
check('工具已注册', ctx.toolsByName.size === 8, `实际 ${ctx.toolsByName.size}`)
check('视图路由已挂载', [...ctx.routes.keys()].includes('/api/lh-data/views'), [...ctx.routes.keys()].join(','))

const imported = await call(ctx, 'dataset_import', { path: 'big.csv' })
check(`导入 ${ROW_COUNT} 行`, imported.value.rowCount === ROW_COUNT, `实际 ${imported.value.rowCount}`)
const datasetId = imported.value.datasetId

// ── 阶段 2：查询只返回片段 ────────────────────────────────────────────────

section('查询：模型只拿片段')
const queried = await call(ctx, 'dataset_query', { dataset: datasetId })
console.log(queried.text.split('\n').slice(0, 12).join('\n'))
check('totalRows = 全量行数', queried.value.totalRows === ROW_COUNT, `实际 ${queried.value.totalRows}`)
check('预览行数 = previewRows', queried.value.preview.rows.length === 5, `实际 ${queried.value.preview.rows.length}`)
check('已生成视图', typeof queried.value.view?.viewId === 'string', JSON.stringify(queried.value.view))
check('片段被标记为不完整', queried.value.truncated === true)
check('生成了列摘要', queried.value.summary.length >= 3, `实际 ${queried.value.summary.length}`)
check('摘要覆盖全量（数量 max = 1234）', queried.value.summary.some(entry => entry.name === '数量' && entry.max === ROW_COUNT), JSON.stringify(queried.value.summary.find(entry => entry.name === '数量')))
check('文本片段远小于全量', queried.text.length < 3000, `实际 ${queried.text.length} 字符（全量约 ${JSON.stringify(rows).length}）`)
check('模型文本不含 viewId', !queried.text.includes(queried.value.view.viewId))
check('模型文本不含物理表名', !/d_[a-z0-9]{8}_/.test(queried.text))

section('查询：presentationMeta（UI 专用）')
check('meta 是 dataset-view', queried.meta?.kind === 'dataset-view', JSON.stringify(queried.meta))
check('meta 带 endpoint 与 totalRows', queried.meta?.endpoint?.includes(queried.value.view.viewId) && queried.meta.totalRows === ROW_COUNT, JSON.stringify(queried.meta))
check('meta 的排序白名单只含已登记列', (queried.meta?.sortable ?? []).every(name => ['名称', '数量', '分组'].includes(name)), JSON.stringify(queried.meta?.sortable))

// ── 阶段 3：前端按 viewId 翻完全量 ────────────────────────────────────────

section('分页：逐页取完并与全量比对')
const viewId = queried.value.view.viewId
const pageSize = 100
const totalPages = Math.ceil(ROW_COUNT / pageSize)
const seen = []
for (let page = 1; page <= totalPages; page += 1) {
  const response = await request(ctx, `/api/lh-data/views/${viewId}/rows?page=${page}&pageSize=${pageSize}`)
  if (response.status !== 200) {
    check(`第 ${page} 页返回 200`, false, JSON.stringify(response.body))
    break
  }
  seen.push(...response.body.rows)
}
check('翻页总数 = totalRows', seen.length === ROW_COUNT, `实际 ${seen.length}`)
check('行不重复（按 _row_id）', new Set(seen.map(row => row._row_id)).size === ROW_COUNT, `实际 ${new Set(seen.map(row => row._row_id)).size}`)
check('顺序与全量一致（数量 = 1..N）', seen.every((row, index) => row.数量 === index + 1), JSON.stringify(seen.slice(0, 3)))
check('末页行数 = 34', (await request(ctx, `/api/lh-data/views/${viewId}/rows?page=${totalPages}&pageSize=${pageSize}`)).body.rows.length === ROW_COUNT % pageSize || ROW_COUNT % pageSize === 0)

section('分页：排序与参数夹紧')
const desc = await request(ctx, `/api/lh-data/views/${viewId}/rows?page=1&pageSize=10&sort=数量&order=desc`)
check('按数量降序首页 = 1234 起', desc.status === 200 && desc.body.rows[0]?.数量 === ROW_COUNT, JSON.stringify(desc.body.rows[0]))
const clamped = await request(ctx, `/api/lh-data/views/${viewId}/rows?page=1&pageSize=99999`)
check('pageSize 被夹到 maxPageSize(500)', clamped.body.pageSize === 500, JSON.stringify(clamped.body.pageSize))
const meta = await request(ctx, `/api/lh-data/views/${viewId}`)
check('视图元信息接口可用', meta.status === 200 && meta.body.totalRows === ROW_COUNT, JSON.stringify(meta.status))

// ── 阶段 4：错误与鉴权 ────────────────────────────────────────────────────

section('错误与鉴权')
const missing = await request(ctx, '/api/lh-data/views/vw_does_not_exist/rows')
check('未知 viewId → 404', missing.status === 404 && missing.body.error.code === 'VIEW_NOT_FOUND', JSON.stringify(missing))
const badSort = await request(ctx, `/api/lh-data/views/${viewId}/rows?sort=_row_id`)
check('非白名单排序列 → 400', badSort.status === 400 && badSort.body.error.code === 'BAD_REQUEST', JSON.stringify(badSort))
const unauthorized = await request(ctx, `/api/lh-data/views/${viewId}/rows`, { reject: 401 })
check('未通过浏览器鉴权 → 401', unauthorized.status === 401, JSON.stringify(unauthorized))
const forbidden = await request(ctx, `/api/lh-data/views/${viewId}/rows`, { reject: 403 })
check('Host/Origin 不通过 → 403', forbidden.status === 403, JSON.stringify(forbidden))
const wrongMethod = await request(ctx, `/api/lh-data/views/${viewId}/rows`, { method: 'POST' })
check('非 GET/DELETE → 405', wrongMethod.status === 405, JSON.stringify(wrongMethod))
const notFoundPath = await request(ctx, '/api/lh-data/other')
check('路由外路径 → 404', notFoundPath.status === 404, JSON.stringify(notFoundPath))

section('释放视图')
const released = await request(ctx, `/api/lh-data/views/${viewId}`, { method: 'DELETE' })
check('DELETE 释放视图', released.status === 200 && released.body.revoked === true, JSON.stringify(released))
check('释放后再取 → 404', (await request(ctx, `/api/lh-data/views/${viewId}/rows`)).status === 404)

// ── 阶段 5：TTL 过期 ──────────────────────────────────────────────────────

section('TTL 过期')
const ttlCtx = makeCtx()
apply(ttlCtx, validateConfig({ dbPath: join(workspace, 'ttl.db'), requireApprovalForWrites: false, viewTtlMs: 50 }))
const ttlImported = await call(ttlCtx, 'dataset_import', { path: 'big.csv', name: 'ttl' })
const ttlQuery = await call(ttlCtx, 'dataset_query', { dataset: ttlImported.value.datasetId })
check('TTL 场景下仍生成视图', typeof ttlQuery.value.view?.viewId === 'string')
await sleep(120)
const expired = await request(ttlCtx, `/api/lh-data/views/${ttlQuery.value.view.viewId}/rows`)
check('过期后 → 404', expired.status === 404, JSON.stringify(expired))
for (const dispose of ttlCtx.disposers) dispose()
closeAllDatabases()

// ── 阶段 6：无 webServer 时降级 ───────────────────────────────────────────

section('降级：无 webServer / connection')
const plainCtx = makeCtx({ webServer: false })
apply(plainCtx, validateConfig({ dbPath: join(workspace, 'plain.db'), requireApprovalForWrites: false }))
const plainImported = await call(plainCtx, 'dataset_import', { path: 'big.csv', name: 'plain' })
const plainQuery = await call(plainCtx, 'dataset_query', { dataset: plainImported.value.datasetId })
check('不注册路由', plainCtx.routes.size === 0, `${plainCtx.routes.size} 条`)
check('不生成视图', plainQuery.value.view === undefined, JSON.stringify(plainQuery.value.view))
check('退化为截断片段（沿用旧默认 50 行）', plainQuery.value.preview.rows.length === 50 && plainQuery.value.truncated === true, `实际 ${plainQuery.value.preview.rows.length} 行`)
check('降级时仍有摘要', plainQuery.value.summary.length > 0)
for (const dispose of plainCtx.disposers) dispose()

// ── 收尾 ──────────────────────────────────────────────────────────────────

section('生命周期')
for (const dispose of ctx.disposers) dispose()
check('卸载后路由已注销', ctx.routes.size === 0, `剩余 ${ctx.routes.size}`)
check('卸载后工具已注销', ctx.toolsByName.size === 0, `剩余 ${ctx.toolsByName.size}`)
closeAllDatabases()
try {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
} catch (error) {
  console.log(`  ! 临时目录清理失败（可手动删除 ${workspace}）：${error.message}`)
}

console.log(`RESULT passed=${passed} failed=${failures.length}`)
console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('验证完成。')
