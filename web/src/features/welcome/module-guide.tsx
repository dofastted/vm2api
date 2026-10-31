import { Link } from '@tanstack/react-router'
import type { ViewId } from '@/config/nav'
import { hasPanelView } from './steps'

type GuideTo =
  | '/overview'
  | '/statistics'
  | '/logs'
  | '/cluster'
  | '/vm'
  | '/import'
  | '/specs'
  | '/proxies'
  | '/models'
  | '/risk'
  | '/system'
  | '/keys'
  | '/anthropic'
  | '/wrap'
  | '/database'
  | '/settings/$tab'

type GuideItem = {
  title: string
  view: ViewId
  to: GuideTo
  summary: string
  detail?: string
}

const GROUPS: { title: string; items: GuideItem[] }[] = [
  {
    title: '监控',
    items: [
      {
        title: '总览',
        view: 'overview',
        to: '/overview',
        summary: '集群健康、账号可用性和近一小时请求质量。',
      },
      {
        title: '统计',
        view: 'statistics',
        to: '/statistics',
        summary: '请求、消费、耗时，以及用户、供应商和模型排行。',
      },
      {
        title: '日志',
        view: 'logs',
        to: '/logs',
        summary: '逐条请求，可筛选、导出和打开详情。',
      },
    ],
  },
  {
    title: '资源',
    items: [
      {
        title: '集群',
        view: 'cluster',
        to: '/cluster',
        summary: '多机节点和接入。',
      },
      {
        title: '虚拟机',
        view: 'vm',
        to: '/vm',
        summary:
          '槽位列表。用量窗口在每一行上，5h / 7d 剩余和重置时间看这里，不另开用量页。',
        detail: '调度开关、并发和限额也在槽位上；账号没探测过会显示未探测。',
      },
      {
        title: '导入',
        view: 'import',
        to: '/import',
        summary: '建槽、绑出口、写入订阅凭证。',
      },
      {
        title: '规格',
        view: 'specs',
        to: '/specs',
        summary: '新建槽用的机器规格和宿主 KVM。',
      },
      {
        title: '代理',
        view: 'proxies',
        to: '/proxies',
        summary: '每个槽的出口。本机 px-local 也算一条。',
      },
    ],
  },
  {
    title: '协议',
    items: [
      {
        title: '模型',
        view: 'models',
        to: '/models',
        summary: '对外模型目录、参数、别名和官方计费。',
      },
      {
        title: '风险审计',
        view: 'risk',
        to: '/risk',
        summary: '入站先过蒸馏、硬正则、拒答缓存、决策模型，拦下的不出站。',
        detail:
          '个人自用会把这四道关关掉；中转站保持蒸馏、硬正则和拒答缓存开着，决策模型默认关。',
      },
      {
        title: 'system提示词',
        view: 'system',
        to: '/system',
        summary: '非官方客户端出站时替换的系统提示词。默认是完整官方提示词。',
      },
      {
        title: '密钥',
        view: 'keys',
        to: '/keys',
        summary: '发给客户端的 sk-vm- 密钥。',
        detail: '不要把主控密钥写进环境变量。可按槽、模型和并发收口。',
      },
      {
        title: 'Anthropic',
        view: 'anthropic',
        to: '/anthropic',
        summary: '直接调用 Anthropic Messages，不经过虚拟机。',
        detail:
          '默认为官方地址和 x-api-key。地址、认证和代理都能改，也可以按已配置的 API 地址调度。',
      },
    ],
  },
  {
    title: '系统',
    items: [
      {
        title: '设置',
        view: 'settings',
        to: '/settings/$tab',
        summary:
          '粘性、账号池、配额、探测、通知这些全局开关。配额在「配额」页：5h/7d 闸线、并发和请求体上限。',
        detail: '个人自用把闸关掉并把闸线和并发拉满；中转站用出厂闸线。',
      },
      {
        title: '内核',
        view: 'wrap',
        to: '/wrap',
        summary: '槽内 CLI 与 rust kernel 的数据面。',
        detail:
          '重装按当前数据面铺内核并重启，不改凭证、不改代理、不删容器。可先拉 GitHub Release 再一键重装。',
      },
      {
        title: '数据库',
        view: 'database',
        to: '/database',
        summary: 'SQLite 体积和日志占用。',
      },
    ],
  },
]

function GuideTitle({ item }: { item: GuideItem }) {
  const className =
    'text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
  if (item.to === '/settings/$tab') {
    return (
      <Link to='/settings/$tab' params={{ tab: 'quota' }} className={className}>
        {item.title}
      </Link>
    )
  }
  return (
    <Link to={item.to} className={className}>
      {item.title}
    </Link>
  )
}

export function WelcomeModuleGuide({ views }: { views?: string[] | null }) {
  return (
    <section
      className='relative z-10 px-6 pt-2 pb-8'
      aria-labelledby='welcome-modules'
    >
      <div className='mx-auto flex max-w-6xl flex-col gap-6 rounded-2xl border bg-card p-4 shadow-xs sm:p-6'>
        <h2
          id='welcome-modules'
          className='text-xl font-semibold tracking-tight sm:text-2xl'
        >
          各页在管什么
        </h2>
        <div className='grid gap-6 lg:grid-cols-2'>
          {GROUPS.map((group) => (
            <div key={group.title} className='min-w-0'>
              <h3 className='mb-2 text-sm font-medium'>{group.title}</h3>
              <dl className='divide-y rounded-2xl border bg-background/70'>
                {group.items.map((item) => {
                  const allowed = hasPanelView(views, item.view)
                  return (
                    <div key={item.title} className='px-3 py-2.5'>
                      <dt>
                        {allowed ? (
                          <GuideTitle item={item} />
                        ) : (
                          <span className='text-sm font-medium text-muted-foreground'>
                            {item.title}
                          </span>
                        )}
                      </dt>
                      <dd className='mt-0.5 text-xs leading-relaxed text-muted-foreground'>
                        {item.summary}
                        {item.detail ? ` ${item.detail}` : ''}
                      </dd>
                    </div>
                  )
                })}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
