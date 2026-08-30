/**
 * 工具定义适配器 —— 设计文档 §2.2 的**方案 B**（零 dsh 运行时依赖）。
 *
 * 与 `dsh-lh-judge` 保持一致：运行时不 import 任何 dsh 框架包，手写
 * `ToolDefinition` 字面量 + 自持参数校验。切换方案 A（`@deepseek-ai/dsh-tools`
 * 的 `defineTool`）时只改本文件：其余模块只依赖这里导出的
 * `ToolSpec` / `ValueSchemaSpec` / `ToolExec` 三个契约。
 *
 * 类型层刻意与 dsh-tools 的 `ParameterSchemaSpec` / `ValueSchemaSpec` 同构：
 * - 参数根对象是隐式开放对象，必填用属性级 `required: true` 标注；
 * - 显式 object 节点必须写 `additionalProperties: true | false`；
 * - 编译产物是 dsh-tools `json-schema.ts` 的受支持子集（否则 `register()` 会抛
 *   `UNSUPPORTED_SCHEMA`）。
 */

/** 插件标识：回注消息与后台任务的 `source.plugin` 字段。 */
export const PLUGIN_NAME = 'dsh-lh-data'

// ── JSON 值与模型可见内容 ────────────────────────────────────────────────

export type JsonScalar = string | number | boolean | null
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

/** 模型可见内容块（本插件只产出文本）。 */
export interface TextContentBlock {
  type: 'text'
  text: string
}

export type ContentBlock = TextContentBlock

// ── 作者侧 schema DSL ────────────────────────────────────────────────────

/** 所有节点共享的注解关键字。 */
export interface ValueSchemaAnnotations {
  description?: string
  title?: string
}

export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'string'
  enum?: readonly string[]
}

export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'number'
}

export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'integer'
}

export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'boolean'
}

export interface NullValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'null'
}

export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'array'
  items?: ValueSchemaSpec
}

/** 显式对象节点；开放性是必填字段，避免拿到 JSON Schema 的意外默认值。 */
export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'object'
  properties?: { [key: string]: ValueSchemaSpec }
  additionalProperties: boolean
}

/** 作者侧「任意无损 JSON」节点；编译后是注解-only schema。 */
export interface JsonValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'json'
}

export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
  oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]]
}

export type ValueSchemaSpec =
  | StringValueSchemaSpec
  | NumberValueSchemaSpec
  | IntegerValueSchemaSpec
  | BooleanValueSchemaSpec
  | NullValueSchemaSpec
  | ArrayValueSchemaSpec
  | ObjectValueSchemaSpec
  | JsonValueSchemaSpec
  | OneOfValueSchemaSpec

/** 隐式参数根对象的一个属性；`required: true` 表示必填。 */
export type ParameterPropertySpec = ValueSchemaSpec & { required?: true }

export type ParameterSchemaSpec = { [key: string]: ParameterPropertySpec }

// ── 类型推导 ────────────────────────────────────────────────────────────

/** 拍平交叉类型，便于 hover 阅读。 */
type Simplify<T> = { [K in keyof T]: T[K] } & {}

/** 标记为必填的属性名。 */
type RequiredKeys<S> = {
  [K in keyof S]: S[K] extends { required: true } ? K : never
}[keyof S]

/** 显式对象节点的推导（含声明的开放性）。 */
type InferObject<S extends { additionalProperties: boolean }> =
  S extends { properties: infer P }
    ? S['additionalProperties'] extends true
      ? { [K in keyof P]: InferValue<P[K]> } & JsonObject
      : { [K in keyof P]: InferValue<P[K]> }
    : S['additionalProperties'] extends true
      ? JsonObject
      : Record<string, never>

/** 一个节点接受的 TypeScript 值。 */
export type InferValue<S> =
  S extends { type: 'string' }
    ? S extends { enum: readonly (infer E)[] } ? E : string
    : S extends { type: 'number' | 'integer' }
      ? S extends { enum: readonly (infer E)[] } ? E : number
      : S extends { type: 'boolean' } ? boolean
        : S extends { type: 'null' } ? null
          : S extends { type: 'array' }
            ? S extends { items: infer I } ? InferValue<I>[] : JsonValue[]
            : S extends { type: 'object'; additionalProperties: boolean } ? Simplify<InferObject<S>>
              : S extends { type: 'json' } ? JsonValue
                : S extends { oneOf: readonly (infer B)[] } ? InferValue<B>
                  : never

/** 一个隐式参数 map 推导出的 args 对象类型。 */
export type InferArgs<S extends ParameterSchemaSpec> = Simplify<
  & { [K in RequiredKeys<S>]: InferValue<S[K]> }
  & { [K in Exclude<keyof S, RequiredKeys<S>>]?: InferValue<S[K]> }
>

// ── 受支持 JSON Schema 子集 ─────────────────────────────────────────────

export type JsonSchemaScalar = string | number | boolean | null
export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

export interface JsonSchemaNode {
  type?: JsonSchemaType
  oneOf?: JsonSchemaNode[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchemaNode
  enum?: JsonSchemaScalar[]
  description?: string
  title?: string
}

const CONSTRAINT_KEYWORDS = ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum']
const ANNOTATION_KEYWORDS = ['description', 'title']
const SCHEMA_TYPES: readonly JsonSchemaType[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

/** 工具定义的作者错误（schema 写错）：让插件加载即报错，而不是运行时才发现。 */
export class ToolSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolSchemaError'
  }
}

/** 工具通用错误；`code` 便于门禁与日志归类。 */
export class ToolError extends Error {
  readonly code: string

  constructor(message: string, code = 'TOOL_ERROR') {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

/** 模型生成的参数不合法（对应 dsh-tools 的 `ToolArgsError` / `INVALID_ARGS`）。 */
export class ToolArgsError extends ToolError {
  readonly violations: string[]

  constructor(violations: string[]) {
    super(`invalid arguments: ${violations.join('; ')}`, 'INVALID_ARGS')
    this.name = 'ToolArgsError'
    this.violations = violations
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

function isJsonNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
}

/** 判断一个值是否为无损 JSON（用于 `json` 节点）。 */
export function isJsonValue(value: unknown, depth = 0): boolean {
  if (value === null) return true
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return true
  if (kind === 'number') return isJsonNumber(value)
  if (kind !== 'object' || depth > 32) return false
  if (Array.isArray(value)) return value.every(entry => isJsonValue(entry, depth + 1))
  if (!isPlainRecord(value)) return false
  return Object.values(value).every(entry => isJsonValue(entry, depth + 1))
}

// ── 编译：作者 DSL → 受支持子集 ──────────────────────────────────────────

function authorError(message: string): never {
  throw new ToolSchemaError(message)
}

function copyAnnotations(spec: Record<string, unknown>, node: JsonSchemaNode): void {
  if (typeof spec.description === 'string') node.description = spec.description
  if (typeof spec.title === 'string') node.title = spec.title
}

function assertAuthorKeys(spec: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(spec)) {
    if (!allowed.includes(key)) authorError(`${path}.${key} 不是受支持的关键字（${allowed.join('/')}）`)
  }
}

function compileNode(spec: unknown, path: string, allowRequired: boolean): JsonSchemaNode {
  if (!isPlainRecord(spec)) authorError(`${path} must be a value schema object`)
  const allowed = [...ANNOTATION_KEYWORDS, ...CONSTRAINT_KEYWORDS, ...(allowRequired ? ['required'] : []), 'const']
  assertAuthorKeys(spec, path, allowed)

  const node: JsonSchemaNode = {}
  copyAnnotations(spec, node)

  if (Object.hasOwn(spec, 'oneOf')) {
    assertAuthorKeys(spec, path, [...ANNOTATION_KEYWORDS, 'oneOf', ...(allowRequired ? ['required'] : [])])
    const branches = spec.oneOf
    if (!Array.isArray(branches) || branches.length < 2) authorError(`${path}.oneOf 至少需要两个分支`)
    node.oneOf = branches.map((branch, index) => compileNode(branch, `${path}.oneOf[${index}]`, false))
    return node
  }

  const type = spec.type
  switch (type) {
    case 'json':
      assertAuthorKeys(spec, path, [...ANNOTATION_KEYWORDS, 'type', ...(allowRequired ? ['required'] : [])])
      break
    case 'object': {
      assertAuthorKeys(spec, path, [...ANNOTATION_KEYWORDS, 'type', 'properties', 'additionalProperties', ...(allowRequired ? ['required'] : [])])
      if (typeof spec.additionalProperties !== 'boolean') authorError(`${path}.additionalProperties 必须显式声明 true 或 false`)
      node.type = 'object'
      node.additionalProperties = spec.additionalProperties
      if (Object.hasOwn(spec, 'properties')) {
        if (!isPlainRecord(spec.properties)) authorError(`${path}.properties 必须是 schema 对象`)
        const properties: Record<string, JsonSchemaNode> = {}
        for (const [key, child] of Object.entries(spec.properties)) {
          properties[key] = compileNode(child, `${path}.properties.${key}`, false)
        }
        node.properties = properties
      }
      break
    }
    case 'array':
      assertAuthorKeys(spec, path, [...ANNOTATION_KEYWORDS, 'type', 'items', ...(allowRequired ? ['required'] : [])])
      node.type = 'array'
      if (Object.hasOwn(spec, 'items')) node.items = compileNode(spec.items, `${path}.items`, false)
      break
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      assertAuthorKeys(spec, path, [...ANNOTATION_KEYWORDS, 'type', 'enum', 'const', ...(allowRequired ? ['required'] : [])])
      node.type = type
      if (Object.hasOwn(spec, 'enum')) {
        const allowed = spec.enum
        if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every(entry => scalarMatches(type, entry))) {
          authorError(`${path}.enum 必须是非空的 ${type} 数组`)
        }
        node.enum = allowed as JsonSchemaScalar[]
      }
      break
    }
    default:
      authorError(`${path}.type 必须是 string/number/integer/boolean/null/array/object/json，或使用 oneOf`)
  }
  return node
}

function scalarMatches(type: Exclude<JsonSchemaType, 'object' | 'array'>, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return isJsonNumber(value)
    case 'integer': return isJsonNumber(value) && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

/** 编译参数 map（隐式开放对象根）。 */
export function compileParameters(spec: ParameterSchemaSpec): JsonSchemaNode {
  if (!isPlainRecord(spec)) authorError('parameters 必须是属性 schema 的对象')
  const properties: Record<string, JsonSchemaNode> = {}
  const required: string[] = []
  for (const [key, child] of Object.entries(spec)) {
    if (!isPlainRecord(child)) authorError(`parameters.${key} 必须是 value schema 对象`)
    if (Object.hasOwn(child, 'required')) {
      if (child.required !== true) authorError(`parameters.${key}.required 只能是 true`)
      required.push(key)
    }
    properties[key] = compileNode(child, `parameters.${key}`, true)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/** 编译输出 schema（任意 JSON 根）。 */
export function compileOutputSchema(spec: ValueSchemaSpec): JsonSchemaNode {
  return compileNode(spec, 'output.schema', false)
}

// ── 校验：受支持子集 → 违规列表 ──────────────────────────────────────────

function diagnosticPath(path: string): string {
  return path === '' ? 'arguments' : path
}

function propertyPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

/** 校验一个值是否匹配已编译节点；返回空数组表示通过。 */
export function validateValue(node: JsonSchemaNode, value: unknown, path = ''): string[] {
  if (node.oneOf !== undefined) {
    const matched = node.oneOf.filter(branch => validateValue(branch, value, path).length === 0).length
    return matched === 1 ? [] : [`"${diagnosticPath(path)}" 必须恰好匹配一个 oneOf 分支（命中 ${matched} 个）`]
  }
  const type = node.type
  if (type === undefined) {
    return isJsonValue(value) ? [] : [`"${diagnosticPath(path)}" 必须是无损 JSON 值`]
  }
  switch (type) {
    case 'object': {
      if (!isPlainRecord(value)) return [`"${diagnosticPath(path)}" 必须是对象`]
      const properties = node.properties ?? {}
      const violations: string[] = []
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          violations.push(`missing required property "${propertyPath(path, key)}"`)
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) continue
        violations.push(...validateValue(child, value[key], propertyPath(path, key)))
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) {
            violations.push(`"${propertyPath(path, key)}" 不是已声明的属性（additionalProperties: false）`)
          }
        }
      }
      return violations
    }
    case 'array': {
      if (!Array.isArray(value)) return [`"${diagnosticPath(path)}" 必须是数组`]
      if (node.items === undefined) return []
      const violations: string[] = []
      value.forEach((entry, index) => {
        violations.push(...validateValue(node.items as JsonSchemaNode, entry, `${path}[${index}]`))
      })
      return violations
    }
    case 'string':
      if (typeof value !== 'string') return [`"${diagnosticPath(path)}" 必须是字符串`]
      break
    case 'number':
      if (!isJsonNumber(value)) return [`"${diagnosticPath(path)}" 必须是有限数字`]
      break
    case 'integer':
      if (!isJsonNumber(value) || !Number.isInteger(value)) return [`"${diagnosticPath(path)}" 必须是整数`]
      break
    case 'boolean':
      if (typeof value !== 'boolean') return [`"${diagnosticPath(path)}" 必须是布尔值`]
      break
    case 'null':
      if (value !== null) return [`"${diagnosticPath(path)}" 必须是 null`]
      break
    default:
      return [`"${path}" 使用了未知类型`]
  }
  if (node.enum !== undefined && !node.enum.includes(value as JsonSchemaScalar)) {
    return [`"${diagnosticPath(path)}" 必须是 ${JSON.stringify(node.enum)} 之一`]
  }
  return []
}

// ── 运行时契约（duck-typed） ────────────────────────────────────────────

/** 调用方 agent 的最小视图（duck-typed，不 import dsh 运行时）。 */
export interface AgentLike {
  /**
   * 真实 dsh：`Agent.session` 是 `Session`，工作目录挂在它的 `header.cwd`
   * （`SessionHeader`）；扁平的 `cwd` / `id` 只是 headless 与自测的兼容位。
   */
  session?: { header?: { cwd?: string; id?: string }; cwd?: string; id?: string }
  inject?(message: unknown): void
}

/** `defineTool` 交给 execute 的上下文（`ToolRunContext` 的最小视图）。 */
export interface ToolExec {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: AgentLike
  readonly signal: AbortSignal
  deferContext?(message: unknown): void
}

/** UI 渲染意图：本插件只用 generic 卡片。 */
export interface GenericCallView {
  card: 'generic'
  title: string
  kind?: 'read' | 'write' | 'search' | 'edit' | 'run'
  content?: string
  rawInput?: string
  locations?: { path: string; line?: number }[]
}

export type ToolCallView = GenericCallView

/** 注册到 `ctx.tools` 的原始工具定义。 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
    /** 可选：只给前端的展示元数据（模型不可见）。 */
    presentationMeta?(args: unknown, value: unknown): JsonValue
  }
  execute(args: unknown, exec: ToolExec): Promise<unknown>
  presentCall?(args: unknown): ToolCallView | undefined
}

/** `ctx.tools` 服务的最小视图。 */
export interface ToolRegistry {
  register(definition: ToolDefinition): () => void
  guard?(guard: (exec: ToolExec) => string | undefined): () => void
}

/** `tools/pre-execute` 的决策（与 dsh-tools 的 `PreToolDecision` 同构）。 */
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

export const ALLOW_DECISION: PreToolDecision = { kind: 'allow' }

// ── 工具定义构造器 ──────────────────────────────────────────────────────

export interface ToolOutputSpec<P extends ParameterSchemaSpec, V> {
  /** 规范输出 schema；execute 的返回值会被强制校验。 */
  schema: ValueSchemaSpec
  /**
   * 把规范值渲染成模型可见内容（纯函数，不做 I/O）。
   * 调用处请显式标注 value 的类型（与 execute 的返回类型一致），
   * 以保证 render 内部拿到精确类型。
   */
  render(args: InferArgs<P>, value: V): ContentBlock[]
  /**
   * 只给 UI 的展示元数据（模型不可见）。平台只对顶层调用计算一次，
   * 因此它必须是 (args, value) 的**纯函数**：任何需要交给前端的东西都要随规范值携带。
   */
  presentationMeta?(args: InferArgs<P>, value: V): JsonValue
}

export interface ToolSpec<P extends ParameterSchemaSpec, V> {
  name: string
  /** 模型唯一可见的说明。 */
  description: string
  parameters: P
  output: ToolOutputSpec<P, V>
  /** pending 卡片；参数不合法时由适配器返回 undefined（渲染永不抛错）。 */
  presentCall?(args: InferArgs<P>): ToolCallView | undefined
  execute(args: InferArgs<P>, exec: ToolExec): Promise<V>
}

/**
 * 把作者侧定义编译成注册表可接受的 `ToolDefinition`：
 * - 编译期校验作者 schema（违反受支持子集直接抛错，fail-loud）；
 * - `execute` 前校验模型入参，违规抛 `ToolArgsError`（→ `INVALID_ARGS`）；
 * - `presentCall` 软校验，任何异常回落到通用卡片。
 */
export function toolDef<const P extends ParameterSchemaSpec, V>(spec: ToolSpec<P, V>): ToolDefinition {
  const parameters = compileParameters(spec.parameters)
  const outputSchema = compileOutputSchema(spec.output.schema)
  const validate = (args: unknown): string[] => validateValue(parameters, args, '')
  const userRender = spec.output.render
  const userMeta = spec.output.presentationMeta
  const userExecute = spec.execute
  const userPresentCall = spec.presentCall

  const definition: ToolDefinition = {
    name: spec.name,
    description: spec.description,
    parameters: parameters as unknown as Record<string, unknown>,
    output: {
      schema: outputSchema as unknown as Record<string, unknown>,
      render(args: unknown, value: unknown): ContentBlock[] {
        return userRender(args as InferArgs<P>, value as V)
      },
      ...userMeta === undefined ? {} : {
        presentationMeta(args: unknown, value: unknown): JsonValue {
          return userMeta(args as InferArgs<P>, value as V)
        },
      },
    },
    async execute(args: unknown, exec: ToolExec): Promise<unknown> {
      const violations = validate(args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return userExecute(args as InferArgs<P>, exec)
    },
  }

  if (userPresentCall) {
    definition.presentCall = (args: unknown): ToolCallView | undefined => {
      if (validate(args).length > 0) return undefined
      try {
        return userPresentCall(args as InferArgs<P>)
      } catch {
        return undefined
      }
    }
  }
  return definition
}
