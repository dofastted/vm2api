import { useEffect, useState } from 'react'
import type { VmKernelSnapshot, VmSeedSettings } from '@/types/panel-vm'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  DEFAULT_CLAUDE_SETTING,
  REJECT_FLAGS,
  seedDraftOf,
  seedSaveBody,
  settingsRows,
  sameDraft,
  telemetryLive,
  type SeedDraft,
} from '@/features/vm/seed-settings'
import { telemetryEnabled } from '@/features/vm/telemetry-policy'

export { DEFAULT_CLAUDE_SETTING }

type ObservedTelemetry = NonNullable<VmKernelSnapshot['telemetry']>

function Lamp({ tone }: { tone: 'on' | 'off' | 'unknown' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex size-2.5 shrink-0 rounded-full',
        tone === 'on' && 'bg-primary',
        tone === 'off' && 'bg-[var(--status-warn)]',
        tone === 'unknown' && 'bg-muted-foreground/50'
      )}
    >
      {tone !== 'unknown' ? (
        <span
          className={cn(
            'absolute inset-0 rounded-full motion-safe:animate-ping',
            tone === 'on' ? 'bg-primary/70' : 'bg-[var(--status-warn)]/70'
          )}
        />
      ) : null}
    </span>
  )
}

function ToggleRow({
  id,
  label,
  detail,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string
  label: string
  detail: string
  checked: boolean
  disabled: boolean
  onCheckedChange: (next: boolean) => void
}) {
  return (
    <div className='flex items-center justify-between gap-3 py-2.5'>
      <div className='min-w-0'>
        <Label htmlFor={id} className='text-sm font-medium'>
          {label}
        </Label>
        <p className='text-xs text-muted-foreground'>{detail}</p>
      </div>
      <div className='flex items-center gap-2'>
        <span
          className={cn(
            'font-mono text-[11px] tracking-wide',
            checked ? 'text-primary' : 'text-muted-foreground'
          )}
        >
          {checked ? '开' : '关'}
        </span>
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />
      </div>
    </div>
  )
}

export function SeedPolicyCard({
  seed,
  telemetry,
  onSave,
  saving,
  syncTelemetry = false,
}: {
  seed: VmSeedSettings
  telemetry?: ObservedTelemetry | null
  onSave: (next: Record<string, boolean | string>) => void
  saving: boolean
  /** External official_cc.sync_telemetry. True means the next init turns telemetry back on. */
  syncTelemetry?: boolean
}) {
  const saved = seedDraftOf(seed)
  const [draft, setDraft] = useState<SeedDraft>(saved)
  useEffect(() => {
    setDraft(seedDraftOf(seed))
  }, [seed])

  const dirty = !sameDraft(draft, saved)
  const on = telemetryEnabled(draft)
  const live = telemetryLive(seed, telemetry)
  const fileSetting =
    typeof seed.claude_setting === 'string' ? seed.claude_setting : ''
  const rows = settingsRows(seed.settings_json, fileSetting)
  const fileMissing = seed.settings_json == null

  const patch = (next: Partial<SeedDraft>) =>
    setDraft((current) => ({ ...current, ...next }))

  return (
    <div className='grid items-start gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.8fr)]'>
      <section className='min-w-0 overflow-hidden rounded-xl border bg-card'>
        <header className='flex items-baseline justify-between gap-3 border-b px-4 py-3'>
          <h2 className='text-sm font-semibold'>当前槽 settings.json</h2>
          <p className='font-mono text-[11px] text-muted-foreground'>
            {fileMissing ? '文件未写入' : `${rows.length} 项`}
          </p>
        </header>
        {fileMissing ? (
          <p className='px-4 py-8 text-sm text-muted-foreground'>
            这槽还没有 settings.json。播种之后，这里显示写进文件的项。
          </p>
        ) : rows.length === 0 ? (
          <p className='px-4 py-8 text-sm text-muted-foreground'>
            文件在，但没有 env 项。
          </p>
        ) : (
          <div className='overflow-x-auto'>
            <table className='w-full border-collapse text-left'>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className='border-b last:border-b-0'>
                    <th
                      scope='row'
                      className='px-4 py-2 align-top font-mono text-xs font-medium text-foreground'
                    >
                      <span className='inline-flex items-center gap-2'>
                        {row.inClaudeSetting ? (
                          <span
                            className='size-1.5 shrink-0 rounded-full bg-primary'
                            title='也写在 claude.setting'
                          />
                        ) : (
                          <span className='size-1.5 shrink-0' />
                        )}
                        {row.key}
                      </span>
                    </th>
                    <td className='px-4 py-2 text-end font-mono text-xs break-all text-muted-foreground'>
                      {row.value === '' ? '空' : row.value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <aside className='min-w-0 rounded-xl border bg-card'>
        <div
          className='flex items-center gap-3 border-b px-4 py-3'
          role='status'
          aria-live='polite'
        >
          <Lamp tone={live.tone} />
          <div className='min-w-0'>
            <p className='text-sm font-semibold'>
              遥测 {live.on === true ? '开' : live.on === false ? '关' : '未知'}
            </p>
            <p className='text-xs text-muted-foreground'>
              {live.label}
              {live.running === true
                ? ' · 进程在跑'
                : live.running === false
                  ? ' · 进程未跑'
                  : ' · 进程未知'}
            </p>
          </div>
        </div>

        <div className='divide-y px-4'>
          <ToggleRow
            id='seed-telemetry'
            label='遥测'
            detail={
              on
                ? '非必要流量=1，DNT 关。这两项跟着开关走。'
                : '非必要流量=0，DNT 开。这两项跟着开关走。'
            }
            checked={on}
            disabled={saving}
            onCheckedChange={(value) => patch({ telemetry_disabled: !value })}
          />
          {REJECT_FLAGS.map(([key, label]) => (
            <ToggleRow
              key={key}
              id={`seed-${key}`}
              label={label}
              detail={
                key === 'reject_client_settings'
                  ? draft.reject_client_settings
                    ? '入站 settings / env 会被丢掉。'
                    : '入站 settings 会留下来。'
                  : draft.reject_client_metadata_identity
                    ? '入站 user / machine 身份会被丢掉。'
                    : '入站身份会留下来。'
              }
              checked={!!draft[key]}
              disabled={saving}
              onCheckedChange={(value) => patch({ [key]: value })}
            />
          ))}
        </div>

        <div className='space-y-2 border-t px-4 py-3'>
          <Label htmlFor='seed-claude-setting' className='text-sm font-medium'>
            claude.setting
          </Label>
          <Textarea
            id='seed-claude-setting'
            value={draft.claude_setting}
            disabled={saving}
            onChange={(event) => patch({ claude_setting: event.target.value })}
            className='min-h-28 font-mono text-xs'
            spellCheck={false}
            placeholder={DEFAULT_CLAUDE_SETTING}
          />
          <p className='text-xs text-muted-foreground'>
            {syncTelemetry
              ? '下次换票会按外部初装把遥测重新打开。'
              : '换票不会改这里的遥测开关。'}
            {dirty ? ' 有未播种的改动。' : ' 与当前策略一致。'}
          </p>
        </div>

        <div className='flex gap-2 border-t px-4 py-3'>
          <Button
            size='sm'
            disabled={saving || !dirty}
            onClick={() => onSave(seedSaveBody(draft))}
          >
            {saving ? '写入中…' : '播种'}
          </Button>
          <Button
            size='sm'
            variant='ghost'
            disabled={saving || !dirty}
            onClick={() => setDraft(saved)}
          >
            重置
          </Button>
        </div>
      </aside>
    </div>
  )
}
