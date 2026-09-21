import test from 'node:test'
import assert from 'node:assert/strict'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'

class Scheduler {
  constructor(candidates) {
    this.candidates = candidates
    this.cooldowns = []
    this.successes = []
    this.selectCalls = 0
  }

  async selectAndReserve({ excluded }) {
    this.selectCalls++
    const candidate = this.candidates.find((item) => !excluded.has(item.accountId) && !excluded.has(item.vmId))
    if (!candidate) return { ok: false, reason: 'no_eligible_accounts' }
    return { ...candidate, ok: true, release() {} }
  }

  markCooldown(candidate, update) {
    this.cooldowns.push({ candidate, update })
  }

  markSuccess(candidate) {
    this.successes.push(candidate)
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
    selectionReason: number === 1 ? 'sticky' : 'weighted-round-robin',
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

test('account1 quota exhausted rotates to account2 and commits final sticky', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const attempts = new Attempts()
  const bindings = []
  const unbound = []
  const runner = new FailoverRunner({
    scheduler,
    attemptsRepo: attempts,
    stickyRouter: {
      bind: (key, value, opts) => bindings.push({ key, value, opts }),
      unbindByAccount: (value) => unbound.push(value),
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
  assert.deepEqual(unbound, [{ accountId: 'account-1', vmId: 'vm-01' }])
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

test('cli-hop rust slot repairs signature 400 even when signature_repair is off', async () => {
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
    callAttempt: ({ body }) => {
      calls++
      if (calls === 1) {
        return {
          ok: false,
          status: 400,
          terminalState: 'rejected',
          body: { error: { message: 'Invalid `signature` in `thinking` block' } },
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

test('thinking-only hop retries same account and returns the later text', async () => {
  const scheduler = new Scheduler([candidate(1)])
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

test('repeated incomplete hop stops on the original VM after one recovery', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler, config: { same_account_retry_delay_ms: 0 } })
  const seen = []
  const result = await runner.run({
    requestId: 'req-incomplete-affinity',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'session-affinity',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.vmId)
      return {
        ok: false,
        status: 200,
        committed: false,
        terminalState: 'incomplete',
        body: { type: 'message', role: 'assistant', content: [], stop_reason: null },
      }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'incomplete_response')
  assert.equal(result.attemptCount, 2)
  assert.equal(result.vmId, 'vm-01')
  assert.deepEqual(seen, ['vm-01', 'vm-01'])
  assert.equal(scheduler.selectCalls, 2)
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
  assert.equal(scheduler.selectCalls, 3)
})

test('502 rotates to another account after one same-account retry', async () => {
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
  assert.deepEqual(seen, ['account-1', 'account-1', 'account-2'])
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
  const unbound = []
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: { unbindByAccount: (value) => unbound.push(value) },
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
  assert.ok(unbound.length >= 1)
  assert.equal(unbound[0].accountId, 'account-1')
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
  const unbound = []
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: { unbindByAccount: (value) => unbound.push(value) },
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
  assert.ok(unbound.length >= 1)
  assert.equal(unbound[0].accountId, 'account-1')
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
  assert.deepEqual(prepared, ['account-1', 'account-1', 'account-2'])
  assert.equal(releases, 3)
  assert.equal(attempts.items.length, 3)
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
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'account_pool_exhausted')
  assert.equal(result.body.error.message, 'No eligible Claude accounts remain')
  assert.equal(result.body.error.details.reason, 'all_accounts_busy')
  assert.equal(result.body.error.details.soonest_available_ms, 10_064_000)
  assert.equal(result.body.error.details.sticky_cleared, true)
  assert.equal(result.body.error.details.eligible, 2)
  assert.deepEqual(result.body.error.details.wait_reasons, ['account_cooldown'])
})

test('preferLastResult does not deliver thinking-only as HTTP 200', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({
    scheduler,
    config: { max_total_attempts: 1, max_same_account_retries: 0, max_account_switches: 0 },
  })
  const result = await runner.run({
    requestId: 'req-incomplete-last',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: () => ({
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
    }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'incomplete_response')
  assert.notEqual(result.status, 200)
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
  const runner = new FailoverRunner({
    scheduler,
    onFablePlanDenied: (event) => denied.push(event.selected.accountId),
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
  assert.equal(scheduler.cooldowns.length, 0)
})
