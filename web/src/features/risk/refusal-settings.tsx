import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  RefusalDeviceBlock,
  RefusalGuardConfig,
  RiskAuditPolicy,
} from '@/types/panel-routing'
import type {
  UsageLogRow,
  UsageLogsBatchResult,
} from '@/types/panel-usage-logs'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtExpiresAt } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Group, ToggleItem, ToggleList } from './blocks'
import { refusalGuardsQueryOptions } from './queries'

const SIMILARITY_CHOICES = [80, 85, 90, 95] as const

function shortFp(fp: string) {
  const s = String(fp || '')
  if (s.length <= 16) return s
  return `${s.slice(0, 10)}…${s.slice(-6)}`
}

/** Changes here save immediately: each switch and list action is one PUT/DELETE. */
export function RefusalSettings({
  onOpen,
}: {
  onOpen: (row: UsageLogRow) => void
}) {
  const qc = useQueryClient()
  const q = useQuery(refusalGuardsQueryOptions())
  const [clearOpen, setClearOpen] = useState(false)
  const [clearDevicesOpen, setClearDevicesOpen] = useState(false)
  const [deleteFp, setDeleteFp] = useState<string | null>(null)
  const [unblockId, setUnblockId] = useState<string | null>(null)

  const source = useMutation({
    mutationFn: async (item: RefusalDeviceBlock) => {
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

  const save = useMutation({
    mutationFn: (patch: Partial<RefusalGuardConfig>) =>
      api<RefusalGuardConfig>('/api/panel/refusal-guards', {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    onSuccess: async (data) => {
      toast.success('已保存拒答设置')
      qc.setQueryData(refusalGuardsQueryOptions().queryKey, data)
    },
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
      toast.success('已清空 device 封禁')
      setClearDevicesOpen(false)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (q.error) {
    return (
      <p className='p-4 text-sm text-destructive' role='alert'>
        {(q.error as Error).message}
      </p>
    )
  }
  if (!q.data) return <div className='h-40 animate-pulse bg-muted/40' />
  const data = q.data
  const devices = data.devices ?? []
  const deviceCount = data.device_count ?? devices.length
  const similarity = data.similarity ?? 90
  const deleting = data.items.find((item) => item.fingerprint === deleteFp)

  return (
    <div className='space-y-8 p-4'>
      <Group
        title='何时拦截'
        hint='上游策略拒答回填为指纹。重复命中返回不可重试的 400；相似匹配只比较用户正文。'
      >
        <ToggleList>
          <ToggleItem
            label='拦截重复拒答'
            desc='REFUSAL_GUARD=0 时不使用拒答缓存'
          >
            <Switch
              checked={data.enabled}
              disabled={save.isPending}
              onCheckedChange={(v) => save.mutate({ enabled: v })}
            />
          </ToggleItem>
          <ToggleItem label='近似拦截' desc='不含共享 system'>
            <Switch
              checked={data.similarity_enabled !== false}
              disabled={save.isPending || !data.enabled}
              onCheckedChange={(v) => save.mutate({ similarity_enabled: v })}
            />
          </ToggleItem>
          <ToggleItem
            label='启用分级封禁'
            desc='设备／机器按违规次数升级；违规会话永久阻止。系统提示词改写不受此开关放行。'
          >
            <Switch
              checked={data.device_block_enabled !== false}
              disabled={save.isPending || !data.enabled}
              onCheckedChange={(v) => save.mutate({ device_block_enabled: v })}
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

      <RiskPolicyForm
        key={JSON.stringify(data.risk_audit)}
        value={data.risk_audit}
        pending={save.isPending}
        onSave={(risk_audit) => save.mutate({ risk_audit })}
      />

      <div className='grid gap-8 xl:grid-cols-2'>
        <Group
          title='设备与会话封禁'
          hint={
            deviceCount
              ? devices.length < deviceCount
                ? `显示最近 ${devices.length} / ${deviceCount} 条，含已到期记录`
                : `${deviceCount} 条，含已到期记录`
              : '还没有'
          }
          action={
            <Button
              size='sm'
              variant='outline'
              className='cursor-pointer'
              disabled={!deviceCount || clearDevices.isPending}
              onClick={() => setClearDevicesOpen(true)}
            >
              全部解除
            </Button>
          }
        >
          {devices.length ? (
            <ul className='max-h-80 divide-y overflow-y-auto rounded-xl border'>
              {devices.map((item) => (
                <li
                  key={item.device_id}
                  className='flex flex-wrap items-center justify-between gap-2 px-3 py-2'
                >
                  <div className='min-w-0 flex-1'>
                    <p className='text-xs break-all'>
                      {item.subject_kind === 'session' ? '会话' : '设备／机器'}{' '}
                      · <code>{item.identity_value || item.device_id}</code>
                    </p>
                    <p className='text-xs text-muted-foreground tabular-nums'>
                      {item.reason || 'refusal_guard'} · 第 {item.violations}{' '}
                      次违规 · 命中 {item.hit_count} ·{' '}
                      {item.expires_at
                        ? `${Date.parse(item.expires_at) <= Date.now() ? '已到期' : '封禁至'} ${fmtExpiresAt(item.expires_at)}`
                        : '永久'}
                    </p>
                    {item.subject_kind !== 'session' && item.session_id ? (
                      <p className='text-xs break-all text-muted-foreground'>
                        触发会话：<code>{item.session_id}</code>
                      </p>
                    ) : null}
                  </div>
                  {item.source_request_id ? (
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={source.isPending}
                      onClick={() => source.mutate(item)}
                    >
                      查看原始日志
                    </Button>
                  ) : null}
                  <Button
                    size='sm'
                    variant='ghost'
                    className='cursor-pointer'
                    onClick={() => setUnblockId(item.device_id)}
                  >
                    解除
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </Group>
        <Group
          title='拒答指纹'
          hint={
            data.count
              ? data.items.length < data.count
                ? `显示最近 ${data.items.length} / ${data.count}`
                : `${data.count} 条`
              : '还没有上游拒答'
          }
          action={
            <Button
              size='sm'
              variant='outline'
              className='cursor-pointer'
              disabled={!data.count || clear.isPending}
              onClick={() => setClearOpen(true)}
            >
              清空指纹
            </Button>
          }
        >
          {data.items.length ? (
            <ul className='max-h-80 divide-y overflow-y-auto rounded-xl border'>
              {data.items.map((item) => (
                <li
                  key={item.fingerprint}
                  className='flex items-center justify-between gap-2 px-3 py-2'
                >
                  <div className='min-w-0 flex-1'>
                    <p
                      className='line-clamp-3 text-sm break-words'
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
                    <p className='truncate font-mono text-xs text-muted-foreground tabular-nums'>
                      {item.model || '—'} · {shortFp(item.fingerprint)} · 命中{' '}
                      {item.hit_count} · {fmtExpiresAt(item.last_seen_at)}
                    </p>
                  </div>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='cursor-pointer'
                    onClick={() => setDeleteFp(item.fingerprint)}
                  >
                    删除
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </Group>
      </div>
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
        title='解除这个 device'
        desc={`解除后 ${unblockId || ''} 的新请求不再因为 device 封禁被拦。`}
        confirmText='解除'
        cancelBtnText='取消'
        destructive
        isLoading={unblock.isPending}
        handleConfirm={() => {
          if (unblockId) unblock.mutate(unblockId)
        }}
      />
    </div>
  )
}

function RiskPolicyForm({
  value,
  pending,
  onSave,
}: {
  value: RiskAuditPolicy
  pending: boolean
  onSave: (value: RiskAuditPolicy) => void
}) {
  const [form, setForm] = useState({
    steps: value.ban_steps.join(', '),
    tools: value.blocked_tools
      .map((tool) => `${tool.name} = ${tool.message}`)
      .join('\n'),
    phrases: value.upstream_policy_phrases.join('\n'),
    pool: value.downgrade_pool,
    endpoint: value.downgrade_endpoint,
    model: value.downgrade_model,
    route: String(value.route_margin),
    margin: String(value.model_margin),
  })
  const change = (key: keyof typeof form, next: string) =>
    setForm({ ...form, [key]: next })
  const lines = (text: string) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  return (
    <Group
      title='封禁、工具与降级策略'
      hint='仅对已通过硬规则的有效 Jev 评分使用降级分差；目标为空则不启用该路线。'
    >
      <form
        className='grid gap-4 sm:grid-cols-2'
        onSubmit={(event) => {
          event.preventDefault()
          onSave({
            ban_steps: form.steps
              .split(/[,，]/)
              .map((item) => (item.trim() ? Number(item) : NaN)),
            blocked_tools: lines(form.tools).map((line) => {
              const split = line.indexOf('=')
              return {
                name: split < 0 ? line : line.slice(0, split).trim(),
                message: split < 0 ? '' : line.slice(split + 1).trim(),
              }
            }),
            upstream_policy_phrases: lines(form.phrases),
            downgrade_pool: form.pool.trim(),
            downgrade_endpoint: form.endpoint.trim(),
            downgrade_model: form.model.trim(),
            route_margin: Number(form.route),
            model_margin: Number(form.margin),
          })
        }}
      >
        <div className='space-y-2 sm:col-span-2'>
          <Label htmlFor='risk-ban-steps'>
            按违规次数封禁（分钟，0 表示永久）
          </Label>
          <Input
            id='risk-ban-steps'
            required
            value={form.steps}
            onChange={(event) => change('steps', event.target.value)}
          />
        </div>
        <div className='space-y-2'>
          <Label htmlFor='risk-denied-tools'>
            禁用工具（每行：工具名 = 错误提示）
          </Label>
          <Textarea
            id='risk-denied-tools'
            value={form.tools}
            onChange={(event) => change('tools', event.target.value)}
          />
        </div>
        <div className='space-y-2'>
          <Label htmlFor='risk-upstream-phrases'>
            上游策略短语（每行一条）
          </Label>
          <Textarea
            id='risk-upstream-phrases'
            value={form.phrases}
            onChange={(event) => change('phrases', event.target.value)}
          />
        </div>
        {(
          [
            { key: 'pool', label: '降级账号池 ID' },
            { key: 'endpoint', label: '降级 API 渠道 ID' },
            { key: 'model', label: '降级模型 ID' },
            { key: 'route', label: '路线降级最大安全分差' },
            { key: 'margin', label: '模型降级最大安全分差' },
          ] as const
        ).map(({ key, label }) => (
          <div key={key} className='space-y-2'>
            <Label htmlFor={`risk-policy-${key}`}>{label}</Label>
            <Input
              id={`risk-policy-${key}`}
              value={form[key]}
              {...(key === 'route' || key === 'margin'
                ? {
                    type: 'number',
                    min: 0,
                    max: 1,
                    step: 'any',
                    required: true,
                  }
                : {})}
              onChange={(event) => change(key, event.target.value)}
            />
          </div>
        ))}
        <div className='sm:col-span-2'>
          <Button type='submit' size='sm' disabled={pending}>
            {pending ? '保存中…' : '保存审核策略'}
          </Button>
        </div>
      </form>
    </Group>
  )
}
