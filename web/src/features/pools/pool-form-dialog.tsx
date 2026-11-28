import { useEffect, useState } from 'react'
import type {
  JevProfile,
  PoolRole,
  ProviderScope,
  SchedulerPool,
  SchedulerPoolDraft,
  SessionOverflowPolicy,
  SystemPromptMode,
  SystemPromptPreset,
} from '@/types/panel-pools'
import { Lock, Plus, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  buildPoolPayload,
  CLIENT_SYSTEM_POLICY_LABELS,
  createDefaultPoolDraft,
  isPromptLockedProvider,
  JEV_PROFILE_LABELS,
  MACHINE_TTL_MAX_SECONDS,
  MACHINE_TTL_MIN_SECONDS,
  POOL_LOCKED_DEFAULTS,
  POOL_ROLE_LABELS,
  poolToDraft,
  PRESET_PLAN_TAGS,
  PROVIDER_SCOPE_LABELS,
  SESSION_OVERFLOW_POLICY_LABELS,
  SESSION_TTL_MAX_SECONDS,
  SESSION_TTL_MIN_SECONDS,
  slugifyPoolName,
  SYSTEM_PROMPT_MAX_BYTES,
  SYSTEM_PROMPT_MODE_LABELS,
  SYSTEM_PROMPT_PRESET_LABELS,
  utf8ByteLength,
  validatePoolPromptPolicy,
} from './pool-rules'
import { TtlDurationInput } from './ttl-input'

const PROVIDERS: ProviderScope[] = [
  'anthropic',
  'openai',
  'google',
  'api',
  'mixed',
]
const ROLES: PoolRole[] = [
  'primary',
  'standard',
  'overflow',
  'downgrade',
  'dedicated',
]
const PROMPT_MODES: SystemPromptMode[] = [
  'official',
  'zero_inject',
  'override',
  'append',
  'passthrough',
  'inherit_global',
]
const JEV_PROFILES: JevProfile[] = [
  'inherit_global',
  'enforce',
  'downgrade_only',
  'bypass_trusted',
]

export function PoolFormDialog({
  mode,
  open,
  onOpenChange,
  initial,
  pending,
  onSubmit,
}: {
  mode: 'create' | 'edit'
  open: boolean
  onOpenChange: (open: boolean) => void
  initial?: SchedulerPool | null
  pending: boolean
  onSubmit: (payload: Record<string, unknown>) => void
}) {
  const [draft, setDraft] = useState<SchedulerPoolDraft>(() =>
    createDefaultPoolDraft()
  )
  const [slugTouched, setSlugTouched] = useState(false)
  const [customTag, setCustomTag] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setCustomTag('')
    if (mode === 'edit' && initial) {
      setDraft(poolToDraft(initial))
      setSlugTouched(true)
    } else {
      setDraft(createDefaultPoolDraft())
      setSlugTouched(false)
    }
  }, [open, mode, initial])

  const promptLocked = isPromptLockedProvider(draft.provider_scope)
  const promptValidation = validatePoolPromptPolicy({
    provider_scope: draft.provider_scope,
    system_prompt_mode: draft.system_prompt_mode,
    system_prompt_text: draft.system_prompt_text,
  })
  const promptBytes = utf8ByteLength(draft.system_prompt_text)

  const handleProviderChange = (next: ProviderScope) => {
    const locked = isPromptLockedProvider(next)
    setDraft((prev) => ({
      ...prev,
      provider_scope: next,
      ...(locked
        ? {
            system_prompt_mode: 'passthrough',
            system_prompt_text: '',
            allow_cross_prompt_fallback: false,
          }
        : prev.system_prompt_mode === 'passthrough' && mode === 'create'
          ? { system_prompt_mode: 'inherit_global' }
          : {}),
    }))
  }

  const toggleTag = (tag: string) => {
    const clean = tag.trim()
    if (!clean) return
    setDraft((prev) => ({
      ...prev,
      plan_tags: prev.plan_tags.includes(clean)
        ? prev.plan_tags.filter((t) => t !== clean)
        : [...prev.plan_tags, clean],
    }))
  }

  const addCustomTag = () => {
    const clean = customTag.trim()
    if (!clean) return
    if (!draft.plan_tags.includes(clean)) {
      setDraft((prev) => ({ ...prev, plan_tags: [...prev.plan_tags, clean] }))
    }
    setCustomTag('')
  }

  const handleSave = () => {
    try {
      const payload = buildPoolPayload(draft)
      setError(null)
      onSubmit(payload)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !pending && onOpenChange(v)}>
      <DialogContent className='flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            {mode === 'create'
              ? '新建分组池'
              : `编辑分组池 · ${initial?.name || initial?.id || ''}`}
          </DialogTitle>
          <DialogDescription>
            全 Provider
            分组池配置。默认启用「满了就换」（spill_immediately，零干等）与 1
            周设备粘性 + 24 小时会话粘性。
          </DialogDescription>
        </DialogHeader>

        <div className='min-h-0 flex-1 space-y-5 overflow-y-auto pr-1'>
          {error ? (
            <Alert variant='destructive'>
              <AlertTitle>校验未通过</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <section className='grid gap-3 sm:grid-cols-2'>
            <div className='space-y-1.5'>
              <Label htmlFor='pool-form-name'>名称 *</Label>
              <Input
                id='pool-form-name'
                placeholder='例如：Anthropic 官方提示词首选池'
                value={draft.name}
                disabled={pending}
                onChange={(e) => {
                  const name = e.target.value
                  setDraft((prev) => ({
                    ...prev,
                    name,
                    ...(slugTouched ? {} : { slug: slugifyPoolName(name) }),
                  }))
                }}
              />
            </div>

            <div className='space-y-1.5'>
              <Label htmlFor='pool-form-slug'>Slug 标识</Label>
              <Input
                id='pool-form-slug'
                placeholder='anthropic-official-primary'
                className='font-mono text-xs'
                value={draft.slug}
                disabled={pending}
                onChange={(e) => {
                  setSlugTouched(true)
                  setDraft((prev) => ({ ...prev, slug: e.target.value }))
                }}
              />
            </div>

            <div className='space-y-1.5'>
              <Label htmlFor='pool-form-provider'>Provider 范围 *</Label>
              <Select
                value={draft.provider_scope}
                disabled={pending}
                onValueChange={(v) => handleProviderChange(v as ProviderScope)}
              >
                <SelectTrigger id='pool-form-provider'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((scope) => (
                    <SelectItem key={scope} value={scope}>
                      {PROVIDER_SCOPE_LABELS[scope]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className='space-y-1.5'>
              <Label htmlFor='pool-form-role'>池角色</Label>
              <Select
                value={draft.pool_role}
                disabled={pending}
                onValueChange={(v) =>
                  setDraft((prev) => ({ ...prev, pool_role: v as PoolRole }))
                }
              >
                <SelectTrigger id='pool-form-role'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {POOL_ROLE_LABELS[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className='space-y-1.5'>
              <Label htmlFor='pool-form-jev'>JEV 前置拦截策略</Label>
              <Select
                value={draft.jev_profile}
                disabled={pending}
                onValueChange={(v) =>
                  setDraft((prev) => ({
                    ...prev,
                    jev_profile: v as JevProfile,
                  }))
                }
              >
                <SelectTrigger id='pool-form-jev'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {JEV_PROFILES.map((profile) => (
                    <SelectItem key={profile} value={profile}>
                      {JEV_PROFILE_LABELS[profile]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className='space-y-1.5'>
              <Label htmlFor='pool-form-sort'>展示排序号</Label>
              <Input
                id='pool-form-sort'
                type='number'
                value={draft.sort_order}
                disabled={pending}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    sort_order: Number(e.target.value) || 0,
                  }))
                }
              />
            </div>

            <div className='space-y-1.5 sm:col-span-2'>
              <Label htmlFor='pool-form-desc'>说明</Label>
              <Input
                id='pool-form-desc'
                placeholder='描述该分组池的业务用途、套餐归属或客户群体'
                value={draft.description}
                disabled={pending}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, description: e.target.value }))
                }
              />
            </div>
          </section>

          {/* 套餐标签 */}
          <section className='space-y-2 rounded-lg border p-3'>
            <Label>套餐标签（plan_tags）</Label>
            <div className='flex flex-wrap gap-1.5'>
              {PRESET_PLAN_TAGS.map((tag) => {
                const active = draft.plan_tags.includes(tag)
                return (
                  <button
                    key={tag}
                    type='button'
                    disabled={pending}
                    onClick={() => toggleTag(tag)}
                    className={`cursor-pointer rounded-md border px-2 py-0.5 font-mono text-xs transition-colors ${
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground'
                    }`}
                  >
                    {tag}
                  </button>
                )
              })}
            </div>
            {draft.plan_tags.filter(
              (t) => !(PRESET_PLAN_TAGS as readonly string[]).includes(t)
            ).length > 0 ? (
              <div className='flex flex-wrap gap-1.5 pt-1'>
                {draft.plan_tags
                  .filter(
                    (t) => !(PRESET_PLAN_TAGS as readonly string[]).includes(t)
                  )
                  .map((tag) => (
                    <Badge key={tag} variant='secondary' className='gap-1'>
                      {tag}
                      <button
                        type='button'
                        aria-label={`移除标签 ${tag}`}
                        onClick={() => toggleTag(tag)}
                      >
                        <X className='size-3' />
                      </button>
                    </Badge>
                  ))}
              </div>
            ) : null}
            <div className='flex items-center gap-2 pt-1'>
              <Input
                value={customTag}
                placeholder='添加自定义套餐标签，如 vip_tier1'
                className='h-8 max-w-xs text-xs'
                disabled={pending}
                onChange={(e) => setCustomTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addCustomTag()
                  }
                }}
              />
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={pending || !customTag.trim()}
                onClick={addCustomTag}
              >
                <Plus className='size-3.5' />
                添加
              </Button>
            </div>
          </section>

          {/* System Prompt 策略（OpenAI / Google 强锁 passthrough） */}
          <section className='space-y-3 rounded-lg border p-3'>
            <div className='flex items-center justify-between gap-2'>
              <Label>System Prompt 策略</Label>
              {promptLocked ? (
                <Badge
                  variant='outline'
                  className='gap-1 text-muted-foreground'
                >
                  <Lock className='size-3' />
                  已锁定透传
                </Badge>
              ) : null}
            </div>
            {promptLocked ? (
              <Alert>
                <Lock className='size-4' />
                <AlertTitle>
                  OpenAI / Google 分组池不使用 System Prompt 注入（恒透传）
                </AlertTitle>
                <AlertDescription>
                  当前选择为 {PROVIDER_SCOPE_LABELS[draft.provider_scope]}
                  ，后端强制锁定{' '}
                  <code className='font-mono'>
                    system_prompt_mode = &apos;passthrough&apos;
                  </code>
                  ，不做池级 system 改写。
                </AlertDescription>
              </Alert>
            ) : (
              <div className='space-y-3'>
                {draft.provider_scope === 'mixed' ||
                draft.provider_scope === 'api' ? (
                  <p className='text-xs text-muted-foreground'>
                    提示：混合 / API 池的 System Prompt 策略仅对路由至 Anthropic
                    节点的请求生效，OpenAI / Google 节点恒定原样透传。
                  </p>
                ) : null}
                <div className='grid gap-3 sm:grid-cols-2'>
                  <div className='space-y-1.5'>
                    <Label htmlFor='pool-form-prompt-mode'>策略模式</Label>
                    <Select
                      value={draft.system_prompt_mode}
                      disabled={pending}
                      onValueChange={(v) =>
                        setDraft((prev) => ({
                          ...prev,
                          system_prompt_mode: v as SystemPromptMode,
                        }))
                      }
                    >
                      <SelectTrigger id='pool-form-prompt-mode'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PROMPT_MODES.map((m) => (
                          <SelectItem key={m} value={m}>
                            {SYSTEM_PROMPT_MODE_LABELS[m]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {draft.system_prompt_mode === 'official' ? (
                    <div className='space-y-1.5'>
                      <Label htmlFor='pool-form-prompt-preset'>官方预设</Label>
                      <Select
                        value={draft.system_prompt_preset}
                        disabled={pending}
                        onValueChange={(v) =>
                          setDraft((prev) => ({
                            ...prev,
                            system_prompt_preset: v as SystemPromptPreset,
                          }))
                        }
                      >
                        <SelectTrigger id='pool-form-prompt-preset'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(['official_full', 'official'] as const).map(
                            (preset) => (
                              <SelectItem key={preset} value={preset}>
                                {SYSTEM_PROMPT_PRESET_LABELS[preset]}
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  {draft.system_prompt_mode === 'override' ? (
                    <div className='space-y-1.5'>
                      <Label htmlFor='pool-form-client-policy'>
                        客户端 system 合并方式
                      </Label>
                      <Select
                        value={draft.client_system_policy}
                        disabled={pending}
                        onValueChange={(v) =>
                          setDraft((prev) => ({
                            ...prev,
                            client_system_policy:
                              v as SchedulerPoolDraft['client_system_policy'],
                          }))
                        }
                      >
                        <SelectTrigger id='pool-form-client-policy'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(
                            [
                              'prepend_pool',
                              'append_pool',
                              'replace_client',
                            ] as const
                          ).map((pol) => (
                            <SelectItem key={pol} value={pol}>
                              {CLIENT_SYSTEM_POLICY_LABELS[pol]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                </div>
                {draft.system_prompt_mode === 'override' ||
                draft.system_prompt_mode === 'append' ? (
                  <div className='space-y-1.5'>
                    <div className='flex items-center justify-between text-xs'>
                      <Label htmlFor='pool-form-prompt-text'>提示词正文</Label>
                      <span
                        className={`font-mono tabular-nums ${
                          promptBytes > SYSTEM_PROMPT_MAX_BYTES
                            ? 'font-semibold text-destructive'
                            : 'text-muted-foreground'
                        }`}
                      >
                        {promptBytes.toLocaleString()} /{' '}
                        {SYSTEM_PROMPT_MAX_BYTES.toLocaleString()} B (64 KiB)
                      </span>
                    </div>
                    <Textarea
                      id='pool-form-prompt-text'
                      rows={4}
                      disabled={pending}
                      placeholder='输入作用于本池 Anthropic 节点的 System Prompt 正文…'
                      value={draft.system_prompt_text}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          system_prompt_text: e.target.value,
                        }))
                      }
                    />
                  </div>
                ) : null}
              </div>
            )}
          </section>

          {/* 粘性、单会话门闩与溢出默认参数（v4 锁定基线） */}
          <section className='space-y-3 rounded-lg border p-3'>
            <div className='text-sm font-medium'>
              粘性、溢出与成员独占参数（v4 锁定默认值）
            </div>
            <div className='grid gap-3 sm:grid-cols-2'>
              <div className='space-y-1.5 sm:col-span-2'>
                <Label>设备粘性 TTL（默认 7 天）</Label>
                <TtlDurationInput
                  seconds={draft.machine_ttl_seconds}
                  minSeconds={MACHINE_TTL_MIN_SECONDS}
                  maxSeconds={MACHINE_TTL_MAX_SECONDS}
                  preferredUnit='days'
                  presets={[86400, 259200, 604800, 1209600, 2592000]}
                  disabled={pending}
                  onChange={(machine_ttl_seconds) =>
                    setDraft((prev) => ({ ...prev, machine_ttl_seconds }))
                  }
                />
              </div>
              <div className='space-y-1.5 sm:col-span-2'>
                <Label>会话粘性 TTL（默认 24 小时）</Label>
                <TtlDurationInput
                  seconds={draft.session_ttl_seconds}
                  minSeconds={SESSION_TTL_MIN_SECONDS}
                  maxSeconds={SESSION_TTL_MAX_SECONDS}
                  preferredUnit='hours'
                  presets={[3600, 21600, 86400, 259200, 604800]}
                  disabled={pending}
                  onChange={(session_ttl_seconds) =>
                    setDraft((prev) => ({ ...prev, session_ttl_seconds }))
                  }
                />
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='pool-form-overflow'>
                  场景 C 单机占满溢出策略
                </Label>
                <Select
                  value={draft.session_overflow_policy}
                  disabled={pending}
                  onValueChange={(v) => {
                    const policy = v as SessionOverflowPolicy
                    setDraft((prev) => ({
                      ...prev,
                      session_overflow_policy: policy,
                      session_busy_wait_ms:
                        policy === 'spill_immediately'
                          ? 0
                          : prev.session_busy_wait_ms || 3000,
                    }))
                  }}
                >
                  <SelectTrigger id='pool-form-overflow'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(
                      [
                        'spill_immediately',
                        'wait_then_spill',
                        'strict',
                      ] as const
                    ).map((policy) => (
                      <SelectItem key={policy} value={policy}>
                        {SESSION_OVERFLOW_POLICY_LABELS[policy]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='pool-form-busy-wait'>
                  单机占满等待上限 (ms)
                </Label>
                <Input
                  id='pool-form-busy-wait'
                  type='number'
                  min={0}
                  max={30000}
                  step={500}
                  disabled={
                    pending ||
                    draft.session_overflow_policy === 'spill_immediately'
                  }
                  value={
                    draft.session_overflow_policy === 'spill_immediately'
                      ? 0
                      : draft.session_busy_wait_ms
                  }
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      session_busy_wait_ms: Number(e.target.value) || 0,
                    }))
                  }
                />
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='pool-form-gate-max'>
                  SessionGate 队列深度（默认{' '}
                  {POOL_LOCKED_DEFAULTS.session_queue_max}）
                </Label>
                <Input
                  id='pool-form-gate-max'
                  type='number'
                  min={1}
                  max={128}
                  disabled={pending}
                  value={draft.session_queue_max}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      session_queue_max: Number(e.target.value) || 16,
                    }))
                  }
                />
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='pool-form-gate-timeout'>
                  SessionGate 等待超时 ms（默认{' '}
                  {POOL_LOCKED_DEFAULTS.session_queue_timeout_ms}）
                </Label>
                <Input
                  id='pool-form-gate-timeout'
                  type='number'
                  min={1000}
                  max={300000}
                  step={1000}
                  disabled={pending}
                  value={draft.session_queue_timeout_ms}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      session_queue_timeout_ms: Number(e.target.value) || 60000,
                    }))
                  }
                />
              </div>
            </div>

            <div className='flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2.5'>
              <div>
                <Label htmlFor='pool-form-exclusive'>
                  成员独占（exclusive_members）
                </Label>
                <p className='text-xs text-muted-foreground'>
                  默认关闭（false），允许 Anthropic CRAG VM 跨不同 Prompt
                  池复用并在添加时给出风控警告（D1）；开启后本池成员不可再加入其他池。
                </p>
              </div>
              <Switch
                id='pool-form-exclusive'
                checked={draft.exclusive_members}
                disabled={pending}
                onCheckedChange={(exclusive_members) =>
                  setDraft((prev) => ({ ...prev, exclusive_members }))
                }
              />
            </div>

            <div className='flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2.5'>
              <div>
                <Label htmlFor='pool-form-enabled'>启用该分组池</Label>
                <p className='text-xs text-muted-foreground'>
                  停用后绑定该池的严格密钥将 Fail-Closed 返回
                  403，不会放宽到全局。
                </p>
              </div>
              <Switch
                id='pool-form-enabled'
                checked={draft.enabled}
                disabled={pending}
                onCheckedChange={(enabled) =>
                  setDraft((prev) => ({ ...prev, enabled }))
                }
              />
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button
            type='button'
            variant='outline'
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type='button'
            disabled={pending || !draft.name.trim() || !promptValidation.ok}
            loading={pending}
            onClick={handleSave}
          >
            {mode === 'create' ? '创建分组池' : '保存修改'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
