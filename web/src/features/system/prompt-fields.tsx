import { useState } from 'react'
import type { PersonaPreset } from '@/types/panel-routing'
import { ArrowRight, FileText, Globe2 } from 'lucide-react'
import {
  isPresetEnvEnabled,
  isPresetGuidanceEnabled,
  isPresetHarnessEnabled,
  presetFlagEnabled,
  setPresetFlag,
  setTemplateBlock,
  templateBlockEnabled,
  type PresetFlagField,
  type RawBlock,
} from '@/lib/persona-template'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  promptBlockLabel,
  promptDisplayText,
  promptSourceText,
} from './prompt-presentation'

type Compat = Record<string, unknown>

const ENV_FLAGS: Record<string, PresetFlagField> = {
  env_extra: 'model_env_extra_presets',
  env_instructions: 'persona_env_instructions_presets',
  env_timezone: 'persona_timezone_presets',
  env_locale: 'persona_locale_presets',
}

const TOP_LEVEL_TOGGLEABLE = new Set(['harness', 'guidance'])

/** Environment blocks render under the unified 环境注入 master switch. */
const isEnvironmentBlock = (id: string) => /^env(_|$)/.test(id)

function PromptDetail({
  label,
  text,
  onSave,
}: {
  label: string
  text: string
  onSave: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(promptDisplayText(text))
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground'
          aria-label={`${label}详情`}
        >
          详情 <ArrowRight className='size-3' aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent className='max-h-[90svh] gap-5 overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            编辑提示词内容，动态变量在请求时自动填入。
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-2'>
          <label htmlFor='prompt-detail-text' className='text-sm font-medium'>
            提示词内容
          </label>
          <Textarea
            id='prompt-detail-text'
            className='max-h-[50svh] min-h-64 resize-y font-mono text-sm leading-7'
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button
            type='button'
            variant='outline'
            onClick={() => setOpen(false)}
          >
            取消
          </Button>
          <Button
            type='button'
            onClick={() => {
              // Keep the original bytes when the user has not changed the template.
              if (draft !== promptDisplayText(text))
                onSave(promptSourceText(draft))
              setOpen(false)
            }}
          >
            应用修改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Keep routing and cache metadata outside the text-editing surface. */
export function PromptFields({
  preset,
  blocks,
  compat,
  server,
  onBlocksChange,
  onCompatChange,
}: {
  preset: PersonaPreset
  blocks: RawBlock[]
  compat: Compat
  server: Compat | undefined
  onBlocksChange: (blocks: RawBlock[]) => void
  onCompatChange: (next: Compat) => void
}) {
  const envOn = isPresetEnvEnabled(compat, preset)
  const fields = (environment: boolean) =>
    blocks.flatMap((block, index) => {
      const id = String(block.id ?? '')
      if (isEnvironmentBlock(id) !== environment) return []
      if (id === 'dynamic_boundary' || (id === 'billing' && preset !== 'zero'))
        return []
      const flag = environment
        ? ENV_FLAGS[id]
        : id === 'guidance'
          ? ('persona_guidance_presets' as const)
          : undefined
      const selected = templateBlockEnabled(compat, preset, id)
      const [label, description] = promptBlockLabel(id)
      const literal = String(block.text ?? '')
        .replace(/\{\{[^}]+\}\}/g, '')
        .replace(/\u200b/g, '')
        .trim()
      const controlled = environment || TOP_LEVEL_TOGGLEABLE.has(id)
      // A disabled env macro flag does not suppress saved literal text.
      const on =
        id === 'harness'
          ? isPresetHarnessEnabled(compat, preset)
          : id === 'guidance'
            ? isPresetGuidanceEnabled(compat, preset)
            : selected &&
              (!flag || presetFlagEnabled(compat, flag, preset) || !!literal)
      const enabled = on && (!environment || envOn)
      const effectId = `prompt-effect-${preset}-${index}`
      return [
        <li
          key={`${id}-${index}`}
          className='flex items-start gap-2.5 py-3 transition-colors duration-150'
        >
          <span
            className={cn(
              'mt-1.5 size-2 shrink-0 rounded-full transition-colors duration-150',
              enabled ? 'bg-primary' : 'bg-muted-foreground/30'
            )}
            aria-hidden
          />
          <div className='min-w-0 flex-1 space-y-0.5'>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
              <span
                className={cn(
                  'text-sm font-medium transition-colors duration-150',
                  enabled ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {label}
              </span>
              {!enabled ? (
                <span className='rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground'>
                  不发送
                </span>
              ) : null}
            </div>
            <p
              id={effectId}
              className={cn(
                'text-xs leading-5 break-words text-muted-foreground',
                !controlled && 'line-clamp-2'
              )}
            >
              {controlled
                ? `${enabled ? '关闭将移除' : '不发送'}「${label}」段`
                : !enabled
                  ? `已移除「${label}」段`
                  : literal || description}
            </p>
          </div>
          <div className='flex shrink-0 items-center gap-1 pt-0.5'>
            {controlled ? (
              <Switch
                aria-label={`加载${label}`}
                aria-describedby={effectId}
                checked={on}
                disabled={environment && !envOn}
                onCheckedChange={(checked) => {
                  const next = setTemplateBlock(
                    compat,
                    preset,
                    id,
                    checked,
                    server
                  )
                  onCompatChange(
                    flag
                      ? setPresetFlag(next, flag, preset, checked, server)
                      : next
                  )
                }}
              />
            ) : !selected ? (
              <Button
                type='button'
                size='sm'
                variant='ghost'
                className='h-7 px-2 text-xs'
                onClick={() =>
                  onCompatChange(
                    setTemplateBlock(compat, preset, id, true, server)
                  )
                }
              >
                启用
              </Button>
            ) : null}
            <PromptDetail
              label={label}
              text={String(block.text ?? '')}
              onSave={(text) =>
                onBlocksChange(
                  blocks.map((item, at) =>
                    at === index ? { ...item, text } : item
                  )
                )
              }
            />
          </div>
        </li>,
      ]
    })

  const environment = fields(true)
  return (
    <div className='space-y-4'>
      <section aria-label='system'>
        <div className='flex items-center gap-2 pb-1.5'>
          <FileText className='size-3.5 text-muted-foreground' aria-hidden />
          <h4 className='text-xs font-semibold tracking-wide text-muted-foreground'>
            系统提示词
          </h4>
          <span className='ml-auto rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'>
            system
          </span>
        </div>
        <ul className='divide-y divide-border/50'>{fields(false)}</ul>
      </section>

      {environment.length ? (
        <section
          className='border-t border-border/70 pt-4'
          aria-label='环境注入'
        >
          <div className='flex items-center gap-2'>
            <Globe2
              className={cn(
                'size-3.5 transition-colors duration-150',
                envOn ? 'text-primary' : 'text-muted-foreground'
              )}
              aria-hidden
            />
            <h4 className='text-sm font-medium'>环境注入</h4>
            <span className='rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'>
              system 末尾
            </span>
            <Switch
              className='ml-auto'
              aria-label='加载环境'
              aria-describedby={`prompt-environment-effect-${preset}`}
              checked={envOn}
              onCheckedChange={(checked) =>
                onCompatChange(
                  setPresetFlag(
                    compat,
                    'persona_env_presets',
                    preset,
                    checked,
                    server
                  )
                )
              }
            />
          </div>
          <p
            id={`prompt-environment-effect-${preset}`}
            className='pt-1.5 pb-2.5 text-xs leading-5 text-muted-foreground'
          >
            {envOn
              ? '关闭将移除环境注入段；其余 system 保留。'
              : '环境注入段已移除；其余 system 保留。'}
          </p>
          <div
            className={cn(
              'rounded-xl border px-3 transition-all duration-200',
              envOn
                ? 'border-border/60 bg-muted/20'
                : 'border-border/40 bg-muted/15 opacity-75'
            )}
          >
            <ul className='divide-y divide-border/50'>{environment}</ul>
          </div>
        </section>
      ) : null}
    </div>
  )
}
