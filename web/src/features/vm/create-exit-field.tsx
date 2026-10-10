import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { VmProxySnap } from '@/types/panel-vm'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  proxyBindable,
  proxiesForNode,
  proxyOptionLabel,
  proxyRemaining,
  readPositive,
  sortedProxiesByAvailability,
} from '@/features/proxies/proxy-sort'
import { proxiesQueryOptions } from '@/features/proxies/queries'
import { useVpsIp } from '@/features/proxies/use-vps-ip'

/** 不指定出口：后端按健康度自动分配，提交时不发 `proxy_id`。 */
const AUTO_EXIT = '__auto__'

export type CreateExit = {
  value: string
  setValue: (id: string) => void
  options: VmProxySnap[]
  poolLimit: number
  vpsIp: string | null
  /** 提交用；null = 自动分配。 */
  proxyId: string | null
}

/**
 * 创建槽位时的出口。本地代理固定第一，按目标 VPS 选择对应出口与容量：
 * 放到集群节点时它就是那台节点自身的出口。
 */
export function useCreateExit(nodeId: string): CreateExit {
  const px = useQuery(proxiesQueryOptions())
  const [picked, setPicked] = useState(AUTO_EXIT)
  const proxies = proxiesForNode(px.data, nodeId)
  const tot = (px.data?.totals || {}) as Record<string, unknown>
  const cfg = (px.data?.config || {}) as Record<string, unknown>
  const poolLimit = readPositive(
    tot,
    'bind_limit',
    readPositive(cfg, 'bind_limit', 5)
  )
  const vpsIp = useVpsIp(nodeId || null, proxies)
  const options = sortedProxiesByAvailability(proxies, '', poolLimit).filter(
    (p) => p.id && proxyBindable(p) && proxyRemaining(p, '', poolLimit) > 0
  )
  // 选中的出口被删 / 绑满后退回自动分配，不提交一个必然被拒的 id。
  const value = options.some((p) => p.id === picked) ? picked : AUTO_EXIT
  return {
    value,
    setValue: setPicked,
    options,
    poolLimit,
    vpsIp,
    proxyId: value === AUTO_EXIT ? null : value,
  }
}

export function CreateExitField({
  exit,
  remote,
}: {
  exit: CreateExit
  /** 目标是集群节点。 */
  remote: boolean
}) {
  return (
    <div className='space-y-1'>
      <Label>出口</Label>
      <Select value={exit.value} onValueChange={exit.setValue}>
        <SelectTrigger aria-label='出口'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {exit.options.map((p) => (
            <SelectItem key={p.id} value={p.id || ''}>
              {proxyOptionLabel(p, exit.poolLimit, exit.vpsIp)}
            </SelectItem>
          ))}
          <SelectItem value={AUTO_EXIT}>自动分配空闲出口</SelectItem>
        </SelectContent>
      </Select>
      <p className='text-xs text-muted-foreground'>
        本地代理按 VPS 独立计算席位：槽位与控制面代发请求都从
        {remote ? '目标节点' : '主控'}自身出网。
      </p>
    </div>
  )
}
