import type { FileRoutesById } from '@/routeTree.gen'

export type ViewId =
  | 'overview'
  | 'cluster'
  | 'vm'
  | 'import'
  | 'specs'
  | 'billing'
  | 'proxies'
  | 'models'
  | 'risk'
  | 'system'
  | 'keys'
  | 'api'
  | 'anthropic'
  | 'logs'
  | 'statistics'
  | 'database'
  | 'settings'
  | 'users'
  | 'wrap'

export const VIEW_TITLES: Record<ViewId, string> = {
  overview: '总览',
  cluster: '集群',
  vm: '虚拟机',
  import: '导入',
  specs: '规格',
  billing: '计费',
  proxies: '代理池',
  models: '模型',
  risk: '风险审计',
  system: 'system提示词',
  keys: '密钥',
  api: 'API',
  anthropic: 'Anthropic',
  logs: '日志',
  statistics: '统计',
  database: '数据库',
  settings: '设置',
  users: '用户',
  wrap: '内核',
}

// 监控组四页的职责边界，避免同一块数据在多页重复出现。
export const VIEW_DESCRIPTIONS: Partial<Record<ViewId, string>> = {
  overview: '集群健康、账号可用性与近 1 小时服务质量',
  statistics: '今日与历史的请求、费用、Token 和缓存；租户可按每台可用 VM 查看',
  logs: '逐条请求记录，支持筛选、导出与查看详情',
}

type AuthenticatedPath<T = keyof FileRoutesById> =
  T extends `/_authenticated/${infer Head}/${string}`
    ? `/${Head}`
    : T extends `/_authenticated/${infer Head}`
      ? `/${Head}`
      : never

/**
 * Console page → panel view (`ROLE_VIEWS` in src/lib/admin/panel-acl.mjs).
 * Keyed by the first path segment, so nested pages (`/vm/$id`,
 * `/settings/$tab`) follow their parent. `null` = any signed-in user.
 * The sidebar and the route guard both read this table.
 */
export const ROUTE_VIEWS = {
  '/': null,
  '/overview': 'overview',
  '/statistics': 'statistics',
  '/logs': 'logs',
  '/cluster': 'cluster',
  '/vm': 'vm',
  '/import': 'import',
  '/specs': 'specs',
  '/proxies': 'proxies',
  '/billing': 'billing',
  '/models': 'models',
  '/risk': 'risk',
  '/system': 'system',
  '/api': 'api',
  '/anthropic': 'anthropic',
  '/keys': 'keys',
  '/settings': 'settings',
  '/wrap': 'wrap',
  '/database': 'database',
  '/users': 'users',
} as const satisfies Record<AuthenticatedPath, ViewId | null>

/** `undefined` = not a console page (left to the not-found route). */
export function viewForPath(path: string): ViewId | null | undefined {
  const head = `/${path.split(/[?#]/)[0].split('/').find(Boolean) ?? ''}`
  return head in ROUTE_VIEWS
    ? ROUTE_VIEWS[head as keyof typeof ROUTE_VIEWS]
    : undefined
}

/** Missing views list = server without panel roles (show everything). */
export function hasPanelView(
  views: readonly string[] | null | undefined,
  view: ViewId
): boolean {
  if (views == null) return true
  return views.includes(view) || views.includes(`/${view}`)
}

export function canOpenPath(
  views: readonly string[] | null | undefined,
  path: string
): boolean {
  const view = viewForPath(path)
  return view == null || hasPanelView(views, view)
}
