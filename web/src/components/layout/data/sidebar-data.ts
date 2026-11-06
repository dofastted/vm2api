import { canOpenPath } from '@/config/nav'
import {
  Boxes,
  Cable,
  ChartColumn,
  Cpu,
  Database,
  Download,
  KeyRound,
  Layers,
  LayoutDashboard,
  MessageSquareText,
  ScrollText,
  Send,
  Server,
  Settings,
  ShieldAlert,
  Sparkles,
} from 'lucide-react'
import type { NavGroup, SidebarData } from '../types'

// 监控组对应 claude-code-hub 的 仪表盘 / 使用记录：
// 总览看集群健康，统计看趋势与排行，日志看逐条请求。账号限额在虚拟机列表的用量窗口。
const ALL_GROUPS: NavGroup[] = [
  {
    title: '监控',
    items: [
      { title: '总览', url: '/overview', icon: LayoutDashboard },
      { title: '统计', url: '/statistics', icon: ChartColumn },
      { title: '日志', url: '/logs', icon: ScrollText },
    ],
  },
  {
    title: '资源',
    items: [
      { title: '集群', url: '/cluster', icon: Boxes },
      { title: '虚拟机', url: '/vm', icon: Server },
      { title: '导入', url: '/import', icon: Download },
      { title: '规格', url: '/specs', icon: Cpu },
      { title: '代理', url: '/proxies', icon: Cable },
    ],
  },
  {
    title: '协议',
    items: [
      { title: '模型', url: '/models', icon: Sparkles },
      { title: '风险审计', url: '/risk', icon: ShieldAlert },
      { title: 'system提示词', url: '/system', icon: MessageSquareText },
      { title: 'API', url: '/api', icon: Send },
      { title: '密钥', url: '/keys', icon: KeyRound },
    ],
  },
  {
    title: '系统',
    items: [
      { title: '设置', url: '/settings', icon: Settings },
      { title: '内核', url: '/wrap', icon: Layers },
      { title: '数据库', url: '/database', icon: Database },
    ],
  },
]

export function navGroupsFor(views?: readonly string[] | null): NavGroup[] {
  if (views == null) return ALL_GROUPS
  return ALL_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => item.url != null && canOpenPath(views, String(item.url))
    ),
  })).filter((group) => group.items.length > 0)
}

/** Landing page for a role: 总览, else 虚拟机, else its first sidebar page. */
export function homePathFor(views?: readonly string[] | null): string {
  const preferred = ['/overview', '/vm'].find((path) =>
    canOpenPath(views, path)
  )
  if (preferred) return preferred
  const first = navGroupsFor(views)[0]?.items[0]?.url
  return first ? String(first) : '/welcome'
}

export const sidebarData: SidebarData = {
  user: {
    name: 'admin',
    email: 'admin',
    avatar: '',
  },
  teams: [
    {
      name: 'vm2api',
      logo: LayoutDashboard,
      plan: 'Console API',
    },
  ],
  navGroups: ALL_GROUPS,
}
