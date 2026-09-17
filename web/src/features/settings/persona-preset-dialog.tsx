import type { PersonaPreset } from '@/types/panel-routing'
import {
  DEFAULT_PERSONA_TEMPLATES,
  PERSONA_TEMPLATE_VARS,
  PREVIEW_VARS,
  parsePersonaTemplateLines,
  personaExplain,
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
import { SettingRow } from '@/components/setting-row'
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

function OutboundPreview({
  blocks,
  hidesOn,
}: {
  blocks: RawBlock[]
  hidesOn: boolean
}) {
  const outbound = renderPersonaTemplate(blocks, PREVIEW_VARS)
  const hidden = hiddenUsageBlocks(blocks)
  return (
    <div className='space-y-2'>
      <p className='text-xs font-medium'>出站 system 形态</p>
      {outbound.length ? (
        <div className='rounded-md border border-border/60'>
          {outbound.map((block, i) => {
            const cc = block.cache_control
            const ttl = cc && typeof cc.ttl === 'string' ? cc.ttl : ''
            const scope = cc && typeof cc.scope === 'string' ? cc.scope : ''
            return (
              <div
                key={`${i}-${block.text.slice(0, 24)}`}
                className='border-b border-border/40 px-3 py-2 last:border-b-0'
              >
                <div className='flex items-center gap-2 text-[11px] text-muted-foreground'>
                  <span className='font-mono'>#{i + 1}</span>
                  {ttl || scope ? (
                    <span>缓存 {[ttl, scope].filter(Boolean).join(' ')}</span>
                  ) : null}
                </div>
                <p className='font-mono text-xs leading-relaxed'>
                  {previewSnippet(block.text)}
                </p>
              </div>
            )
          })}
        </div>
      ) : (
        <p className='text-xs text-muted-foreground'>
          没有会写出的 system 块。
        </p>
      )}
      <p className='text-xs font-medium'>从 client usage 消失的块</p>
      {hidden.length ? (
        <ul className='space-y-1 text-xs text-muted-foreground'>
          {hidden.map((block, i) => (
            <li key={`${block.id}-${i}`}>
              <code className='font-mono'>{block.id || `块 ${i + 1}`}</code>
              {block.note ? ` · ${block.note}` : ''}
            </li>
          ))}
        </ul>
      ) : (
        <p className='text-xs text-muted-foreground'>
          模板块都没有 hide。系统遮罩
          {hidesOn
            ? '已开：网关注入的 system usage 仍可能被整段隐藏。'
            : '已关：回包按上游原值。'}
        </p>
      )}
      {hidden.length && hidesOn ? (
        <p className='text-xs text-muted-foreground'>
          系统遮罩已开：这些 hide 块会从调用方 usage 里拿掉。
        </p>
      ) : null}
    </div>
  )
}

function SlotField({
  label,
  desc,
  hide,
  onHideChange,
  hideLabel = '遮罩 usage',
  extra,
  children,
}: {
  label: string
  desc: string
  hide: boolean
  onHideChange: (on: boolean) => void
  hideLabel?: string
  extra?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className='space-y-2 rounded-md border border-border/60 p-3'>
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='min-w-32 flex-1 space-y-0.5'>
          <p className='text-sm font-medium'>{label}</p>
          <p className='text-xs text-muted-foreground'>{desc}</p>
        </div>
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
        desc='与 official_full 第 1 块同槽。默认 {{billing_semi}} + prompt_version 折进短身份，不另开可读 identity 句。'
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
        desc='与 official_full 第 2 块同槽。上游拒空 text，默认零宽字符 U+200B，不写 Agent SDK 原文。'
        hide={fields.identityHide}
        onHideChange={(on) => patch({ identityHide: on })}
        extra={
          <div className='flex items-center justify-between gap-2'>
            <p className='text-xs text-muted-foreground'>
              {isZeroWidthPlaceholder(fields.identityText)
                ? '当前是零宽占位（U+200B）。'
                : fields.identityText
                  ? '当前是自定义文本。'
                  : '当前为空，上游可能拒绝。'}
            </p>
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
          placeholder='默认零宽占位 U+200B'
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
        desc='与 official_full 第 3 块同槽：占 5m 缓存断点，不写 agent 全文。'
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
          placeholder='默认零宽占位 U+200B'
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
        desc='调用方剩余 system（--append-system-prompt），默认空则丢弃、不遮罩。'
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

function schemeCopy(preset: PersonaPreset): string {
  if (preset === 'official') {
    return '块：billing / identity / caller_agent / caller_system。无 environment。默认模板没有 hide:true，usage 是否遮罩看「系统遮罩」和每块开关。'
  }
  if (preset === 'official_full') {
    return '块：billing / identity / agent_official / env_official / caller_system。写入官方 Claude Code agent 全文和 Environment。'
  }
  if (preset === 'zero') {
    return '与 official_full 同槽位。身份折进 prompt_version；identity / agent 用零宽占位；overlay 强制关闭。'
  }
  return '完全按 JSONL 逐块组装。空数组会静默回落官方提示词，不是「什么都不注入」。'
}

export function PersonaPresetDialog({
  preset,
  open,
  text,
  hidesOn,
  onOpenChange,
  onTextChange,
  onHidesChange,
}: {
  preset: PersonaPreset
  open: boolean
  text: string
  hidesOn: boolean
  onOpenChange: (open: boolean) => void
  onTextChange: (text: string) => void
  onHidesChange: (on: boolean) => void
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
          <DialogDescription className='text-xs leading-relaxed'>
            {personaExplain(preset)} {schemeCopy(preset)}
            官方 Claude Code 入站仍整包跳过。
          </DialogDescription>
        </DialogHeader>

        <div className='min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4'>
          {preset === 'zero' ? (
            <div
              className='rounded-md border px-3 py-2'
              style={{
                borderColor: 'var(--status-caution)',
                backgroundColor: 'var(--status-caution-bg)',
              }}
            >
              <SettingRow
                label='系统遮罩'
                desc='开：对调用方隐藏网关注入的 system usage（0 注入对齐 Portunex 的开关）。关：回包按上游原值。官方 Claude Code 入站不受影响。wrap/cli-hop 的 usage hide 走 gateway personaHideForCliZero，尚未接 persona_hides。'
              >
                <Switch checked={hidesOn} onCheckedChange={onHidesChange} />
              </SettingRow>
            </div>
          ) : null}

          {preset === 'zero' ? (
            <Notice tone='caution'>
              wrap / cli-hop 的 CLI 0 注入 layout 不读本页 JSONL；改这里不会改
              Claude Code 出站 system 文本。usage hide 是 gateway{' '}
              <code>personaHideForCliZero</code>，尚未接{' '}
              <code>persona_hides</code>。
            </Notice>
          ) : null}

          {preset === 'custom' && customEmpty ? (
            <Notice tone='caution'>
              自定义模板是空的。网关此时<b>不是「什么都不注入」</b>
              ，而是静默回落到官方提示词预设。真要清空，写一个 text 为空的块。
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
            <OutboundPreview blocks={effective} hidesOn={hidesOn} />
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
