import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { VmProxySnap } from '@/types/panel-vm'
import { Activity, Globe } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ProxyPanel } from './proxy-panel'
import { SeatCells } from './proxy-seats'
import { proxyBoundIds } from './proxy-sort'
import { useRefreshProxies } from './queries'

const BIND_LIMITS = [1, 2, 3, 4, 5, 8, 10, 16, 20, 32]
const PROBE_MINS = [5, 10, 30, 60]
// The chosen upstream is tried first; the existing automatic fallback order
// is unchanged, including when a domain or custom HTTPS endpoint is selected.
const DNS_CHOICES = [
  { value: 'auto', label: '自动（默认顺序）' },
  { value: 'https://1.1.1.1/dns-query', label: 'Cloudflare DoH' },
  {
    value: 'https://cloudflare-dns.com/dns-query',
    label: 'Cloudflare DoH（域名）',
  },
  { value: 'https://8.8.8.8/dns-query', label: 'Google DoH' },
  { value: '8.8.8.8:53', label: 'Google TCP 53（明文）' },
  { value: '1.1.1.1:53', label: 'Cloudflare TCP 53（明文）' },
]

type ConfigResult = {
  egress?: { proxy_id: string; ok: boolean; error?: string | null }[]
}

export function ProxyManagePanel({
  proxies,
  bindLimit,
  probeMin,
  dnsPrimary,
  dnsDisableSvcbHttps,
  followProxyTimezone,
}: {
  proxies: VmProxySnap[]
  bindLimit: number
  probeMin: number
  dnsPrimary: string
  dnsDisableSvcbHttps: boolean
  followProxyTimezone: boolean
}) {
  const refresh = useRefreshProxies()
  const [customDnsDraft, setCustomDnsDraft] = useState<string | null>(null)
  const lastProbe = useMemo(() => {
    let max = 0
    for (const p of proxies) {
      const t = Date.parse(p.last_probe_at || '')
      if (Number.isFinite(t) && t > max) max = t
    }
    return max ? new Date(max).toISOString() : ''
  }, [proxies])
  const maxUsed = proxies.reduce(
    (n, p) => Math.max(n, proxyBoundIds(p).length),
    0
  )

  const saveConfig = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<ConfigResult>('/api/panel/proxies/config', {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    onSuccess: async (data, patch) => {
      const failed = (data.egress || []).filter((entry) => !entry.ok)
      if (failed.length) {
        toast.warning(
          `DNS 已保存，但 ${failed.length} 个出口重载失败：${failed.map((entry) => entry.proxy_id).join('、')}`
        )
      } else if (
        patch.dns_primary != null ||
        patch.dns_disable_svcb_https != null
      ) {
        toast.success('出口 DNS 已保存，本机出口已同步')
      } else if (patch.bind_limit != null) {
        toast.success(`每个出口最多绑 ${String(patch.bind_limit)} 台`)
      } else if (patch.probe_interval_min != null) {
        toast.success(`探测间隔 ${String(patch.probe_interval_min)} 分钟`)
      } else {
        toast.success('已保存')
      }
      await refresh()
      if (patch.dns_primary != null) setCustomDnsDraft(null)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const probeAll = useMutation({
    mutationFn: () => api('/api/panel/proxies/probe', { method: 'POST' }),
    onSuccess: async () => {
      toast.success('代理探测完成')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const geoAll = useMutation({
    mutationFn: () =>
      api<{ results?: { ok?: boolean }[] }>('/api/panel/proxies/geo', {
        method: 'POST',
        body: JSON.stringify({ force: true }),
      }),
    onSuccess: async (data) => {
      const rows = data.results || []
      const ok = rows.filter((r) => r.ok).length
      toast.success(`地理检测完成 ${ok}/${rows.length}`)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  // 保存中的值先行显示，避免选中后按钮跳回旧值再跳到新值。
  const pending = saveConfig.isPending ? saveConfig.variables : undefined
  const limitShown = Number(pending?.bind_limit ?? bindLimit)
  const probeShown = Number(pending?.probe_interval_min ?? probeMin)
  const dnsShown = String(pending?.dns_primary ?? dnsPrimary)
  const dnsDisableShown = Boolean(
    pending?.dns_disable_svcb_https ?? dnsDisableSvcbHttps
  )
  const customDnsShown =
    customDnsDraft !== null ||
    !DNS_CHOICES.some((choice) => choice.value === dnsShown)
  const over = proxies.filter((p) => proxyBoundIds(p).length > limitShown)

  return (
    <ProxyPanel title='管理'>
      <div className='grid grid-cols-2 gap-2'>
        <Button
          variant='outline'
          size='sm'
          onClick={() => probeAll.mutate()}
          disabled={probeAll.isPending || !proxies.length}
          loading={probeAll.isPending}
          title='检测各出口可用性，不发送推理请求'
        >
          <Activity aria-hidden='true' />
          全部测通
        </Button>
        <Button
          variant='outline'
          size='sm'
          onClick={() => geoAll.mutate()}
          disabled={geoAll.isPending || !proxies.length}
          loading={geoAll.isPending}
          title='经每条代理查出口 IP 的国家 / 城市 / 时区'
        >
          <Globe aria-hidden='true' />
          全部测地理
        </Button>
      </div>
      <p className='mt-1.5 text-[11px] text-muted-foreground'>
        {lastProbe ? `最近探测 ${fmtAgo(lastProbe)}` : '还没有探测记录'} · 每{' '}
        {probeShown} 分钟自动探测
      </p>

      <div className='mt-4 space-y-4 border-t pt-4'>
        <fieldset>
          <legend className='flex w-full items-baseline justify-between text-xs font-medium'>
            每个出口最多绑
            <span className='text-muted-foreground tabular-nums'>
              容量 {proxies.length} × {limitShown} ={' '}
              <b className='font-semibold text-foreground'>
                {proxies.length * limitShown}
              </b>
            </span>
          </legend>
          <div className='mt-2 flex items-center gap-3'>
            <span className='inline-flex w-14 items-baseline gap-0.5 tabular-nums'>
              <span className='text-2xl leading-none font-[620] tracking-[-0.03em]'>
                {limitShown}
              </span>
              <span className='text-xs text-muted-foreground'>台</span>
            </span>
            <SeatCells
              used={maxUsed}
              limit={limitShown}
              color='var(--status-ok-solid)'
              className='min-w-0 flex-1'
            />
          </div>
          <Segmented
            label='每个出口最多绑定台数'
            options={BIND_LIMITS}
            value={limitShown}
            disabled={saveConfig.isPending}
            onChange={(value) => saveConfig.mutate({ bind_limit: value })}
            className='mt-2 grid-cols-5'
          />
          <p className='mt-1.5 text-[11px] text-muted-foreground'>
            {over.length
              ? `${over.length} 条代理已绑超过 ${limitShown} 台：现有绑定保留，只是不再接新槽位。`
              : maxUsed
                ? `亮格为当前绑得最多的一条（${maxUsed} 台）。`
                : '每台 VPS 的 local 独立计数；调低不会踢掉已绑的槽位。'}
          </p>
        </fieldset>

        <fieldset>
          <legend className='text-xs font-medium'>自动探测间隔</legend>
          <Segmented
            label='自动探测间隔（分钟）'
            options={PROBE_MINS}
            value={probeShown}
            suffix='分'
            disabled={saveConfig.isPending}
            onChange={(value) =>
              saveConfig.mutate({ probe_interval_min: value })
            }
            className='mt-2 grid-cols-4'
          />
        </fieldset>

        <div>
          <label
            htmlFor='proxy-dns'
            className='flex items-baseline justify-between text-xs font-medium'
          >
            出口 DNS
            <span className='font-normal text-muted-foreground'>
              失败自动换下一个
            </span>
          </label>
          <Select
            value={customDnsShown ? 'custom' : dnsShown}
            disabled={saveConfig.isPending}
            onValueChange={(value) => {
              if (value === 'custom') {
                setCustomDnsDraft(customDnsShown ? dnsShown : '')
              } else {
                setCustomDnsDraft(null)
                saveConfig.mutate({ dns_primary: value })
              }
            }}
          >
            <SelectTrigger id='proxy-dns' className='mt-2 h-8 w-full text-xs'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DNS_CHOICES.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
              <SelectItem value='custom'>自定义 HTTPS DoH</SelectItem>
            </SelectContent>
          </Select>
          {customDnsShown && (
            <form
              className='mt-2 space-y-2'
              onSubmit={(event) => {
                event.preventDefault()
                if (!saveConfig.isPending) {
                  saveConfig.mutate({ dns_primary: customDnsDraft ?? dnsShown })
                }
              }}
            >
              <label htmlFor='proxy-dns-url' className='text-xs font-medium'>
                自定义 DoH URL
              </label>
              <Input
                id='proxy-dns-url'
                type='url'
                required
                title='请输入完整的 HTTPS DoH URL，例如 https://dns.example.com/dns-query'
                pattern='https://.+'
                value={customDnsDraft ?? dnsShown}
                onChange={(event) => setCustomDnsDraft(event.target.value)}
                disabled={saveConfig.isPending}
                placeholder='https://dns.example.com/dns-query'
                aria-describedby='proxy-dns-url-help'
                className='h-8 text-xs'
              />
              <p
                id='proxy-dns-url-help'
                className='text-[11px] text-muted-foreground'
              >
                输入完整 HTTPS URL，支持域名或 IP（IPv6
                地址需加方括号）；不能包含用户名、密码、片段（#）或逗号。
              </p>
              <Button
                type='submit'
                size='sm'
                variant='outline'
                disabled={saveConfig.isPending}
                loading={saveConfig.isPending}
              >
                保存 DNS
              </Button>
            </form>
          )}
        </div>

        <div className='flex items-start justify-between gap-3'>
          <div className='space-y-0.5'>
            <label
              htmlFor='proxy-dns-empty-types'
              className='block text-xs font-medium'
            >
              关闭 DNS type 64 / 65
            </label>
            <p
              id='proxy-dns-empty-types-help'
              className='text-[11px] text-muted-foreground'
            >
              通过 DNS 覆写让 SVCB（64）、HTTPS（65）返回空答案；A / AAAA
              解析不受影响。 仅用于 SOCKS5
              出口，集群出口在下次启动或重载槽位时生效。
            </p>
          </div>
          <Switch
            id='proxy-dns-empty-types'
            checked={dnsDisableShown}
            disabled={saveConfig.isPending}
            onCheckedChange={(value) =>
              saveConfig.mutate({ dns_disable_svcb_https: value })
            }
            aria-describedby='proxy-dns-empty-types-help'
            className='mt-0.5'
          />
        </div>

        <label className='flex cursor-pointer items-start justify-between gap-3'>
          <span className='space-y-0.5'>
            <span className='block text-xs font-medium'>
              绑定后跟随代理时区
            </span>
            <span className='block text-[11px] text-muted-foreground'>
              手动钉过时区的槽位不受影响
            </span>
          </span>
          <Switch
            checked={followProxyTimezone}
            onCheckedChange={(value) =>
              saveConfig.mutate({ follow_proxy_timezone: value })
            }
            aria-label='绑定后跟随代理时区'
            className='mt-0.5'
          />
        </label>
      </div>
    </ProxyPanel>
  )
}

function Segmented({
  label,
  options,
  value,
  suffix,
  disabled,
  onChange,
  className,
}: {
  label: string
  options: number[]
  value: number
  suffix?: string
  disabled?: boolean
  onChange: (value: number) => void
  className?: string
}) {
  return (
    <div
      role='group'
      aria-label={label}
      className={cn('grid gap-1 rounded-lg bg-muted/60 p-1', className)}
    >
      {options.map((n) => {
        const on = n === value
        return (
          <button
            key={n}
            type='button'
            aria-pressed={on}
            disabled={disabled}
            onClick={() => !on && onChange(n)}
            className={cn(
              'h-7 rounded-md text-xs tabular-nums transition-colors disabled:cursor-wait',
              on
                ? 'bg-background font-semibold text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
            )}
          >
            {n}
            {suffix ? (
              <span className='ms-px text-[10px] font-normal opacity-70'>
                {suffix}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
