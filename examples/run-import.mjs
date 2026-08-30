/**
 * 自包含验证脚本：构造最小 dsh 运行时上下文（假 ctx），加载 dsh-lh-data 的
 * apply()，跑通「单元校验 → 导入 → list → schema → query → insert → update
 * → delete → drop」，并检查写操作的审批门禁（设计文档 §11）。
 *
 * 运行：先 `npm run build`，再 `node examples/run-import.mjs`
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as XLSX from 'xlsx'
import {
  apply,
  assertPhysicalTableName,
  closeAllDatabases,
  generateTableName,
  inferColumnType,
  resolveInputFile,
  validateConfig,
  validateReadOnlyQuery,
} from '../lib/index.js'

process.on('uncaughtException', (error) => {
  console.error('[uncaught]', error?.message, '\n', error?.stack)
  process.exit(1)
})
process.on('unhandledRejection', (error) => {
  console.error('[unhandled]', error?.message, '\n', error?.stack)
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

// ── 准备临时工作区与样例文件 ──────────────────────────────────────────────

const workspace = resolve(mkdtempSync(join(tmpdir(), 'dsh-lh-data-')))
const xlsxPath = join(workspace, 'sales.xlsx')
const csvPath = join(workspace, 'extra.csv')

const worksheet = XLSX.utils.aoa_to_sheet([
  ['物料编码', '名称', '数量', '单价', '是否加急'],
  ['6901234567890', '钢板', 3, 12.5, true],
  ['6901234567891', '螺栓', 120, 0.75, false],
  ['6901234567892', '垫片', 40, 1.2, false],
])
const workbook = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
writeFileSync(xlsxPath, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))

writeFileSync(csvPath, '名称,数量\n螺母,60\n垫圈,80\n')

// ── 阶段 0：单元校验 ──────────────────────────────────────────────────────

section('单元：只读校验器（sql.ts）')
const allowed = ['d_ab12cd34_sales_x1y2z3']
try {
  validateReadOnlyQuery('WITH x AS (SELECT * FROM d_ab12cd34_sales_x1y2z3) DELETE FROM d_ab12cd34_sales_x1y2z3', { allowedTables: allowed, maxRows: 200 })
  check('WITH … DELETE 被拒绝', false, '未抛错')
} catch {
  check('WITH … DELETE 被拒绝', true)
}
try {
  const ok = validateReadOnlyQuery("SELECT * FROM d_ab12cd34_sales_x1y2z3 WHERE name = 'DROP'", { allowedTables: allowed, maxRows: 200 })
  check("含 'DROP' 字符串字面量的 SELECT 放行并补 LIMIT", ok.endsWith('LIMIT 200'), ok)
} catch (error) {
  check("含 'DROP' 字符串字面量的 SELECT 放行并补 LIMIT", false, error.message)
}
try {
  validateReadOnlyQuery('SELECT 1; DROP TABLE d_ab12cd34_sales_x1y2z3', { allowedTables: allowed, maxRows: 200 })
  check('多语句被拒绝', false, '未抛错')
} catch {
  check('多语句被拒绝', true)
}
try {
  validateReadOnlyQuery('EXPLAIN SELECT * FROM d_ab12cd34_sales_x1y2z3', { allowedTables: allowed, maxRows: 200 })
  check('EXPLAIN 放行', true)
} catch (error) {
  check('EXPLAIN 放行', false, error.message)
}
try {
  validateReadOnlyQuery('SELECT * FROM other_table', { allowedTables: allowed, maxRows: 200 })
  check('未登记的表被拒绝', false, '未抛错')
} catch {
  check('未登记的表被拒绝', true)
}

section('单元：类型推断与表名（parse.ts / store.ts）')
check('13+ 位数字列 → text', inferColumnType(['6901234567890', '6901234567891'], '物料编码') === 'text')
check('列名含「编码」→ text', inferColumnType(['1', '2'], '物料编码') === 'text')
check('1.78E+12 → text', inferColumnType(['1.78278E+12'], '数值') === 'text')
check('普通数字列 → numeric', inferColumnType(['1.5', '2', '3'], '单价') === 'numeric')
check('物理表名正则通过', (() => {
  const name = generateTableName('sales.xlsx', 'ab12cd34')
  assertPhysicalTableName(name)
  return /^d_ab12cd34_sales_[a-z0-9]+$/.test(name)
})())
check('非法物理表名被拒绝', (() => {
  try {
    assertPhysicalTableName('users; DROP TABLE x')
    return false
  } catch {
    return true
  }
})())

section('单元：路径解析（scope.ts）')
check('相对路径基于 cwd', resolveInputFile(workspace, 'sales.xlsx') === resolveInputFile(workspace, xlsxPath))
try {
  resolveInputFile(workspace, '../outside.csv')
  check('../ 越界被拒绝', false, '未抛错')
} catch {
  check('../ 越界被拒绝', true)
}
try {
  resolveInputFile(workspace, 'notes.txt')
  check('非白名单扩展名被拒绝', false, '未抛错')
} catch {
  check('非白名单扩展名被拒绝', true)
}

// ── 阶段 1：装配插件 ──────────────────────────────────────────────────────

function makeCtx(options = {}) {
  const listeners = new Map()
  const tools = new Map()
  const guards = []
  const disposers = []
  // 假的 dsh 工具注册表：register/guard 与真实 ctx.tools 同签名。
  const registry = {
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
  }
  return {
    listeners,
    tools: registry,
    toolsByName: tools,
    guards,
    disposers,
    logger: { info() {}, warn: message => console.warn('  [warn]', message) },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    emit() {},
    async fire(event, ...args) {
      for (const handler of listeners.get(event) ?? []) {
        const result = await handler(...args)
        if (result) return result
      }
      return null
    },
    effect(setup) {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => (typeof dispose === 'function' ? dispose() : undefined)
    },
    // 可选依赖：默认都不提供（验证降级路径）；按需注入 jobs / systemPrompt。
    inject(deps, callback) {
      if (deps.includes('jobs') && options.jobs !== undefined) callback({ jobs: options.jobs })
      if (deps.includes('systemPrompt') && options.systemPrompt !== undefined) callback({ systemPrompt: options.systemPrompt })
    },
  }
}

const ctx = makeCtx()
const config = validateConfig({
  dbPath: join(workspace, 'lh-data.db'),
  requireApprovalForWrites: true,
  readOnly: false,
})
apply(ctx, config)

section('装载')
check('八个工具已注册', ctx.toolsByName.size === 8, `实际 ${ctx.toolsByName.size}`)
check('物理表名未出现在任何工具描述中', ![...ctx.toolsByName.values()].some(definition => /d_[a-z0-9]{8}_/.test(definition.description)))

const injected = []
function makeExec(toolName, args) {
  return {
    name: toolName,
    arguments: args,
    agent: {
      id: 'agent-1',
      // 与真实 dsh 一致：cwd 挂在 SessionHeader 上（session.header.cwd）。
      session: { header: { cwd: workspace, id: 'session-1' } },
      inject: message => injected.push(message),
    },
    signal: new AbortController().signal,
    deferContext() {},
  }
}

async function callOn(targetCtx, toolName, args) {
  const definition = targetCtx.toolsByName.get(toolName)
  if (definition === undefined) throw new Error(`未注册工具：${toolName}`)
  const exec = makeExec(toolName, args)
  const value = await definition.execute(args, exec)
  const text = definition.output.render(args, value).map(block => block.text).join('\n')
  return { value, text }
}

async function call(toolName, args) {
  return callOn(ctx, toolName, args)
}

// ── 阶段 2：审批门禁 ──────────────────────────────────────────────────────

section('门禁：tools/pre-execute')
const gate = (ctx.listeners.get('tools/pre-execute') ?? [])[0]
const allowNext = async () => ({ kind: 'allow' })
check('写工具 dataset_insert → ask', (await gate(makeExec('dataset_insert', { dataset: 'x', rows: [] }), allowNext))?.kind === 'ask')
check('写工具 dataset_import → ask', (await gate(makeExec('dataset_import', { path: 'a.csv' }), allowNext))?.kind === 'ask')
check('读工具 dataset_list → allow', (await gate(makeExec('dataset_list', {}), allowNext))?.kind === 'allow')
check('写工具缺少归属句柄被单调守卫拒绝', ctx.guards.some(guard => typeof guard(makeExec('dataset_drop', {})) === 'string'))
check('非本插件工具不受守卫影响', ctx.guards.every(guard => guard(makeExec('bash', { command: 'ls' })) === undefined))

const readOnlyCtx = makeCtx()
apply(readOnlyCtx, validateConfig({ dbPath: join(workspace, 'readonly.db'), readOnly: true }))
const readOnlyGate = (readOnlyCtx.listeners.get('tools/pre-execute') ?? [])[0]
const readOnlyDecision = await readOnlyGate(makeExec('dataset_drop', { dataset: 'x' }), allowNext)
check('readOnly 模式写操作 → deny', readOnlyDecision?.kind === 'deny', JSON.stringify(readOnlyDecision))

// ── 阶段 3：全链路 ────────────────────────────────────────────────────────

section('集成：dataset_import（xlsx）')
const imported = await call('dataset_import', { path: 'sales.xlsx' })
console.log(imported.text.split('\n').slice(0, 8).join('\n'))
check('导入完成且状态 ready', imported.value.status === 'ready')
check('行数 = 3', imported.value.rowCount === 3, `实际 ${imported.value.rowCount}`)
check('物料编码列被推断为 text', imported.value.columns.some(column => column.name === '物料编码' && column.type === 'text'))
check('数量列被推断为 numeric', imported.value.columns.some(column => column.name === '数量' && column.type === 'numeric'))
const datasetId = imported.value.datasetId

section('集成：dataset_list')
const listed = await call('dataset_list', {})
console.log(listed.text)
check('列表包含刚导入的数据集', listed.value.datasets.some(item => item.datasetId === datasetId))

section('集成：dataset_schema')
const schema = await call('dataset_schema', { dataset: datasetId })
console.log(schema.text)
check('列数 = 5', schema.value.columns.length === 5, `实际 ${schema.value.columns.length}`)

section('集成：dataset_query（结构化）')
const queried = await call('dataset_query', { dataset: datasetId, columns: ['名称', '数量'], where: '数量 >= 40', orderBy: '数量 DESC' })
console.log(queried.text)
check('结构化查询命中 2 行', queried.value.totalRows === 2, `实际 ${queried.value.totalRows}`)
check('小结果集不建视图（片段即全量）', queried.value.view === undefined && queried.value.preview.rows.length === 2, JSON.stringify(queried.value.view))
check('排序生效（螺栓 120 在前）', queried.value.preview.rows[0]?.名称 === '螺栓', JSON.stringify(queried.value.preview.rows[0]))

section('集成：dataset_query（原始 sql，用 ds 别名）')
const bySql = await call('dataset_query', { dataset: datasetId, sql: 'SELECT 名称, 数量 FROM ds WHERE 数量 > 10 ORDER BY 数量 DESC' })
console.log(bySql.text)
check('sql 分支命中 2 行', bySql.value.totalRows === 2, `实际 ${bySql.value.totalRows}`)
check('结果不含物理表名', !JSON.stringify(bySql.value).includes('d_'))

section('集成：dataset_insert / update / delete')
const inserted = await call('dataset_insert', { dataset: datasetId, rows: [{ 物料编码: '6901234567893', 名称: '焊条', 数量: 15, 单价: 3.2, 是否加急: false }] })
console.log(inserted.text)
check('插入 1 行后共 4 行', inserted.value.rowCount === 4, `实际 ${inserted.value.rowCount}`)

const newRow = (await call('dataset_query', { dataset: datasetId, where: '名称 = \'焊条\'' })).value.preview.rows[0]
const updated = await call('dataset_update', { dataset: datasetId, rowId: newRow._row_id, data: { 单价: 4.5 } })
console.log(updated.text)
check('更新成功', updated.value.updated === true)
const afterUpdate = (await call('dataset_query', { dataset: datasetId, where: '名称 = \'焊条\'' })).value.preview.rows[0]
check('单价已改为 4.5', Number(afterUpdate.单价) === 4.5, String(afterUpdate.单价))

const deleted = await call('dataset_delete', { dataset: datasetId, rowId: newRow._row_id })
console.log(deleted.text)
check('删除后剩 3 行', deleted.value.rowCount === 3, `实际 ${deleted.value.rowCount}`)

try {
  await call('dataset_update', { dataset: datasetId, rowId: 999999, data: { 单价: 1 } })
  check('更新不存在的行报错', false, '未抛错')
} catch (error) {
  check('更新不存在的行报错', String(error.message).includes('999999'), error.message)
}

section('集成：CSV 导入 + 越界拒绝 + dataset_drop')
const csvImported = await call('dataset_import', { path: join(workspace, 'extra.csv') })
check('CSV 导入 2 行', csvImported.value.rowCount === 2, `实际 ${csvImported.value.rowCount}`)
try {
  await call('dataset_import', { path: join(tmpdir(), 'outside-sales.xlsx') })
  check('工作区外的文件被拒绝', false, '未抛错')
} catch (error) {
  check('工作区外的文件被拒绝', String(error.message).includes('工作区目录内'), error.message)
}

const dropped = await call('dataset_drop', { dataset: csvImported.value.datasetId })
console.log(dropped.text)
const afterDrop = await call('dataset_list', {})
check('删除后列表只剩 1 个数据集', afterDrop.value.count === 1, `实际 ${afterDrop.value.count}`)
try {
  await call('dataset_query', { dataset: csvImported.value.datasetId })
  check('已删除的数据集不可查询', false, '未抛错')
} catch (error) {
  check('已删除的数据集不可查询', String(error.message).includes('未找到数据集'), error.message)
}

section('集成：后台导入（ctx.jobs）')
const injectedBefore = injected.length
const jobs = {
  counter: 0,
  hooks: new Map(),
  start(spec) {
    this.counter += 1
    const id = `${spec.kind}-${this.counter}`
    this.hooks.set(id, spec.run())
    return id
  },
}
const bgCtx = makeCtx({ jobs })
apply(bgCtx, validateConfig({ dbPath: join(workspace, 'bg.db') }))
const bgImport = await callOn(bgCtx, 'dataset_import', { path: 'sales.xlsx', name: 'bg-sales', background: true })
console.log(bgImport.text.split('\n')[0])
check('后台导入立即返回 jobId 与 running', bgImport.value.status === 'running' && typeof bgImport.value.jobId === 'string', JSON.stringify(bgImport.value))
const outcome = await jobs.hooks.get(bgImport.value.jobId).done
check('后台任务完成', outcome.status === 'completed', JSON.stringify(outcome))
check('完成后回注通知', injected.length > injectedBefore, `新增 ${injected.length - injectedBefore} 条`)
const bgList = await callOn(bgCtx, 'dataset_list', {})
check('后台导入后状态 ready 且 3 行', bgList.value.datasets[0]?.status === 'ready' && bgList.value.datasets[0]?.rowCount === 3, JSON.stringify(bgList.value.datasets[0]))

// ── 阶段 4：作用域解析（session.header.cwd / fail-loud） ───────────────────

section('集成：作用域解析')
const scopeCtx = makeCtx()
apply(scopeCtx, validateConfig({ dbPath: join(workspace, 'scope.db'), requireApprovalForWrites: false }))

async function importWithAgent(agent, args) {
  const definition = scopeCtx.toolsByName.get('dataset_import')
  const exec = { name: 'dataset_import', arguments: args, agent, signal: new AbortController().signal, deferContext() {} }
  return definition.execute(args, exec)
}

// 真实 dsh 运行时的形状：cwd 挂在 SessionHeader 上（Agent.session 是 Session）。
const headerAgent = { id: 'agent-1', session: { header: { cwd: workspace, id: 'session-1' } }, inject() {} }
check(
  'session.header.cwd 生效（相对路径按会话 cwd 解析）',
  (await importWithAgent(headerAgent, { path: 'sales.xlsx', name: 'scope-header' })).status === 'ready',
)

// 旧约定 / headless 的扁平形状仍兼容。
const flatAgent = { id: 'agent-1', session: { cwd: workspace, id: 'session-1' }, inject() {} }
check(
  '扁平 session.cwd 仍兼容',
  (await importWithAgent(flatAgent, { path: 'sales.xlsx', name: 'scope-flat' })).status === 'ready',
)

// fail-loud：拿不到会话 cwd 时必须报错，绝不静默回落到 process.cwd()（dsh 启动目录）。
const noCwdAgent = { id: 'agent-1', session: { header: { id: 'session-1' } }, inject() {} }
try {
  await importWithAgent(noCwdAgent, { path: 'sales.xlsx' })
  check('缺 cwd 时 fail-loud（不回落 process.cwd）', false, '未抛错')
} catch (error) {
  check('缺 cwd 时 fail-loud（不回落 process.cwd）', String(error.message).includes('无法解析工作区目录'), error.message)
}

// ── 收尾 ──────────────────────────────────────────────────────────────────

section('生命周期')
for (const dispose of [...ctx.disposers, ...readOnlyCtx.disposers, ...bgCtx.disposers, ...scopeCtx.disposers]) dispose()
check('卸载后工具全部注销', ctx.toolsByName.size === 0, `剩余 ${ctx.toolsByName.size}`)
closeAllDatabases()
try {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
} catch (error) {
  // libSQL 本地客户端在 Windows 上释放文件句柄较晚（close() 后仍短暂占用），
  // 属上游已知现象，不影响插件本身；临时目录留在 %TEMP% 下，可手动清理。
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
