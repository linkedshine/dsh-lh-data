# dsh-lh-data: Let your agent safely treat spreadsheets as databases (Excel / CSV / MySQL / PostgreSQL → local libSQL)


---

Hi all 👋 —— Sharing a community plugin I just finished: **[dsh-lh-data](https://github.com/linkedshine/dsh-lh-data)**.

In one sentence: it imports "Excel / CSV files in your workspace" and "tables from remote MySQL / PostgreSQL" into a local Turso (libSQL), then hands the model a set of **handle-based `dataset_*` tools** for CRUD operations; on the human side, there's also a browser-based settings page ("Settings → Datasets") for visual management.

---

## 1. The three real pain points it aims to solve

There are three common ways to have an agent work with tabular data, and each one has pitfalls:

| Approach | Problem |
| --- | --- |
| Stuffing the whole CSV into context / having the model write Python snippets | A few thousand rows blows up the context; it re-reads everything on every question; results can't be reviewed |
| Letting the model connect directly to the production DB and write SQL | Connection strings, passwords, and real table schemas are all exposed to the model; `UPDATE` has no gate; one slip is an incident |
| Just reading the file as text | Can't aggregate, can't write incrementally, can't "keep asking on this same table next time" |

The idea behind `dsh-lh-data` is: **give the model a "data handle layer", not a database connection.**

- The model only knows the `datasetId` / registered name / business column names (keeping Chinese headers), and **never sees the physical table name**;
- The model only gets "a few preview rows + a full statistical summary", with the **complete result fetched by the frontend table card via `viewId` with pagination**;

---

## 2. Installation

```bash
# Install from the central registry (local source paths are also supported)
npx @deepseek-ai/dsh plugin --profile web add dsh-lh-data

# Uninstall
npx @deepseek-ai/dsh plugin --profile web remove dsh-lh-data
```

It works out of the box with zero required configuration. The database defaults to `$DSH_HOME/lh-data/data.db` (falling back to `~/.dsh` when `DSH_HOME` is unset); the plugin injects default config via `cordis.patch.yml` and also provides a visual management page under "Settings → Datasets" in the browser.

When you need a remote database, just configure `dbUrl` (`file:` or `libsql://`) + `TURSO_AUTH_TOKEN` — no code changes required.

`mysql2` / `pg` ship installed with the plugin by default, but use **dynamic loading** — when you only import Excel / CSV, they are never `require`d at all, so startup is unaffected.

---

## 3. Tool overview (12 tools, 4 of which can be disabled wholesale)

`dataset_*` —— the dataset itself:

| Tool | Type | Description |
| --- | --- | --- |
| `dataset_list` | Read | What datasets exist in the current workspace: row count, column count, status, source |
| `dataset_schema` | Read | Column names (original headers), inferred types, nullability, sample values |
| `dataset_query` | Read | Structured query (`columns` / `where` / `orderBy` / `limit`) or restricted `sql` |
| `dataset_import` | Write | Import `.xlsx` / `.xls` / `.csv`; large files auto-switch to a background task |
| `dataset_insert` / `_update` / `_delete` | Write | Row-level add/update/delete, located via the system column `_row_id` |
| `dataset_drop` | Write | Delete together with the physical table and metadata |

`datasource_*` —— fetch from remote databases (not registered at all when `datasourceEnabled=false`):

| Tool | Description |
| --- | --- |
| `datasource_list` | List registered data sources (MySQL / PostgreSQL), returning no credentials whatsoever |
| `datasource_test` | Connectivity test: latency + server version |
| `datasource_tables` | Browse remote tables: schema, estimated row count, primary keys, column metadata |
| `datasource_import` | Import a remote table in chunks into the **current workspace**, after which it has exactly the same rights as an Excel-imported dataset |

On the credentials side: the return value of `datasource_*` contains **only "whether a password is set"**, never the password itself; on connection failure it returns human-readable messages like "connection refused (host reachable, but port not open or service not started)" or "wrong username or password", and the driver's raw stack never crosses the module boundary.

Two typical sessions:

> You: Import `sales_detail.xlsx` and tell me which region has the highest return rate
>
> agent: `dataset_import(path=…)` → `dataset_schema` → `dataset_query(sql="SELECT region, COUNT(*) … FROM ds GROUP BY region")`
>
> The model only gets 5 preview rows + the statistical summary per column; the full 30k rows are paginated in the frontend card, sortable and exportable to CSV.

> You: Pull the production `orders` table down and reconcile the amounts against this Excel
>
> agent: `datasource_list` → `datasource_tables(source=…)` (view schema / estimated rows / column structure) → `datasource_import(source=…, table="orders")` → after that it's just an ordinary dataset, and filtering and aggregation go back to `dataset_query`
>
> Once the whole chain is done, the model still only holds the `datasetId` — it doesn't know the database name, the instance address, or the password. (The import is a full-table pull, so if you really want "the last three months", you land it in the DB first and then filter with `dataset_query`; if it feels too big you can cap it with `datasourceMaxImportRows`.)

---

## 4. A few design trade-offs worth talking about

### 1. Handle-based: the physical table name is the plugin's private state

The `datasets` metadata table holds `table_name` (of the form `d_<scopeHash8>_<base40>_<ts36>`), and it only appears inside `store.ts` / `view.ts`. **The physical table name does not appear in tool descriptions, tool return values, HTTP responses, or error text** — the model has no opportunity to "guess a table name", and the frontend only gets the `datasetId`.

This also incidentally closes the SQL-injection surface: the raw SQL in `dataset_query` is **stripped of comments and string literals** before validation — a single `SELECT` / `WITH` / `EXPLAIN`, table references must be within a whitelist (using the reserved alias `ds` to refer to the dataset), DDL or write keywords are rejected outright, and overly long statements are rejected.

Datasets imported from a data source follow the same rule: only positioning info like `schema.table` is left in `source_id` / `source_ref` (desensitized, with no credentials), and `source_path` is written as `db:<data source name>`, so `dataset_list` and the settings page can search by data source name with zero changes.

### 2. Context economy: fragments for the model, the full set for the eyes

Under `viewMode=auto`, a result view is only created when the matched row count > 20 or the fragment bytes > 4KB. Once a view is created:

- The model only gets 5 preview rows + the whole-table aggregated `summary` (column stats, value distribution);
- `viewId` / `endpoint` are passed to the frontend via **`presentationMeta`** — **invisible to the model**;
- The frontend card (`src/client/index.ts` taking over `tool.call.toolview`) handles pagination, sorting, and CSV export;
- View metadata persists to `lh_views`, so **pagination still works after restart**; when paginating it queries the original table live, and the card keeps a "data may have changed" hint.

The HTTP interface **accepts no SQL whatsoever** (statements are held by the host-side `ViewRegistry`), and every request first passes through the Host/Origin fence of `connection.requestRejection()` and browser authentication.

### 3. Write operations fail-closed: triple protection

1. `tools/pre-execute` returns `ask` for the 6 write tools (`dataset_import` / `_insert` / `_update` / `_delete` / `_drop`, plus `datasource_import`), with the target handle included in the approval reason;
2. `ctx.tools.guard()` monotonic guard — write tools lacking `dataset` / `path` / `source` are all rejected, and subsequent listeners can't undo it;
3. `readOnly=true` directly results in `deny`.

**No approval channel = rejection**, rather than "just execute it then".

A deliberate trade-off: `requireApprovalForWrites` in the `Config` schema defaults to `true`, but the `cordis.patch.yml` shipped with the repo injects it as `false` — to make it "run through right after install", without the user getting stuck on a popup on first use. **The other two layers of protection are unaffected by this switch**; to go back to per-call confirmation, just change this line back to `true`.

### 4. Data source credentials: encrypted at rest, never echoed back

Passwords use AES-256-GCM (cipher format `iv:authTag:encrypted`, key derived via `scryptSync`), with key priority `datasourceEncryptKey` → `LH_DATA_ENCRYPT_KEY` → built-in default (using the default value triggers a startup warning "unsafe for production"). **Plaintext only exists in memory at the moment of establishing the connection**: tool descriptions, return values, HTTP responses, logs, and error text never contain the password — only "whether a password is set" is exposed.

### 5. Workspace isolation + optional dependency degradation

Datasets are scoped by session cwd (or `ws:<id>` when `perWorkspace=true`); imported files, after parsing, must land within the scope directory (no `../` traversal), with an extension whitelist of `.xlsx` / `.xls` / `.csv`. **When the session cwd can't be obtained it fails loudly**, never silently falling back to `process.cwd()`.

If any of `jobs` / `systemPrompt` / `webServer` / `connection` is missing, only the corresponding capability is degraded: under CLI / TUI profiles the result view automatically degrades to a plain-text fragment, the management interface isn't registered, and the rest of the plugin's capabilities are unaffected. The same applies to database drivers — `mysql2` / `pg` are dynamically `require`d, so when the package is missing only `datasource_*` errors out and gives an install command, while `dataset_*` is completely unaffected.

### 6. Not pinning to dsh's RC waves

`tooling.ts` (the tool-definition adapter) has **zero dsh runtime dependency**; the plugin context is a duck-typed minimal interface that only declares the members actually used. The only runtime dependencies are `@libsql/client` / `xlsx` / `papaparse` + cordis/schemastery (`mysql2` / `pg` are dynamically loaded and never enter the critical path). So however dsh's `0.1.0-rc.x` wave moves, this basically doesn't need to change alongside it — which should also be good news for embedders (scenarios that embed the dsh runtime into a host application).

### 7. Some "pitfalls" in type inference

Column names have the highest priority: `编码 / 编号 / 代码 / 账号 / 证件号 / 邮编 / 电话` (and `code` / `sku` / `ean` / `isbn` / `zip` / `phone` …) are all judged as `text`, to avoid "order numbers read as numbers losing leading zeros"; integers over 13 digits or scientific notation like `1.78E+12` are also forced to `text`, preventing precision loss. The rest are judged `numeric` / `boolean` / `date` / `text` by sampling proportion (default first 100 rows). Column names **keep their original names (including Chinese)**, wrapped in double quotes in SQL.

---

## 5. Settings page: tools are for the model, but the data ultimately belongs to the human

In the browser "Settings → Datasets" (partition id `lh-data`, order 100) there are two tabs:

| Tab | What you can do |
| --- | --- |
| Datasets | A cross-workspace aggregated list (searchable by name), create an empty table, rename / change description / change column notes, view data read-only with pagination, delete together with the physical table |
| Data sources | Register MySQL / PostgreSQL connections (when `test:true` it tests connectivity first and won't persist if unreachable), test connectivity, browse remote table structure and estimated row count, one-click import a table into a specified workspace |

The management interface is fixed at `/api/lh-data/admin` (not registered when `adminEnabled=false`); every request also first passes through the Host/Origin fence and browser authentication; error responses are desensitized and do not echo SQL, physical table names, or passwords. `scope` can only be returned by the caller from a "known workspace list" — **arbitrary paths are not accepted**.

> The column structure corresponds to the physical table DDL and **cannot be changed after creation** — this is also deliberate: rather let you rebuild a dataset than run `ALTER TABLE` on a table the agent might be reading.

---

## 6. How to verify

Instead of adopting a test framework, there are four self-contained scripts, each constructing a minimal fake ctx to run the full chain (requires `pnpm run build` first):

```bash
pnpm run import      # Unit validation + import → list → schema → query → write ops → gate → lifecycle
pnpm run view        # Large result set → fragment → frontend pagination → auth / persistence recovery / degradation
pnpm run admin       # Aggregated list / create empty table / rename & change description / delete / paginated data view
pnpm run datasource  # Encryption & decryption / column mapping / loading gate / data source CRUD / desensitization / auth / degradation
```

To run a real end-to-end import: replace `DEMO` at the top of `run-datasource.mjs` with your own database, then `node examples/run-datasource.mjs --live`.

---

## 7. Known boundaries / open questions

Listing honestly, and discussion or PRs are welcome:

- **Row-level writes, no conditional updates**: `_update` / `_delete` can only locate by `_row_id`, with no "conditional batch update" yet; if needed, I'd lean toward adding a structured `where` that also goes through approval, rather than opening up raw `UPDATE`.
- **Conservative scale limits**: `maxQueryRows` defaults to 200, `maxInsertRows` 500, `maxViewRows` 50000. This is deliberate — it's an "agent's workbench", not a data warehouse.
- **Data sources only cover MySQL / PostgreSQL**: SQLite, SQL Server, and Oracle aren't done yet; connections are cached and reused by `sourceId` (changing / deleting a data source closes the old connection first), pool upper limit defaults to 5, but there's no real stress test of idle reclamation and concurrency limits yet.
- **Default encryption key is insecure**: when `datasourceEncryptKey` / `LH_DATA_ENCRYPT_KEY` aren't configured, a built-in default key is used (with a startup warning). It guards against "password plaintext into logs / into context", not against local attackers — for production use please configure a key.
- **Remote import is a full snapshot**: `datasource_import` pulls the table in chunks (default 1000 rows/batch) and lands it in the DB, with no incremental sync; `datasourceMaxImportRows` can set a ceiling, default unlimited.
- **Data snapshot semantics**: view pagination queries the original table, so "the page you saw at the time" may have been changed. Should we add an optional snapshot to the view (materialized at import time)?
- **Cross-workspace shared datasets**: it's now strictly isolated by scope (though data source config is globally shared). Does anyone actually need "import once, reference across multiple workspaces"? If so, how should the handle layer express the reference relationship?
- **`dbUrl` pointing to remote Turso (`libsql://`)** has only basic validation; there's no real-world data on import performance under high latency yet.

Also, if your team is using cost/performance observability toolchains (such as the community's Langfuse telemetry backend, see #1007): the "preview + summary + view" of `dataset_query` is precisely designed to compress the token consumption of a single session — I'd love to know your measured context savings.

---

Design docs are also in the repo: `docs/excel-to-turso-skill设计.md` (data layer / toolset / scope & security), `docs/查询结果视图与前端分页设计.md` (view protocol & frontend card), `docs/设置页数据集管理设计.md` (management interface & dual-identity contract).

Feedback, issues, and PRs welcome!

- Repo: <https://github.com/linkedshine/dsh-lh-data>
