import type { ViewId } from '@/config/nav'
import { DOCS_URL } from '@/config/repo'

export { hasPanelView } from '@/config/nav'

export type OnboardingStepId =
  | 'admin_password'
  | 'egress'
  | 'slot_account'
  | 'schedulable'
  | 'api_key'
  | 'first_request'

export type StepPanelTo =
  '/users' | '/proxies' | '/import' | '/vm' | '/keys' | '/logs'

export type StepMeta = {
  id: OnboardingStepId
  title: string
  description: string
  panelTo: StepPanelTo
  panelView: ViewId
  docsPath: string
}

export const STEP_META: Record<OnboardingStepId, StepMeta> = {
  admin_password: {
    id: 'admin_password',
    title: '修改默认密码',
    description: '环境变量里的 123456 不能留到生产。到用户页给管理员换一条。',
    panelTo: '/users',
    panelView: 'users',
    docsPath: 'guide/console/users',
  },
  egress: {
    id: 'egress',
    title: '配置出口代理',
    description: '每个槽位要有独立出口才能上线，本机 px-local 也算一条。',
    panelTo: '/proxies',
    panelView: 'proxies',
    docsPath: 'guide/console/proxies',
  },
  slot_account: {
    id: 'slot_account',
    title: '导入槽位账号',
    description: '建槽并写入订阅凭证，官方客户端才有东西可跑。',
    panelTo: '/import',
    panelView: 'import',
    docsPath: 'guide/console/import',
  },
  schedulable: {
    id: 'schedulable',
    title: '上线可调度槽位',
    description: '有凭证的槽打开调度后，网关才会把请求派进去。',
    panelTo: '/vm',
    panelView: 'vm',
    docsPath: 'guide/slots',
  },
  api_key: {
    id: 'api_key',
    title: '签发 API 密钥',
    description: '给客户端一张 sk-vm- 密钥，不要把主控密钥写进环境变量。',
    panelTo: '/keys',
    panelView: 'keys',
    docsPath: 'guide/console/keys',
  },
  first_request: {
    id: 'first_request',
    title: '发出第一个请求',
    description: '打通 /v1 后，日志里出现一条 2xx 就算首配完成。',
    panelTo: '/logs',
    panelView: 'logs',
    docsPath: 'guide/api',
  },
}

export function isOnboardingStepId(id: string): id is OnboardingStepId {
  return id in STEP_META
}

/** Docs site is rooted at /zh/; pass a path like `guide/clients`. */
export function docsHref(relativePath: string): string {
  const base = DOCS_URL.endsWith('/') ? DOCS_URL : `${DOCS_URL}/`
  return `${base}${relativePath.replace(/^\//, '')}`
}
