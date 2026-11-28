import { useEffect, useMemo, useState } from 'react'
import type { PersonaPreset } from '@/types/panel-routing'
import { Check, ChevronDown, RotateCcw, SlidersHorizontal } from 'lucide-react'
import {
  DEFAULT_PERSONA_TEMPLATES,
  PERSONA_PRESETS,
  PERSONA_TEMPLATE_VARS,
  formatLineError,
  parsePersonaTemplateLines,
  personaPresetFromCompat,
  presetFlagEnabled,
  presetSeed,
  setPresetFlag,
  stringifyPersonaTemplate,
  validatePersonaTemplate,
  type RawBlock,
} from '@/lib/persona-template'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  type PersonaDrafts,
  personaDraftStoresEmpty,
  personaSchemeSummary,
  personaTemplatesPayload,
  seedPersonaDrafts,
} from '@/features/settings/persona-drafts'
import {
  Notice,
  PersonaTemplateEditor,
  Problems,
} from '@/features/settings/persona-editors'
import { PromptFields } from './prompt-fields'
import {
  ANTHROPIC_MODE_OPTIONS,
  anthropicPresetLabel,
  promptDisplayText,
  promptEditorBlocks,
  promptSourceBlocks,
  promptSourceText,
  sanitizeTemplateVarNote,
} from './prompt-presentation'
import { SlidingTabs } from './sliding-tabs'
import { SystemPreview } from './system-preview'

type Compat = Record<string, unknown>

/** 草稿能解析就用草稿块，否则（空 / 有错）用后端会回落到的内置模板。 */
function effectiveBlocks(text: string, preset: PersonaPreset): RawBlock[] {
  const { blocks, errors } = parsePersonaTemplateLines(text)
  if (!errors.length && blocks.length) return blocks
  return presetSeed(DEFAULT_PERSONA_TEMPLATES, preset)
}

export function SystemPromptWorkspace({
  compat,
  server,
  onChange,
  onProblemsChange,
}: {
  compat: Compat
  server: Compat | undefined
  onChange: (next: Compat) => void
  onProblemsChange: (problems: string[]) => void
}) {
  const [drafts, setDrafts] = useState<PersonaDrafts | null>(null)
  const active = personaPresetFromCompat(compat)
  const [viewing, setViewing] = useState<PersonaPreset>(active)
  const [editorExpanded, setEditorExpanded] = useState(true)

  useEffect(() => {
    if (drafts || !Object.keys(compat).length) return
    setDrafts(seedPersonaDrafts(compat))
    setViewing(personaPresetFromCompat(compat))
  }, [compat, drafts])

  const problems = useMemo(() => {
    if (!drafts) return []
    const out: string[] = []
    for (const key of PERSONA_PRESETS) {
      const at = key === active ? '' : `「${anthropicPresetLabel(key)}」`
      const parsed = parsePersonaTemplateLines(drafts[key])
      for (const err of parsed.errors)
        out.push(`模板${at}${formatLineError(err)}`)
      for (const msg of validatePersonaTemplate(parsed.blocks))
        out.push(`模板${at}${msg}`)
    }
    return out
  }, [drafts, active])

  useEffect(() => {
    onProblemsChange(problems)
  }, [problems, onProblemsChange])

  if (!drafts) {
    return <p className='text-sm text-muted-foreground'>读取中…</p>
  }

  const setDraft = (text: string) => {
    const next = { ...drafts, [viewing]: text }
    setDrafts(next)
    onChange({ ...compat, persona_templates: personaTemplatesPayload(next) })
  }

  const text = drafts[viewing]
  const parsed = parsePersonaTemplateLines(text)
  const hasErrors = parsed.errors.length > 0
  const blocks = effectiveBlocks(text, viewing)
  const showAdvancedEditor = viewing === 'custom' || hasErrors

  const modeTabs = ANTHROPIC_MODE_OPTIONS.map((option) => {
    const summary = personaSchemeSummary(drafts[option.value], option.value)
    const isModified = summary !== '内置'
    return {
      value: option.value,
      label: option.label,
      description: isModified ? summary : option.summary,
      badge:
        option.value === active ? (
          <span className='inline-flex items-center gap-1 rounded-full bg-ok-1 px-2 py-0.5 text-[10px] font-medium text-ok-5 dark:bg-ok-1/80'>
            <Check className='size-2.5' aria-hidden />
            生效中
          </span>
        ) : null,
    }
  })

  return (
    <div className='space-y-5'>
      <SlidingTabs
        variant='cards'
        ariaLabel='Anthropic 提示词模式'
        items={modeTabs}
        value={viewing}
        onChange={setViewing}
        className='grid-cols-2 xl:grid-cols-4'
      />

      <div className='grid items-start gap-5 xl:grid-cols-[minmax(0,25.5rem)_minmax(0,1fr)]'>
        <aside aria-label='注入控制' className='min-w-0 space-y-4'>
          <div className='overflow-hidden rounded-2xl border border-border/75 bg-card'>
            <div className='flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-4'>
              <div className='min-w-0 flex-1'>
                <h3 className='text-base font-semibold tracking-tight'>
                  {anthropicPresetLabel(viewing)}
                </h3>
                {viewing !== active ? (
                  <p className='mt-0.5 text-xs text-muted-foreground'>
                    预览中 · 当前生效「{anthropicPresetLabel(active)}」
                  </p>
                ) : null}
              </div>
              <div className='flex shrink-0 items-center gap-1.5'>
                {viewing !== active ? (
                  <Button
                    type='button'
                    size='sm'
                    className='h-8 cursor-pointer text-xs'
                    onClick={() =>
                      onChange({
                        ...compat,
                        persona_preset: viewing,
                        persona_templates: personaTemplatesPayload(drafts),
                      })
                    }
                  >
                    设为生效
                  </Button>
                ) : null}
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  className='h-8 cursor-pointer gap-1 px-2.5 text-xs text-muted-foreground hover:text-foreground'
                  onClick={() =>
                    setDraft(
                      stringifyPersonaTemplate(
                        presetSeed(DEFAULT_PERSONA_TEMPLATES, viewing)
                      )
                    )
                  }
                >
                  <RotateCcw className='size-3.5' aria-hidden />
                  恢复默认
                </Button>
              </div>
            </div>

            <div
              key={viewing}
              className='animate-prompt-pane-in space-y-4 px-5 py-4'
            >
              {viewing === 'custom' &&
              personaDraftStoresEmpty(text, 'custom') ? (
                <Notice tone='caution'>空模板将回落官方提示词。</Notice>
              ) : null}

              {showAdvancedEditor ? (
                <div className='space-y-2'>
                  <button
                    type='button'
                    aria-expanded={editorExpanded || hasErrors}
                    disabled={hasErrors}
                    onClick={() => {
                      if (!hasErrors) setEditorExpanded((prev) => !prev)
                    }}
                    className='flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 text-left text-sm font-medium text-foreground transition-colors hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default disabled:hover:text-foreground'
                  >
                    <SlidersHorizontal
                      className='size-4 text-muted-foreground'
                      aria-hidden
                    />
                    <span>模板块编辑</span>
                    <ChevronDown
                      className={cn(
                        'ml-auto size-4 text-muted-foreground transition-transform duration-200',
                        (editorExpanded || hasErrors) && 'rotate-180'
                      )}
                      aria-hidden
                    />
                  </button>
                  <div
                    className='prompt-accordion'
                    data-open={editorExpanded || hasErrors ? 'true' : 'false'}
                    aria-hidden={!(editorExpanded || hasErrors)}
                    inert={!(editorExpanded || hasErrors) || undefined}
                  >
                    <div className='prompt-accordion-inner'>
                      <div className='pt-2'>
                        <PersonaTemplateEditor
                          key={viewing}
                          text={
                            hasErrors
                              ? promptDisplayText(text)
                              : stringifyPersonaTemplate(
                                  promptEditorBlocks(parsed.blocks)
                                )
                          }
                          blocks={promptEditorBlocks(blocks)}
                          hasErrors={hasErrors}
                          vars={PERSONA_TEMPLATE_VARS.map(
                            ([name, description]) => [
                              promptDisplayText(`{{${name}}}`).slice(2, -2),
                              sanitizeTemplateVarNote(description),
                            ]
                          )}
                          onTextChange={(next) => {
                            const source = promptSourceText(next)
                            const nextParsed = parsePersonaTemplateLines(source)
                            setDraft(
                              nextParsed.errors.length
                                ? source
                                : stringifyPersonaTemplate(
                                    promptSourceBlocks(
                                      nextParsed.blocks,
                                      blocks
                                    )
                                  )
                            )
                          }}
                          onBlocksChange={(next) =>
                            setDraft(
                              stringifyPersonaTemplate(
                                promptSourceBlocks(next, blocks)
                              )
                            )
                          }
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <PromptFields
                  preset={viewing}
                  blocks={blocks}
                  compat={compat}
                  server={server}
                  onBlocksChange={(next) =>
                    setDraft(stringifyPersonaTemplate(next))
                  }
                  onCompatChange={onChange}
                />
              )}

              <div className='border-t border-border/70 pt-4'>
                <div className='flex items-start gap-3'>
                  <div className='min-w-0 flex-1'>
                    <label
                      htmlFor={`usage-passthrough-${viewing}`}
                      className='text-sm font-medium'
                    >
                      对外完整透传 usage
                    </label>
                    <p className='pt-0.5 text-xs leading-5 text-muted-foreground'>
                      开启后计费统计不扣除系统注入 token。
                    </p>
                  </div>
                  <Switch
                    id={`usage-passthrough-${viewing}`}
                    aria-label='对外完整透传 usage'
                    checked={presetFlagEnabled(
                      compat,
                      'usage_passthrough_presets',
                      viewing
                    )}
                    onCheckedChange={(enabled) =>
                      onChange(
                        setPresetFlag(
                          compat,
                          'usage_passthrough_presets',
                          viewing,
                          enabled,
                          server
                        )
                      )
                    }
                  />
                </div>
              </div>
            </div>
          </div>

          <Problems items={problems} />
        </aside>

        <section aria-label='出站预览' className='min-w-0 xl:sticky xl:top-20'>
          <SystemPreview preset={viewing} blocks={blocks} compat={compat} />
        </section>
      </div>
    </div>
  )
}
