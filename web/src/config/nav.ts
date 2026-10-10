export type ViewId =
  | 'overview'
  | 'cluster'
  | 'vm'
  | 'import'
  | 'specs'
  | 'usage'
  | 'billing'
  | 'proxies'
  | 'models'
  | 'risk'
  | 'system'
  | 'keys'
  | 'api'
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
  usage: '用量',
  billing: '计费',
  proxies: '代理池',
  models: '模型',
  risk: '风险审计',
  system: 'system提示词',
  keys: '密钥',
  api: 'API',
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
  statistics: '请求、消费与耗时趋势，以及用户 / 供应商 / 模型排行',
  logs: '逐条请求记录，支持筛选、导出与查看详情',
  usage: '各账号 5h / 7d 限额占用、并发与费用',
}
