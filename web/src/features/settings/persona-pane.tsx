import { useEffect, useMemo, useState } from 'react'
import type { PersonaPreset } from '@/types/panel-routing'
import {
  PERSONA_PRESET_OPTIONS,
  PERSONA_PRESETS,
  PERSONA_STANDING_MAX,
  formatLineError,
  parsePersonaTemplateLines,
  personaPresetFromCompat,
  personaPresetLabel,
  validatePersonaTemplate,
} from '@/lib/persona-template'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { StatusMark } from '@/components/status-mark'
import {
  type PersonaDrafts,
  personaSchemeSummary,
  personaTemplatesPayload,
  seedPersonaDrafts,
} from '@/features/settings/persona-drafts'
import { Problems } from '@/features/settings/persona-editors'
import { PersonaPresetDialog } from '@/features/settings/persona-preset-dialog'

type Compat = Record<string, unknown>

export function PersonaPane({
  compat,
  onChange,
  onProblemsChange,
}: {
  compat: Compat
  onChange: (next: Compat) => void
  onProblemsChange?: (problems: string[]) => void
}) {
  const [personaDrafts, setPersonaDrafts] = useState<PersonaDrafts | null>(null)
  const [dialogPreset, setDialogPreset] = useState<PersonaPreset | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    if (personaDrafts || !Object.keys(compat).length) return
    setPersonaDrafts(seedPersonaDrafts(compat))
  }, [compat, personaDrafts])

  const preset = personaPresetFromCompat(compat)
  const standing = String(compat.persona_standing ?? '')

  const problems = useMemo(() => {
    if (!personaDrafts) return []
    const out: string[] = []
    const label = (key: string, active: boolean) => (active ? '' : `「${key}」`)
    for (const key of PERSONA_PRESETS) {
      const parsed = parsePersonaTemplateLines(personaDrafts[key])
      const at = label(personaPresetLabel(key), key === preset)
      for (const err of parsed.errors)
        out.push(`人设模板${at}${formatLineError(err)}`)
      for (const msg of validatePersonaTemplate(parsed.blocks))
        out.push(`人设模板${at}${msg}`)
    }
    if (standing.length > PERSONA_STANDING_MAX) {
      out.push(`常驻约束超过 ${PERSONA_STANDING_MAX} 字符`)
    }
    return out
  }, [personaDrafts, preset, standing])

  useEffect(() => {
    onProblemsChange?.(problems)
  }, [problems, onProblemsChange])

  const commit = (
    nextPersona: PersonaDrafts,
    patch: Record<string, unknown> = {}
  ) => {
    onChange({
      ...compat,
      ...patch,
      persona_templates: personaTemplatesPayload(nextPersona),
    })
  }

  const setPersonaDraft = (key: PersonaPreset, text: string) => {
    if (!personaDrafts) return
    const next = { ...personaDrafts, [key]: text }
    setPersonaDrafts(next)
    commit(next)
  }

  const openScheme = (key: PersonaPreset) => {
    setDialogPreset(key)
    setDialogOpen(true)
  }

  const selectPreset = (next: PersonaPreset) => {
    if (!personaDrafts) return
    commit(personaDrafts, { persona_preset: next })
    if (next === 'zero') openScheme('zero')
  }

  const editing = dialogPreset ?? 'official'

  if (!personaDrafts) {
    return (
      <p className='text-sm text-muted-foreground'>正在读取当前人设配置...</p>
    )
  }

  return (
    <div className='space-y-3'>
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>人设方案</CardTitle>
        </CardHeader>
        <CardContent className='space-y-3'>
          <RadioGroup
            value={preset}
            onValueChange={(v) => selectPreset(v as PersonaPreset)}
            className='gap-0 divide-y divide-border/60 rounded-md border border-border/60'
            name='persona-preset'
          >
            {PERSONA_PRESET_OPTIONS.map(([key, label]) => {
              const active = key === preset
              return (
                <div
                  key={key}
                  className={cn(
                    'flex items-start gap-3 px-3 py-3',
                    active && 'bg-muted/30'
                  )}
                >
                  <RadioGroupItem
                    id={`persona-preset-${key}`}
                    value={key}
                    className='mt-1'
                  />
                  <div className='min-w-0 flex-1 space-y-1'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <Label
                        htmlFor={`persona-preset-${key}`}
                        className='text-sm font-medium'
                      >
                        {label}
                      </Label>
                      {active ? (
                        <StatusMark
                          variant='pill'
                          tone={{ key: 'ok', cls: 'ok', text: '当前启用' }}
                        />
                      ) : null}
                    </div>
                    <p className='font-mono text-[11px] leading-relaxed text-muted-foreground'>
                      {personaSchemeSummary(personaDrafts[key], key)}
                    </p>
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      aria-label={`配置${label}`}
                      onClick={() => openScheme(key)}
                    >
                      配置
                    </Button>
                  </div>
                </div>
              )
            })}
          </RadioGroup>

          <div className='flex items-center justify-between gap-2'>
            <Label htmlFor='persona-standing' className='text-sm'>
              常驻约束
            </Label>
            <span
              className={cn(
                'font-mono text-xs text-muted-foreground',
                standing.length > PERSONA_STANDING_MAX && 'text-destructive'
              )}
            >
              {standing.length} / {PERSONA_STANDING_MAX}
            </span>
          </div>
          <Textarea
            id='persona-standing'
            className='h-24 text-xs'
            spellCheck={false}
            aria-label='常驻约束 persona_standing'
            value={standing}
            onChange={(e) =>
              onChange({ ...compat, persona_standing: e.target.value })
            }
          />
        </CardContent>
      </Card>

      <Problems items={problems} />

      <PersonaPresetDialog
        preset={editing}
        open={dialogOpen}
        text={personaDrafts[editing]}
        onOpenChange={setDialogOpen}
        onTextChange={(text) => setPersonaDraft(editing, text)}
      />
    </div>
  )
}
