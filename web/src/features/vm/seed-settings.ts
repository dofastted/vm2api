import type { VmKernelSnapshot, VmSeedSettings } from '@/types/panel-vm'
import {
  telemetryEnabled,
  telemetrySeedFlags,
  telemetryView,
  type TelemetrySeedFlags,
} from '@/features/vm/telemetry-policy'
import { telemetryStatusLabel } from '@/features/vm/telemetry-status'

export const DEFAULT_CLAUDE_SETTING =
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1'

export const REJECT_FLAGS = [
  ['reject_client_settings', '拒客户端 settings'],
  ['reject_client_metadata_identity', '拒客户端身份'],
] as const

const TOP_KEYS = ['theme', 'autoUpdates', 'grove_enabled'] as const

export type SettingRow = {
  key: string
  value: string
  /** True when this env key is also named in the editable claude.setting text. */
  inClaudeSetting: boolean
}

export type SeedDraft = TelemetrySeedFlags & {
  claude_setting: string
  reject_client_settings: boolean
  reject_client_metadata_identity: boolean
}

type ObservedTelemetry = NonNullable<VmKernelSnapshot['telemetry']>

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function settingText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : fallback
}

/** Keys named by `KEY=value` lines. Comments and blanks do not count. */
export function claudeSettingKeys(text: string): Set<string> {
  const keys = new Set<string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    const key = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim()
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) keys.add(key)
  }
  return keys
}

/**
 * Rows from the slot file `settings.json`. Missing file yields no rows —
 * the policy default string is not a substitute for the file.
 */
export function settingsRows(
  settings: Record<string, unknown> | null | undefined,
  claudeSetting: string
): SettingRow[] {
  const root = asRecord(settings)
  if (!root) return []
  const env = asRecord(root.env) || {}
  const named = claudeSettingKeys(claudeSetting)
  const keys = Object.keys(env)
  const rows: SettingRow[] = keys.map((key) => ({
    key,
    value: env[key] == null ? '' : String(env[key]),
    inClaudeSetting: named.has(key),
  }))
  for (const key of TOP_KEYS) {
    if (!(key in root)) continue
    rows.push({
      key,
      value: root[key] == null ? '' : String(root[key]),
      inClaudeSetting: false,
    })
  }
  return rows
}

export function seedDraftOf(
  seed: VmSeedSettings | null | undefined
): SeedDraft {
  const policy = asRecord(seed?.seed_policy) || {}
  const enabled = telemetryEnabled(policy)
  // null/undefined: the file was not read, so the policy text is the only copy.
  // An empty string is a real file and stays empty.
  const fileSetting = settingText(seed?.claude_setting)
  const policySetting = settingText(policy.claude_setting, '')
  return {
    ...telemetrySeedFlags(enabled),
    claude_setting:
      seed?.claude_setting == null
        ? policySetting || DEFAULT_CLAUDE_SETTING
        : fileSetting,
    reject_client_settings:
      'reject_client_settings' in policy
        ? policy.reject_client_settings !== false
        : true,
    reject_client_metadata_identity:
      'reject_client_metadata_identity' in policy
        ? policy.reject_client_metadata_identity !== false
        : true,
  }
}

export function sameDraft(a: SeedDraft, b: SeedDraft): boolean {
  return (
    telemetryEnabled(a) === telemetryEnabled(b) &&
    a.claude_setting === b.claude_setting &&
    a.reject_client_settings === b.reject_client_settings &&
    a.reject_client_metadata_identity === b.reject_client_metadata_identity
  )
}

/** Body for PUT /seed-settings. Mirrors follow the telemetry bit. */
export function seedSaveBody(
  draft: SeedDraft
): Record<string, boolean | string> {
  return {
    ...telemetrySeedFlags(telemetryEnabled(draft)),
    claude_setting: draft.claude_setting.replace(/\n+$/g, ''),
    reject_client_settings: draft.reject_client_settings,
    reject_client_metadata_identity: draft.reject_client_metadata_identity,
  }
}

export type TelemetryLive = {
  on: boolean | null
  running: boolean | null
  label: string
  tone: 'on' | 'off' | 'unknown'
}

/**
 * Live lamp. `running` is the process probe and is never rewritten into
 * on/off. Configured on/off comes from the seed bit when a policy exists.
 */
export function telemetryLive(
  seed: VmSeedSettings | null | undefined,
  observed: ObservedTelemetry | null | undefined
): TelemetryLive {
  const policy = asRecord(seed?.seed_policy)
  const view = telemetryView(policy, observed)
  const enabled = view?.enabled
  const running = observed?.running
  const on = enabled === true ? true : enabled === false ? false : null
  return {
    on,
    running: typeof running === 'boolean' ? running : null,
    label: telemetryStatusLabel(view),
    tone: on === true ? 'on' : on === false ? 'off' : 'unknown',
  }
}
