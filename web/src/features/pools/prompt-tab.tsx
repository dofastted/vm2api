import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  ClientSystemPolicy,
  SchedulerPool,
  SystemPromptMode,
  SystemPromptPreset,
} from '@/types/panel-pools'
import {
  Info,
  Lock,
  Save,
  ShieldCheck,
  ShieldOff,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { updateSchedulerPool } from './api'
import {
  CLIENT_SYSTEM_POLICY_LABELS,
  isPromptLockedProvider,
  NODE_TYPE_LABELS,
  normalizePoolPromptPreset,
  PROVIDER_SCOPE_LABELS,
  SYSTEM_PROMPT_MAX_BYTES,
  SYSTEM_PROMPT_PRESET_LABELS,
  utf8ByteLength,
  validatePoolPromptPolicy,
} from './pool-rules'
import { SCHEDULER_POOLS_KEY } from './queries'

const MODE_CARDS: Array<{
  mode: SystemPromptMode
  title: string
  subtitle: string
  detail: string
  highlight?: 'official' | 'zero'
}> = [
  {
    mode: 'official',
    title: '官方提示词',
    subtitle: 'official · 统一官方人设注入',
    detail:
      '对本池 Anthropic 节点按所选官方预设注入（official_full 完整官方提示词 / official 默认仅身份），cli-node 与 CRAG 语义统一。',
    highlight: 'official',
  },
  {
    mode: 'zero_inject',
    title: '0 注入',
    subtitle: 'zero_inject · 剥离官方提示词',
    detail:
      '剥离全部内置系统提示词与官方身份块，将官方 CLI 身份写入计费头 prompt_version，原样保留调用方业务 system。',
    highlight: 'zero',
  },
  {
    mode: 'override',
    title: '自定义覆写',
    subtitle: 'override · 池级自定义正文',
    detail:
      '使用下方自定义正文覆盖内置人设，并按 client_system_policy 决定与客户端 system 的合并顺序。',
  },
  {
    mode: 'append',
    title: '尾部追加',
    subtitle: 'append · 保 Prompt Cache 前缀',
    detail:
      '恒定在原有/客户端 system 末尾追加自定义文本块，最大程度保留前缀缓存命中。',
  },
  {
    mode: 'passthrough',
    title: '原样透传',
    subtitle: 'passthrough · 不追加不剥离',
    detail: '不对请求 system 做池级改写，交由上游或内核默认行为处理。',
  },
  {
    mode: 'inherit_global',
    title: '继承全局',
    subtitle: 'inherit_global · 跟随 /system 全局默认',
    detail: '无池级显式覆盖，回落至全局「system提示词」页面配置。',
  },
]

export function PoolPromptTab({ pool }: { pool: SchedulerPool }) {
  const qc = useQueryClient()
  const locked = isPromptLockedProvider(pool.provider_scope)

  const [mode, setMode] = useState<SystemPromptMode>(pool.system_prompt_mode)
  const [preset, setPreset] = useState<SystemPromptPreset>(() =>
    normalizePoolPromptPreset(pool.system_prompt_preset)
  )
  const [text, setText] = useState(pool.system_prompt_text || '')
  const [clientPolicy, setClientPolicy] = useState<ClientSystemPolicy>(
    pool.client_system_policy
  )

  useEffect(() => {
    setMode(locked ? 'passthrough' : pool.system_prompt_mode)
    setPreset(normalizePoolPromptPreset(pool.system_prompt_preset))
    setText(locked ? '' : pool.system_prompt_text || '')
    setClientPolicy(pool.client_system_policy || 'prepend_pool')
  }, [pool, locked])

  const bytes = utf8ByteLength(text)
  const bytePct = Math.min(
    100,
    Math.round((bytes / SYSTEM_PROMPT_MAX_BYTES) * 100)
  )
  const validation = validatePoolPromptPolicy({
    provider_scope: pool.provider_scope,
    system_prompt_mode: mode,
    system_prompt_text: text,
  })

  const saveMut = useMutation({
    mutationFn: () =>
      updateSchedulerPool(pool.id, {
        system_prompt_mode: mode,
        system_prompt_preset: preset,
        system_prompt_text:
          mode === 'override' || mode === 'append' ? text : '',
        client_system_policy: clientPolicy,
      }),
    onSuccess: async () => {
      toast.success('池级 System Prompt 策略已保存并热生效')
      await Promise.all([
        qc.invalidateQueries({ queryKey: SCHEDULER_POOLS_KEY }),
        qc.invalidateQueries({
          queryKey: ['panel', 'scheduler-pools', pool.id],
        }),
      ])
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const { anthropicMembers, nonAnthropicMembers } = useMemo(() => {
    const members = (pool.members || []).filter((m) => m.enabled !== false)
    const anth = members.filter(
      (m) =>
        m.node_type === 'claude_vm' ||
        (m.node_type === 'api_endpoint' &&
          (m.protocol === 'anthropic' || m.provider === 'anthropic'))
    )
    const other = members.filter((m) => !anth.includes(m))
    return { anthropicMembers: anth, nonAnthropicMembers: other }
  }, [pool.members])

  // OpenAI / Google 分组池强锁 passthrough，隐藏/禁用编辑器
  if (locked) {
    return (
      <div className='space-y-4'>
        <Alert className='border-border bg-muted/40'>
          <Lock className='size-4' />
          <AlertTitle>
            OpenAI / Google 分组池不使用 System Prompt 注入（恒透传）
          </AlertTitle>
          <AlertDescription className='space-y-1.5 pt-1'>
            <p>
              当前分组池 Provider 为{' '}
              <strong>{PROVIDER_SCOPE_LABELS[pool.provider_scope]}</strong>
              。按照架构锁定规范，池级 System Prompt 注入严格仅限 Anthropic
              平台；本池后端强制锁定{' '}
              <code className='font-mono'>
                system_prompt_mode = &apos;passthrough&apos;
              </code>
              ，所有请求保持原生透传，专注权重等级、双级粘性与密钥池隔离调度。
            </p>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const dirty =
    mode !== pool.system_prompt_mode ||
    preset !== pool.system_prompt_preset ||
    (mode === 'override' || mode === 'append'
      ? text !== (pool.system_prompt_text || '')
      : false) ||
    (mode === 'override' && clientPolicy !== pool.client_system_policy)

  return (
    <div className='space-y-5'>
      {pool.provider_scope === 'mixed' || pool.provider_scope === 'api' ? (
        <Alert>
          <Info className='size-4' />
          <AlertTitle>仅对池内 Anthropic 节点生效</AlertTitle>
          <AlertDescription>
            当前为 {PROVIDER_SCOPE_LABELS[pool.provider_scope]} 分组池：下列
            System Prompt 策略仅对路由至 Anthropic 节点（Claude VM 或 Anthropic
            协议 API 渠道）的请求生效；落到 OpenAI / Google
            节点的请求恒定原样透传。
          </AlertDescription>
        </Alert>
      ) : null}

      {/* 6 选 1 策略卡片 */}
      <section className='space-y-2.5'>
        <Label className='text-sm font-semibold'>
          选择 Anthropic 池级 System Prompt 策略（6 选 1）
        </Label>
        <div
          role='radiogroup'
          aria-label='System Prompt 策略模式'
          className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'
        >
          {MODE_CARDS.map((card) => {
            const active = mode === card.mode
            return (
              <button
                key={card.mode}
                type='button'
                role='radio'
                aria-checked={active}
                onClick={() => setMode(card.mode)}
                className={cn(
                  'flex cursor-pointer flex-col gap-1.5 rounded-xl border p-3.5 text-left transition-all',
                  active
                    ? card.highlight === 'official'
                      ? 'border-emerald-500 bg-emerald-500/10 ring-1 ring-emerald-500/40'
                      : card.highlight === 'zero'
                        ? 'border-amber-500 bg-amber-500/10 ring-1 ring-amber-500/40'
                        : 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                )}
              >
                <div className='flex items-center justify-between gap-2'>
                  <span className='inline-flex items-center gap-1.5 text-sm font-semibold'>
                    {card.highlight === 'official' ? (
                      <ShieldCheck className='size-4 text-emerald-600 dark:text-emerald-400' />
                    ) : card.highlight === 'zero' ? (
                      <ShieldOff className='size-4 text-amber-600 dark:text-amber-400' />
                    ) : card.mode === 'override' ? (
                      <Sparkles className='size-4 text-purple-600 dark:text-purple-400' />
                    ) : null}
                    {card.title}
                  </span>
                  {active ? (
                    <Badge variant='default' className='text-[10px]'>
                      当前选中
                    </Badge>
                  ) : null}
                </div>
                <span className='font-mono text-[11px] text-muted-foreground'>
                  {card.subtitle}
                </span>
                <p className='text-xs leading-5 text-muted-foreground'>
                  {card.detail}
                </p>
              </button>
            )
          })}
        </div>
      </section>

      {/* 模式专属参数 */}
      {mode === 'official' ? (
        <section className='space-y-2 rounded-xl border bg-card p-4'>
          <Label htmlFor='prompt-preset-select'>
            官方人设预设（system_prompt_preset）
          </Label>
          <Select
            value={preset}
            onValueChange={(v) => setPreset(v as SystemPromptPreset)}
          >
            <SelectTrigger id='prompt-preset-select' className='max-w-sm'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['official_full', 'official'] as const).map((p) => (
                <SelectItem key={p} value={p}>
                  {SYSTEM_PROMPT_PRESET_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className='text-xs text-muted-foreground'>
            统一作用于本池内的 cli-node、CRAG 与 Anthropic API 节点：
            official_full 注入完整官方提示词；official
            默认仅含计费头与官方身份句（可按 /system 开关按需扩展）。
          </p>
        </section>
      ) : null}

      {mode === 'override' || mode === 'append' ? (
        <section className='space-y-4 rounded-xl border bg-card p-4'>
          <div className='space-y-2'>
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <Label htmlFor='prompt-body-textarea'>
                {mode === 'override' ? '自定义覆写正文' : '尾部追加正文'}
              </Label>
              <span
                className={cn(
                  'font-mono text-xs tabular-nums',
                  bytes > SYSTEM_PROMPT_MAX_BYTES
                    ? 'font-semibold text-destructive'
                    : bytes > SYSTEM_PROMPT_MAX_BYTES * 0.85
                      ? 'text-[color:var(--status-warn)]'
                      : 'text-muted-foreground'
                )}
              >
                {bytes.toLocaleString()} /{' '}
                {SYSTEM_PROMPT_MAX_BYTES.toLocaleString()} 字节（{bytePct}% · 64
                KiB 上限）
              </span>
            </div>
            <Progress value={bytePct} className='h-1.5' />
            <Textarea
              id='prompt-body-textarea'
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                mode === 'override'
                  ? '输入用于覆盖内置人设的完整 System Prompt 正文…'
                  : '输入追加在客户端 system 尾部的约束/说明文本…'
              }
              className='font-mono text-xs leading-5'
            />
            {!validation.ok && validation.message ? (
              <p role='alert' className='text-xs text-destructive'>
                {validation.message}
              </p>
            ) : null}
          </div>

          {mode === 'override' ? (
            <div className='space-y-2 border-t pt-3'>
              <Label className='text-xs font-semibold'>
                客户端自带 system 合并策略（仅 override 模式显示）
              </Label>
              <div
                role='radiogroup'
                aria-label='客户端 system 合并策略'
                className='grid gap-2 sm:grid-cols-3'
              >
                {(
                  ['prepend_pool', 'append_pool', 'replace_client'] as const
                ).map((pol) => {
                  const selected = clientPolicy === pol
                  return (
                    <button
                      key={pol}
                      type='button'
                      role='radio'
                      aria-checked={selected}
                      onClick={() => setClientPolicy(pol)}
                      className={cn(
                        'cursor-pointer rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                        selected
                          ? 'border-primary bg-primary/5 font-medium text-foreground'
                          : 'border-border bg-background text-muted-foreground hover:border-primary/40'
                      )}
                    >
                      {CLIENT_SYSTEM_POLICY_LABELS[pol]}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : (
            <p className='text-xs text-muted-foreground'>
              尾部追加模式恒定在原有/客户端 system 末尾追加文本块，最大程度保留
              Prompt Cache 前缀字节命中。
            </p>
          )}
        </section>
      ) : null}

      {/* 生效 Anthropic 成员预览 */}
      <section className='space-y-2 rounded-xl border bg-muted/20 p-4'>
        <div className='flex items-center justify-between gap-2'>
          <h4 className='text-xs font-semibold'>生效 Anthropic 成员预览</h4>
          <span className='text-xs text-muted-foreground tabular-nums'>
            共 {anthropicMembers.length} 个启用中的 Anthropic 节点受此策略影响
          </span>
        </div>
        {anthropicMembers.length === 0 ? (
          <p className='text-xs text-muted-foreground'>
            本池尚未添加启用中的 Anthropic 节点（Claude VM 或 Anthropic API
            渠道）。
          </p>
        ) : (
          <div className='flex flex-wrap gap-1.5'>
            {anthropicMembers.map((m) => (
              <Badge
                key={`${m.node_type}:${m.node_id}`}
                variant='secondary'
                className='font-mono text-xs'
              >
                {m.name || m.node_id}
              </Badge>
            ))}
          </div>
        )}
        {nonAnthropicMembers.length > 0 ? (
          <p className='text-[11px] text-muted-foreground'>
            池内另有 {nonAnthropicMembers.length} 个非 Anthropic 节点（
            {nonAnthropicMembers
              .slice(0, 5)
              .map(
                (m) =>
                  `${m.name || m.node_id} [${NODE_TYPE_LABELS[m.node_type]}]`
              )
              .join('、')}
            {nonAnthropicMembers.length > 5 ? '…' : ''}
            ），这些节点始终原样透传，不受本页策略影响。
          </p>
        ) : null}
      </section>

      <div className='flex items-center justify-end gap-2'>
        <Button
          type='button'
          size='sm'
          disabled={!dirty || !validation.ok || saveMut.isPending}
          loading={saveMut.isPending}
          onClick={() => saveMut.mutate()}
        >
          <Save className='size-3.5' />
          保存 Prompt 策略
        </Button>
      </div>
    </div>
  )
}
