/**
 * 设置页「数据集」根组件：顶部页签条 + 两个同级面板。
 *
 * - 「数据集」：跨工作区聚合浏览 / 新建 / 编辑 / 查看表数据（既有能力，见 `DatasetsPanel`）；
 * - 「数据源」：登记与管理远程数据库连接，浏览远端表并导入成数据集（见 `DataSourcesPanel`）。
 *
 * 两个面板各自持有状态（搜索、分页、选中项），切换页签不互相重置。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { DatasetsPanel } from './DatasetsPanel'
import { DataSourcesPanel } from './DataSourcesPanel'
import { s } from './styles'

type Tab = 'datasets' | 'sources'

const TABS: { key: Tab; label: string }[] = [
  { key: 'datasets', label: '数据集' },
  { key: 'sources', label: '数据源' },
]

export function DatasetSettingsSection(): ReactElement {
  const [tab, setTab] = useState<Tab>('datasets')

  return (
    <div style={s.page}>
      <div style={s.tabs}>
        {TABS.map(entry => (
          <button
            key={entry.key}
            type="button"
            style={{ ...s.tab, ...(tab === entry.key ? s.activeTab : null) }}
            onClick={() => setTab(entry.key)}
          >{entry.label}</button>
        ))}
      </div>
      {tab === 'datasets' ? <DatasetsPanel /> : <DataSourcesPanel />}
    </div>
  )
}
