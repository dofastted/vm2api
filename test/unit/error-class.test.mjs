import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyRequestError,
  collectErrors,
  enrichLogRow,
  excludeErrorClassSql,
  resolveMutedErrorClasses,
} from '../../src/lib/admin/error-class.mjs'

test('classifyRequestError maps known codes and statuses', () => {
  assert.equal(classifyRequestError({ status: 200 }), null)
  assert.equal(classifyRequestError({ status: 503, error_code: 'server_overloaded' }).error_class, 'overloaded')
  assert.equal(classifyRequestError({ status: 429, error_code: 'upstream_rate_limit' }).error_class, 'rate_limit')
  assert.equal(classifyRequestError({ status: 400, error_code: 'invalid_json' }).error_class, 'request')
  assert.equal(
    classifyRequestError({ status: 400, error_message: 'thinking signature invalid' }).error_class,
    'signature',
  )
  assert.equal(classifyRequestError({ status: 401, error_code: 'invalid_api_key' }).error_class, 'auth')
  assert.equal(
    classifyRequestError({
      status: 401,
      error_code: 'auth_failed',
      error_message: 'missing or invalid credentials',
    }).error_class,
    'auth',
  )
  assert.equal(
    classifyRequestError({
      status: 401,
      error_message: 'Invalid credentials',
    }).error_class,
    'auth',
  )
  assert.equal(classifyRequestError({ status: 403, error_code: 'api_key_expired' }).error_class, 'auth')
  assert.equal(classifyRequestError({ status: 403, error_code: 'distill_blocked' }).error_class, 'distill')
  assert.equal(classifyRequestError({ status: 400, error_code: 'refusal_guard' }).error_class, 'refusal')
  assert.equal(classifyRequestError({ status: 403, error_code: 'refusal_guard' }).error_class, 'refusal')
  assert.equal(classifyRequestError({ status: 500, error_code: 'refusal_guard' }).error_class, 'refusal')
  assert.equal(classifyRequestError({ status: 503, error_code: 'refusal_guard' }).error_class, 'refusal')
  assert.equal(classifyRequestError({ status: 401, error_code: 'upstream_auth_error' }).error_class, 'credential')
  assert.equal(
    classifyRequestError({
      status: 401,
      error_code: 'upstream_auth_error',
      error_message: 'OAuth access token has been revoked',
      vm_id: 'vm-05',
    }).error_class,
    'credential',
  )
  assert.equal(classifyRequestError({ status: 504, error_code: 'upstream_timeout' }).error_class, 'timeout')
  assert.equal(classifyRequestError({ status: 503, error_code: 'slot_busy' }).error_class, 'overloaded')
  assert.equal(classifyRequestError({ status: 503, error_code: 'wrap_connection_error' }).error_class, 'other')
  assert.equal(classifyRequestError({ status: 503 }).error_class, 'unavailable')
  assert.equal(classifyRequestError({ status: 529 }).error_class, 'overloaded')
  assert.equal(classifyRequestError({ status: 503, error_code: 'kernel_unavailable' }).error_class, 'other')
  assert.equal(classifyRequestError({ status: 529, error_code: 'pool_overload_cooldown' }).error_class, 'overloaded')
  assert.equal(classifyRequestError({ status: 429, error_code: 'pool_rate_limited' }).error_class, 'rate_limit')
  assert.equal(classifyRequestError({ status: 403, error_message: 'Just a moment Cloudflare' }).error_class, 'proxy')
  assert.equal(
    classifyRequestError({
      status: 400,
      error_code: 'upstream_invalid_request',
      error_message: 'Invalid `signature` in thinking block',
    }).error_class,
    'signature',
  )
  assert.equal(
    classifyRequestError({
      status: 400,
      error_code: 'upstream_invalid_request',
      error_message:
        'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy',
    }).error_class,
    'refusal',
  )
  assert.equal(
    classifyRequestError({
      status: 400,
      error_code: 'upstream_invalid_request',
      error_message: 'HTTP 400: Third-party apps now draw from your extra usage, not your plan limits.',
    }).error_class,
    'refusal',
  )
  assert.equal(
    classifyRequestError({
      status: 503,
      error_code: 'upstream_error',
      error_message: 'no third-party apps allowed on this subscription',
    }).error_class,
    'refusal',
  )
  assert.equal(
    classifyRequestError({
      status: 400,
      error_code: 'upstream_invalid_request',
      error_message: 'max_tokens: 1 is too small',
    }).error_class,
    'request',
  )
  assert.equal(
    classifyRequestError({
      status: 401,
      error_code: 'upstream_auth_error',
      vm_id: 'slot',
      error_message: 'Usage Policy quoted inside an auth failure',
    }).error_class,
    'credential',
  )
  assert.equal(
    classifyRequestError({
      status: 503,
      error_code: 'upstream_error',
      error_message: '服务器负载过高稍后重试',
    }).error_class,
    'overloaded',
  )
  assert.equal(classifyRequestError({ status: 200, error_code: 'client_cancelled' }), null)
  assert.equal(classifyRequestError({ status: 499, error_code: 'client_cancelled' }), null)
  assert.equal(classifyRequestError({ status: 502, error_code: 'ECONNRESET' }).error_class, 'timeout')
  assert.equal(classifyRequestError({ status: 200, error_code: 'stream_incomplete' }), null)
  assert.equal(classifyRequestError({ status: 200, error_message: 'stream first-byte timeout' }), null)
})

test('collectErrors groups by class and code', () => {
  const bag = collectErrors([
    {
      ts: '2026-08-20T01:00:00Z',
      request_id: 'a',
      status: 503,
      error_code: 'server_overloaded',
      error_message: '负载过高',
    },
    {
      ts: '2026-08-20T01:01:00Z',
      request_id: 'b',
      status: 503,
      error_code: 'server_overloaded',
      error_message: '负载过高',
    },
    { ts: '2026-08-20T01:02:00Z', request_id: 'c', status: 429, error_code: 'upstream_rate_limit' },
    { ts: '2026-08-20T01:03:00Z', request_id: 'd', status: 200 },
  ])
  assert.equal(bag.total, 3)
  assert.equal(bag.by_class[0].id, 'overloaded')
  assert.equal(bag.by_class[0].count, 2)
  assert.equal(bag.by_code[0].error_code, 'server_overloaded')
  assert.equal(bag.recent.length, 3)
  assert.equal(enrichLogRow({ status: 503, error_code: 'server_overloaded' }).error_label, '过载排队')
})

test('resolveMutedErrorClasses defaults to auth and accepts an empty list', () => {
  assert.deepEqual(resolveMutedErrorClasses(null), ['auth'])
  assert.deepEqual(resolveMutedErrorClasses(undefined), ['auth'])
  assert.deepEqual(resolveMutedErrorClasses([]), [])
  assert.deepEqual(resolveMutedErrorClasses(['auth', 'nope']), ['auth'])
})

test('excludeErrorClassSql hides ingress auth without dropping oauth credential 401s', () => {
  const sql = excludeErrorClassSql('auth')
  assert.match(sql, /invalid_api_key/)
  assert.match(sql, /NOT \(/)
  assert.match(sql, /IFNULL\(error_code/)
  assert.match(sql, /upstream_auth_error/)
})

test('default auth mute keeps policy 403s that already name a non-auth class', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE logs (status INTEGER, error_code TEXT, vm_id TEXT)')
  const insert = db.prepare('INSERT INTO logs VALUES (?, ?, ?)')
  for (const row of [
    [401, 'invalid_api_key', null],
    [403, null, null],
    [403, 'claude_code_only', null],
    [403, 'key_group_mismatch', null],
    [403, 'distill_blocked', null],
    [401, 'upstream_auth_error', null],
  ]) {
    insert.run(...row)
  }
  const kept = db
    .prepare(`SELECT error_code FROM logs WHERE ${excludeErrorClassSql('auth')}`)
    .all()
    .map((r) => r.error_code)
  assert.deepEqual(kept.sort(), ['claude_code_only', 'distill_blocked', 'key_group_mismatch', 'upstream_auth_error'])
})
