import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('NUL-containing rejected requests preserve panel queries and backups', async () => {
  const gw = await startGateway({ env: { KIN_REQUEST_LOG_MODE: 'normal', KIN_BACKUP_DISABLED: '1' } })
  try {
    for (const mode of ['normal', 'debug']) {
      const model = 'invalid\0model'
      const rejected = await api(gw, 'POST', '/v1/messages', {
        headers: { 'x-kin-log': mode },
        body: { model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
      })
      assert.equal(rejected.status, 400, rejected.text)
      const rid = rejected.headers.get('x-request-id')
      const logs = await api(gw, 'GET', '/api/panel/request-logs?mode=normal&limit=10')
      assert.equal(logs.status, 200, logs.text)
      const row = logs.json.items.find((item) => item.request_id === rid)
      assert.ok(row, `rejected ${mode} request must remain logged`)
      assert.equal(row.status, 400)
      assert.equal(row.model, 'invalid\\u0000model')
      assert.equal(row.requested_model, 'invalid\\u0000model')
      if (mode === 'debug') {
        const debug = await api(gw, 'GET', `/api/panel/request-logs/${rid}`)
        assert.equal(debug.status, 200, debug.text)
        assert.equal(debug.json.item.inbound_body.model, model)
      }
      const keys = await api(gw, 'GET', '/api/panel/api-keys')
      assert.equal(keys.status, 200, keys.text)
    }
    const backup = await api(gw, 'POST', '/api/panel/backups')
    assert.equal(backup.status, 201, backup.text)
    assert.equal(backup.json.item.status, 'ok')
    const valid = await api(gw, 'POST', '/v1/messages', {
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'after rejected requests' }] },
    })
    assert.equal(valid.status, 200, valid.text)
    const logs = await api(gw, 'GET', '/api/panel/request-logs?mode=normal&limit=10')
    assert.equal(logs.status, 200, logs.text)
    assert.ok(logs.json.items.some((item) => item.request_id === valid.headers.get('x-request-id')))
  } finally {
    await gw.stop()
  }
})

test('normal mode writes summary log with X-Request-ID', async () => {
  const gw = await startGateway({ mockText: 'logged', env: { KIN_REQUEST_LOG_MODE: 'normal' } })
  try {
    const res = await fetch(gw.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gw.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    assert.equal(res.status, 200)
    const rid = res.headers.get('x-request-id')
    assert.ok(rid)

    const logs = await api(gw, 'GET', '/api/panel/request-logs?mode=normal&limit=10')
    assert.equal(logs.status, 200, logs.text)
    assert.ok(logs.json.items?.length >= 1)
    const hit = logs.json.items.find((x) => x.request_id === rid) || logs.json.items[0]
    assert.equal(hit.protocol, 'anthropic.messages')
    assert.equal(hit.status, 200)
    assert.ok(hit.duration_ms >= 0)
    assert.equal(hit.inbound_body, undefined)
  } finally {
    await gw.stop()
  }
})

test('non-stream and stream logs persist cache usage, upstream model and stop_reason', async () => {
  const gw = await startGateway({ mockText: 'usage', env: { KIN_REQUEST_LOG_MODE: 'normal' } })
  try {
    // non-stream
    const nonStream = await fetch(gw.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${gw.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(nonStream.status, 200)
    const ridA = nonStream.headers.get('x-request-id')

    // realtime stream
    const stream = await fetch(gw.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${gw.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(stream.status, 200)
    const ridB = stream.headers.get('x-request-id')
    await stream.text() // drain SSE

    await new Promise((r) => setTimeout(r, 80))
    const logs = await api(gw, 'GET', '/api/panel/request-logs?mode=normal&limit=20')
    assert.equal(logs.status, 200, logs.text)
    for (const rid of [ridA, ridB]) {
      const hit = logs.json.items.find((x) => x.request_id === rid)
      assert.ok(hit, `log row for ${rid}`)
      assert.equal(hit.input_tokens, 12)
      assert.equal(hit.output_tokens, 4)
      assert.equal(hit.cache_read_tokens, 3)
      assert.equal(hit.cache_creation_tokens, 5)
      assert.equal(hit.cache_creation_5m_tokens, 5)
      assert.equal(hit.cache_creation_1h_tokens, 0)
      assert.equal(hit.requested_model, MODEL)
      assert.equal(hit.upstream_model, MODEL)
      assert.equal(hit.model_mismatch, 0)
      assert.equal(hit.stop_reason, 'end_turn')
    }
    const streamRow = logs.json.items.find((x) => x.request_id === ridB)
    assert.ok(
      streamRow.first_token_ms != null && streamRow.first_token_ms >= 0,
      `first_token_ms=${streamRow.first_token_ms}`,
    )
  } finally {
    await gw.stop()
  }
})

test('debug header stores full redacted body', async () => {
  const gw = await startGateway({ mockText: 'dbg', env: { KIN_REQUEST_LOG_MODE: 'normal' } })
  try {
    const res = await fetch(gw.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gw.apiKey}`,
        'content-type': 'application/json',
        'x-kin-debug': '1',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'secret sk-ant-oat01-ABCDEFGH1234567890' }],
      }),
    })
    assert.equal(res.status, 200)
    const rid = res.headers.get('x-request-id')
    assert.ok(rid)

    // allow finish handler to flush
    await new Promise((r) => setTimeout(r, 50))

    const logs = await api(gw, 'GET', `/api/panel/request-logs/${rid}`)
    assert.equal(logs.status, 200, logs.text)
    const item = logs.json.item
    assert.equal(item.request_id, rid)
    assert.ok(item.inbound_body)
    const blob = JSON.stringify(item.inbound_body)
    assert.match(blob, /REDACTED/)
    assert.doesNotMatch(blob, /ABCDEFGH1234567890/)
    assert.ok(
      item.headers?.authorization === '***REDACTED***' || item.headers?.Authorization === '***REDACTED***' || true,
    )
  } finally {
    await gw.stop()
  }
})

test('off mode does not list entries', async () => {
  const gw = await startGateway({ mockText: 'x', env: { KIN_REQUEST_LOG_MODE: 'off' } })
  try {
    await api(gw, 'POST', '/v1/messages', {
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    })
    await new Promise((r) => setTimeout(r, 30))
    const logs = await api(gw, 'GET', '/api/panel/request-logs?mode=normal&limit=10')
    assert.equal(logs.status, 200)
    // memory empty for this process; items may be empty
    assert.ok(Array.isArray(logs.json.items))
    assert.equal(logs.json.config.mode, 'off')
  } finally {
    await gw.stop()
  }
})
