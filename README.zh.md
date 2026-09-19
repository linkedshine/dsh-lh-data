# dsh-lh-data
> [项目github地址](https://github.com/linkedshine/dsh-lh-data)

dsh（deepseek-harness）插件：把工作区内的 Excel / CSV 导入本地 Turso（libSQL），并以**句柄化的 `dataset_*` 工具**做增删改查。

核心设计：**物理表名从不外泄**。模型侧只见 `datasetId` / 登记名 / 业务列名（保留中文表头）；查询只拿「少量预览行 + 全量统计摘要」，完整结果由**前端表格卡片按 `viewId` 分页拉取**。

---

## 特性

- **8 个 `dataset_*` 工具**：导入、列表、列信息、查询、插入、更新、删除、删表。
- **4 个 `datasource_*` 工具**：登记 MySQL / PostgreSQL 连接、测试连通、浏览远端表、把远端表全量导入成数据集；导入产出的数据集与文件导入完全同权。
- **句柄化**：SQL 里的物理表名由插件持有与替换，模型与 HTTP 响应中都不可见。
- **结果视图**：大结果集自动建视图，模型只拿片段，前端卡片翻页 / 排序 / 导出 CSV；视图持久化，重启后仍可翻页。
- **工作区隔离**：数据集按会话 cwd（或 WorkspaceId）分 scope，导入文件必须落在工作区内（禁止 `../` 穿越）。
- **写操作 fail-closed**：`tools/pre-execute` 门禁 + 单调守卫 + 只读模式三重保护。
- **只读 SQL 校验**：原始 SQL 仅允许单条 `SELECT` / `WITH` / `EXPLAIN`，表引用白名单，无 DDL / 写关键字。
- **设置页**：浏览器「设置 → 数据集」内分「数据集 / 数据源」两个页签，可聚合查看、新建空表、改描述、分页看数据、删除；数据源页签支持登记连接、测试连通、浏览远端表并一键导入。
- **可选依赖降级**：`jobs` / `systemPrompt` / `webServer` / `connection` 任一缺失都只降级对应能力，不影响装载；`mysql2` / `pg` 已随插件**默认安装**，但仍走动态加载——只用文件导入时不会拖慢启动，万一运行环境缺包也给明确安装提示而非抛裸栈。

---

## 常用命令

### 编译

```
pnpm run build
```

产物两个半身（由 `tsdown` 并行构建，共用 `lib/`）：

| 产物 | 格式 | 入口 | 说明 |
| --- | --- | --- | --- |
| `lib/index.js` | ESM | `src/index.ts` | 主机半身，cordis 插件 |
| `lib/client.js` | CJS 工厂 | `src/client/index.ts` | 浏览器半身，注册到 `window.__ModuleLoader__` |

### 类型检查

```
pnpm run typecheck          # 主机 + 客户端
pnpm run typecheck:host     # 仅主机
pnpm run typecheck:client   # 仅客户端
```

### 启动 web 服务

```
npx @deepseek-ai/dsh web
```

### 安装插件


本地源码
```
npx @deepseek-ai/dsh plugin --profile web add D:\fastwork\projects\node\dsh-lh-data
```

github
```
npx @deepseek-ai/dsh plugin --profile web add https://github.com/linkedshine/dsh-lh-data.git
```
中央仓库
```
npx @deepseek-ai/dsh plugin --profile web add dsh-lh-data
```

删除：

```
npx @deepseek-ai/dsh plugin --profile web remove dsh-lh-data
```

插件通过 `cordis.patch.yml` 注入默认配置（`dbPath` 留空、`requireApprovalForWrites: false`）。

### 验证脚本（需先 build）

```
pnpm run import   # examples/run-import.mjs：单元校验 + 导入 → list → schema → query → 写操作 → 门禁 → 生命周期
pnpm run view     # examples/run-view.mjs  ：大结果集 → 片段 → 前端分页 → 鉴权 / 持久化恢复 / 降级
pnpm run admin    # examples/run-admin.mjs ：聚合列表 / 新建空表 / 改名改描述 / 删除 / 分页看数据
pnpm run datasource  # examples/run-datasource.mjs：加解密 / 列映射 / 装载门禁 / 数据源 CRUD / 脱敏 / 鉴权 / 降级
```

`mysql2` / `pg` 已随插件默认安装，`pnpm install` 后即可连接数据库。想跑真实的端到端导入验证：把脚本顶部的 `DEMO` 改成你的库，再 `node examples/run-datasource.mjs --live`。

连接失败（端口未开放、主机不可达、账号密码错误、库不存在等）时，工具与设置页统一返回**可读的中文原因**（如「连接被拒绝（主机可达，但端口未开放或服务未启动）」），不会把驱动的裸栈抛给模型或浏览器；驱动确实缺失时仍给 `pnpm add mysql2` / `pnpm add pg` 提示。

---

## 工具一览

| 工具 | 类型 | 主要参数 | 返回要点 |
| --- | --- | --- | --- |
| `dataset_list` | 读 | — | `datasets[]`：`datasetId`、`name`、行数、列数、`status`、`sourcePath`、时间 |
| `dataset_schema` | 读 | `dataset` | 列名（原始表头）、`sanitizedName`、推断类型、可空、样例值、说明 |
| `dataset_query` | 读 | `dataset`、`columns`、`where`、`orderBy`、`limit`、`offset`、`sql` | `matchedRows` / `totalRows`、`preview`（少量预览行）、`summary`（列统计）、可选 `view` |
| `dataset_import` | 写 | `path`、`name?`、`sheet?`、`limit?`、`background?` | `datasetId`、行列数、`status: ready \| running`、`jobId?`、列信息 |
| `dataset_insert` | 写 | `dataset`、`rows[]` | `inserted`、最新 `rowCount` |
| `dataset_update` | 写 | `dataset`、`rowId`、`data` | `updated`、`changedColumns[]` |
| `dataset_delete` | 写 | `dataset`、`rowId` | `deleted`、剩余 `rowCount` |
| `dataset_drop` | 写 | `dataset` | `dropped`（连同物理表与元数据删除，不可恢复） |
| `datasource_list` | 读 | — | `sources[]`：`id`、`name`、`type`、`host`、`port`、`database`、`status`、`lastError`、`lastCheckedAt`（不含密码） |
| `datasource_test` | 读 | `source` | `success` / `latency` / `version` / `error` |
| `datasource_tables` | 读 | `source`、`schema?`、`q?` | `tables[]`：表名 / schema / 估计行数 / 列结构（列名 / 推断类型 / 可空 / 注释） |
| `datasource_import` | 写 | `source`、`table`、`schema?`、`name?`、`limit?` | `datasetId`、行列数、`status: ready \| running`、`jobId?` |

要点：

- `datasource_*` 的连接密码在**任何**工具描述、返回值、HTTP 响应、日志与错误文本里都不回显，只暴露「是否设置了密码」。
- `datasource_import` 加入写门禁；`readOnly=true` 或 `datasourceEnabled=false` 时直接拒绝；导入产出的数据集落在**当前会话工作区**，之后一律用 `dataset_*` 工具操作。
- 驱动（`mysql2` / `pg`）未安装时，`datasource_test` / `datasource_tables` / `datasource_import` 返回可读错误并提示 `pnpm add mysql2`（或 `pg`），不抛裸栈。

- `dataset` 一律传 **datasetId 或登记名**，不要猜物理表名。
- 查询优先用结构化参数；只有需要聚合 / 连接时才传 `sql`，用保留别名 `ds` 指代数据集，例如：
  ```sql
  SELECT 状态, COUNT(*) AS c FROM ds GROUP BY 状态
  ```
- 系统列 `_row_id`（自增主键）会随结果返回，是 `update` / `delete` 的定位键；`_uploaded_at` 由系统维护。两者都不能写入。
- 5 个写工具（`dataset_import` / `_insert` / `_update` / `_delete` / `_drop`）默认触发人工确认；`readOnly=true` 时直接 deny。

---

## 数据模型

### 元数据表 `datasets`（插件自有，每个 scope 库一份）

| 列 | 说明 |
| --- | --- |
| `id` | `ds_<ts36><rand>`，对外的 datasetId |
| `scope_key` | 归属键（cwd 规范化路径，或 `ws:<id>`） |
| `name` | 登记名，`(scope_key, name)` 唯一 |
| `table_name` | 物理表名，形如 `d_<scopeHash8>_<base40>_<ts36>`，只由插件持有 |
| `source_path` / `description` / `row_count` / `columns` / `status` / `error` / `created_at` / `updated_at` | 元数据 |

`status`：`importing` → `ready` / `failed`。导入失败会删掉半截物理表并标记 `failed`，非 `ready` 数据集会被拒绝读写。

来自数据源的数据集会在 `source_id` / `source_ref` 两列留下定位信息（`source_ref` 形如 `schema.table` 或 `table`，脱敏、不含凭据）；`source_path` 同时写成 `db:<数据源名>`，因此 `dataset_list` 与设置页搜索零改动即可按数据源名检索。

### 数据源登记表 `lh_data_sources`（catalog 库，全局共享）

数据源连接配置与数据集**不在同一个库**：数据源存 catalog 库（与 `dataset_scopes` 同级），跨工作区共享；导入产出的数据集仍落在各 scope 业务库。

| 列 | 说明 |
| --- | --- |
| `id` | `dsrc_<ts36><rand>`，对外的 sourceId |
| `name` | 登记名，全局唯一 |
| `type` / `host` / `port` / `database` / `username` | 连接参数 |
| `password_enc` | AES-256-GCM 密文（`iv:authTag:encrypted`），密钥取自 `datasourceEncryptKey` → `LH_DATA_ENCRYPT_KEY` → 内置默认；**永不回显** |
| `ssl_mode` / `pool_max` / `description` | 可选连接参数与说明 |
| `status` | `unknown` / `connected` / `error`，最近一次测试结论 |
| `last_error` / `last_checked_at` | 最近一次测试的脱敏错误与时间戳 |
| `created_at` / `updated_at` | 元数据 |

### 物理表

```sql
CREATE TABLE <table_name> (
  _row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  "<业务列>" <REAL | INTEGER | TEXT>,   -- 列名保留原始表头（含中文），SQL 中双引号包裹
  _uploaded_at INTEGER DEFAULT (strftime('%s','now'))
);
```

类型映射：`numeric → REAL`、`boolean → INTEGER`、`date / text → TEXT`。写入时按列类型强制转换（布尔→0/1、数值→Number、日期→ISO、对象/数组→JSON）。

### 列名与类型推断

- 列名**保留原名**（含中文）；空列名回落 `column`；重名追加 `_2` / `_3`（SQL 用 `sanitizedName`）。
- 类型推断（列名优先级最高，采样默认前 100 行）：
  1. 编码 / 号码类列名 → `text`（中文「编码/编号/代码/代号/账号/证件号/邮编/区号/电话/手机」，英文 `code` / `sku` / `ean` / `upc` / `isbn` / `issn` / `postal` / `zip` / `phone` / `tel` / `mobile`）；
  2. 13 位以上整数或 `1.78E+12` 类科学计数法 → `text`（防精度丢失）；
  3. 数值占比 > 80% → `numeric`；布尔占比 > 90% → `boolean`；日期正则占比 > 70% → `date`；
  4. 其余 → `text`。

### 库位置

连接优先级：`dbUrl` > `dbPath` > `SQLITE_PATH` > `TURSO_DATABASE_URL` > 默认 `$DSH_HOME/lh-data/data.db`（`DSH_HOME` 未设时回落 `~/.dsh`）。启动 PRAGMA：`journal_mode=WAL`、`foreign_keys=ON`。

---

## 结果视图与前端分页

模型调用 `dataset_query` 时：

1. `viewMode=auto` 下，命中行数 > `viewThresholdRows`（默认 20）或片段字节 > `viewThresholdBytes`（默认 4KB）才建视图；`always` / `never` 强制开关。
2. 建视图后，模型只拿到 `previewRows`（默认 5）行预览 + 全表聚合的 `summary`；`viewId` / `endpoint` 经 **`presentationMeta`** 传给前端（模型不可见）。
3. 前端卡片（`src/client/index.ts`）接管 `tool.call.toolview` 上 key = `dataset_query` 的渲染位，按 `viewId` 分页拉取：翻页、点表头排序、导出 CSV。
4. 视图元数据持久化到 `lh_views`（与 `datasets` 同库同 scope），重启后预载恢复；翻页行数据实时查询原表，因此卡片常驻「数据可能已发生变化」提示。

### 视图路由（`viewRoutePrefix` 可配，默认 `/api/lh-data`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `{prefix}/views/:viewId` | 视图元信息（列、总行数、分页上限、可排序列） |
| `GET` | `{prefix}/views/:viewId/rows?page=&pageSize=&sort=&order=` | 取一页数据 |
| `DELETE` | `{prefix}/views/:viewId` | 释放视图 |

接口**不接受任何 SQL**（语句由主机侧 `ViewRegistry` 持有），每个请求先过 `connection.requestRejection()`（Host/Origin 围栏 + 浏览器鉴权）。无 `webServer` / `connection`（CLI / TUI 剖面）时自动降级为纯文本片段。

---

## 设置页管理接口

固定挂在 `/api/lh-data/admin`（不受 `viewRoutePrefix` 影响），`adminEnabled=false` 时不注册。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/scopes` | 已知工作区列表 |
| `GET` | `/datasets?q=&page=&pageSize=` | 跨工作区聚合列表（超 `adminMaxDatasets` 截断并提示） |
| `POST` | `/datasets` | 新建空数据集（body 含 `scopeKey` 与列定义） |
| `GET` | `/datasets/:id?scope=` | 单条详情（含只读列结构） |
| `GET` | `/datasets/:id/rows?scope=&page=&pageSize=` | 分页查看表数据（只读） |
| `PATCH` | `/datasets/:id?scope=` | 改名 / 改描述 / 改来源 / 改列说明与样例 |
| `DELETE` | `/datasets/:id?scope=` | 连同物理表与元数据删除 |
| `GET` | `/sources` | 数据源列表（脱敏，不含密码） |
| `POST` | `/sources` | 新建数据源（`test:true` 时先测连，不通不落库） |
| `POST` | `/sources/test` | 测试连接（body 可含未保存的连接参数） |
| `GET` | `/sources/:id` | 单条详情（不含密码） |
| `PATCH` | `/sources/:id` | 改连接参数 / 改密码 / 改名改描述 |
| `DELETE` | `/sources/:id` | 删除数据源 |
| `GET` | `/sources/:id/tables?schema=&q=` | 列远端表（含 schema / 估计行数 / 列结构） |
| `POST` | `/sources/:id/import` | 把远端表导入指定工作区（`body.scopeKey` + 表名） |

约束：列名 / 类型 / 可空性对应物理表 DDL，创建后**不可改**；`scope` 由调用方从「已知工作区列表」回传，不接收任意路径。错误响应脱敏，不回显 SQL 与物理表名，数据源接口也绝不回显密码。

错误码：`UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` / `METHOD_NOT_ALLOWED` / `BAD_REQUEST` / `PAYLOAD_TOO_LARGE` / `READ_ONLY` / `ADMIN_DISABLED` / `SCOPE_UNKNOWN` / `DUPLICATE_NAME` / `INVALID_COLUMNS` / `QUERY_FAILED` / `SOURCE_DISABLED`（datasourceEnabled=false）/ `DRIVER_MISSING`（驱动未安装）/ `SOURCE_UNREACHABLE`（连接失败）/ `IMPORT_FAILED`（导入异常）。

浏览器侧在「设置 → 数据集」（`ADMIN_SECTION_ID = lh-data`，order 100）注册分区，组件见 `src/client/settings/`。

---

## 配置

在 `cordis.patch.yml` 或 dsh 插件配置中设置（`Config` schema 是默认值唯一真源）：

### 存储

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dbPath` | `''` | libSQL 库路径；空 → `$DSH_HOME/lh-data/data.db` |
| `dbUrl` | `''` | 非空则覆盖 `dbPath`，可为 `file:` 或 `libsql://`（远程 Turso） |
| `authToken` | `''` | 远程 token；建议留空走 `TURSO_AUTH_TOKEN` |
| `perWorkspace` | `false` | scope 用 WorkspaceId 且每个工作区独立库文件 |

### 安全

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `requireApprovalForWrites` | `true` | 写工具走人工确认（无审批通道即拒绝） |
| `readOnly` | `false` | 只读模式，写工具直接 deny |
| `allowRawSql` | `true` | 关闭后 `dataset_query` 仅接受结构化参数 |
| `maxFileBytes` | `209715200` | 单个导入文件字节上限 |
| `maxInsertRows` | `500` | `dataset_insert` 单次行数上限 |
| `maxQueryRows` | `200` | `dataset_query` 可服务行数上限 |
| `batchSize` / `backgroundThresholdRows` | `100` / `20000` | 插入批大小 / 超过该行数自动转后台导入 |
| `previewSampleRows` | `100` | 类型推断采样行数 |

### 结果视图与预览

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `viewMode` | `auto` | `auto` / `always` / `never` |
| `viewThresholdRows` / `viewThresholdBytes` | `20` / `4096` | `auto` 模式的建视图阈值 |
| `previewRows` / `previewStrategy` | `5` / `head` | 预览行数；`head` 或 `head-tail` |
| `previewCellChars` / `previewColumns` | `40` / `12` | 单元格截断长度 / 展示列数上限 |
| `summaryEnabled` | `true` | 是否生成列统计摘要 |
| `summaryMaxColumns` / `summaryMaxTextColumns` | `24` / `3` | 参与摘要的列数 / 取值分布的文本列数上限 |
| `defaultPageSize` / `maxPageSize` / `maxViewRows` | `100` / `500` / `50000` | 前端首页行数 / 单页上限 / 单视图可翻到的最大行数 |
| `viewRoutePrefix` | `/api/lh-data` | 前端分页接口路由前缀 |

### 设置页

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `adminEnabled` | `true` | 是否挂载管理接口 |
| `adminMaxBodyBytes` | `65536` | 请求体字节上限 |
| `adminMaxDatasets` | `500` | 聚合列表扫描上限 |

### 数据源（关系型数据库）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `datasourceEnabled` | `true` | 总开关；`false` 时不注册 `datasource_*` 工具与 `/sources` 接口 |
| `datasourceFetchBatchSize` | `1000` | 远端表分块拉取的行数 |
| `datasourceConnectTimeoutMs` | `10000` | 连接 / 连通性测试的超时毫秒数 |
| `datasourceMaxImportRows` | `0` | 单次从远端表导入的行数上限，`0` 表示不限 |
| `datasourceEncryptKey` | `''` | 数据源密码的加密密钥；留空则回落到环境变量 `LH_DATA_ENCRYPT_KEY`，再空用内置默认并告警（生产不安全） |

---

## 作用域与安全

- **scope 解析**：默认取 `exec.agent.session.header.cwd`（兼容扁平 `session.cwd`），经 `realpath` 规范化后作为 `scopeKey`；`perWorkspace=true` 时提升为 `ws:<WorkspaceId>`。拿不到会话 cwd 时 **fail-loud 报错**，绝不静默回落 `process.cwd()`。
- **路径围栏**：导入文件解析后必须落在 scope 目录内，扩展名白名单 `.xlsx` / `.xls` / `.csv`。
- **SQL 校验**：剥离注释与字符串字面量后检测多语句与写关键字；表引用必须在白名单内；单条 `SELECT` / `WITH` / `EXPLAIN`，超长（> 8000 字符）拒绝。
- **写门禁**：`tools/pre-execute` 对写工具返回 `ask`；`ctx.tools.guard()` 单调守卫，写工具缺 `dataset`（导入缺 `path`）一律拒绝；`readOnly` 下 deny。
- **句柄化**：物理表名只出现在 `store.ts` / `view.ts` 内部，工具描述、返回值、HTTP 响应、错误文本都不含。

---

## 目录结构

```
src/
  index.ts            插件入口：name / inject / Config / apply，门禁与生命周期
  tooling.ts          工具定义适配器（零 dsh 运行时依赖）：toolDef、参数校验、ToolError
  db.ts               libSQL 客户端与生命周期、PRAGMA、JSON 规整、库 URL 解析
  store.ts            datasets 元数据层、物理表名生成、归属断言
  table.ts            物理表建/插/改/删，按列类型转换
  sql.ts              只读校验器、结构化查询拼装、标识符引号化
  parse.ts            XLSX / CSV 解析、列名消毒与类型推断
  preview.ts          模型可见片段（预览行 + 全表列统计）
  render.ts           纯函数文本渲染（列表 / 列 / 行 / 查询预览）
  view.ts             结果视图注册中心（持久化到 lh_views）
  scope.ts            scope 解析与路径围栏
  scope-registry.ts   scope 注册表
  http.ts             视图分页路由
  http-common.ts      鉴权、请求体、响应公共逻辑
  admin*.ts           设置页服务层 / 路由 / 校验 / 双半身契约
  tools/              registry（12 工具聚合）、import、read、write、datasource
  datasource/         数据源模块：types / crypto / columns / driver / connector（mysql|pg）/ connection / source-sql / source-store / importer
  client/             浏览器半身：查询结果卡片 + 设置页分区（DatasetsPanel / DataSourcesPanel / DataSourceForm / SourceTablesPanel）
docs/                 设计文档
examples/             四个自包含验证脚本（构造最小假 ctx 跑通全链路）
```

## 设计文档

- `docs/excel-to-turso-skill设计.md` —— 数据层、工具集、作用域与安全设计
- `docs/查询结果视图与前端分页设计.md` —— 结果视图、分页协议与前端卡片
