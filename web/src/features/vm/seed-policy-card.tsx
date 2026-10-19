import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  telemetryEnabled,
  telemetrySeedFlags,
} from '@/features/vm/telemetry-policy'

export const DEFAULT_CLAUDE_SETTING =
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1'

const REJECT_FLAGS: [string, string][] = [
  ['reject_client_settings', '拒客户端 settings'],
  ['reject_client_metadata_identity', '拒客户端身份'],
]

type SeedPolicy = Record<string, boolean | string>

export const SEED_PRESETS: Record<string, SeedPolicy> = {
  standard: {
    ...telemetrySeedFlags(false),
    claude_setting: DEFAULT_CLAUDE_SETTING,
    reject_client_settings: true,
    reject_client_metadata_identity: true,
  },
  open: {
    ...telemetrySeedFlags(true),
    claude_setting: DEFAULT_CLAUDE_SETTING,
    reject_client_settings: false,
    reject_client_metadata_identity: false,
  },
  strict: {
    ...telemetrySeedFlags(false),
    claude_setting: DEFAULT_CLAUDE_SETTING,
    reject_client_settings: true,
    reject_client_metadata_identity: true,
  },
}

const PRESET_LABELS: [string, string, string][] = [
  ['standard', '标准', '拒客户端覆写，遥测关；需手动开启'],
  ['open', '开放', '不拒客户端；遥测开，非必要流量=1'],
  ['strict', '关闭遥测', '关遥测 + DNT；非必要流量=0'],
]

/** Mirrors follow the telemetry bit. Reject flags are left alone. */
export function alignTelemetryDraft(draft: SeedPolicy): SeedPolicy {
  return { ...draft, ...telemetrySeedFlags(telemetryEnabled(draft)) }
}

/**
 * 预设名 → 提交给后端的种子策略。`theme: 'dark'` 是固定值（非用户可选项）。
 */
export function seedPolicyOf(name: string): Record<string, boolean | string> {
  return { ...(SEED_PRESETS[name] || SEED_PRESETS.standard), theme: 'dark' }
}

export function matchSeedPreset(policy: Record<string, unknown>): string {
  const on = telemetryEnabled(policy)
  for (const [name, preset] of Object.entries(SEED_PRESETS)) {
    if (telemetryEnabled(preset) !== on) continue
    if (REJECT_FLAGS.every(([k]) => !!preset[k] === !!policy[k])) return name
  }
  return 'custom'
}

function normalize(policy: Record<string, unknown>): SeedPolicy {
  const out: SeedPolicy = { ...telemetrySeedFlags(telemetryEnabled(policy)) }
  out.claude_setting =
    typeof policy.claude_setting === 'string'
      ? policy.claude_setting
      : DEFAULT_CLAUDE_SETTING
  for (const [k] of REJECT_FLAGS) {
    out[k] = k in policy ? !!policy[k] : !!SEED_PRESETS.standard[k]
  }
  return out
}

export function SeedPolicyCard({
  policy,
  onSave,
  saving,
  syncTelemetry = false,
}: {
  policy: Record<string, unknown>
  onSave: (next: SeedPolicy) => void
  saving: boolean
  /** External official_cc.sync_telemetry. True means the next init turns telemetry back on. */
  syncTelemetry?: boolean
}) {
  const [draft, setDraft] = useState<SeedPolicy>(() =>
    alignTelemetryDraft(normalize(policy))
  )
  useEffect(() => {
    setDraft(alignTelemetryDraft(normalize(policy)))
  }, [policy])

  const current = matchSeedPreset(draft)
  const saved = normalize(policy)
  const dirty =
    telemetryEnabled(draft) !== telemetryEnabled(saved) ||
    REJECT_FLAGS.some(([k]) => !!draft[k] !== !!saved[k]) ||
    draft.claude_setting !== saved.claude_setting
  const on = telemetryEnabled(draft)

  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>种子策略</CardTitle>
      </CardHeader>
      <CardContent className='space-y-4 pt-0'>
        <div className='space-y-2'>
          <div className='flex flex-wrap gap-2'>
            {PRESET_LABELS.map(([key, label, desc]) => (
              <Button
                key={key}
                size='sm'
                variant={current === key ? 'default' : 'outline'}
                aria-pressed={current === key}
                title={desc}
                disabled={saving}
                onClick={() =>
                  setDraft(alignTelemetryDraft({ ...SEED_PRESETS[key] }))
                }
              >
                {label}
              </Button>
            ))}
            {current === 'custom' ? (
              <Button size='sm' variant='secondary' disabled aria-pressed>
                自定义
              </Button>
            ) : null}
          </div>
          <p className='text-xs text-muted-foreground'>
            {current === 'custom'
              ? '当前组合不匹配任何预设。'
              : PRESET_LABELS.find(([k]) => k === current)?.[2]}
          </p>
        </div>

        <div className='space-y-2 border-t pt-3'>
          <div className='flex items-center justify-between gap-3'>
            <Label htmlFor='seed-telemetry' className='text-sm font-normal'>
              遥测
            </Label>
            <Switch
              id='seed-telemetry'
              checked={on}
              disabled={saving}
              onCheckedChange={(v) =>
                setDraft(
                  alignTelemetryDraft({ ...draft, telemetry_disabled: !v })
                )
              }
            />
          </div>
          {REJECT_FLAGS.map(([key, label]) => (
            <div key={key} className='flex items-center justify-between gap-3'>
              <Label htmlFor={`seed-${key}`} className='text-sm font-normal'>
                {label}
              </Label>
              <Switch
                id={`seed-${key}`}
                checked={!!draft[key]}
                disabled={saving}
                onCheckedChange={(v) => setDraft({ ...draft, [key]: v })}
              />
            </div>
          ))}
        </div>
        <p className='text-xs text-muted-foreground'>
          {on
            ? '遥测开：非必要流量=1，DNT 关。这两项跟着遥测走，不能单独拨。'
            : '遥测关：非必要流量=0，DNT 开。这两项跟着遥测走，不能单独拨。'}
          {syncTelemetry
            ? ' 外部初装「同步遥测」开着，下次换票会按那份配置把本槽遥测重新打开。'
            : ' 外部初装「同步遥测」关着，换票不会改写这里的遥测开关。'}
        </p>

        <div className='space-y-2 border-t pt-3'>
          <Label htmlFor='seed-claude-setting' className='text-sm font-normal'>
            claude.setting
          </Label>
          <Textarea
            id='seed-claude-setting'
            value={String(draft.claude_setting || '')}
            disabled={saving}
            onChange={(e) =>
              setDraft({ ...draft, claude_setting: e.target.value })
            }
            className='min-h-24 font-mono text-xs'
            spellCheck={false}
            placeholder={DEFAULT_CLAUDE_SETTING}
          />
          <p className='text-xs text-muted-foreground'>
            每行一个 Claude 设置。默认写入 <code>{DEFAULT_CLAUDE_SETTING}</code>
            。
          </p>
        </div>

        <div className='flex gap-2 border-t pt-3'>
          <Button
            size='sm'
            disabled={saving || !dirty}
            onClick={() => onSave(alignTelemetryDraft(draft))}
          >
            {saving ? '写入中…' : '播种'}
          </Button>
          <Button
            size='sm'
            variant='ghost'
            disabled={saving || !dirty}
            onClick={() => setDraft(normalize(policy))}
          >
            重置
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
