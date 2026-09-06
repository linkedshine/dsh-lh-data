/**
 * 前端分页取数的 HTTP 路由 —— 设计文档 §5.5 / §9。
 *
 * 只暴露两个能力：按 `viewId` 取一页、按 `viewId` 释放视图。
 * 接口**不接受任何 SQL**：语句由 `ViewRegistry` 在主机侧持有，因此没有注入面。
 * 每个请求先过 `connection.requestRejection()`（Host/Origin 围栏 + 浏览器鉴权）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { ViewError, type ViewDescriptor } from './view'
import { selectRows } from './table'
import { debugLog } from './tooling'
import type { DataServices } from './store'
import { authorize, queryInt, sendError, sendJson, type RouteRequest, type RouteResponse } from './http-common'

/** `/views/<id>` 或 `/views/<id>/rows`。 */
function parseViewPath(pathname: string, prefix: string): { viewId: string; rows: boolean } | undefined {
  if (!pathname.startsWith(`${prefix}/views/`)) return undefined
  const rest = pathname.slice(`${prefix}/views/`.length).replace(/\/+$/, '')
  const [viewId, tail] = rest.split('/')
  if (viewId === undefined || viewId.length === 0) return undefined
  if (tail === undefined) return { viewId, rows: false }
  if (tail === 'rows') return { viewId, rows: true }
  return undefined
}

/**
 * 注册视图路由。返回 disposer；宿主缺失（`webServer` / `connection` 任一不可用）时返回 undefined。
 * 路由路径重复会抛错（webserver 的契约），由调用方决定如何降级。
 */
export function registerViewRoutes(services: DataServices): (() => void) | undefined {
  const { webServer, connection, views, cfg } = services
  if (webServer === undefined || connection === undefined || views === undefined) return undefined
  const prefix = cfg.viewRoutePrefix.replace(/\/+$/, '')

  const handler = async (rawRequest: unknown, rawResponse: unknown): Promise<void> => {
    const request = rawRequest as RouteRequest & IncomingMessage
    const response = rawResponse as RouteResponse & ServerResponse

    const rejection = authorize(connection, request)
    if (rejection !== undefined) {
      sendError(response, rejection, rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', 'unauthorized')
      return
    }

    const method = (request.method ?? 'GET').toUpperCase()
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    const parsed = parseViewPath(pathname, prefix)
    if (parsed === undefined) {
      sendError(response, 404, 'NOT_FOUND', 'not found')
      return
    }
    if (method !== 'GET' && method !== 'DELETE') {
      sendError(response, 405, 'METHOD_NOT_ALLOWED', 'only GET and DELETE are allowed')
      return
    }

    if (method === 'DELETE') {
      const revoked = await views.revoke(parsed.viewId)
      sendJson(response, 200, { viewId: parsed.viewId, revoked })
      return
    }

    try {
      const view = views.get(parsed.viewId)
      if (view === undefined) {
        // 未注册对外统一 404，避免探测视图是否存在。
        throw new ViewError('VIEW_NOT_FOUND', 404, '视图不存在或接口不可用（请重新查询）')
      }
      // 归属与就绪状态按视图绑定的 scope 重新断言（defense-in-depth）。
      await services.store.require(view.scopeKey, view.datasetId, { requireReady: true })

      if (!parsed.rows) {
        const meta: Omit<ViewDescriptor, 'endpoint'> & { endpoint: string } = {
          kind: 'dataset-view',
          viewId: view.viewId,
          endpoint: `${prefix}/views/${view.viewId}/rows`,
          datasetId: view.datasetId,
          name: view.name,
          columns: view.columns,
          totalRows: view.totalRows,
          pageSize: services.cfg.defaultPageSize,
          maxPageSize: services.cfg.maxPageSize,
          stable: view.stable,
          sortable: view.sortable,
        }
        sendJson(response, 200, meta)
        return
      }

      const params = new URL(request.url ?? '/', 'http://localhost').searchParams
      const order = params.get('order')
      const statement = views.page(parsed.viewId, {
        page: queryInt(params.get('page')),
        pageSize: queryInt(params.get('pageSize')),
        sort: params.get('sort') ?? undefined,
        order: order === 'desc' || order === 'asc' ? order : undefined,
      })
      const db = await services.store.database(view.scopeKey)
      const { rows, columns } = await selectRows(db, statement.sql, [...statement.params])
      debugLog('http:rows', {
        viewId: view.viewId,
        page: statement.page,
        pageSize: statement.pageSize,
        totalRows: statement.totalRows,
        totalPages: statement.totalPages,
        rows: rows.length,
      })
      sendJson(response, 200, {
        viewId: view.viewId,
        columns,
        rows,
        page: statement.page,
        pageSize: statement.pageSize,
        totalRows: statement.totalRows,
        totalPages: statement.totalPages,
        stable: statement.stable,
      })
    } catch (error) {
      if (error instanceof ViewError) {
        sendError(response, error.status, error.code, error.message)
        return
      }
      // 错误信息脱敏：不回显 SQL 与物理表名。
      sendError(response, 500, 'QUERY_FAILED', '分页查询失败')
    }
  }

  return webServer.register({ kind: 'prefix', path: `${prefix}/views`, handler })
}
