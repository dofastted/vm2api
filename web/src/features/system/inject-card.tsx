import type { PersonaPreset } from '@/types/panel-routing'
import { EyeOff, RotateCcw, SquarePlus, type LucideIcon } from 'lucide-react'
import {
  AGENT_STANDING_MAX,
  agentStandingText,
  personaHideEnabled,
  presetFlagEnabled,
  resetAgentStanding,
  selectedPreviewBlocks,
  setPersonaHide,
  setPresetFlag,
  setTemplateBlock,
  templateBlockEnabled,
  type PresetFlagField,
  type RawBlock,
} from '@/lib/persona-template'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
type Compat = Record<string, unknown>

/** 模板对某个注入位的引用状态：引用了就可开关，自带就锁开，都没有就锁关。 */
export type SlotState = 'switch' | 'builtin' | 'absent'

function FlagRow({
  id,
  label,
  hint,
  state,
  lockedHint,
  on,
  onChange,
}: {
  id: string
  label: string
  hint: string
  state: SlotState
  /** 锁关时的原因，缺省为「模板未引用」。 */
  lockedHint?: string
  on: boolean
  onChange: (on: boolean) => void
}) {
  const locked = state !== 'switch'
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 transition-colors duration-200',
        locked ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-muted/40'
      )}
    >
      <span className='min-w-0'>
        <span className='block text-sm font-medium'>{label}</span>
        <span className='block truncate font-mono text-[10px] text-muted-foreground'>
          {state === 'builtin'
            ? '模板自带'
            : state === 'absent'
              ? lockedHint || '模板未引用 · 可恢复预设'
              : hint}
        </span>
      </span>
      <Switch
        id={id}
        checked={state === 'builtin' || (state === 'switch' && on)}
        disabled={locked}
        onCheckedChange={onChange}
      />
    </label>
  )
}

function FlagGroup({
  icon: Icon,
  title,
  note,
  children,
}: {
  icon: LucideIcon
  title: string
  note: string
  children: React.ReactNode
}) {
  return (
    <section className='p-1.5'>
      <div className='flex items-center gap-1.5 px-3 pt-1.5 pb-1'>
        <Icon className='size-3.5 text-muted-foreground' aria-hidden />
        <h3 className='text-xs font-medium'>{title}</h3>
        <span className='truncate text-[11px] text-muted-foreground'>
          {note}
        </span>
      </div>
      <div className='grid gap-1 sm:grid-cols-2'>{children}</div>
    </section>
  )
}

/** 当前查看档的注入 / usage 遮罩开关 + 四档共用的常驻约束文本。 */
export function InjectCard({
  compat,
  server,
  preset,
  blocks,
  standing,
  env,
  onChange,
}: {
  compat: Compat
  server: Compat | undefined
  preset: PersonaPreset
  /** 当前查看档的生效模板块，整档遮罩的默认值跟它的 hide 标记走。 */
  blocks: RawBlock[]
  standing: SlotState
  env: SlotState
  onChange: (next: Compat) => void
}) {
  const custom = compat.agent_standing != null
  const raw = custom ? String(compat.agent_standing) : agentStandingText(compat)
  const over = raw.length > AGENT_STANDING_MAX
  const standingOn =
    standing === 'switch' &&
    presetFlagEnabled(compat, 'agent_standing_presets', preset)
  const flip = (field: PresetFlagField) => (on: boolean) =>
    onChange(setPresetFlag(compat, field, preset, on, server))

  return (
    <Card className='gap-0 overflow-hidden py-0'>
      <FlagGroup icon={SquarePlus} title='注入' note='写进出站 system'>
        <FlagRow
          id='flag-standing'
          label='常驻约束'
          hint='agent 第一段'
          state={standing}
          on={presetFlagEnabled(compat, 'agent_standing_presets', preset)}
          onChange={flip('agent_standing_presets')}
        />
        <FlagRow
          id='flag-env'
          label='Environment'
          hint='槽位时区'
          state={env}
          on={presetFlagEnabled(compat, 'persona_env_presets', preset)}
          onChange={flip('persona_env_presets')}
        />
      </FlagGroup>

      <div className='border-t border-border/60'>
        <FlagGroup
          icon={EyeOff}
          title='usage 遮罩'
          note='开 = 不计入调用方 usage'
        >
          <FlagRow
            id='flag-persona-hide'
            label='注入块'
            hint='身份 / agent / Environment'
            state='switch'
            on={personaHideEnabled(compat, preset, blocks)}
            onChange={(on) =>
              onChange(setPersonaHide(compat, preset, on, blocks, server))
            }
          />
          <FlagRow
            id='flag-standing-hide'
            label='常驻约束'
            hint='单独计'
            state={standingOn ? 'switch' : 'absent'}
            lockedHint='常驻约束未注入'
            on={presetFlagEnabled(
              compat,
              'agent_standing_hide_presets',
              preset
            )}
            onChange={flip('agent_standing_hide_presets')}
          />
        </FlagGroup>
      </div>

      <div className='space-y-2 border-t border-border/60 px-4 py-3'>
        <div className='flex items-center gap-2'>
          <label htmlFor='agent-standing' className='text-sm font-medium'>
            常驻约束内容
          </label>
          <Badge variant='outline' className='font-normal'>
            {custom ? '已改' : '默认'}
          </Badge>
          <span className='text-[11px] text-muted-foreground'>四档共用</span>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='ml-auto h-7 cursor-pointer text-xs'
            disabled={!custom}
            onClick={() => onChange(resetAgentStanding(compat, server))}
          >
            <RotateCcw />
            恢复默认
          </Button>
        </div>
        <div className='relative'>
          <Textarea
            id='agent-standing'
            className='min-h-28 pb-6 font-mono text-xs leading-relaxed'
            spellCheck={false}
            aria-invalid={over || undefined}
            value={raw}
            placeholder='留空则不加'
            onChange={(e) =>
              onChange({ ...compat, agent_standing: e.target.value })
            }
          />
          <span
            className={cn(
              'pointer-events-none absolute right-2 bottom-1.5 font-mono text-[10px] tabular-nums',
              over ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {raw.length}/{AGENT_STANDING_MAX}
          </span>
        </div>
      </div>
      {preset === 'official_full' ? (
        <div className='space-y-1 border-t border-border/60 px-4 py-3'>
          <div className='text-sm font-medium'>块选择</div>
          {selectedPreviewBlocks(blocks, undefined, preset).map((block) => {
            const id = String(block.id ?? '')
            return (
              <label
                key={id}
                className='flex items-center justify-between gap-3 text-xs'
              >
                <span className='font-mono'>{id}</span>
                <Switch
                  checked={templateBlockEnabled(compat, preset, id)}
                  onCheckedChange={(on) =>
                    onChange(setTemplateBlock(compat, preset, id, on))
                  }
                />
              </label>
            )
          })}
        </div>
      ) : null}
    </Card>
  )
}
