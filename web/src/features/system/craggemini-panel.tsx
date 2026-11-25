import { Check, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

type Compat = Record<string, unknown>
export type CragGeminiPersona = 'official_full' | 'zero'

export const CRAGGEMINI_SYSTEM_PROMPT_MAX = 32_768

export function cragGeminiPersonaFromCompat(
  compat: Compat | undefined
): CragGeminiPersona {
  return compat?.craggemini_persona_preset === 'zero' ? 'zero' : 'official_full'
}

export function cragGeminiGlobalPromptFromCompat(
  compat: Compat | undefined
): string {
  return typeof compat?.craggemini_system_prompt === 'string'
    ? compat.craggemini_system_prompt
    : ''
}

export function cragGeminiPromptProblem(
  compat: Compat | undefined
): string | null {
  return cragGeminiGlobalPromptFromCompat(compat).length >
    CRAGGEMINI_SYSTEM_PROMPT_MAX
    ? `craggemini_system_prompt 超过 ${CRAGGEMINI_SYSTEM_PROMPT_MAX} 字符`
    : null
}

const OPTIONS: {
  value: CragGeminiPersona
  label: string
  detail: string
}[] = [
  {
    value: 'official_full',
    label: '官方提示词',
    detail: '锁定 agy 官方提示词，调用方 system 作为附加提示词',
  },
  {
    value: 'zero',
    label: '0提示词',
    detail: '用调用方 system 直接替换 agy 官方提示词',
  },
]

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

  return (
    <div className='space-y-4'>
      <div
        role='tablist'
        aria-label='CRAGGemini 系统提示词模式'
        className='grid gap-2 sm:grid-cols-2'
      >
        {OPTIONS.map((option) => {
          const selected = option.value === active
          return (
            <button
              key={option.value}
              type='button'
              role='tab'
              aria-selected={selected}
              onClick={() =>
                onChange({ ...compat, craggemini_persona_preset: option.value })
              }
              className={cn(
                'flex cursor-pointer flex-col items-start gap-1 rounded-xl border px-3.5 py-2.5 text-left transition-colors duration-200 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                selected
                  ? 'border-primary/50 bg-primary/5'
                  : 'border-border/60 bg-card hover:border-border hover:bg-muted/40'
              )}
            >
              <span className='text-sm font-medium'>{option.label}</span>
              <span className='flex w-full items-center gap-2 text-[11px] text-muted-foreground'>
                <span>{option.detail}</span>
                {selected ? (
                  <span className='ml-auto flex shrink-0 items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400'>
                    <Check className='size-3' aria-hidden />
                    生效
                  </span>
                ) : null}
              </span>
            </button>
          )
        })}
      </div>

      <div className='space-y-2 rounded-xl border bg-card px-5 py-4 sm:px-6'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <Label htmlFor='craggemini-global-system-prompt' className='text-sm font-medium'>
            全局系统提示词（可选）
          </Label>
          <div className='flex items-center gap-2'>
            <span
              className={cn(
                'text-xs tabular-nums',
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
                className='h-7 px-2 text-xs'
                onClick={() =>
                  onChange({ ...compat, craggemini_system_prompt: '' })
                }
              >
                <RotateCcw className='mr-1 size-3' aria-hidden />
                清空
              </Button>
            ) : null}
          </div>
        </div>
        <Textarea
          id='craggemini-global-system-prompt'
          rows={4}
          value={globalPrompt}
          placeholder={
            active === 'official_full'
              ? '留空则仅保留 agy 官方提示词并透传调用方 system；填写后将与调用方 system 一并作为附加提示词追加。'
              : '留空则完全按调用方请求的 system 替换官方提示词（无 system 时清空为 0 提示词）；填写后将作为默认/前置系统提示词。'
          }
          onChange={(e) =>
            onChange({ ...compat, craggemini_system_prompt: e.target.value })
          }
          className='font-mono text-xs'
        />
      </div>

      <div className='space-y-3 rounded-xl border bg-card px-5 py-4 text-sm leading-6 text-muted-foreground sm:px-6'>
        <p>
          针对原生 CRAGGemini（官方 Antigravity CLI <code>agy 1.5.9</code> +{' '}
          <code>libagy_bridge.so</code>），通过底层 Hook{' '}
          <code>(*modelAPIAdapter).Generate</code> 直接读写{' '}
          <code>modelapiinterface.ModelRequest.SystemPrompt</code>（
          <code>+0x10/+0x18</code>），同时覆盖 Code Assist OAuth 与 Gemini API
          路径，不再把 <code>systemInstruction</code> 混入用户消息正文。
        </p>
        {active === 'official_full' ? (
          <p>
            <strong>官方提示词模式</strong>：锁定 <code>agy</code> 原生渲染的完整官方提示词（含{' '}
            <code>AGENTS.md</code> / <code>GEMINI.md</code> /{' '}
            <code>user_global</code> 规则段）不改动；调用方请求的{' '}
            <code>system</code> / <code>systemInstruction</code>{' '}
            经安全清洗（剥离 Anthropic 计费归因头）后作为附加提示词追加到{' '}
            <code>SystemPrompt</code> 末尾。调用方未传 system 时保持官方字节级原样。
          </p>
        ) : (
          <p>
            <strong>0提示词模式</strong>：根据调用方请求携带的{' '}
            <code>system</code> / <code>systemInstruction</code>{' '}
            直接替换原本的 <code>agy</code> 官方系统提示词；若调用方未携带 system
            且未配置全局提示词，则发送空串 <code>&quot;&quot;</code>（0 提示词）。子代理独立会话仍保留其原有提示词。
          </p>
        )}
        <ul className='list-disc space-y-1 pl-5'>
          <li>
            请求级字段：<code>system</code>、<code>systemInstruction</code>、
            <code>system_instruction</code>、<code>instructions</code> 与{' '}
            <code>role: system/developer</code> 消息均统一汇总并经安全清洗后进入{' '}
            <code>ModelRequest.SystemPrompt</code>。
          </li>
          <li>
            用户规则发现：<code>agy</code> 原生从 <code>~/.gemini/</code>（
            <code>user_global</code>）与工作区 <code>AGENTS.md</code> /{' '}
            <code>GEMINI.md</code> / <code>.agents</code> 加载规则；切换为 0
            提示词时会连同官方默认段一起被调用方 <code>system</code> 替换。
          </li>
          <li>
            旧版 bridge 兼容：未宣告 <code>system_prompt_hook_v1</code>{' '}
            的旧载荷仍按默认官方模式平滑降级，不会阻断已有槽位流量。
          </li>
        </ul>
      </div>
    </div>
  )
}
