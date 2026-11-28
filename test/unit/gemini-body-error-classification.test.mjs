import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createGeminiPublicHandler } from '../../src/lib/gemini/routes.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'

test('real body reader distinguishes oversized bodies from invalid JSON before dispatch', async () => {
  const logs = []
  const handler = createGeminiPublicHandler({
    readBody,
    scheduler: {
      catalog: () => assert.fail('must not discover accounts'),
      stream: () => assert.fail('must not dispatch'),
    },
    json: (res, status, body) => Object.assign(res, { statusCode: status, body }),
    requestLog: {
      start: () => ({ request_id: 'body-error-test' }),
      finish: (_context, row) => logs.push(row),
    },
  })
  for (const [raw, status, code] of [
    [Buffer.alloc(12 * 1024 * 1024 + 1, 32), 413, 'body_too_large'],
    [Buffer.from('{'), 400, 'invalid_json'],
  ]) {
    const req = Object.assign(Readable.from([raw]), {
      method: 'POST',
      url: '/v1/responses',
      headers: {},
      apiKeyKind: 'managed',
      apiKeyRecord: { id: 'test', group_type: 'gemini' },
    })
    const res = { setHeader() {} }
    await handler(req, res)
    assert.equal(res.statusCode, status)
    assert.equal(res.body.error.code, code)
    assert.equal(logs.at(-1).error_code, code)
    assert.equal(logs.at(-1).attempt_count, 0)
  }
})
