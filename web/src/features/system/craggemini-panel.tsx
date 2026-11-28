import { useEffect, useState } from 'react'
import { Check, Copy, Layers, RotateCcw, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { PREVIEW_CALLER_SYSTEM, estimateTokens } from '@/lib/persona-template'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  CRAGGEMINI_SYSTEM_PROMPT_MAX,
  buildGoogleRawJsonPayload,
  cragGeminiGlobalPromptFromCompat,
  cragGeminiPersonaFromCompat,
  type CragGeminiPersona,
} from './google-prompt'
import { RawJsonDisclosure } from './raw-json-panel'
import { SlidingTabs } from './sliding-tabs'

type Compat = Record<string, unknown>

const GOOGLE_MODE_OPTIONS: readonly {
  value: CragGeminiPersona
  label: string
  description: string
}[] = [
  {
    value: 'official_full',
    label: '官方提示词',
    description: '保留官方基础提示词，追加全局与调用方 system',
  },
  {
    value: 'zero',
    label: '0注入',
    description: '不注入官方提示词，仅发送全局或调用方 system',
  },
]

type GoogleLayer = {
  id: string
  label: string
  placement: string
  tone: string
  text: string
  highlighted?: boolean
}

function GooglePromptPreview({
  mode,
  globalPrompt,
}: {
  mode: CragGeminiPersona
  globalPrompt: string
}) {
  const [withCaller, setWithCaller] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  const trimmedGlobal = globalPrompt.trim()
  const layers: GoogleLayer[] = []

  if (mode === 'official_full') {
    layers.push({
      id: 'google_official',
      label: '官方提示词',
      placement: 'system · 锁定原样',
      tone: 'bg-ok-1 text-ok-5 border-ok-2/60 dark:bg-ok-1/70',
      text: '保留 Google 官方系统提示词与工作区规则原样出站。',
    })
  }
  if (trimmedGlobal) {
    layers.push({
      id: 'google_global',
      label: '全局系统提示词',
      placement: mode === 'official_full' ? 'system · 追加' : 'system · 前置',
      tone: 'bg-select-surface text-select-fg border-select-border/40',
      text: globalPrompt,
    })
  }
  if (withCaller) {
    layers.push({
      id: 'caller_system',
      label: '调用方提示词',
      placement: mode === 'official_full' ? 'system · 追加' : 'system · 直通',
      tone: 'bg-caution-1 text-caution-5 border-caution-2/60 dark:bg-caution-1/75',
      text: PREVIEW_CALLER_SYSTEM,
      highlighted: true,
    })
  }

  const plain = layers.map((layer) => layer.text).join('\n\n')
  const totalTokens = estimateTokens(plain)

  return (
    <div className='flex flex-col overflow-hidden rounded-2xl border border-border/75 bg-card'>
      <div className='space-y-3 border-b border-border/60 px-5 py-4'>
        <div className='flex flex-wrap items-center gap-2'>
          <Layers className='size-4 text-primary' aria-hidden />
          <h3 className='text-base font-semibold tracking-tight'>出站预览</h3>
          <Badge variant='secondary' className='font-normal'>
            {mode === 'zero' ? '0注入' : '官方提示词'}
          </Badge>
          <span className='rounded-md bg-muted/70 px-2 py-0.5 font-mono text-[11px] text-muted-foreground tabular-nums'>
            {layers.length} 层
          </span>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='ml-auto h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground'
            aria-label='复制 Google 提示词预览'
            disabled={!plain}
            onClick={() => {
              void navigator.clipboard.writeText(plain)
              setCopied(true)
              toast.success('已复制')
            }}
          >
            {copied ? (
              <Check className='size-3.5 text-primary' aria-hidden />
            ) : (
              <Copy className='size-3.5' aria-hidden />
            )}
            {copied ? '已复制' : '复制预览'}
          </Button>
        </div>

        <div className='flex items-center justify-end'>
          <label className='flex cursor-pointer items-center gap-2 text-xs text-muted-foreground'>
            <Switch
              aria-label='显示调用方示例（仅预览）'
              checked={withCaller}
              onCheckedChange={setWithCaller}
            />
            <span>调用方示例</span>
          </label>
        </div>
      </div>

      <div className='min-h-60 flex-1 space-y-4 px-5 py-4'>
        {mode === 'zero' ? (
          <div
            data-testid='google-zero-callout'
            className='animate-prompt-pane-in rounded-xl border border-ok-2/70 bg-ok-1/45 px-4 py-3 dark:bg-ok-1/30'
          >
            <div className='flex items-center gap-2 text-sm font-medium text-ok-5'>
              <ShieldCheck className='size-4 shrink-0' aria-hidden />
              <span>0 注入直通模式</span>
            </div>
            <div className='mt-2 grid gap-2 text-xs sm:grid-cols-3'>
              <div className='rounded-lg bg-card/80 px-2.5 py-2'>
                <span className='block text-[11px] text-muted-foreground'>
                  官方基座
                </span>
                <span className='font-medium text-foreground'>
                  0 注入（已关闭）
                </span>
              </div>
              <div className='rounded-lg bg-card/80 px-2.5 py-2'>
                <span className='block text-[11px] text-muted-foreground'>
                  全局提示词
                </span>
                <span className='font-medium text-foreground'>
                  {trimmedGlobal ? '已配置前置段' : '未配置'}
                </span>
              </div>
              <div className='rounded-lg bg-card/80 px-2.5 py-2'>
                <span className='block text-[11px] text-muted-foreground'>
                  业务 system
                </span>
                <span className='font-medium text-foreground'>
                  调用方原样直通
                </span>
              </div>
            </div>
          </div>
        ) : null}

        {layers.length ? (
          <ol key={mode} className='space-y-3'>
            {layers.map((layer, index) => (
              <li
                key={layer.id}
                className='animate-prompt-layer-in relative flex gap-3'
                style={{ animationDelay: `${Math.min(index * 30, 120)}ms` }}
              >
                <div className='relative flex flex-col items-center pt-2.5'>
                  <span className='z-10 flex size-6 shrink-0 items-center justify-center rounded-full border border-border/80 bg-card font-mono text-[11px] font-medium text-muted-foreground tabular-nums'>
                    {index + 1}
                  </span>
                  {index < layers.length - 1 ? (
                    <span
                      aria-hidden
                      className='mt-1.5 w-px flex-1 bg-border/65'
                    />
                  ) : null}
                </div>
                <div className='min-w-0 flex-1 overflow-hidden rounded-xl border border-border/70 bg-card'>
                  <div className='flex flex-wrap items-center gap-2 border-b border-border/50 bg-muted/25 px-3.5 py-2'>
                    <span
                      className={cn(
                        'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium',
                        layer.tone
                      )}
                    >
                      {layer.label}
                    </span>
                    <span className='font-mono text-[11px] text-muted-foreground'>
                      {layer.placement}
                    </span>
                  </div>
                  <pre className='px-3.5 py-3 font-mono text-xs leading-6 break-words whitespace-pre-wrap text-foreground/90'>
                    {layer.highlighted ? (
                      <mark className='rounded-sm bg-primary/12 px-0.5 text-foreground ring-1 ring-primary/25'>
                        {layer.text}
                      </mark>
                    ) : (
                      layer.text
                    )}
                  </pre>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className='rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-xs text-muted-foreground'>
            全局与调用方提示词均为空，出站将发送空系统提示词。
          </div>
        )}
      </div>

      <div className='space-y-3 border-t border-border/60 bg-muted/20 px-5 py-3.5'>
        {mode !== 'zero' ? (
          <RawJsonDisclosure
            mode={mode}
            buildPayload={() =>
              buildGoogleRawJsonPayload(mode, globalPrompt, withCaller)
            }
          />
        ) : null}
        <div className='flex items-center justify-between font-mono text-[11px] text-muted-foreground tabular-nums'>
          <span>共 {layers.length} 层</span>
          <span>
            {plain.length} 字符 · ≈{totalTokens} tok
          </span>
        </div>
      </div>
    </div>
  )
}

export function CragGeminiPanel({
  compat,
  onChange,
}: {
  compat: Compat
  onChange: (next: Compat) => void
}) {
  const active = cragGeminiPersonaFromCompat(compat)
  const globalPrompt = cragGeminiGlobalPromptFromCompat(compat)
  const overLimit = globalPrompt.length > CRAGGEMINI_SYSTEM_PROMPT_MAX

  const modeTabs = GOOGLE_MODE_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
    badge:
      option.value === active ? (
        <span className='inline-flex items-center gap-1 rounded-full bg-ok-1 px-2 py-0.5 text-[10px] font-medium text-ok-5 dark:bg-ok-1/80'>
          <Check className='size-2.5' aria-hidden />
          生效中
        </span>
      ) : null,
  }))

  return (
    <div className='space-y-5'>
      <SlidingTabs
        variant='cards'
        ariaLabel='Google 系统提示词模式'
        items={modeTabs}
        value={active}
        onChange={(nextMode) =>
          onChange({ ...compat, craggemini_persona_preset: nextMode })
        }
        className='grid-cols-1 sm:grid-cols-2'
      />

      <div className='grid items-start gap-5 xl:grid-cols-[minmax(0,25.5rem)_minmax(0,1fr)]'>
        <aside aria-label='Google 提示词配置' className='min-w-0'>
          <div className='overflow-hidden rounded-2xl border border-border/75 bg-card'>
            <div className='flex items-center justify-between gap-2 border-b border-border/60 px-5 py-4'>
              <h3 className='text-base font-semibold tracking-tight'>
                {active === 'zero' ? '0注入' : '官方提示词'}
              </h3>
              <span className='rounded-full bg-ok-1 px-2.5 py-0.5 text-[11px] font-medium text-ok-5 dark:bg-ok-1/80'>
                当前生效
              </span>
            </div>

            <div
              key={active}
              className='animate-prompt-pane-in space-y-4 px-5 py-4'
            >
              <div className='space-y-2'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <Label
                    htmlFor='google-global-system-prompt'
                    className='text-sm font-medium'
                  >
                    全局系统提示词（可选）
                  </Label>
                  <div className='flex items-center gap-2'>
                    <span
                      className={cn(
                        'font-mono text-xs tabular-nums',
                        overLimit ? 'text-destructive' : 'text-muted-foreground'
                      )}
                    >
                      {globalPrompt.length} / {CRAGGEMINI_SYSTEM_PROMPT_MAX}
                    </span>
                    {globalPrompt ? (
                      <Button
                        type='button'
                        variant='ghost'
                        size='sm'
                        className='h-7 gap-1 px-2 text-xs'
                        onClick={() =>
                          onChange({ ...compat, craggemini_system_prompt: '' })
                        }
                      >
                        <RotateCcw className='size-3' aria-hidden />
                        清空
                      </Button>
                    ) : null}
                  </div>
                </div>
                <Textarea
                  id='google-global-system-prompt'
                  rows={5}
                  value={globalPrompt}
                  aria-invalid={overLimit || undefined}
                  placeholder={
                    active === 'official_full'
                      ? '留空仅保留 Google 官方提示词并追加调用方 system；填写后将与调用方 system 一并追加。'
                      : '留空则直接使用调用方请求的 system（均为空时发送空提示词）；填写后将作为前置系统提示词。'
                  }
                  onChange={(e) =>
                    onChange({
                      ...compat,
                      craggemini_system_prompt: e.target.value,
                    })
                  }
                  className='font-mono text-xs leading-6'
                />
                {overLimit ? (
                  <p className='text-xs text-destructive'>
                    Google 全局系统提示词超过 {CRAGGEMINI_SYSTEM_PROMPT_MAX}{' '}
                    字符
                  </p>
                ) : null}
              </div>

              <div className='space-y-2 border-t border-border/60 pt-4 text-xs leading-5 text-muted-foreground'>
                <p>
                  {active === 'official_full'
                    ? '保留 Google 官方系统提示词不作改动；调用方传入的 system / systemInstruction 经安全清洗后追加到末尾。'
                    : '不注入 Google 官方系统提示词；调用方传入的 system / systemInstruction 直接作为系统提示词出站，均为空时发送空串。'}
                </p>
                <p>
                  统一汇总请求中的 system、systemInstruction、instructions 与
                  system/developer 消息。
                </p>
              </div>
            </div>
          </div>
        </aside>

        <section
          aria-label='Google 出站预览'
          className='min-w-0 xl:sticky xl:top-20'
        >
          <GooglePromptPreview mode={active} globalPrompt={globalPrompt} />
        </section>
      </div>
    </div>
  )
}
