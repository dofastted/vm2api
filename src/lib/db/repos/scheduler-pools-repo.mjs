/**
 * Unified scheduler center repository (SQLite + PostgreSQL dual-engine SSOT).
 *
 * Manages:
 * - scheduler_pools
 * - scheduler_pool_members
 * - api_key_pool_bindings (+ api_keys.default_pool_id / pool_binding_mode)
 * - scheduler_sticky_bindings
 * - scheduler_node_penalties
 *
 * Also exposes `bootstrapSchedulerPools({ db, isStandby })` for idempotent
 * Leader-only backfill from legacy `vm_pools` / `vm_pool_members` /
 * `api_keys.vm_pool_id` (strictly skipped under `KIN_STANDBY=1`).
 */
import crypto from 'node:crypto'
import { getDb, withTransaction } from '../database.mjs'

export const SCHEDULER_POOL_DEFAULTS = Object.freeze({
  description: '',
  enabled: true,
  exclusive_members: false,
  provider_scope: 'mixed',
  plan_tags: [],
  pool_role: 'standard',
  sort_order: 0,
  fallback_pool_id: null,
  allow_cross_prompt_fallback: false,
  intra_tier_strategy: 'least_inflight_swrr',
  session_queue_max: 16,
  session_queue_timeout_ms: 60000,
  queue_wait_ms: 15000,
  queue_max: 50,
  machine_sticky_enabled: true,
  machine_ttl_seconds: 604800,
  session_sticky_enabled: true,
  session_ttl_seconds: 86400,
  session_busy_wait_ms: 0,
  session_overflow_policy: 'spill_immediately',
  system_prompt_mode: 'inherit_global',
  system_prompt_preset: 'official_full',
  system_prompt_text: '',
  client_system_policy: 'prepend_pool',
  jev_profile: 'inherit_global',
})

const PROMPT_EXEMPT_PROVIDERS = new Set(['openai', 'google'])

function nowIso() {
  return new Date().toISOString()
}

export function normalizeProviderScope(scope) {
  const raw = String(scope ?? SCHEDULER_POOL_DEFAULTS.provider_scope)
    .trim()
    .toLowerCase()
  if (raw === 'gemini') return 'google'
  return raw || SCHEDULER_POOL_DEFAULTS.provider_scope
}

export function isPromptLockedProvider(scope) {
  return PROMPT_EXEMPT_PROVIDERS.has(normalizeProviderScope(scope))
}

export function defaultSystemPromptModeForProvider(scope) {
  return isPromptLockedProvider(scope) ? 'passthrough' : 'inherit_global'
}

export function slugifyPoolName(name, fallbackId = '') {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (base) return base
  const fb = String(fallbackId || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return fb || `pool-${crypto.randomBytes(4).toString('hex')}`
}

function assertPromptPolicyForProvider(providerScope, systemPromptMode) {
  if (isPromptLockedProvider(providerScope) && systemPromptMode !== 'passthrough') {
    throw Object.assign(new Error(`provider_scope=${providerScope} 仅支持 system_prompt_mode=passthrough`), {
      code: 'pool_prompt_unsupported_provider',
      status: 400,
    })
  }
}

function parseJsonArray(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function encodePlanTags(planTags, planTagsJson) {
  if (Array.isArray(planTags)) return JSON.stringify(planTags.map((t) => String(t)))
  if (typeof planTagsJson === 'string') return planTagsJson
  return '[]'
}

function rowToMember(row) {
  if (!row) return null
  return {
    pool_id: row.pool_id,
    node_type: row.node_type,
    node_id: row.node_id,
    enabled: Boolean(Number(row.enabled)),
    member_role: row.member_role,
    weight_tier_override: row.weight_tier_override == null ? null : Number(row.weight_tier_override),
    sub_weight_override: row.sub_weight_override == null ? null : Number(row.sub_weight_override),
    member_order: Number(row.member_order) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function rowToPool(row, members = []) {
  if (!row) return null
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    enabled: Boolean(Number(row.enabled)),
    exclusive_members: Boolean(Number(row.exclusive_members)),
    provider_scope: row.provider_scope,
    plan_tags: parseJsonArray(row.plan_tags_json),
    plan_tags_json: row.plan_tags_json ?? '[]',
    pool_role: row.pool_role,
    sort_order: Number(row.sort_order) || 0,
    fallback_pool_id: row.fallback_pool_id ?? null,
    allow_cross_prompt_fallback: Boolean(Number(row.allow_cross_prompt_fallback)),
    intra_tier_strategy: row.intra_tier_strategy,
    session_queue_max: Number(row.session_queue_max),
    session_queue_timeout_ms: Number(row.session_queue_timeout_ms),
    queue_wait_ms: Number(row.queue_wait_ms),
    queue_max: Number(row.queue_max),
    machine_sticky_enabled: Boolean(Number(row.machine_sticky_enabled)),
    machine_ttl_seconds: Number(row.machine_ttl_seconds),
    session_sticky_enabled: Boolean(Number(row.session_sticky_enabled)),
    session_ttl_seconds: Number(row.session_ttl_seconds),
    session_busy_wait_ms: Number(row.session_busy_wait_ms),
    session_overflow_policy: row.session_overflow_policy,
    system_prompt_mode: row.system_prompt_mode,
    system_prompt_preset: row.system_prompt_preset,
    system_prompt_text: row.system_prompt_text ?? '',
    client_system_policy: row.client_system_policy,
    jev_profile: row.jev_profile,
    config_version: Number(row.config_version) || 1,
    members,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function rowToBinding(row) {
  if (!row) return null
  return {
    api_key_id: row.api_key_id,
    pool_id: row.pool_id,
    is_default: Boolean(Number(row.is_default)),
    created_at: row.created_at,
  }
}

function rowToSticky(row) {
  if (!row) return null
  return {
    scope_kind: row.scope_kind,
    pool_id: row.pool_id,
    model_family: row.model_family,
    identity_id: row.identity_id,
    node_type: row.node_type,
    node_id: row.node_id,
    machine_id: row.machine_id ?? null,
    stood_in: Boolean(Number(row.stood_in)),
    bound_at_ms: Number(row.bound_at_ms),
    last_seen_ms: Number(row.last_seen_ms),
    expires_at_ms: Number(row.expires_at_ms),
    hits: Number(row.hits) || 0,
    generation: Number(row.generation) || 1,
  }
}

function rowToPenalty(row) {
  if (!row) return null
  return {
    node_type: row.node_type,
    node_id: row.node_id,
    model_scope: row.model_scope,
    reason: row.reason,
    cooldown_until_ms: Number(row.cooldown_until_ms),
    ladder_step: Number(row.ladder_step) || 0,
    updated_at: row.updated_at,
  }
}

function mapConstraint(error, { op = '' } = {}) {
  const message = String(error?.message || error)
  const code = String(error?.code || error?.pgCode || '')
  const detail = `${message} ${String(error?.constraint || '')}`
  if (code === '23505' || /UNIQUE|duplicate key/i.test(message)) {
    if (/idx_sched_pools_slug|slug/i.test(detail)) {
      return Object.assign(new Error('分组池标识 slug 已存在'), { code: 'scheduler_pool_slug_taken' })
    }
    if (/idx_sched_pools_name|name/i.test(detail)) {
      return Object.assign(new Error('分组池名称已存在'), { code: 'scheduler_pool_name_taken' })
    }
  }
  if (code === '23503' || /FOREIGN KEY|foreign key/i.test(message)) {
    if (op === 'remove' || /api_key_pool_bindings|pool_id/i.test(detail)) {
      return Object.assign(new Error('分组池仍有绑定的 API 密钥，无法删除'), { code: 'scheduler_pool_in_use' })
    }
  }
  return error
}

export class SchedulerPoolsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._listPools = db.prepare('SELECT * FROM scheduler_pools ORDER BY sort_order, created_at, id')
    this._getPool = db.prepare('SELECT * FROM scheduler_pools WHERE id = ?')
    this._getPoolBySlug = db.prepare('SELECT * FROM scheduler_pools WHERE LOWER(slug) = LOWER(?)')
    this._insertPool = db.prepare(`
      INSERT INTO scheduler_pools (
        id, slug, name, description, enabled, exclusive_members, provider_scope,
        plan_tags_json, pool_role, sort_order, fallback_pool_id, allow_cross_prompt_fallback,
        intra_tier_strategy, session_queue_max, session_queue_timeout_ms, queue_wait_ms,
        queue_max, machine_sticky_enabled, machine_ttl_seconds, session_sticky_enabled,
        session_ttl_seconds, session_busy_wait_ms, session_overflow_policy,
        system_prompt_mode, system_prompt_preset, system_prompt_text, client_system_policy,
        jev_profile, config_version, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `)
    this._updatePool = db.prepare(`
      UPDATE scheduler_pools SET
        slug = ?,
        name = ?,
        description = ?,
        enabled = ?,
        exclusive_members = ?,
        provider_scope = ?,
        plan_tags_json = ?,
        pool_role = ?,
        sort_order = ?,
        fallback_pool_id = ?,
        allow_cross_prompt_fallback = ?,
        intra_tier_strategy = ?,
        session_queue_max = ?,
        session_queue_timeout_ms = ?,
        queue_wait_ms = ?,
        queue_max = ?,
        machine_sticky_enabled = ?,
        machine_ttl_seconds = ?,
        session_sticky_enabled = ?,
        session_ttl_seconds = ?,
        session_busy_wait_ms = ?,
        session_overflow_policy = ?,
        system_prompt_mode = ?,
        system_prompt_preset = ?,
        system_prompt_text = ?,
        client_system_policy = ?,
        jev_profile = ?,
        config_version = config_version + 1,
        updated_at = ?
      WHERE id = ?
    `)
    this._touchPool = db.prepare(
      'UPDATE scheduler_pools SET config_version = config_version + 1, updated_at = ? WHERE id = ?',
    )
    this._deletePool = db.prepare('DELETE FROM scheduler_pools WHERE id = ?')

    this._membersByPool = db.prepare(
      'SELECT * FROM scheduler_pool_members WHERE pool_id = ? ORDER BY member_order, node_type, node_id',
    )
    this._allMembers = db.prepare(
      'SELECT * FROM scheduler_pool_members ORDER BY pool_id, member_order, node_type, node_id',
    )
    this._clearMembers = db.prepare('DELETE FROM scheduler_pool_members WHERE pool_id = ?')
    this._insertMember = db.prepare(`
      INSERT INTO scheduler_pool_members (
        pool_id, node_type, node_id, enabled, member_role,
        weight_tier_override, sub_weight_override, member_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._deleteNodeMembers = db.prepare('DELETE FROM scheduler_pool_members WHERE node_type = ? AND node_id = ?')

    this._bindingsByPool = db.prepare(
      'SELECT * FROM api_key_pool_bindings WHERE pool_id = ? ORDER BY is_default DESC, api_key_id',
    )
    this._bindingsByKey = db.prepare(
      'SELECT * FROM api_key_pool_bindings WHERE api_key_id = ? ORDER BY is_default DESC, pool_id',
    )
    this._allBindings = db.prepare('SELECT * FROM api_key_pool_bindings ORDER BY api_key_id, is_default DESC, pool_id')
    this._boundKeySummariesByPool = db.prepare(`
      SELECT
        b.api_key_id,
        b.pool_id,
        b.is_default,
        b.created_at,
        k.name,
        k.key_prefix,
        k.status,
        k.pool_binding_mode,
        k.max_concurrency,
        k.rpm,
        k.requests
      FROM api_key_pool_bindings b
      INNER JOIN api_keys k ON k.id = b.api_key_id
      WHERE b.pool_id = ? AND k.deleted_at IS NULL
      ORDER BY b.is_default DESC, k.created_at, b.api_key_id
    `)
    this._allBoundKeySummaries = db.prepare(`
      SELECT
        b.api_key_id,
        b.pool_id,
        b.is_default,
        b.created_at,
        k.name,
        k.key_prefix,
        k.status,
        k.pool_binding_mode,
        k.max_concurrency,
        k.rpm,
        k.requests
      FROM api_key_pool_bindings b
      INNER JOIN api_keys k ON k.id = b.api_key_id
      WHERE k.deleted_at IS NULL
      ORDER BY b.pool_id, b.is_default DESC, k.created_at, b.api_key_id
    `)
    this._countKeysByPool = db.prepare('SELECT COUNT(*) AS n FROM api_key_pool_bindings WHERE pool_id = ?')
    this._countNonDeletedKeysByPool = db.prepare(`
      SELECT COUNT(*) AS n
      FROM api_key_pool_bindings b
      INNER JOIN api_keys k ON k.id = b.api_key_id
      WHERE b.pool_id = ? AND k.deleted_at IS NULL
    `)
    this._countActiveKeysByPool = db.prepare(`
      SELECT COUNT(*) AS n
      FROM api_key_pool_bindings b
      INNER JOIN api_keys k ON k.id = b.api_key_id
      WHERE b.pool_id = ? AND k.deleted_at IS NULL AND k.status = 'active'
    `)
    this._clearKeyBindings = db.prepare('DELETE FROM api_key_pool_bindings WHERE api_key_id = ?')
    this._clearBindingsForPool = db.prepare('DELETE FROM api_key_pool_bindings WHERE pool_id = ?')
    this._insertKeyBinding = db.prepare(`
      INSERT INTO api_key_pool_bindings (api_key_id, pool_id, is_default, created_at)
      VALUES (?, ?, ?, ?)
    `)
    this._insertKeyBindingIgnore = db.prepare(`
      INSERT INTO api_key_pool_bindings (api_key_id, pool_id, is_default, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (api_key_id, pool_id) DO NOTHING
    `)
    this._promoteBindingDefault = db.prepare(
      'UPDATE api_key_pool_bindings SET is_default = 1 WHERE api_key_id = ? AND pool_id = ?',
    )
    this._clearFallbackRef = db.prepare('UPDATE scheduler_pools SET fallback_pool_id = NULL WHERE fallback_pool_id = ?')
    this._clearStickyForPool = db.prepare('DELETE FROM scheduler_sticky_bindings WHERE pool_id = ?')
    this._resetMachineStickyPool = db.prepare(
      "DELETE FROM scheduler_sticky_bindings WHERE scope_kind = 'machine' AND pool_id = ?",
    )
    this._resetMachineStickyPoolNode = db.prepare(
      "DELETE FROM scheduler_sticky_bindings WHERE scope_kind = 'machine' AND pool_id = ? AND node_type = ? AND node_id = ?",
    )
    this._updateKeyDefaultPool = db.prepare('UPDATE api_keys SET default_pool_id = ? WHERE id = ?')
    this._updateKeyDefaultAndVmPool = db.prepare(
      "UPDATE api_keys SET default_pool_id = ?, vm_pool_id = CASE WHEN group_type = 'gemini' THEN vm_pool_id ELSE ? END WHERE id = ?",
    )
    this._updateKeyDefaultAndMode = db.prepare(
      'UPDATE api_keys SET default_pool_id = ?, pool_binding_mode = ? WHERE id = ?',
    )

    this._upsertSticky = db.prepare(`
      INSERT INTO scheduler_sticky_bindings (
        scope_kind, pool_id, model_family, identity_id, node_type, node_id, machine_id,
        stood_in, bound_at_ms, last_seen_ms, expires_at_ms, hits, generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_kind, pool_id, model_family, identity_id) DO UPDATE SET
        node_type = excluded.node_type,
        node_id = excluded.node_id,
        machine_id = COALESCE(excluded.machine_id, scheduler_sticky_bindings.machine_id),
        stood_in = excluded.stood_in,
        bound_at_ms = excluded.bound_at_ms,
        last_seen_ms = excluded.last_seen_ms,
        expires_at_ms = excluded.expires_at_ms,
        hits = excluded.hits,
        generation = excluded.generation
    `)
    this._listLiveSticky = db.prepare(
      'SELECT * FROM scheduler_sticky_bindings WHERE expires_at_ms > ? ORDER BY scope_kind, pool_id, model_family, identity_id',
    )
    this._deleteSticky = db.prepare(
      'DELETE FROM scheduler_sticky_bindings WHERE scope_kind = ? AND pool_id = ? AND model_family = ? AND identity_id = ?',
    )
    this._purgeSticky = db.prepare('DELETE FROM scheduler_sticky_bindings WHERE expires_at_ms <= ?')

    this._upsertPenalty = db.prepare(`
      INSERT INTO scheduler_node_penalties (
        node_type, node_id, model_scope, reason, cooldown_until_ms, ladder_step, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (node_type, node_id, model_scope) DO UPDATE SET
        reason = excluded.reason,
        cooldown_until_ms = excluded.cooldown_until_ms,
        ladder_step = excluded.ladder_step,
        updated_at = excluded.updated_at
    `)
    this._listActivePenalties = db.prepare(
      'SELECT * FROM scheduler_node_penalties WHERE cooldown_until_ms > ? ORDER BY node_type, node_id, model_scope',
    )
    this._deletePenalty = db.prepare(
      'DELETE FROM scheduler_node_penalties WHERE node_type = ? AND node_id = ? AND model_scope = ?',
    )
    this._purgePenalties = db.prepare('DELETE FROM scheduler_node_penalties WHERE cooldown_until_ms <= ?')
  }

  list() {
    const grouped = new Map()
    for (const row of this._allMembers.all()) {
      const m = rowToMember(row)
      const list = grouped.get(m.pool_id) || []
      list.push(m)
      grouped.set(m.pool_id, list)
    }
    return this._listPools.all().map((row) => rowToPool(row, grouped.get(row.id) || []))
  }

  get(id) {
    const row = this._getPool.get(id)
    if (!row) return null
    return rowToPool(row, this.listMembers(id))
  }

  getBySlug(slug) {
    const row = this._getPoolBySlug.get(String(slug || ''))
    if (!row) return null
    return rowToPool(row, this.listMembers(row.id))
  }

  insert(input = {}) {
    const now = nowIso()
    const id = input.id ? String(input.id) : `pool_${crypto.randomBytes(4).toString('hex')}`
    const name = String(input.name || '').trim()
    const slug = input.slug ? String(input.slug).trim().toLowerCase() : slugifyPoolName(name, id)
    const providerScope = normalizeProviderScope(input.provider_scope)
    const systemPromptMode =
      input.system_prompt_mode != null && String(input.system_prompt_mode).trim() !== ''
        ? String(input.system_prompt_mode).trim()
        : defaultSystemPromptModeForProvider(providerScope)
    assertPromptPolicyForProvider(providerScope, systemPromptMode)

    try {
      this._insertPool.run(
        id,
        slug,
        name,
        input.description ?? SCHEDULER_POOL_DEFAULTS.description,
        (input.enabled ?? SCHEDULER_POOL_DEFAULTS.enabled) ? 1 : 0,
        (input.exclusive_members ?? SCHEDULER_POOL_DEFAULTS.exclusive_members) ? 1 : 0,
        providerScope,
        encodePlanTags(input.plan_tags, input.plan_tags_json),
        input.pool_role ?? SCHEDULER_POOL_DEFAULTS.pool_role,
        Number(input.sort_order ?? SCHEDULER_POOL_DEFAULTS.sort_order),
        input.fallback_pool_id ?? null,
        (input.allow_cross_prompt_fallback ?? SCHEDULER_POOL_DEFAULTS.allow_cross_prompt_fallback) ? 1 : 0,
        input.intra_tier_strategy ?? SCHEDULER_POOL_DEFAULTS.intra_tier_strategy,
        Number(input.session_queue_max ?? SCHEDULER_POOL_DEFAULTS.session_queue_max),
        Number(input.session_queue_timeout_ms ?? SCHEDULER_POOL_DEFAULTS.session_queue_timeout_ms),
        Number(input.queue_wait_ms ?? SCHEDULER_POOL_DEFAULTS.queue_wait_ms),
        Number(input.queue_max ?? SCHEDULER_POOL_DEFAULTS.queue_max),
        (input.machine_sticky_enabled ?? SCHEDULER_POOL_DEFAULTS.machine_sticky_enabled) ? 1 : 0,
        Number(input.machine_ttl_seconds ?? SCHEDULER_POOL_DEFAULTS.machine_ttl_seconds),
        (input.session_sticky_enabled ?? SCHEDULER_POOL_DEFAULTS.session_sticky_enabled) ? 1 : 0,
        Number(input.session_ttl_seconds ?? SCHEDULER_POOL_DEFAULTS.session_ttl_seconds),
        Number(input.session_busy_wait_ms ?? SCHEDULER_POOL_DEFAULTS.session_busy_wait_ms),
        input.session_overflow_policy ?? SCHEDULER_POOL_DEFAULTS.session_overflow_policy,
        systemPromptMode,
        input.system_prompt_preset ?? SCHEDULER_POOL_DEFAULTS.system_prompt_preset,
        input.system_prompt_text ?? SCHEDULER_POOL_DEFAULTS.system_prompt_text,
        input.client_system_policy ?? SCHEDULER_POOL_DEFAULTS.client_system_policy,
        input.jev_profile ?? SCHEDULER_POOL_DEFAULTS.jev_profile,
        Number(input.config_version ?? 1),
        input.created_at || now,
        input.updated_at || now,
      )
    } catch (error) {
      throw mapConstraint(error)
    }
    return this.get(id)
  }

  update(id, patch = {}) {
    const existing = this.get(id)
    if (!existing) return null
    const providerScope =
      patch.provider_scope !== undefined ? normalizeProviderScope(patch.provider_scope) : existing.provider_scope
    const systemPromptMode =
      patch.system_prompt_mode !== undefined ? String(patch.system_prompt_mode) : existing.system_prompt_mode
    assertPromptPolicyForProvider(providerScope, systemPromptMode)

    const now = nowIso()
    try {
      this._updatePool.run(
        patch.slug !== undefined ? String(patch.slug).trim().toLowerCase() : existing.slug,
        patch.name !== undefined ? String(patch.name).trim() : existing.name,
        patch.description !== undefined ? String(patch.description) : existing.description,
        (patch.enabled !== undefined ? patch.enabled : existing.enabled) ? 1 : 0,
        (patch.exclusive_members !== undefined ? patch.exclusive_members : existing.exclusive_members) ? 1 : 0,
        providerScope,
        patch.plan_tags !== undefined || patch.plan_tags_json !== undefined
          ? encodePlanTags(patch.plan_tags, patch.plan_tags_json)
          : existing.plan_tags_json,
        patch.pool_role ?? existing.pool_role,
        patch.sort_order !== undefined ? Number(patch.sort_order) : existing.sort_order,
        patch.fallback_pool_id !== undefined ? patch.fallback_pool_id : existing.fallback_pool_id,
        (
          patch.allow_cross_prompt_fallback !== undefined
            ? patch.allow_cross_prompt_fallback
            : existing.allow_cross_prompt_fallback
        )
          ? 1
          : 0,
        patch.intra_tier_strategy ?? existing.intra_tier_strategy,
        patch.session_queue_max !== undefined ? Number(patch.session_queue_max) : existing.session_queue_max,
        patch.session_queue_timeout_ms !== undefined
          ? Number(patch.session_queue_timeout_ms)
          : existing.session_queue_timeout_ms,
        patch.queue_wait_ms !== undefined ? Number(patch.queue_wait_ms) : existing.queue_wait_ms,
        patch.queue_max !== undefined ? Number(patch.queue_max) : existing.queue_max,
        (patch.machine_sticky_enabled !== undefined ? patch.machine_sticky_enabled : existing.machine_sticky_enabled)
          ? 1
          : 0,
        patch.machine_ttl_seconds !== undefined ? Number(patch.machine_ttl_seconds) : existing.machine_ttl_seconds,
        (patch.session_sticky_enabled !== undefined ? patch.session_sticky_enabled : existing.session_sticky_enabled)
          ? 1
          : 0,
        patch.session_ttl_seconds !== undefined ? Number(patch.session_ttl_seconds) : existing.session_ttl_seconds,
        patch.session_busy_wait_ms !== undefined ? Number(patch.session_busy_wait_ms) : existing.session_busy_wait_ms,
        patch.session_overflow_policy ?? existing.session_overflow_policy,
        systemPromptMode,
        patch.system_prompt_preset ?? existing.system_prompt_preset,
        patch.system_prompt_text !== undefined ? String(patch.system_prompt_text) : existing.system_prompt_text,
        patch.client_system_policy ?? existing.client_system_policy,
        patch.jev_profile ?? existing.jev_profile,
        now,
        id,
      )
    } catch (error) {
      throw mapConstraint(error)
    }
    return this.get(id)
  }

  remove(id) {
    try {
      const info = this._deletePool.run(id)
      return Number(info.changes) > 0
    } catch (error) {
      throw mapConstraint(error, { op: 'remove' })
    }
  }

  listMembers(poolId) {
    return this._membersByPool.all(poolId).map(rowToMember)
  }

  setMembers(poolId, members = []) {
    if (!this._getPool.get(poolId)) return null
    const now = nowIso()
    withTransaction(this.db, () => {
      this._clearMembers.run(poolId)
      for (let i = 0; i < members.length; i += 1) {
        const m = members[i]
        this._insertMember.run(
          poolId,
          String(m.node_type),
          String(m.node_id),
          (m.enabled ?? true) ? 1 : 0,
          m.member_role ?? 'active',
          m.weight_tier_override == null ? null : Number(m.weight_tier_override),
          m.sub_weight_override == null ? null : Number(m.sub_weight_override),
          m.member_order != null ? Number(m.member_order) : i,
          m.created_at || now,
          now,
        )
      }
      this._touchPool.run(now, poolId)
    })
    return this.get(poolId)
  }

  removeNode(nodeType, nodeId) {
    const info = this._deleteNodeMembers.run(String(nodeType), String(nodeId))
    return Number(info.changes) || 0
  }

  listBindingsByPool(poolId) {
    return this._bindingsByPool.all(poolId).map(rowToBinding)
  }

  listBindingsByKey(apiKeyId) {
    return this._bindingsByKey.all(apiKeyId).map(rowToBinding)
  }

  listAllBindings() {
    return this._allBindings.all().map(rowToBinding)
  }

  listBoundKeySummariesByPool(poolId) {
    return this._boundKeySummariesByPool.all(poolId).map((row) => ({
      api_key_id: row.api_key_id,
      pool_id: row.pool_id,
      name: row.name ?? null,
      key_prefix: row.key_prefix ?? null,
      status: row.status ?? 'active',
      is_default: Boolean(Number(row.is_default)),
      pool_binding_mode: row.pool_binding_mode === 'strict_pool' ? 'strict_pool' : 'legacy_scope',
      max_concurrency: Number(row.max_concurrency) || 0,
      rpm: Number(row.rpm) || 0,
      requests: Number(row.requests) || 0,
    }))
  }

  listAllBoundKeySummaries() {
    return this._allBoundKeySummaries.all().map((row) => ({
      api_key_id: row.api_key_id,
      pool_id: row.pool_id,
      name: row.name ?? null,
      key_prefix: row.key_prefix ?? null,
      status: row.status ?? 'active',
      is_default: Boolean(Number(row.is_default)),
      pool_binding_mode: row.pool_binding_mode === 'strict_pool' ? 'strict_pool' : 'legacy_scope',
      max_concurrency: Number(row.max_concurrency) || 0,
      rpm: Number(row.rpm) || 0,
      requests: Number(row.requests) || 0,
    }))
  }

  countKeys(poolId) {
    return Number(this._countKeysByPool.get(poolId)?.n) || 0
  }

  countBoundKeys(poolId) {
    return Number(this._countNonDeletedKeysByPool.get(poolId)?.n) || 0
  }

  countActiveKeys(poolId) {
    return Number(this._countActiveKeysByPool.get(poolId)?.n) || 0
  }

  deleteBindingsForKey(apiKeyId) {
    const info = this._clearKeyBindings.run(String(apiKeyId))
    return Number(info.changes) || 0
  }

  /**
   * Force-delete a pool, either migrating bound keys to `migrateToPoolId` or
   * unbinding them while preserving `strict_pool` Fail-Closed semantics.
   */
  forceRemove(id, { migrateToPoolId = null } = {}) {
    if (!this._getPool.get(id)) return false
    const targetId = migrateToPoolId ? String(migrateToPoolId).trim() : null
    if (targetId && (targetId === id || !this._getPool.get(targetId))) {
      throw Object.assign(new Error('迁移目标分组池不存在或无效'), { code: 'invalid_migrate_target', status: 400 })
    }
    const now = nowIso()
    return withTransaction(this.db, () => {
      const boundRows = this._bindingsByPool.all(id)
      const legacyPoolId = (pid) => (pid && /^pool_[a-f0-9]{8}$/.test(pid) ? pid : null)
      if (targetId) {
        const legacyTarget = legacyPoolId(targetId)
        for (const row of boundRows) {
          this._insertKeyBindingIgnore.run(row.api_key_id, targetId, Number(row.is_default) ? 1 : 0, now)
          if (Number(row.is_default)) {
            this._promoteBindingDefault.run(row.api_key_id, targetId)
            this._updateKeyDefaultAndVmPool.run(targetId, legacyTarget, row.api_key_id)
          }
        }
        this._clearBindingsForPool.run(id)
      } else {
        this._clearBindingsForPool.run(id)
        for (const row of boundRows) {
          if (Number(row.is_default)) {
            const remaining = this._bindingsByKey.all(row.api_key_id)
            const nextDefault = remaining[0]?.pool_id ?? null
            if (nextDefault) this._promoteBindingDefault.run(row.api_key_id, nextDefault)
            this._updateKeyDefaultAndVmPool.run(nextDefault, legacyPoolId(nextDefault), row.api_key_id)
          }
        }
      }
      this._clearFallbackRef.run(id)
      this._clearStickyForPool.run(id)
      const info = this._deletePool.run(id)
      return Number(info.changes) > 0
    })
  }

  resetMachineStickyForPool(poolId, { nodeType = null, nodeId = null } = {}) {
    if (nodeType && nodeId) {
      const info = this._resetMachineStickyPoolNode.run(String(poolId), String(nodeType), String(nodeId))
      return Number(info.changes) || 0
    }
    const info = this._resetMachineStickyPool.run(String(poolId))
    return Number(info.changes) || 0
  }

  queryStickyBindings({
    pool_id = null,
    scope_kind = null,
    model_family = null,
    identity_id = null,
    machine_id = null,
    session_id = null,
    includeExpired = false,
    nowMs = Date.now(),
    limit = 500,
  } = {}) {
    const clauses = []
    const params = []
    if (!includeExpired) {
      clauses.push('expires_at_ms > ?')
      params.push(Number(nowMs))
    }
    if (pool_id) {
      clauses.push('pool_id = ?')
      params.push(String(pool_id))
    }
    if (scope_kind) {
      clauses.push('scope_kind = ?')
      params.push(String(scope_kind))
    }
    if (model_family) {
      clauses.push('model_family = ?')
      params.push(String(model_family))
    }
    if (identity_id) {
      clauses.push('identity_id = ?')
      params.push(String(identity_id))
    }
    if (machine_id) {
      clauses.push("((scope_kind = 'machine' AND identity_id = ?) OR machine_id = ?)")
      params.push(String(machine_id), String(machine_id))
    }
    if (session_id) {
      clauses.push("(scope_kind = 'session' AND identity_id = ?)")
      params.push(String(session_id))
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const cap = Math.max(1, Math.min(2000, Number(limit) || 500))
    const rows = this.db
      .prepare(`SELECT * FROM scheduler_sticky_bindings ${where} ORDER BY last_seen_ms DESC LIMIT ?`)
      .all(...params, cap)
    return rows.map((row) => {
      const item = rowToSticky(row)
      return { ...item, node_key: `${item.node_type}:${item.node_id}` }
    })
  }

  deleteStickyBindings({
    pool_id = null,
    scope_kind = null,
    model_family = null,
    identity_id = null,
    machine_id = null,
    session_id = null,
    node_type = null,
    node_id = null,
    allowAll = false,
  } = {}) {
    const clauses = []
    const params = []
    if (pool_id) {
      clauses.push('pool_id = ?')
      params.push(String(pool_id))
    }
    if (scope_kind) {
      clauses.push('scope_kind = ?')
      params.push(String(scope_kind))
    }
    if (model_family) {
      clauses.push('model_family = ?')
      params.push(String(model_family))
    }
    if (identity_id) {
      clauses.push('identity_id = ?')
      params.push(String(identity_id))
    }
    if (machine_id) {
      clauses.push("((scope_kind = 'machine' AND identity_id = ?) OR machine_id = ?)")
      params.push(String(machine_id), String(machine_id))
    }
    if (session_id) {
      clauses.push("(scope_kind = 'session' AND identity_id = ?)")
      params.push(String(session_id))
    }
    if (node_type) {
      clauses.push('node_type = ?')
      params.push(String(node_type))
    }
    if (node_id) {
      clauses.push('node_id = ?')
      params.push(String(node_id))
    }
    if (!clauses.length && !allowAll) {
      throw Object.assign(new Error('删除粘性绑定至少需要一个过滤条件'), {
        code: 'sticky_filter_required',
        status: 400,
      })
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const info = this.db.prepare(`DELETE FROM scheduler_sticky_bindings ${where}`).run(...params)
    return Number(info.changes) || 0
  }

  setKeyBindings(apiKeyId, poolIds = [], { defaultPoolId = null, bindingMode = null } = {}) {
    const uniqueIds = [...new Set(poolIds.map((p) => String(p).trim()).filter(Boolean))]
    const resolvedDefault =
      defaultPoolId && uniqueIds.includes(String(defaultPoolId)) ? String(defaultPoolId) : (uniqueIds[0] ?? null)
    const now = nowIso()
    withTransaction(this.db, () => {
      this._clearKeyBindings.run(apiKeyId)
      for (const pid of uniqueIds) {
        this._insertKeyBinding.run(apiKeyId, pid, pid === resolvedDefault ? 1 : 0, now)
      }
      if (bindingMode != null) {
        this._updateKeyDefaultAndMode.run(resolvedDefault, String(bindingMode), apiKeyId)
      } else {
        this._updateKeyDefaultPool.run(resolvedDefault, apiKeyId)
      }
    })
    return this.listBindingsByKey(apiKeyId)
  }

  upsertStickyBinding(entry) {
    const now = Date.now()
    this._upsertSticky.run(
      String(entry.scope_kind),
      String(entry.pool_id),
      String(entry.model_family),
      String(entry.identity_id),
      String(entry.node_type),
      String(entry.node_id),
      entry.machine_id ?? null,
      entry.stood_in ? 1 : 0,
      Number(entry.bound_at_ms ?? now),
      Number(entry.last_seen_ms ?? now),
      Number(entry.expires_at_ms),
      Number(entry.hits ?? 0),
      Number(entry.generation ?? 1),
    )
  }

  listLiveStickyBindings(nowMs = Date.now()) {
    return this._listLiveSticky.all(Number(nowMs)).map(rowToSticky)
  }

  deleteStickyBinding({ scope_kind, pool_id, model_family, identity_id }) {
    const info = this._deleteSticky.run(String(scope_kind), String(pool_id), String(model_family), String(identity_id))
    return Number(info.changes) > 0
  }

  purgeExpiredStickyBindings(nowMs = Date.now()) {
    const info = this._purgeSticky.run(Number(nowMs))
    return Number(info.changes) || 0
  }

  upsertNodePenalty(entry) {
    this._upsertPenalty.run(
      String(entry.node_type),
      String(entry.node_id),
      String(entry.model_scope ?? '*'),
      String(entry.reason),
      Number(entry.cooldown_until_ms),
      Number(entry.ladder_step ?? 0),
      entry.updated_at || nowIso(),
    )
  }

  listActiveNodePenalties(nowMs = Date.now()) {
    return this._listActivePenalties.all(Number(nowMs)).map(rowToPenalty)
  }

  deleteNodePenalty({ node_type, node_id, model_scope = '*' }) {
    const info = this._deletePenalty.run(String(node_type), String(node_id), String(model_scope))
    return Number(info.changes) > 0
  }

  purgeExpiredNodePenalties(nowMs = Date.now()) {
    const info = this._purgePenalties.run(Number(nowMs))
    return Number(info.changes) || 0
  }
}

function allocateUniqueLower(base, existingLowerSet, disambiguator) {
  let candidate = base
  if (!existingLowerSet.has(candidate.toLowerCase())) {
    existingLowerSet.add(candidate.toLowerCase())
    return candidate
  }
  const suffix = String(disambiguator || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '')
    .slice(-12)
  if (suffix) {
    candidate = `${base}-${suffix}`
    if (!existingLowerSet.has(candidate.toLowerCase())) {
      existingLowerSet.add(candidate.toLowerCase())
      return candidate
    }
  }
  for (let i = 2; ; i += 1) {
    candidate = `${base}-${i}`
    if (!existingLowerSet.has(candidate.toLowerCase())) {
      existingLowerSet.add(candidate.toLowerCase())
      return candidate
    }
  }
}

/**
 * Idempotent Leader-only startup backfill from legacy `vm_pools`,
 * `vm_pool_members`, and `api_keys.vm_pool_id` into the unified scheduler
 * center tables (`071_scheduler_center.sql` / `008_scheduler_center.sql`).
 *
 * Strictly skips with zero DB reads/writes when `isStandby === true`
 * (blue-green `KIN_STANDBY=1` boot).
 */
export function bootstrapSchedulerPools({ db = getDb(), isStandby = false } = {}) {
  if (isStandby === true) {
    return {
      skipped: true,
      reason: 'standby',
      pools: 0,
      members: 0,
      bindings: 0,
      apiKeysUpdated: 0,
    }
  }

  const now = nowIso()
  let poolsInserted = 0
  let membersInserted = 0
  let bindingsInserted = 0
  let apiKeysUpdated = 0

  withTransaction(db, () => {
    // 1. Backfill vm_pools -> scheduler_pools (provider_scope='anthropic', system_prompt_mode='inherit_global')
    const existingPools = db.prepare('SELECT id, slug, name FROM scheduler_pools').all()
    const existingIds = new Set(existingPools.map((r) => r.id))
    const usedSlugs = new Set(existingPools.map((r) => String(r.slug || '').toLowerCase()))
    const usedNames = new Set(existingPools.map((r) => String(r.name || '').toLowerCase()))

    const legacyPools = db
      .prepare('SELECT id, name, enabled, created_at, updated_at FROM vm_pools ORDER BY created_at, id')
      .all()

    const insertPool = db.prepare(`
      INSERT INTO scheduler_pools (
        id, slug, name, enabled, provider_scope, system_prompt_mode, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'anthropic', 'inherit_global', ?, ?)
      ON CONFLICT (id) DO NOTHING
    `)

    for (const lp of legacyPools) {
      if (existingIds.has(lp.id)) continue
      const baseSlug = slugifyPoolName(lp.name, lp.id)
      const slug = allocateUniqueLower(baseSlug, usedSlugs, lp.id)
      const rawName = String(lp.name || lp.id).trim() || lp.id
      const name = usedNames.has(rawName.toLowerCase())
        ? allocateUniqueLower(`${rawName} (${lp.id})`, usedNames, lp.id)
        : (usedNames.add(rawName.toLowerCase()), rawName)
      const createdAt = lp.created_at || now
      const updatedAt = lp.updated_at || createdAt
      const info = insertPool.run(lp.id, slug, name, Number(lp.enabled) ? 1 : 0, createdAt, updatedAt)
      if (Number(info.changes) > 0) {
        poolsInserted += 1
        existingIds.add(lp.id)
      }
    }

    // 2. Backfill vm_pool_members -> scheduler_pool_members (node_type='claude_vm')
    const legacyMembers = db
      .prepare(`
        SELECT m.pool_id, m.vm_id, m.created_at
        FROM vm_pool_members m
        INNER JOIN scheduler_pools p ON p.id = m.pool_id
        ORDER BY m.pool_id, m.vm_id
      `)
      .all()

    const insertMember = db.prepare(`
      INSERT INTO scheduler_pool_members (
        pool_id, node_type, node_id, created_at, updated_at
      ) VALUES (?, 'claude_vm', ?, ?, ?)
      ON CONFLICT (pool_id, node_type, node_id) DO NOTHING
    `)

    for (const lm of legacyMembers) {
      const ts = lm.created_at || now
      const info = insertMember.run(lm.pool_id, lm.vm_id, ts, ts)
      if (Number(info.changes) > 0) membersInserted += 1
    }

    // 3. Backfill api_keys.vm_pool_id -> api_key_pool_bindings (is_default=1) + api_keys.default_pool_id (only when empty)
    const legacyBoundKeys = db
      .prepare(`
        SELECT k.id, k.vm_pool_id, k.default_pool_id, k.created_at
        FROM api_keys k
        INNER JOIN scheduler_pools p ON p.id = k.vm_pool_id
        WHERE k.vm_pool_id IS NOT NULL
          AND TRIM(k.vm_pool_id) != ''
          AND k.deleted_at IS NULL
        ORDER BY k.id
      `)
      .all()

    const countKeyBindings = db.prepare('SELECT COUNT(*) AS n FROM api_key_pool_bindings WHERE api_key_id = ?')
    const hasPoolBinding = db.prepare('SELECT 1 AS ok FROM api_key_pool_bindings WHERE api_key_id = ? AND pool_id = ?')
    const insertBinding = db.prepare(`
      INSERT INTO api_key_pool_bindings (api_key_id, pool_id, is_default, created_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT (api_key_id, pool_id) DO NOTHING
    `)
    const backfillDefaultPool = db.prepare(`
      UPDATE api_keys
      SET default_pool_id = ?
      WHERE id = ? AND (default_pool_id IS NULL OR TRIM(default_pool_id) = '')
    `)

    for (const key of legacyBoundKeys) {
      const currentDefault = key.default_pool_id == null ? '' : String(key.default_pool_id).trim()
      const hasManualOverride = currentDefault !== '' && currentDefault !== key.vm_pool_id
      if (hasManualOverride) continue

      const existingCount = Number(countKeyBindings.get(key.id)?.n) || 0
      if (existingCount > 0 && !hasPoolBinding.get(key.id, key.vm_pool_id)) continue

      if (existingCount === 0) {
        const bInfo = insertBinding.run(key.id, key.vm_pool_id, key.created_at || now)
        if (Number(bInfo.changes) > 0) bindingsInserted += 1
      }

      if (currentDefault === '') {
        const uInfo = backfillDefaultPool.run(key.vm_pool_id, key.id)
        if (Number(uInfo.changes) > 0) apiKeysUpdated += 1
      }
    }
  })

  return {
    skipped: false,
    reason: null,
    pools: poolsInserted,
    members: membersInserted,
    bindings: bindingsInserted,
    apiKeysUpdated,
  }
}
