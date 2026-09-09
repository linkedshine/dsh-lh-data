/**
 * 设置页的内联样式常量。沿用插件既有风格：中性灰底、细边框、6px 圆角、12–13px 字号，
 * 全部走 `var(--dsw-*)` 设计变量并带字面量兜底，自动跟随平台明暗主题。
 * 不引入任何 CSS 管线（与浏览器半身既有卡片一致）。
 */

export const c = {
  bg: 'var(--dsw-bg, #ffffff)',
  subtle: 'var(--dsw-bg-subtle, #fafafa)',
  fg: 'var(--dsw-fg, #1f2328)',
  fg2: 'var(--dsw-fg-secondary, #656d76)',
  border: 'var(--dsw-border, #e5e5e5)',
  primary: 'var(--dsw-primary, #2f6feb)',
  danger: 'var(--dsw-danger, #c0392b)',
  ok: 'var(--dsw-ok, #1a7f37)',
  warn: 'var(--dsw-warn, #9a6700)',
} as const

export const s = {
  page: { fontSize: 12, color: c.fg, lineHeight: 1.6 },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
    paddingBottom: 10, borderBottom: `1px solid ${c.border}`,
  },
  search: {
    flex: 1, minWidth: 0, padding: '5px 8px', fontSize: 12,
    border: `1px solid ${c.border}`, borderRadius: 6, background: c.bg, color: c.fg,
    outline: 'none',
  },
  button: {
    border: `1px solid ${c.border}`, background: c.bg, color: c.fg,
    borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
  },
  primaryButton: {
    border: `1px solid ${c.primary}`, background: c.primary, color: '#fff',
    borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
  },
  dangerButton: {
    border: `1px solid ${c.danger}`, background: 'transparent', color: c.danger,
    borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 12,
  },
  disabledButton: { opacity: 0.5, cursor: 'not-allowed' },
  banner: {
    marginBottom: 10, padding: '6px 10px', borderRadius: 6,
    border: `1px solid ${c.danger}`, color: c.danger, fontSize: 12,
    display: 'flex', alignItems: 'center', gap: 8,
  },
  scroll: {
    maxHeight: 360, overflow: 'auto', border: `1px solid ${c.border}`, borderRadius: 6,
  },
  table: { borderCollapse: 'collapse', width: '100%', fontSize: 12 },
  th: {
    position: 'sticky', top: 0, background: c.subtle, textAlign: 'left',
    padding: '6px 8px', borderBottom: `1px solid ${c.border}`, color: c.fg2, fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '5px 8px', borderBottom: `1px solid ${c.border}`, maxWidth: 280,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  row: { cursor: 'pointer' },
  selectedRow: { boxShadow: `inset 2px 0 0 ${c.primary}` },
  rowHover: { background: c.subtle },
  dot: { display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 5 },
  panel: {
    marginTop: 12, padding: 12, border: `1px solid ${c.border}`, borderRadius: 6, background: c.subtle,
  },
  field: { marginBottom: 10 },
  label: { display: 'block', fontSize: 12, color: c.fg2, marginBottom: 4 },
  input: {
    width: '100%', boxSizing: 'border-box', padding: '5px 8px', fontSize: 12,
    border: `1px solid ${c.border}`, borderRadius: 6, background: c.bg, color: c.fg, outline: 'none',
  },
  select: {
    padding: '4px 6px', fontSize: 12, border: `1px solid ${c.border}`, borderRadius: 6,
    background: c.bg, color: c.fg, outline: 'none',
  },
  textarea: {
    width: '100%', boxSizing: 'border-box', padding: '5px 8px', fontSize: 12,
    border: `1px solid ${c.border}`, borderRadius: 6, background: c.bg, color: c.fg,
    outline: 'none', resize: 'vertical', minHeight: 54, fontFamily: 'inherit',
  },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, alignItems: 'end' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  bar: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  muted: { color: c.fg2 },
  link: { color: c.primary, cursor: 'pointer' },
  status: { fontWeight: 600 },
  tabs: {
    display: 'flex', gap: 18, marginBottom: 12, borderBottom: `1px solid ${c.border}`,
  },
  tab: {
    padding: '0 0 6px', fontSize: 13, fontWeight: 600, color: c.fg2,
    background: 'none', border: 'none', borderBottom: '2px solid transparent',
    cursor: 'pointer', transition: 'color 120ms ease, border-color 120ms ease',
  },
  activeTab: { color: c.fg, borderBottom: `2px solid ${c.primary}` },
} as const

/** 状态圆点配色（数据集）。 */
export const STATUS_COLOR: Record<string, string> = {
  ready: c.ok,
  importing: c.warn,
  failed: c.danger,
}

/** 数据源连通状态圆点配色。 */
export const SOURCE_STATUS_COLOR: Record<string, string> = {
  connected: c.ok,
  error: c.danger,
  unknown: c.fg2,
}

export const SOURCE_STATUS_TEXT: Record<string, string> = {
  connected: '已连通',
  error: '连接失败',
  unknown: '未检测',
}

/** 类型徽标底色（低饱和，跟随主题的浅底细边框）。 */
export const TYPE_BADGE: Record<string, string> = {
  mysql: c.primary,
  postgresql: c.ok,
}
