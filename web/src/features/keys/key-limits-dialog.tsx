import { useEffect, useState, type ReactNode } from 'react'
import type { ApiEndpoint } from '@/types/panel-api-endpoints'
import type { ApiKeyItem } from '@/types/panel-keys'
import type { PoolBindingMode, SchedulerPool } from '@/types/panel-pools'
import type { PanelUser } from '@/types/panel-users'
import type { Vm } from '@/types/panel-vm'
import { slotDisplayTitle, slotRawEmail } from '@/lib/vm-kind'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { GeminiEnvironment } from '@/features/import/gemini-environments'
import {
  PromptModeBadge,
  ProviderScopeBadge,
} from '@/features/pools/pool-badges'
import {
  isPromptLockedProvider,
  PROVIDER_SCOPE_LABELS,
  SYSTEM_PROMPT_MODE_LABELS,
} from '@/features/pools/pool-rules'
import type { KeyGroupType, KeyLimitsDraft } from './key-payload'
import { keyVmSelection, vmsInGroup } from './key-vm-selection'

const CONC = [0, 1, 2, 4, 8, 16, 20, 32, 64]
const QUOTA_CREATE = [0, 1000, 5000, 10000, 50000]
const QUOTA_EDIT = [0, 1000, 5000, 10000, 50000, 100000]
const RPM_CREATE = [0, 30, 60, 120, 600]
const RPM_EDIT = [0, 30, 60, 120, 300, 600]
const DAYS = [0, 7, 30, 90, 365]

export type { KeyLimitsDraft } from './key-payload'

function withCurrent(opts: number[], current: number): number[] {
  if (opts.includes(current)) return opts
  return [...opts, current].sort((a, b) => a - b)
}

function optLabel(kind: 'conc' | 'quota' | 'rpm' | 'days', n: number): string {
  if (n === 0) {
    if (kind === 'days') return '永久'
    return '不限'
  }
  if (kind === 'quota') {
    if (n >= 1000) return `${n / 1000}k`
    return String(n)
  }
  if (kind === 'days') return n === 365 ? '一年' : `${n} 天`
  return String(n)
}

function poolOptionMeta(pool: SchedulerPool): string {
  const provider =
    PROVIDER_SCOPE_LABELS[pool.provider_scope] || pool.provider_scope
  const prompt = isPromptLockedProvider(pool.provider_scope)
    ? '透传'
    : SYSTEM_PROMPT_MODE_LABELS[pool.system_prompt_mode] ||
      pool.system_prompt_mode
  return `${provider} · ${prompt}${pool.enabled ? '' : ' · 已停用'}`
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='space-y-1'>
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function NumSelect({
  value,
  options,
  onChange,
  kind,
}: {
  value: number
  options: number[]
  onChange: (n: number) => void
  kind: 'conc' | 'quota' | 'rpm' | 'days'
}) {
  const opts = withCurrent(options, value)
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {opts.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {optLabel(kind, n)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function KeyLimitsDialog({
  mode,
  open,
  onOpenChange,
  initial,
  pending,
  onSubmit,
  vms = [],
  vmsReady = false,
  vmsError = false,
  pools,
  channels,
  channelsLoading,
  channelsError,
  users,
  geminiEnvs,
}: {
  mode: 'create' | 'edit'
  open: boolean
  onOpenChange: (open: boolean) => void
  initial?: ApiKeyItem | null
  pending: boolean
  onSubmit: (draft: KeyLimitsDraft) => void
  vms?: Vm[]
  vmsReady?: boolean
  vmsError?: boolean
  pools?: SchedulerPool[]
  channels?: ApiEndpoint[]
  channelsLoading?: boolean
  channelsError?: boolean
  users?: PanelUser[]
  geminiEnvs?: GeminiEnvironment[]
}) {
  const [draft, setDraft] = useState<KeyLimitsDraft>(blankDraft())
  const isAdmin = pools !== undefined

  useEffect(() => {
    if (!open) return
    if (mode === 'edit' && initial) {
      const defPool = initial.default_pool_id || initial.vm_pool_id || ''
      const allowedPools = [
        ...new Set([
          ...(initial.allowed_pool_ids || []),
          ...(defPool ? [defPool] : []),
        ]),
      ]
      const bindingMode: PoolBindingMode =
        initial.pool_binding_mode === 'strict_pool' ||
        (initial.pool_binding_mode == null && Boolean(defPool))
          ? 'strict_pool'
          : 'legacy_scope'
      const group = groupOf(initial.group_type)
      setDraft({
        name: initial.name || '',
        category:
          initial.category === 'api'
            ? 'api'
            : initial.category === 'all'
              ? 'all'
              : 'oauth',
        api_endpoint_id: initial.api_endpoint_id || '',
        permission_tier: initial.permission_tier || 'platform',
        owner_id: initial.owner_id ?? '',
        allowed_endpoints: initial.allowed_endpoints || [],
        allowed_gemini_envs: initial.allowed_gemini_envs || [],
        ...(isAdmin
          ? {
              pool_binding_mode: bindingMode,
              default_pool_id: defPool,
              allowed_pool_ids: allowedPools,
              vm_pool_id: defPool,
            }
          : {}),
        max_concurrency: Number(initial.max_concurrency ?? 20),
        quota_requests: Number(initial.quota_requests ?? 0),
        quota_usd: Number(initial.quota_usd ?? 0),
        rpm: Number(initial.rpm ?? 0),
        expires_in_days: 0,
        group_type: group,
        allowed_vms: group === 'all' ? [] : initial.allowed_vms || [],
        allowed_models: (initial.allowed_models || []).join(', '),
      })
      return
    }
    setDraft(blankDraft(isAdmin))
  }, [open, mode, initial, isAdmin])

  const quotaOpts = mode === 'edit' ? QUOTA_EDIT : QUOTA_CREATE
  const rpmOpts = mode === 'edit' ? RPM_EDIT : RPM_CREATE
  const isStrictPool = isAdmin && draft.pool_binding_mode === 'strict_pool'
  const isApi = draft.category === 'api'
  const enabledChannels = (channels || []).filter(
    (channel) => !channel.disabled
  )
  const selectedChannel = enabledChannels.find(
    (channel) => channel.id === draft.api_endpoint_id
  )
  const legacyApi =
    mode === 'edit' && initial?.category === 'api' && !initial.api_endpoint_id
  const unchangedChannel =
    !!draft.api_endpoint_id &&
    initial?.api_endpoint_id === draft.api_endpoint_id
  const listed = vmsInGroup(vms || [], draft.group_type)
  const selection = keyVmSelection(draft, vms, vmsReady)
  const effectiveAllowedPools = [
    ...new Set([
      ...(draft.allowed_pool_ids || []),
      ...(draft.default_pool_id ? [draft.default_pool_id] : []),
    ]),
  ]
  const scopeBlocked = isStrictPool
    ? effectiveAllowedPools.length === 0
    : isApi
      ? !selectedChannel &&
        !unchangedChannel &&
        !(legacyApi && !draft.api_endpoint_id)
      : draft.group_type !== 'all' &&
        draft.group_type !== 'gemini' &&
        selection.blocked

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            {mode === 'create'
              ? '生成密钥'
              : `编辑 · ${initial?.name || initial?.id || ''}`}
          </DialogTitle>
        </DialogHeader>
        {mode === 'edit' && initial ? (
          <p className='text-xs text-muted-foreground'>
            <span className='font-mono'>
              {initial.key_prefix || initial.prefix || initial.id}
            </span>
            {initial.inflight ? ` · 进行中 ${initial.inflight}` : ''}
          </p>
        ) : null}

        <div className='min-h-0 flex-1 space-y-4 overflow-y-auto pr-1'>
          <div className='grid gap-3 sm:grid-cols-2'>
            {mode === 'create' ? (
              <Field label='名称'>
                <Input
                  value={draft.name}
                  placeholder='client-a'
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, name: e.target.value }))
                  }
                />
              </Field>
            ) : null}
            {isAdmin ? (
              <Field label='分类'>
                <Select
                  value={draft.category}
                  onValueChange={(v) =>
                    setDraft((d) => ({
                      ...d,
                      category:
                        v === 'api' ? 'api' : v === 'all' ? 'all' : 'oauth',
                      api_endpoint_id:
                        v === 'api' || v === 'all' ? d.api_endpoint_id : '',
                      group_type:
                        v === 'api' && d.group_type === 'gemini'
                          ? 'all'
                          : d.group_type,
                      allowed_vms: v === 'api' ? [] : d.allowed_vms,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='oauth'>OAuth 槽位</SelectItem>
                    <SelectItem value='api'>API 直连</SelectItem>
                    <SelectItem value='all'>全部（OAuth + API）</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <Field label='并发'>
              <NumSelect
                kind='conc'
                value={draft.max_concurrency}
                options={CONC}
                onChange={(n) =>
                  setDraft((d) => ({ ...d, max_concurrency: n }))
                }
              />
            </Field>
            <Field label='请求额度'>
              <NumSelect
                kind='quota'
                value={draft.quota_requests}
                options={quotaOpts}
                onChange={(n) => setDraft((d) => ({ ...d, quota_requests: n }))}
              />
            </Field>
            <Field label='USD 额度'>
              <Input
                type='number'
                min={0}
                step='0.01'
                value={draft.quota_usd}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    quota_usd: Number(e.target.value),
                  }))
                }
              />
            </Field>
            <Field label='RPM'>
              <NumSelect
                kind='rpm'
                value={draft.rpm}
                options={rpmOpts}
                onChange={(n) => setDraft((d) => ({ ...d, rpm: n }))}
              />
            </Field>
            {mode === 'create' ? (
              <Field label='有效期'>
                <NumSelect
                  kind='days'
                  value={draft.expires_in_days}
                  options={DAYS}
                  onChange={(n) =>
                    setDraft((d) => ({ ...d, expires_in_days: n }))
                  }
                />
              </Field>
            ) : null}
          </div>

          {/* 管理员：统一分组池绑定（取代废弃的虚拟 group_type='pool'） */}
          {isAdmin ? (
            <section className='space-y-3 rounded-lg border bg-muted/20 p-3'>
              <div className='grid gap-3 sm:grid-cols-2'>
                <Field label='分组池绑定模式（pool_binding_mode）'>
                  <Select
                    value={draft.pool_binding_mode || 'legacy_scope'}
                    onValueChange={(v) => {
                      const nextMode = v as PoolBindingMode
                      setDraft((d) => ({
                        ...d,
                        pool_binding_mode: nextMode,
                        ...(nextMode === 'strict_pool'
                          ? { group_type: 'all', allowed_vms: [] }
                          : {}),
                      }))
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='strict_pool'>
                        strict_pool · 严格分组池（Fail-Closed）
                      </SelectItem>
                      <SelectItem value='legacy_scope'>
                        legacy_scope · 兼容作用域
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>

                <Field label='默认分组池（default_pool_id）'>
                  <Select
                    value={draft.default_pool_id || '__none__'}
                    onValueChange={(id) => {
                      const nextId = id === '__none__' ? '' : id
                      setDraft((d) => {
                        const allowed = new Set(d.allowed_pool_ids || [])
                        if (nextId) allowed.add(nextId)
                        return {
                          ...d,
                          default_pool_id: nextId,
                          vm_pool_id: nextId,
                          allowed_pool_ids: [...allowed],
                        }
                      })
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder='未指定默认池' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='__none__'>不指定默认池</SelectItem>
                      {(pools || []).map((pool) => (
                        <SelectItem key={pool.id} value={pool.id}>
                          {pool.name} · {poolOptionMeta(pool)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <div className='space-y-1.5'>
                <Label>允许访问的分组池（allowed_pool_ids）</Label>
                {(pools || []).length === 0 ? (
                  <p className='text-xs text-muted-foreground'>
                    暂无分组池，请先在「分组池」页面创建。
                  </p>
                ) : (
                  <div className='max-h-40 space-y-1.5 overflow-y-auto rounded-md border bg-background p-2'>
                    {(pools || []).map((pool) => {
                      const checked = effectiveAllowedPools.includes(pool.id)
                      const isDef = draft.default_pool_id === pool.id
                      return (
                        <label
                          key={pool.id}
                          className='flex cursor-pointer flex-wrap items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50'
                        >
                          <input
                            type='checkbox'
                            className='size-3.5'
                            checked={checked}
                            onChange={(e) => {
                              const on = e.target.checked
                              setDraft((d) => {
                                const current = new Set(
                                  d.allowed_pool_ids || []
                                )
                                if (on) current.add(pool.id)
                                else current.delete(pool.id)
                                const nextAllowed = [...current]
                                const nextDefault =
                                  !on && d.default_pool_id === pool.id
                                    ? nextAllowed[0] || ''
                                    : d.default_pool_id || (on ? pool.id : '')
                                return {
                                  ...d,
                                  default_pool_id: nextDefault,
                                  vm_pool_id: nextDefault,
                                  allowed_pool_ids: nextAllowed,
                                }
                              })
                            }}
                          />
                          <span className='font-medium'>{pool.name}</span>
                          <ProviderScopeBadge
                            scope={pool.provider_scope}
                            className='px-1.5 py-0 text-[10px]'
                          />
                          <PromptModeBadge
                            providerScope={pool.provider_scope}
                            mode={pool.system_prompt_mode}
                            compact
                            className='px-1.5 py-0 text-[10px]'
                          />
                          {isDef ? (
                            <Badge
                              variant='secondary'
                              className='px-1 py-0 text-[10px]'
                            >
                              默认
                            </Badge>
                          ) : null}
                          {!pool.enabled ? (
                            <span className='text-[10px] text-destructive'>
                              已停用
                            </span>
                          ) : null}
                        </label>
                      )
                    })}
                  </div>
                )}
                {isStrictPool && effectiveAllowedPools.length === 0 ? (
                  <p role='alert' className='text-xs text-destructive'>
                    严格分组池模式下至少需勾选 1 个分组池（Fail-Closed，空池返
                    403）。
                  </p>
                ) : (
                  <p className='text-[11px] text-muted-foreground'>
                    请求头 <code className='font-mono'>X-VM2API-Pool</code>{' '}
                    仅在已勾选的允许池内生效，越界或目标池停用/无启用成员将直接返回
                    403。
                  </p>
                )}
              </div>
            </section>
          ) : null}

          {/* 管理员：权限层级、属主、允许 API 渠道与允许 Gemini 环境 */}
          {isAdmin ? (
            <section className='space-y-3 rounded-lg border p-3'>
              <div className='grid gap-3 sm:grid-cols-2'>
                <Field label='权限层级（permission_tier）'>
                  <Select
                    value={draft.permission_tier || 'platform'}
                    onValueChange={(v) =>
                      setDraft((d) => ({
                        ...d,
                        permission_tier: v as
                          'platform' | 'tenant' | 'resource',
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='platform'>
                        platform · 平台级
                      </SelectItem>
                      <SelectItem value='tenant'>tenant · 租户级</SelectItem>
                      <SelectItem value='resource'>
                        resource · 资源级
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label='归属租户（owner_id）'>
                  {users && users.length > 0 ? (
                    <Select
                      value={draft.owner_id || '__none__'}
                      onValueChange={(v) =>
                        setDraft((d) => ({
                          ...d,
                          owner_id: v === '__none__' ? '' : v,
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder='无（平台归属）' />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='__none__'>无（平台归属）</SelectItem>
                        {users.map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.username} ({u.role}) · {u.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      value={draft.owner_id || ''}
                      placeholder='留空为平台归属，或填写 user_id'
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, owner_id: e.target.value }))
                      }
                    />
                  )}
                </Field>
              </div>

              {channels && channels.length > 0 ? (
                <div className='space-y-1'>
                  <Label>
                    允许的 API 渠道（allowed_endpoints · 留空按池/默认）
                  </Label>
                  <div className='flex max-h-24 flex-wrap gap-x-3 gap-y-1 overflow-y-auto rounded-md border p-2'>
                    {channels.map((ep) => {
                      const checked = (draft.allowed_endpoints || []).includes(
                        ep.id
                      )
                      return (
                        <label
                          key={ep.id}
                          className='flex cursor-pointer items-center gap-1.5 text-xs'
                        >
                          <input
                            type='checkbox'
                            className='size-3.5'
                            checked={checked}
                            onChange={(e) => {
                              const on = e.target.checked
                              setDraft((d) => ({
                                ...d,
                                allowed_endpoints: on
                                  ? [...(d.allowed_endpoints || []), ep.id]
                                  : (d.allowed_endpoints || []).filter(
                                      (id) => id !== ep.id
                                    ),
                              }))
                            }}
                          />
                          <span>
                            {ep.name || ep.id} (
                            {ep.protocol || ep.kind || 'api'})
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              ) : null}

              {geminiEnvs && geminiEnvs.length > 0 ? (
                <div className='space-y-1'>
                  <Label>
                    允许的 Gemini 环境（allowed_gemini_envs · 留空按池/默认）
                  </Label>
                  <div className='flex max-h-24 flex-wrap gap-x-3 gap-y-1 overflow-y-auto rounded-md border p-2'>
                    {geminiEnvs.map((env) => {
                      const checked = (
                        draft.allowed_gemini_envs || []
                      ).includes(env.id)
                      return (
                        <label
                          key={env.id}
                          className='flex cursor-pointer items-center gap-1.5 text-xs'
                        >
                          <input
                            type='checkbox'
                            className='size-3.5'
                            checked={checked}
                            onChange={(e) => {
                              const on = e.target.checked
                              setDraft((d) => ({
                                ...d,
                                allowed_gemini_envs: on
                                  ? [...(d.allowed_gemini_envs || []), env.id]
                                  : (d.allowed_gemini_envs || []).filter(
                                      (id) => id !== env.id
                                    ),
                              }))
                            }}
                          />
                          <span>
                            {env.name || env.id}
                            {env.account?.email
                              ? ` · ${env.account.email}`
                              : ''}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {/* 兼容旧作用域（非 strict_pool 时展示） */}
          {!isStrictPool ? (
            <div className='grid gap-3 sm:grid-cols-2'>
              {isApi ? (
                <div className='space-y-1 sm:col-span-2'>
                  <Field label='API 渠道'>
                    <Select
                      value={
                        draft.api_endpoint_id || (legacyApi ? '__legacy__' : '')
                      }
                      onValueChange={(id) =>
                        setDraft((d) => ({
                          ...d,
                          api_endpoint_id: id === '__legacy__' ? '' : id,
                          group_type:
                            id === '__legacy__'
                              ? groupOf(initial?.group_type)
                              : 'all',
                        }))
                      }
                    >
                      <SelectTrigger className='w-full' aria-label='API 渠道'>
                        <SelectValue placeholder='选择已启用的渠道' />
                      </SelectTrigger>
                      <SelectContent>
                        {legacyApi ? (
                          <SelectItem value='__legacy__'>
                            沿用原协议筛选（未绑定）
                          </SelectItem>
                        ) : null}
                        {unchangedChannel && !selectedChannel ? (
                          <SelectItem value={draft.api_endpoint_id!}>
                            原渠道不可用 · {draft.api_endpoint_id}
                          </SelectItem>
                        ) : null}
                        {enabledChannels.map((channel) => (
                          <SelectItem key={channel.id} value={channel.id}>
                            {channel.name || channel.id} · {channel.protocol} ·{' '}
                            {channel.base_url}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <p className='text-xs text-muted-foreground'>
                    {selectedChannel
                      ? selectedChannel.models?.length
                        ? selectedChannel.protocol === 'gemini'
                          ? `已保存 ${selectedChannel.models.length} 个模型；默认走原生 Gemini（/v1beta 与 /v1），同时支持 OpenAI / Anthropic 多协议调用。`
                          : `已保存 ${selectedChannel.models.length} 个模型；此密钥只调用所选渠道。`
                        : '此渠道尚未保存模型。请先到 API 页面获取模型。'
                      : channelsError
                        ? '无法加载 API 渠道。请重试。'
                        : channelsLoading
                          ? '正在加载 API 渠道…'
                          : unchangedChannel
                            ? '原渠道已停用或删除，调用不会切换到其他渠道。'
                            : !enabledChannels.length
                              ? '暂无已启用的 API 渠道。请先配置渠道。'
                              : '选择渠道后，此密钥只调用该渠道。'}
                  </p>
                </div>
              ) : null}

              {!isApi || (legacyApi && !draft.api_endpoint_id) ? (
                <Field label={isApi ? 'API 协议' : '平台 / 分组'}>
                  <Select
                    value={draft.group_type}
                    onValueChange={(v) => {
                      const group = groupOf(v)
                      const keep = new Set(
                        vmsInGroup(vms || [], group).map((vm) => vm.id)
                      )
                      setDraft((d) => ({
                        ...d,
                        group_type: group,
                        allowed_vms:
                          isApi || group === 'all' || group === 'gemini'
                            ? []
                            : d.allowed_vms.filter((id) => keep.has(id)),
                      }))
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='all'>
                        {isApi ? 'all · 全部协议' : 'all · 全局可调度'}
                      </SelectItem>
                      <SelectItem value='anthropic'>
                        {isApi ? 'anthropic · Anthropic 协议' : 'anthropic'}
                      </SelectItem>
                      <SelectItem value='openai'>
                        {isApi ? 'openai · OpenAI 协议' : 'openai'}
                      </SelectItem>
                      {!isApi && isAdmin ? (
                        <SelectItem value='gemini'>
                          Gemini · CRAGAnti
                        </SelectItem>
                      ) : null}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}

              {!isApi &&
                (draft.group_type === 'gemini' ? (
                  <p className='text-xs text-muted-foreground sm:col-span-2'>
                    仅用于 Gemini 宿主机账号，不使用 VM 或直连渠道。默认支持原生
                    Gemini（/v1beta 与 /v1），同时兼容 OpenAI / Anthropic 协议。
                  </p>
                ) : draft.group_type === 'all' ? (
                  <p className='text-xs text-muted-foreground sm:col-span-2'>
                    all 表示不按单台 VM
                    限制；如需按分组池隔离，请将上方「分组池绑定模式」切换为
                    strict_pool。
                  </p>
                ) : (
                  <div className='sm:col-span-2'>
                    <Field label='可用 VM'>
                      {!vmsReady ? (
                        <p
                          role='status'
                          className='text-xs text-muted-foreground'
                        >
                          {vmsError
                            ? '无法加载可用 VM，请刷新后重试。保存已暂停。'
                            : '正在核对可用 VM…'}
                        </p>
                      ) : selection.removed.length > 0 ? (
                        <p
                          role='status'
                          className='text-xs text-muted-foreground'
                        >
                          已排除当前不可用的旧选择：
                          {selection.removed.join(', ')}。请确认可用 VM 后保存。
                        </p>
                      ) : null}
                      <div className='max-h-40 space-y-1 overflow-y-auto rounded-md border p-2'>
                        {listed.length === 0 ? (
                          <p className='text-xs text-muted-foreground'>
                            该分组下没有 VM
                          </p>
                        ) : (
                          listed.map((vm) => (
                            <label
                              key={vm.id}
                              className='flex items-center gap-2 text-sm'
                            >
                              <input
                                type='checkbox'
                                className='size-3.5'
                                checked={selection.draft.allowed_vms.includes(
                                  vm.id
                                )}
                                disabled={!vmsReady}
                                onChange={(e) => {
                                  const on = e.target.checked
                                  setDraft((d) => ({
                                    ...d,
                                    allowed_vms: on
                                      ? [...d.allowed_vms, vm.id]
                                      : d.allowed_vms.filter(
                                          (id) => id !== vm.id
                                        ),
                                  }))
                                }}
                              />
                              <span
                                className='truncate'
                                title={slotRawEmail(vm) || undefined}
                              >
                                {slotDisplayTitle(vm)}
                              </span>
                              <span className='font-mono text-xs text-muted-foreground'>
                                {vm.id}
                              </span>
                            </label>
                          ))
                        )}
                      </div>
                    </Field>
                  </div>
                ))}
            </div>
          ) : null}

          <div>
            <Field label='允许的模型'>
              <Input
                value={draft.allowed_models}
                placeholder='留空不限，例如 claude-sonnet-5, gpt-6-sol'
                onChange={(e) =>
                  setDraft((d) => ({ ...d, allowed_models: e.target.value }))
                }
              />
            </Field>
            <p className='mt-1 text-xs text-muted-foreground'>
              按客户端请求里写的模型名匹配（不分大小写，映射前，Claude Code 的
              [1m] 后缀自动忽略），逗号分隔；名单外的模型直接返回 400。
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            取消
          </Button>
          <Button
            onClick={() => {
              if (!scopeBlocked) onSubmit(selection.draft)
            }}
            disabled={
              pending ||
              (mode === 'create' && !draft.name.trim()) ||
              scopeBlocked
            }
            loading={pending}
          >
            {mode === 'create' ? '生成' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function blankDraft(isAdmin = false): KeyLimitsDraft {
  return {
    name: '',
    category: 'oauth',
    api_endpoint_id: '',
    ...(isAdmin
      ? {
          permission_tier: 'platform' as const,
          owner_id: '',
          allowed_endpoints: [],
          allowed_gemini_envs: [],
          pool_binding_mode: 'legacy_scope' as const,
          default_pool_id: '',
          allowed_pool_ids: [],
        }
      : {}),
    max_concurrency: 20,
    quota_requests: 0,
    quota_usd: 0,
    rpm: 0,
    expires_in_days: 30,
    group_type: 'all',
    allowed_vms: [],
    allowed_models: '',
  }
}

function groupOf(value: string | undefined): KeyGroupType {
  if (value === 'anthropic' || value === 'openai' || value === 'gemini')
    return value
  return 'all'
}
