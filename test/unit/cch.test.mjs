import { test } from 'node:test'
import assert from 'node:assert/strict'
import { xxh64 } from '../../src/lib/identity/xxh64.mjs'
import {
  CCH_PLACEHOLDER,
  CCH_XXH64_SEED,
  computeClaudeCodeCch,
  projectClaudeCodeCchText,
  sealClaudeCodeCch,
} from '../../src/lib/identity/cch.mjs'
import {
  CRS_OFFICIAL_AGENT_PROMPT,
  applyCrsUnofficialPersona,
  buildBillingAttributionText,
} from '../../src/lib/identity/crs-persona.mjs'
import { finalizeWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'

test('only the first canonical system billing block is normalized, projected and sealed', () => {
  const literal = 'x-anthropic-billing-header: cc_version=example; cch=259ed;'
  for (const system of [
    [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296; cch=fffff;' },
      { type: 'text', text: literal },
      { type: 'text', text: `Documentation:\n${literal}` },
    ],
    `x-anthropic-billing-header: cc_version=2.1.296; cch=fffff;\nDocumentation:\n${literal}`,
  ]) {
    const body = { messages: [{ role: 'user', content: literal }], model: 'm', system }
    const before = structuredClone(body)
    const projected = JSON.parse(projectClaudeCodeCchText(JSON.stringify(body)))
    assert.deepEqual(projected.messages, body.messages)
    const sealed = sealClaudeCodeCch(body)
    const deferred = sealClaudeCodeCch(body, { seal: false })
    assert.deepEqual(sealed.messages, body.messages)
    for (const result of [projected, sealed, deferred]) {
      if (Array.isArray(system)) assert.deepEqual(result.system.slice(1), system.slice(1))
      else assert.equal(result.system.split('\n').slice(1).join('\n'), system.split('\n').slice(1).join('\n'))
    }
    assert.deepEqual(sealClaudeCodeCch(sealed), sealed)
    assert.deepEqual(body, before)
  }
})

test('a billing example in messages or an embedded system line is not canonical billing', () => {
  const literal = 'x-anthropic-billing-header: cc_version=example; cch=259ed;'
  const body = { messages: [{ role: 'user', content: literal }], system: `Documentation:\n${literal}` }
  assert.deepEqual(sealClaudeCodeCch(body), body)
  assert.throws(() => projectClaudeCodeCchText(JSON.stringify(body)), /billing cch not found/)
})

test('xxh64 matches Python xxhash.xxh64 intdigest vectors', () => {
  const seed = CCH_XXH64_SEED
  assert.equal(xxh64(Buffer.alloc(0), 0n), 0xef46db3751d8e999n)
  assert.equal(xxh64(Buffer.from('a'), 0n), 0xd24ec4f1a98c6e5bn)
  assert.equal(xxh64(Buffer.from('abc'), 0n), 0x44bc2cf5ad770999n)
  assert.equal(xxh64(Buffer.from('abc'), seed), 0xdfc4f4d6913699b6n)
  assert.equal(xxh64(Buffer.from('hello'), seed), 0xfc8105d2d40e53f1n)
  assert.equal(xxh64(Buffer.from('0123456789abcdef0123456789abcdef'), 0n), 0x642a94958e71e6c5n)
  assert.equal(xxh64(Buffer.from('0123456789abcdef0123456789abcdefXXXX'), seed), 0x35f35a19b70a062en)
  assert.equal(xxh64(Buffer.from('{"x":"cch=00000"}'), seed), 0xd9938bad051d0a74n)
})

test('computeClaudeCodeCch is xxh64(bytes, 2.1.280 seed) & 0xfffff as 5 hex', () => {
  const raw = Buffer.from('{"x":"cch=00000"}')
  assert.equal(computeClaudeCodeCch(raw), 'd0a74')
  assert.equal(computeClaudeCodeCch(Buffer.from('hello')), 'e53f1')
})

test('buildBillingAttributionText leaves cch=00000 for later seal', () => {
  const text = buildBillingAttributionText('hello', '2.1.263', 's-1')
  assert.match(text, new RegExp(`cch=${CCH_PLACEHOLDER};`))
  assert.doesNotMatch(text, /cch=(?!00000)[0-9a-f]{5}/)
})

test('sealClaudeCodeCch hashes the 2.1.280 projection then writes digest', () => {
  const body = {
    model: 'claude-sonnet-5',
    max_tokens: 64000,
    fallbacks: ['claude-haiku-4-5'],
    fallback_credit_token: 'tok',
    system: [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=2.1.280.abc; cc_entrypoint=sdk-cli; cch=00000; cc_prompt_id=00000000-0000-4000-8000-000000000000;',
      },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  }
  const raw = JSON.stringify(body)
  const projected = projectClaudeCodeCchText(raw)
  const projectedBody = JSON.parse(projected)
  assert.equal(projectedBody.model, '')
  assert.equal(Object.hasOwn(projectedBody, 'max_tokens'), false)
  assert.equal(Object.hasOwn(projectedBody, 'fallbacks'), false)
  assert.equal(Object.hasOwn(projectedBody, 'fallback_credit_token'), false)
  assert.match(projected, /cch=00000/)
  const expected = computeClaudeCodeCch(Buffer.from(projected, 'utf8'))
  assert.notEqual(expected, computeClaudeCodeCch(Buffer.from(raw, 'utf8')))
  const sealed = sealClaudeCodeCch(body)
  assert.equal(expected.length, 5)
  assert.notEqual(expected, CCH_PLACEHOLDER)
  assert.match(sealed.system[0].text, new RegExp(`cch=${expected};`))
  assert.equal(sealed.model, 'claude-sonnet-5')
  assert.equal(sealed.max_tokens, 64000)
  assert.deepEqual(sealed.fallbacks, ['claude-haiku-4-5'])
  assert.equal(sealed.fallback_credit_token, 'tok')
  assert.equal(JSON.stringify(sealed), raw.replace(/cch=00000/, `cch=${expected}`))
})

test('CCH projection resets billing only, preserving prompt literals before system', () => {
  const raw = {
    model: 'sonnet',
    messages: [{ model: 'other', content: 'literal cch=3180f;' }],
    max_tokens: 9,
    fallbacks: ['haiku', { model: 'inside' }],
    fallback_credit_token: 'tok',
    system: [{ text: 'x-anthropic-billing-header: cc_version=2.1.296; cch=fffff;' }],
  }
  const projected = JSON.parse(projectClaudeCodeCchText(JSON.stringify(raw)))
  assert.equal(projected.system[0].text, 'x-anthropic-billing-header: cc_version=2.1.296; cch=00000;')
  assert.equal(projected.messages[0].content, raw.messages[0].content)
  assert.equal(projected.model, '')
  assert.equal(projected.messages[0].model, '')
  assert.equal(Object.hasOwn(projected, 'max_tokens'), false)
  assert.equal(Object.hasOwn(projected, 'fallbacks'), false)
  assert.equal(Object.hasOwn(projected, 'fallback_credit_token'), false)
})

test('CCH fills missing values and replaces stale values without changing billing parameters', () => {
  const billing =
    'x-anthropic-billing-header: cc_version=2.1.296.abc; cc_entrypoint=sdk-cli; cc_prompt_id=11111111-2222-4333-8444-555555555555;'
  for (const suffix of ['', ' cch=cc746;', ' cch=bad; cch=fffff;']) {
    const body = {
      model: 'claude-opus-5-5',
      max_tokens: 32,
      system: [{ type: 'text', text: billing + suffix }],
      messages: [{ role: 'user', content: 'hi' }],
    }
    const sealed = sealClaudeCodeCch(body)
    const text = sealed.system[0].text
    const cch = text.match(/cch=([0-9a-f]{5});/)[1]
    assert.equal((text.match(/cch=/g) || []).length, 1)
    assert.equal(cch, computeClaudeCodeCch(Buffer.from(projectClaudeCodeCchText(JSON.stringify(sealed)))))
    assert.equal(text.replace(/ cch=[0-9a-f]{5};/, ''), billing)
    assert.equal(body.system[0].text, billing + suffix)
    assert.equal(sealClaudeCodeCch(sealed).system[0].text, text)
    assert.equal(sealClaudeCodeCch(JSON.stringify(body, null, 2)), JSON.stringify(sealed))
    const disabled = sealClaudeCodeCch(body, { enabled: false })
    assert.match(disabled.system[0].text, /cch=00000;/)
    assert.equal((disabled.system[0].text.match(/cch=/g) || []).length, 1)
    assert.equal(disabled.system[0].text.replace(/ cch=00000;/, ''), billing)
  }
})

test('sealing writes the digest into system billing only and never throws on prompt literals', () => {
  const placeholderLiteral = `x-anthropic-billing-header: cc_version=1; cch=${CCH_PLACEHOLDER};`
  const body = {
    model: 'claude-opus-5-5',
    messages: [
      { role: 'user', content: placeholderLiteral },
      { role: 'user', content: 'x-anthropic-billing-header: x; cch=abcde;' },
    ],
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296.abc; cc_entrypoint=sdk-cli;' }],
  }
  const sealed = sealClaudeCodeCch(body)
  assert.equal(sealed.messages[0].content, placeholderLiteral)
  assert.equal(sealed.messages[1].content, body.messages[1].content)
  const cch = sealed.system[0].text.match(/cch=([0-9a-f]{5});/)[1]
  assert.notEqual(cch, CCH_PLACEHOLDER)
  const unsealed = {
    ...sealed,
    system: [{ ...sealed.system[0], text: sealed.system[0].text.replace(cch, CCH_PLACEHOLDER) }],
  }
  const projected = JSON.stringify(unsealed).replace(/"model":"[^"]*"/g, '"model":""')
  assert.equal(cch, computeClaudeCodeCch(Buffer.from(projected, 'utf8')))

  const noBilling = {
    model: 'm',
    system: 'plain',
    messages: [{ role: 'user', content: `literal cch=${CCH_PLACEHOLDER}` }],
  }
  assert.deepEqual(sealClaudeCodeCch(noBilling), noBilling)
})

test('CCH settings apply per hop and native sealing waits for final CLI serialization', () => {
  const body = {
    model: 'claude-opus-5-5',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296.abc; cc_entrypoint=sdk-cli; cch=cc746;' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  }
  const options = { body, reqHeaders: {}, exec: { vm: { claude: { mode: 'oauth' } } } }
  const routing = { compatibility: { cch_enabled: true } }
  const native = finalizeWorkerPayload({ ...options, routing, cliHop: true }).body
  assert.match(native.system[0].text, /cch=00000;/)
  routing.compatibility.cch_enabled = false
  for (const cliHop of [false, true]) {
    const disabled = finalizeWorkerPayload({ ...options, routing, cliHop }).body
    assert.match(disabled.system[0].text, /cch=00000;/)
    assert.match(disabled.system[0].text, /cc_version=2.1.296.abc; cc_entrypoint=sdk-cli;/)
  }
  routing.compatibility.cch_enabled = true
  const enabled = finalizeWorkerPayload({ ...options, routing }).body
  assert.match(enabled.system[0].text, /cch=[0-9a-f]{5};/)
  assert.doesNotMatch(enabled.system[0].text, /cch=(00000|cc746);/)
})

test('applyCrsUnofficialPersona keeps the placeholder until hop finalize', () => {
  const out = applyCrsUnofficialPersona({
    messages: [{ role: 'user', content: 'ping' }],
  })
  const billing = out.system.find((block) => /x-anthropic-billing-header:/i.test(block?.text || ''))
  assert.match(billing.text, new RegExp(`cch=${CCH_PLACEHOLDER};`))
  const sealed = finalizeWorkerPayload({
    body: out,
    reqHeaders: {},
    exec: { homeDir: '', vm: { claude: { mode: 'setup-token', scope: 'user:inference' } } },
    identity: null,
  }).body
  const sealedBilling = sealed.system.find((block) => /x-anthropic-billing-header:/i.test(block?.text || ''))
  const cch = sealedBilling.text.match(/cch=([0-9a-f]{5})/)[1]
  assert.notEqual(cch, CCH_PLACEHOLDER)
  const replay = JSON.stringify(sealed).replace(`cch=${cch}`, `cch=${CCH_PLACEHOLDER}`)
  const projected = projectClaudeCodeCchText(replay)
  assert.equal(computeClaudeCodeCch(Buffer.from(projected, 'utf8')), cch)
})

test('no inbound system still emits billing, identity, official prompt, and env', () => {
  const sessionId = '11111111-2222-4333-8444-555555555555'
  const out = applyCrsUnofficialPersona(
    {
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: '你好呀。' }],
    },
    { mode: 'official_prompt', sessionId },
  )
  assert.equal(out.system.length, 4)
  assert.match(out.system[0].text, /^x-anthropic-billing-header: /)
  assert.equal(out.system[1].text, "You are Claude Code, Anthropic's official CLI for Claude.")
  assert.equal(out.system[2].text, CRS_OFFICIAL_AGENT_PROMPT)
  assert.deepEqual(out.system[2].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.match(out.system[3].text, /^# Environment\n/)
})
