import type { ScheduleState, Vm, VmProxySnap } from '@/types/panel-vm'
import {
  geminiAccountStatus,
  geminiHostBlocker,
} from '@/lib/gemini-account-status'
import {
  geminiPayloadIssue,
  type GeminiEnvironment,
  type GeminiInventory,
} from '@/features/import/gemini-environments'

function isValidFraction(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
}

type GeminiWindowPick = {
  utilization: number | null
  resetAt: string | null
}

function pickTightestWindow(
  entries: ReadonlyArray<{
    remaining_fraction: number | null
    reset_at?: string | null
  }>
): GeminiWindowPick {
  let minRemaining: number | null = null
  let resetAt: string | null = null
  for (const entry of entries) {
    if (!isValidFraction(entry.remaining_fraction)) continue
    if (minRemaining == null || entry.remaining_fraction < minRemaining) {
      minRemaining = entry.remaining_fraction
      resetAt = entry.reset_at ?? null
    } else if (
      entry.remaining_fraction === minRemaining &&
      !resetAt &&
      entry.reset_at
    ) {
      resetAt = entry.reset_at
    }
  }
  if (minRemaining == null) {
    const fallbackReset =
      entries.find((entry) => entry.reset_at)?.reset_at ?? null
    return { utilization: null, resetAt: fallbackReset }
  }
  return {
    utilization: Math.max(0, Math.min(1, 1 - minRemaining)),
    resetAt,
  }
}

export function geminiQuotaWindows(environment: GeminiEnvironment): {
  fiveHour: GeminiWindowPick
  weekly: GeminiWindowPick
} {
  if (environment.auth_method !== 'oauth') {
    return {
      fiveHour: { utilization: null, resetAt: null },
      weekly: { utilization: null, resetAt: null },
    }
  }
  const groups = environment.account?.quota_groups ?? []
  const fiveHourEntries = groups.flatMap((group) =>
    group.windows.filter((window) => window.period === '5h')
  )
  const weeklyEntries = groups.flatMap((group) =>
    group.windows.filter((window) => window.period === 'weekly')
  )
  const fiveHourFromGroups = pickTightestWindow(fiveHourEntries)
  const fiveHour =
    fiveHourFromGroups.utilization != null
      ? fiveHourFromGroups
      : pickTightestWindow(environment.account?.quotas ?? [])
  const weekly = pickTightestWindow(weeklyEntries)
  return { fiveHour, weekly }
}

export function geminiSlot(
  environment: GeminiEnvironment,
  inventory?: GeminiInventory,
  proxies?: VmProxySnap[]
): Vm {
  const { auth_state: auth, account, usage } = environment
  const quota = geminiQuotaWindows(environment)
  const hostBlocker = geminiHostBlocker(
    environment,
    inventory,
    geminiPayloadIssue(inventory)
  )
  const status = geminiAccountStatus(environment, hostBlocker)
  const schedulable = auth !== 'disabled' && environment.schedulable !== false
  const restriction =
    environment.restriction &&
    (!environment.restriction.until ||
      environment.restriction.until > Date.now())
      ? environment.restriction
      : null
  const circuit =
    environment.circuit && environment.circuit.state !== 'closed'
      ? environment.circuit
      : null
  const scheduleState: ScheduleState =
    auth === 'disabled' || environment.schedulable === false
      ? 'off'
      : auth === 'reauth_required' || Boolean(status.blocker)
        ? 'unschedulable'
        : status.group === 'restricted'
          ? 'restricted'
          : 'on'
  const seatsMax =
    typeof environment.max_concurrency === 'number' &&
    Number.isFinite(environment.max_concurrency) &&
    environment.max_concurrency > 0
      ? environment.max_concurrency
      : null
  const activeSlots =
    typeof environment.inflight === 'number' &&
    Number.isFinite(environment.inflight)
      ? environment.inflight
      : typeof environment.active_slots === 'number' &&
          Number.isFinite(environment.active_slots)
        ? environment.active_slots
        : 0
  return {
    id: environment.id,
    name: environment.name,
    gemini: environment,
    owner_user_id: environment.owner_user_id ?? null,
    origin: environment.owner_user_id ? 'admin_assigned' : 'platform',
    schedulable,
    schedule_state: scheduleState,
    schedule_level:
      typeof environment.schedule_level === 'number' &&
      Number.isInteger(environment.schedule_level) &&
      environment.schedule_level >= 1 &&
      environment.schedule_level <= 10
        ? environment.schedule_level
        : 5,
    schedule_level_mode:
      environment.schedule_level_mode === 'manual' ? 'manual' : 'auto',
    ...(restriction
      ? {
          restriction_reason: restriction.reason,
          restriction_text: restriction.text,
          restriction_until: restriction.until,
          ...(restriction.until
            ? {
                cooldown_until: restriction.until,
                cooldown_reason: restriction.text,
              }
            : {}),
        }
      : {}),
    ...(circuit ? { circuit } : {}),
    email: account?.email || undefined,
    expires_at: account?.expires_at || undefined,
    // Same pool row a normal slot carries, so ProxyChip renders one way for both.
    proxy: proxies?.find((p) => p.id === environment.proxy_id) ?? {
      id: environment.proxy_id,
    },
    proxy_id: environment.proxy_id,
    proxy_configured: true,
    credential_mode: environment.auth_method === 'oauth' ? 'oauth' : 'apikey',
    has_token: auth === 'authorized' || (auth === 'disabled' && !!account),
    utilization_5h: quota.fiveHour.utilization,
    reset_5h: quota.fiveHour.resetAt || undefined,
    utilization_7d: quota.weekly.utilization,
    reset_7d: quota.weekly.resetAt || undefined,
    ...(seatsMax != null
      ? {
          seats_used: activeSlots,
          seats_max: seatsMax,
          max_concurrency: seatsMax,
        }
      : {}),
    inflight: activeSlots,
    ...(usage
      ? {
          today_cost: usage.today_cost,
          today_requests: usage.today_requests,
          today_tokens: usage.today_tokens,
          today_input_tokens: usage.today_input_tokens,
          today_output_tokens: usage.today_output_tokens,
          today_cache_read_tokens: usage.today_cache_read_tokens,
          today_cache_creation_tokens: usage.today_cache_creation_tokens,
          cache_hit_rate: usage.cache_hit_rate,
          window_5h_cost: usage.window_5h_cost,
          window_5h_requests: usage.window_5h_requests,
          window_5h_tokens: usage.window_5h_tokens,
          window_7d_cost: usage.window_7d_cost,
          window_7d_requests: usage.window_7d_requests,
          window_7d_success: usage.window_7d_success,
          window_7d_errors: usage.window_7d_errors,
          window_7d_tokens: usage.window_7d_tokens,
          total_cost: usage.total_cost,
          total_tokens: usage.total_tokens,
          health_24h: usage.health_24h,
        }
      : {}),
    // The host prerequisite is display context, not an inferred scheduler state.
    unschedulable_text: hostBlocker,
  }
}
