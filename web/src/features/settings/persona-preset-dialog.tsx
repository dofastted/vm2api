import type { PersonaPreset } from '@/types/panel-routing'
import {
  DEFAULT_PERSONA_TEMPLATES,
  PERSONA_TEMPLATE_VARS,
  PREVIEW_VARS,
  parsePersonaTemplateLines,
  personaPresetLabel,
  presetSeed,
  renderPersonaTemplate,
  stringifyPersonaTemplate,
  type RawBlock,
} from '@/lib/persona-template'
import {
  ZERO_WIDTH_PLACEHOLDER,
  applyZeroFields,
  hiddenUsageBlocks,
  isZeroWidthPlaceholder,
  zeroFieldsFromBlocks,
  type ZeroFields,
} from '@/lib/persona-zero-fields'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { personaDraftStoresEmpty } from '@/features/settings/persona-drafts'
import {
  Notice,
  PersonaTemplateEditor,
  VarsHint,
} from '@/features/settings/persona-editors'

function previewSnippet(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return '（空）'
  if (flat.length <= max) return flat
  return `${flat.slice(0, max)}…`
}

function OutboundPreview({ blocks }: { blocks: RawBlock[] }) {
  const outbound = renderPersonaTemplate(blocks, PREVIEW_VARS)
  const hidden = hiddenUsageBlocks(blocks)
  return (
    <div className='space-y-2'>
      <p className='text-xs font-medium'>出站 system</p>
      {outbound.length ? (
        <div className='rounded-md border border-border/60'>
          {outbound.map((block, i) => {
            const cc = block.cache_control
            const ttl = cc && typeof cc.ttl === 'string' ? cc.ttl : ''
            return (
              <div
                key={`${i}-${block.text.slice(0, 24)}`}
                className='border-b border-border/40 px-3 py-2 last:border-b-0'
              >
                <div className='flex items-center gap-2 text-[11px] text-muted-foreground'>
                  <span className='font-mono'>#{i + 1}</span>
                  {ttl ? <span>{ttl}</span> : null}
                </div>
                <p className='font-mono text-xs leading-relaxed'>
                  {previewSnippet(block.text)}
                </p>
              </div>
            )
          })}
        </div>
      ) : (
        <p className='text-xs text-muted-foreground'>没有 system 块</p>
      )}
      {hidden.length ? (
        <ul className='space-y-1 text-xs text-muted-foreground'>
          {hidden.map((block, i) => (
            <li key={`${block.id}-${i}`}>
              <code className='font-mono'>{block.id || `块 ${i + 1}`}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function SlotField({
  label,
  hide,
  onHideChange,
  hideLabel = '遮罩 usage',
  extra,
  children,
}: {
  label: string
  hide: boolean
  onHideChange: (on: boolean) => void
  hideLabel?: string
  extra?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className='space-y-2 rounded-md border border-border/60 p-3'>
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <p className='text-sm font-medium'>{label}</p>
        <label className='flex items-center gap-2 text-xs'>
          <Switch checked={hide} onCheckedChange={onHideChange} />
          {hideLabel}
        </label>
      </div>
      {children}
      {extra}
    </div>
  )
}

function placeholderValue(text: string): string {
  return isZeroWidthPlaceholder(text) ? '' : text
}

function ZeroFieldsForm({
  blocks,
  onChange,
}: {
  blocks: RawBlock[]
  onChange: (blocks: RawBlock[]) => void
}) {
  const fields = zeroFieldsFromBlocks(blocks)
  const patch = (next: Partial<ZeroFields>) =>
    onChange(applyZeroFields(blocks, next))

  return (
    <div className='space-y-3'>
      <SlotField
        label='计费头'
        hide={fields.billingHide}
        onHideChange={(on) => patch({ billingHide: on })}
      >
        <Textarea
          className='h-20 font-mono text-xs'
          spellCheck={false}
          aria-label='0注入计费头'
          value={fields.billingText}
          onChange={(e) => patch({ billingText: e.target.value })}
        />
      </SlotField>

      <SlotField
        label='identity 占位'
        hide={fields.identityHide}
        onHideChange={(on) => patch({ identityHide: on })}
        extra={
          <div className='flex justify-end'>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              onClick={() => patch({ identityText: ZERO_WIDTH_PLACEHOLDER })}
            >
              填回零宽占位
            </Button>
          </div>
        }
      >
        <Textarea
          className='h-16 font-mono text-xs'
          spellCheck={false}
          aria-label='0注入 identity 占位'
          value={placeholderValue(fields.identityText)}
          onChange={(e) =>
            patch({
              identityText: e.target.value
                ? e.target.value
                : ZERO_WIDTH_PLACEHOLDER,
            })
          }
        />
      </SlotField>

      <SlotField
        label='agent 槽'
        hide={fields.agentHide}
        onHideChange={(on) => patch({ agentHide: on })}
        extra={
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <label className='flex items-center gap-2 text-xs'>
              cache ttl
              <Input
                className='h-7 w-20 font-mono text-xs'
                value={fields.agentCacheTtl}
                placeholder='5m'
                aria-label='0注入 agent cache ttl'
                onChange={(e) => patch({ agentCacheTtl: e.target.value })}
              />
            </label>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              onClick={() =>
                patch({
                  agentText: ZERO_WIDTH_PLACEHOLDER,
                  agentCacheTtl: '5m',
                })
              }
            >
              填回零宽占位
            </Button>
          </div>
        }
      >
        <Textarea
          className='h-16 font-mono text-xs'
          spellCheck={false}
          aria-label='0注入 agent 槽'
          value={placeholderValue(fields.agentText)}
          onChange={(e) =>
            patch({
              agentText: e.target.value
                ? e.target.value
                : ZERO_WIDTH_PLACEHOLDER,
            })
          }
        />
      </SlotField>

      <SlotField
        label='caller leftover'
        hide={fields.callerHide}
        onHideChange={(on) => patch({ callerHide: on })}
        extra={
          <label className='flex items-center gap-2 text-xs'>
            <Switch
              checked={fields.callerDropIfEmpty}
              onCheckedChange={(on) => patch({ callerDropIfEmpty: on })}
            />
            空则丢弃
          </label>
        }
      >
        <Textarea
          className='h-16 font-mono text-xs'
          spellCheck={false}
          aria-label='0注入 caller leftover'
          value={fields.callerText}
          onChange={(e) => patch({ callerText: e.target.value })}
        />
      </SlotField>
    </div>
  )
}

export function PersonaPresetDialog({
  preset,
  open,
  text,
  onOpenChange,
  onTextChange,
}: {
  preset: PersonaPreset
  open: boolean
  text: string
  onOpenChange: (open: boolean) => void
  onTextChange: (text: string) => void
}) {
  const parsed = parsePersonaTemplateLines(text)
  const hasErrors = parsed.errors.length > 0
  const customEmpty =
    preset === 'custom' && personaDraftStoresEmpty(text, 'custom')
  const effective = parsed.blocks.length
    ? parsed.blocks
    : presetSeed(DEFAULT_PERSONA_TEMPLATES, preset)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl'>
        <DialogHeader className='space-y-1.5 border-b px-6 py-4'>
          <DialogTitle>配置{personaPresetLabel(preset)}</DialogTitle>
          <DialogDescription className='sr-only'>
            配置{personaPresetLabel(preset)}
          </DialogDescription>
        </DialogHeader>

        <div className='min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4'>
          {preset === 'custom' && customEmpty ? (
            <Notice tone='caution'>
              空模板会回落官方提示词。真要清空，写一个 text 为空的块。
            </Notice>
          ) : null}

          {preset === 'zero' && !hasErrors ? (
            <ZeroFieldsForm
              blocks={parsed.blocks.length ? parsed.blocks : effective}
              onChange={(blocks) =>
                onTextChange(stringifyPersonaTemplate(blocks))
              }
            />
          ) : (
            <PersonaTemplateEditor
              text={text}
              blocks={parsed.blocks}
              hasErrors={hasErrors}
              customEmpty={false}
              onTextChange={onTextChange}
              onBlocksChange={(blocks) =>
                onTextChange(stringifyPersonaTemplate(blocks))
              }
              onReset={() =>
                onTextChange(
                  stringifyPersonaTemplate(
                    presetSeed(DEFAULT_PERSONA_TEMPLATES, preset)
                  )
                )
              }
            />
          )}

          {preset === 'zero' && !hasErrors ? (
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button type='button' size='sm' variant='ghost'>
                  高级：JSONL
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className='space-y-2 pt-2'>
                <Textarea
                  className='h-40 font-mono text-xs'
                  spellCheck={false}
                  aria-label='0注入 system 模板 JSONL'
                  value={text}
                  onChange={(e) => onTextChange(e.target.value)}
                />
                <VarsHint vars={PERSONA_TEMPLATE_VARS} />
                <div className='flex justify-end'>
                  <Button
                    type='button'
                    size='sm'
                    variant='ghost'
                    onClick={() =>
                      onTextChange(
                        stringifyPersonaTemplate(
                          presetSeed(DEFAULT_PERSONA_TEMPLATES, 'zero')
                        )
                      )
                    }
                  >
                    恢复预设
                  </Button>
                </div>
              </CollapsibleContent>
            </Collapsible>
          ) : null}

          {hasErrors ? (
            <Notice tone='bad'>
              JSONL 有错，预览按解析成功的块显示，保存前先修好。
            </Notice>
          ) : (
            <OutboundPreview blocks={effective} />
          )}
        </div>

        <DialogFooter className='border-t px-6 py-3'>
          <Button
            type='button'
            variant='outline'
            onClick={() => onOpenChange(false)}
          >
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
