/**
 * 设置页管理接口的 HTTP 路由 —— 与视图路由同源（自建前缀 + `connection` 鉴权），
 * 但不接受任何 SQL：所有读写都走 `admin.ts` 的服务函数，物理表名与 SQL 不出现在接口里。
 *
 * 路由表（固定挂在 `ADMIN_API_BASE = /api/lh-data/admin`）：
 *   GET    /scopes                 列出已知工作区
 *   GET    /datasets               聚合列表（?q=&page=&pageSize=）
 *   POST   /datasets               新建空数据集（body 含 scopeKey 与列定义）
 *   GET    /datasets/:id?scope=    单条详情
 *   GET    /datasets/:id/rows?scope=&page=&pageSize=   分页查看表数据（只读）
 *   PATCH  /datasets/:id?scope=    改名 / 改描述 / 改来源
 *   DELETE /datasets/:id?scope=    连同物理表与元数据删除
 *
 * 数据源（datasourceEnabled=false 时整组不注册）：
 *   GET    /sources                数据源列表（脱敏，不含密码）
 *   POST   /sources                新建数据源（body.test=true 时先测连）
 *   POST   /sources/test           测试连接（已登记的 source，或未保存的完整参数）
 *   GET    /sources/:id            单条详情
 *   PATCH  /sources/:id            改连接参数 / 密码 / 名称 / 描述
 *   DELETE /sources/:id            删除数据源
 *   GET    /sources/:id/tables?schema=&q=   浏览远端表
 *   POST   /sources/:id/import     把远端表导入指定工作区
 *
 * scope 一律由写操作的调用方从「已知工作区列表」里回传，不接收任意路径输入。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { ADMIN_API_BASE, type CreateDatasetRequest, type PatchDatasetRequest } from './admin-contract'
import {
  createDataset,
  createDataSource,
  deleteDataset,
  deleteDataSource,
  getDataset,
  getDataSource,
  importSourceTable,
  listDatasetRows,
  listDatasets,
  listDataSources,
  listScopes,
  listSourceTables,
  patchDataset,
  patchDataSource,
  testDataSource,
  AdminServiceError,
} from './admin'
import { AdminValidationError } from './admin-validate'
import type { DataServices } from './store'
import {
  authorize,
  readJsonBody,
  sendError,
  sendJson,
  type RouteRequest,
  type RouteResponse,
} from './http-common'

type Resource =
  | { kind: 'scopes' }
  | { kind: 'datasets'; id?: string; rows?: boolean }
  | { kind: 'sources'; id?: string; action?: 'test' | 'tables' | 'import' }

/** `/api/lh-data/admin` 之后的路径解析。 */
function parseAdminPath(pathname: string): Resource | undefined {
  const base = ADMIN_API_BASE
  const rest = pathname.slice(base.length).replace(/^\/+/, '').replace(/\/+$/, '')
  if (rest === '' || rest === 'scopes') return { kind: 'scopes' }
  if (rest === 'datasets') return { kind: 'datasets' }
  if (rest === 'sources') return { kind: 'sources' }
  // `sources/test` 必须优先于 `:id` 匹配，否则会被当成 id=test 的数据源。
  if (rest === 'sources/test') return { kind: 'sources', action: 'test' }
  const parts = rest.split('/')
  if (parts[0] === 'sources' && parts[1] !== undefined && parts[1].length > 0) {
    const id = decodeURIComponent(parts[1])
    if (parts.length === 2) return { kind: 'sources', id }
    if (parts.length === 3 && parts[2] === 'tables') return { kind: 'sources', id, action: 'tables' }
    if (parts.length === 3 && parts[2] === 'import') return { kind: 'sources', id, action: 'import' }
    return undefined
  }
  if (parts[0] === 'datasets' && parts[1] !== undefined && parts[1].length > 0) {
    const id = decodeURIComponent(parts[1])
    // `/datasets/:id/rows` —— 表数据分页；更深或别的子路径一律不认（404）。
    if (parts.length === 2) return { kind: 'datasets', id }
    if (parts.length === 3 && parts[2] === 'rows') return { kind: 'datasets', id, rows: true }
  }
  return undefined
}

function methodNotAllowed(response: RouteResponse): void {
  sendError(response, 405, 'METHOD_NOT_ALLOWED', 'only GET / POST / PATCH / DELETE are allowed')
}

function requireScope(params: URLSearchParams): string {
  const scope = params.get('scope')
  if (scope === null || scope.trim().length === 0) {
    throw new AdminValidationError('BAD_REQUEST', '缺少 scope 参数（请从工作区列表里选）')
  }
  return scope.trim()
}

/**
 * 注册管理路由。宿主缺失（`webServer` / `connection`）时返回 undefined，由调用方降级。
 * 路由路径重复会抛错（webserver 契约），与视图路由路径不同前缀，互不影响。
 */
export function registerAdminRoutes(services: DataServices): (() => void) | undefined {
  const { webServer, connection } = services
  if (webServer === undefined || connection === undefined) return undefined

  const handler = async (rawRequest: unknown, rawResponse: unknown): Promise<void> => {
    const request = rawRequest as RouteRequest & IncomingMessage
    const response = rawResponse as RouteResponse & ServerResponse

    const rejection = authorize(connection, request)
    if (rejection !== undefined) {
      sendError(response, rejection, rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', 'unauthorized')
      return
    }

    const method = (request.method ?? 'GET').toUpperCase()
    const url = new URL(request.url ?? '/', 'http://localhost')
    const resource = parseAdminPath(url.pathname)
    if (resource === undefined) {
      sendError(response, 404, 'NOT_FOUND', 'not found')
      return
    }
    const params = url.searchParams

    try {
      if (resource.kind === 'scopes') {
        if (method !== 'GET') {
          methodNotAllowed(response)
          return
        }
        const scopes = await listScopes(services)
        sendJson(response, 200, { scopes })
        return
      }

      if (resource.kind === 'sources') {
        if (resource.action === 'test') {
          if (method !== 'POST') {
            methodNotAllowed(response)
            return
          }
          const body = await readJsonBody(request, services.cfg.adminMaxBodyBytes)
          sendJson(response, 200, await testDataSource(services, body))
          return
        }
        if (resource.id === undefined) {
          if (method === 'GET') {
            sendJson(response, 200, { sources: await listDataSources(services) })
            return
          }
          if (method === 'POST') {
            const body = await readJsonBody(request, services.cfg.adminMaxBodyBytes)
            sendJson(response, 201, await createDataSource(services, body))
            return
          }
          methodNotAllowed(response)
          return
        }
        if (resource.action === 'tables') {
          if (method !== 'GET') {
            methodNotAllowed(response)
            return
          }
          sendJson(response, 200, await listSourceTables(services, resource.id, Object.fromEntries(params)))
          return
        }
        if (resource.action === 'import') {
          if (method !== 'POST') {
            methodNotAllowed(response)
            return
          }
          const body = await readJsonBody(request, services.cfg.adminMaxBodyBytes)
          sendJson(response, 201, await importSourceTable(services, resource.id, body))
          return
        }
        if (method === 'GET') {
          sendJson(response, 200, await getDataSource(services, resource.id))
          return
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(request, services.cfg.adminMaxBodyBytes)
          sendJson(response, 200, await patchDataSource(services, resource.id, body))
          return
        }
        if (method === 'DELETE') {
          sendJson(response, 200, await deleteDataSource(services, resource.id))
          return
        }
        methodNotAllowed(response)
        return
      }

      if (resource.id === undefined) {
        if (method === 'GET') {
          const result = await listDatasets(services, Object.fromEntries(params))
          sendJson(response, 200, result)
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(request, services.cfg.adminMaxBodyBytes)
          const created = await createDataset(services, body as CreateDatasetRequest)
          sendJson(response, 201, created)
          return
        }
        methodNotAllowed(response)
        return
      }

      const scope = requireScope(params)
      if (resource.rows === true) {
        if (method !== 'GET') {
          methodNotAllowed(response)
          return
        }
        const rows = await listDatasetRows(services, scope, resource.id, Object.fromEntries(params))
        sendJson(response, 200, rows)
        return
      }
      if (method === 'GET') {
        const detail = await getDataset(services, scope, resource.id)
        sendJson(response, 200, detail)
        return
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(request, services.cfg.adminMaxBodyBytes)
        const patched = await patchDataset(services, scope, resource.id, body as PatchDatasetRequest)
        sendJson(response, 200, patched)
        return
      }
      if (method === 'DELETE') {
        const result = await deleteDataset(services, scope, resource.id)
        sendJson(response, 200, result)
        return
      }
      methodNotAllowed(response)
    } catch (error) {
      if (error instanceof AdminValidationError) {
        sendError(response, 400, error.code, error.message)
        return
      }
      if (error instanceof AdminServiceError) {
        sendError(response, error.status, error.code, error.message)
        return
      }
      // 脱敏：不回显 SQL 与物理表名。
      sendError(response, 500, 'QUERY_FAILED', '管理接口内部错误')
    }
  }

  return webServer.register({ kind: 'prefix', path: ADMIN_API_BASE, handler })
}
