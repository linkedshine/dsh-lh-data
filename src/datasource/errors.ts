/**
 * 数据源模块的统一错误类型。
 *
 * 主机侧的边界（工具 / 管理接口）把它翻译成 `ToolError` / `AdminServiceError`。
 * 错误文本一律脱敏：不含密码、不含本地物理表名。
 */

export type DataSourceErrorCode =
  | 'NOT_FOUND'
  | 'DRIVER_MISSING'
  | 'UNREACHABLE'
  | 'BAD_REQUEST'
  | 'TOO_MANY_ROWS'
  | 'IMPORT_FAILED'

export class DataSourceError extends Error {
  readonly code: DataSourceErrorCode

  constructor(code: DataSourceErrorCode, message: string) {
    super(message)
    this.name = 'DataSourceError'
    this.code = code
  }
}

export function isDataSourceError(error: unknown): error is DataSourceError {
  return error instanceof DataSourceError
}

/**
 * 原生驱动错误 → 脱敏的中文提示。
 * 只保留可定位的主机与端口，凭据绝不进文本。
 */
export function describeCause(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string') {
    if (code === 'ECONNREFUSED') return '连接被拒绝（主机可达，但端口未开放或服务未启动）'
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '主机名无法解析'
    if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH') return '连接超时（主机不可达或被防火墙拦截）'
    if (code === 'ER_ACCESS_DENIED_ERROR' || code === '28P01' || code === '28000') return '用户名或密码错误'
    if (code === 'ER_DBACCESS_DENIED_ERROR' || code === '3D000') return '数据库不存在，或该用户无权访问'
    if (code === 'ER_NOT_SUPPORTED_AUTH_MODE') return '服务端认证协议不被驱动支持'
    if (code === 'EPROTO') return 'SSL 协商失败（检查 sslMode 配置）'
  }
  const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
  return message.trim().length > 0 ? message.trim() : '未知错误'
}

/**
 * 连接 / 查询异常归一为 `DataSourceError`。
 * 已经是 `DataSourceError` 的（如 DRIVER_MISSING）保持原语义，其余按「连不上」处理，
 * 这样工具与设置页永远不会把驱动的裸栈抛给模型 / 浏览器。
 */
export function wrapConnectionError(error: unknown, host: string, port: number): unknown {
  if (isDataSourceError(error)) return error
  return new DataSourceError('UNREACHABLE', `连接 ${host}:${port} 失败：${describeCause(error)}`)
}

/** 错误码 → HTTP 状态码（管理接口用；工具侧另有一套映射）。 */
export function dataSourceErrorStatus(code: DataSourceErrorCode): number {
  switch (code) {
    case 'NOT_FOUND': return 404
    case 'DRIVER_MISSING': return 503
    case 'UNREACHABLE': return 502
    case 'BAD_REQUEST': return 400
    case 'TOO_MANY_ROWS': return 413
    default: return 500
  }
}
