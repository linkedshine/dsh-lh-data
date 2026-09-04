/**
 * 设置页管理接口的浏览器侧取数封装。
 *
 * 全部走同源 `fetch`，前缀来自 `admin-contract` 的 `ADMIN_API_BASE`（与主机侧同一真源，
 * 避免客户端硬编码漂移）。错误统一收口成 `AdminApiError`，携带服务端的中文 message，
 * 由组件层直接展示。
 */

import {
  ADMIN_API_BASE,
  type CreateDatasetRequest,
  type DatasetAdminView,
  type DatasetDetailView,
  type ListDatasetsResult,
  type PatchDatasetRequest,
  type ScopeView,
} from '../../admin-contract'

/** 服务端脱敏后的错误（含中文 message 与机器码）。 */
export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AdminApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ADMIN_API_BASE}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    let code = 'UNKNOWN'
    let message = `请求失败（HTTP ${response.status}）`
    try {
      const body = await response.json() as { error?: { code?: string; message?: string } }
      if (body.error) {
        code = body.error.code ?? code
        message = body.error.message ?? message
      }
    } catch {
      // 响应体非 JSON：保留默认文案。
    }
    throw new AdminApiError(response.status, code, message)
  }
  return (await response.json()) as T
}

export function listScopes(): Promise<{ scopes: ScopeView[] }> {
  return request('/scopes')
}

export function listDatasets(query: string, page: number, pageSize: number): Promise<ListDatasetsResult> {
  const params = new URLSearchParams()
  if (query.trim().length > 0) params.set('q', query)
  params.set('page', String(page))
  params.set('pageSize', String(pageSize))
  return request(`/datasets?${params.toString()}`)
}

export function getDataset(id: string, scope: string): Promise<DatasetDetailView> {
  return request(`/datasets/${encodeURIComponent(id)}?scope=${encodeURIComponent(scope)}`)
}

export function createDataset(body: CreateDatasetRequest): Promise<DatasetDetailView> {
  return request('/datasets', { method: 'POST', body: JSON.stringify(body) })
}

export function patchDataset(
  id: string,
  scope: string,
  body: PatchDatasetRequest,
): Promise<DatasetDetailView> {
  return request(`/datasets/${encodeURIComponent(id)}?scope=${encodeURIComponent(scope)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteDataset(
  id: string,
  scope: string,
): Promise<{ id: string; name: string; dropped: boolean }> {
  return request(`/datasets/${encodeURIComponent(id)}?scope=${encodeURIComponent(scope)}`, {
    method: 'DELETE',
  })
}
