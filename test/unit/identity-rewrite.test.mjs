import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCrsIdentityReplace,
  buildStableSessionSeed,
  extractCallerSession,
  firstUserContentFingerprint,
  normalizeSessionUserAgent,
  outboundSessionMode,
  rebuildOutboundSession,
  resolveOutboundSessionId,
  resolveInboundIdentity,
  sessionContextDiscriminator,
  REBUILD_SESSION_SEED,
  STABLE_SESSION_SEED,
  uuidFromSeed,
  UNOFFICIAL_SESSION_SEED,
  parseUserId,
} from '../../src/lib/identity/identity-rewrite.mjs'
import { stampBillingPromptId } from '../../src/lib/identity/crs-persona.mjs'

const SLOT = {
  vmId: 'vm-01',
  deviceId: 'vm-dev',
  accountUuid: 'vm-acc',
  sessionId: 'vm-sess',
  email: 'slot@example.com',
  metadataUserId: JSON.stringify({ device_id: 'vm-dev', account_uuid: 'vm-acc', session_id: 'vm-sess' }),
}

test('unofficial identity: device/account are slot, session is minted not caller raw', () => {
  const body = {
    settings: { theme: 'light' },
    metadata: {
      user_id: JSON.stringify({ device_id: 'win-dev', account_uuid: 'win-acc', session_id: 'win-sess' }),
      machine_id: 'pc',
    },
  }
  const out = applyCrsIdentityReplace(body, SLOT, body)
  const uid = JSON.parse(out.metadata.user_id)
  const minted = rebuildOutboundSession({ identity: 'win-sess', epoch: 'pending' })
  assert.equal(uid.device_id, 'vm-dev')
  assert.equal(uid.account_uuid, 'vm-acc')
  assert.equal(uid.session_id, minted)
  assert.notEqual(uid.session_id, 'win-sess')
  assert.notEqual(uid.session_id, 'vm-sess')
  assert.notEqual(uid.session_id, uuidFromSeed(UNOFFICIAL_SESSION_SEED + 'win-sess'))
  assert.equal(uid.email, undefined)
  assert.equal(String(out.metadata.user_id).includes('@'), false)
  assert.equal(out.settings, undefined)
  assert.equal(out.metadata.machine_id, undefined)
})

test('official Claude Code identity keeps the caller session under passthrough', () => {
  const body = {
    metadata: {
      user_id: JSON.stringify({ device_id: 'win-dev', account_uuid: 'win-acc', session_id: 'win-sess' }),
    },
  }
  const out = applyCrsIdentityReplace(body, SLOT, body, {}, { officialClient: true, mode: 'passthrough' })
  const uid = JSON.parse(out.metadata.user_id)
  assert.equal(uid.session_id, 'win-sess')
  assert.equal(uid.device_id, 'vm-dev')
  assert.equal(uid.account_uuid, 'vm-acc')
})

test('official Claude Code identity rebuilds the caller session by default', () => {
  const body = {
    metadata: {
      user_id: JSON.stringify({ device_id: 'win-dev', account_uuid: 'win-acc', session_id: 'win-sess' }),
    },
  }
  const out = applyCrsIdentityReplace(body, SLOT, body, {}, { officialClient: true, epoch: 1000 })
  const uid = JSON.parse(out.metadata.user_id)
  assert.notEqual(uid.session_id, 'win-sess')
  assert.equal(uid.session_id, rebuildOutboundSession({ identity: 'win-sess', epoch: 1000 }))
  assert.equal(uid.device_id, 'vm-dev')
  assert.equal(uid.account_uuid, 'vm-acc')
})

test('outboundSessionMode defaults to rebuild', () => {
  assert.equal(outboundSessionMode(), 'rebuild')
  assert.equal(outboundSessionMode({}), 'rebuild')
  assert.equal(outboundSessionMode({ sticky: {} }), 'rebuild')
  assert.equal(outboundSessionMode({ sticky: { outbound_session: 'rebuild' } }), 'rebuild')
  assert.equal(outboundSessionMode({ sticky: { outbound_session: 'passthrough' } }), 'passthrough')
  assert.equal(outboundSessionMode({ sticky: { outbound_session: 'other' } }), 'rebuild')
})

test('rebuildOutboundSession is stable for the same identity and epoch', () => {
  const a = rebuildOutboundSession({ identity: 'win-sess', epoch: 42 })
  const b = rebuildOutboundSession({ identity: 'win-sess', epoch: 42 })
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(a, rebuildOutboundSession({ identity: 'win-sess', epoch: 43 }))
  assert.notEqual(a, uuidFromSeed(UNOFFICIAL_SESSION_SEED + 'win-sess'))
  assert.notEqual(a, uuidFromSeed(STABLE_SESSION_SEED + 'win-sess'))
  assert.equal(a, uuidFromSeed(`${REBUILD_SESSION_SEED}win-sess#42`))
})

test('resolveOutboundSessionId always returns a session', () => {
  const minted = resolveOutboundSessionId('caller-raw')
  assert.equal(minted, rebuildOutboundSession({ identity: 'caller-raw', epoch: 'pending' }))
  assert.notEqual(minted, 'caller-raw')
  assert.notEqual(resolveOutboundSessionId('keep-me', { officialClient: true }), 'keep-me')
  assert.equal(resolveOutboundSessionId('keep-me', { officialClient: true, mode: 'passthrough' }), 'keep-me')
  assert.match(resolveOutboundSessionId('', { officialClient: true }), /^[0-9a-f-]{36}$/)
  assert.match(resolveOutboundSessionId(''), /^[0-9a-f-]{36}$/)
})

test('identity replace is stable for the same inbound session', () => {
  const inbound = { metadata: { user_id: JSON.stringify({ device_id: 'd1', session_id: 's1' }) } }
  const id = { accountUuid: 'acc', deviceId: 'vm', vmId: 'vm-01' }
  const a = applyCrsIdentityReplace({ model: 'x' }, id, inbound)
  const b = applyCrsIdentityReplace({ model: 'x' }, id, inbound)
  assert.deepEqual(JSON.parse(a.metadata.user_id), JSON.parse(b.metadata.user_id))
})

test('parseUserId accepts JSON, object, and legacy underscore formats', () => {
  const json = parseUserId(JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: 's' }))
  assert.deepEqual(json, {
    device_id: 'd',
    account_uuid: 'a',
    session_id: 's',
    parent_session_id: '',
    root_session_id: '',
  })
  const obj = parseUserId({ deviceId: 'd2', accountUuid: 'a2', sessionId: 's2' })
  assert.deepEqual(obj, {
    device_id: 'd2',
    account_uuid: 'a2',
    session_id: 's2',
    parent_session_id: '',
    root_session_id: '',
  })
  const legacy = parseUserId('user_dev1_account_acc1_session_sess1')
  assert.deepEqual(legacy, { device_id: 'dev1', account_uuid: 'acc1', session_id: 'sess1' })
  assert.equal(parseUserId(''), null)
})

test('extractCallerSession prefers metadata, then sticky headers, then body keys', () => {
  assert.equal(
    extractCallerSession({
      inbound: { metadata: { user_id: { session_id: 'from-meta' } } },
      headers: { 'x-session-id': 'from-header' },
    }),
    'from-meta',
  )
  assert.equal(
    extractCallerSession({
      inbound: { model: 'x' },
      headers: { 'x-claude-code-session-id': 'from-header' },
    }),
    'from-header',
  )
  assert.equal(
    extractCallerSession({
      inbound: { conversation_id: 'from-body' },
      headers: {},
    }),
    'from-body',
  )
})

test('resolveInboundIdentity accepts JSON string metadata.user_id', () => {
  const identity = resolveInboundIdentity({
    inbound: {
      metadata: {
        user_id: JSON.stringify({ device_id: 'device-json', account_uuid: 'account-json', session_id: 'session-json' }),
      },
    },
    body: { device_id: 'device-body' },
    headers: { 'x-kin-device-id': 'device-header' },
  })
  assert.deepEqual(identity, { sessionId: 'session-json', deviceId: 'device-json', source: 'metadata' })
})

test('resolveInboundIdentity accepts object metadata.user_id', () => {
  const identity = resolveInboundIdentity({
    body: {
      metadata: { user_id: { deviceId: 'device-object', accountUuid: 'account-object', sessionId: 'session-object' } },
    },
  })
  assert.deepEqual(identity, { sessionId: 'session-object', deviceId: 'device-object', source: 'metadata' })
})

test('resolveInboundIdentity accepts legacy metadata.user_id', () => {
  const identity = resolveInboundIdentity({
    inbound: { metadata: { user_id: 'user_device-legacy_account_account-legacy_session_session-legacy' } },
  })
  assert.deepEqual(identity, { sessionId: 'session-legacy', deviceId: 'device-legacy', source: 'metadata' })
})

test('resolveInboundIdentity uses explicit device_id body field when metadata lacks device', () => {
  const identity = resolveInboundIdentity({
    inbound: { metadata: { user_id: { session_id: 'session-meta', account_uuid: 'account-meta' } } },
    body: { device_id: 'device-explicit' },
    headers: { 'x-kin-device-id': 'device-header' },
  })
  assert.deepEqual(identity, { sessionId: 'session-meta', deviceId: 'device-explicit', source: 'explicit-device' })
})

test('resolveInboundIdentity uses x-kin-device-id header when no metadata device or body device exists', () => {
  const identity = resolveInboundIdentity({
    body: { metadata: { user_id: { session_id: 'session-meta' } } },
    headers: { 'X-Kin-Device-Id': 'device-header' },
  })
  assert.deepEqual(identity, { sessionId: 'session-meta', deviceId: 'device-header', source: 'explicit-device' })
})

test('resolveInboundIdentity does not guess identity from auth, ip, user agent, or message text', () => {
  const identity = resolveInboundIdentity({
    inbound: {
      messages: [{ role: 'user', content: 'stable first message' }],
    },
    body: {
      messages: [{ role: 'user', content: 'another stable first message' }],
    },
    headers: {
      authorization: 'Bearer secret-api-key',
      'x-api-key': 'another-secret-api-key',
      'x-forwarded-for': '203.0.113.9',
      'user-agent': 'claude-cli/2.1.241',
    },
  })
  assert.deepEqual(identity, { sessionId: '', deviceId: '', source: 'none' })
})

test('uuidFromSeed is a deterministic v4-shaped uuid', () => {
  const a = uuidFromSeed('seed')
  const b = uuidFromSeed('seed')
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('missing caller session is stable across turns and not random', () => {
  const base = {
    officialClient: false,
    accountId: 'vm-01',
    clientIp: '203.0.113.9',
    userAgent: 'claude-cli/2.1.241 (external, sdk-cli)',
    apiKeyId: 'key-7',
    firstUserText: 'first question',
    epoch: 'pending',
  }
  const seed = buildStableSessionSeed('vm-01', sessionContextDiscriminator(base), 'first question')
  const round1 = resolveOutboundSessionId('', base)
  const round2 = resolveOutboundSessionId('', { ...base, firstUserText: 'first question' })
  assert.equal(round1, round2)
  assert.match(round1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(round1, rebuildOutboundSession({ identity: seed, epoch: 'pending' }))
  assert.notEqual(round1, uuidFromSeed(STABLE_SESSION_SEED + seed))
  assert.notEqual(resolveOutboundSessionId('', { ...base, firstUserText: 'other opener' }), round1)
  assert.notEqual(resolveOutboundSessionId('', { ...base, accountId: 'vm-02' }), round1)
  assert.equal(resolveOutboundSessionId('', { ...base, userAgent: 'claude-cli/2.1.999 (external, sdk-cli)' }), round1)
  assert.notEqual(resolveOutboundSessionId('', { ...base, epoch: 99 }), round1)
})

test('first user content fingerprint is typed, ordered, untruncated and ignores later messages', () => {
  const fp = (body) => firstUserContentFingerprint(body)
  const text = (value) => ({ type: 'text', text: value })
  const opener = (question) => ({
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Today is 2026-10-04. Working directory: /work/demo' }, text(question)],
      },
    ],
  })

  // messages / Codex input / legacy prompt describe the same first user text
  assert.equal(
    fp({ messages: [{ role: 'user', content: 'hello' }] }),
    fp({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] }),
  )
  assert.equal(fp({ prompt: 'hello' }), fp({ messages: [{ role: 'user', content: 'hello' }] }))

  // two openers that share a leading block stay apart, the same opener is stable
  assert.notEqual(fp(opener('会话 A 的问题')), fp(opener('会话 B 的问题')))
  assert.equal(fp(opener('会话 A 的问题')), fp(opener('会话 A 的问题')))

  // block boundaries, order and whitespace normalization
  assert.notEqual(
    fp({ messages: [{ role: 'user', content: [text('a'), text('b')] }] }),
    fp({ messages: [{ role: 'user', content: [text('ab')] }] }),
  )
  assert.notEqual(
    fp({ messages: [{ role: 'user', content: [text('a'), text('b')] }] }),
    fp({ messages: [{ role: 'user', content: [text('b'), text('a')] }] }),
  )
  assert.equal(
    fp({ messages: [{ role: 'user', content: [text('a  b')] }] }),
    fp({ messages: [{ role: 'user', content: [text('a b')] }] }),
  )

  // no 4000-char truncation
  const long = 'x'.repeat(5000)
  assert.notEqual(
    fp({ messages: [{ role: 'user', content: `${long}A` }] }),
    fp({ messages: [{ role: 'user', content: `${long}B` }] }),
  )

  // later messages never move the fingerprint
  assert.equal(
    fp({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'a later turn' },
      ],
    }),
    fp({ messages: [{ role: 'user', content: 'hello' }] }),
  )

  // multimodal blocks participate by content
  const image = (data) => ({
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }, text('look')],
      },
    ],
  })
  assert.equal(fp(image('QUJD')), fp(image('QUJD')))
  assert.notEqual(fp(image('QUJD')), fp(image('QUJDRA==')))
  assert.notEqual(fp(image('QUJD')), fp({ messages: [{ role: 'user', content: [text('look')] }] }))

  // no usable first-user content
  assert.equal(fp({}), '')
  assert.equal(fp({ messages: [{ role: 'user', content: '' }] }), '')
})

test('firstUserIdentity seeds the session and outranks billing text', () => {
  const base = {
    officialClient: false,
    accountId: 'vm-01',
    clientIp: '203.0.113.9',
    userAgent: 'claude-cli/2.1.241 (external, sdk-cli)',
    apiKeyId: 'key-7',
    epoch: 'pending',
  }
  const opener = (question) => ({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Today is 2026-10-04. Working directory: /work/demo' },
          { type: 'text', text: question },
        ],
      },
    ],
  })
  const identityA = firstUserContentFingerprint(opener('会话 A 的问题'))
  const identityB = firstUserContentFingerprint(opener('会话 B 的问题'))
  const opts = { ...base, firstUserText: 'preamble', firstUserIdentity: identityA }
  const first = resolveOutboundSessionId('', opts)
  assert.equal(first, resolveOutboundSessionId('', { ...opts }))
  assert.notEqual(first, resolveOutboundSessionId('', { ...opts, firstUserIdentity: identityB }))
  // Billing text churn must not move the seed while the opener is unchanged.
  assert.equal(first, resolveOutboundSessionId('', { ...opts, firstUserText: 'other billing text' }))
  // Exact composition: prefixed fingerprint material inside the stable seed.
  const seed = buildStableSessionSeed('vm-01', sessionContextDiscriminator(base), `first-user-content:${identityA}`)
  assert.equal(first, rebuildOutboundSession({ identity: seed, epoch: 'pending' }))
  // Legacy callers that only pass raw text keep the old seed.
  assert.notEqual(first, resolveOutboundSessionId('', { ...base, firstUserText: 'preamble' }))
})

test('passthrough fallback also seeds from the first-user identity', () => {
  const opts = {
    officialClient: false,
    mode: 'passthrough',
    accountId: 'vm-01',
    clientIp: '203.0.113.9',
    userAgent: 'RikkaHub/1.0',
    apiKeyId: 'key-7',
    epoch: 'pending',
    firstUserText: 'billing',
    firstUserIdentity: firstUserContentFingerprint({ messages: [{ role: 'user', content: 'opener one' }] }),
  }
  const a = resolveOutboundSessionId('', opts)
  assert.equal(a, resolveOutboundSessionId('', opts))
  assert.notEqual(
    a,
    resolveOutboundSessionId('', {
      ...opts,
      firstUserIdentity: firstUserContentFingerprint({ messages: [{ role: 'user', content: 'opener two' }] }),
    }),
  )
})

test('sticky outbound id is reused for the same VM and reminted after failover', () => {
  const opts = {
    accountId: 'vm-01',
    boundAccountId: 'vm-01',
    boundSessionId: '11111111-1111-4111-8111-111111111111',
    boundVmId: 'vm-01',
    vmId: 'vm-01',
    firstUserText: 'trimmed current turn',
    clientDiscriminator: '203.0.113.9:claude-cli+sdk-cli:key-7',
    epoch: 10,
  }
  assert.equal(resolveOutboundSessionId('', opts), '11111111-1111-4111-8111-111111111111')
  const moved = resolveOutboundSessionId('', { ...opts, accountId: 'vm-02', vmId: 'vm-02' })
  assert.notEqual(moved, opts.boundSessionId)
  assert.equal(resolveOutboundSessionId('', { ...opts, accountId: 'vm-02', vmId: 'vm-02' }), moved)
  assert.equal(
    moved,
    rebuildOutboundSession({
      identity: buildStableSessionSeed('vm-02', opts.clientDiscriminator, 'trimmed current turn'),
      epoch: 10,
    }),
  )
  assert.equal(
    resolveOutboundSessionId('caller-raw', { ...opts, mode: 'passthrough' }),
    uuidFromSeed(UNOFFICIAL_SESSION_SEED + 'caller-raw'),
  )
  assert.equal(resolveOutboundSessionId('keep-me', { ...opts, officialClient: true, mode: 'passthrough' }), 'keep-me')
})

test('rebuild does not reuse a sticky session without a matching VM id', () => {
  const bound = '11111111-1111-4111-8111-111111111111'
  const minted = resolveOutboundSessionId('inbound-A', {
    boundSessionId: bound,
    vmId: 'vm-2',
    epoch: 7,
  })
  assert.notEqual(minted, bound)
  assert.equal(minted, rebuildOutboundSession({ identity: 'inbound-A', epoch: 7 }))
  assert.notEqual(resolveOutboundSessionId('inbound-A', { boundSessionId: bound, boundVmId: 'vm-1', epoch: 7 }), bound)
})

test('session user agent ignores version noise', () => {
  assert.equal(
    normalizeSessionUserAgent('claude-cli/2.1.241 (external, sdk-cli)'),
    normalizeSessionUserAgent('claude-cli/9.9.9 (external, sdk-cli)'),
  )
  assert.equal(normalizeSessionUserAgent('claude-cli/2.1.241 (external, sdk-cli)'), 'claude-cli')
})

test('billing prompt id follows the stable outbound session', () => {
  const body = {
    system: [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=2.1.241.abc; cc_entrypoint=sdk-cli; cch=00000; cc_prompt_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa;',
      },
    ],
  }
  const stable = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const out = stampBillingPromptId(body, stable, 'first question')
  assert.match(out.system[0].text, new RegExp(`cc_prompt_id=${stable}`))
  assert.equal(body.system[0].text.includes('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), true)
})

test('resolveInboundIdentity keeps a metadata session_id when no device exists', () => {
  const identity = resolveInboundIdentity({
    inbound: { metadata: { user_id: JSON.stringify({ session_id: 'session-only' }) } },
  })
  assert.deepEqual(identity, { sessionId: 'session-only', deviceId: '', source: 'metadata' })
})

test('resolveInboundIdentity reads explicit device_id from the raw inbound body', () => {
  const identity = resolveInboundIdentity({
    inbound: { device_id: 'device-raw', metadata: { user_id: { session_id: 'session-raw' } } },
    body: {},
  })
  assert.deepEqual(identity, { sessionId: 'session-raw', deviceId: 'device-raw', source: 'explicit-device' })
})
