import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

type Compat = Record<string, unknown>
export type CragPrintPersona = 'official_full' | 'zero'

export function cragPersonaFromCompat(
  compat: Compat | undefined
): CragPrintPersona {
  return compat?.crag_persona_preset === 'zero' ? 'zero' : 'official_full'
}

const OPTIONS: { value: CragPrintPersona; label: string; detail: string }[] = [
  {
    value: 'official_full',
    label: '官方完整',
    detail: '只 append 调用方尾巴',
  },
  {
    value: 'zero',
    label: '0注入',
    detail: 'crag_prompt.mode=replace',
  },
]

export function CragPrintPanel({
  compat,
  onChange,
}: {
  compat: Compat
  onChange: (next: Compat) => void
}) {
  const active = cragPersonaFromCompat(compat)
  return (
    <div className='space-y-4'>
      <div
        role='tablist'
        aria-label='CRAG print 人设'
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
                onChange({ ...compat, crag_persona_preset: option.value })
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
      <div className='space-y-3 rounded-xl border bg-card px-5 py-4 text-sm leading-6 text-muted-foreground sm:px-6'>
        <p>
          这套只给 CRAG v2 print worker（官方二进制
          claude-code-2.1.317）。vm2api 不走 TUI。
          <code className='mx-1'>kernel.json</code>的{' '}
          <code>persona_preset</code> 和 <code>CLAUDE_CODE_SYSTEM_LAYOUT</code>{' '}
          这条路径不读。
        </p>
        {active === 'official_full' ? (
          <p>
            不把官方四块 system 再贴进去，只 append 调用方剩余文本。≤ 64 KiB 走{' '}
            <code>--append-system-prompt</code>
            ；更长由 helper 写进用户消息，不是 system 缓存块。没有尾巴就不发
            system 旗标，四块仍是 CLI 自己写的。
          </p>
        ) : (
          <p>
            裸 <code>system</code> 在 v2 里仍是 append，所以 0注入必须{' '}
            <code>crag_prompt.mode=replace</code>。不要用 <code>--bare</code>
            ，OAuth 槽会被切成只认 API key。replace 超过 64 KiB 直接
            400，不假装换掉。
            <code>--system-prompt</code> 会不会换掉
            identity/harness/guidance，2.1.303
            抓包没复测，未证实。旗标说明来自恢复出的 2.1.293，比 worker 钉的
            2.1.317 旧。没有调用方文本时发不出 replace。
          </p>
        )}
        <ul className='list-disc space-y-1 pl-5'>
          <li>
            今天进官方 CLI 的只有 <code>--model</code>、64 KiB 的 append/replace
            文本、preload 改写的 <code>max_tokens</code> / <code>effort</code> /
            已有 cache marker 的 ttl，以及调用方工具变 MCP。
          </li>
          <li>
            print 上内置工具和 Chrome 都还开着。
            <code>--tools &quot;&quot;</code> 和 <code>--no-chrome</code> 只有
            TUI，这条 worker 不加。
          </li>
          <li>
            thinking、temperature、betas、system 上的 cache_control
            协议层收了，helper 不转发。
          </li>
          <li>
            「只要 identity」没有旗标。自定义模板不进 CRAG。槽位显式 0注入走
            replace；其它槽位档收成 append 尾巴。
          </li>
        </ul>
      </div>
    </div>
  )
}
