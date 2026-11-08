import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearCachePrefixSessions,
  confirmCachePrefix,
  peekInterceptSession,
  prepareCachePrefix,
} from '../../src/lib/protocol/cache-prefix.mjs'
import {
  contextMessageIdentity,
  createRequestBodyContext,
  resetRequestBodyContextStats,
  shallowCopyBody,
} from '../../src/lib/protocol/request-body-context.mjs'
import { computeMessageIdentity } from '../../src/lib/protocol/cache-prefix.mjs'
import { refusalUserDocument } from '../../src/lib/core/refusal-similarity.mjs'
import { jevDocument, jevInterceptSessionCache } from '../../src/lib/protocol/jev-intercept.mjs'

test('shallowCopyBody keeps message object references', () => {
  const msg = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
  const body = { model: 'claude', messages: [msg], system: 's' }
  const copy = shallowCopyBody(body, { omit: ['cache_control'] })
  assert.notEqual(copy, body)
  assert.equal(copy.messages, body.messages)
  assert.equal(copy.messages[0], msg)
  copy.messages[0].content[0].text = 'changed'
  assert.equal(msg.content[0].text, 'changed')
})

test('context memoizes message identity within one request', () => {
  resetRequestBodyContextStats()
  const ctx = createRequestBodyContext({ messages: [{ role: 'user', content: 'a' }] })
  const message = ctx.body.messages[0]
  const a = contextMessageIdentity(ctx, message, computeMessageIdentity)
  const b = contextMessageIdentity(ctx, message, computeMessageIdentity)
  assert.equal(a, b)
  assert.equal(ctx.stats.messageIdentityMisses, 1)
})

test('cache-prefix keeps prefix on append-only growth', () => {
  clearCachePrefixSessions()
  const m1 = { role: 'user', content: [{ type: 'text', text: 'one' }] }
  const m2 = { role: 'assistant', content: [{ type: 'text', text: 'two' }] }
  const base = { tools: [{ name: 'Read' }], system: [{ type: 'text', text: 'sys' }], messages: [m1, m2] }
  const ctx = createRequestBodyContext(base)
  assert.equal(prepareCachePrefix('acc:s', base, 0, { ctx })?.break, null)
  confirmCachePrefix('acc:s', 1, { intercept: jevInterceptSessionCache(base, base, { ctx }) })
  const grown = { ...base, messages: [...base.messages, { role: 'user', content: [{ type: 'text', text: 'three' }] }] }
  const ctx2 = createRequestBodyContext(grown)
  assert.equal(prepareCachePrefix('acc:s', grown, 2, { ctx: ctx2 })?.break, null)
})

test('incremental intercept document matches full scan on growing conversation', () => {
  clearCachePrefixSessions()
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
  const body = { messages }
  const ctx = createRequestBodyContext(body)
  prepareCachePrefix('a:s', body, 0, { ctx })
  confirmCachePrefix('a:s', 1, { intercept: jevInterceptSessionCache(body, body, { ctx }) })
  const grown = {
    messages: [...messages, { role: 'user', content: [{ type: 'text', text: 'next ask' }] }],
  }
  const interceptSession = peekInterceptSession('a:s', 2)
  assert.ok(interceptSession?.parts?.length)
  const full = refusalUserDocument(body, grown)
  const inc = refusalUserDocument(body, grown, { interceptSession, ctx: createRequestBodyContext(grown) })
  assert.equal(inc, full)
  const fullJev = jevDocument(body, grown)
  const incJev = jevDocument(body, grown, { interceptSession, ctx: createRequestBodyContext(grown) })
  assert.equal(incJev, fullJev)
})
