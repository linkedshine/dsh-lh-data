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

/**
 * 校验并规范化一条只读 SQL。返回值是可直接执行的单语句（已补 LIMIT）。
 * 任何不合规都抛 `SqlError`。
 */
export function validateReadOnlyQuery(sql: string, options: ReadOnlyQueryOptions): string {
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

  const hasLimit = /\bLIMIT\b/i.test(blanked)
  const hasOffset = /\bOFFSET\b/i.test(blanked)
  if (hasLimit) return stripped
  // SQLite 要求 LIMIT 在 OFFSET 之前，无法简单地追加，直接要求调用方显式声明。
  if (hasOffset) throw new SqlError('使用 OFFSET 时必须同时显式声明 LIMIT')
  return `${stripped} LIMIT ${Math.max(1, Math.floor(options.maxRows))}`
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

/** 拼装结构化查询（插件自己拼 SQL，天然安全，作为推荐路径）。 */
export function buildStructuredQuery(query: StructuredQuery): { sql: string; params: unknown[] } {
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
  if (query.orderBy !== undefined) parts.push(`ORDER BY ${validateOrderBy(query.orderBy)}`)

  const maxRows = Math.max(1, Math.floor(query.maxRows))
  const limit = query.limit === undefined ? maxRows : Math.min(Math.max(1, Math.floor(query.limit)), maxRows)
  const offset = query.offset === undefined ? 0 : Math.max(0, Math.floor(query.offset))
  parts.push('LIMIT ? OFFSET ?')
  return { sql: parts.join(' '), params: [limit, offset] }
}
