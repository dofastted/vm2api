import {
  Activity,
  Archive,
  BellRing,
  Bot,
  Fingerprint,
  Gauge,
  Info,
  Layers,
  Magnet,
  Network,
  PackageCheck,
  RadioTower,
  ScrollText,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react'

export const SETTINGS_TABS = [
  ['sticky', '粘性'],
  ['pool', '账号池'],
  ['quota', '配额'],
  ['openai', 'OpenAI'],
  ['logs', '日志'],
  ['protocol', '协议'],
  ['redaction', '脱敏'],
  ['init', '初装'],
  ['health', '探测'],
  ['notify', '通知'],
  ['telemetry', '遥测'],
  ['socks5', 'SOCKS5'],
  ['backup', '备份'],
  ['about', '关于'],
] as const

export type SettingsTabId = (typeof SETTINGS_TABS)[number][0]

/**
 * 设置页左侧分组导航。id 必须来自 SETTINGS_TABS（类型层面约束），
 * 分组只改呈现顺序，不改路由与合法 tab 集合。每个 tab 只出现一次。
 */
export const SETTINGS_NAV_GROUPS: {
  label: string
  items: { id: SettingsTabId; icon: LucideIcon }[]
}[] = [
  {
    label: '调度',
    items: [
      { id: 'sticky', icon: Magnet },
      { id: 'pool', icon: Layers },
      { id: 'quota', icon: Gauge },
      { id: 'openai', icon: Bot },
    ],
  },
  {
    label: '协议',
    items: [
      { id: 'protocol', icon: Fingerprint },
      { id: 'redaction', icon: ShieldCheck },
    ],
  },
  {
    label: '槽位',
    items: [
      { id: 'init', icon: PackageCheck },
      { id: 'health', icon: Activity },
      { id: 'telemetry', icon: RadioTower },
      { id: 'socks5', icon: Network },
    ],
  },
  {
    label: '运维',
    items: [
      { id: 'notify', icon: BellRing },
      { id: 'logs', icon: ScrollText },
      { id: 'backup', icon: Archive },
      { id: 'about', icon: Info },
    ],
  },
]

export const SETTINGS_TAB_LABELS = Object.fromEntries(SETTINGS_TABS) as Record<
  SettingsTabId,
  string
>

export function settingsTabId(tab: string | undefined): SettingsTabId {
  return SETTINGS_TABS.some((item) => item[0] === tab)
    ? (tab as SettingsTabId)
    : 'sticky'
}

export const SETTINGS_NAV_ITEMS = SETTINGS_NAV_GROUPS.flatMap(
  (group) => group.items
)
