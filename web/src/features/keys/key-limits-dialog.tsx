import { useEffect, useState, type ReactNode } from 'react'
import type { ApiEndpoint } from '@/types/panel-api-endpoints'
import type { ApiKeyItem, VmPool } from '@/types/panel-keys'
import type { Vm } from '@/types/panel-vm'
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
  pools?: VmPool[]
  channels?: ApiEndpoint[]
  channelsLoading?: boolean
  channelsError?: boolean
}) {
  const [draft, setDraft] = useState<KeyLimitsDraft>(blankDraft())

  useEffect(() => {
    if (!open) return
    if (mode === 'edit' && initial) {
      const pooled = !!pools && !!initial.vm_pool_id
      const group = pooled ? 'pool' : groupOf(initial.group_type)
      setDraft({
        name: initial.name || '',
        category: initial.category === 'api' ? 'api' : 'oauth',
        api_endpoint_id: initial.api_endpoint_id || '',
        max_concurrency: Number(initial.max_concurrency ?? 20),
        quota_requests: Number(initial.quota_requests ?? 0),
        quota_usd: Number(initial.quota_usd ?? 0),
        rpm: Number(initial.rpm ?? 0),
        expires_in_days: 0,
        group_type: group,
        allowed_vms:
          group === 'all' || group === 'pool' ? [] : initial.allowed_vms || [],
        ...(pools ? { vm_pool_id: initial.vm_pool_id || '' } : {}),
        allowed_models: (initial.allowed_models || []).join(', '),
      })
      return
    }
    setDraft(blankDraft())
    // pools is only the option list. Reloading it must not wipe an open form.
  }, [open, mode, initial])

  const quotaOpts = mode === 'edit' ? QUOTA_EDIT : QUOTA_CREATE
  const rpmOpts = mode === 'edit' ? RPM_EDIT : RPM_CREATE
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
  const scopeBlocked = isApi
    ? !selectedChannel &&
      !unchangedChannel &&
      !(legacyApi && !draft.api_endpoint_id)
    : draft.group_type === 'pool'
      ? !draft.vm_pool_id
      : draft.group_type !== 'all' &&
        draft.group_type !== 'gemini' &&
        selection.blocked

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
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
          {pools ? (
            <Field label='分类'>
              <Select
                value={draft.category}
                onValueChange={(v) =>
                  setDraft((d) => ({
                    ...d,
                    category: v === 'api' ? 'api' : 'oauth',
                    api_endpoint_id: v === 'api' ? d.api_endpoint_id : '',
                    group_type:
                      v === 'api' &&
                      (d.group_type === 'pool' || d.group_type === 'gemini')
                        ? 'all'
                        : d.group_type,
                    allowed_vms: v === 'api' ? [] : d.allowed_vms,
                    vm_pool_id: v === 'api' ? '' : d.vm_pool_id,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='oauth'>OAuth 槽位</SelectItem>
                  <SelectItem value='api'>API 直连</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <Field label='并发'>
            <NumSelect
              kind='conc'
              value={draft.max_concurrency}
              options={CONC}
              onChange={(n) => setDraft((d) => ({ ...d, max_concurrency: n }))}
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
                setDraft((d) => ({ ...d, quota_usd: Number(e.target.value) }))
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
                  const group = v === 'pool' ? 'pool' : groupOf(v)
                  const keep = new Set(
                    vmsInGroup(vms || [], group).map((vm) => vm.id)
                  )
                  setDraft((d) => ({
                    ...d,
                    group_type: group,
                    allowed_vms:
                      isApi ||
                      group === 'all' ||
                      group === 'pool' ||
                      group === 'gemini'
                        ? []
                        : d.allowed_vms.filter((id) => keep.has(id)),
                    ...(pools
                      ? {
                          vm_pool_id:
                            !isApi && group === 'pool'
                              ? d.vm_pool_id || ''
                              : '',
                        }
                      : {}),
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
                  {!isApi && pools ? (
                    <SelectItem value='pool'>账号池</SelectItem>
                  ) : null}
                  <SelectItem value='anthropic'>
                    {isApi ? 'anthropic · Anthropic 协议' : 'anthropic'}
                  </SelectItem>
                  <SelectItem value='openai'>
                    {isApi ? 'openai · OpenAI 协议' : 'openai'}
                  </SelectItem>
                  {!isApi && pools ? (
                    <SelectItem value='gemini'>Gemini · CRAGAnti</SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {!isApi &&
            (draft.group_type === 'pool' ? (
              <Field label='账号池'>
                <Select
                  value={draft.vm_pool_id || ''}
                  onValueChange={(id) =>
                    setDraft((d) => ({ ...d, vm_pool_id: id }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder='选择账号池' />
                  </SelectTrigger>
                  <SelectContent>
                    {(pools || []).map((pool) => (
                      <SelectItem key={pool.id} value={pool.id}>
                        {pool.name}
                        {pool.enabled ? '' : ' · 停用'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : draft.group_type === 'gemini' ? (
              <p className='text-xs text-muted-foreground sm:col-span-2'>
                仅用于 Gemini 宿主机账号，不使用 VM 或直连渠道。默认支持原生
                Gemini（/v1beta 与 /v1），同时兼容 OpenAI Chat / Responses 与
                Anthropic Messages 协议。
              </p>
            ) : draft.group_type === 'all' ? (
              <p className='text-xs text-muted-foreground sm:col-span-2'>
                all 是最高权限，不再选择 VM。
              </p>
            ) : (
              <div className='sm:col-span-2'>
                <Field label='可用 VM'>
                  {!vmsReady ? (
                    <p role='status' className='text-xs text-muted-foreground'>
                      {vmsError
                        ? '无法加载可用 VM，请刷新后重试。保存已暂停。'
                        : '正在核对可用 VM…'}
                    </p>
                  ) : selection.removed.length > 0 ? (
                    <p role='status' className='text-xs text-muted-foreground'>
                      已排除当前不可用的旧选择：{selection.removed.join(', ')}。
                      请确认可用 VM 后保存。
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
                                  : d.allowed_vms.filter((id) => id !== vm.id),
                              }))
                            }}
                          />
                          <span className='truncate'>
                            {vm.name || vm.email || vm.id}
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
          <div className='sm:col-span-2'>
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

function blankDraft(): KeyLimitsDraft {
  return {
    name: '',
    category: 'oauth',
    api_endpoint_id: '',
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
