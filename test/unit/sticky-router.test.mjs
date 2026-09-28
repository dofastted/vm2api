import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  StickyRouter,
  childDeclaredWithoutParent,
  explicitParentSessionId,
  isShortProbeRequest,
  mergeStickyConfig,
} from '../../src/lib/pool/sticky-router.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

function tmpDir(prefix = 'kin-sticky-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('string and header parent ids stay on one family and do not cross API keys', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const req = { apiKeyRecord: { id: 'key-a' }, headers: {} }
  const other = { apiKeyRecord: { id: 'key-b' }, headers: {} }
  const child = {
    metadata: {
      user_id: JSON.stringify({
        device_id: 'same-device',
        session_id: 'child-sess',
        parent_session_id: 'parent-sess',
      }),
    },
  }
  assert.equal(explicitParentSessionId(child, {}), 'parent-sess')
  assert.equal(
    explicitParentSessionId({ metadata: { user_id: { device_id: 'same-device', session_id: 'other' } } }, {}),
    '',
  )
  assert.equal(explicitParentSessionId({}, { 'x-kin-root-session': 'root-sess' }), 'root-sess')
  const familyA = r.familyKey(req, 'parent-sess', 'anthropic')
  const familyB = r.familyKey(other, 'parent-sess', 'anthropic')
  const otherParent = r.familyKey(req, 'second-parent', 'anthropic')
  assert.notEqual(familyA, familyB)
  assert.notEqual(familyA, otherParent)
  r.bind(familyA, { accountId: 'acc', vmId: 'vm-10' })
  const moved = r.rebindFamily(familyA, { accountId: 'acc-2', vmId: 'vm-20' })
  assert.equal(moved.generation, 2)
  assert.equal(r.resolve(familyA).vmId, 'vm-20')
  assert.equal(r.resolve(familyA).sessionId, null)
})

test('a declared child without parent or root is rejected as a relation', () => {
  assert.equal(childDeclaredWithoutParent({ metadata: { kin_child: true } }, {}), true)
  assert.equal(
    childDeclaredWithoutParent({ metadata: { kin_child: true, parent_session_id: 'parent-sess' } }, {}),
    false,
  )
  assert.equal(childDeclaredWithoutParent({ metadata: { user_id: { device_id: 'dev' } } }, {}), false)
})

test('bind + resolve + hits increment', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  r.bind('conv-1', { accountId: 'acc-1', vmId: 'vm-1', sessionId: 'sess-9' })
  const hit = r.resolve('conv-1')
  assert.equal(hit.accountId, 'acc-1')
  assert.equal(hit.vmId, 'vm-1')
  assert.equal(hit.sessionId, 'sess-9')
  r.bind('conv-1', { accountId: 'acc-1', vmId: 'vm-1' })
  assert.equal(r.stats().sessions['conv-1'].hits, 2)
  // session_id preserved from previous bind
  assert.equal(r.stats().sessions['conv-1'].session_id, 'sess-9')
})

test('bind keeps outbound session on the same VM and overwrites after a VM change', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  r.bind('conv-s', { accountId: 'acc-1', vmId: 'vm-1', sessionId: 'S1' })
  r.bind('conv-s', { accountId: 'acc-1', vmId: 'vm-1', sessionId: 'S2' })
  assert.equal(r.resolve('conv-s').sessionId, 'S1')
  assert.equal(r.resolve('conv-s').vmId, 'vm-1')

  r.bind('conv-s', { accountId: 'acc-1', vmId: 'vm-2', sessionId: 'S3' })
  assert.equal(r.resolve('conv-s').vmId, 'vm-2')
  assert.equal(r.resolve('conv-s').sessionId, 'S3')

  r.unbind('conv-s')
  r.bind('conv-s', { accountId: 'acc-1', vmId: 'vm-1', sessionId: 'S4' })
  assert.equal(r.resolve('conv-s').vmId, 'vm-1')
  assert.equal(r.resolve('conv-s').sessionId, 'S4')
})

test('bind stays locked when both VM and account differ', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  r.bind('conv-lock', { accountId: 'acc-1', vmId: 'vm-1', sessionId: 'S1' })
  r.bind('conv-lock', { accountId: 'acc-2', vmId: 'vm-2', sessionId: 'S2' })
  assert.equal(r.resolve('conv-lock').accountId, 'acc-1')
  assert.equal(r.resolve('conv-lock').vmId, 'vm-1')
  assert.equal(r.resolve('conv-lock').sessionId, 'S1')
})

test('mergeStickyConfig normalizes outbound_session to rebuild or passthrough', () => {
  assert.equal(mergeStickyConfig({}).outbound_session, 'rebuild')
  assert.equal(mergeStickyConfig({ sticky: {} }).outbound_session, 'rebuild')
  assert.equal(mergeStickyConfig({ sticky: { outbound_session: 'rebuild' } }).outbound_session, 'rebuild')
  assert.equal(mergeStickyConfig({ sticky: { outbound_session: 'passthrough' } }).outbound_session, 'passthrough')
  assert.equal(mergeStickyConfig({ sticky: { outbound_session: 'other' } }).outbound_session, 'rebuild')
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  assert.equal(r.config.outbound_session, 'rebuild')
  r.reloadConfig({ sticky: { enabled: true, outbound_session: 'passthrough' } })
  assert.equal(r.config.outbound_session, 'passthrough')
})

test('expired sessions purge on resolve/stats', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: -1 } } })
  r.bind('conv-2', { accountId: 'a', vmId: 'v' })
  assert.equal(r.resolve('conv-2'), null)
  assert.equal(r.stats().active_sessions, 0)
})

test('disabled sticky returns null and binds nothing', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: false } } })
  r.bind('conv-3', { accountId: 'a', vmId: 'v' })
  assert.equal(r.resolve('conv-3'), null)
})

test('sticky sessions persist across re-open', () => {
  const dir = tmpDir()
  const cfg = { sticky: { enabled: true, ttl_seconds: 3600 } }
  const r1 = new StickyRouter({ dataDir: dir, config: cfg })
  r1.bind('conv-4', { accountId: 'acc-4', vmId: 'vm-4' })

  const r2 = new StickyRouter({ dataDir: dir, config: cfg })
  const hit = r2.resolve('conv-4')
  assert.ok(hit)
  assert.equal(hit.accountId, 'acc-4')
})

test('extractKey uses default header_keys when config omits them', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, mode: 'conversation' } } })
  const key = r.extractKey({ headers: { 'x-session-id': 'sess-default' } }, {})
  assert.equal(key, 'sess-default')
})

test('extractKey prefers metadata.user_id session over headers', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const key = r.extractKey(
    { headers: { 'x-session-id': 'header-sess' } },
    { metadata: { user_id: { session_id: 'meta-sess' } } },
  )
  assert.equal(key, 'meta-sess')
})

test('caller session wins over a persistable envelope', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, mode: 'conversation' } } })
  const a = r.extractPoolKey(
    { apiKeyRecord: { id: 'key_f041' }, headers: { 'thread-id': '01a0b947-aaaa' } },
    {
      thread_id: '01a0b947-aaaa',
      metadata: { user_id: { session_id: 'sess-aaaa' } },
      messages: [
        {
          role: 'user',
          content: 'thread_id: 01a0b947-aaaa\n\nPersistable response items (JSON):\n[{"text":"缓存修复"}]',
        },
      ],
    },
  )
  const b = r.extractPoolKey(
    { apiKeyRecord: { id: 'key_f041' }, headers: { 'thread-id': '01a0bab2-bbbb' } },
    {
      thread_id: '01a0bab2-bbbb',
      metadata: { user_id: { session_id: 'sess-bbbb' } },
      messages: [
        {
          role: 'user',
          content: 'thread_id: 01a0bab2-bbbb\n\nPersistable response items (JSON):\n[{"text":"套餐识别"}]',
        },
      ],
    },
  )
  assert.equal(a, 'kkey_f041:sess-aaaa')
  assert.equal(b, 'kkey_f041:sess-bbbb')
  assert.notEqual(a, b)
})

test('envelope without a session id stays one key per API key', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, mode: 'conversation' } } })
  const body = {
    messages: [{ role: 'user', content: 'Persistable response items (JSON):\n[{"text":"任务"}]' }],
  }
  assert.equal(r.extractPoolKey({ apiKeyRecord: { id: 'key_f041' } }, body), 'kkey_f041:envelope')
  assert.equal(
    r.extractPoolKey(
      { apiKeyRecord: { id: 'key_f041' } },
      {
        metadata: { user_id: { device_id: 'dev-aaaa', session_id: 'sess-aaaa' } },
        messages: [{ role: 'user', content: 'Persistable response items (JSON):\n[{"text":"缓存修复"}]' }],
      },
    ),
    'kkey_f041:sess-aaaa',
  )
})

test('persistable envelope keys stay isolated per API key', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, mode: 'conversation' } } })
  const body = {
    messages: [{ role: 'user', content: 'Persistable response items (JSON):\n[{"text":"任务"}]' }],
  }
  assert.equal(r.extractKey({ apiKeyRecord: { id: 'key_a' } }, body), 'kkey_a:envelope')
  assert.equal(r.extractKey({ apiKeyRecord: { id: 'key_b' } }, body), 'kkey_b:envelope')
})

test('ip mode does not switch envelope traffic onto the API-key envelope key', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, mode: 'ip' } } })
  const key = r.extractKey(
    { apiKeyRecord: { id: 'key_f041' }, headers: { 'x-forwarded-for': '203.0.113.9' } },
    { messages: [{ role: 'user', content: 'Persistable response items (JSON):\n[{"text":"任务"}]' }] },
  )
  assert.equal(key, 'kkey_f041:ip:203.0.113.9')
})

test('plain first-user hash is unchanged without envelope', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const a = r.extractKey(
    { apiKeyRecord: { id: 'key_f041' } },
    { messages: [{ role: 'user', content: '同一段会话的第一句' }] },
  )
  const b = r.extractKey({ apiKeyRecord: { id: 'key_f041' } }, { messages: [{ role: 'user', content: '另一段会话' }] })
  assert.match(a, /^kkey_f041:ch:/)
  assert.notEqual(a, b)
})

test('extractKey ignores x-client-request-id and hashes first user', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const a = r.extractKey(
    { headers: { 'x-client-request-id': 'req-aaaa' } },
    { messages: [{ role: 'user', content: '同一段会话的第一句' }] },
  )
  const b = r.extractKey(
    { headers: { 'x-client-request-id': 'req-bbbb' } },
    {
      messages: [
        { role: 'user', content: '同一段会话的第一句' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: '第二句' },
      ],
    },
  )
  assert.ok(a && a.startsWith('ch:'))
  assert.equal(a, b)
})

test('later blocks of the first user message stay on one session slot', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const req = { apiKeyRecord: { id: 'key_f041' }, headers: {} }
  const first = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'stable preamble' },
          { type: 'text', text: 'turn-1 transcript that grows' },
        ],
      },
    ],
  }
  const next = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'stable preamble' },
          { type: 'text', text: 'turn-2 a different transcript' },
        ],
      },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'continue' },
    ],
  }
  const other = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a different conversation' }] }],
  }
  const a = r.extractPoolKey(req, first, { platform: 'anthropic' })
  const b = r.extractPoolKey(req, next, { platform: 'anthropic' })
  assert.equal(a, b)
  assert.equal(r.collectPoolKeys(req, next, { platform: 'anthropic' }).length, 1)
  assert.notEqual(a, r.extractPoolKey(req, other, { platform: 'anthropic' }))
})

test('extractKey mode=ip uses forwarded address', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, mode: 'ip' } } })
  const key = r.extractKey({ headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } }, {})
  assert.equal(key, 'ip:203.0.113.9')
})

test('extractKey mode=session isolates by API key', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, mode: 'session' } } })
  assert.equal(r.extractKey({ apiKeyRecord: { id: 4 } }, {}), 'k4:login')
})

test('extractOfficialFamilyKey binds parent and child hops by device_id', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const parent = r.extractOfficialFamilyKey(
    { headers: { 'x-claude-code-session-id': 'parent-sess' } },
    { metadata: { user_id: { device_id: 'aabbcc', session_id: 'parent-sess' } } },
  )
  const child = r.extractOfficialFamilyKey(
    { headers: { 'x-claude-code-session-id': 'child-sess' } },
    { metadata: { user_id: { device_id: 'aabbcc', session_id: 'child-sess' } } },
  )
  assert.equal(parent, 'dev:aabbcc')
  assert.equal(child, parent)
  assert.notEqual(
    r.extractKey(
      { headers: { 'x-claude-code-session-id': 'child-sess' } },
      { metadata: { user_id: { device_id: 'aabbcc', session_id: 'child-sess' } } },
    ),
    parent,
  )
})

test('parent and child session ids stay on separate slots', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const parentReq = {
    headers: { 'user-agent': 'claude-cli/2.1.241 (external, sdk-cli)', 'x-claude-code-session-id': 'parent-sess' },
  }
  const parentBody = { metadata: { user_id: { device_id: 'aabbcc', session_id: 'parent-sess' } } }
  const childReq = {
    headers: {
      'user-agent': 'claude-cli/2.1.241 (external, local-agent, agent-sdk/0.3.241)',
      'x-claude-code-session-id': 'child-sess',
    },
  }
  const childBody = { metadata: { user_id: { device_id: 'aabbcc', session_id: 'child-sess' } } }
  assert.equal(r.extractPoolKey(parentReq, parentBody), 'parent-sess')
  assert.equal(r.extractPoolKey(childReq, childBody), 'child-sess')
  assert.deepEqual(r.collectPoolKeys(childReq, childBody), ['child-sess'])
  r.bind('child-sess', { accountId: 'acc-2', vmId: 'vm-02' })
  r.bind('child-sess', { accountId: 'acc-9', vmId: 'vm-09', sessionId: 'outbound-2' })
  assert.equal(r.resolve('child-sess').vmId, 'vm-02')
  assert.equal(r.resolve('child-sess').sessionId, 'outbound-2')
})

function companionHaiku(sessionId, deviceId = '998dad9c1e3eccf11cd192c3919d4d1f') {
  return {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    stream: true,
    temperature: 0,
    thinking: { type: 'disabled' },
    tools: [],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.280.e2f; cc_entrypoint=cli; cch=e6d45;' },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
    ],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Compress into one routing hint of at most 12 words: WHEN to use; WHEN NOT' }],
      },
    ],
    metadata: {
      user_id: JSON.stringify({ device_id: deviceId, session_id: sessionId }),
    },
  }
}

test('haiku subagent keeps its own session and does not reuse the parent key', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const device = '8cd2bdff61fcd056'
  const req = { apiKeyRecord: { id: 'key_f0419454c00d' }, headers: { 'user-agent': 'Go-http-client/1.1' } }
  const parentBody = {
    model: 'claude-opus-5-5',
    messages: [
      { role: 'user', content: 'parent turn' },
      { role: 'assistant', content: 'tool' },
    ],
    metadata: { user_id: { device_id: device, session_id: 'parent-sess' } },
  }
  const parentKey = r.extractPoolKey(req, parentBody, { platform: 'anthropic' })
  r.bind(parentKey, { accountId: 'acc-parent', vmId: 'vm-10', sessionId: 'out-parent', deviceId: device })
  const child = companionHaiku('1334bab2-94bb-4429-a694-b2fa3434b1f5', device)
  const childKey = r.extractPoolKey(req, child, { platform: 'anthropic' })
  assert.notEqual(childKey, parentKey)
  assert.doesNotMatch(String(childKey), /fam:/)
  assert.match(String(childKey), /1334bab2-94bb-4429-a694-b2fa3434b1f5/)
})

test('explicit parent session shares a family VM and keeps a separate session key', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const req = { apiKeyRecord: { id: 'key_family' }, headers: {} }
  const parentBody = {
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'parent' }],
    metadata: { user_id: { device_id: 'dev-1', session_id: 'parent-sess' } },
  }
  const childBody = {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'child' }],
    tools: [{ name: 'Read' }],
    metadata: { user_id: { device_id: 'dev-1', session_id: 'child-sess', parent_session_id: 'parent-sess' } },
  }
  const parentKey = r.extractPoolKey(req, parentBody, { platform: 'anthropic' })
  const childKey = r.extractPoolKey(req, childBody, { platform: 'anthropic' })
  assert.notEqual(parentKey, childKey)
  const family = r.familyKey(req, 'parent-sess', 'anthropic')
  r.bind(family, { accountId: 'acc-parent', vmId: 'vm-10' })
  r.bind(parentKey, { accountId: 'acc-parent', vmId: 'vm-10', sessionId: 'out-parent', slotIndex: 0 })
  r.bind(childKey, { accountId: 'acc-parent', vmId: 'vm-10', sessionId: 'out-child', slotIndex: 1 })
  assert.equal(r.resolve(family).vmId, 'vm-10')
  assert.equal(r.resolve(parentKey).slotIndex, 0)
  assert.equal(r.resolve(childKey).slotIndex, 1)
  assert.notEqual(r.resolve(parentKey).sessionId, r.resolve(childKey).sessionId)
})

test('companion haiku sessions stay independent without an explicit parent', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const req = { apiKeyRecord: { id: 'key_side' }, headers: {} }
  const a = r.extractPoolKey(req, companionHaiku('sess-a'), { platform: 'anthropic' })
  const b = r.extractPoolKey(req, companionHaiku('sess-b'), { platform: 'anthropic' })
  assert.notEqual(a, b)
  assert.doesNotMatch(String(a), /fam:/)
  assert.doesNotMatch(String(b), /fam:/)
})

test('a stale parent and a real haiku chat do not absorb the companion rule', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 3600 } } })
  const device = 'dev-old'
  const req = { apiKeyRecord: { id: 'key_stale' }, headers: {} }
  const parentBody = {
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'old' }],
    metadata: { user_id: { device_id: device, session_id: 'old-sess' } },
  }
  const parentKey = r.extractPoolKey(req, parentBody, { platform: 'anthropic' })
  r.bind(parentKey, { accountId: 'acc-old', vmId: 'vm-old', sessionId: 'out-old', deviceId: device })
  const prev = r.stats().sessions[parentKey]
  r.repo.upsert(parentKey, {
    account_id: prev.account_id,
    vm_id: prev.vm_id,
    session_id: prev.session_id,
    device_id: prev.device_id,
    bound_at: Date.now() - 10 * 60_000,
    expires_at: prev.expires_at,
    hits: prev.hits,
  })
  const companion = companionHaiku('fresh-child', device)
  const fam = r.extractPoolKey(req, companion, { platform: 'anthropic' })
  assert.notEqual(fam, parentKey)
  assert.match(fam, /fresh-child$/)
  assert.doesNotMatch(fam, /fam:/)
  const chat = {
    model: 'claude-haiku-4-5',
    tools: [{ name: 'Bash' }],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'next' },
    ],
    metadata: { user_id: { device_id: 'dev-chat', session_id: 'chat-sess' } },
  }
  r.bind(parentKey, { accountId: 'acc-old', vmId: 'vm-old' })
  assert.match(r.extractPoolKey(req, chat, { platform: 'anthropic' }), /chat-sess$/)
})

test('anthropic and openai sticky keys do not share a session', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const req = { headers: { 'x-session-id': 'same-session' } }
  const body = { metadata: { user_id: { session_id: 'same-session' } } }
  const claude = r.extractPoolKey(req, body, { platform: 'anthropic' })
  const gpt = r.extractPoolKey(req, body, { platform: 'openai' })
  assert.equal(claude, 'p:anthropic:same-session')
  assert.equal(gpt, 'p:openai:same-session')
  r.bind(claude, { accountId: 'acc-claude', vmId: 'vm-claude' })
  assert.equal(r.resolve(gpt), null)
  assert.equal(r.extractPoolKey(req, body, { platform: 'openai' }), gpt)
  assert.equal(r.resolve(r.extractPoolKey(req, body, { platform: 'anthropic' })).vmId, 'vm-claude')
})

test('a caller session does not stick through a content fingerprint', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const firstUser = [{ role: 'user', content: '同一段跨协议会话的首条消息' }]
  const anthropic = {
    metadata: { user_id: { session_id: 'anthropic-session' } },
    messages: firstUser,
  }
  const openai = { messages: firstUser }
  const req = { apiKeyRecord: { id: 'key_cross_protocol' }, headers: {} }

  const primary = r.extractPoolKey(req, anthropic)
  const aliases = r.collectPoolKeys(req, anthropic)
  assert.equal(primary, 'kkey_cross_protocol:anthropic-session')
  assert.deepEqual(aliases, ['kkey_cross_protocol:anthropic-session'])
  r.bind(primary, { accountId: 'acc-1', vmId: 'vm-01', sessionId: 'out-1' })
  r.bind(primary, { accountId: 'acc-2', vmId: 'vm-02', sessionId: 'out-2' })
  assert.equal(r.resolve(primary).vmId, 'vm-01')
  assert.equal(r.resolve(primary).sessionId, 'out-1')
  assert.equal(r.resolve(r.extractPoolKey(req, openai)), null)
})

test('explicit session is the stable lock when concurrent turns have different first messages', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const req = { apiKeyRecord: { id: 'key_lock' }, headers: { 'x-session-id': 'shared-session' } }
  const first = { messages: [{ role: 'user', content: 'first visible turn' }] }
  const second = { messages: [{ role: 'user', content: 'trimmed current turn' }] }
  assert.equal(r.extractPoolKey(req, first), 'kkey_lock:shared-session')
  assert.equal(r.extractPoolKey(req, second), 'kkey_lock:shared-session')
  assert.deepEqual(r.collectPoolKeys(req, first), ['kkey_lock:shared-session'])
  assert.deepEqual(r.collectPoolKeys(req, second), ['kkey_lock:shared-session'])
})

test('provisional bind does not increment hits', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  r.bind('conv-p', { accountId: 'acc', vmId: 'vm-1' }, { countHit: false })
  assert.equal(r.stats().sessions['conv-p'].hits, 0)
  r.bind('conv-p', { accountId: 'acc', vmId: 'vm-1' })
  assert.equal(r.stats().sessions['conv-p'].hits, 1)
})

test('extractKey isolates the same session per API key', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const raw = { headers: { 'x-session-id': 'same-session' } }
  assert.equal(r.extractKey(raw, {}), 'same-session')
  assert.equal(r.extractKey({ ...raw, apiKeyRecord: { id: 7 } }, {}), 'k7:same-session')
})

test('canonical identity keys are not scoped to API keys', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const reqA = { apiKeyRecord: { id: 'key-a' } }
  const reqB = { apiKeyRecord: { id: 'key-b' } }

  assert.equal(r.canonicalSessionKey('session-1'), 'sess:session-1')
  assert.equal(r.canonicalDeviceKey('device-1'), 'dev2:device-1')
  assert.equal(r.canonicalSessionKey('session-1'), r.canonicalSessionKey('session-1', reqA))
  assert.equal(r.canonicalSessionKey('session-1', reqA), r.canonicalSessionKey('session-1', reqB))
  assert.equal(r.canonicalDeviceKey('device-1'), r.canonicalDeviceKey('device-1', reqA))
  assert.equal(r.canonicalDeviceKey('device-1', reqA), r.canonicalDeviceKey('device-1', reqB))
  assert.doesNotMatch(r.canonicalSessionKey('session-1', reqA), /key-a|key-b|^k/)
  assert.doesNotMatch(r.canonicalDeviceKey('device-1', reqA), /key-a|key-b|^k/)
  assert.notEqual(r.canonicalSessionKey('session-1'), r.canonicalSessionKey('session-2'))
  assert.notEqual(r.canonicalDeviceKey('device-1'), r.canonicalDeviceKey('device-2'))
  assert.equal(r.canonicalSessionKey(''), null)
  assert.equal(r.canonicalDeviceKey(''), null)
})

test('canonical identity keys ignore account_uuid changes', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const first = { device_id: 'device-same', account_uuid: 'account-a', session_id: 'session-same' }
  const second = { device_id: 'device-same', account_uuid: 'account-b', session_id: 'session-same' }

  assert.equal(r.canonicalSessionKey(first.session_id), r.canonicalSessionKey(second.session_id))
  assert.equal(r.canonicalDeviceKey(first.device_id), r.canonicalDeviceKey(second.device_id))
})

test('device affinity bind carries no session seat and can move to another VM', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  const key = r.canonicalDeviceKey('device-affinity')
  const first = r.bindDeviceAffinity(key, { accountId: 'acc-1', vmId: 'vm-01' })
  assert.equal(first.generation, 1)
  let hit = r.resolve(key)
  assert.equal(hit.accountId, 'acc-1')
  assert.equal(hit.vmId, 'vm-01')
  assert.equal(hit.sessionId, null)
  assert.equal(hit.slotIndex, null)
  assert.equal(r.stats().sessions[key].hits, 0)

  const moved = r.bindDeviceAffinity(key, { accountId: 'acc-2', vmId: 'vm-02' })
  assert.equal(moved.generation, 2)
  hit = r.resolve(key)
  assert.equal(hit.accountId, 'acc-2')
  assert.equal(hit.vmId, 'vm-02')
  assert.equal(hit.sessionId, null)
  assert.equal(hit.slotIndex, null)
})

test('migrateLegacyIdentity lazily writes canonical keys on a legacy hit', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  const req = { apiKeyRecord: { id: 'key_legacy' }, headers: {} }
  const legacyKey = r.isolateKey('legacy-session', req)
  r.bind(legacyKey, { accountId: 'acc-legacy', vmId: 'vm-legacy', sessionId: 'out-legacy' })

  const result = r.migrateLegacyIdentity(legacyKey, { sessionId: 'legacy-session', deviceId: 'device-legacy' })
  assert.equal(result.sessionKey, 'sess:legacy-session')
  assert.equal(result.deviceKey, 'dev2:device-legacy')

  // Canonical keys carry no API key.
  assert.doesNotMatch(result.sessionKey, /key_legacy|^k/)
  assert.doesNotMatch(result.deviceKey, /key_legacy|^k/)

  const sessionHit = r.resolve(result.sessionKey)
  assert.equal(sessionHit.accountId, 'acc-legacy')
  assert.equal(sessionHit.vmId, 'vm-legacy')
  const deviceHit = r.resolve(result.deviceKey)
  assert.equal(deviceHit.accountId, 'acc-legacy')
  assert.equal(deviceHit.vmId, 'vm-legacy')

  // The legacy row itself is untouched, still readable.
  const legacyHit = r.resolve(legacyKey)
  assert.equal(legacyHit.accountId, 'acc-legacy')
  assert.equal(legacyHit.vmId, 'vm-legacy')
})

test('migrateLegacyIdentity does not overwrite an existing canonical session binding on conflict', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  const req = { apiKeyRecord: { id: 'key_conflict' }, headers: {} }
  const sessionKey = r.canonicalSessionKey('conflict-session')
  // A prior request already bound the canonical session key to vm-a.
  r.bind(sessionKey, { accountId: 'acc-a', vmId: 'vm-a' })

  // A stale legacy row for the same logical session points at a different VM.
  const legacyKey = r.isolateKey('conflict-session', req)
  r.bind(legacyKey, { accountId: 'acc-b', vmId: 'vm-b' })

  const result = r.migrateLegacyIdentity(legacyKey, { sessionId: 'conflict-session', deviceId: 'device-conflict' })
  assert.equal(result.sessionKey, sessionKey)

  // bind()'s locked semantics keep the already-bound VM; the legacy hit does not
  // silently move or merge the canonical session onto vm-b.
  const hit = r.resolve(sessionKey)
  assert.equal(hit.vmId, 'vm-a')
  assert.equal(hit.accountId, 'acc-a')

  // The legacy row itself is left exactly as it was (no cleanup, no rewrite).
  const legacyHit = r.resolve(legacyKey)
  assert.equal(legacyHit.vmId, 'vm-b')
  assert.equal(legacyHit.accountId, 'acc-b')
})

test('migrateLegacyIdentity is a no-op without a resolvable legacy hit and deletes nothing', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  r.bind('unrelated-conv', { accountId: 'acc-unrelated', vmId: 'vm-unrelated' })
  const before = r.stats().active_sessions

  const missing = r.migrateLegacyIdentity('never-bound-legacy-key', {
    sessionId: 'orphan-session',
    deviceId: 'orphan-device',
  })
  assert.equal(missing.sessionKey, null)
  assert.equal(missing.deviceKey, null)
  assert.equal(r.resolve('sess:orphan-session'), null)
  assert.equal(r.resolve('dev2:orphan-device'), null)

  // No canonical keys were minted, and the unrelated row is untouched.
  assert.equal(r.stats().active_sessions, before)
  assert.equal(r.resolve('unrelated-conv').vmId, 'vm-unrelated')
})

test('migrateLegacyIdentity without a trusted device/session identity mints nothing', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  const req = { apiKeyRecord: { id: 'key_notrust' }, headers: {} }
  const legacyKey = r.isolateKey('untrusted-session', req)
  r.bind(legacyKey, { accountId: 'acc-untrusted', vmId: 'vm-untrusted' })

  const result = r.migrateLegacyIdentity(legacyKey, {})
  assert.equal(result.sessionKey, null)
  assert.equal(result.deviceKey, null)
})

test('migrateLegacyIdentity keeps a live device home VM', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  const req = { apiKeyRecord: { id: 'key_home' }, headers: {} }
  r.bindDeviceAffinity(r.canonicalDeviceKey('device-home'), { accountId: 'acc-home', vmId: 'vm-home' })
  const legacyKey = r.isolateKey('old-session', req)
  r.bind(legacyKey, { accountId: 'acc-old', vmId: 'vm-old' })

  r.migrateLegacyIdentity(legacyKey, { sessionId: 'old-session', deviceId: 'device-home' })
  assert.equal(r.resolve('sess:old-session').vmId, 'vm-old')
  assert.equal(r.resolve('dev2:device-home').vmId, 'vm-home')
})

test('sessionPoolKeys uses one canonical key across API keys and keeps legacy aliases', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  const body = { metadata: { user_id: JSON.stringify({ device_id: 'dev-s', session_id: 'sess-s' }) } }
  const reqA = { apiKeyRecord: { id: 'a' }, headers: {} }
  const reqB = { apiKeyRecord: { id: 'b' }, headers: {} }
  const legacy = r.extractPoolKey(reqA, body, { platform: 'anthropic' })
  r.bind(legacy, { accountId: 'acc-s', vmId: 'vm-s' })

  const peek = r.sessionPoolKeys(reqA, body, { sessionId: 'sess-s', deviceId: 'dev-s', migrate: false })
  assert.deepEqual(peek, { stickyKey: legacy, stickyKeys: [legacy] })
  assert.equal(r.resolve('sess:sess-s'), null)

  const a = r.sessionPoolKeys(reqA, body, { sessionId: 'sess-s', deviceId: 'dev-s' })
  assert.deepEqual(a, { stickyKey: 'sess:sess-s', stickyKeys: ['sess:sess-s', legacy] })
  assert.equal(r.resolve('sess:sess-s').vmId, 'vm-s')
  const b = r.sessionPoolKeys(reqB, body, { sessionId: 'sess-s', deviceId: 'dev-s' })
  assert.deepEqual(b, { stickyKey: 'sess:sess-s', stickyKeys: ['sess:sess-s'] })
  assert.equal(r.familyPoolKey(reqA, 'sess-s', { trusted: true }), r.familyPoolKey(reqB, 'sess-s', { trusted: true }))
  assert.match(r.familyPoolKey(reqA, 'sess-s'), /ka:family:sess-s$/)
})

test('unbind and unbindByAccount drop dead bindings', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  r.bind('conv-dead', { accountId: 'acc-x', vmId: 'vm-02' })
  r.bind('conv-other', { accountId: 'acc-y', vmId: 'vm-04' })
  r.unbind('conv-dead')
  assert.equal(r.resolve('conv-dead'), null)
  r.bind('conv-dead', { accountId: 'acc-x', vmId: 'vm-02' })
  r.unbindByAccount({ vmId: 'vm-02' })
  assert.equal(r.resolve('conv-dead'), null)
  assert.equal(r.resolve('conv-other').vmId, 'vm-04')
})

test('proxy pool import/bind/config persist across re-open', () => {
  const dir = tmpDir('kin-proxy-')
  const pool = new ProxyPool({ dataDir: dir })
  const res = pool.importLines('socks5://user:pass@10.0.0.1:1080\n10.0.0.2:1080\nbadline:xx\n10.0.0.1:1080:user:pass')
  assert.equal(res.added, 2)
  const id = pool.snapshot().proxies[0].id
  assert.equal(pool.bind(id, 'vm-1').ok, true)
  pool.updateConfig({ probe_interval_min: 30, max_failures: 3 })
  pool.stopScheduler()

  const pool2 = new ProxyPool({ dataDir: dir })
  const snap = pool2.snapshot()
  assert.equal(snap.totals.total, 2)
  assert.equal(snap.config.probe_interval_min, 30)
  assert.equal(snap.config.max_failures, 3)
  assert.equal(snap.proxies.find((p) => p.id === id).bound_vm_id, 'vm-1')
  const forVm = pool2.getProxyForVm('vm-1')
  assert.equal(forVm.url, 'socks5://user:pass@10.0.0.1:1080')
  pool2.stopScheduler()
})

test('proxy remove + unbindVm persist', () => {
  const dir = tmpDir('kin-proxy-')
  const pool = new ProxyPool({ dataDir: dir })
  pool.importLines('10.1.1.1:1080\n10.1.1.2:1080')
  const [a, b] = pool.snapshot().proxies.map((p) => p.id)
  pool.bind(a, 'vm-z')
  pool.unbindVm('vm-z')
  pool.remove(b)
  pool.stopScheduler()

  const pool2 = new ProxyPool({ dataDir: dir })
  const snap = pool2.snapshot()
  assert.equal(snap.totals.total, 1)
  assert.equal(snap.proxies[0].bound_vm_id, null)
  pool2.stopScheduler()
})

test('disconnect_on_error config persists and runtime failure disables slot', () => {
  const dir = tmpDir('kin-proxy-')
  const disabled = []
  const disconnected = []
  const pool = new ProxyPool({
    dataDir: dir,
    onDisableVm: (vmId, reason, proxyId) => disabled.push({ vmId, reason, proxyId }),
    onDisconnectVm: (vmId, reason, proxyId) => disconnected.push({ vmId, reason, proxyId }),
  })
  pool.importLines('10.2.2.2:1080')
  const id = pool.snapshot().proxies[0].id
  pool.bind(id, 'vm-err')
  assert.equal(pool.snapshot().config.disconnect_on_error, false)
  const skipped = pool.reportRuntimeFailure('vm-err', 'proxy_transport_failure')
  assert.equal(skipped.skipped, true)
  assert.equal(disconnected.length, 0)

  const updated = pool.updateConfig({ disconnect_on_error: true, max_failures: 1 })
  assert.equal(updated.ok, true)
  assert.equal(updated.config.disconnect_on_error, true)
  pool.stopScheduler()

  const pool2 = new ProxyPool({
    dataDir: dir,
    onDisableVm: (vmId, reason, proxyId) => disabled.push({ vmId, reason, proxyId }),
    onDisconnectVm: (vmId, reason, proxyId) => disconnected.push({ vmId, reason, proxyId }),
  })
  assert.equal(pool2.snapshot().config.disconnect_on_error, true)
  const reported = pool2.reportRuntimeFailure('vm-err', 'proxy_transport_failure')
  assert.equal(reported.ok, true)
  assert.equal(reported.skipped, false)
  assert.equal(reported.proxy.status, 'dead')
  assert.equal(disconnected.length, 1)
  assert.equal(disconnected[0].vmId, 'vm-err')
  assert.match(disconnected[0].reason, /proxy_disconnect/)
  assert.equal(disabled.length, 0, 'runtime disconnect should not also fire probe disable')
  pool2.stopScheduler()
})

test('isShortProbeRequest matches one-shot test calls of any max_tokens', () => {
  // sub2api account test
  assert.equal(
    isShortProbeRequest({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
    }),
    true,
  )
  // new-api channel test
  assert.equal(isShortProbeRequest({ max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }), true)
  assert.equal(
    isShortProbeRequest({ max_tokens: 32, messages: [{ role: 'user', content: 'verify-session f4: reply OK' }] }),
    true,
  )
})

test('isShortProbeRequest leaves conversations alone', () => {
  const user = { role: 'user', content: 'hi' }
  assert.equal(isShortProbeRequest({ messages: [user, { role: 'assistant', content: 'x' }, user] }), false)
  assert.equal(isShortProbeRequest({ messages: [user], tools: [{ name: 'Bash' }] }), false)
  assert.equal(isShortProbeRequest({ messages: [{ role: 'user', content: 'x'.repeat(65) }] }), false)
  assert.equal(
    isShortProbeRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: {} },
            { type: 'text', text: 'hi' },
          ],
        },
      ],
    }),
    false,
  )
  assert.equal(isShortProbeRequest({ messages: [{ role: 'user', content: '  ' }] }), false)
})

test('replaceSession remints the outbound session on the same VM', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  r.bind('sess:a', { accountId: 'acc', vmId: 'vm-05', sessionId: 'old-session', slotIndex: 0 })
  r.bind(
    'sess:a',
    { accountId: 'acc', vmId: 'vm-05', sessionId: 'new-session', slotIndex: 1 },
    { countHit: false, replaceSession: true },
  )
  assert.equal(r.resolve('sess:a').sessionId, 'new-session')
  assert.equal(r.resolve('sess:a').slotIndex, 1)
  r.bind('sess:a', { accountId: 'acc', vmId: 'vm-05' }, { countHit: false, replaceSession: true, clearSlot: true })
  assert.equal(r.resolve('sess:a').sessionId, null)
  assert.equal(r.resolve('sess:a').slotIndex, null)
  r.db?.close?.()
})
