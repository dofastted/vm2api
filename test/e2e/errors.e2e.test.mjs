import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'
import { callAnthropicMessages, streamAnthropicMessages } from '../../src/lib/protocol/anthropic-messages.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('host-process Anthropic hop stays 501 (CRS is uid/mock)', async () => {
  const a = await callAnthropicMessages({ accessToken: 'sk-ant-oat01-FAKE' })
  const b = await streamAnthropicMessages({ accessToken: 'sk-ant-oat01-FAKE' })
  assert.equal(a.status, 501)
  assert.equal(b.status, 501)
})

test('VM without credentials is excluded and pool fails closed', async () => {
  const gw = await startGateway({ oauth: false })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(r.status, 503, r.text)
    const blob = JSON.stringify(r.json)
    assert.match(blob, /号池当前没有可用账号/)
    assert.doesNotMatch(blob, /负载过高/)
    assert.equal(r.json?.error?.code, 'pool_unavailable')
    assert.doesNotMatch(blob, /eligible|no ready api|account_pool_exhausted/i)
  } finally {
    await gw.stop()
  }
})

test('unknown model is rejected without hop', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: { model: 'gpt-4o', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.ok(r.status >= 400, r.text)
    assert.match(JSON.stringify(r.json), /model/i)
  } finally {
    await gw.stop()
  }
})

test('legacy CLI selector header is ignored — Go worker still serves', async () => {
  const gw = await startGateway({ scenario: 'hang', timeoutMs: 800 })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(r.status, 200, r.text)
  } finally {
    await gw.stop()
  }
})

test('single-account rate limit is returned after bounded pool exhaustion', async () => {
  const gw = await startGateway({ scenario: 'rate_limit' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(r.status, 429, r.text)
    assert.match(JSON.stringify(r.json), /rate.limit|quota/i)
    const q = await api(gw, 'GET', '/admin/quota')
    assert.equal(q.status, 200, q.text)
    assert.ok(q.json)
  } finally {
    await gw.stop()
  }
})
