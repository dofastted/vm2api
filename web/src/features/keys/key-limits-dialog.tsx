import { useEffect, useState, type ReactNode } from 'react'
import type { ApiKeyItem, VmPool } from '@/types/panel-keys'
import type { Vm } from '@/types/panel-vm'
import { isCodexVm } from '@/lib/vm-kind'
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
  pools,
}: {
  mode: 'create' | 'edit'
  open: boolean
  onOpenChange: (open: boolean) => void
  initial?: ApiKeyItem | null
  pending: boolean
  onSubmit: (draft: KeyLimitsDraft) => void
  vms?: Vm[]
  pools?: VmPool[]
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
        max_concurrency: Number(initial.max_concurrency ?? 20),
        quota_requests: Number(initial.quota_requests ?? 0),
        quota_usd: Number(initial.quota_usd ?? 0),
        rpm: Number(initial.rpm ?? 0),
        expires_in_days: 0,
        group_type: group,
        allowed_vms:
          group === 'all' || group === 'pool' ? [] : initial.allowed_vms || [],
        ...(pools ? { vm_pool_id: initial.vm_pool_id || '' } : {}),
      })
      return
    }
    setDraft(blankDraft())
    // pools is only the option list. Reloading it must not wipe an open form.
  }, [open, mode, initial])

  const quotaOpts = mode === 'edit' ? QUOTA_EDIT : QUOTA_CREATE
  const rpmOpts = mode === 'edit' ? RPM_EDIT : RPM_CREATE
  const listed = vmsInGroup(vms || [], draft.group_type)
  const scopeBlocked =
    draft.group_type === 'pool'
      ? !draft.vm_pool_id
      : draft.group_type !== 'all' && draft.allowed_vms.length === 0

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
          <Field label='分组'>
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
                    group === 'all' || group === 'pool'
                      ? []
                      : d.allowed_vms.filter((id) => keep.has(id)),
                  ...(pools
                    ? { vm_pool_id: group === 'pool' ? d.vm_pool_id || '' : '' }
                    : {}),
                }))
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>all · 全局可调度</SelectItem>
                {pools ? <SelectItem value='pool'>账号池</SelectItem> : null}
                <SelectItem value='anthropic'>anthropic</SelectItem>
                <SelectItem value='openai'>openai</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {draft.group_type === 'pool' ? (
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
          ) : draft.group_type === 'all' ? (
            <p className='text-xs text-muted-foreground sm:col-span-2'>
              all 是最高权限，不再选择 VM。
            </p>
          ) : (
            <div className='sm:col-span-2'>
              <Field label='可用 VM'>
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
                          checked={draft.allowed_vms.includes(vm.id)}
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
          )}
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
            onClick={() => onSubmit(draft)}
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
    max_concurrency: 20,
    quota_requests: 0,
    quota_usd: 0,
    rpm: 0,
    expires_in_days: 30,
    group_type: 'all',
    allowed_vms: [],
  }
}

function groupOf(value: string | undefined): KeyGroupType {
  if (value === 'anthropic' || value === 'openai') return value
  return 'all'
}

function vmsInGroup(vms: Vm[], group: KeyGroupType): Vm[] {
  if (group === 'openai') return vms.filter((vm) => isCodexVm(vm))
  if (group === 'anthropic') return vms.filter((vm) => !isCodexVm(vm))
  return []
}
