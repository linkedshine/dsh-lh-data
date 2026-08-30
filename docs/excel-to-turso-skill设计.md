# 插件设计文档：`dsh-lh-data`（Excel → 本地 Turso 导入与 CRUD）

> 版本：v2（v1 设计的平台迁移重写稿，不含实现代码）
> 主工程：`D:\fastwork\projects\node\deepseek-harness`（下称 dsh）
> 插件模板参考：`D:\fastwork\projects\node\dsh-lh-judge`
> 数据层参考实现：`D:\fastwork\projects\js\agentic-data-mini`
> 目标：给 dsh 的 agent 一组对话可用的工具，把工作区的 Excel/CSV **导入本地 Turso（libSQL）**，并对其进行**增删改查（CRUD）**。

---

## 0. v1 → v2 变更摘要

v1 把本能力设计成 `agentic-data-mini` 的 **Instructions-as-Skill 插件**（`SKILL.md` + `PluginEngine.registerTool`）。v2 把它重新落位为 **dsh 的原生 cordis 插件**，与 `dsh-lh-judge` 同构。

| 维度 | v1（agentic-data-mini Skill） | v2（dsh 插件 `dsh-lh-data`） |
| --- | --- | --- |
| 宿主 | Next.js Web 应用，多租户 `userId` | dsh 运行时（cordis），Agent / Session / Workspace |
| 插件形态 | `skills/excel-to-turso/SKILL.md` + `registerTool` | 独立 npm 包：`name` / `Config` / `inject` / `apply`，tsdown 构建到 `lib/` |
| 工具定义 | `ToolDefinition { description, parameters: zod, execute }` | `defineTool({ name, description, parameters, output, execute })`，`ctx.tools.register()` |
| 指令注入 | SKILL.md 正文注入 system prompt | `ctx.systemPrompt.section()` + 工具 description |
| 破坏性确认 | 工具入参 `confirm: true`（靠模型自觉） | `tools/pre-execute` 返回 `{ kind: 'ask' }` → `ctx.approval` 人工审批（fail-closed） |
| 归属隔离 | `dataset_metadata.user_id` | `scope_key` = 调用 agent 的 `session.cwd`（workspace 维度） |
| 写操作句柄 | 模型直接传物理表名（注入面大） | 模型只传 **datasetId / 登记名**；物理表名由插件内部持有，从不外泄 |
| 元数据存储 | drizzle + `dataset_metadata` 表 | 插件自有的 libSQL 库，自建 `datasets` 表 |
| 大文件导入 | 同步批量插入 | 超阈值走 `ctx.jobs` 后台任务 + `agent.inject()` 通知 |

**未变**：文件解析、类型推断、建表/批量插入的语义全部沿用 `agentic-data-mini` 已验证的实现（见 §4）。

---

## 1. 背景与目标

### 1.1 为什么改造成 dsh 插件

- `dsh-lh-judge` 已验证「独立工程 + 构建产物 `lib/` + `cordis.patch.yml` + `pnpm dsh plugin add <path>`」这条外部插件链路可跑通。
- dsh 提供 v1 需要手工补齐的能力：原生工具流水线（`tools/pre-execute` 的 `ask` 审批）、`ctx.jobs` 后台任务、`ctx.systemPrompt` 段注入、`ctx.effect()` 自动清理。
- 能力复用：`agentic-data-mini` 的 Excel 解析 / Turso 原语是同进程的 Node 代码，可直接移植为插件内模块，不需要 HTTP 边界。

### 1.2 目标

1. 用户对 agent 说「把 `sales.xlsx` 导入数据库」→ 插件建表、批量插入、登记元数据。
2. 继续说「加一行 / 改下单据 / 删这条 / 查前 20 条」→ 用 CRUD 工具完成。
3. 大文件自动转后台任务，完成后回注通知，不阻塞对话。
4. 破坏性操作默认经 `ctx.approval` 人工确认；只读工具强制只读。
5. 数据按 workspace 隔离；agent 侧永不接触物理表名。

### 1.3 非目标

- 不改动 dsh 内核（不在 `deepseek-harness/packages/` 下新增包；保持独立工程）。
- 不做可视化建表 UI（对话 + 审批弹窗即可）。
- 不替换文件上传通道：文件读取复用工作区已有文件（`ctx.fs` / `node:fs`）。
- 不实现图表/分析闭环（后续可与 `query` 工具组合）。

---

## 2. 平台机制与约束（dsh 侧设计前置条件）

### 2.1 插件形态

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-lh-data'          // cordis 用于加载/去重的唯一标识
export const inject = ['tools']            // 等待 ctx.tools 就绪后才 apply

export interface Config { /* ... */ }
export const Config = Schema.object({ /* schemastery，非普通对象字面量 */ })

export function apply(ctx: Context, config: Config): void { /* 注册能力 */ }
```

约束：

- `Config` 必须是 **schemastery**（Standard Schema）实例，否则 cordis 校验阶段抛 `Config.validate is undefined`（`dsh-lh-judge/src/index.ts` 的注释已记录该坑）。
- 注册即副作用：插件 fiber 卸载时工具、监听、定时器全部自动注销。
- 非 cordis 管理的资源（libSQL 客户端、文件句柄）用 `ctx.effect(() => { ...; return () => close() })` 挂 disposer。
- 类型侧只 `import type { Context } from '@deepseek-ai/cordis'`（devDependency），运行时零 dsh 框架依赖——与 demo 一致。

### 2.2 工具契约

`ctx.tools.register(definition)` 接收 `ToolDefinition`，返回 disposer。第一方工具用 `defineTool` 构造：

```ts
ctx.tools.register(defineTool({
  name: 'dataset_query',
  description: '...',               // 模型唯一可见的说明
  parameters: { /* ParameterSchemaSpec：属性级 required: true */ },
  output: {
    schema: { /* ValueSchemaSpec */ },
    render: (args, value) => [{ type: 'text', text: '...' }],
  },
  execute: (args, exec) => Promise.resolve(value),
  presentCall: args => ({ card: 'generic', title: '...', kind: 'read' }),
}))
```

要点（来自 `docs/cookbook/adding-a-tool.zh.md` 与 `docs/subsystems/tools.zh.md`）：

- `defineTool` 在 `execute` 前完成参数校验并收窄 `args` 类型；抛 `ToolArgsError` → `INVALID_ARGS`。
- `execute` 只返回 `output.schema` 声明的**规范 JSON 值**；`output.render` 负责转成模型可见内容。不要返回内容块。
- 必须响应 `exec.signal`（取消即停）。
- `exec.agent` → 调用方 agent；`exec.agent.session.cwd` 是作用域依据。
- `exec.deferContext(msg)` 可把插件指令挂到本次结果之后回注。
- 显式对象节点必须声明 `additionalProperties: true | false`；参数根对象是隐式开放对象。
- 工具名全局唯一，且 `dataset_*` 前缀不与 dsh 内建工具（`read_file` / `bash` / `todo_write` / `subagent` / `web_search` …）冲突。

**依赖取舍（需落地时确认）**

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| **A（推荐）** | `dependencies` 增加 `@deepseek-ai/dsh-tools`，直接用 `defineTool` | 白拿参数校验 + `output.schema` 编译；需该包可 npm 安装 |
| **B（与 demo 对齐）** | 零 dsh 运行时依赖；手写 `ToolDefinition` 字面量（原始 JSON Schema）+ 自写 `validateArgs()` | 与 `dsh-lh-judge` 完全一致；多约 40 行自持代码 |

工具定义统一收口在 `src/tooling.ts` 的 `toolDef()` 适配器里，A/B 切换只改这一个文件。

### 2.3 执行流水线（安全能力来源）

```
tools/pre-execute (allow | deny | ask)  →  guard（单调拒绝）  →  tools/execute
  →  tools/post-execute (accept / replace / block)  →  finalizeContent  →  tools/result
```

- `ask` 经 `ctx.approval` 分发；只有 `allowed-once` 才放行，`rejected` / `cancelled` / `unavailable` 一律拒绝（**fail-closed**）。会话级 `approval/policy = 'never'` 时确定性拒绝（`CI/无头` 安全）。
- `ctx.tools.guard()` 提供不可被后续监听器撤销的最终拒绝。
- 策略**不写进工具内部**：审批门禁由插件自己的 `tools/pre-execute` 监听器提供（见 §7.2）。

### 2.4 身份与作用域

dsh 没有 `agentic-data-mini` 的 `userId`。映射关系：

| v1 概念 | v2 来源 | 说明 |
| --- | --- | --- |
| `userId` | `exec.agent.session.cwd`（规范化后的绝对路径） | 同一工作区共享数据集；无 cwd 时回落 `default` |
| `dataset_metadata.user_id` | `datasets.scope_key` | 所有读写按 `scope_key` 过滤 |
| （新增） | `ctx.workspaceRegistry.resolveByPath(cwd)` | 可选：把 scope 提升为 `WorkspaceId`（`perWorkspace` 模式） |

### 2.5 装载方式

```bash
# 工程内（与 demo 一致）
pnpm install && pnpm run build            # tsdown → lib/
pnpm dsh plugin --profile web add D:\fastwork\projects\node\dsh-lh-data
```

`package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；`cordis.patch.yml` 插入插件行与配置：

```yaml
- insert:
    - id: lh-data
      name: 'D:/fastwork/projects/node/dsh-lh-data'
      config:
        dbPath: ''
        requireApprovalForWrites: true
```

调试态也可用 `pnpm dsh web --patch ./cordis.yml` 直接指向 `src/index.ts`（绝对路径），省去构建步骤。

---

## 3. 总体架构

```
┌──────────────────────── 用户对话 ─────────────────────────┐
│  "把 sales.xlsx 导入数据库，然后加一行、改单价"              │
└───────────────────────────┬──────────────────────────────┘
                            │ 模型选择 dataset_* 工具
                            ▼
┌──────── dsh 工具流水线（tools/pre-execute 门禁）───────────┐
│  写类工具 → { kind:'ask' } → ctx.approval → allowed-once    │
│  读类工具 → allow                                           │
└───────────────────────────┬──────────────────────────────┘
                            ▼
┌──────────── 插件 dsh-lh-data（scope = session.cwd）────────┐
│ dataset_import   dataset_list    dataset_schema             │
│ dataset_query    dataset_insert  dataset_update             │
│ dataset_delete   dataset_drop                               │
│   ↳ handle 层：datasetId/name → 物理表（内部持有，不外泄）   │
│   ↳ 解析层：parseXLSX / parseCSV（移植自 agentic-data-mini）│
│   ↳ 存储层：自有 libSQL（@libsql/client），ctx.effect 关闭   │
└───────────────────────────┬──────────────────────────────┘
                            ▼
              本地 Turso / libSQL 文件（含 datasets 元数据表）
```

---

## 4. 参考实现：从 `agentic-data-mini` 迁移的资产

`agentic-data-mini` 中 `skills/excel-to-turso/` 目前是**空目录**，v1 设计未落地；真正可直接移植的是其 `src/lib` 下已跑通的模块。

| 能力 | 参考位置 | 移植方式 | 需保留的关键行为 |
| --- | --- | --- | --- |
| 连接与执行 | `src/lib/primitives/db.ts` | 复制 `SqliteDatabase` 兼容层（`@libsql/client` 的 `prepare().all/get/run`） | URL 优先级 `SQLITE_PATH` > `TURSO_DATABASE_URL` > `file:./data/*.db`；裸路径补 `file:`；启动 `PRAGMA journal_mode=WAL` + `foreign_keys=ON`；日志不打印 authToken |
| 标识符消毒 | `db.ts#sanitizeId` | 保留，用于兜底 | `[^a-zA-Z0-9_\u4e00-\u9fa5]` → `_` |
| Excel 解析 | `src/lib/utils/fileParser.ts#parseXLSX` | 近乎原样复制 | `XLSX.read({ type:'buffer', cellDates:true })` + `sheet_to_json({ raw:true, defval:null })`；Date → `YYYY-MM-DD`；默认第一个 sheet |
| CSV 解析 | `fileParser.ts#parseCSV` | 原样复制 | `Papa.parse({ header:true, skipEmptyLines:true, dynamicTyping:true, transformHeader:trim })` |
| 列名处理 | `fileParser.ts#sanitizeColumnName` / `deduplicateColumnNames` | 原样复制 | **保留原名（含中文）**，SQL 中双引号包裹；空列名 → `column`；重名追加 `_2` |
| 类型推断 | `fileParser.ts#inferColumnType` | 原样复制 | 编码/号码类列名（编码/编号/代码/代号/账号/证件号/邮编/区号/code/sku/ean/upc/isbn/postal/zip/phone/tel/电话/手机）**强制 text**；13+ 位整数或 `xE+12` 科学计数法**强制 text**（防精度丢失）；numeric>80% / boolean>90% / date 正则>70% |
| 表名生成 | `fileParser.ts#generateTableName` | 改造（去掉 userId） | 小写化、非 `[a-z0-9_]`→`_`、折叠连续 `_`、去首尾 `_`、截断 40；后缀 `Date.now().toString(36)` |
| 建表 | `src/lib/utils/tableManager.ts#createDatasetTable` | 原样复制 | `_row_id INTEGER PRIMARY KEY AUTOINCREMENT` + 业务列 + `_uploaded_at INTEGER DEFAULT (strftime('%s','now'))` |
| 批量插入 | `tableManager.ts#insertDatasetRowsFast` | 原样复制 | **100 行/批**；类型转换 boolean→0/1、numeric→`Number`、date→ISO、Date→ISO、object/array→`JSON.stringify`（Buffer 直传） |
| 删表 | `tableManager.ts#dropDatasetTable` | 复制 | `DROP TABLE IF EXISTS "…"` |
| 只读校验 | `tableManager.ts#executeUserSQL` / `db.ts#p_db_query` | **重写**（见 §7.3） | 参考实现的「禁词表」会误伤字符串字面量（如 `SELECT * FROM t WHERE name='DROP'`），v2 改为「单语句 + 首词白名单 + 顶层关键字扫描」 |

---

## 5. 能力设计（工具契约）

### 5.1 工具清单

| 工具 | 参数 | 行为 | 破坏性 | 默认审批 |
| --- | --- | --- | --- | --- |
| `dataset_import` | `path`、`name?`、`sheet?`、`limit?`、`background?` | 解析工作区 Excel/CSV → 建表 + 批量插入 + 登记元数据 | 是 | ask |
| `dataset_list` | — | 列出当前 scope 的数据集（name / rowCount / 列数 / 创建时间） | 否 | allow |
| `dataset_schema` | `dataset` | 返回列信息（原名、类型、可空、样例） | 否 | allow |
| `dataset_query` | `dataset`、`sql?`、`columns?`、`where?`、`orderBy?`、`limit?`(默认 50)、`offset?` | 只读查询，返回行 + 列名 | 否 | allow |
| `dataset_insert` | `dataset`、`rows[]`(≤ 上限) | 批量追加行 | 是 | ask |
| `dataset_update` | `dataset`、`rowId`、`data` | 按 `_row_id` 更新单行 | 是 | ask |
| `dataset_delete` | `dataset`、`rowId` | 按 `_row_id` 删除单行 | 是 | ask |
| `dataset_drop` | `dataset` | 删物理表 + 删元数据（不可恢复） | 是 | ask |

> `dataset` 参数统一接受 **datasetId** 或**登记名**；物理表名不出现在任何参数或返回值中。

### 5.2 导入流程（关键路径）

1. **定位文件**：`resolveFile(scope, path)` — 绝对路径原样；相对路径以 `exec.agent.session.cwd` 为基；必须落在 scope 目录内（越界拒绝）。扩展名白名单 `.xlsx / .xls / .csv`；大小上限 `maxFileBytes`（默认 200MB）。
2. **读取**：优先 `ctx.fs`（sandbox 感知）；不可用时回落 `node:fs/promises`，并透传 `exec.signal`。
3. **解析**：`.csv` → `parseCSV`，否则 `parseXLSX(buffer, sheet)`；得到 `columns: ColumnInfo[]` 与 `rows`。
4. **建表**：`generateTableName(base, scopeHash)` → 断言 `^d_[a-z0-9]{8}_[a-z0-9_]{1,40}_[a-z0-9]+$` → `createDatasetTable`。
5. **插入**：`insertDatasetRowsFast`（100/批）；每批之间 `exec.signal.throwIfAborted()`。
6. **登记**：`datasets` 表写入 `id / scope_key / name / table_name / source_path / row_count / columns(json) / created_at / updated_at / status`。
7. **返回**：`{ datasetId, name, rowCount, columns, status }`。

**后台分支**：`rows.length >= backgroundThresholdRows`（默认 20000）或 `background === true` 时：

- `ctx.jobs.start({ kind: 'dataset-import', label, owner: exec.agent, run })`；
- 立即返回 `{ datasetId, status: 'running', jobId }`（`rowCount` 为 0，状态为 `importing`）；
- 完成后写 `status='ready'` + `row_count`，并通过 `exec.agent.inject({ content, source:{ kind:'plugin', plugin:'dsh-lh-data' } })` 回注（try/catch 兜住已 dispose 的 agent）；
- 后台任务使用**任务自有的取消信号**，不再用 `exec.signal`。

### 5.3 数据模型

- **物理表名**：`d_<scopeHash8>_<base40>_<ts36>`，只由插件生成与持有。
- **系统列**：`_row_id`（自增主键，写操作定位用）、`_uploaded_at`（写入时间戳）。插入/更新时剔除这两个键。
- **元数据表** `datasets`（插件自有，替代 drizzle 的 `dataset_metadata`）：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | `ds_<ts36><rand>` |
| `scope_key` | TEXT NOT NULL | scope（默认规范化 cwd；`perWorkspace` 模式下为 `WorkspaceId`） |
| `name` | TEXT NOT NULL | 用户可见名；`UNIQUE(scope_key, name)` |
| `table_name` | TEXT NOT NULL UNIQUE | 物理表名，仅内部使用 |
| `source_path` | TEXT | 导入来源文件（仅用于溯源，不用于读） |
| `row_count` | INTEGER | 最近一次写入后的行数 |
| `columns` | TEXT (JSON) | `ColumnInfo[]` |
| `status` | TEXT | `importing` / `ready` / `failed` |
| `error` | TEXT | 后台导入失败原因 |
| `created_at` / `updated_at` | INTEGER | epoch ms |

索引：`(scope_key, created_at DESC)`、`UNIQUE(scope_key, name)`、`UNIQUE(table_name)`。

---

## 6. 配置（`Config`）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `dbPath` | string | `''` | libSQL 库路径；空 → `$DSH_HOME/lh-data/data.db` |
| `dbUrl` | string | `''` | 非空则覆盖 `dbPath`，可为 `file:` 或 `libsql://`（远程 Turso） |
| `authToken` | string | `''` | 远程 Turso token；**建议留空并走环境变量 `TURSO_AUTH_TOKEN`** |
| `perWorkspace` | boolean | `false` | `true` 时 scope 用 `WorkspaceId` 且每个工作区独立库文件 |
| `requireApprovalForWrites` | boolean | `true` | 写类工具是否走 `ctx.approval` |
| `allowRawSql` | boolean | `true` | `dataset_query` 是否接受 `sql`；关闭后仅结构化查询 |
| `maxFileBytes` | number | `209715200` | 单文件上限 |
| `maxInsertRows` | number | `500` | `dataset_insert` 单批上限 |
| `maxQueryRows` | number | `200` | `dataset_query` 返回行数上限 |
| `batchSize` | number | `100` | 导入批量插入批次大小 |
| `backgroundThresholdRows` | number | `20000` | 超过则自动后台导入 |
| `previewSampleRows` | number | `100` | 类型推断采样行数 |
| `readOnly` | boolean | `false` | 只读模式：写类工具直接 deny |

配置在插件加载时由 cordis 校验，非法即加载失败（fail-loud）。

---

## 7. 安全与隔离设计（关键）

### 7.1 句柄化消除注入面

- 模型只传 `dataset`（id 或登记名），插件在 `datasets` 表中解析出物理表名。
- 物理表名必须匹配 `^d_[a-z0-9]{8}_[a-z0-9_]{1,40}_[a-z0-9]+$` 才允许拼进 SQL；不匹配即拒绝（防御内部数据被污染）。
- 列名**保留原名**并双引号包裹（`"` 转义为 `""`）；值一律 `?` 参数化。
- 结果：**写操作无法指向非本插件创建的表**；读操作的 `sql` 分支另由 §7.3 约束。

### 7.2 破坏性操作审批

```ts
const WRITE_TOOLS = new Set(['dataset_import','dataset_insert','dataset_update','dataset_delete','dataset_drop'])

ctx.on('tools/pre-execute', async (exec, next) => {
  if (!WRITE_TOOLS.has(exec.name)) return next()
  if (cfg.readOnly) return { kind: 'deny', reason: 'dsh-lh-data is in read-only mode' }
  if (!cfg.requireApprovalForWrites) return next()
  return { kind: 'ask', reason: `${exec.name} will modify the local dataset store` }
})
```

- `ask` 走 `ctx.approval`；无审批通道 / `unavailable` / 策略 `never` → 拒绝（fail-closed）。
- `ctx.tools.guard()` 再兜一层：解析不到归属数据集的写操作一律拒绝（单调，不可被后续监听器放行）。

### 7.3 只读校验（替换参考实现的禁词表）

`dataset_query` 的 `sql` 分支：

1. 剥离 `--` 行注释与 `/* */` 块注释（不剥离字符串字面量内的内容需按引号状态机处理）；
2. 拒绝含 `;` 的多语句；
3. 首关键字必须落在白名单 `{ SELECT, WITH, EXPLAIN }`；
4. 顶层关键字扫描：命中 `INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|BEGIN|COMMIT` → 拒绝（`WITH … DELETE` 这类 CTE 写语句因此被拦下）；
5. 表名引用必须出现在当前 scope 已登记表名集合内（否则拒绝）；
6. 强制追加 `LIMIT`（未显式声明时用 `maxQueryRows`）。

结构化分支（`columns/where/orderBy/limit`）由插件拼装 SQL，天然安全，作为默认推荐路径写进工具 description。

### 7.4 其它约束

| 维度 | 设计 |
| --- | --- |
| **越权** | 所有操作先 `assertOwned(scopeKey, datasetId)`；跨 scope 一律拒绝（defense-in-depth） |
| **路径** | 导入文件路径必须解析后位于 scope 目录内（防 `../` 穿越）；扩展名白名单 |
| **系统列** | 插入/更新时过滤 `_row_id`、`_uploaded_at` |
| **批量上限** | `dataset_insert` ≤ `maxInsertRows`；导入内部 `batchSize`/批 |
| **取消** | 每个批次检查 `exec.signal`；后台任务用任务自有信号 |
| **结果脱敏** | 工具返回值不出现物理表名；错误信息不回显完整 SQL 之外的凭据 |
| **日志** | 不打印 `authToken`；结构化日志走 `ctx.logger`（不可用则静默） |
| **HMR** | 插件热替换时 `ctx.effect()` 关闭 libSQL 客户端，工具注册自动注销 |

---

## 8. 持久化与生命周期

- **单一 libSQL 连接**：首次工具调用时惰性建立（不在 `apply()` 里同步建立，避免拖慢启动），缓存在模块级单例。
- **关闭**：`ctx.effect(() => { const db = getDb(cfg); return () => db.close() })`；HMR / 卸载时确定性释放。
- **并发**：libSQL 客户端本身串行安全；导入任务内部顺序执行批次。跨工具并发写由 `isConcurrencySafe` 默认不声明（即独占串行），避免交错写。
- **与 `ctx.storage` 的取舍**：`ctx.storageDomain`（KV）适合小量键值，不适合大批量表数据与任意列结构；因此插件自建 libSQL 并独立持有 schema，不接入 storage seam。

---

## 9. 使用引导（替代 v1 的 SKILL.md）

v1 用 `SKILL.md` 正文注入指令；v2 用两个机制：

1. **工具 description**：写清工作流与约束（先 `dataset_list` 确认目标 → `dataset_schema` → 结构化查询优先 → 写操作会触发人工确认）。
2. **`ctx.systemPrompt.section()`**（可选依赖，`ctx.inject(['systemPrompt'], …)` 激活）：

```ts
{
  name: 'dsh-lh-data',
  order: 900,
  text: '本地表格库：用 dataset_import 把工作区 Excel/CSV 落库；用 dataset_query 只读查询（优先结构化参数）；写操作需人工确认。',
}
```

---

## 10. 文件结构与落地步骤

### 10.1 文件落点

```
dsh-lh-data/
├── src/
│   ├── index.ts        # name / inject / Config / apply：工具注册 + pre-execute 门禁 + systemPrompt 段
│   ├── tooling.ts      # toolDef() 适配器（defineTool 或原生字面量，A/B 方案切换点）
│   ├── tools/
│   │   ├── registry.ts # 八个工具的 ToolDefinition 聚合导出
│   │   ├── read.ts     # dataset_list / dataset_schema / dataset_query
│   │   ├── write.ts    # dataset_insert / dataset_update / dataset_delete / dataset_drop
│   │   └── import.ts   # dataset_import（前台 + 后台分支）
│   ├── store.ts        # datasets 元数据 CRUD + assertOwned + 物理表名生成/断言
│   ├── db.ts           # libSQL 客户端（移植 db.ts 兼容层）+ 生命周期
│   ├── parse.ts        # parseXLSX / parseCSV / inferColumnType（移植 fileParser.ts）
│   ├── table.ts        # createDatasetTable / insertDatasetRowsFast / dropDatasetTable（移植 tableManager.ts）
│   ├── sql.ts          # 只读校验器 + 结构化查询拼装 + 标识符引号化
│   ├── scope.ts        # exec.agent → scopeKey（cwd 规范化 / WorkspaceId）
│   └── render.ts       # 表格/结果文本渲染（对齐 demo 的 render.ts 定位）
├── lib/                # tsdown 产物（运行时 JS + d.ts）
├── examples/
│   └── run-import.mjs  # 最小假 ctx 验证脚本（沿用 demo 的 examples 约定）
├── cordis.patch.yml
├── package.json        # main: lib/index.js；dsh.bundle.patch
├── tsdown.config.ts
├── tsconfig.json / tsconfig.build.json
└── docs/               # 本文件
```

### 10.2 落地步骤

1. **初始化工程**：以 `dsh-lh-judge` 为骨架复制 `package.json / tsconfig / tsdown.config / cordis.patch.yml`；`name` 改为 `dsh-lh-data`。
2. **依赖**：`dependencies` 增加 `@libsql/client`、`xlsx`、`papaparse`（+ 方案 A 的 `@deepseek-ai/dsh-tools`）；`devDependencies` 保留 `typescript` / `tsdown` / `@types/node` / `@deepseek-ai/cordis`；保留 `@deepseek-ai/schemastery` 作为运行时依赖（`Config` 需要）。
3. **移植数据层**：§4 表格逐项搬运到 `db.ts` / `parse.ts` / `table.ts`，去掉 drizzle 与 `userId`，补 `exec.signal` 检查点。
4. **实现 `store.ts`**：建 `datasets` 表（幂等 `CREATE TABLE IF NOT EXISTS` + 索引），实现 `assertOwned`。
5. **实现八个工具**：`read.ts` → `write.ts` → `import.ts`；先前台导入，再接 `ctx.jobs` 后台分支。
6. **接入审批门禁**：`src/index.ts` 注册 `tools/pre-execute` 监听器 + `ctx.tools.guard()`。
7. **系统提示词段**：`ctx.inject(['systemPrompt'], …)` 注册 section。
8. **生命周期**：libSQL 客户端包进 `ctx.effect()`。
9. **装载验证**：`pnpm run build` → `pnpm dsh plugin --profile web add D:\fastwork\projects\node\dsh-lh-data`；或 `pnpm dsh web --patch ./cordis.yml` 直连 `src/index.ts` 调试。
10. **示例脚本**：`examples/run-import.mjs` 造最小 `ctx`（`on/emit/fire` + 假 `tools.register`），跑通「导入 → list → query → insert → update → delete → drop」。

---

## 11. 测试计划

| 层级 | 用例 |
| --- | --- |
| 单元：`sql.ts` | `WITH x AS (...) DELETE FROM t` 被拒；含 `'DROP'` 字符串字面量的 SELECT 放行；多语句被拒；`EXPLAIN` 放行 |
| 单元：`parse.ts` | 13+ 位数字列 → text；`1.78E+12` → text；列名含 `编码` → text；重名列 → `_2`；空列名 → `column`；中文列名保留 |
| 单元：`store.ts` | `assertOwned` 跨 scope 拒绝；`name` 在 scope 内唯一；物理表名正则断言 |
| 单元：路径解析 | 相对路径基于 cwd；`../` 越界拒绝；非白名单扩展名拒绝 |
| 集成 | 构造临时 `.xlsx` → `dataset_import` → `dataset_list` 可见 → `dataset_query` 行数一致 → `insert` → `update` → `delete` → `drop`；断言 `datasets` 同步、删表后元数据清理 |
| 集成：审批 | `requireApprovalForWrites: true` 且无审批通道时，写操作被拒（fail-closed）；`readOnly: true` 时 deny |
| 集成：后台 | 超过 `backgroundThresholdRows` 返回 `jobId` + `status:'running'`，完成后 `status:'ready'` 并回注通知 |
| 集成：取消 | 导入中途 `signal.abort()`，无半截表残留（元数据标记 `failed`） |
| 冒烟 | `examples/run-import.mjs` 全链路通过 |

---

## 12. 开放问题

1. `@deepseek-ai/dsh-tools` 能否从 npm 安装？决定走方案 A 还是 B（§2.2）。
2. scope 默认用 `session.cwd` 还是强制 `WorkspaceId`？后者隔离更严格，但 headless / 无工作区场景需回落。
3. 是否需要 `dataset_export`（表 → CSV/XLSX）形成闭环？
4. 是否需要支持「追加导入到已有数据集」与「覆盖导入（先 drop 再建）」？
5. 后台导入失败是否自动重试 / 断点续传（参考实现有 `parseXLSXFromRow`）？
6. 是否要让 `dataset_query` 结果与 dsh 的分析/图表能力打通（本插件只出结构化数据，渲染交给模型）？

---

## 附录 A：与 `agentic-data-mini` 现有能力对照

| 本插件工具 | agentic-data-mini 现有能力 | 差异 |
| --- | --- | --- |
| `dataset_import` | `POST /api/upload`（Next.js API，非对话驱动） | 对话驱动 + 后台任务 + 审批门禁 |
| `dataset_list` | `p_db_list_datasets(userId)` | scope 维度替代 userId |
| `dataset_schema` | 上传预览 `parseXLSXPreview` | 读回已登记列信息 |
| `dataset_query` | `query_database` / `p_db_fuzzy_search` | 句柄化 + 更严的只读校验；暂不含中文模糊搜索 |
| `dataset_insert` | `insert_data` | 批量 + 系统列保护 + 句柄化 |
| `dataset_update` / `dataset_delete` | `p_db_update` 等（无单行工具） | 按 `_row_id` 精确单行 + 审批 |
| `dataset_drop` | `drop_table` | 增加元数据清理 + 审批 |

## 附录 B：与 `dsh-lh-judge`（demo）的对照

| 关注点 | `dsh-lh-judge` | `dsh-lh-data` |
| --- | --- | --- |
| 侵入方式 | 监听 `agent/pre-step`、`tools/post-execute`，只回注消息 | 注册模型可调用工具 + 工具门禁 |
| ctx 依赖 | duck-typed + `ctx.reflect.get('llm', false)` 优雅降级 | `inject: ['tools']`（必需）；`systemPrompt` / `jobs` 用 `ctx.inject([...], cb)` 可选依赖 |
| 外部资源 | 无 | libSQL 客户端，需 `ctx.effect()` 释放 |
| 产物与装载 | `lib/` + `cordis.patch.yml` + `dsh plugin add` | 完全相同 |
| 验证方式 | `examples/run-guard.mjs`（假 ctx） | `examples/run-import.mjs`（同构） |
