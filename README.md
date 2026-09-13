# dsh-lh-data

A [dsh](https://github.com/deepseek-ai) (deepseek-harness) plugin that imports Excel / CSV files from the workspace into a local Turso (libSQL) database and exposes CRUD operations through **handle-based `dataset_*` tools**.

Core design: **physical table names never leak**. The model only sees `datasetId` / registered name / business column names (Chinese headers are preserved); queries return only a "small preview slice + full aggregate summary", while the complete result is paginated by the **front-end table card via `viewId`**.

---

## Features

- **8 `dataset_*` tools**: import, list, column info, query, insert, update, delete, drop.
- **4 `datasource_*` tools**: register MySQL / PostgreSQL connections, test connectivity, browse remote tables, and bulk-import a remote table as a dataset; datasets produced this way are fully equal in rights to file-imported ones.
- **Handle-based**: physical table names are held and rewritten by the plugin — invisible in both the model side and HTTP responses.
- **Result views**: large result sets automatically build a view; the model gets only a fragment, while the front-end card paginates / sorts / exports CSV; the view is persisted, so paging still works after a restart.
- **Workspace isolation**: datasets are scoped by session cwd (or WorkspaceId); imported files must land inside the workspace (no `../` traversal).
- **Fail-closed writes**: a triple guard of `tools/pre-execute` gate + monotonic guard + read-only mode.
- **Read-only SQL validation**: raw SQL only permits a single `SELECT` / `WITH` / `EXPLAIN`, with a table-reference allow-list and no DDL / write keywords.
- **Settings page**: under the browser "Settings → Datasets" there are two tabs ("Datasets" / "Data Sources") — aggregate view, create empty tables, edit descriptions, paginate data, and delete; the data-source tab supports registering connections, testing connectivity, browsing remote tables, and one-click import.
- **Optional-dependency degradation**: missing `jobs` / `systemPrompt` / `webServer` / `connection` only degrades the corresponding capability, never blocks loading; `mysql2` / `pg` are **installed by default** with the plugin, but still loaded dynamically — file-only import won't slow startup, and if a driver is missing at runtime you get a clear install hint rather than a bare stack trace.

---

## Common Commands

### Build

```
pnpm run build
```

Two halves of output (built in parallel by `tsdown`, sharing `lib/`):

| Artifact | Format | Entry | Description |
| --- | --- | --- | --- |
| `lib/index.js` | ESM | `src/index.ts` | Host half, cordis plugin |
| `lib/client.js` | CJS factory | `src/client/index.ts` | Browser half, registered to `window.__ModuleLoader__` |

### Type check

```
pnpm run typecheck          # host + client
pnpm run typecheck:host     # host only
pnpm run typecheck:client   # client only
```

### Start web service

```
npx @deepseek-ai/dsh web
```

### Install plugin

Local source
```
npx @deepseek-ai/dsh plugin --profile web add D:\fastwork\projects\node\dsh-lh-data
```

github
```
npx @deepseek-ai/dsh plugin --profile web add https://github.com/linkedshine/dsh-lh-data.git
```

central registry
```
npx @deepseek-ai/dsh plugin --profile web add dsh-lh-data
```

remove:

```
npx @deepseek-ai/dsh plugin --profile web remove dsh-lh-data
```

The plugin injects default config via `cordis.patch.yml` (`dbPath` empty, `requireApprovalForWrites: false`).

### Validation scripts (build first)

```
pnpm run import   # examples/run-import.mjs: unit checks + import → list → schema → query → writes → gate → lifecycle
pnpm run view     # examples/run-view.mjs  : large result set → fragment → front-end paging → auth / persistence restore / degradation
pnpm run admin    # examples/run-admin.mjs : aggregate list / create empty table / rename & edit description / delete / paginate data
pnpm run datasource  # examples/run-datasource.mjs: encrypt/decrypt / column mapping / load gate / datasource CRUD / masking / auth / degradation
```

`mysql2` / `pg` are installed by default with the plugin; after `pnpm install` you can connect to databases. To run a real end-to-end import test: change `DEMO` at the top of the script to your database, then `node examples/run-datasource.mjs --live`.

On connection failure (port closed, host unreachable, wrong credentials, missing database, etc.), the tools and settings page uniformly return a **readable cause in Chinese** (e.g. "connection refused (host reachable, but port not open or service not started)") instead of bubbling the driver's bare stack to the model or browser; if a driver is genuinely missing you still get `pnpm add mysql2` / `pnpm add pg` hints.

---

## Tool Reference

| Tool | Type | Main params | Returns |
| --- | --- | --- | --- |
| `dataset_list` | read | — | `datasets[]`: `datasetId`, `name`, rows, cols, `status`, `sourcePath`, timestamps |
| `dataset_schema` | read | `dataset` | column names (original headers), `sanitizedName`, inferred type, nullable, sample value, description |
| `dataset_query` | read | `dataset`, `columns`, `where`, `orderBy`, `limit`, `offset`, `sql` | `matchedRows` / `totalRows`, `preview` (few preview rows), `summary` (column stats), optional `view` |
| `dataset_import` | write | `path`, `name?`, `sheet?`, `limit?`, `background?` | `datasetId`, rows/cols, `status: ready \| running`, `jobId?`, column info |
| `dataset_insert` | write | `dataset`, `rows[]` | `inserted`, latest `rowCount` |
| `dataset_update` | write | `dataset`, `rowId`, `data` | `updated`, `changedColumns[]` |
| `dataset_delete` | write | `dataset`, `rowId` | `deleted`, remaining `rowCount` |
| `dataset_drop` | write | `dataset` | `dropped` (drops physical table and metadata together, unrecoverable) |
| `datasource_list` | read | — | `sources[]`: `id`, `name`, `type`, `host`, `port`, `database`, `status`, `lastError`, `lastCheckedAt` (no password) |
| `datasource_test` | read | `source` | `success` / `latency` / `version` / `error` |
| `datasource_tables` | read | `source`, `schema?`, `q?` | `tables[]`: table name / schema / estimated rows / column structure (name / inferred type / nullable / comment) |
| `datasource_import` | write | `source`, `table`, `schema?`, `name?`, `limit?` | `datasetId`, rows/cols, `status: ready \| running`, `jobId?` |

Notes:

- `datasource_*` connection passwords are never echoed in **any** tool description, return value, HTTP response, log, or error text — only "whether a password is set" is exposed.
- `datasource_import` goes through the write gate; it is rejected outright when `readOnly=true` or `datasourceEnabled=false`; the resulting dataset lands in the **current session workspace**, and is thereafter operated on only via `dataset_*` tools.
- When the driver (`mysql2` / `pg`) is not installed, `datasource_test` / `datasource_tables` / `datasource_import` return a readable error with a `pnpm add mysql2` (or `pg`) hint, no bare stack.

- Always pass `dataset` as a **datasetId or registered name** — never guess the physical table name.
- Prefer structured params for queries; only pass `sql` when you need aggregation / joins, using the reserved alias `ds` for the dataset, e.g.:
  ```sql
  SELECT 状态, COUNT(*) AS c FROM ds GROUP BY 状态
  ```
- The system column `_row_id` (auto-increment primary key) is returned with results and is the locator key for `update` / `delete`; `_uploaded_at` is maintained by the system. Neither can be written.
- The 5 write tools (`dataset_import` / `_insert` / `_update` / `_delete` / `_drop`) trigger human confirmation by default; they are denied when `readOnly=true`.

---

## Data Model

### Metadata table `datasets` (owned by the plugin, one per scope db)

| Column | Description |
| --- | --- |
| `id` | `ds_<ts36><rand>`, the external datasetId |
| `scope_key` | owning key (normalized cwd path, or `ws:<id>`) |
| `name` | registered name, unique on `(scope_key, name)` |
| `table_name` | physical table name, like `d_<scopeHash8>_<base40>_<ts36>`, held only by the plugin |
| `source_path` / `description` / `row_count` / `columns` / `status` / `error` / `created_at` / `updated_at` | metadata |

`status`: `importing` → `ready` / `failed`. A failed import deletes the half-built physical table and marks `failed`; a non-`ready` dataset is rejected for read/write.

Datasets from a data source leave location info in the `source_id` / `source_ref` columns (`source_ref` is like `schema.table` or `table`, masked, no credentials); `source_path` is also written as `db:<data source name>`, so `dataset_list` and the settings page can search by data-source name with zero changes.

### Data-source registry table `lh_data_sources` (catalog db, shared globally)

The data-source connection config and datasets are **not in the same db**: data sources are stored in the catalog db (sibling to `dataset_scopes`), shared across workspaces; imported datasets still land in each scope's business db.

| Column | Description |
| --- | --- |
| `id` | `dsrc_<ts36><rand>`, the external sourceId |
| `name` | registered name, globally unique |
| `type` / `host` / `port` / `database` / `username` | connection params |
| `password_enc` | AES-256-GCM ciphertext (`iv:authTag:encrypted`), key from `datasourceEncryptKey` → `LH_DATA_ENCRYPT_KEY` → built-in default; **never echoed** |
| `ssl_mode` / `pool_max` / `description` | optional connection params and description |
| `status` | `unknown` / `connected` / `error`, conclusion of the last test |
| `last_error` / `last_checked_at` | masked error and timestamp of the last test |
| `created_at` / `updated_at` | metadata |

### Physical table

```sql
CREATE TABLE <table_name> (
  _row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  "<business column>" <REAL | INTEGER | TEXT>,   -- column name preserves original header (incl. Chinese), double-quoted in SQL
  _uploaded_at INTEGER DEFAULT (strftime('%s','now'))
);
```

Type mapping: `numeric → REAL`, `boolean → INTEGER`, `date / text → TEXT`. On write, values are coerced by column type (bool→0/1, number→Number, date→ISO, object/array→JSON).

### Column names and type inference

- Column names **preserve the original name** (incl. Chinese); empty names fall back to `column`; duplicates get `_2` / `_3` appended (SQL uses `sanitizedName`).
- Type inference (column name has highest priority, sampling defaults to first 100 rows):
  1. Code / number-like column names → `text` (Chinese 「编码/编号/代码/代号/账号/证件号/邮编/区号/电话/手机」, English `code` / `sku` / `ean` / `upc` / `isbn` / `issn` / `postal` / `zip` / `phone` / `tel` / `mobile`);
  2. Integers of 13+ digits or scientific notation like `1.78E+12` → `text` (prevent precision loss);
  3. Numeric ratio > 80% → `numeric`; boolean ratio > 90% → `boolean`; date-regex ratio > 70% → `date`;
  4. Otherwise → `text`.

### DB location

Connection priority: `dbUrl` > `dbPath` > `SQLITE_PATH` > `TURSO_DATABASE_URL` > default `$DSH_HOME/lh-data/data.db` (falls back to `~/.dsh` when `DSH_HOME` is unset). Startup PRAGMA: `journal_mode=WAL`, `foreign_keys=ON`.

---

## Result Views and Front-end Paging

When the model calls `dataset_query`:

1. Under `viewMode=auto`, a view is built only when matched rows > `viewThresholdRows` (default 20) or fragment bytes > `viewThresholdBytes` (default 4KB); `always` / `never` force the switch.
2. After building the view, the model gets only `previewRows` (default 5) preview rows + full-table aggregate `summary`; the `viewId` / `endpoint` are passed to the front-end via **`presentationMeta`** (invisible to the model).
3. The front-end card (`src/client/index.ts`) takes over the render slot keyed `dataset_query` on `tool.call.toolview`, paginating by `viewId`: page, click header to sort, export CSV.
4. View metadata is persisted to `lh_views` (same db and scope as `datasets`), preloaded and restored after restart; paged row data is queried from the original table in real time, so the card keeps a "data may have changed" hint.

### View routes (`viewRoutePrefix` configurable, default `/api/lh-data`)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `{prefix}/views/:viewId` | view metadata (columns, total rows, page limit, sortable columns) |
| `GET` | `{prefix}/views/:viewId/rows?page=&pageSize=&sort=&order=` | fetch one page of data |
| `DELETE` | `{prefix}/views/:viewId` | release the view |

The endpoints **accept no SQL** (statements are held by the host-side `ViewRegistry`); every request passes `connection.requestRejection()` first (Host/Origin fence + browser auth). Without `webServer` / `connection` (CLI / TUI profile) it auto-degrades to a plain-text fragment.

---

## Settings Page Admin API

Fixed under `/api/lh-data/admin` (not affected by `viewRoutePrefix`); not registered when `adminEnabled=false`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/scopes` | known workspace list |
| `GET` | `/datasets?q=&page=&pageSize=` | cross-workspace aggregate list (truncated and hinted beyond `adminMaxDatasets`) |
| `POST` | `/datasets` | create empty dataset (body has `scopeKey` and column definitions) |
| `GET` | `/datasets/:id?scope=` | single detail (incl. read-only column structure) |
| `GET` | `/datasets/:id/rows?scope=&page=&pageSize=` | paginate table data (read-only) |
| `PATCH` | `/datasets/:id?scope=` | rename / edit description / edit source / edit column description & samples |
| `DELETE` | `/datasets/:id?scope=` | delete along with physical table and metadata |
| `GET` | `/sources` | data-source list (masked, no password) |
| `POST` | `/sources` | create data source (`test:true` tests first, won't persist if unreachable) |
| `POST` | `/sources/test` | test connection (body may carry unsaved connection params) |
| `GET` | `/sources/:id` | single detail (no password) |
| `PATCH` | `/sources/:id` | edit connection params / password / name & description |
| `DELETE` | `/sources/:id` | delete the data source |
| `GET` | `/sources/:id/tables?schema=&q=` | list remote tables (incl. schema / estimated rows / column structure) |
| `POST` | `/sources/:id/import` | import a remote table into a specified workspace (`body.scopeKey` + table name) |

Constraints: column name / type / nullability correspond to the physical-table DDL and are **immutable** after creation; `scope` is echoed back by the caller from the "known workspace list" — no arbitrary paths accepted. Error responses are masked, never echo SQL or physical table names, and data-source endpoints never echo passwords either.

Error codes: `UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` / `METHOD_NOT_ALLOWED` / `BAD_REQUEST` / `PAYLOAD_TOO_LARGE` / `READ_ONLY` / `ADMIN_DISABLED` / `SCOPE_UNKNOWN` / `DUPLICATE_NAME` / `INVALID_COLUMNS` / `QUERY_FAILED` / `SOURCE_DISABLED` (datasourceEnabled=false) / `DRIVER_MISSING` (driver not installed) / `SOURCE_UNREACHABLE` (connection failed) / `IMPORT_FAILED` (import exception).

The browser registers a section under "Settings → Datasets" (`ADMIN_SECTION_ID = lh-data`, order 100); components live in `src/client/settings/`.

---

## Configuration

Set in `cordis.patch.yml` or the dsh plugin config (the `Config` schema is the single source of truth for defaults):

### Storage

| Key | Default | Description |
| --- | --- | --- |
| `dbPath` | `''` | libSQL db path; empty → `$DSH_HOME/lh-data/data.db` |
| `dbUrl` | `''` | non-empty overrides `dbPath`; may be `file:` or `libsql://` (remote Turso) |
| `authToken` | `''` | remote token; leave empty to use `TURSO_AUTH_TOKEN` |
| `perWorkspace` | `false` | scope uses WorkspaceId and a separate db file per workspace |

### Security

| Key | Default | Description |
| --- | --- | --- |
| `requireApprovalForWrites` | `true` | write tools go through human confirmation (rejected without an approval channel) |
| `readOnly` | `false` | read-only mode, write tools denied outright |
| `allowRawSql` | `true` | when off, `dataset_query` only accepts structured params |
| `maxFileBytes` | `209715200` | per-import file byte limit |
| `maxInsertRows` | `500` | `dataset_insert` row limit per call |
| `maxQueryRows` | `200` | `dataset_query` servable row limit |
| `batchSize` / `backgroundThresholdRows` | `100` / `20000` | insert batch size / auto background import beyond this row count |
| `previewSampleRows` | `100` | type-inference sampling rows |

### Result views and preview

| Key | Default | Description |
| --- | --- | --- |
| `viewMode` | `auto` | `auto` / `always` / `never` |
| `viewThresholdRows` / `viewThresholdBytes` | `20` / `4096` | view-build thresholds for `auto` mode |
| `previewRows` / `previewStrategy` | `5` / `head` | preview row count; `head` or `head-tail` |
| `previewCellChars` / `previewColumns` | `40` / `12` | cell truncation length / display column cap |
| `summaryEnabled` | `true` | whether to generate column stats summary |
| `summaryMaxColumns` / `summaryMaxTextColumns` | `24` / `3` | columns in summary / text columns with value distribution cap |
| `defaultPageSize` / `maxPageSize` / `maxViewRows` | `100` / `500` / `50000` | front-end first-page rows / per-page cap / max rows paginable per view |
| `viewRoutePrefix` | `/api/lh-data` | front-end paging route prefix |

### Settings page

| Key | Default | Description |
| --- | --- | --- |
| `adminEnabled` | `true` | whether to mount the admin API |
| `adminMaxBodyBytes` | `65536` | request body byte limit |
| `adminMaxDatasets` | `500` | aggregate list scan cap |

### Data sources (relational databases)

| Key | Default | Description |
| --- | --- | --- |
| `datasourceEnabled` | `true` | master switch; `false` means `datasource_*` tools and `/sources` endpoints are not registered |
| `datasourceFetchBatchSize` | `1000` | rows pulled per chunk from a remote table |
| `datasourceConnectTimeoutMs` | `10000` | connection / connectivity-test timeout in ms |
| `datasourceMaxImportRows` | `0` | max rows imported from a remote table per call, `0` = unlimited |
| `datasourceEncryptKey` | `''` | encryption key for data-source passwords; empty falls back to env `LH_DATA_ENCRYPT_KEY`, then built-in default with a warning (unsafe for production) |

---

## Scope and Security

- **scope resolution**: by default takes `exec.agent.session.header.cwd` (compat with flat `session.cwd`), normalized via `realpath` as `scopeKey`; when `perWorkspace=true` it is promoted to `ws:<WorkspaceId>`. When the session cwd can't be obtained it **fails loud**, never silently falling back to `process.cwd()`.
- **path fence**: resolved import files must land inside the scope directory; extension allow-list `.xlsx` / `.xls` / `.csv`.
- **SQL validation**: after stripping comments and string literals, detect multi-statements and write keywords; table references must be in the allow-list; single `SELECT` / `WITH` / `EXPLAIN`, rejects if too long (> 8000 chars).
- **write gate**: `tools/pre-execute` returns `ask` for write tools; `ctx.tools.guard()` monotonic guard, write tools missing `dataset` (import missing `path`) are rejected outright; denied under `readOnly`.
- **handle-based**: physical table names appear only inside `store.ts` / `view.ts`; tool descriptions, return values, HTTP responses, and error text contain none.

---

## Directory Structure

```
src/
  index.ts            plugin entry: name / inject / Config / apply, gate and lifecycle
  tooling.ts          tool definition adapter (zero dsh runtime deps): toolDef, param validation, ToolError
  db.ts               libSQL client and lifecycle, PRAGMA, JSON normalization, db URL parsing
  store.ts            datasets metadata layer, physical table name generation, ownership assertion
  table.ts            physical table create/insert/update/delete, typed conversion
  sql.ts              read-only validator, structured query assembly, identifier quoting
  parse.ts            XLSX / CSV parsing, column-name sanitization and type inference
  preview.ts          model-visible fragment (preview rows + full-table column stats)
  render.ts           pure-function text rendering (list / columns / rows / query preview)
  view.ts             result view registry (persisted to lh_views)
  scope.ts            scope resolution and path fence
  scope-registry.ts   scope registry
  http.ts             view paging routes
  http-common.ts     auth, request body, response common logic
  admin*.ts           settings page service layer / routes / validation / dual-half contract
  tools/              registry (12 tools aggregate), import, read, write, datasource
  datasource/         data-source module: types / crypto / columns / driver / connector (mysql|pg) / connection / source-sql / source-store / importer
  client/             browser half: query-result card + settings page section (DatasetsPanel / DataSourcesPanel / DataSourceForm / SourceTablesPanel)
docs/                 design docs
examples/             four self-contained validation scripts (construct a minimal fake ctx to run the full chain)
```

## Design Docs

- `docs/excel-to-turso-skill设计.md` —— data layer, toolset, scope and security design
- `docs/查询结果视图与前端分页设计.md` —— result views, paging protocol, and front-end card
