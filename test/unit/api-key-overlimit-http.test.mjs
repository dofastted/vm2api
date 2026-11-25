import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { startGateway, api } from '../harness.mjs'
import { formatGeminiProtocolError } from '../../src/lib/protocol/gemini-convert.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

async function gateway(t, extraEnv = {}) {
  const gw = await startGateway({ readyMs: 20_000, env: { KIN_KERNEL_BIN: process.execPath, ...extraEnv } })
  t.after(async () => {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  })
  return gw
}

test('HTTP /v1/messages returns 402 with quota_error & limit_type on USD quota exhaustion (#911)', async (t) => {
  const gw = await gateway(t)
  const created = await api(gw, 'POST', '/api/panel/api-keys', {
    body: { name: 'usd-cap', quota_usd: 0.000001, rpm: 0 },
  })
  assert.equal(created.status, 201, created.text)
  const headers = { authorization: `Bearer ${created.json.item.key}` }
  const body = { model: MODEL, max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }

  const first = await api(gw, 'POST', '/v1/messages', { headers, body })
  assert.equal(first.status, 200, first.text)

  const second = await api(gw, 'POST', '/v1/messages', { headers, body })
  assert.equal(second.status, 402, second.text)
  assert.equal(second.json.error.type, 'quota_error')
  assert.equal(second.json.error.code, 'api_key_quota_exhausted')
  assert.equal(second.json.error.details.limit_type, 'usd_quota')
  assert.equal(second.json.error.details.limit, 0.000001)
  assert.ok(second.json.error.details.current >= 0.000001)
  assert.equal(second.json.error.details.remaining, 0)
  assert.equal(second.json.error.details.reset_at, null)
  assert.equal(second.headers.get('retry-after'), null)
})

test('HTTP /v1/messages returns 402 + Retry-After + reset_at on 5h spend window exhaustion (#911)', async (t) => {
  const gw = await gateway(t)
  const created = await api(gw, 'POST', '/api/panel/api-keys', {
    body: { name: 'spend-5h', rate_limit_5h: 0.000001, rpm: 0 },
  })
  assert.equal(created.status, 201, created.text)
  const headers = { authorization: `Bearer ${created.json.item.key}` }
  const body = { model: MODEL, max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }

  const first = await api(gw, 'POST', '/v1/messages', { headers, body })
  assert.equal(first.status, 200, first.text)

  const second = await api(gw, 'POST', '/v1/messages', { headers, body })
  assert.equal(second.status, 402, second.text)
  assert.equal(second.json.error.type, 'rate_limit_error')
  assert.equal(second.json.error.code, 'api_key_rate_limit')
  assert.equal(second.json.error.details.limit_type, 'spend_5h')
  assert.equal(second.json.error.details.limit, 0.000001)
  assert.equal(second.json.error.details.remaining, 0)
  assert.ok(Date.parse(second.json.error.details.reset_at) > Date.now())
  const retryAfter = Number(second.headers.get('retry-after'))
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 5 * 3600)
})

test('HTTP /v1/messages returns 429 + Retry-After + reset_at on RPM exhaustion (#911)', async (t) => {
  const gw = await gateway(t)
  const created = await api(gw, 'POST', '/api/panel/api-keys', {
    body: { name: 'rpm-1', rpm: 1, max_concurrency: 0 },
  })
  assert.equal(created.status, 201, created.text)
  const headers = { authorization: `Bearer ${created.json.item.key}` }
  const body = { model: MODEL, max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }

  const first = await api(gw, 'POST', '/v1/messages', { headers, body })
  assert.equal(first.status, 200, first.text)

  const second = await api(gw, 'POST', '/v1/messages', { headers, body })
  assert.equal(second.status, 429, second.text)
  assert.equal(second.json.error.type, 'rate_limit_error')
  assert.equal(second.json.error.code, 'api_key_rate_limit')
  assert.equal(second.json.error.details.limit_type, 'rpm')
  assert.equal(second.json.error.details.current, 1)
  assert.equal(second.json.error.details.limit, 1)
  assert.equal(second.json.error.details.remaining, 0)
  assert.ok(Date.parse(second.json.error.details.reset_at) > Date.now())
  const retryAfter = Number(second.headers.get('retry-after'))
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60)
})

test('formatGeminiProtocolError preserves quota_error/rate_limit_error types and details on 402/429', () => {
  const details = { limit_type: 'usd_quota', current: 2, limit: 2, remaining: 0, reset_at: null }
  const openai = formatGeminiProtocolError(
    'openai-chat',
    402,
    'api_key_quota_exhausted',
    'API key USD quota exhausted',
    details,
  )
  assert.equal(openai.error.type, 'quota_error')
  assert.deepEqual(openai.error.details, details)

  const anth = formatGeminiProtocolError('anthropic', 402, 'api_key_rate_limit', 'API key 5h spend limit exceeded', {
    limit_type: 'spend_5h',
    current: 1,
    limit: 1,
    remaining: 0,
    reset_at: '2026-11-24T17:00:00.000Z',
  })
  assert.equal(anth.error.type, 'rate_limit_error')
  assert.equal(anth.error.details.limit_type, 'spend_5h')

  const gem = formatGeminiProtocolError(
    'gemini',
    402,
    'api_key_quota_exhausted',
    'API key USD quota exhausted',
    details,
  )
  assert.equal(gem.error.code, 402)
  assert.equal(gem.error.status, 'RESOURCE_EXHAUSTED')
  assert.equal(gem.error.details[0].metadata.limit_type, 'usd_quota')
})

test('managed key with unlimited concurrency/RPM and >60 RPM follows panel settings instead of built-in 60 gateway bucket', async (t) => {
  const gw = await gateway(t)
  const unlimited = await api(gw, 'POST', '/api/panel/api-keys', {
    body: { name: 'unlimited-burst', max_concurrency: 0, rpm: 0 },
  })
  assert.equal(unlimited.status, 201, unlimited.text)
  assert.equal(unlimited.json.item.max_concurrency, 0)
  assert.equal(unlimited.json.item.rpm, 0)

  const unlimitedHeaders = { authorization: `Bearer ${unlimited.json.item.key}` }
  const burst = await Promise.all(
    Array.from({ length: 65 }, () => api(gw, 'GET', '/v1/models', { headers: unlimitedHeaders })),
  )
  for (const res of burst) {
    assert.equal(res.status, 200, res.text)
  }

  const highRpm = await api(gw, 'POST', '/api/panel/api-keys', {
    body: { name: 'rpm-65', max_concurrency: 0, rpm: 65 },
  })
  assert.equal(highRpm.status, 201, highRpm.text)
  const rpmHeaders = { authorization: `Bearer ${highRpm.json.item.key}` }
  const msgBody = { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
  for (let i = 0; i < 65; i++) {
    const res = await api(gw, 'POST', '/v1/messages', { headers: rpmHeaders, body: msgBody })
    assert.equal(res.status, 200, `request #${i + 1}: ${res.text}`)
  }
  const over = await api(gw, 'POST', '/v1/messages', { headers: rpmHeaders, body: msgBody })
  assert.equal(over.status, 429, over.text)
  assert.equal(over.json.error.code, 'api_key_rate_limit')
  assert.equal(over.json.error.details.limit_type, 'rpm')
  assert.equal(over.json.error.details.limit, 65)

  // Default master key also stays unlimited when KIN_RATE_CAP is unset.
  const masterBurst = await Promise.all(Array.from({ length: 65 }, () => api(gw, 'GET', '/v1/models')))
  for (const res of masterBurst) {
    assert.equal(res.status, 200, res.text)
  }
})

test('explicit KIN_RATE_CAP still caps master key while managed key follows its own panel limits', async (t) => {
  const gw = await gateway(t, { KIN_RATE_CAP: '2', KIN_RATE_REFILL: '0.001' })
  const created = await api(gw, 'POST', '/api/panel/api-keys', {
    body: { name: 'managed-independent', max_concurrency: 0, rpm: 0 },
  })
  assert.equal(created.status, 201, created.text)

  const headers = { authorization: `Bearer ${created.json.item.key}` }
  for (let i = 0; i < 5; i++) {
    const res = await api(gw, 'GET', '/v1/models', { headers })
    assert.equal(res.status, 200, `managed #${i + 1}: ${res.text}`)
  }

  // Master key already spent 1 token on POST /api/panel/api-keys; next call consumes token #2, then #3 is 429.
  assert.equal((await api(gw, 'GET', '/v1/models')).status, 200)
  const blocked = await api(gw, 'GET', '/v1/models')
  assert.equal(blocked.status, 429, blocked.text)
  assert.equal(blocked.json.error.code, 'gateway_rate_limit')
})
