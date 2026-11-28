import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PersonaPreset } from '@/types/panel-routing'
import {
  Check,
  ChevronDown,
  Copy,
  EyeOff,
  Layers,
  ShieldCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  CLI_IDENTITY,
  PREVIEW_CALLER_AGENT,
  PREVIEW_CALLER_SYSTEM,
  PREVIEW_REQUEST_VARS,
  agentStandingVar,
  applyPersonaEnvVars,
  dropLegacyAutoScope,
  envTimezoneText,
  estimateTokens,
  isPresetEnvEnabled,
  isPresetGuidanceEnabled,
  migrateLegacyOfficialTemplate,
  personaHideEnabled,
  presetFlagEnabled,
  previewBillingVars,
  previewModelSentence,
  previewSystemBlocks,
  selectedPreviewBlocks,
  templateBlockEnabled,
  type RawBlock,
} from '@/lib/persona-template'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  anthropicPresetLabel,
  promptBlockCategory,
  promptBlockLabel,
  splitLongPreviewBlock,
  type PromptLayerCategory,
} from './prompt-presentation'
import { personaPreviewVarsQueryOptions } from './queries'
import {
  buildAnthropicRawJsonPayload,
  type RenderedPreviewBlock,
} from './raw-json'
import { RawJsonDisclosure } from './raw-json-panel'

const LAYER_BADGE_STYLE: Record<PromptLayerCategory, string> = {
  billing: 'bg-muted text-muted-foreground border-border/60',
  identity: 'bg-ok-1 text-ok-5 border-ok-2/60 dark:bg-ok-1/70',
  core: 'bg-select-surface text-select-fg border-select-border/40',
  guidance:
    'bg-(--tier-max-badge-bg) text-(--tier-max-fg) border-(--tier-max-border)/50',
  environment:
    'bg-(--tier-gemini-surface-hover) text-(--tier-gemini-fg) border-(--tier-gemini-border)/50',
  caller:
    'bg-caution-1 text-caution-5 border-caution-2/60 dark:bg-caution-1/75',
  custom: 'bg-secondary text-secondary-foreground border-border/60',
}

/** 常驻约束与调用方占位高亮，其余原样。 */
function highlight(text: string, marks: string[]): ReactNode[] {
  const needles = marks.filter(Boolean)
  const out: ReactNode[] = []
  let rest = text
  let key = 0
  while (rest) {
    let at = -1
    let hit = ''
    for (const needle of needles) {
      const idx = rest.indexOf(needle)
      if (idx >= 0 && (at < 0 || idx < at)) {
        at = idx
        hit = needle
      }
    }
    if (at < 0) {
      out.push(rest)
      break
    }
    if (at > 0) out.push(rest.slice(0, at))
    out.push(
      <mark
        key={key++}
        className='rounded-sm bg-primary/12 px-0.5 text-foreground ring-1 ring-primary/25'
      >
        {hit}
      </mark>
    )
    rest = rest.slice(at + hit.length)
  }
  return out
}

function PreviewLayerCard({
  block,
  index,
  isLast,
  masked,
  blockMasked,
  marks,
}: {
  block: RenderedPreviewBlock
  index: number
  isLast: boolean
  masked: boolean
  blockMasked: boolean
  marks: string[]
}) {
  const [expanded, setExpanded] = useState(false)
  const [label] = promptBlockLabel(block.id)
  const category = promptBlockCategory(block.id)
  const split = useMemo(
    () =>
      block.placeholder
        ? ({ kind: 'short', head: '' } as const)
        : splitLongPreviewBlock(block.text),
    [block.placeholder, block.text]
  )
  const isLong = split.kind !== 'short'
  const delayMs = Math.min(index * 28, 140)

  return (
    <li
      className='animate-prompt-layer-in relative flex gap-3'
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <div className='relative flex flex-col items-center pt-2.5'>
        <span className='z-10 flex size-6 shrink-0 items-center justify-center rounded-full border border-border/80 bg-card font-mono text-[11px] font-medium text-muted-foreground tabular-nums'>
          {index + 1}
        </span>
        {!isLast ? (
          <span aria-hidden className='mt-1.5 w-px flex-1 bg-border/65' />
        ) : null}
      </div>

      <div className='min-w-0 flex-1 overflow-hidden rounded-xl border border-border/70 bg-card transition-colors duration-150 hover:border-border'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border/50 bg-muted/25 px-3.5 py-2'>
          <span
            className={cn(
              'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium',
              LAYER_BADGE_STYLE[category]
            )}
          >
            {label}
          </span>
          <span className='font-mono text-[11px] text-muted-foreground'>
            {block.region}
          </span>
          <span className='ml-auto flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted-foreground'>
            {block.ttl ? (
              <span className='rounded bg-muted px-1.5 py-0.5 text-[10px]'>
                ttl {block.ttl}
              </span>
            ) : null}
            {block.scope ? (
              <span className='rounded bg-muted px-1.5 py-0.5 text-[10px]'>
                {block.scope}
              </span>
            ) : null}
            {masked ? (
              <span
                className='inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px]'
                title={blockMasked ? '注入块不计 usage' : '常驻约束不计 usage'}
              >
                <EyeOff className='size-3' aria-hidden />
                {blockMasked ? '遮罩' : '约束遮罩'}
              </span>
            ) : null}
            <span className='tabular-nums'>
              ≈{estimateTokens(block.text)} tok
            </span>
          </span>
        </div>

        {block.placeholder ? (
          <p className='px-3.5 py-2.5 text-xs text-muted-foreground italic'>
            零宽占位
          </p>
        ) : (
          <div className='px-3.5 py-3'>
            {split.kind === 'short' ? (
              <pre className='font-mono text-xs leading-6 break-words whitespace-pre-wrap text-foreground/90'>
                {highlight(split.head, marks)}
              </pre>
            ) : split.kind === 'lines' ? (
              <>
                <div className='relative'>
                  <pre className='font-mono text-xs leading-6 break-words whitespace-pre-wrap text-foreground/90'>
                    {highlight(split.head, marks)}
                  </pre>
                  {!expanded ? (
                    <div
                      aria-hidden
                      className='pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-card via-card/75 to-transparent'
                    />
                  ) : null}
                </div>
                <div
                  className='prompt-accordion'
                  data-open={expanded ? 'true' : 'false'}
                  aria-hidden={!expanded}
                >
                  <div className='prompt-accordion-inner'>
                    <pre className='font-mono text-xs leading-6 break-words whitespace-pre-wrap text-foreground/90'>
                      {highlight(split.tail, marks)}
                    </pre>
                  </div>
                </div>
              </>
            ) : expanded ? (
              <pre className='animate-prompt-pane-in font-mono text-xs leading-6 break-words whitespace-pre-wrap text-foreground/90'>
                {highlight(split.full, marks)}
              </pre>
            ) : (
              <div className='relative'>
                <pre className='font-mono text-xs leading-6 break-words whitespace-pre-wrap text-foreground/90'>
                  {highlight(split.excerpt, marks)}
                </pre>
                <div
                  aria-hidden
                  className='pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-card via-card/75 to-transparent'
                />
              </div>
            )}
            {isLong ? (
              <button
                type='button'
                aria-expanded={expanded}
                onClick={() => setExpanded((prev) => !prev)}
                className='mt-2 inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors duration-150 hover:bg-primary/10 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none'
              >
                <ChevronDown
                  className={cn(
                    'size-3.5 transition-transform duration-200',
                    expanded && 'rotate-180'
                  )}
                  aria-hidden
                />
                {expanded
                  ? '收起内容'
                  : `展开全文（${block.text.length} 字符）`}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </li>
  )
}

export function SystemPreview({
  preset,
  blocks,
  compat,
}: {
  preset: PersonaPreset
  blocks: RawBlock[]
  compat: Record<string, unknown>
}) {
  const dash = useQuery(dashboardQueryOptions())
  const [withCaller, setWithCaller] = useState(true)
  const [copied, setCopied] = useState(false)
  const zones = [
    ...new Set(
      (dash.data?.vms || [])
        .filter((vm) => !isCodexVm(vm))
        .map((vm) => String(vm.timezone || '').trim() || 'UTC')
    ),
  ].sort()
  const [picked, setPicked] = useState('')
  const [previewModel, setPreviewModel] = useState('claude-sonnet-5-5')
  const timezone = zones.includes(picked) ? picked : zones[0] || 'UTC'

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  // 等槽位列表回来再取常量，否则 env_official 会先按 UTC 渲染一遍。
  const vars = useQuery({
    ...personaPreviewVarsQueryOptions(timezone),
    enabled: !dash.isLoading,
  })

  const standing = agentStandingVar(compat, preset).trimEnd()
  const envOn = isPresetEnvEnabled(compat, preset)
  const usagePassthrough = presetFlagEnabled(
    compat,
    'usage_passthrough_presets',
    preset
  )
  const standingMasked =
    !!standing &&
    !usagePassthrough &&
    presetFlagEnabled(compat, 'agent_standing_hide_presets', preset)
  const blocksMasked =
    !usagePassthrough && personaHideEnabled(compat, preset, blocks)
  const selected = selectedPreviewBlocks(
    migrateLegacyOfficialTemplate(preset, blocks),
    compat,
    preset
  )
  const timezoneOnly =
    preset === 'official_full' &&
    blocks.some((block) => block.id === 'env_official') &&
    !templateBlockEnabled(compat, preset, 'env_official')
  const env = envTimezoneText(timezone)
  const previewVars = vars.data
    ? applyPersonaEnvVars(
        {
          ...vars.data.vars,
          ...PREVIEW_REQUEST_VARS,
          ...previewBillingVars(compat, vars.data.vars.cli_version),
          identity: CLI_IDENTITY,
          identity_cli: CLI_IDENTITY,
          guidance_303: isPresetGuidanceEnabled(compat, preset)
            ? vars.data.vars.guidance_303 || ''
            : '',
          timezone,
          env_timezone_only: env,
          env_timezone:
            vars.data.vars.env_timezone || ` - Timezone: ${timezone}`,
          env_locale: vars.data.vars.env_locale || ' - Language: en-US',
          env_official: timezoneOnly ? env : vars.data.vars.env_official,
          env,
          agent_standing: agentStandingVar(compat, preset),
          caller_agent: withCaller ? PREVIEW_CALLER_AGENT : '',
          caller_system: withCaller ? PREVIEW_CALLER_SYSTEM : '',
          model: previewModel,
          model_sentence: previewModelSentence(compat, previewModel, preset),
        },
        compat,
        preset
      )
    : null
  const source = dropLegacyAutoScope(preset, selected)
  const rendered: RenderedPreviewBlock[] = previewVars
    ? previewSystemBlocks(source, previewVars, {
        preserveCallerSystem: preset === 'zero',
        includeBilling: true,
      }).map((block) => ({
        ...block,
        region:
          block.id === 'caller_system' &&
          source.some((template) => template.id === 'caller_system')
            ? 'messages · 首条 user'
            : block.role === 'system'
              ? 'messages · role=system'
              : 'system',
      }))
    : []
  const plain = rendered.map((block) => block.text).join('\n\n')
  const marks = [standing, PREVIEW_CALLER_AGENT, PREVIEW_CALLER_SYSTEM]
  const totalTokens = estimateTokens(plain)

  return (
    <div className='flex flex-col overflow-hidden rounded-2xl border border-border/75 bg-card'>
      <div className='space-y-3 border-b border-border/60 px-5 py-4'>
        <div className='flex flex-wrap items-center gap-2'>
          <Layers className='size-4 text-primary' aria-hidden />
          <h3 className='text-base font-semibold tracking-tight'>出站预览</h3>
          <Badge variant='secondary' className='font-normal'>
            {anthropicPresetLabel(preset)}
          </Badge>
          {rendered.length ? (
            <span className='rounded-md bg-muted/70 px-2 py-0.5 font-mono text-[11px] text-muted-foreground tabular-nums'>
              {rendered.length} 层 · ≈{totalTokens} tok
            </span>
          ) : null}
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='ml-auto h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground'
            aria-label='复制 system prompt'
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
            {copied ? '已复制' : '复制全文'}
          </Button>
        </div>

        <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
          {envOn ? (
            <Select value={timezone} onValueChange={setPicked}>
              <SelectTrigger
                size='sm'
                className='h-7 cursor-pointer font-mono text-[11px]'
                aria-label='预览用槽位时区'
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(zones.length ? zones : ['UTC']).map((zone) => (
                  <SelectItem
                    key={zone}
                    value={zone}
                    className='font-mono text-xs'
                  >
                    {zone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {envOn &&
          presetFlagEnabled(compat, 'model_env_extra_presets', preset) ? (
            <Select value={previewModel} onValueChange={setPreviewModel}>
              <SelectTrigger
                size='sm'
                className='h-7 cursor-pointer font-mono text-[11px]'
                aria-label='预览用模型'
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  'claude-sonnet-5-5',
                  'claude-haiku-5-5',
                  'claude-opus-5-5',
                  ...Object.keys(
                    compat.model_env_extra &&
                      typeof compat.model_env_extra === 'object' &&
                      !Array.isArray(compat.model_env_extra)
                      ? (compat.model_env_extra as Record<string, string>)
                      : {}
                  ),
                ]
                  .filter((id, index, all) => all.indexOf(id) === index)
                  .map((id) => (
                    <SelectItem
                      key={id}
                      value={id}
                      className='font-mono text-xs'
                    >
                      {id}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          ) : null}
          <label className='ml-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground'>
            <Switch
              aria-label='显示调用方示例（仅预览）'
              aria-describedby='preview-caller-effect'
              checked={withCaller}
              onCheckedChange={setWithCaller}
            />
            <span>调用方示例</span>
          </label>
        </div>

        {!withCaller ? (
          <p
            id='preview-caller-effect'
            className='text-xs text-muted-foreground'
          >
            仅隐藏预览中的调用方占位，不影响实际请求中的 system 透传。
          </p>
        ) : (
          <span id='preview-caller-effect' className='sr-only'>
            关闭仅隐藏调用方提示词示例，不修改实际请求。
          </span>
        )}
      </div>

      <div className='max-h-[68svh] min-h-64 flex-1 space-y-4 overflow-y-auto px-5 py-4'>
        {preset === 'zero' ? (
          <div
            data-testid='zero-inject-callout'
            className='animate-prompt-pane-in rounded-xl border border-ok-2/70 bg-ok-1/45 px-4 py-3 dark:bg-ok-1/30'
          >
            <div className='flex items-center gap-2 text-sm font-medium text-ok-5'>
              <ShieldCheck className='size-4 shrink-0' aria-hidden />
              <span>0 注入直通模式</span>
            </div>
            <div className='mt-2 grid gap-2 text-xs sm:grid-cols-3'>
              <div className='rounded-lg bg-card/80 px-2.5 py-2'>
                <span className='block text-[11px] text-muted-foreground'>
                  计费归因
                </span>
                <span className='font-medium text-foreground'>
                  prompt_version 携带身份
                </span>
              </div>
              <div className='rounded-lg bg-card/80 px-2.5 py-2'>
                <span className='block text-[11px] text-muted-foreground'>
                  注入系统块
                </span>
                <span className='font-medium text-foreground'>
                  0 块（无核心与环境）
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

        {vars.isLoading || dash.isLoading ? (
          <div className='space-y-3'>
            <Skeleton className='h-16 w-full rounded-xl' />
            <Skeleton className='h-28 w-full rounded-xl' />
            <Skeleton className='h-20 w-full rounded-xl' />
          </div>
        ) : vars.error ? (
          <p className='rounded-xl border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-xs text-destructive'>
            {(vars.error as Error).message}
          </p>
        ) : rendered.length ? (
          <ol key={preset} className='space-y-3'>
            {rendered.map((block, i) => {
              const blockMasked = blocksMasked && block.hide
              const masked =
                blockMasked || (standingMasked && block.text.includes(standing))
              return (
                <PreviewLayerCard
                  key={`${block.id}-${i}`}
                  block={block}
                  index={i}
                  isLast={i === rendered.length - 1}
                  masked={masked}
                  blockMasked={blockMasked}
                  marks={marks}
                />
              )
            })}
          </ol>
        ) : (
          <p className='rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-xs text-muted-foreground'>
            当前配置无出站 system 块
          </p>
        )}
      </div>

      <div className='space-y-3 border-t border-border/60 bg-muted/20 px-5 py-3.5'>
        {preset !== 'zero' ? (
          <RawJsonDisclosure
            mode={preset}
            buildPayload={() => buildAnthropicRawJsonPayload(preset, rendered)}
          />
        ) : null}
        {rendered.length ? (
          <div className='flex items-center justify-between font-mono text-[11px] text-muted-foreground tabular-nums'>
            <span>共 {rendered.length} 层</span>
            <span>
              {plain.length} 字符 · ≈{totalTokens} tok
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
