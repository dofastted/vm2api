import { type ComponentProps, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import {
  healthProbeQueryOptions,
  type HealthSnapshotView,
} from '@/features/settings/queries'
import { settleInt, typingInt } from './int-input'

type Obj = Record<string, unknown>

type HealthPaneProps = {
  title: string
  failover: Obj
  healthProbe: Obj | undefined
  compatibility: Obj
  onFailoverChange: (next: Obj) => void
  onHealthProbeChange: (next: Obj) => void
  onCompatibilityChange: (next: Obj) => void
}

function obj(value: unknown): Obj {
  return value && typeof value === 'object' ? (value as Obj) : {}
}

function clampInt(raw: string, min: number, max: number, fallback: number) {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 输入时不限范围（否则键入「120」第一个键就被拉成 30），失焦时再限到 [min, max]。
 * 未失焦直接保存时由网关按同样范围收口。
 */
function DeferredIntInput({
  value,
  min,
  max,
  fallback,
  onCommit,
  ...props
}: Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'onBlur'> & {
  value: number
  min: number
  max: number
  fallback: number
  onCommit: (next: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <Input
      {...props}
      type='number'
      min={min}
      max={max}
      value={text ?? String(value)}
      onChange={(event) => {
        setText(event.target.value)
        const n = typingInt(event.target.value)
        if (n !== null) onCommit(n)
      }}
      onBlur={() => {
        if (text === null) return
        const settled = settleInt(text, min, max, fallback)
        setText(null)
        if (settled !== value) onCommit(settled)
      }}
    />
  )
}

export function HealthPane(props: HealthPaneProps) {
  const {
    title,
    failover,
    healthProbe,
    compatibility,
    onFailoverChange,
    onHealthProbeChange,
    onCompatibilityChange,
  } = props
  const probe = obj(healthProbe)
  const real = obj(probe.real)
  const minTokens = obj(compatibility.min_max_tokens)
  const setProbe = (patch: Obj) => onHealthProbeChange({ ...probe, ...patch })
  const setReal = (patch: Obj) => setProbe({ real: { ...real, ...patch } })
  const minTokensMode = String(minTokens.mode ?? minTokens.tier ?? 'floor')
  const preserveCaller =
    minTokensMode === '不改' ||
    minTokens.no_raise === true ||
    minTokens.raise === false
  const setMinTokens = (patch: Obj) =>
    onCompatibilityChange({
      ...compatibility,
      min_max_tokens: {
        enabled: true,
        value: 128,
        mode: 'floor',
        ...minTokens,
        ...patch,
      },
    })

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <p className='text-xs text-muted-foreground'>
            探测和测试请求在进入调度前就地应答，不占并发、会话席位和粘性。
          </p>
        </CardHeader>
        <CardContent className='divide-y'>
          <SettingRow
            label='拦截预热请求'
            desc='仅 Claude 模型的 /v1/messages。Claude Code 的 Warmup、标题生成、SUGGESTION MODE、haiku max_tokens=1 连通性检查直接返回模拟响应，不打上游。'
          >
            <Switch
              checked={probe.intercept_warmup === true}
              onCheckedChange={(checked) =>
                setProbe({ intercept_warmup: checked })
              }
              aria-label='拦截预热请求'
            />
          </SettingRow>
          <SettingRow
            label='thinking 合法间隔'
            desc='未写 max_tokens 时用模型目录 max_tokens_default。写了且低于此值时抬到该值；「不抬升」或模式「不改」时不抬。该数值在 enabled thinking 的 budget 不小于 max_tokens 时只补 thinking 合法间隔。'
          >
            <div className='flex flex-col items-end gap-3 sm:flex-row sm:flex-wrap sm:items-center'>
              <Input
                className='w-24'
                type='number'
                min={1}
                max={4096}
                disabled={minTokens.enabled === false}
                value={Number(minTokens.value ?? 128)}
                onChange={(event) =>
                  setMinTokens({
                    value: clampInt(event.target.value, 1, 4096, 128),
                  })
                }
                aria-label='thinking 合法间隔'
              />
              <div
                className='flex flex-wrap gap-2'
                role='group'
                aria-label='max_tokens 抬升模式'
              >
                <Button
                  type='button'
                  size='sm'
                  variant={preserveCaller ? 'outline' : 'default'}
                  className='min-h-11'
                  disabled={minTokens.enabled === false}
                  onClick={() =>
                    setMinTokens({
                      mode: 'floor',
                      no_raise: false,
                      raise: true,
                    })
                  }
                >
                  默认抬升
                </Button>
                <Button
                  type='button'
                  size='sm'
                  variant={preserveCaller ? 'default' : 'outline'}
                  className='min-h-11'
                  disabled={minTokens.enabled === false}
                  onClick={() =>
                    setMinTokens({ mode: '不改', no_raise: true, raise: false })
                  }
                >
                  不改
                </Button>
              </div>
              <label className='flex items-center gap-2 text-xs text-muted-foreground'>
                <Switch
                  checked={preserveCaller}
                  disabled={minTokens.enabled === false}
                  onCheckedChange={(checked) =>
                    setMinTokens(
                      checked
                        ? { mode: '不改', no_raise: true, raise: false }
                        : { mode: 'floor', no_raise: false, raise: true }
                    )
                  }
                  aria-label='不抬升'
                />
                不抬升
              </label>
              <Switch
                checked={minTokens.enabled !== false}
                onCheckedChange={(checked) =>
                  setMinTokens({ enabled: checked })
                }
                aria-label='启用 thinking 合法间隔'
              />
            </div>
          </SettingRow>
        </CardContent>
      </Card>
      <HealthCacheCard
        probe={probe}
        real={real}
        onProbeChange={setProbe}
        onRealChange={setReal}
      />
      <SignatureRepairCard failover={failover} onChange={onFailoverChange} />
    </>
  )
}

function HealthCacheCard({
  probe,
  real,
  onProbeChange,
  onRealChange,
}: {
  probe: Obj
  real: Obj
  onProbeChange: (patch: Obj) => void
  onRealChange: (patch: Obj) => void
}) {
  const status = useQuery(healthProbeQueryOptions())
  const snaps = status.data?.snapshots
  return (
    <Card>
      <CardHeader>
        <CardTitle>健康缓存</CardTitle>
        <p className='text-xs text-muted-foreground'>
          定时用真实槽位跑一次对话并缓存结果。new-api 渠道测试、sub2api
          账号测试这类 hi / ping 请求直接回放缓存，覆盖
          Messages、Chat、Responses 的流式和非流式。
        </p>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow label='启用' desc='关闭时探测请求照常进入调度'>
          <Switch
            checked={probe.enabled === true}
            onCheckedChange={(checked) => onProbeChange({ enabled: checked })}
            aria-label='启用健康缓存'
          />
        </SettingRow>
        <SettingRow label='探测间隔' desc='秒，30–86400'>
          <DeferredIntInput
            className='w-28'
            min={30}
            max={86400}
            fallback={600}
            value={Number(probe.interval_sec ?? 600)}
            onCommit={(next) => onProbeChange({ interval_sec: next })}
            aria-label='探测间隔'
          />
        </SettingRow>
        <SettingRow
          label='全号轮询'
          desc='每个间隔对所有可调度槽各探一次（受并发上限、工作时段、冷却与凭证排除约束）。列表中首个成功的结果仍写入健康缓存；关闭时探测到第一个可用槽即停止。'
        >
          <Switch
            checked={probe.probe_all_slots === true}
            onCheckedChange={(checked) =>
              onProbeChange({ probe_all_slots: checked })
            }
            aria-label='全号轮询'
          />
        </SettingRow>
        <SettingRow label='缓存有效期' desc='秒，过期后探测请求照常进入调度'>
          <DeferredIntInput
            className='w-28'
            min={30}
            max={172800}
            fallback={900}
            value={Number(probe.cache_ttl_sec ?? 900)}
            onCommit={(next) => onProbeChange({ cache_ttl_sec: next })}
            aria-label='缓存有效期'
          />
        </SettingRow>
        <SettingRow label='Claude 探测模型' desc='在 Claude 槽上跑真实探测'>
          <Input
            className='w-56'
            value={String(real.model ?? 'claude-haiku-4-5')}
            onChange={(event) => onRealChange({ model: event.target.value })}
            aria-label='Claude 探测模型'
          />
        </SettingRow>
        <SettingRow
          label='GPT 探测模型'
          desc='在 GPT 槽上跑真实探测。留空则 GPT 模型的探测请求不走缓存。'
        >
          <Input
            className='w-56'
            placeholder='gpt-5.4'
            value={String(real.openai_model ?? '')}
            onChange={(event) =>
              onRealChange({ openai_model: event.target.value })
            }
            aria-label='GPT 探测模型'
          />
        </SettingRow>
        <SettingRow label='最近快照'>
          <div className='flex flex-col items-end gap-1 text-xs'>
            <SnapshotLine label='Claude' snap={snaps?.anthropic} />
            <SnapshotLine label='GPT' snap={snaps?.openai} />
          </div>
        </SettingRow>
      </CardContent>
    </Card>
  )
}

function SnapshotLine({
  label,
  snap,
}: {
  label: string
  snap: HealthSnapshotView | undefined
}) {
  if (!snap?.at) {
    return <span className='text-muted-foreground'>{label}：暂无</span>
  }
  const tone = snap.ok ? 'default' : snap.error ? 'destructive' : 'secondary'
  const text = snap.ok ? '可用' : snap.error ? '失败' : '已过期'
  return (
    <span className='flex items-center gap-2'>
      <span className='text-muted-foreground'>
        {label} · {snap.vm_id || '—'} · {snap.model || '—'}
      </span>
      <Badge variant={tone} title={snap.error || undefined}>
        {text}
      </Badge>
    </span>
  )
}

function SignatureRepairCard({
  failover,
  onChange,
}: {
  failover: Obj
  onChange: (next: Obj) => void
}) {
  // 默认值在 gateway HEAD 与工作区之间相反（!== false vs === true），
  // 所以不硬编码默认态，严格按 GET /routing 的实际值回显。
  const enabled = failover.signature_repair === true
  return (
    <Card>
      <CardHeader>
        <CardTitle>签名修复</CardTitle>
      </CardHeader>
      <CardContent className='flex items-start justify-between gap-4'>
        <div className='space-y-1 text-sm text-muted-foreground'>
          <p>
            上游因思考签名返回 400 时，剥掉思考历史后重试一次，客户端最终看到
            200。
          </p>
          <p>
            关闭则保留同账号的 thinking / signature
            块（缺少字段时补齐空字段），把 400 原样透传；切账号的清理和 cli-node
            自身行为不受此开关改变。 其它修复（搜索 / 预填 / 工具配对 / schema /
            自适应）不受此开关影响。
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            onChange({ ...failover, signature_repair: checked })
          }
          aria-label='签名修复'
        />
      </CardContent>
    </Card>
  )
}
