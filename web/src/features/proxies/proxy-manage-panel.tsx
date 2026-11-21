import { useEffect, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { VmProxySnap } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
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
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SeatCells } from './proxy-seats'
import { proxyBoundIds, proxyIsLocal } from './proxy-sort'
import { useRefreshProxies } from './queries'

const BIND_LIMITS = [1, 2, 3, 4, 5, 8, 10, 16, 20, 32]
const PROBE_MINS = [5, 10, 30, 60]
// 选中的那个排第一，其余内置上游仍按原顺序排在后面做 fallback；
// 选域名或自定义 HTTPS 时这个 fallback 顺序也不变。
const DNS_CHOICES = [
  { value: 'auto', label: '自动挑最快的' },
  { value: 'https://1.1.1.1/dns-query', label: 'Cloudflare（加密）' },
  {
    value: 'https://cloudflare-dns.com/dns-query',
    label: 'Cloudflare（加密，走域名）',
  },
  { value: 'https://8.8.8.8/dns-query', label: 'Google（加密）' },
  { value: '8.8.8.8:53', label: 'Google（不加密）' },
  { value: '1.1.1.1:53', label: 'Cloudflare（不加密）' },
]

type ConfigResult = {
  egress?: { proxy_id: string; ok: boolean; error?: string | null }[]
}

/** 本次能改的池级字段。DNS 屏蔽开关不在其中：它是逐条写入的批量动作。 */
type Draft = {
  bind_limit: number
  probe_interval_min: number
  dns_primary: string
  follow_proxy_timezone: boolean
}

function reportEgress(data: ConfigResult, okText: string) {
  const failed = (data.egress || []).filter((entry) => !entry.ok)
  if (failed.length) {
    toast.warning(
      `已保存，但 ${failed.length} 条代理的出口没重载成功：${failed
        .map((entry) => entry.proxy_id)
        .join('、')}`
    )
    return
  }
  toast.success(okText)
}

export function ProxyManagePanel({
  proxies,
  bindLimit,
  probeMin,
  dnsPrimary,
  followProxyTimezone,
  onDirtyChange,
}: {
  proxies: VmProxySnap[]
  bindLimit: number
  probeMin: number
  dnsPrimary: string
  followProxyTimezone: boolean
  /** 有未保存改动时上报，抽屉据此拦住关闭。 */
  onDirtyChange?: (dirty: boolean) => void
}) {
  const refresh = useRefreshProxies()
  const saved: Draft = useMemo(
    () => ({
      bind_limit: bindLimit,
      probe_interval_min: probeMin,
      dns_primary: dnsPrimary,
      follow_proxy_timezone: followProxyTimezone,
    }),
    [bindLimit, probeMin, dnsPrimary, followProxyTimezone]
  )
  const [draft, setDraft] = useState<Draft>(saved)
  // 自定义 DoH 的输入框是否展开。null = 跟随 draft 判断，避免一边输入一边
  // 被「这个值不在预设里」的推断反复开合。
  const [customOpen, setCustomOpen] = useState<boolean | null>(null)

  const dirtyKeys = useMemo(
    () =>
      (Object.keys(saved) as (keyof Draft)[]).filter(
        (k) => draft[k] !== saved[k]
      ),
    [draft, saved]
  )
  const dirty = dirtyKeys.length > 0

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  // 外部值变了（别处保存、后台刷新）且本地没在改，就跟上。
  useEffect(() => {
    if (!dirty) setDraft(saved)
    // dirty 变化本身不该触发同步：只在 saved 变动时对齐。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved])

  // 本地代理没有自己的 kin-egress helper，带不了这个开关。判定与后端
  // isLocalEgressProxy 对齐：节点那几条 px-local-<node> 也要排除。
  const outlets = useMemo(
    () => proxies.filter((p) => !proxyIsLocal(p)),
    [proxies]
  )
  const blocked = outlets.filter((p) => p.dns_disable_svcb_https === true)
  const blockedBound = blocked.filter((p) => proxyBoundIds(p).length).length
  const allBlocked = outlets.length > 0 && blocked.length === outlets.length
  const [bulkTarget, setBulkTarget] = useState<boolean | null>(null)

  const maxUsed = proxies.reduce(
    (n, p) => Math.max(n, proxyBoundIds(p).length),
    0
  )

  const save = useMutation({
    mutationFn: () => {
      const patch: Record<string, unknown> = {}
      for (const key of dirtyKeys) patch[key] = draft[key]
      return api<ConfigResult>('/api/panel/proxies/config', {
        method: 'PUT',
        body: JSON.stringify(patch),
      })
    },
    onSuccess: async (data) => {
      reportEgress(data, '代理池设置已保存')
      setCustomOpen(null)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  // 批量动作不进草稿：它逐条写入每个代理，确认后立即执行。
  const applyAll = useMutation({
    mutationFn: (value: boolean) =>
      api<ConfigResult>('/api/panel/proxies/config', {
        method: 'PUT',
        body: JSON.stringify({ dns_disable_svcb_https: value }),
      }),
    onSuccess: async (data, value) => {
      reportEgress(
        data,
        value
          ? `已对 ${outlets.length} 条代理开启屏蔽`
          : `已对 ${outlets.length} 条代理关闭屏蔽`
      )
      setBulkTarget(null)
      await refresh()
    },
    onError: (error: Error) => {
      toast.error(error.message)
      setBulkTarget(null)
    },
  })

  const busy = save.isPending || applyAll.isPending
  const customShown =
    customOpen ??
    !DNS_CHOICES.some((choice) => choice.value === draft.dns_primary)
  const over = proxies.filter((p) => proxyBoundIds(p).length > draft.bind_limit)
  const dnsInvalid = customShown && !/^https:\/\/.+/.test(draft.dns_primary)

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <div className='min-h-0 flex-1 space-y-5 overflow-y-auto p-4'>
        <fieldset>
          <legend className='flex w-full items-baseline justify-between text-xs font-medium'>
            <span>
              每条代理最多带几台机器
              <Unsaved on={dirtyKeys.includes('bind_limit')} />
            </span>
            <span className='text-muted-foreground tabular-nums'>
              总共能带 {proxies.length} × {draft.bind_limit} ={' '}
              <b className='font-semibold text-foreground'>
                {proxies.length * draft.bind_limit}
              </b>
            </span>
          </legend>
          <div className='mt-2 flex items-center gap-3'>
            <span className='inline-flex w-14 items-baseline gap-0.5 tabular-nums'>
              <span className='text-2xl leading-none font-[620] tracking-[-0.03em]'>
                {draft.bind_limit}
              </span>
              <span className='text-xs text-muted-foreground'>台</span>
            </span>
            <SeatCells
              used={maxUsed}
              limit={draft.bind_limit}
              color='var(--status-ok-solid)'
              className='min-w-0 flex-1'
            />
          </div>
          <Segmented
            label='每条代理最多带几台机器'
            options={BIND_LIMITS}
            value={draft.bind_limit}
            disabled={busy}
            onChange={(value) => setDraft((d) => ({ ...d, bind_limit: value }))}
            className='mt-2 grid-cols-5'
          />
          <p className='mt-1.5 text-[11px] text-muted-foreground'>
            {over.length
              ? `有 ${over.length} 条代理已经带超过 ${draft.bind_limit} 台：已经带着的不会被踢掉，只是不再接新的。`
              : maxUsed
                ? `亮起来的格子是目前带得最多的那条（${maxUsed} 台）。`
                : '改小不会踢掉已经带着的机器。'}
          </p>
        </fieldset>

        <fieldset>
          <legend className='text-xs font-medium'>
            多久自动测一次通不通
            <Unsaved on={dirtyKeys.includes('probe_interval_min')} />
          </legend>
          <Segmented
            label='多久自动测一次通不通'
            options={PROBE_MINS}
            value={draft.probe_interval_min}
            suffix='分'
            disabled={busy}
            onChange={(value) =>
              setDraft((d) => ({ ...d, probe_interval_min: value }))
            }
            className='mt-2 grid-cols-4'
          />
          <p className='mt-1.5 text-[11px] text-muted-foreground'>
            测不通的代理会自动停用，带着的机器也会暂停派活。
          </p>
        </fieldset>

        <div>
          <label
            htmlFor='proxy-dns'
            className='flex items-baseline justify-between text-xs font-medium'
          >
            <span>
              域名解析走哪里
              <Unsaved on={dirtyKeys.includes('dns_primary')} />
            </span>
            <span className='font-normal text-muted-foreground'>
              这个不通会自动换下一个
            </span>
          </label>
          <Select
            value={customShown ? 'custom' : draft.dns_primary}
            disabled={busy}
            onValueChange={(value) => {
              if (value === 'custom') {
                setCustomOpen(true)
                setDraft((d) => ({
                  ...d,
                  dns_primary: DNS_CHOICES.some(
                    (c) => c.value === d.dns_primary
                  )
                    ? ''
                    : d.dns_primary,
                }))
              } else {
                setCustomOpen(false)
                setDraft((d) => ({ ...d, dns_primary: value }))
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
              <SelectItem value='custom'>填自己的加密 DNS</SelectItem>
            </SelectContent>
          </Select>
          {customShown && (
            <div className='mt-2 space-y-2'>
              <label htmlFor='proxy-dns-url' className='text-xs font-medium'>
                你的加密 DNS 地址
              </label>
              <Input
                id='proxy-dns-url'
                type='url'
                value={draft.dns_primary}
                onChange={(event) =>
                  setDraft((d) => ({ ...d, dns_primary: event.target.value }))
                }
                disabled={busy}
                aria-invalid={dnsInvalid}
                placeholder='https://dns.example.com/dns-query'
                aria-describedby='proxy-dns-url-help'
                className='h-8 text-xs'
              />
              <p
                id='proxy-dns-url-help'
                className='text-[11px] text-muted-foreground'
              >
                要完整的 https:// 地址，域名或 IP 都行（IPv6
                要用方括号括起来）。不能带用户名、密码、井号和逗号。
              </p>
            </div>
          )}
        </div>

        <div className='flex items-start justify-between gap-3'>
          <div className='space-y-0.5'>
            <label
              htmlFor='proxy-dns-block-all'
              className='block text-xs font-medium'
            >
              屏蔽 HTTP/3 与加密 SNI 探测
            </label>
            <p
              id='proxy-dns-block-all-help'
              className='text-[11px] text-muted-foreground'
            >
              让浏览器查不到 HTTP/3 和加密 SNI 的线路，只走普通
              HTTPS。网站照样打得开，正常域名解析不受影响。
            </p>
            <p className='text-[11px] text-muted-foreground'>
              {outlets.length === 0
                ? '现在还没有代理可以设置。'
                : allBlocked
                  ? `已对全部 ${outlets.length} 条代理开启。`
                  : blocked.length === 0
                    ? `全部 ${outlets.length} 条代理都没开启。`
                    : `${outlets.length} 条代理里有 ${blocked.length} 条开着。这个开关一次改全部，想只改一条请到那条代理的「编辑」里。`}
            </p>
          </div>
          <Switch
            id='proxy-dns-block-all'
            checked={allBlocked}
            disabled={busy || outlets.length === 0}
            onCheckedChange={(value) => setBulkTarget(value)}
            aria-describedby='proxy-dns-block-all-help'
            className='mt-0.5'
          />
        </div>

        <label className='flex cursor-pointer items-start justify-between gap-3'>
          <span className='space-y-0.5'>
            <span className='block text-xs font-medium'>
              机器时间跟着代理所在地走
              <Unsaved on={dirtyKeys.includes('follow_proxy_timezone')} />
            </span>
            <span className='block text-[11px] text-muted-foreground'>
              手动设过时区的机器不受影响
            </span>
          </span>
          <Switch
            checked={draft.follow_proxy_timezone}
            disabled={busy}
            onCheckedChange={(value) =>
              setDraft((d) => ({ ...d, follow_proxy_timezone: value }))
            }
            aria-label='机器时间跟着代理所在地走'
            className='mt-0.5'
          />
        </label>
      </div>

      <div className='flex items-center justify-end gap-2 border-t bg-background p-4'>
        <p
          className='me-auto text-[11px] text-muted-foreground'
          aria-live='polite'
        >
          {dirty ? `有 ${dirtyKeys.length} 项还没保存` : '没有待保存的改动'}
        </p>
        <Button
          variant='outline'
          size='sm'
          disabled={!dirty || busy}
          onClick={() => {
            setDraft(saved)
            setCustomOpen(null)
          }}
        >
          放弃改动
        </Button>
        <Button
          size='sm'
          disabled={!dirty || busy || dnsInvalid}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          保存
        </Button>
      </div>

      <ConfirmDialog
        open={bulkTarget !== null}
        onOpenChange={(open) => !open && setBulkTarget(null)}
        title={bulkTarget ? '对所有代理开启屏蔽' : '对所有代理关闭屏蔽'}
        desc={
          bulkTarget
            ? `会把全部 ${outlets.length} 条代理都设为屏蔽，包括现在没开的那些。`
            : `会把全部 ${outlets.length} 条代理都设为不屏蔽，包括现在开着的 ${blocked.length} 条。`
        }
        confirmText={bulkTarget ? '全部开启' : '全部关闭'}
        cancelBtnText='取消'
        isLoading={applyAll.isPending}
        handleConfirm={() => {
          if (bulkTarget !== null) applyAll.mutate(bulkTarget)
        }}
      >
        {blockedBound ||
        (bulkTarget && outlets.some((p) => proxyBoundIds(p).length)) ? (
          <p className='text-xs text-[color:var(--status-caution)]'>
            带着机器的代理会重启出口，期间它们的网络会断一下。
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}

/** 未保存标记：圆点之外还有文字，不靠颜色单独承载信息。 */
function Unsaved({ on }: { on: boolean }) {
  if (!on) return null
  return (
    <span className='ms-1.5 inline-flex items-center gap-1 align-middle text-[10px] font-normal text-[color:var(--status-caution)]'>
      <span aria-hidden='true' className='size-1.5 rounded-full bg-current' />
      未保存
    </span>
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
