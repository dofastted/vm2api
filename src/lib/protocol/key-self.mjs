/**
 * GET /v1/me/quota and GET /v1/me/usage: a managed key reads its own limits
 * and usage. Read-only: no concurrency slot, RPM tick, usage row or scheduler
 * peek. Expired or exhausted keys still answer so the holder can see why they
 * are refused; disabled or deleted keys are 401. Nothing about slots,
 * accounts, egress, the owner or other keys leaves here.
 */
import { makeError, ErrorType, ErrorCode } from '../core/errors.mjs'
import { createRateLimiter } from '../core/security.mjs'
import { reportTimezone, zonedDayStartMs } from '../core/timezone.mjs'
import { usagePoolEnabled, usageRead } from '../db/sqlite-pool.mjs'

export const KEY_SELF_PATHS = new Set(['/v1/me/quota', '/v1/me/usage'])

const QUERYABLE = new Set(['active', 'quota_exhausted'])
const SELF_RATE = { capacity: 60, refillPerSec: 1 }
const PERIODS = [
  ['today', 1],
  ['7d', 7],
  ['30d', 30],
]
const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}/

export function encodeCursor(next) {
  if (!next?.created_at || !next.id) return null
  return Buffer.from(`${next.created_at}\n${next.id}`).toString('base64url')
}

/** `before` is a cursor from `next_before`, or a plain ISO time (rows strictly older). */
export function decodeCursor(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: true, before: null }
  if (ISO_PREFIX.test(text)) {
    const ms = Date.parse(text)
    return Number.isFinite(ms) ? { ok: true, before: { created_at: new Date(ms).toISOString() } } : { ok: false }
  }
  const decoded = /^[A-Za-z0-9_-]+$/.test(text) ? Buffer.from(text, 'base64url').toString('utf8') : ''
  const m = /^(\d{4}-\d{2}-\d{2}T[^\n]+)\n([^\n]+)$/.exec(decoded)
  if (!m || !Number.isFinite(Date.parse(m[1]))) return { ok: false }
  return { ok: true, before: { created_at: m[1], id: m[2] } }
}

function publicRecentRow(row) {
  return {
    request_id: row.request_id ?? null,
    created_at: row.created_at,
    model: row.model ?? null,
    status: row.status ?? null,
    error_code: row.error_code || null,
    input_tokens: Number(row.input_tokens) || 0,
    output_tokens: Number(row.output_tokens) || 0,
    cache_read_tokens: Number(row.cache_read_tokens) || 0,
    cache_creation_tokens: Number(row.cache_creation_tokens) || 0,
    cost: row.actual_cost == null ? null : Number(row.actual_cost),
    duration_ms: row.duration_ms ?? null,
  }
}

export function createKeySelfHandler({ json, requireAuth, apiKeyStore, getUsageLogs, rate = SELF_RATE } = {}) {
  const allow = createRateLimiter(rate)
  const retryAfter = String(Math.max(1, Math.ceil(1 / (Number(rate.refillPerSec) || 1))))

  function fail(res, err) {
    return json(res, err.status, err.body)
  }

  // Same read-only worker pool as the panel log scans; the main-thread repo is the fallback.
  async function read(method, args) {
    if (usagePoolEnabled()) {
      try {
        return await usageRead({ kind: 'repo', method, args: [args] })
      } catch (err) {
        console.warn(`[sqlite-pool] repo.${method}: ${err?.message || err}`)
      }
    }
    return getUsageLogs()[method](args)
  }

  function authorize(req, res) {
    // Skip the key gate: expired / exhausted keys must still read why they are refused.
    if (!requireAuth(req, res, { keyGate: false })) return null
    const rec = req.apiKeyKind === 'managed' ? req.apiKeyRecord : null
    if (!rec) {
      fail(
        res,
        makeError({
          type: ErrorType.INVALID_REQUEST,
          code: 'managed_key_required',
          message: '此接口只适用于托管 Key（sk-vm-…）；主密钥和面板会话没有 Key 额度',
          status: 400,
        }),
      )
      return null
    }
    if (!QUERYABLE.has(rec.status)) {
      fail(
        res,
        makeError({
          type: ErrorType.AUTH,
          code: ErrorCode.API_KEY_DISABLED,
          message: 'API key is disabled',
          status: 401,
        }),
      )
      return null
    }
    if (!allow(rec.id)) {
      res.setHeader?.('retry-after', retryAfter)
      fail(
        res,
        makeError({
          type: ErrorType.RATE_LIMIT,
          code: ErrorCode.GATEWAY_RATE_LIMIT,
          message: `Self-service query limit exceeded (${rate.capacity}/min). Retry later.`,
          status: 429,
        }),
      )
      return null
    }
    return rec
  }

  return async function handleKeySelf(req, res, url, now = Date.now()) {
    const rec = authorize(req, res)
    if (!rec) return
    if (url.pathname === '/v1/me/quota') {
      return json(res, 200, {
        object: 'api_key_quota',
        checked_at: new Date(now).toISOString(),
        ...apiKeyStore.selfQuota(rec, now),
      })
    }
    const q = url.searchParams
    const cursor = decodeCursor(q.get('before'))
    if (!cursor.ok) {
      return fail(
        res,
        makeError({
          type: ErrorType.INVALID_REQUEST,
          code: 'invalid_cursor',
          message: 'before 必须是上一页的 next_before 或 ISO 时间',
          param: 'before',
          status: 400,
        }),
      )
    }
    const zone = reportTimezone(q.get('tz'))
    const periods = PERIODS.map(([name, days]) => ({
      name,
      since: new Date(zonedDayStartMs(now, zone, 1 - days)).toISOString(),
    }))
    const [usage, recent] = await Promise.all([
      read('keyUsagePeriods', { apiKeyId: rec.id, periods }),
      read('keyRecentRequests', { apiKeyId: rec.id, limit: q.get('limit'), before: cursor.before }),
    ])
    return json(res, 200, {
      object: 'api_key_usage',
      timezone: zone,
      periods: usage,
      recent: {
        items: recent.items.map(publicRecentRow),
        has_more: recent.has_more,
        next_before: encodeCursor(recent.next),
      },
    })
  }
}
