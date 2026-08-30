# dsh-lh-data

dsh 外部插件：把工作区内的 Excel / CSV 导入本地 Turso（libSQL），并以**句柄化**的 `dataset_*` 工具做增删改查。

模型侧只见 `datasetId` / 登记名，物理表名由插件内部持有，从不外泄。

---

## 特性

- **导入**：`.xlsx` / `.xls` / `.csv` → 自动推断列类型 → 建表 → 批量插入 → 登记元数据。
- **句柄化**：所有工具用 `datasetId` 或登记名指代数据集，禁止拼接物理表名。
- **只读 SQL 校验**：原始 SQL 只允许单条 `SELECT / WITH / EXPLAIN`，用保留别名 `ds` 指代数据集，写入 / DDL 关键字与未登记表一律拒绝。
- **写操作门禁**：`tools/pre-execute` 对写工具返回 `ask`（走人工确认，无审批通道即拒绝）；`ctx.tools.guard()` 单调兜底。
- **工作区隔离**：数据集按 scope（默认 `session.cwd`）隔离，导入路径禁止 `../` 越界。
- **结果视图化**：`dataset_query` 只把「少量预览行 + 全量统计摘要」交给模型；完整结果以服务端**视图句柄**暴露给前端，前端按 `viewId` 自动分页拉取并展示表格（模型不接触全量数据，也不接触 SQL）。
- **后台导入**：大文件（默认 ≥ 20000 行或显式 `background: true`）转 `ctx.jobs` 任务，完成后回注通知；无 `jobs` 时自动降级为前台同步导入。
- **零运行时框架依赖**：不 import 任何 dsh 框架包，工具定义手写并自持校验（同构于 `dsh-tools` 的 schema 子集）。

## 安装与装载

```bash
pnpm install
pnpm run build          # tsdown → lib/
pnpm dsh plugin --profile web add D:/fastwork/projects/node/dsh-lh-data
```

仓库内已附 `cordis.patch.yml`，等价于在 dsh 配置里插入：

```yaml
- insert:
    - id: lh-data
      name: 'D:/fastwork/projects/node/dsh-lh-data'
      config:
        dbPath: ''
        requireApprovalForWrites: true
```

## 配置（`Config`）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `dbPath` | `''` | 本地库路径；空 → `$DSH_HOME/lh-data/data.db`（未设 `DSH_HOME` 时为 `~/.dsh/lh-data`） |
| `dbUrl` | `''` | 非空则覆盖 `dbPath`，可为 `file:` 或 `libsql://`（远程 Turso） |
| `authToken` | `''` | 远程 token；建议留空并走环境变量 `TURSO_AUTH_TOKEN` |
| `perWorkspace` | `false` | true 时 scope 用 WorkspaceId（`ws:<id>`），且每个工作区独立库文件 |
| `requireApprovalForWrites` | `true` | 写类工具是否走人工确认 |
| `allowRawSql` | `true` | `dataset_query` 是否接受原始 SQL；关闭后仅结构化查询 |
| `maxFileBytes` | `209715200` | 单个导入文件的字节上限 |
| `maxInsertRows` | `500` | `dataset_insert` 单次插入行数上限 |
| `maxQueryRows` | `200` | `dataset_query` 可服务行数上限（无前端视图时的片段上限；有视图时由 `maxViewRows` 接管） |
| `viewMode` | `'auto'` | 结果视图模式：`auto`（超阈值才建视图）/ `always` / `never` |
| `viewThresholdRows` | `20` | 超过该行数启用视图（`auto`） |
| `viewThresholdBytes` | `4096` | 片段字节数超过该值启用视图（`auto`） |
| `previewRows` | `5` | 模型可见的预览行数 |
| `previewStrategy` | `'head'` | 预览行取法：`head` / `head-tail`（头尾各取） |
| `previewCellChars` | `40` | 预览单元格截断长度 |
| `previewColumns` | `12` | 预览展示的列数上限 |
| `summaryEnabled` | `true` | 是否生成列统计摘要 |
| `summaryMaxColumns` | `24` | 参与摘要的列数上限 |
| `summaryMaxTextColumns` | `3` | 参与取值分布的文本列数上限 |
| `defaultPageSize` | `100` | 前端视图首页行数 |
| `maxPageSize` | `500` | 前端视图单页行数上限 |
| `maxViewRows` | `50000` | 单个视图可翻到的最大行数 |
| `viewTtlMs` | `1800000` | 视图存活时间（毫秒，访问即刷新） |
| `maxViews` | `64` | 同时存活的视图数（LRU 淘汰） |
| `viewRoutePrefix` | `'/api/lh-data'` | 前端分页接口的路由前缀 |
| `batchSize` | `100` | 导入批量插入的批次大小 |
| `backgroundThresholdRows` | `20000` | 超过该行数自动转后台导入 |
| `previewSampleRows` | `100` | 类型推断的采样行数 |
| `readOnly` | `false` | 只读模式：写类工具直接 deny |

库连接优先级：`dbUrl` > `dbPath` > `SQLITE_PATH` > `TURSO_DATABASE_URL` > 默认本地文件。

## 工具

| 工具 | 类型 | 关键参数 | 说明 |
| --- | --- | --- | --- |
| `dataset_list` | 读 | — | 列出当前工作区已登记的数据集 |
| `dataset_schema` | 读 | `dataset` | 列名（保留中文原始表头）、类型、可空性、样例值 |
| `dataset_query` | 读 | `dataset` + 结构化参数或 `sql` | 只读查询：返回预览行 + 列摘要 + 结果视图（前端分页取全量） |
| `dataset_import` | 写 | `path`、`name?`、`sheet?`、`limit?`、`background?` | 导入工作区内的表格文件 |
| `dataset_insert` | 写 | `dataset`、`rows` | 批量追加行 |
| `dataset_update` | 写 | `dataset`、`rowId`、`data` | 按 `_row_id` 更新单行 |
| `dataset_delete` | 写 | `dataset`、`rowId` | 按 `_row_id` 删除单行 |
| `dataset_drop` | 写 | `dataset` | 删除整个数据集（物理表 + 元数据） |

写工具（`import` / `insert` / `update` / `delete` / `drop`）默认触发人工确认；`readOnly=true` 时直接拒绝。

### 典型流程

```text
dataset_import  { path: "data/sales.xlsx" }
  → dataset_list
  → dataset_schema { dataset: "sales" }
  → dataset_query  { dataset: "sales", columns: ["名称","数量"], where: "数量 >= 40", orderBy: "数量 DESC" }
  → dataset_update { dataset: "sales", rowId: 12, data: { "单价": 4.5 } }
```

需要聚合 / 连接时才用原始 SQL，数据集用保留别名 `ds`：

```sql
SELECT 状态, COUNT(*) AS c FROM ds GROUP BY 状态
```

## 数据模型

- 元数据表 `datasets`：`id`、`scope_key`、`name`、`table_name`、`source_path`、`row_count`、`columns`、`status`、`error`、`created_at`、`updated_at`；唯一索引 `(scope_key, name)`。
- 物理表：`d_<scopeHash8>_<base40>_<ts36>`，列为业务列 + 系统列 `_row_id`（自增主键）、`_uploaded_at`。
- 状态：`importing` / `ready` / `failed`；非 `ready` 的数据集不可查询与写入。导入失败会删掉半截物理表。

### 类型推断

采样前 `previewSampleRows` 行，优先级：列名（含「编码 / 编号 / 代码 / phone」等 → `text`）> 大数（13+ 位整数或 `1.78E+12`）→ numeric > 80% → boolean > 90% → 日期正则 > 70% → 其余 `text`。列名保留原名（支持中文），重名追加 `_2`。

## 安全模型

1. **路径白名单**：导入文件解析后必须落在工作区内，扩展名限于 `.xlsx / .xls / .csv`，且不得超过 `maxFileBytes`。
2. **句柄化**：模型只见 datasetId / 登记名，物理表名在插件内生成、校验（正则白名单）后拼进 SQL。
3. **SQL 校验**：剥离注释与字符串字面量后扫关键字，拒绝多语句、写操作 / DDL / 事务关键字；表引用必须落在当前 scope 已登记的集合内。
4. **审批门禁**：写工具 → `ask`；只读模式 → `deny`；写工具缺少归属句柄（`dataset` / `path`）由 `guard()` 单调拒绝。
5. **生命周期**：`ctx.effect()` 在 HMR / 卸载时注销工具并 `closeAllDatabases()`。

## 目录结构

```
src/
  index.ts      # 插件入口：name / inject(['tools']) / Config / apply
  tooling.ts    # 工具定义适配器（零框架依赖）与参数校验
  db.ts         # libSQL 客户端、URL 解析、连接缓存与关闭
  store.ts      # datasets 元数据、物理表名生成、归属断言
  scope.ts      # scope 解析与导入路径校验
  parse.ts      # XLSX / CSV 解析与类型推断
  table.ts      # 建表 / 批量插入 / 更新 / 删除 / 查询
  sql.ts        # 只读校验器、ds 别名替换、结构化查询拼装、count/page 计划派生
  render.ts     # 输出渲染（含查询结果片段）
  view.ts       # 结果视图注册中心（句柄、LRU、TTL、分页语句组装）
  preview.ts    # 预览切片与全量列摘要
  http.ts       # 前端分页路由（webServer + connection 鉴权）
  tools/        # 八个 dataset_* 工具（read / write / import / registry）
  client/       # 浏览器半身：dataset_query 结果表格卡片（tool.call.toolview）
examples/run-import.mjs   # 自包含验证脚本（假 ctx 跑通全链路）
examples/run-view.mjs     # 结果视图验证脚本（假 webServer/connection）
docs/excel-to-turso-skill设计.md        # 设计文档（导入与 CRUD）
docs/查询结果视图与前端分页设计.md       # 设计文档（结果视图与前端分页）
```

## 结果视图（模型只拿片段）

`dataset_query` 命中较大结果集时：

1. 主机侧由已校验的语句派生 `countSql` / `pageSql`，注册一个 `viewId`（TTL + LRU，绑定 scope）；
2. `output.render` 只产出 **预览行 + 类型化摘要**（默认 5 行，约 4 KB 上限）；
3. `output.presentationMeta` 产出**模型不可见**的视图描述符，前端拿到后自动
   `GET {viewRoutePrefix}/views/{viewId}/rows?page=&pageSize=&sort=&order=`；
4. 分页接口只接受 `viewId`，**不接受任何 SQL**；每个请求先过 `connection.requestRejection()`。

无 `webServer` / `connection`（CLI、TUI）或 `viewMode: 'never'` 时自动降级为旧的文本表格输出。

## 开发

```bash
pnpm run typecheck          # 主机半身 + 浏览器半身
pnpm run typecheck:client   # 只查浏览器半身（tsconfig.client.json）
pnpm run build              # lib/index.js（主机）+ lib/client.js（浏览器工厂包）
pnpm run import             # 先 build，再跑 examples/run-import.mjs
pnpm run view               # 先 build，再跑 examples/run-view.mjs
```

- `examples/run-import.mjs`：最小假 ctx，覆盖只读 SQL 校验器、类型推断、路径越界、审批门禁、导入 / 查询 / 增删改 / 后台导入 / 卸载清理。
- `examples/run-view.mjs`：假 `webServer` / `connection`，覆盖片段生成、`presentationMeta`、逐页取完并与全量比对、排序与参数夹紧、401/403/404/405、视图释放、TTL 过期、无 webServer 降级、卸载清理。

两个脚本结束都会打印 `RESULT passed=N failed=0`。

> Windows 上 libSQL 本地客户端在 `close()` 后仍会短暂占用文件句柄，脚本清理临时目录失败属已知现象，可手动删除 `%TEMP%\dsh-lh-data-*`。

## 相关

- 设计文档：[`docs/excel-to-turso-skill设计.md`](docs/excel-to-turso-skill设计.md)
- 设计文档：[`docs/查询结果视图与前端分页设计.md`](docs/查询结果视图与前端分页设计.md)（模型只拿片段，前端按视图句柄分页取数）
- 插件模板参考：`dsh-lh-judge`
- 数据层参考实现：`agentic-data-mini`
