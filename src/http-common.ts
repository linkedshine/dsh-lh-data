/**
 * 自建 HTTP 路由的公共层（视图路由与管理路由共用）。
 *
 * 抽出原因：`http.ts` 的视图路由已有 160 行，再加管理路由会失控；两路由共享
 * 同样的「鉴权 + JSON 收发 + queryInt 解析」原语，单独成模块避免复制。
 *
 * 仅主机侧使用；`node:http` 的类型在这里统一引入，视图/管理路由都从这里取。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { AdminValidationError } from './admin-validate'

/** 路由需要的请求面（duck-typed：只用这几个字段）。 */
export interface RouteRequest {
  method?: string
  url?: string
}

export interface RouteResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string): unknown
}

export const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

export function sendJson(response: RouteResponse, status: number, payload: unknown): void {
  response.writeHead(status, JSON_HEADERS)
  response.end(`${JSON.stringify(payload)}\n`)
}

export function sendError(response: RouteResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } })
}

export function queryInt(raw: string | null): number | undefined {
  if (raw === null || raw.trim().length === 0) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined
}

/**
 * 鉴权：复用平台同样的连接围栏（Host/Origin + 浏览器登录态）。
 * 通过返回 undefined；否则返回应写入的 HTTP 状态码（401 / 403）。
 */
export function authorize(
  connection: { requestRejection(request: unknown): 401 | 403 | undefined },
  request: unknown,
): 401 | 403 | undefined {
  return connection.requestRejection(request)
}

/** 读取并 JSON 解析请求体，超 `maxBytes` 或非法 JSON 时抛错（由调用方映射成响应）。 */
export async function readJsonBody(
  request: IncomingMessage & RouteRequest,
  maxBytes: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    let aborted = false
    request.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > maxBytes) {
        aborted = true
        request.destroy()
        reject(new AdminValidationError('PAYLOAD_TOO_LARGE', `请求体超过 ${maxBytes} 字节`))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (aborted) return
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new AdminValidationError('BAD_REQUEST', '请求体不是合法 JSON'))
      }
    })
    request.on('error', (error: Error) => {
      if (!aborted) reject(error)
    })
  })
}
