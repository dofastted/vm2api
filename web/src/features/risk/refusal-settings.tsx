import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  RefusalDeviceBlock,
  RefusalGuardConfig,
  RefusalSessionBlock,
} from '@/types/panel-routing'
import type {
  UsageLogRow,
  UsageLogsBatchResult,
} from '@/types/panel-usage-logs'
import {
  Check,
  Copy,
  Fingerprint,
  Search,
  ShieldBan,
  ShieldOff,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtExpiresAt } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyNotice, Group, ToggleItem, ToggleList } from './blocks'
import { refusalGuardsQueryOptions } from './queries'
import { RiskPolicyForm } from './risk-policy-form'

function CopyIdButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast.success(`已复制${label}`)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('复制失败')
    }
  }
  return (
    <button
      type='button'
      aria-label={`复制${label}`}
      title={`复制${label}`}
      onClick={handleCopy}
      className='inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
    >
      {copied ? (
        <Check
          className='size-3.5 text-[var(--status-ok)]'
          aria-hidden='true'
        />
      ) : (
        <Copy className='size-3' aria-hidden='true' />
      )}
    </button>
  )
}

const SIMILARITY_CHOICES = [80, 85, 90, 95] as const

function shortFp(fp: string) {
  const s = String(fp || '')
  if (s.length <= 16) return s
  return `${s.slice(0, 10)}…${s.slice(-6)}`
}

export function RefusalSettings({
  section,
  onDirtyChange,
}: {
  section: 'preflight' | 'jev'
  onDirtyChange: (dirty: boolean) => void
}) {
  const qc = useQueryClient()
  const q = useQuery(refusalGuardsQueryOptions())

  const save = useMutation({
    mutationFn: (patch: Partial<RefusalGuardConfig>) =>
      api<RefusalGuardConfig>('/api/panel/refusal-guards', {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    onSuccess: async (data) => {
      toast.success(section === 'jev' ? '已保存降级策略' : '已保存前置策略')
      qc.setQueryData(refusalGuardsQueryOptions().queryKey, data)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (q.error) return <SettingsError error={q.error} />
  if (!q.data) return <SettingsLoading />
  const data = q.data
  const similarity = data.similarity ?? 90

  return (
    <div className='space-y-8 p-4'>
      {section === 'preflight' && (
        <Group
          title='何时拦截'
          hint='上游策略拒答回填为指纹。重复命中返回不可重试的 400；相似匹配只比较用户正文。开关立即生效。'
        >
          <ToggleList>
            <ToggleItem
              label='封锁拒答会话'
              desc='上游拒答一次，这个会话（含子 agent）永久不再转发，也不换号重试；不受下面总开关影响'
            >
              <Switch
                checked={data.session_block_enabled !== false}
                disabled={save.isPending}
                onCheckedChange={(session_block_enabled) =>
                  save.mutate({ session_block_enabled })
                }
              />
            </ToggleItem>
            <ToggleItem
              label='拦截重复拒答'
              desc='REFUSAL_GUARD=0 时不使用拒答缓存'
            >
              <Switch
                checked={data.enabled}
                disabled={save.isPending}
                onCheckedChange={(enabled) => save.mutate({ enabled })}
              />
            </ToggleItem>
            <ToggleItem label='近似拦截' desc='不含共享 system'>
              <Switch
                checked={data.similarity_enabled !== false}
                disabled={save.isPending || !data.enabled}
                onCheckedChange={(similarity_enabled) =>
                  save.mutate({ similarity_enabled })
                }
              />
            </ToggleItem>
            <ToggleItem
              label='启用分级封禁'
              desc='设备／机器按违规次数升级；违规会话永久阻止。'
            >
              <Switch
                checked={data.device_block_enabled !== false}
                disabled={save.isPending || !data.enabled}
                onCheckedChange={(device_block_enabled) =>
                  save.mutate({ device_block_enabled })
                }
              />
            </ToggleItem>
            <ToggleItem label='相似度' desc='越高越不容易误伤'>
              <div
                role='radiogroup'
                aria-label='相似度'
                className='flex rounded-lg bg-muted p-0.5'
              >
                {SIMILARITY_CHOICES.map((choice) => (
                  <button
                    key={choice}
                    type='button'
                    role='radio'
                    aria-checked={similarity === choice}
                    disabled={
                      save.isPending ||
                      !data.enabled ||
                      data.similarity_enabled === false
                    }
                    onClick={() => save.mutate({ similarity: choice })}
                    className='cursor-pointer rounded-md px-2 py-1 text-xs text-muted-foreground tabular-nums transition-colors duration-200 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm'
                  >
                    {choice}%
                  </button>
                ))}
              </div>
            </ToggleItem>
          </ToggleList>
        </Group>
      )}
      <RiskPolicyForm
        key={JSON.stringify(data.risk_audit)}
        section={section}
        value={data.risk_audit}
        pending={save.isPending}
        onDirtyChange={onDirtyChange}
        onSave={(risk_audit) => save.mutate({ risk_audit })}
      />
    </div>
  )
}

function SettingsError({ error }: { error: Error }) {
  return (
    <p className='p-4 text-sm text-destructive' role='alert'>
      {error.message}
    </p>
  )
}

function SettingsLoading() {
  return (
    <div
      className='h-40 animate-pulse bg-muted/40 motion-reduce:animate-none'
      aria-busy='true'
    />
  )
}

export function RefusalRecords({
  onOpen,
}: {
  onOpen: (row: UsageLogRow) => void
}) {
  const qc = useQueryClient()
  const q = useQuery(refusalGuardsQueryOptions())
  const [tab, setTab] = useState<'devices' | 'sessions' | 'fingerprints'>(
    'devices'
  )
  const [query, setQuery] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearDevicesOpen, setClearDevicesOpen] = useState(false)
  const [clearSessionsOpen, setClearSessionsOpen] = useState(false)
  const [deleteFp, setDeleteFp] = useState<string | null>(null)
  const [unblockId, setUnblockId] = useState<string | null>(null)
  const [unblockSessionId, setUnblockSessionId] = useState<string | null>(null)

  const source = useMutation({
    mutationFn: async (
      item: Pick<
        RefusalDeviceBlock | RefusalSessionBlock,
        'source_request_id' | 'session_id'
      >
    ) => {
      const params = new URLSearchParams({
        request_id: item.source_request_id || '',
        include_muted: '1',
        limit: '1',
      })
      if (item.session_id) params.set('session_id', item.session_id)
      const result = await api<UsageLogsBatchResult>(
        `/api/panel/usage-logs?${params}`
      )
      if (!result.logs[0]) throw new Error('原始请求日志已过保留期或未保存。')
      return result.logs[0]
    },
    onSuccess: onOpen,
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: (fingerprint: string) =>
      api<RefusalGuardConfig>(`/api/panel/refusal-guards/${fingerprint}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      toast.success('已删除指纹')
      setDeleteFp(null)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const clear = useMutation({
    mutationFn: () =>
      api<RefusalGuardConfig>('/api/panel/refusal-guards', {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: async () => {
      toast.success('已清空拒答缓存')
      setClearOpen(false)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const unblock = useMutation({
    mutationFn: (deviceId: string) =>
      api<RefusalGuardConfig>('/api/panel/refusal-device-blocks', {
        method: 'DELETE',
        body: JSON.stringify({ device_id: deviceId }),
      }),
    onSuccess: async () => {
      toast.success('已解除 device 封禁')
      setUnblockId(null)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const clearDevices = useMutation({
    mutationFn: () =>
      api<RefusalGuardConfig>('/api/panel/refusal-device-blocks', {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: async () => {
      toast.success('已清空设备与会话封禁')
      setClearDevicesOpen(false)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const unblockSession = useMutation({
    mutationFn: (sessionId: string) =>
      api<RefusalGuardConfig>('/api/panel/refusal-session-blocks', {
        method: 'DELETE',
        body: JSON.stringify({ session_id: sessionId }),
      }),
    onSuccess: async () => {
      toast.success('已解除会话封禁')
      setUnblockSessionId(null)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const clearSessions = useMutation({
    mutationFn: () =>
      api<RefusalGuardConfig>('/api/panel/refusal-session-blocks', {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: async () => {
      toast.success('已清空根会话封禁')
      setClearSessionsOpen(false)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (q.error) return <SettingsError error={q.error} />
  if (!q.data) return <SettingsLoading />
  const data = q.data
  const devices = data.devices ?? []
  const deviceCount = data.device_count ?? devices.length
  const sessions = data.sessions ?? []
  const sessionCount = data.session_count ?? sessions.length
  const deleting = data.items.find((item) => item.fingerprint === deleteFp)
  const unblocking = devices.find((item) => item.device_id === unblockId)
  const nowMs = Date.now()
  const needle = query.trim().toLowerCase()
  const isDeviceActive = (item: RefusalDeviceBlock) =>
    !item.expires_at || Date.parse(item.expires_at) > nowMs
  const activeDeviceCount = devices.filter(isDeviceActive).length
  const filteredDevices = devices.filter((item) => {
    if (activeOnly && !isDeviceActive(item)) return false
    if (!needle) return true
    return [
      item.identity_value,
      item.device_id,
      item.session_id,
      item.reason,
    ].some((v) =>
      String(v || '')
        .toLowerCase()
        .includes(needle)
    )
  })
  const filteredSessions = sessions.filter((item) => {
    if (!needle) return true
    return [item.session_id, item.reason, item.preview, item.model].some((v) =>
      String(v || '')
        .toLowerCase()
        .includes(needle)
    )
  })
  const filteredItems = data.items.filter((item) => {
    if (!needle) return true
    return [
      item.fingerprint,
      item.preview,
      item.error_message,
      item.model,
    ].some((v) =>
      String(v || '')
        .toLowerCase()
        .includes(needle)
    )
  })

  const recordTabs = [
    {
      id: 'devices' as const,
      label: '设备与会话封禁',
      count: deviceCount,
      icon: ShieldBan,
    },
    {
      id: 'sessions' as const,
      label: '根会话封锁',
      count: sessionCount,
      icon: ShieldOff,
    },
    {
      id: 'fingerprints' as const,
      label: '拒答指纹',
      count: data.count,
      icon: Fingerprint,
    },
  ]

  return (
    <div className='space-y-4 p-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div
          role='tablist'
          aria-label='封禁与拒答分类'
          className='flex flex-wrap items-center gap-1 rounded-lg border bg-muted/40 p-1'
        >
          {recordTabs.map(({ id, label, count, icon: Icon }) => {
            const active = tab === id
            return (
              <button
                key={id}
                type='button'
                role='tab'
                aria-selected={active}
                onClick={() => setTab(id)}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  active
                    ? 'border-select-border bg-select-surface font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-background/70 hover:text-foreground'
                )}
              >
                <Icon className='size-3.5 shrink-0' aria-hidden='true' />
                <span>{label}</span>
                <span className='py-0.2 rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground tabular-nums'>
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        <div className='flex flex-wrap items-center gap-2'>
          <div className='relative w-56 sm:w-64'>
            <Search
              aria-hidden='true'
              className='pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground'
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='搜索设备、会话、原因或正文…'
              aria-label='搜索封禁与拒答记录'
              className='h-8 pr-7 pl-8 text-xs'
            />
            {query ? (
              <button
                type='button'
                aria-label='清空搜索'
                onClick={() => setQuery('')}
                className='absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground'
              >
                <X className='size-3.5' aria-hidden='true' />
              </button>
            ) : null}
          </div>
          {tab === 'devices' ? (
            <>
              <button
                type='button'
                aria-pressed={activeOnly}
                onClick={() => setActiveOnly((v) => !v)}
                className={cn(
                  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  activeOnly
                    ? 'border-select-border bg-select-surface font-medium text-foreground'
                    : 'border-border bg-card text-muted-foreground hover:text-foreground'
                )}
              >
                仅看生效中
                <span className='font-mono text-[11px] tabular-nums opacity-75'>
                  {activeDeviceCount}
                </span>
              </button>
              <Button
                size='sm'
                variant='outline'
                className='h-8 cursor-pointer text-xs'
                disabled={!deviceCount || clearDevices.isPending}
                onClick={() => setClearDevicesOpen(true)}
              >
                全部解除
              </Button>
            </>
          ) : null}
          {tab === 'sessions' ? (
            <Button
              size='sm'
              variant='outline'
              className='h-8 cursor-pointer text-xs'
              disabled={!sessionCount || clearSessions.isPending}
              onClick={() => setClearSessionsOpen(true)}
            >
              全部解除
            </Button>
          ) : null}
          {tab === 'fingerprints' ? (
            <Button
              size='sm'
              variant='outline'
              className='h-8 cursor-pointer text-xs'
              disabled={!data.count || clear.isPending}
              onClick={() => setClearOpen(true)}
            >
              清空指纹
            </Button>
          ) : null}
        </div>
      </div>

      {tab === 'devices' ? (
        filteredDevices.length ? (
          <ul className='max-h-96 divide-y divide-[var(--hairline)] overflow-y-auto rounded-xl border'>
            {filteredDevices.map((item) => {
              const expired =
                !!item.expires_at && Date.parse(item.expires_at) <= nowMs
              const permanent = !item.expires_at
              const displayId = item.identity_value || item.device_id
              return (
                <li
                  key={item.device_id}
                  className={cn(
                    'flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 transition-colors duration-150 hover:bg-muted/35',
                    expired && 'opacity-65'
                  )}
                >
                  <div className='min-w-0 flex-1 space-y-1'>
                    <div className='flex flex-wrap items-center gap-1.5 text-xs'>
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
                          permanent
                            ? 'bg-[var(--status-bad-bg)] text-[var(--status-bad)]'
                            : expired
                              ? 'bg-[var(--status-none-bg)] text-[var(--status-none)]'
                              : 'bg-[var(--status-warn-bg)] text-[var(--status-warn)]'
                        )}
                      >
                        {permanent ? '永久封禁' : expired ? '已到期' : '冷却中'}
                      </span>
                      <span className='text-muted-foreground'>
                        {item.subject_kind === 'session' ? '会话' : '设备'}
                      </span>
                      <code className='font-mono break-all text-foreground'>
                        {displayId}
                      </code>
                      <CopyIdButton
                        value={displayId}
                        label={
                          item.subject_kind === 'session'
                            ? '会话 ID'
                            : '设备 ID'
                        }
                      />
                    </div>
                    <p className='text-xs text-muted-foreground tabular-nums'>
                      {item.reason || 'refusal_guard'} · 第 {item.violations}{' '}
                      次违规 · 命中 {item.hit_count} 次 ·{' '}
                      {item.expires_at
                        ? `${expired ? '已于' : '封禁至'} ${fmtExpiresAt(item.expires_at)}`
                        : '永久有效'}
                    </p>
                    {item.subject_kind !== 'session' && item.session_id ? (
                      <p className='text-[11px] break-all text-[var(--text-tertiary)]'>
                        触发会话：
                        <code className='font-mono text-muted-foreground'>
                          {item.session_id}
                        </code>
                      </p>
                    ) : null}
                  </div>
                  <div className='flex shrink-0 items-center gap-1.5'>
                    {item.source_request_id ? (
                      <Button
                        size='sm'
                        variant='outline'
                        className='h-7 cursor-pointer px-2.5 text-xs'
                        disabled={source.isPending}
                        onClick={() => source.mutate(item)}
                      >
                        原始日志
                      </Button>
                    ) : null}
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-7 cursor-pointer px-2.5 text-xs text-destructive hover:text-destructive'
                      onClick={() => setUnblockId(item.device_id)}
                    >
                      解除
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className='rounded-xl border'>
            <EmptyNotice
              icon={ShieldBan}
              message={
                query || activeOnly
                  ? '没有符合当前筛选条件的设备或会话封禁记录。'
                  : '当前没有设备或会话封禁记录。'
              }
            />
          </div>
        )
      ) : null}

      {tab === 'sessions' ? (
        filteredSessions.length ? (
          <ul className='max-h-96 divide-y divide-[var(--hairline)] overflow-y-auto rounded-xl border'>
            {filteredSessions.map((item) => (
              <li
                key={item.session_id}
                className='flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 transition-colors duration-150 hover:bg-muted/35'
              >
                <div className='min-w-0 flex-1 space-y-1'>
                  <div className='flex flex-wrap items-center gap-1.5 text-xs'>
                    <span className='rounded bg-[var(--status-bad-bg)] px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-[var(--status-bad)]'>
                      永久封锁
                    </span>
                    <code className='font-mono break-all text-foreground'>
                      {item.session_id}
                    </code>
                    <CopyIdButton value={item.session_id} label='会话 ID' />
                  </div>
                  {item.preview ? (
                    <p
                      className='line-clamp-2 text-xs text-muted-foreground'
                      title={item.preview}
                    >
                      {item.preview}
                    </p>
                  ) : null}
                  <p className='text-xs text-muted-foreground tabular-nums'>
                    {item.reason || 'upstream_refusal'}
                    {item.model ? ` · ${item.model}` : ''} · 命中{' '}
                    {item.hit_count} 次 · {fmtExpiresAt(item.last_seen_at)}
                  </p>
                </div>
                <div className='flex shrink-0 items-center gap-1.5'>
                  {item.source_request_id ? (
                    <Button
                      size='sm'
                      variant='outline'
                      className='h-7 cursor-pointer px-2.5 text-xs'
                      disabled={source.isPending}
                      onClick={() => source.mutate(item)}
                    >
                      原始日志
                    </Button>
                  ) : null}
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-7 cursor-pointer px-2.5 text-xs text-destructive hover:text-destructive'
                    onClick={() => setUnblockSessionId(item.session_id)}
                  >
                    解除
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className='rounded-xl border'>
            <EmptyNotice
              icon={ShieldOff}
              message={
                query
                  ? '没有匹配该关键字的封禁会话。'
                  : '当前没有被永久封锁的根会话。'
              }
            />
          </div>
        )
      ) : null}

      {tab === 'fingerprints' ? (
        filteredItems.length ? (
          <ul className='max-h-96 divide-y divide-[var(--hairline)] overflow-y-auto rounded-xl border'>
            {filteredItems.map((item) => (
              <li
                key={item.fingerprint}
                className='flex items-center justify-between gap-2 px-3.5 py-2.5 transition-colors duration-150 hover:bg-muted/35'
              >
                <div className='min-w-0 flex-1 space-y-1'>
                  <p
                    className='line-clamp-2 text-sm break-words'
                    title={item.preview || undefined}
                  >
                    {item.preview || '（无预览）'}
                  </p>
                  {item.error_message ? (
                    <p
                      className='line-clamp-2 text-xs break-words text-muted-foreground'
                      title={item.error_message}
                    >
                      {item.error_message}
                    </p>
                  ) : null}
                  <p className='truncate font-mono text-xs text-[var(--text-tertiary)] tabular-nums'>
                    {item.model || '—'} · {shortFp(item.fingerprint)} · 命中{' '}
                    {item.hit_count} 次 · {fmtExpiresAt(item.last_seen_at)}
                  </p>
                </div>
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-7 shrink-0 cursor-pointer px-2.5 text-xs text-destructive hover:text-destructive'
                  onClick={() => setDeleteFp(item.fingerprint)}
                >
                  删除
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <div className='rounded-xl border'>
            <EmptyNotice
              icon={Fingerprint}
              message={
                query ? '没有匹配的拒答指纹。' : '还没有上游拒答指纹记录。'
              }
            />
          </div>
        )
      ) : null}
      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title='清空拒答缓存'
        desc='清空后同样请求会再次 hop 上游。已封禁的 device 不会一起解除。'
        confirmText='清空'
        cancelBtnText='取消'
        destructive
        isLoading={clear.isPending}
        handleConfirm={() => clear.mutate()}
      />
      <ConfirmDialog
        open={clearDevicesOpen}
        onOpenChange={setClearDevicesOpen}
        title='解除全部 device 封禁'
        desc='解除后这些 device 可以再次请求。拒答指纹还在，相同或足够近似的正文仍会被拦。'
        confirmText='全部解除'
        cancelBtnText='取消'
        destructive
        isLoading={clearDevices.isPending}
        handleConfirm={() => clearDevices.mutate()}
      />
      <ConfirmDialog
        open={!!deleteFp}
        onOpenChange={(open) => {
          if (!open) setDeleteFp(null)
        }}
        title='删除这条指纹'
        desc={`删除后「${deleting?.preview || shortFp(deleteFp || '')}」会再次打上游。`}
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        isLoading={remove.isPending}
        handleConfirm={() => {
          if (deleteFp) remove.mutate(deleteFp)
        }}
      />
      <ConfirmDialog
        open={!!unblockId}
        onOpenChange={(open) => {
          if (!open) setUnblockId(null)
        }}
        title={
          unblocking?.subject_kind === 'session'
            ? '解除这个会话封禁'
            : '解除这个设备封禁'
        }
        desc={`解除后 ${unblocking?.identity_value || unblockId || ''} 的新请求不再因此封禁记录被拦。`}
        confirmText='解除'
        cancelBtnText='取消'
        destructive
        isLoading={unblock.isPending}
        handleConfirm={() => {
          if (unblockId) unblock.mutate(unblockId)
        }}
      />
      <ConfirmDialog
        open={!!unblockSessionId}
        onOpenChange={(open) => {
          if (!open) setUnblockSessionId(null)
        }}
        title='解除这个根会话封禁'
        desc={`解除后会话 ${unblockSessionId || ''}（及其子 Agent）可再次转发。`}
        confirmText='解除'
        cancelBtnText='取消'
        destructive
        isLoading={unblockSession.isPending}
        handleConfirm={() => {
          if (unblockSessionId) unblockSession.mutate(unblockSessionId)
        }}
      />
      <ConfirmDialog
        open={clearSessionsOpen}
        onOpenChange={setClearSessionsOpen}
        title='解除全部根会话封禁'
        desc='解除后所有被永久封锁的会话可以再次转发。'
        confirmText='全部解除'
        cancelBtnText='取消'
        destructive
        isLoading={clearSessions.isPending}
        handleConfirm={() => clearSessions.mutate()}
      />
    </div>
  )
}
