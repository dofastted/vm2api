import { Link } from '@tanstack/react-router'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { cn } from '@/lib/utils'
import { localProxyText, proxyHostLabel } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TabsContent } from '@/components/ui/tabs'
import { StatusMark } from '@/components/status-mark'
import { HealthDonut } from '@/features/overview/health-gauge'
import {
  proxyIsLocal,
  proxyHostText,
  proxyLabel,
  proxyStatusLabel,
} from '@/features/proxies/proxy-sort'
import {
  proxyFieldClass,
  proxyLatencyTone,
} from '@/features/proxies/proxy-tone'
import { useVpsIp } from '@/features/proxies/use-vps-ip'
import { Field } from '@/features/vm/detail-section-primitives'
import { proxyHealthOf } from '@/features/vm/proxy-health'

type VmProxyTabProps = {
  vm: Vm
  proxy: VmProxySnap
  boundId: string
  free: VmProxySnap[]
  /** 整个池：本机槽的本地代理 IP 取自池里本地代理行的出口地理。 */
  pool: VmProxySnap[]
  bindId: string
  onBindIdChange: (id: string) => void
  onUnbind: () => void
  onAllocate: () => void
  onBind: () => void
  onProbe: () => void
  onGeo: () => void
}

export function VmProxyTab(props: VmProxyTabProps) {
  const {
    vm,
    proxy,
    boundId,
    free,
    pool,
    bindId,
    onBindIdChange,
    onUnbind,
    onAllocate,
    onBind,
    onProbe,
    onGeo,
  } = props
  const health = proxyHealthOf(vm, proxy)
  const local = !!boundId && proxyIsLocal(proxy)
  const vpsIp = useVpsIp(vm.node_id, pool)
  // 旧接口不带节点出口行时，不把主控地理当作子节点观测。
  const unscopedNodeLocal = local && !!vm.node_id && !proxy.view_id
  const selectedId = bindId || free[0]?.id || ''

  return (
    <TabsContent value='proxy' className='space-y-3 pt-4'>
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>
            {local ? '绑定的本地代理' : '绑定的 SOCKS5'}
          </CardTitle>
        </CardHeader>
        <p className='px-6 pb-2 text-xs text-muted-foreground'>
          {local
            ? `槽内流量与控制面代发请求（换票、刷新、测试）都从 ${proxy.view_id ? proxyLabel(proxy) : localProxyText(vpsIp)} 出网，local 席位按所在 VPS 独立计算。`
            : '出站经这条代理的 egress 网关。槽内不 Dial SOCKS。'}
        </p>
        {proxy.blocked_reason === 'node_unavailable' ? (
          <p className='px-6 pb-2 text-xs text-caution-3'>
            节点未连接，已有绑定保留；连接恢复后才能绑定新槽位或探测。
          </p>
        ) : null}
        <CardContent className='flex flex-wrap gap-6 pt-0'>
          <HealthDonut score={health.score} label='健康' size={80} />
          <div className='min-w-0 flex-1 divide-y'>
            <Field label='绑定 ID'>
              <span className='field-host text-xs'>{boundId || '—'}</span>
            </Field>
            {proxy.label ? (
              <Field label='代理名称'>
                <span className='text-xs'>{proxy.label}</span>
              </Field>
            ) : null}
            <Field label='地址'>
              <span className='field-host text-xs'>
                {local ? proxyHostText(proxy, vpsIp) : proxyHostLabel(proxy)}
                {local && vpsIp ? ` · ${vpsIp}` : ''}
              </span>
            </Field>
            <Field label='状态'>
              <span className='flex items-center gap-2'>
                {proxyStatusLabel(proxy)}
                {vm.has_token && !proxy.host && !vm.proxy_id ? (
                  <StatusMark
                    variant='pill'
                    tone={{
                      key: 'bad',
                      text: '缺 SOCKS5',
                      cls: 'bad',
                      label: '缺 SOCKS5 · fail closed',
                    }}
                  />
                ) : null}
              </span>
            </Field>
            <Field label='延迟'>
              <span
                className={cn(
                  'field-metric text-sm',
                  proxyFieldClass(proxyLatencyTone(proxy))
                )}
              >
                {proxy.latency_ms != null ? `${proxy.latency_ms}ms` : '—'}
              </span>
            </Field>
            <Field label='认证'>{proxy.has_auth ? '有' : '无'}</Field>
            <Field label='出口'>
              {unscopedNodeLocal ? (
                <span className='text-xs text-muted-foreground'>
                  随节点出口（时区按节点出口地理同步）
                </span>
              ) : proxy.geo?.country || proxy.geo?.timezone ? (
                <span className='flex flex-wrap items-center gap-1.5'>
                  {[proxy.geo.country_code || proxy.geo.country, proxy.geo.city]
                    .filter(Boolean)
                    .map((v) => (
                      <StatusMark
                        key={v}
                        variant='pill'
                        tone={{ key: 'none', text: String(v), cls: 'none' }}
                      />
                    ))}
                  {proxy.geo.timezone ? (
                    <>
                      <StatusMark
                        variant='pill'
                        tone={{
                          key: 'none',
                          text: proxy.geo.timezone,
                          cls:
                            proxy.geo.timezone !== vm.timezone
                              ? 'caution'
                              : 'none',
                        }}
                      />
                      {proxy.geo.timezone !== vm.timezone ? (
                        <span className='text-[11px] text-muted-foreground'>
                          槽位为 {vm.timezone || '—'}，可在「运维 · 环境」跟随
                        </span>
                      ) : null}
                    </>
                  ) : null}
                  {proxy.geo.isp ? (
                    <span className='text-[11px] text-muted-foreground'>
                      {proxy.geo.isp}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className='text-xs text-muted-foreground'>
                  {proxy.blocked_reason
                    ? proxyStatusLabel(proxy)
                    : proxy.geo?.error
                      ? '检测失败'
                      : '未检测'}
                </span>
              )}
            </Field>
          </div>
        </CardContent>
      </Card>
      <div className='flex flex-wrap gap-2'>
        {boundId ? (
          <>
            <Button
              size='sm'
              variant='outline'
              onClick={onProbe}
              disabled={!!proxy.blocked_reason}
            >
              测通
            </Button>
            <Button
              size='sm'
              variant='outline'
              onClick={onGeo}
              disabled={!!proxy.blocked_reason}
            >
              测地理
            </Button>
            <Button size='sm' variant='outline' onClick={onUnbind}>
              解绑
            </Button>
          </>
        ) : null}
        <Button size='sm' variant='outline' onClick={onAllocate}>
          分配空闲出口
        </Button>
        <Button size='sm' variant='ghost' asChild>
          <Link to='/settings/$tab' params={{ tab: 'socks5' }}>
            设置里管理池
          </Link>
        </Button>
      </div>
      {free.length ? (
        <div className='flex gap-2'>
          <Select value={selectedId} onValueChange={onBindIdChange}>
            <SelectTrigger className='w-64'>
              <SelectValue placeholder='选择出口' />
            </SelectTrigger>
            <SelectContent>
              {free.map((p) => (
                <SelectItem key={p.id} value={p.id || ''}>
                  {proxyLabel(p, vpsIp)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size='sm'
            onClick={onBind}
            disabled={!selectedId || selectedId === boundId}
          >
            绑定
          </Button>
        </div>
      ) : (
        <p className='text-sm text-muted-foreground'>池里没有可绑的空闲出口</p>
      )}
    </TabsContent>
  )
}
