import { useState } from 'react'
import type { PersonaPreset } from '@/types/panel-routing'
import { ArrowRight, FileText, Globe2 } from 'lucide-react'
import {
  presetFlagEnabled,
  selectedPreviewBlocks,
  setPresetFlag,
  setTemplateBlock,
  templateBlockEnabled,
  type PresetFlagField,
  type RawBlock,
} from '@/lib/persona-template'
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
}

/** Environment blocks render at the end of the top-level system, under the env switch. */
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
          className='shrink-0 gap-1 text-muted-foreground hover:text-foreground'
          aria-label={`${label}详情`}
        >
          详情 <ArrowRight className='size-3.5' aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent className='max-h-[90svh] gap-5 overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            编辑提示词内容，动态变量在请求时填入。
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
  const routed = selectedPreviewBlocks(blocks, undefined, preset)
  const envOn = presetFlagEnabled(compat, 'persona_env_presets', preset)
  const fields = (environment: boolean) =>
    routed.flatMap((block, index) => {
      const id = String(block.id ?? '')
      if (isEnvironmentBlock(id) !== environment) return []
      if (id === 'dynamic_boundary' || (id === 'billing' && preset !== 'zero'))
        return []
      const flag = environment ? ENV_FLAGS[id] : undefined
      const selected = templateBlockEnabled(compat, preset, id)
      const [label, description] = promptBlockLabel(id)
      const literal = String(block.text ?? '')
        .replace(/\{\{[^}]+\}\}/g, '')
        .replace(/\u200b/g, '')
        .trim()
      // A disabled macro flag does not suppress saved literal text. Reflect the
      // existing content, and use block selection when switching the whole part off.
      const on =
        selected &&
        (!flag || presetFlagEnabled(compat, flag, preset) || !!literal)
      const enabled = on && (!environment || envOn)
      const controlled = environment && (flag || id !== 'env')
      const effectId = `prompt-effect-${preset}-${index}`
      return [
        <li key={`${id}-${index}`} className='flex items-start gap-2 py-3'>
          <span
            className={`mt-2 size-1.5 shrink-0 rounded-full ${enabled ? 'bg-primary' : 'bg-muted-foreground/40'}`}
            aria-hidden
          />
          <div className='min-w-0 flex-1 space-y-1'>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
              <span className='text-sm font-medium'>{label}</span>
              {!enabled ? (
                <span className='text-xs text-muted-foreground'>不发送</span>
              ) : null}
            </div>
            <p
              id={effectId}
              className={`text-xs leading-5 break-words text-muted-foreground ${controlled ? '' : 'line-clamp-2'}`}
            >
              {controlled
                ? `${enabled ? '关闭将移除' : '不发送'}「${label}」段`
                : !enabled
                  ? `已移除「${label}」段`
                  : literal || description}
            </p>
          </div>
          {controlled ? (
            <Switch
              className='mt-1.5'
              aria-label={`加载${label}`}
              aria-describedby={effectId}
              checked={on}
              disabled={!envOn}
              onCheckedChange={(enabled) => {
                const next = setTemplateBlock(compat, preset, id, enabled)
                onCompatChange(
                  flag
                    ? setPresetFlag(next, flag, preset, enabled, server)
                    : next
                )
              }}
            />
          ) : !selected ? (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              onClick={() =>
                onCompatChange(setTemplateBlock(compat, preset, id, true))
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
        </li>,
      ]
    })

  const environment = fields(true)
  return (
    <div>
      <section aria-label='system'>
        <div className='flex items-center gap-2 pt-1 pb-2 text-sm font-medium'>
          <FileText className='size-4 text-muted-foreground' aria-hidden />
          系统提示词
          <span className='ml-auto font-mono text-xs font-normal text-muted-foreground'>
            system
          </span>
        </div>
        <ul className='divide-y divide-border/50'>{fields(false)}</ul>
      </section>
      {environment.length ? (
        <section
          className='mt-3 border-t border-border pt-5'
          aria-label='环境注入'
        >
          <div className='flex items-center gap-2'>
            <Globe2 className='size-4 text-muted-foreground' aria-hidden />
            <h3 className='text-sm font-medium'>环境注入</h3>
            <Switch
              className='ml-auto'
              aria-label='加载环境'
              aria-describedby={`prompt-environment-effect-${preset}`}
              checked={envOn}
              onCheckedChange={(enabled) =>
                onCompatChange(
                  setPresetFlag(
                    compat,
                    'persona_env_presets',
                    preset,
                    enabled,
                    server
                  )
                )
              }
            />
          </div>
          <p className='pt-2 font-mono text-[11px] break-all text-muted-foreground'>
            system 末尾
          </p>
          <p
            id={`prompt-environment-effect-${preset}`}
            className='pt-1 pb-2 text-xs leading-5 text-muted-foreground'
          >
            {envOn
              ? '关闭将移除环境注入段；其余 system 保留。'
              : '环境注入段已移除；其余 system 保留。'}
          </p>
          <ul className='divide-y divide-border/50'>{environment}</ul>
        </section>
      ) : null}
    </div>
  )
}
