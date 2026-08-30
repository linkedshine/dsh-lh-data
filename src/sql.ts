/**
 * 只读校验器 + 结构化查询拼装 + 标识符引号化（设计文档 §7.1 / §7.3）。
 *
 * 参考实现的「禁词表」会误伤字符串字面量（如 `WHERE name='DROP'`），这里改为五步校验：
 * 1. 按引号状态机剥离 `--` 与 `/* *\/` 注释（不动字符串字面量）；
 * 2. 把字符串字面量内容置空后再扫分号，拒绝多语句；
 * 3. 首关键字白名单 `{ SELECT, WITH, EXPLAIN }`；
 * 4. 顶层关键字扫描（命中写/DDL/事务关键字即拒绝，因此 `WITH … DELETE` 也会被拦下）；
 * 5. 表引用必须落在当前 scope 已登记的表名集合内；
 * 6. 未显式声明 `LIMIT` 时补 `maxQueryRows`（有 `OFFSET` 无 `LIMIT` 直接拒绝）。
 */

export class SqlError extends Error {
  readonly code = 'INVALID_SQL'

  constructor(message: string) {
    super(message)
    this.name = 'SqlError'
  }
}

const ALLOWED_LEADING_KEYWORDS = ['SELECT', 'WITH', 'EXPLAIN']
const FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'DROP', 'ALTER', 'CREATE',
  'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'BEGIN', 'COMMIT',
]
const FORBIDDEN_IN_WHERE = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'DROP', 'ALTER', 'CREATE',
  'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'FROM', 'UNION',
]
const MAX_SQL_LENGTH = 8000

/** 标识符双引号包裹，内部 `"` 转义为 `""`（列名保留原名/中文）。 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function unquote(name: string): string {
  const trimmed = name.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/""/g, '"')
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1)
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) return trimmed.slice(1, -1)
  return trimmed
}

/**
 * 剥离注释，保留字符串字面量与引号标识符内的原样内容。
 * 逐个扫描字符，按 `'` / `"` / `` ` `` 的状态机跳过引号区域。
 */
export function stripComments(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch
      out += ch
      i += 1
      while (i < sql.length) {
        const current = sql[i]!
        out += current
        i += 1
        if (current === quote) {
          // SQL 的转义是引号翻倍（'' / ""）。
          if (sql[i] === quote) {
            out += sql[i]!
            i += 1
            continue
          }
          break
        }
      }
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      i += 2
      out += ' '
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 把单引号字符串字面量的内容替换为空格（保留引号与长度），供关键字扫描使用。 */
export function blankStringLiterals(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    if (ch !== '\'') {
      out += ch
      i += 1
      continue
    }
    out += '\''
    i += 1
    while (i < sql.length) {
      const current = sql[i]!
      i += 1
      if (current === '\'') {
        if (sql[i] === '\'') {
          out += '\''
          i += 1
          continue
        }
        out += '\''
        break
      }
      out += ' '
    }
  }
  return out
}

/**
 * 把模型书写的 `ds` 别名替换为数据集的物理表名。
 *
 * 模型拿不到（也不该拿到）物理表名，因此原始 SQL 用保留别名 `ds` 指代本数据集；
 * 只替换裸标识符，引号与字符串字面量内部不受影响。
 */
export function substituteDatasetAlias(sql: string, tableName: string): string {
  const replacement = quoteIdentifier(tableName)
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch
      out += ch
      i += 1
      while (i < sql.length) {
        const current = sql[i]!
        out += current
        i += 1
        if (current === quote) {
          if (sql[i] === quote) {
            out += sql[i]!
            i += 1
            continue
          }
          break
        }
      }
      continue
    }
    if (/[A-Za-z_\u4e00-\u9fa5]/.test(ch)) {
      let identifier = ''
      while (i < sql.length && /[\w\u4e00-\u9fa5$]/.test(sql[i]!)) {
        identifier += sql[i]!
        i += 1
      }
      out += identifier.toLowerCase() === 'ds' ? replacement : identifier
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 提取 `FROM` / `JOIN` 之后的表名（跳过子查询 `( … )`）。 */
export function extractTableReferences(sql: string): string[] {
  const identifier = '(?:"[^"]+"|\\[[^\\]]+\\]|`[^`]+`|[A-Za-z_\\u4e00-\\u9fa5][\\w\\u4e00-\\u9fa5$]*)'
  const pattern = new RegExp(`\\b(?:FROM|JOIN)\\s+(${identifier}(?:\\s*\\.\\s*${identifier})?)`, 'gi')
  const names: string[] = []
  for (const match of sql.matchAll(pattern)) {
    const raw = match[1] ?? ''
    const first = raw.split('.')[0] ?? ''
    const trimmed = first.trim()
    if (trimmed.length === 0 || trimmed.startsWith('(')) continue
    names.push(unquote(trimmed))
  }
  return names
}

export interface ReadOnlyQueryOptions {
  /** 当前 scope 已登记的物理表名集合。 */
  allowedTables: Iterable<string>
  /** 未显式声明 LIMIT 时补上的行数上限。 */
  maxRows: number
}

/** 一条语句解析出的 `LIMIT` / `OFFSET`（只认字面量整数，参数化写法交给调用方）。 */
export interface LimitClause {
  limit: number
  offset: number
}

/**
 * 从等长的 `blanked` 里定位 `LIMIT`，用于在 `stripped` 上切掉尾部限制子句。
 * 返回值是 `LIMIT` 关键字在串中的下标；没有则 -1。
 */
function locateLimit(blanked: string): number {
  const match = /\bLIMIT\b/i.exec(blanked)
  return match === null ? -1 : match.index
}

/** 解析 `LIMIT n [OFFSET m | , m]`；只有 OFFSET 没有 LIMIT 时抛错（SQLite 要求 LIMIT 在前）。 */
export function parseLimitClause(blanked: string): LimitClause | undefined {
  const hasLimit = /\bLIMIT\b/i.test(blanked)
  const hasOffset = /\bOFFSET\b/i.test(blanked)
  if (!hasLimit) {
    if (hasOffset) throw new SqlError('使用 OFFSET 时必须同时显式声明 LIMIT')
    return undefined
  }
  const match = /\bLIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+)|\s*,\s*(\d+))?/i.exec(blanked)
  if (match === null) throw new SqlError('LIMIT 只支持字面量整数（分页由视图接管）')
  const limit = Number(match[1])
  const offset = Number(match[2] ?? match[3] ?? 0)
  if (!Number.isFinite(limit) || limit < 1) throw new SqlError('LIMIT 必须是正整数')
  return { limit, offset }
}

/** 校验后的只读语句：分页/计数都从 `baseSql` 派生。 */
export interface NormalizedQuery {
  /** 去掉注释与尾部分号、已通过关键字与表引用校验的语句（仍可能带模型声明的 LIMIT）。 */
  stripped: string
  /** 与 `stripped` **等长**、字符串字面量置空的版本（关键字扫描用）。 */
  blanked: string
  /** 首关键字：`SELECT` / `WITH` / `EXPLAIN`。 */
  leading: string
  /** 模型显式声明的 LIMIT/OFFSET。 */
  limit?: LimitClause
}

/**
 * 只读校验的前五步（设计文档 §5 的 1–5），不做 LIMIT 补全。
 * 校验器只在这里收紧一次，派生的 count/page 语句都建立在它的输出上。
 */
export function normalizeReadOnlyQuery(sql: string, options: ReadOnlyQueryOptions): NormalizedQuery {
  const trimmed = typeof sql === 'string' ? sql.trim() : ''
  if (trimmed.length === 0) throw new SqlError('sql 不能为空')
  if (trimmed.length > MAX_SQL_LENGTH) throw new SqlError(`sql 过长（上限 ${MAX_SQL_LENGTH} 字符）`)

  const stripped = stripComments(trimmed).trim().replace(/;\s*$/, '')
  const blanked = blankStringLiterals(stripped)
  if (blanked.includes(';')) throw new SqlError('只允许单条语句（禁止分号拼接）')

  const leading = /^([A-Za-z_]+)/.exec(stripped)?.[1]?.toUpperCase()
  if (leading === undefined || !ALLOWED_LEADING_KEYWORDS.includes(leading)) {
    throw new SqlError(`只允许 ${ALLOWED_LEADING_KEYWORDS.join(' / ')} 开头的只读语句`)
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(blanked)) {
      throw new SqlError(`只读查询不允许出现关键字 ${keyword}`)
    }
  }

  const allowed = new Set<string>()
  for (const table of options.allowedTables) allowed.add(table.toLowerCase())
  for (const reference of extractTableReferences(stripped)) {
    if (!allowed.has(reference.toLowerCase())) throw new SqlError(`不允许引用未登记的表：${reference}`)
  }

  const limit = parseLimitClause(blanked)
  return { stripped, blanked, leading, ...limit === undefined ? {} : { limit } }
}

/**
 * 校验并规范化一条只读 SQL。返回值是可直接执行的单语句（已补 LIMIT）。
 * 任何不合规都抛 `SqlError`。
 */
export function validateReadOnlyQuery(sql: string, options: ReadOnlyQueryOptions): string {
  const normalized = normalizeReadOnlyQuery(sql, options)
  if (normalized.limit !== undefined) return normalized.stripped
  return `${normalized.stripped} LIMIT ${Math.max(1, Math.floor(options.maxRows))}`
}

/** `where` 是模型提供的布尔表达式片段（不含 WHERE 关键字），做同样的收紧校验。 */
export function validateWhereExpression(expression: string): string {
  const trimmed = typeof expression === 'string' ? expression.trim() : ''
  if (trimmed.length === 0) throw new SqlError('where 不能为空')
  const stripped = stripComments(trimmed).trim()
  const blanked = blankStringLiterals(stripped)
  if (blanked.includes(';')) throw new SqlError('where 不允许分号')
  for (const keyword of FORBIDDEN_IN_WHERE) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(blanked)) {
      throw new SqlError(`where 只允许布尔表达式（出现关键字 ${keyword}）`)
    }
  }
  return stripped
}

/** `orderBy` 形如 `单价 DESC, 名称`，逐项校验并引号化。 */
export function validateOrderBy(expression: string): string {
  const trimmed = typeof expression === 'string' ? expression.trim() : ''
  if (trimmed.length === 0) throw new SqlError('orderBy 不能为空')
  const terms = trimmed.split(',').map(part => part.trim()).filter(part => part.length > 0)
  if (terms.length === 0) throw new SqlError('orderBy 不能为空')
  return terms.map((term) => {
    const match = /^(.+?)(?:\s+(ASC|DESC))?$/i.exec(term)
    const raw = match?.[1]?.trim() ?? ''
    if (raw.length === 0) throw new SqlError(`orderBy 无法解析：${term}`)
    const direction = match?.[2]?.toUpperCase()
    const quoted = quoteIdentifier(unquote(raw))
    return direction === undefined ? quoted : `${quoted} ${direction}`
  }).join(', ')
}

export interface StructuredQuery {
  table: string
  columns?: string[]
  where?: string
  orderBy?: string
  limit?: number
  offset?: number
  /** 该数据集已登记的列名（不含系统列之外的任意标识符）。 */
  allowedColumns: string[]
  maxRows: number
}

/** 结构化查询的骨架：不带 LIMIT 的基础语句 + 稳定排序（总是以 `_row_id` 兜底）。 */
export interface StructuredPlan {
  baseSql: string
  orderBy: string
}

/**
 * 拼装结构化查询的骨架（插件自己拼 SQL，天然安全，作为推荐路径）。
 * 排序恒定追加 `_row_id` 兜底键，保证翻页不重不漏（设计文档 §6）。
 */
export function buildStructuredPlan(query: StructuredQuery): StructuredPlan {
  const allowed = new Set(query.allowedColumns)
  const selected: string[] = []
  for (const column of query.columns ?? []) {
    if (column === '*') {
      selected.push('*')
      continue
    }
    if (!allowed.has(column)) throw new SqlError(`未知列：${column}`)
    selected.push(quoteIdentifier(column))
  }
  const projection = selected.length === 0
    ? '_row_id, *'
    : ['_row_id', ...selected].join(', ')

  const parts = [`SELECT ${projection} FROM ${quoteIdentifier(query.table)}`]
  if (query.where !== undefined) parts.push(`WHERE (${validateWhereExpression(query.where)})`)

  const tie = `${quoteIdentifier(query.table)}._row_id`
  const orderBy = query.orderBy === undefined
    ? tie
    : `${validateOrderBy(query.orderBy)}, ${tie}`
  return { baseSql: parts.join(' '), orderBy }
}

/** 拼装结构化查询（插件自己拼 SQL，天然安全，作为推荐路径）。 */
export function buildStructuredQuery(query: StructuredQuery): { sql: string; params: unknown[] } {
  const { baseSql, orderBy } = buildStructuredPlan(query)
  const maxRows = Math.max(1, Math.floor(query.maxRows))
  const limit = query.limit === undefined ? maxRows : Math.min(Math.max(1, Math.floor(query.limit)), maxRows)
  const offset = query.offset === undefined ? 0 : Math.max(0, Math.floor(query.offset))
  return { sql: `${baseSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, params: [limit, offset] }
}

// ── 查询计划：count / page 派生（设计文档 §5.3 / §6） ─────────────────────

/** 一条可分页的只读查询计划。三条语句都建立在**已校验**的基础语句之上。 */
export interface QueryPlan {
  /** 已校验、已切掉模型声明的 LIMIT/OFFSET 与 ORDER BY 的基础语句。 */
  baseSql: string
  /** 模型（或结构化参数）给出的排序项，已引号化；可空。 */
  baseOrder?: string
  /** 兜底排序键（通常 `_row_id`）；拿不到时为空，此时不保证翻页稳定。 */
  tie?: string
  /** `SELECT COUNT(*) … FROM (<baseSql>)`。 */
  countSql: string
  /** 默认排序下的分页语句：`… ORDER BY … LIMIT ? OFFSET ?`。 */
  pageSql: string
  /** 该计划能服务的最大行数（模型声明的 LIMIT 与 maxRows 取小）。 */
  rowCap: number
  /** 模型是否显式声明了 LIMIT（未声明时视图上限另按 maxViewRows 计算）。 */
  declaredLimit?: number
  /** 模型声明的 OFFSET：只影响它看到的片段，视图始终从第一行开始。 */
  previewOffset: number
  /** 排序是否稳定：false 时前端禁止深翻页。 */
  stable: boolean
  /** EXPLAIN 语句：不产生视图，也不分页。 */
  explain: boolean
}

function countOf(baseSql: string): string {
  return `SELECT COUNT(*) AS _total FROM (${baseSql})`
}

/** 按「基础语句 + 排序项 + 兜底键」拼分页语句。 */
export function composePagedSql(plan: Pick<QueryPlan, 'baseSql' | 'baseOrder' | 'tie'>): string {
  const terms = [plan.baseOrder, plan.tie].filter((term): term is string => typeof term === 'string' && term.length > 0)
  const orderBy = terms.length > 0 ? ` ORDER BY ${terms.join(', ')}` : ''
  return `${plan.baseSql}${orderBy} LIMIT ? OFFSET ?`
}

/** 由结构化参数派生查询计划（排序恒定以 `_row_id` 兜底）。 */
export function planStructuredQuery(query: StructuredQuery): QueryPlan {
  const { baseSql, orderBy } = buildStructuredPlan(query)
  const maxRows = Math.max(1, Math.floor(query.maxRows))
  const declared = query.limit === undefined ? undefined : Math.max(1, Math.floor(query.limit))
  const tie = `${quoteIdentifier(query.table)}._row_id`
  const baseOrder = query.orderBy === undefined ? undefined : validateOrderBy(query.orderBy)
  const plan: QueryPlan = {
    baseSql,
    countSql: countOf(baseSql),
    pageSql: '',
    rowCap: Math.min(declared ?? maxRows, maxRows),
    previewOffset: Math.max(0, Math.floor(query.offset ?? 0)),
    stable: true,
    explain: false,
    tie,
    ...declared === undefined ? {} : { declaredLimit: declared },
  }
  return { ...plan, ...baseOrder === undefined ? {} : { baseOrder }, pageSql: composePagedSql({ baseSql, baseOrder, tie }) }
}

/**
 * 由模型书写的原始 SQL 派生查询计划。
 *
 * 基础语句先过 `normalizeReadOnlyQuery`（含表引用白名单），随后：
 * 1. 切掉尾部 `LIMIT/OFFSET` —— 分页由视图接管，模型声明的 LIMIT 降级为行数上限；
 * 2. 只有「单表 + 无 GROUP BY/DISTINCT + 非复合查询」时才补 `_row_id` 兜底排序，
 *    其余情况保留模型自己的 ORDER BY，并把 `stable` 记为 false。
 */
export function planRawQuery(sql: string, options: ReadOnlyQueryOptions): QueryPlan {
  const normalized = normalizeReadOnlyQuery(sql, options)
  const maxRows = Math.max(1, Math.floor(options.maxRows))

  // 1) 切掉尾部 LIMIT/OFFSET：分页由视图接管，声明的 LIMIT 降级为行数上限。
  const limitAt = locateLimit(normalized.blanked)
  let stripped = limitAt < 0 ? normalized.stripped : normalized.stripped.slice(0, limitAt)
  let blanked = limitAt < 0 ? normalized.blanked : normalized.blanked.slice(0, limitAt)

  // 2) 切出顶层 ORDER BY（blanked 与 stripped 等长，下标可直接复用）。
  //    括号内的 ORDER BY（窗口函数）深度不为 0，必须整段留在基础语句里。
  let baseOrder: string | undefined
  const orderMatch = /\bORDER\s+BY\b/i.exec(blanked)
  if (orderMatch !== null && parenDepth(blanked, orderMatch.index) === 0) {
    baseOrder = stripped.slice(orderMatch.index + orderMatch[0].length).trim()
    stripped = stripped.slice(0, orderMatch.index)
    blanked = blanked.slice(0, orderMatch.index)
  }

  const baseSql = stripped.trim()
  if (baseSql.length === 0) throw new SqlError('sql 缺少可执行的查询语句')

  const compound = /\bUNION\b|\bINTERSECT\b|\bEXCEPT\b/i.test(blanked)
  const grouped = /\bGROUP\s+BY\b/i.test(blanked) || /\bDISTINCT\b/i.test(blanked)
  const aggregated = /\b(?:COUNT|SUM|AVG|MIN|MAX|TOTAL|GROUP_CONCAT)\s*\(/i.test(blanked)
  const tables = extractTableReferences(baseSql)
  // 只有「单表 + 非分组 + 非聚合 + 非复合」时才补 `_row_id` 兜底排序。
  const canTiebreak = !compound && !grouped && !aggregated && tables.length === 1 && normalized.leading !== 'EXPLAIN'
  const tie = canTiebreak ? `${quoteIdentifier(tables[0]!)}._row_id` : undefined
  const stable = canTiebreak || (baseOrder !== undefined && !compound)

  const plan: QueryPlan = {
    baseSql,
    countSql: countOf(baseSql),
    pageSql: '',
    rowCap: Math.min(normalized.limit?.limit ?? maxRows, maxRows),
    previewOffset: Math.max(0, Math.floor(normalized.limit?.offset ?? 0)),
    stable,
    explain: normalized.leading === 'EXPLAIN',
    ...normalized.limit === undefined ? {} : { declaredLimit: normalized.limit.limit },
  }
  return {
    ...plan,
    ...baseOrder === undefined ? {} : { baseOrder },
    ...tie === undefined ? {} : { tie },
    pageSql: composePagedSql({ baseSql, baseOrder, tie }),
  }
}

/** 下标 `index` 之前的括号深度（用于区分顶层与子查询内的关键字）。 */
function parenDepth(blanked: string, index: number): number {
  let depth = 0
  for (let i = 0; i < index; i += 1) {
    const ch = blanked[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
  }
  return depth
}
