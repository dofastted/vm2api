import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PersonaPreset } from '@/types/panel-routing'
import { Copy, EyeOff, FileText } from 'lucide-react'
import { toast } from 'sonner'
import {
  PREVIEW_CALLER_AGENT,
  PREVIEW_CALLER_SYSTEM,
  PREVIEW_REQUEST_VARS,
  agentStandingVar,
  applyPersonaEnvVars,
  dropLegacyAutoScope,
  envTimezoneText,
  estimateTokens,
  personaHideEnabled,
  personaPresetLabel,
  presetFlagEnabled,
  previewModelSentence,
  previewSystemBlocks,
  selectedPreviewBlocks,
  templateBlockEnabled,
  type RawBlock,
} from '@/lib/persona-template'
import { isCodexVm } from '@/lib/vm-kind'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { promptBlockLabel } from './prompt-presentation'
import { personaPreviewVarsQueryOptions } from './queries'

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
        className='rounded-sm bg-primary/10 px-0.5 text-foreground ring-1 ring-primary/20'
      >
        {hit}
      </mark>
    )
    rest = rest.slice(at + hit.length)
  }
  return out
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
  // 等槽位列表回来再取常量，否则 env_official 会先按 UTC 渲染一遍。
  const vars = useQuery({
    ...personaPreviewVarsQueryOptions(timezone),
    enabled: !dash.isLoading,
  })

  const standing = agentStandingVar(compat, preset).trimEnd()
  const standingMasked =
    !!standing &&
    presetFlagEnabled(compat, 'agent_standing_hide_presets', preset)
  const blocksMasked = personaHideEnabled(compat, preset, blocks)
  const selected = selectedPreviewBlocks(blocks, compat, preset)
  const timezoneOnly =
    preset === 'official_full' &&
    !templateBlockEnabled(compat, preset, 'env_official')
  const env = envTimezoneText(timezone)
  const previewVars = vars.data
    ? applyPersonaEnvVars(
        {
          ...vars.data.vars,
          ...PREVIEW_REQUEST_VARS,
          timezone,
          env_timezone_only: env,
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
  const rendered = previewVars
    ? previewSystemBlocks(source, previewVars).map((block) => ({
        ...block,
        region: 'system',
      }))
    : []
  const plain = rendered.map((block) => block.text).join('\n\n')
  const marks = [standing, PREVIEW_CALLER_AGENT, PREVIEW_CALLER_SYSTEM]

  return (
    <Card className='h-[70svh] min-h-80 gap-3 overflow-hidden py-4 xl:h-[calc(100svh-11rem)] xl:max-h-[60rem]'>
      <CardHeader className='space-y-2 px-4'>
        <div className='flex items-center gap-2'>
          <FileText className='size-4 text-muted-foreground' aria-hidden />
          <CardTitle className='text-base'>出站预览</CardTitle>
          <Badge variant='secondary' className='font-normal'>
            {personaPresetLabel(preset)}
          </Badge>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='ml-auto size-7 cursor-pointer'
            aria-label='复制 system prompt'
            disabled={!plain}
            onClick={() => {
              void navigator.clipboard.writeText(plain)
              toast.success('已复制')
            }}
          >
            <Copy />
          </Button>
        </div>
        <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
          {presetFlagEnabled(compat, 'persona_env_presets', preset) ? (
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
          {presetFlagEnabled(compat, 'model_env_extra_presets', preset) ? (
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
          <label className='ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground'>
            <Switch
              aria-label='显示调用方示例（仅预览）'
              aria-describedby='preview-caller-effect'
              checked={withCaller}
              onCheckedChange={setWithCaller}
            />
            调用方示例 · 仅预览
          </label>
        </div>
        {!withCaller ? (
          <p
            id='preview-caller-effect'
            className='text-xs text-muted-foreground'
          >
            仅隐藏调用方提示词示例，不移除请求中的 system 内容。
          </p>
        ) : (
          <span id='preview-caller-effect' className='sr-only'>
            关闭仅隐藏调用方提示词示例，不修改实际请求。
          </span>
        )}
      </CardHeader>
      <CardContent className='min-h-0 flex-1 space-y-2 overflow-y-auto px-4'>
        {vars.isLoading || dash.isLoading ? (
          <div className='space-y-2'>
            <Skeleton className='h-16 w-full' />
            <Skeleton className='h-40 w-full' />
          </div>
        ) : vars.error ? (
          <p className='text-xs text-destructive'>
            {(vars.error as Error).message}
          </p>
        ) : rendered.length ? (
          <ol className='space-y-2'>
            {rendered.map((block, i) => {
              const blockMasked = blocksMasked && block.hide
              const masked =
                blockMasked || (standingMasked && block.text.includes(standing))
              return (
                <li
                  key={`${block.id}-${i}`}
                  className='overflow-hidden rounded-md border border-border/60'
                >
                  <div className='flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/40 bg-muted/30 px-3 py-2 font-mono text-[10px] text-muted-foreground'>
                    <span className='tabular-nums'>{i + 1}</span>
                    <span className='truncate'>
                      {promptBlockLabel(block.id)[0]}
                    </span>
                    <span className='break-all'>{block.region}</span>
                    <span className='ml-auto flex items-center gap-1.5'>
                      {block.ttl ? <span>{block.ttl}</span> : null}
                      {block.scope ? <span>{block.scope}</span> : null}
                      {masked ? (
                        <span
                          className='flex items-center gap-0.5'
                          title={
                            blockMasked
                              ? '注入块不计 usage'
                              : '常驻约束不计 usage'
                          }
                        >
                          <EyeOff className='size-3' aria-hidden />
                          {blockMasked ? '遮罩' : '约束遮罩'}
                        </span>
                      ) : null}
                      <span className='tabular-nums'>
                        ≈{estimateTokens(block.text)}
                      </span>
                    </span>
                  </div>
                  {block.placeholder ? (
                    <p className='px-2.5 py-2 text-[11px] text-muted-foreground italic'>
                      零宽占位
                    </p>
                  ) : (
                    <pre className='px-3 py-3 font-mono text-xs leading-6 break-words whitespace-pre-wrap'>
                      {highlight(block.text, marks)}
                    </pre>
                  )}
                </li>
              )
            })}
          </ol>
        ) : (
          <p className='text-xs text-muted-foreground'>无 system 块</p>
        )}
      </CardContent>
      {rendered.length ? (
        <div className='flex items-center justify-between border-t border-border/40 px-4 pt-3 font-mono text-[10px] text-muted-foreground tabular-nums'>
          <span>{rendered.length} 块</span>
          <span>
            {plain.length} 字符 · ≈{estimateTokens(plain)} tok
          </span>
        </div>
      ) : null}
    </Card>
  )
}
