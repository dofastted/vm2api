import test from 'node:test'
import assert from 'node:assert/strict'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { resolveOutboundSessionId } from '../../src/lib/identity/identity-rewrite.mjs'

class Scheduler {
  constructor(candidates) {
    this.candidates = candidates
    this.cooldowns = []
    this.successes = []
    this.releasedAccounts = []
    this.selectCalls = 0
  }

  async selectAndReserve({ excluded, avoid = null, allowWait = true }) {
    this.selectCalls++
    const open = this.candidates.filter((item) => !excluded.has(item.accountId) && !excluded.has(item.vmId))
    const preferred = avoid ? open.filter((item) => !avoid.has(item.accountId) && !avoid.has(item.vmId)) : open
    const candidate = preferred[0] || (allowWait ? open[0] : null)
    if (!candidate) return { ok: false, reason: 'no_eligible_accounts' }
    return { ...candidate, ok: true, release() {} }
  }

  markCooldown(candidate, update) {
    this.cooldowns.push({ candidate, update })
  }

  markSuccess(candidate) {
    this.successes.push(candidate)
  }

  releaseAccountSessions(value) {
    this.releasedAccounts.push(value)
  }
}

class Attempts {
  items = []
  begin(item) {
    this.items.push({ ...item, state: 'started' })
  }
  complete(requestId, attemptNo, result) {
    const item = this.items.find((entry) => entry.requestId === requestId && entry.attemptNo === attemptNo)
    Object.assign(item, result, { state: 'completed' })
  }
}

function candidate(number) {
  return {
    vmId: `vm-0${number}`,
    accountId: `account-${number}`,
    selectionReason: number === 1 ? 'sticky' : 'balanced',
    waitMs: 0,
  }
}

function success(text = 'ok') {
  return {
    ok: true,
    status: 200,
    terminalState: 'verified',
    body: {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}

test('unsupported classifier runtime stops without counting execution or cooling accounts', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler })
  let calls = 0
  const result = await runner.run({
    requestId: 'classifier-runtime',
    model: 'claude-sonnet-4-6',
    canonicalBody: { model: 'claude-sonnet-4-6' },
    callAttempt: async () => {
      calls++
      return {
        ok: false,
        status: 400,
        upstreamExecutions: 0,
        terminalState: 'rejected',
        body: {
          error: {
            type: 'invalid_request_error',
            code: 'classifier_runtime_unsupported',
            message: 'unsupported runtime',
          },
        },
      }
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.attemptCount, 0)
  assert.equal(result.body.error.code, 'classifier_runtime_unsupported')
  assert.deepEqual(scheduler.cooldowns, [])
  assert.equal(scheduler.selectCalls, 1)
})

test('invalid panel cache layout stops before execution without rotating or cooling accounts', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const attempts = new Attempts()
  const runner = new FailoverRunner({ scheduler, attemptsRepo: attempts })
  const result = await runner.run({
    requestId: 'invalid-cache-layout',
    model: 'claude-opus-5-5',
    canonicalBody: { model: 'claude-opus-5-5' },
    applyAttempt: () => {
      const error = new Error('Cache TTL must place 1h before 5m.')
      error.status = 400
      error.body = { error: { type: 'invalid_request_error', code: 'invalid_cache_control', message: error.message } }
      throw error
    },
    callAttempt: () => assert.fail('invalid cache layout must not execute'),
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'invalid_cache_control')
  assert.equal(result.attemptCount, 0)
  assert.equal(scheduler.selectCalls, 1)
  assert.deepEqual(scheduler.cooldowns, [])
  assert.equal(attempts.items[0].errorScope, 'request')
})

test('account1 quota exhausted rotates to account2 and commits final sticky', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const attempts = new Attempts()
  const bindings = []
  const runner = new FailoverRunner({
    scheduler,
    attemptsRepo: attempts,
    stickyRouter: {
      bind: (key, value, opts) => bindings.push({ key, value, opts }),
    },
  })
  const seen = []
  const result = await runner.run({
    requestId: 'req-1',
    canonicalBody: { model: 'claude-opus-test', metadata: { user_id: 'caller' } },
    model: 'claude-opus-test',
    stickyKey: 'conversation-1',
    applyAttempt: (body, selected) => {
      body.metadata.user_id = selected.accountId
      return body
    },
    callAttempt: ({ candidate: selected, body }) => {
      seen.push({ accountId: selected.accountId, userId: body.metadata.user_id })
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 429,
          terminalState: 'rejected',
          body: { error: { type: 'rate_limit_error', message: '5h exhausted' } },
          headers: { 'anthropic-ratelimit-unified-5h-status': 'rejected' },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.equal(result.attemptCount, 2)
  assert.deepEqual(seen, [
    { accountId: 'account-1', userId: 'account-1' },
    { accountId: 'account-2', userId: 'account-2' },
  ])
  assert.equal(scheduler.cooldowns.length, 1)
  assert.equal(scheduler.cooldowns[0].candidate.accountId, 'account-1')
  assert.deepEqual(scheduler.releasedAccounts, [{ accountId: 'account-1', vmId: 'vm-01' }])
  const commits = bindings.filter((b) => b.opts?.countHit !== false)
  assert.ok(bindings.some((b) => b.value.accountId === 'account-1' && b.opts?.countHit === false))
  assert.deepEqual(commits, [
    {
      key: 'conversation-1',
      value: { accountId: 'account-2', vmId: 'vm-02' },
      opts: undefined,
    },
  ])
  assert.equal(attempts.items.length, 2)
  assert.equal(attempts.items[1].terminalState, 'verified')
})

test('slot_busy spill serves the turn elsewhere but keeps the session pinned', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  scheduler.releaseAccountSessions = () => assert.fail('capacity spill must not unbind')
  const pins = new Map([['conversation-1', { accountId: 'account-1', vmId: 'vm-01' }]])
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: {
      resolve: (key) => pins.get(key) || null,
      bind: (key, value) => pins.set(key, value),
    },
  })
  const result = await runner.run({
    requestId: 'req-spill',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'conversation-1',
    callAttempt: ({ candidate: selected }) =>
      selected.accountId === 'account-1'
        ? {
            ok: false,
            status: 503,
            terminalState: 'rejected',
            body: { error: { type: 'api_error', code: 'slot_busy', message: 'no free slot' } },
          }
        : success(),
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.deepEqual(pins.get('conversation-1'), { accountId: 'account-1', vmId: 'vm-01' })
})

test('#A20: a late completion never writes back a pin another request released', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const pins = new Map([['conversation-1', { accountId: 'account-1', vmId: 'vm-01', generation: 3 }]])
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: {
      resolve: (key) => pins.get(key) || null,
      bind: (key, value) => pins.set(key, { ...value, generation: (pins.get(key)?.generation || 0) + 1 }),
    },
  })
  const result = await runner.run({
    requestId: 'req-late',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'conversation-1',
    callAttempt: () => {
      // While this hop streams, a quota exclusion elsewhere releases the pin.
      pins.delete('conversation-1')
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-1')
  assert.equal(pins.has('conversation-1'), false)
})

test('verified hop binds family and session sticky keys to the same account', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const bindings = []
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: {
      bind: (key, value, opts) => bindings.push({ key, value, opts }),
    },
  })
  const result = await runner.run({
    requestId: 'req-family',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'dev:aabbcc',
    stickyKeys: ['dev:aabbcc', 'child-sess'],
    callAttempt: () => success(),
  })
  assert.equal(result.ok, true)
  const commits = bindings.filter((b) => b.opts?.countHit !== false)
  assert.deepEqual(commits.map((b) => b.key).sort(), ['child-sess', 'dev:aabbcc'])
  assert.ok(commits.every((b) => b.value.accountId === 'account-1' && b.value.vmId === 'vm-01'))
})

test('probe hop passes skipSessionSeat and only updates device affinity', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const selectCalls = []
  const select = scheduler.selectAndReserve.bind(scheduler)
  scheduler.selectAndReserve = async (opts) => {
    selectCalls.push(opts)
    return select(opts)
  }
  const sessionBindings = []
  const deviceBindings = []
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: {
      resolve: (key) => (key === 'dev2:device-1' ? { vmId: 'vm-01', accountId: 'account-1' } : null),
      bind: (key, value, opts) => sessionBindings.push({ key, value, opts }),
      bindDeviceAffinity: (key, value, opts) => deviceBindings.push({ key, value, opts }),
    },
  })
  const result = await runner.run({
    requestId: 'req-probe-seatless',
    canonicalBody: { model: 'claude-haiku-test' },
    model: 'claude-haiku-test',
    stickyKey: null,
    stickyKeys: [],
    stickyDeviceId: 'device-1',
    deviceKey: 'dev2:device-1',
    skipSessionSeat: true,
    callAttempt: () => success(),
  })
  assert.equal(result.ok, true)
  assert.equal(selectCalls.length, 1)
  assert.equal(selectCalls[0].skipSessionSlot, true)
  assert.equal(selectCalls[0].stickyKey, null)
  assert.deepEqual(selectCalls[0].stickyKeys, [])
  assert.equal(selectCalls[0].deviceVmId, 'vm-01')
  assert.deepEqual(sessionBindings, [])
  assert.equal(deviceBindings.length, 2)
  assert.ok(deviceBindings.every((binding) => binding.key === 'dev2:device-1'))
})

test('verified hop stores the outbound session on every sticky alias', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const bindings = []
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: {
      bind: (key, value, opts) => bindings.push({ key, value, opts }),
    },
  })
  const result = await runner.run({
    requestId: 'req-stable-session',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'dev:aabbcc',
    stickyKeys: ['dev:aabbcc', 'ch:first'],
    applyAttempt: () => ({
      body: { model: 'claude-opus-test' },
      meta: { sessionId: '11111111-1111-4111-8111-111111111111', toolNames: {} },
    }),
    callAttempt: () => success(),
  })
  assert.equal(result.ok, true)
  const stored = bindings.filter((b) => b.value.sessionId)
  assert.deepEqual(stored.map((b) => b.key).sort(), ['ch:first', 'dev:aabbcc', 'ch:first', 'dev:aabbcc'].sort())
  assert.ok(stored.every((b) => b.value.sessionId === '11111111-1111-4111-8111-111111111111'))
  assert.ok(stored.every((b) => b.value.accountId === 'account-1'))
})

test('request-scoped entitlement error does not walk the pool', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-2',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: () => ({
      ok: false,
      status: 429,
      terminalState: 'rejected',
      body: { error: { message: 'Usage credits are required for fast mode' } },
    }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.attemptCount, 1)
  assert.equal(scheduler.selectCalls, 1)
  assert.equal(scheduler.cooldowns.length, 0)
})

test('committed realtime stream failure never switches accounts', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-3',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stream: true,
    callAttempt: ({ onCommit }) => {
      onCommit()
      return {
        ok: false,
        status: 200,
        committed: true,
        terminalState: 'incomplete',
        body: { error: { message: 'stream closed' } },
      }
    },
  })
  assert.equal(result.finalState, 'incomplete')
  assert.equal(result.attemptCount, 1)
  assert.equal(scheduler.selectCalls, 1)
})

test('cloudflare 403 does not trigger SOCKS disconnect', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const failures = []
  const runner = new FailoverRunner({
    scheduler,
    onProxyFailure: (vmId, reason) => failures.push({ vmId, reason }),
  })
  const result = await runner.run({
    requestId: 'req-cf',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 403,
          terminalState: 'rejected',
          body: { error: { message: '<html>cloudflare</html>' } },
        }
      }
      return success()
    },
  })
  assert.equal(failures.length, 0)
})

test('proxy transport error notifies onProxyFailure then rotates', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const failures = []
  const runner = new FailoverRunner({
    scheduler,
    onProxyFailure: (vmId, reason) => failures.push({ vmId, reason }),
  })
  const result = await runner.run({
    requestId: 'req-proxy',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 0,
          transportError: true,
          terminalState: 'transport_error',
          body: { error: { code: 'worker_transport_error', message: 'SOCKS proxy dial failed' } },
        }
      }
      return success()
    },
  })
  assert.ok(failures.length >= 1)
  assert.equal(failures[0].vmId, 'vm-01')
  assert.equal(failures[0].reason, 'proxy_transport_failure')
})

function badGateway(message = 'net/http: timeout awaiting response headers') {
  return {
    ok: false,
    status: 502,
    terminalState: 'error',
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        code: 'upstream_transport_error',
        message,
      },
    },
  }
}

test('signature error is repaired once on the same account when enabled', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler, config: { signature_repair: true } })
  let calls = 0
  const result = await runner.run({
    requestId: 'req-4',
    canonicalBody: {
      model: 'claude-opus-test',
      thinking: { type: 'enabled' },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'x' },
            { type: 'text', text: 'keep' },
          ],
        },
      ],
    },
    model: 'claude-opus-test',
    callAttempt: ({ body }) => {
      calls++
      if (calls === 1) {
        return {
          ok: false,
          status: 400,
          terminalState: 'rejected',
          body: { error: { message: 'thinking.signature: Field required' } },
        }
      }
      assert.equal(body.thinking, undefined)
      assert.deepEqual(body.messages[0].content, [
        { type: 'text', text: 'x' },
        { type: 'text', text: 'keep' },
      ])
      return success('repaired')
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.attemptCount, 2)
  assert.equal(calls, 2)
})

test('search history repair still runs when the rejected hop outlived the deadline', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler, config: { total_retry_deadline_ms: 20 } })
  const bodies = []
  const result = await runner.run({
    requestId: 'req-search-slow-400',
    canonicalBody: {
      model: 'claude-opus-test',
      messages: [
        { role: 'user', content: 'find it' },
        {
          role: 'assistant',
          content: [
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'mac mini' } },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_1',
              content: [{ type: 'web_search_result', title: 'T', url: 'https://a.example', encrypted_content: 'AAAA' }],
            },
            { type: 'text', text: 'found' },
          ],
        },
        { role: 'user', content: 'go on' },
      ],
    },
    model: 'claude-opus-test',
    callAttempt: async ({ body }) => {
      bodies.push(body)
      if (bodies.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 40))
        return {
          ok: false,
          status: 400,
          terminalState: 'rejected',
          body: {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'messages.1.content.0: Invalid `encrypted_content` in `search_result` block',
            },
          },
        }
      }
      return success('repaired')
    },
  })
  assert.equal(result.ok, true)
  assert.equal(bodies.length, 2)
  assert.equal(JSON.stringify(bodies[1]).includes('encrypted_content'), false)
})

function searchHistoryBody() {
  return {
    model: 'claude-opus-test',
    messages: [
      { role: 'user', content: 'find it' },
      {
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'release notes' } },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [
              { type: 'web_search_result', title: 'Release', url: 'https://a.example', encrypted_content: 'old' },
            ],
          },
        ],
      },
      { role: 'user', content: 'summarize' },
    ],
  }
}

function rejectedSearch() {
  return {
    ok: false,
    status: 400,
    terminalState: 'rejected',
    body: { error: { message: 'Invalid `encrypted_content` in `search_result` block' } },
  }
}

test('confirmed search repair is reused for unchanged history on the next turn', async () => {
  const runner = new FailoverRunner({ scheduler: new Scheduler([candidate(1)]) })
  const history = searchHistoryBody()
  let executions = 0
  const execute = ({ body }) => {
    executions++
    if (JSON.stringify(body).includes('encrypted_content')) {
      return rejectedSearch()
    }
    return success('release summary')
  }
  const args = { model: history.model, stickyKey: 'search-conversation', callAttempt: execute }
  const first = await runner.run({ ...args, requestId: 'search-first', canonicalBody: history })
  assert.equal(first.status, 200)
  assert.equal(first.attemptCount, 2)
  const beforeSecond = executions
  const second = await runner.run({
    ...args,
    requestId: 'search-next',
    canonicalBody: {
      ...history,
      messages: [
        ...history.messages,
        { role: 'assistant', content: 'release summary' },
        { role: 'user', content: 'explain the changes' },
      ],
    },
  })
  assert.equal(second.status, 200)
  assert.equal(executions - beforeSecond, 1, 'known rejected history must not make another failing upstream call')
  assert.equal(second.attemptCount, 1)
  assert.equal(history.messages[1].content[1].content[0].encrypted_content, 'old')
})

for (const changed of ['session', 'account', 'vm', 'model', 'credential', 'history', 'tools', 'new search']) {
  test(`confirmed search repair does not rewrite a different ${changed}`, async () => {
    const scheduler = new Scheduler([{ ...candidate(1), vm: { claude: { _token_version: 1 } } }])
    const runner = new FailoverRunner({ scheduler })
    const history = searchHistoryBody()
    const args = { model: history.model, stickyKey: 'search-conversation', canonicalBody: history }
    const first = await runner.run({
      ...args,
      requestId: 'learn-search',
      callAttempt: ({ body }) => (JSON.stringify(body).includes('encrypted_content') ? rejectedSearch() : success()),
    })
    assert.equal(first.status, 200)
    assert.equal(first.attemptCount, 2)
    switch (changed) {
      case 'session':
        args.stickyKey = 'other-conversation'
        break
      case 'account':
        scheduler.candidates[0].accountId = 'other-account'
        break
      case 'vm':
        scheduler.candidates[0].vmId = 'other-vm'
        break
      case 'model':
        args.model = history.model = 'claude-sonnet-test'
        break
      case 'credential':
        scheduler.candidates[0].vm.claude._token_version = 2
        break
      case 'history':
        history.messages[1].content[1].content[0].encrypted_content = 'new-ciphertext'
        break
      case 'tools':
        history.tools = [{ name: 'extra', input_schema: { type: 'object' } }]
        break
      case 'new search':
        history.messages.push(
          { ...structuredClone(history.messages[1]), content: [{ type: 'search_result', encrypted_content: 'new' }] },
          { role: 'user', content: 'continue' },
        )
        break
    }
    const result = await runner.run({
      ...args,
      requestId: 'fresh-search-contract',
      callAttempt: ({ body }) => {
        assert.deepEqual(body, history, 'a new execution context or search history must get its original opaque data')
        return success('original history accepted')
      },
    })
    assert.equal(result.status, 200)
    assert.equal(result.attemptCount, 1)
  })
}

test('failed search repair is not learned for the next turn', async () => {
  const runner = new FailoverRunner({ scheduler: new Scheduler([candidate(1)]) })
  const history = searchHistoryBody()
  const args = { model: history.model, stickyKey: 'failed-search', canonicalBody: history }
  const rejected = await runner.run({ ...args, requestId: 'failed-repair', callAttempt: rejectedSearch })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.attemptCount, 2)
  const accepted = await runner.run({
    ...args,
    requestId: 'next-after-failed-repair',
    callAttempt: ({ body }) => {
      assert.deepEqual(body, history)
      return success('original accepted')
    },
  })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.attemptCount, 1)
})

test('a confirmed search repair does not hide a later rejection or retry the same transformed body', async () => {
  const runner = new FailoverRunner({ scheduler: new Scheduler([candidate(1)]) })
  const history = searchHistoryBody()
  const args = { model: history.model, stickyKey: 'changed-upstream', canonicalBody: history }
  const learned = await runner.run({
    ...args,
    requestId: 'learned-search',
    callAttempt: ({ body }) => (JSON.stringify(body).includes('encrypted_content') ? rejectedSearch() : success()),
  })
  assert.equal(learned.attemptCount, 2)
  const rejected = await runner.run({ ...args, requestId: 'search-rejected-again', callAttempt: rejectedSearch })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.attemptCount, 1)
  const next = await runner.run({
    ...args,
    requestId: 'after-stale-search-repair',
    callAttempt: ({ body }) => {
      assert.deepEqual(body, history, 'a failed learned repair must be discarded')
      return success('original accepted')
    },
  })
  assert.equal(next.status, 200)
})

test('signature 400 is not repaired when signature_repair is off', async () => {
  const scheduler = new Scheduler([{ ...candidate(1), vm: { family: 'codex', platform: 'openai' } }])
  const runner = new FailoverRunner({ scheduler })
  let calls = 0
  const result = await runner.run({
    requestId: 'req-sig-off',
    canonicalBody: {
      model: 'claude-opus-test',
      thinking: { type: 'enabled' },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'x' },
            { type: 'text', text: 'keep' },
          ],
        },
      ],
    },
    model: 'claude-opus-test',
    callAttempt: () => {
      calls++
      return {
        ok: false,
        status: 400,
        terminalState: 'rejected',
        body: { error: { message: 'thinking.signature: Field required' } },
      }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 400)
  assert.equal(calls, 1)
})

test('cli-hop signature 400 is not repaired when signature_repair is off', async () => {
  const scheduler = new Scheduler([
    {
      ...candidate(1),
      vm: { inference_engine: 'rust' },
    },
  ])
  const runner = new FailoverRunner({ scheduler })
  let calls = 0
  const result = await runner.run({
    requestId: 'req-cli-hop-sig',
    canonicalBody: {
      model: 'claude-opus-test',
      thinking: { type: 'enabled' },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'x' },
            { type: 'text', text: 'keep' },
          ],
        },
      ],
    },
    model: 'claude-opus-test',
    callAttempt: () => {
      calls++
      return {
        ok: false,
        status: 400,
        terminalState: 'rejected',
        body: { error: { message: 'Invalid `signature` in `thinking` block' } },
      }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 400)
  assert.equal(calls, 1)
})

test('thinking-only hop moves to the next slot and returns the later text', async () => {
  const scheduler = new Scheduler([candidate(1)])
  let n = 0
  const select = scheduler.selectAndReserve.bind(scheduler)
  scheduler.selectAndReserve = async (args) => {
    const selected = await select(args)
    if (selected?.ok) selected.slotIndex = n++
    return selected
  }
  const runner = new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0 },
  })
  let calls = 0
  const result = await runner.run({
    requestId: 'req-thinking-only',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          committed: false,
          terminalState: 'verified',
          body: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'draft', signature: 'sig' }],
            stop_reason: null,
          },
        }
      }
      return success('full answer')
    },
  })
  assert.equal(calls, 2)
  assert.equal(result.ok, true)
  assert.equal(result.finalState, 'verified')
  assert.equal(result.body.content[0].text, 'full answer')
  assert.equal(result.body.stop_reason, 'end_turn')
})

test('a replayable incomplete hop tries a free VM before repeating the same one', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const parked = []
  const runner = new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0 },
    rateLimitService: {
      handleUpstreamError: () => null,
      tempUnschedule: (item) => parked.push(item),
    },
  })
  const seen = []
  const result = await runner.run({
    requestId: 'req-incomplete-affinity',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'session-affinity',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.vmId)
      if (selected.vmId === 'vm-02') return success('recovered')
      return {
        ok: false,
        status: 200,
        committed: false,
        terminalState: 'incomplete',
        body: { type: 'message', role: 'assistant', content: [], stop_reason: null },
      }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.vmId, 'vm-02')
  assert.equal(result.attemptCount, 2)
  assert.deepEqual(seen, ['vm-01', 'vm-02'])
  assert.deepEqual(parked, [])
})

test('pinned incomplete hop still stops on the pinned VM', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler, config: { same_account_retry_delay_ms: 0 } })
  const result = await runner.run({
    requestId: 'req-incomplete-pin',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    pinVmId: 'vm-01',
    callAttempt: () => ({
      ok: false,
      status: 200,
      committed: false,
      terminalState: 'incomplete',
      body: { type: 'message', role: 'assistant', content: [], stop_reason: null },
    }),
  })
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'incomplete_response')
  assert.equal(result.vmId, 'vm-01')
})

test('aborted signal stops before another account is tried', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler, config: { same_account_retry_delay_ms: 0 } })
  const seen = []
  const signal = AbortSignal.abort()
  const result = await runner.run({
    requestId: 'req-cancel',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    signal,
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.vmId)
      return success('should not run')
    },
  })
  assert.equal(result.body.error.code, 'client_cancelled')
  assert.equal(result.status, 499)
  assert.deepEqual(seen, [])
  assert.equal(scheduler.cooldowns.length, 0)
})

for (const cancellation of ['result', 'throw']) {
  test(`client cancellation via ${cancellation} preserves outbound session beyond fifty turns`, async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cancel-session-'))
    const sticky = new StickyRouter({ dataDir, config: { sticky: { enabled: true } } })
    t.after(() => {
      sticky.db.close()
      fs.rmSync(dataDir, { recursive: true, force: true })
    })
    const scheduler = new Scheduler([{ ...candidate(1), slotIndex: 3 }])
    const runner = new FailoverRunner({ scheduler, stickyRouter: sticky })
    const callerSession = 'cancelled-caller'
    const stickyKey = sticky.canonicalSessionKey(callerSession)
    let originalSession
    for (let turn = 0; turn < 53; turn++) {
      const controller = new AbortController()
      const result = await runner.run({
        requestId: `req-cancel-${cancellation}-${turn}`,
        canonicalBody: { model: 'claude-opus-test' },
        model: 'claude-opus-test',
        stickyKey,
        signal: controller.signal,
        applyAttempt: (body, selected, extra) => {
          const bound = extra.stickyBound
          const sessionId = resolveOutboundSessionId(callerSession, {
            boundSessionId: bound?.sessionId,
            boundVmId: bound?.vmId,
            vmId: selected.vmId,
            epoch: `turn:${turn}`,
          })
          originalSession ??= sessionId
          assert.equal(sessionId, originalSession, `outbound session changed at turn ${turn}`)
          return { body, meta: { sessionId } }
        },
        callAttempt: () => {
          if (turn !== 50) return success()
          if (cancellation === 'throw') {
            controller.abort()
            throw Object.assign(new Error('Client closed the connection'), { code: 'request_cancelled' })
          }
          return { ok: false, status: 499, clientCancelled: true, terminalState: 'cancelled' }
        },
      })
      assert.equal(result.status, turn === 50 ? 499 : 200)
      if (turn === 50) assert.equal(result.body.error.code, 'client_cancelled')
      const bound = sticky.resolve(stickyKey)
      assert.equal(bound.sessionId, originalSession, `persisted session changed at turn ${turn}`)
      assert.equal(bound.slotIndex, 3, `cancellation dropped the seat at turn ${turn}`)
    }
    assert.notEqual(originalSession, callerSession)
    assert.deepEqual(scheduler.releasedAccounts, [])
    assert.deepEqual(scheduler.cooldowns, [])
  })
}

test('streamed plan limit writes the hard block and rotates to another account', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const blocks = []
  const runner = new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0 },
    rateLimitService: {
      handleUpstreamError: ({ accountId, policy }) => {
        if (policy.reason !== 'account_quota_exhausted') return null
        blocks.push({ accountId, reason: policy.reason })
        return { kind: 'rate_limited', until: 9_999_999_999_999 }
      },
      tempUnschedule: () => {},
    },
  })
  const seen = []
  const result = await runner.run({
    requestId: 'req-plan-limit',
    canonicalBody: { model: 'claude-haiku-test' },
    model: 'claude-haiku-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.accountId)
      if (selected.accountId === 'account-2') return success('other account')
      return {
        ok: false,
        status: 429,
        committed: false,
        terminalState: 'rejected',
        body: { type: 'error', error: { type: 'api_error', message: "You've hit your limit · resets 11am (UTC)" } },
      }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.deepEqual(seen, ['account-1', 'account-2'])
  assert.deepEqual(blocks, [{ accountId: 'account-1', reason: 'account_quota_exhausted' }])
  const cooled = scheduler.cooldowns.find((item) => item.candidate.accountId === 'account-1')
  assert.equal(cooled.update.until, 9_999_999_999_999)
})

test('fast 502 retries the same account once without cooldown', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0 },
  })
  const seen = []
  const result = await runner.run({
    requestId: 'req-502-same',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.accountId)
      return badGateway()
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'upstream_transport_error')
  assert.equal(result.via, 'pool-failover')
  assert.notEqual(result.body.error.code, 'server_overloaded')
  assert.deepEqual(seen, ['account-1', 'account-1'])
  assert.equal(scheduler.cooldowns.length, 0)
})

test('a retryable 502 moves to a free account before retrying the same one', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0 },
  })
  const seen = []
  const result = await runner.run({
    requestId: 'req-502-rotate',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.accountId)
      if (selected.accountId === 'account-1') return badGateway()
      return success('recovered')
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.deepEqual(seen, ['account-1', 'account-2'])
  assert.equal(scheduler.cooldowns.length, 0)
})

test('slow 502 does not stack another same-account hop', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({
    scheduler,
    config: {
      same_account_retry_delay_ms: 0,
      same_account_retry_max_hop_ms: 0,
    },
  })
  let calls = 0
  const result = await runner.run({
    requestId: 'req-502-slow',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: () => {
      calls++
      return badGateway()
    },
  })
  assert.equal(result.status, 502)
  assert.equal(calls, 1)
  assert.equal(scheduler.cooldowns.length, 0)
  assert.equal(result.body.error.code, 'upstream_transport_error')
})

test('pin 401 without refresh does not forever-park the slot', async () => {
  const scheduler = new Scheduler([{ ...candidate(1), hasRefresh: false }])
  const failures = []
  const runner = new FailoverRunner({
    scheduler,
    onCredentialFailure: (payload) => failures.push(payload),
  })
  const result = await runner.run({
    requestId: 'req-pin-401',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    pinVmId: 'vm-01',
    callAttempt: () => ({
      ok: false,
      status: 401,
      terminalState: 'rejected',
      body: { error: { message: 'invalid or expired credentials' } },
    }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
  assert.equal(scheduler.cooldowns.length, 0)
  assert.equal(failures.length, 0)
})

test('401 without refresh disables that slot then hops', async () => {
  const scheduler = new Scheduler([{ ...candidate(1), hasRefresh: false }, candidate(2)])
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: {},
  })
  const result = await runner.run({
    requestId: 'req-401-no-rt',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 401,
          terminalState: 'rejected',
          body: { error: { message: 'invalid or expired credentials' } },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.equal(scheduler.cooldowns[0].update.reason, 'oauth_no_refresh')
  assert.equal(scheduler.cooldowns[0].update.status, 'disabled')
  assert.ok(scheduler.releasedAccounts.length >= 1)
  assert.equal(scheduler.releasedAccounts[0].accountId, 'account-1')
})

test('second 401 on the same generation disables the slot then hops', async () => {
  const first = {
    ...candidate(1),
    vm: { claude: { has_refresh: true, oauth_401_generation: 4, expires_at: 99 } },
    workerStatus: { credential: { has_refresh: true, generation: 4 } },
  }
  const scheduler = new Scheduler([first, candidate(2)])
  const failures = []
  const runner = new FailoverRunner({
    scheduler,
    onCredentialFailure: (payload) => failures.push(payload),
  })
  const result = await runner.run({
    requestId: 'req-401-escalate',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 401,
          terminalState: 'rejected',
          body: { error: { message: 'OAuth access token has been revoked' } },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.equal(scheduler.cooldowns[0].update.reason, 'oauth_revoked')
  assert.equal(scheduler.cooldowns[0].update.status, 'disabled')
  assert.equal(failures[0].policy.reason, 'oauth_revoked')
})

test('401 unbinds the dead account then continues on the next slot', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: {},
  })
  const result = await runner.run({
    requestId: 'req-401',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'conversation-dead',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 401,
          terminalState: 'rejected',
          body: { error: { message: 'invalid or expired credentials' } },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.ok(scheduler.releasedAccounts.length >= 1)
  assert.equal(scheduler.releasedAccounts[0].accountId, 'account-1')
})

test('first 401 with refresh revokes the slot once then hops', async () => {
  const scheduler = new Scheduler([
    { ...candidate(1), vm: { claude: { has_refresh: true } }, workerStatus: { credential: { has_refresh: true } } },
    candidate(2),
  ])
  const failures = []
  const runner = new FailoverRunner({
    scheduler,
    onCredentialFailure: (payload) => failures.push(payload),
  })
  const seen = []
  const result = await runner.run({
    requestId: 'req-401-once',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.accountId)
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 401,
          terminalState: 'rejected',
          body: { error: { message: 'OAuth access token has been revoked.' } },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.deepEqual(seen, ['account-1', 'account-2'])
  assert.equal(scheduler.cooldowns[0].update.reason, 'oauth_revoked')
  assert.equal(scheduler.cooldowns[0].update.status, 'disabled')
  assert.equal(failures[0].policy.reason, 'oauth_revoked')
})

test('applyAttempt failure releases its reservation and fails over', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const select = scheduler.selectAndReserve.bind(scheduler)
  let releases = 0
  scheduler.selectAndReserve = async (opts) => {
    const selected = await select(opts)
    if (!selected.ok) return selected
    return { ...selected, release: () => releases++ }
  }
  const attempts = new Attempts()
  const runner = new FailoverRunner({ scheduler, attemptsRepo: attempts, config: { same_account_retry_delay_ms: 0 } })
  const prepared = []
  const result = await runner.run({
    requestId: 'req-prepare-failure',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    applyAttempt: (body, selected) => {
      prepared.push(selected.accountId)
      if (selected.accountId === 'account-1') throw new Error('persona preparation failed')
      return body
    },
    callAttempt: () => success(),
  })

  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.deepEqual(prepared, ['account-1', 'account-2'])
  assert.equal(releases, 2)
  assert.equal(attempts.items.length, 2)
  assert.ok(attempts.items.every((item) => item.state === 'completed'))
})

test('empty pool without a prior hop stays account_pool_exhausted', async () => {
  const scheduler = new Scheduler([])
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-empty',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: () => success(),
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'account_pool_exhausted')
  assert.equal(result.body.error.message, 'No eligible Claude accounts remain')
  assert.equal(result.body.error.details.reason, 'no_eligible_accounts')
  assert.equal(result.body.error.details.wait_ms, 0)
  assert.equal(result.body.error.details.sticky_cleared, false)
})

test('fable without an eligible Max account returns a dedicated HTTP 429', async () => {
  const scheduler = {
    async selectAndReserve() {
      return { ok: false, reason: 'fable_requires_max', waitMs: 0, eligible: 0, available: 0 }
    },
    markCooldown() {},
    markSuccess() {},
  }
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-fable-no-max',
    canonicalBody: { model: 'claude-fable-5' },
    model: 'claude-fable-5',
    callAttempt: () => success(),
  })
  assert.equal(result.status, 429)
  assert.equal(result.body.error.type, 'rate_limit_error')
  assert.equal(result.body.error.code, 'fable_requires_max')
  assert.match(result.body.error.message, /Max account/i)
})

test('pool exhaustion details include the scheduler snapshot', async () => {
  const scheduler = {
    async selectAndReserve() {
      return {
        ok: false,
        reason: 'all_accounts_busy',
        waitMs: 12,
        soonest_available_ms: 10_064_000,
        wait_reasons: ['account_cooldown'],
        eligible: 2,
        available: 0,
        sticky_cleared: true,
      }
    },
    markCooldown() {},
    markSuccess() {},
  }
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-busy-snap',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: () => success(),
  })
  assert.equal(result.status, 529)
  assert.equal(result.body.error.type, 'overloaded_error')
  assert.equal(result.body.error.code, 'pool_overloaded')
  assert.equal(result.body.error.message, '号池负载过高，稍后再试')
  assert.equal(result.retryAfterSec, 10_064)
  assert.equal(result.attemptCount, 0)
  assert.equal(result.body.error.details.reason, 'all_accounts_busy')
  assert.equal(result.body.error.details.soonest_available_ms, 10_064_000)
  assert.equal(result.body.error.details.sticky_cleared, true)
  assert.equal(result.body.error.details.eligible, 2)
  assert.deepEqual(result.body.error.details.wait_reasons, ['account_cooldown'])
})

test('a seat queue timeout is a 529 overloaded_error with the planner retry-after', async () => {
  const scheduler = {
    async selectAndReserve() {
      return { ok: false, reason: 'pool_queue_timeout', waitMs: 3000, retry_after_ms: 2_500, eligible: 2 }
    },
    markCooldown() {},
    markSuccess() {},
  }
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-queue-timeout',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: () => success(),
  })
  assert.equal(result.status, 529)
  assert.equal(result.body.error.type, 'overloaded_error')
  assert.equal(result.body.error.code, 'pool_overloaded')
  assert.equal(result.body.error.details.reason, 'pool_queue_timeout')
  assert.equal(result.retryAfterSec, 3)
})

test('every account in an upstream cooldown: 529 cooldown is capacity, 429 cooldown is a 429', async () => {
  const cases = [
    ['pool_overload_cooldown', 529, 'overloaded_error', 'pool_overloaded'],
    ['pool_rate_limited', 429, 'rate_limit_error', 'pool_rate_limited'],
  ]
  for (const [reason, status, type, code] of cases) {
    const scheduler = {
      async selectAndReserve() {
        return { ok: false, reason, retry_after_ms: 41_200, eligible: 0 }
      },
      markCooldown() {},
      markSuccess() {},
    }
    const result = await new FailoverRunner({ scheduler }).run({
      requestId: `req-${reason}`,
      canonicalBody: { model: 'claude-sonnet-test' },
      model: 'claude-sonnet-test',
      callAttempt: () => success(),
    })
    assert.equal(result.status, status, reason)
    assert.equal(result.body.error.type, type, reason)
    assert.equal(result.body.error.code, code, reason)
    assert.equal(result.retryAfterSec, 42, reason)
  }
})

test('a full pool queue answers 529 immediately with retry-after >= 1s', async () => {
  const scheduler = {
    async selectAndReserve() {
      throw Object.assign(new Error('Claude pool queue is full'), { code: 'pool_wait_queue_full', retryAfterMs: null })
    },
    markCooldown() {},
    markSuccess() {},
  }
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-queue-full',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: () => success(),
  })
  assert.equal(result.status, 529)
  assert.equal(result.body.error.type, 'overloaded_error')
  assert.equal(result.body.error.details.reason, 'pool_wait_queue_full')
  assert.equal(result.retryAfterSec, 1)
})

test('one VM gets at most three executions for a request, hidden retries included', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const seen = []
  const runner = new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0 },
  })
  const result = await runner.run({
    requestId: 'req-incomplete-cap',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.vmId)
      return {
        ok: false,
        status: 200,
        committed: false,
        terminalState: 'incomplete',
        rust_transport_retried: seen.length === 1,
        body: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'draft', signature: 'sig' }],
          stop_reason: null,
        },
      }
    },
  })
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'incomplete_response')
  assert.equal(result.vmId, 'vm-01')
  assert.equal(result.attemptCount, 2)
  assert.deepEqual(seen, ['vm-01', 'vm-01'])
})

test('a hop that failed with a kernel-named cause ends with that cause, not incomplete_response', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const seen = []
  const runner = new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0 },
  })
  const result = await runner.run({
    requestId: 'req-network',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.vmId)
      return {
        ok: false,
        status: 502,
        committed: false,
        terminalState: 'incomplete',
        body: {
          type: 'error',
          error: { type: 'api_error', code: 'upstream_network_error', message: 'fetch failed: ECONNRESET' },
        },
      }
    },
  })
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'upstream_network_error')
  assert.ok(seen.includes('vm-02'), 'a network failure moves on to another VM')
  assert.deepEqual(scheduler.cooldowns, [], 'no account is penalised for it')
})

test('the fifth candidate is reached after four VMs fail', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)])
  const seen = []
  const result = await new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0, max_total_attempts: 4, max_account_switches: 3 },
  }).run({
    requestId: 'req-fifth',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.vmId)
      if (selected.vmId === 'vm-05') return success('fifth')
      return {
        ok: false,
        status: 529,
        terminalState: 'rejected',
        body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.vmId, 'vm-05')
  assert.deepEqual(seen, ['vm-01', 'vm-02', 'vm-03', 'vm-04', 'vm-05'])
})

test('session queue timeout defaults to 15 minutes and reloads over the default', () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler })
  assert.equal(runner.config.session_queue_timeout_ms, 900_000)
  runner.reloadConfig({ total_retry_deadline_ms: 50 })
  assert.equal(runner.config.session_queue_timeout_ms, 900_000)
  runner.reloadConfig({ session_queue_timeout_ms: 0 })
  assert.equal(runner.config.session_queue_timeout_ms, 0)
})

test('a same-session waiter times out without starting or overlapping the holder', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler, config: { session_queue_timeout_ms: 40 } })
  let release
  let entered
  const holderEntered = new Promise((resolve) => {
    entered = resolve
  })
  let holderCalls = 0
  let waiterCalls = 0
  let followerCalls = 0
  const holder = runner.run({
    requestId: 'req-hold',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'shared-session',
    callAttempt: () => {
      holderCalls += 1
      entered()
      return new Promise((resolve) => {
        release = () => resolve(success())
      })
    },
  })
  await holderEntered
  const waiter = await runner.run({
    requestId: 'req-wait',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'shared-session',
    callAttempt: () => {
      waiterCalls += 1
      return success()
    },
  })
  assert.equal(waiter.ok, false)
  assert.equal(waiter.status, 529)
  assert.equal(waiter.body.error.type, 'overloaded_error')
  assert.equal(waiter.body.error.code, 'pool_overloaded')
  assert.equal(waiter.body.error.details.reason, 'session_queue_timeout')
  assert.equal(waiterCalls, 0)
  assert.equal(holderCalls, 1)
  let followerEntered = false
  const follower = runner.run({
    requestId: 'req-follow',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'shared-session',
    callAttempt: () => {
      followerEntered = true
      followerCalls += 1
      return success()
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(followerEntered, false)
  release()
  const held = await holder
  const followed = await follower
  assert.equal(held.ok, true)
  assert.equal(followed.ok, true)
  assert.equal(followerCalls, 1)
  assert.equal(waiterCalls, 0)
  assert.equal(scheduler.selectCalls, 2)
})

test('session queue wait still aborts with the caller', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler, config: { session_queue_timeout_ms: 5_000 } })
  let release
  let entered
  const holderEntered = new Promise((resolve) => {
    entered = resolve
  })
  const holder = runner.run({
    requestId: 'req-hold-abort',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'abort-session',
    callAttempt: () => {
      entered()
      return new Promise((resolve) => {
        release = () => resolve(success())
      })
    },
  })
  await holderEntered
  const controller = new AbortController()
  const pending = runner.run({
    requestId: 'req-abort-wait',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'abort-session',
    signal: controller.signal,
    callAttempt: () => success(),
  })
  controller.abort()
  const aborted = await pending
  assert.equal(aborted.terminalState, 'cancelled')
  assert.equal(aborted.status, 499)
  release()
  assert.equal((await holder).ok, true)
})

test('same sticky session requests execute serially', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler })
  let active = 0
  let peak = 0
  const callAttempt = async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active -= 1
    return success()
  }
  const request = (requestId) =>
    runner.run({
      requestId,
      canonicalBody: { model: 'claude-opus-test' },
      model: 'claude-opus-test',
      stickyKey: 'shared-session',
      callAttempt,
    })
  const [first, second] = await Promise.all([request('req-serial-1'), request('req-serial-2')])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(peak, 1)
})

test('different sticky sessions still execute concurrently', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler })
  let active = 0
  let peak = 0
  const callAttempt = async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active -= 1
    return success()
  }
  await Promise.all(
    ['session-a', 'session-b'].map((stickyKey) =>
      runner.run({
        requestId: `req-${stickyKey}`,
        canonicalBody: { model: 'claude-opus-test' },
        model: 'claude-opus-test',
        stickyKey,
        callAttempt,
      }),
    ),
  )
  assert.equal(peak, 2)
})

test('fable 403 marks pro and failovers without credential cooldown', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const denied = []
  const accepted = []
  const runner = new FailoverRunner({
    scheduler,
    onFablePlanDenied: (event) => denied.push(event.selected.accountId),
    onFableSuccess: (event) => accepted.push(event.selected.accountId),
  })
  const result = await runner.run({
    requestId: 'req-fable-pro',
    canonicalBody: { model: 'claude-fable-5' },
    model: 'claude-fable-5',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 403,
          terminalState: 'rejected',
          body: { error: { type: 'permission_error', message: 'permission denied' } },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.deepEqual(denied, ['account-1'])
  assert.deepEqual(accepted, ['account-2'])
  assert.equal(scheduler.cooldowns.length, 0)
})

function leasingScheduler(candidates, cap = 2) {
  const state = { inflight: 0, selects: [] }
  return {
    state,
    async selectAndReserve(opts) {
      state.selects.push(opts)
      const vmId = opts.pinVmId || opts.familyVmId || candidates[0].vmId
      const found = candidates.find((item) => item.vmId === vmId)
      if (!found || state.inflight >= cap) return { ok: false, reason: 'all_accounts_busy', eligible: 1 }
      state.inflight++
      let released = false
      return {
        ...found,
        ok: true,
        release() {
          if (released) return
          released = true
          state.inflight--
        },
      }
    },
    markCooldown() {},
    markSuccess() {},
  }
}

test('explicit VM pin is not redirected by a family locked elsewhere', async () => {
  const scheduler = leasingScheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: {
      resolve: (key) => (key === 'family2:root' ? { accountId: 'account-2', vmId: 'vm-02' } : null),
      bind: () => true,
    },
  })
  for (let i = 0; i < 3; i++) {
    const result = await runner.run({
      requestId: `req-pinned-${i}`,
      canonicalBody: { model: 'claude-haiku-test' },
      model: 'claude-haiku-test',
      pinVmId: 'vm-01',
      familyKey: 'family2:root',
      familyVmId: 'vm-02',
      callAttempt: () => success(),
    })
    assert.equal(result.ok, true)
    assert.equal(result.vmId, 'vm-01')
  }
  assert.equal(scheduler.state.selects.length, 3)
  assert.equal(scheduler.state.inflight, 0)
})

test('an all-rest pool 503 carries Retry-After for the next window open', async () => {
  const scheduler = {
    async selectAndReserve() {
      return { ok: false, reason: 'no_eligible_accounts', retry_after_ms: 90_500, eligible: 0, available: 0 }
    },
  }
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-all-rest',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: () => success(),
  })
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'account_pool_exhausted')
  assert.equal(result.retryAfterSec, 91)
})
