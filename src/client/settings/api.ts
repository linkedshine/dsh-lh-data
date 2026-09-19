/**
 * 设置页管理接口的浏览器侧取数封装。
 *
 * 全部走同源 `fetch`，前缀来自 `admin-contract` 的 `ADMIN_API_BASE`（与主机侧同一真源，
 * 避免客户端硬编码漂移）。错误统一收口成 `AdminApiError`，携带服务端的中文 message，
 * 由组件层直接展示。
 */

import {
  ADMIN_API_BASE,
  type ConnectionTestView,
  type CreateDataSourceRequest,
  type CreateDatasetRequest,
  type DataSourceView,
  type DatasetAdminView,
  type DatasetDetailView,
  type DatasetRowsResult,
  type ExportDatasetResult,
  type ExportDatasetsRequest,
  type ExportDatasetsResult,
  type ImportSourceTableRequest,
  type ImportSourceTableResult,
  type ListDatasetsResult,
  type ListSourceTablesResult,
  type PatchDataSourceRequest,
  type PatchDatasetRequest,
  type ScopeView,
  type TestDataSourceRequest,
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

/** 分页读取数据集的物理表数据（只读）。 */
export function listDatasetRows(
  id: string,
  scope: string,
  page: number,
  pageSize: number,
): Promise<DatasetRowsResult> {
  const params = new URLSearchParams()
  params.set('scope', scope)
  params.set('page', String(page))
  params.set('pageSize', String(pageSize))
  return request(`/datasets/${encodeURIComponent(id)}/rows?${params.toString()}`)
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

// ── 数据源 ───────────────────────────────────────────────────────────────

export function listDataSources(): Promise<{ sources: DataSourceView[] }> {
  return request('/sources')
}

export function getDataSource(id: string): Promise<DataSourceView> {
  return request(`/sources/${encodeURIComponent(id)}`)
}

export function createDataSource(body: CreateDataSourceRequest): Promise<DataSourceView> {
  return request('/sources', { method: 'POST', body: JSON.stringify(body) })
}

export function patchDataSource(id: string, body: PatchDataSourceRequest): Promise<DataSourceView> {
  return request(`/sources/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export function deleteDataSource(id: string): Promise<{ deleted: boolean }> {
  return request(`/sources/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 测已登记的数据源（给 source）或未保存的草稿（给完整参数）。 */
export function testDataSource(body: TestDataSourceRequest): Promise<ConnectionTestView> {
  return request('/sources/test', { method: 'POST', body: JSON.stringify(body) })
}

export function listSourceTables(id: string, schema?: string, query?: string): Promise<ListSourceTablesResult> {
  const params = new URLSearchParams()
  if (schema !== undefined && schema.trim().length > 0) params.set('schema', schema)
  if (query !== undefined && query.trim().length > 0) params.set('q', query)
  const suffix = params.toString().length > 0 ? `?${params.toString()}` : ''
  return request(`/sources/${encodeURIComponent(id)}/tables${suffix}`)
}

export function importSourceTable(id: string, body: ImportSourceTableRequest): Promise<ImportSourceTableResult> {
  return request(`/sources/${encodeURIComponent(id)}/import`, { method: 'POST', body: JSON.stringify(body) })
}

/** 把选中的数据集批量导出到指定数据源；同名表冲突且未覆盖时抛 DUPLICATE_NAME（409）。 */
export function exportDatasets(id: string, body: ExportDatasetsRequest): Promise<ExportDatasetsResult> {
  return request(`/sources/${encodeURIComponent(id)}/export`, { method: 'POST', body: JSON.stringify(body) })
}
