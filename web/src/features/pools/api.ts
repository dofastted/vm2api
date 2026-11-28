import type {
  SchedulerEventItem,
  SchedulerExplainRequest,
  SchedulerExplainResponse,
  SchedulerPool,
  SchedulerPoolMember,
  SchedulerPoolMemberInput,
  SchedulerStickyBinding,
} from '@/types/panel-pools'
import { api, isApiError, panelFetch } from '@/lib/api'
import { hasSession } from '@/lib/session'
import { parseSseFrames } from '@/features/vm/use-pool-seat-stream'
import {
  defaultSystemPromptModeForProvider,
  isPromptLockedProvider,
  normalizePoolPromptPreset,
  normalizeProviderScope,
  POOL_LOCKED_DEFAULTS,
} from './pool-rules'

function normalizePool(raw: Record<string, unknown>): SchedulerPool {
  const provider_scope = normalizeProviderScope(
    String(raw.provider_scope || 'mixed')
  )
  const locked = isPromptLockedProvider(provider_scope)
  const rawPlanTags = raw.plan_tags ?? raw.plan_tags_json
  let plan_tags: string[] = []
  if (Array.isArray(rawPlanTags)) {
    plan_tags = rawPlanTags.map(String).filter(Boolean)
  } else if (typeof rawPlanTags === 'string' && rawPlanTags.trim()) {
    try {
      const parsed = JSON.parse(rawPlanTags)
      if (Array.isArray(parsed)) plan_tags = parsed.map(String).filter(Boolean)
    } catch {
      plan_tags = rawPlanTags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }
  }
  const members = Array.isArray(raw.members)
    ? (raw.members as SchedulerPoolMember[])
    : undefined
  const vmIds = Array.isArray(raw.vm_ids) ? raw.vm_ids.map(String) : undefined

  return {
    id: String(raw.id || ''),
    slug: String(raw.slug || raw.id || ''),
    name: String(raw.name || raw.id || ''),
    description: String(raw.description || ''),
    enabled: raw.enabled !== false && raw.enabled !== 0,
    exclusive_members: Boolean(raw.exclusive_members),
    provider_scope,
    plan_tags,
    pool_role:
      (raw.pool_role as SchedulerPool['pool_role']) ||
      POOL_LOCKED_DEFAULTS.pool_role,
    sort_order: Number(raw.sort_order ?? 0),
    fallback_pool_id:
      raw.fallback_pool_id == null || raw.fallback_pool_id === ''
        ? null
        : String(raw.fallback_pool_id),
    allow_cross_prompt_fallback: Boolean(raw.allow_cross_prompt_fallback),
    intra_tier_strategy:
      (raw.intra_tier_strategy as SchedulerPool['intra_tier_strategy']) ||
      POOL_LOCKED_DEFAULTS.intra_tier_strategy,
    session_queue_max: Number(
      raw.session_queue_max ?? POOL_LOCKED_DEFAULTS.session_queue_max
    ),
    session_queue_timeout_ms: Number(
      raw.session_queue_timeout_ms ??
        POOL_LOCKED_DEFAULTS.session_queue_timeout_ms
    ),
    queue_wait_ms: Number(
      raw.queue_wait_ms ?? POOL_LOCKED_DEFAULTS.queue_wait_ms
    ),
    queue_max: Number(raw.queue_max ?? POOL_LOCKED_DEFAULTS.queue_max),
    machine_sticky_enabled:
      raw.machine_sticky_enabled !== false && raw.machine_sticky_enabled !== 0,
    machine_ttl_seconds: Number(
      raw.machine_ttl_seconds ?? POOL_LOCKED_DEFAULTS.machine_ttl_seconds
    ),
    session_sticky_enabled:
      raw.session_sticky_enabled !== false && raw.session_sticky_enabled !== 0,
    session_ttl_seconds: Number(
      raw.session_ttl_seconds ?? POOL_LOCKED_DEFAULTS.session_ttl_seconds
    ),
    session_busy_wait_ms: Number(
      raw.session_busy_wait_ms ?? POOL_LOCKED_DEFAULTS.session_busy_wait_ms
    ),
    session_overflow_policy:
      (raw.session_overflow_policy as SchedulerPool['session_overflow_policy']) ||
      POOL_LOCKED_DEFAULTS.session_overflow_policy,
    system_prompt_mode: locked
      ? 'passthrough'
      : (raw.system_prompt_mode as SchedulerPool['system_prompt_mode']) ||
        defaultSystemPromptModeForProvider(provider_scope),
    system_prompt_preset: normalizePoolPromptPreset(raw.system_prompt_preset),
    system_prompt_text: locked ? '' : String(raw.system_prompt_text || ''),
    client_system_policy:
      (raw.client_system_policy as SchedulerPool['client_system_policy']) ||
      POOL_LOCKED_DEFAULTS.client_system_policy,
    jev_profile:
      (raw.jev_profile as SchedulerPool['jev_profile']) ||
      POOL_LOCKED_DEFAULTS.jev_profile,
    config_version:
      raw.config_version != null ? Number(raw.config_version) : undefined,
    created_at: raw.created_at ? String(raw.created_at) : undefined,
    updated_at: raw.updated_at ? String(raw.updated_at) : undefined,
    members,
    metrics:
      raw.metrics && typeof raw.metrics === 'object'
        ? (raw.metrics as SchedulerPool['metrics'])
        : undefined,
    bound_keys: Array.isArray(raw.bound_keys)
      ? (raw.bound_keys as SchedulerPool['bound_keys'])
      : undefined,
    total_members:
      raw.total_members != null ? Number(raw.total_members) : undefined,
    healthy_members:
      raw.healthy_members != null ? Number(raw.healthy_members) : undefined,
    inflight: raw.inflight != null ? Number(raw.inflight) : undefined,
    max_concurrency:
      raw.max_concurrency != null ? Number(raw.max_concurrency) : undefined,
    bound_keys_count:
      raw.bound_keys_count != null ? Number(raw.bound_keys_count) : undefined,
    active_bound_keys_count:
      raw.active_bound_keys_count != null
        ? Number(raw.active_bound_keys_count)
        : undefined,
    vm_ids: vmIds,
  }
}

export const POOLS_BACKEND_NOT_READY =
  '分组池后端未就绪（/api/panel/pools 返回 404）'

export async function listSchedulerPools(
  signal?: AbortSignal
): Promise<SchedulerPool[]> {
  try {
    const res = await api<
      | { pools?: Record<string, unknown>[]; items?: Record<string, unknown>[] }
      | Record<string, unknown>[]
    >('/api/panel/pools', { signal })
    const rawList = Array.isArray(res) ? res : (res?.pools ?? res?.items ?? [])
    return rawList.map(normalizePool)
  } catch (err) {
    // 单一来源：不回退旧 /api/panel/vm-pools，交给 QueryGate 显示明确错误。
    if (isApiError(err) && err.status === 404) {
      err.message = POOLS_BACKEND_NOT_READY
      throw err
    }
    throw err
  }
}

export async function getSchedulerPool(
  id: string,
  signal?: AbortSignal
): Promise<SchedulerPool> {
  const res = await api<
    { pool?: Record<string, unknown>; item?: Record<string, unknown> } & Record<
      string,
      unknown
    >
  >(`/api/panel/pools/${encodeURIComponent(id)}`, { signal })
  const payload =
    (res?.pool as Record<string, unknown> | undefined) ??
    (res?.item as Record<string, unknown> | undefined) ??
    res
  return normalizePool(payload || { id })
}

export async function createSchedulerPool(
  body: Record<string, unknown>
): Promise<SchedulerPool> {
  const res = await api<
    { pool?: Record<string, unknown>; item?: Record<string, unknown> } & Record<
      string,
      unknown
    >
  >('/api/panel/pools', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return normalizePool(
    (res?.pool as Record<string, unknown>) ??
      (res?.item as Record<string, unknown>) ??
      res
  )
}

export async function updateSchedulerPool(
  id: string,
  patch: Record<string, unknown>
): Promise<SchedulerPool> {
  const res = await api<
    { pool?: Record<string, unknown>; item?: Record<string, unknown> } & Record<
      string,
      unknown
    >
  >(`/api/panel/pools/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  return normalizePool(
    (res?.pool as Record<string, unknown>) ??
      (res?.item as Record<string, unknown>) ??
      res
  )
}

export async function deleteSchedulerPool(
  id: string,
  opts: { force?: boolean } = {}
): Promise<{ deleted?: boolean }> {
  const qs = opts.force ? '?force=1' : ''
  return api<{ deleted?: boolean }>(
    `/api/panel/pools/${encodeURIComponent(id)}${qs}`,
    { method: 'DELETE' }
  )
}

export async function replacePoolMembers(
  id: string,
  members: SchedulerPoolMemberInput[]
): Promise<SchedulerPool> {
  const res = await api<
    { pool?: Record<string, unknown>; item?: Record<string, unknown> } & Record<
      string,
      unknown
    >
  >(`/api/panel/pools/${encodeURIComponent(id)}/members`, {
    method: 'PUT',
    body: JSON.stringify({ members }),
  })
  return normalizePool(
    (res?.pool as Record<string, unknown>) ??
      (res?.item as Record<string, unknown>) ??
      res
  )
}

export async function resetPoolMachineSticky(
  id: string,
  body: { node_type?: string; node_id?: string; node_key?: string } = {}
): Promise<{ cleared?: number; count?: number }> {
  return api<{ cleared?: number; count?: number }>(
    `/api/panel/pools/${encodeURIComponent(id)}/reset-machine-sticky`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  )
}

export async function explainSchedule(
  body: SchedulerExplainRequest
): Promise<SchedulerExplainResponse> {
  return api<SchedulerExplainResponse>('/api/panel/scheduler/explain', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function unrestSchedulerNode(
  nodeKey: string
): Promise<{ ok?: boolean; unrested?: boolean; woke_waiters?: number }> {
  return api<{ ok?: boolean; unrested?: boolean; woke_waiters?: number }>(
    `/api/panel/scheduler/nodes/${encodeURIComponent(nodeKey)}/unrest`,
    { method: 'POST' }
  )
}

export type StickyQueryParams = {
  pool_id?: string
  scope_kind?: 'machine' | 'session'
  machine_id?: string
  session_id?: string
  identity_id?: string
}

export async function listSchedulerSticky(
  params: StickyQueryParams = {},
  signal?: AbortSignal
): Promise<SchedulerStickyBinding[]> {
  const qs = new URLSearchParams()
  if (params.pool_id) qs.set('pool_id', params.pool_id)
  if (params.scope_kind) qs.set('scope_kind', params.scope_kind)
  if (params.machine_id) qs.set('machine_id', params.machine_id)
  if (params.session_id) qs.set('session_id', params.session_id)
  if (params.identity_id) qs.set('identity_id', params.identity_id)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const res = await api<
    | { items?: SchedulerStickyBinding[]; bindings?: SchedulerStickyBinding[] }
    | SchedulerStickyBinding[]
  >(`/api/panel/scheduler/sticky${suffix}`, { signal })
  if (Array.isArray(res)) return res
  return res?.items ?? res?.bindings ?? []
}

export async function deleteSchedulerSticky(params: {
  pool_id?: string
  scope_kind?: 'machine' | 'session'
  model_family?: string
  identity_id?: string
  machine_id?: string
  session_id?: string
}): Promise<{ deleted?: number }> {
  const qs = new URLSearchParams()
  if (params.pool_id) qs.set('pool_id', params.pool_id)
  if (params.scope_kind) qs.set('scope_kind', params.scope_kind)
  if (params.model_family) qs.set('model_family', params.model_family)
  if (params.identity_id) qs.set('identity_id', params.identity_id)
  if (params.machine_id) qs.set('machine_id', params.machine_id)
  if (params.session_id) qs.set('session_id', params.session_id)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return api<{ deleted?: number }>(`/api/panel/scheduler/sticky${suffix}`, {
    method: 'DELETE',
  })
}

export type SchedulerStreamStatus =
  'connecting' | 'connected' | 'reconnecting' | 'unavailable' | 'paused'

/**
 * 订阅 `/api/panel/scheduler/events` SSE 实时路由流，支持 `epoch:seq` 游标续传
 * 与 `409 snapshot_required` 越窗自动重置游标。
 */
export function startSchedulerEventsStream(options: {
  poolId?: string
  initialCursor?: string
  signal: AbortSignal
  onEvent: (event: SchedulerEventItem, nextCursor?: string) => void
  onStatus?: (status: SchedulerStreamStatus, detail?: string) => void
  onSnapshotRequired?: () => void
}) {
  let cursor = options.initialCursor || ''
  let retryTimer: number | undefined

  const connect = async () => {
    if (options.signal.aborted || !hasSession()) return
    options.onStatus?.(cursor ? 'reconnecting' : 'connecting')
    const qs = new URLSearchParams()
    if (cursor) qs.set('after', cursor)
    if (options.poolId) qs.set('pool_id', options.poolId)
    const path = `/api/panel/scheduler/events${qs.toString() ? `?${qs.toString()}` : ''}`
    let fatal = false
    try {
      const res = await panelFetch(path, {
        signal: options.signal,
        headers: { Accept: 'text/event-stream' },
      })
      if (res.status === 409) {
        cursor = ''
        options.onSnapshotRequired?.()
        if (!options.signal.aborted) {
          retryTimer = window.setTimeout(() => void connect(), 1000)
        }
        return
      }
      if (res.status === 401 || res.status === 403) {
        fatal = true
        options.onStatus?.('unavailable', `无权访问事件流 (${res.status})`)
        return
      }
      if (res.status === 404 || res.status === 503) {
        options.onStatus?.(
          'unavailable',
          res.status === 503
            ? '调度引擎暂不可用 (503)'
            : '调度事件流端点尚未启用 (404)'
        )
        return
      }
      if (!res.ok || !res.body) {
        options.onStatus?.('reconnecting', `HTTP ${res.status}`)
        return
      }
      options.onStatus?.('connected')
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const parsed = parseSseFrames(buffer + value)
        buffer = parsed.rest
        for (const frame of parsed.frames) {
          if (frame.event === 'heartbeat' || frame.event === 'ping') continue
          try {
            const data = JSON.parse(frame.data) as SchedulerEventItem
            const nextCursor =
              data.cursor ||
              (data.epoch != null && data.seq != null
                ? `${data.epoch}:${data.seq}`
                : undefined)
            if (nextCursor) cursor = nextCursor
            options.onEvent(
              {
                ...data,
                type: data.type || data.event_type || frame.event,
              },
              nextCursor
            )
          } catch {
            // 忽略单帧 JSON 损坏，维持长连接
          }
        }
      }
    } catch {
      // 网络中断或 abort
    } finally {
      if (!options.signal.aborted && !fatal) {
        options.onStatus?.('reconnecting')
        retryTimer = window.setTimeout(() => void connect(), 4000)
      }
    }
  }

  void connect()

  return () => {
    clearTimeout(retryTimer)
  }
}
