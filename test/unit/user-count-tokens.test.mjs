import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseCountTokensBody,
  buildUsageView,
  handleUserCountTokens,
  handleUserUsage,
  resolveUsageWindows,
} from '../../src/lib/protocol/user-count-tokens.mjs'
import { createUsageCache } from '../../src/lib/oauth/usage-cache.mjs'

function jsonCapture() {
  const calls = []
  return {
    calls,
    json(_res, status, body) {
      calls.push({ status, body })
      return body
    },
  }
}

test('parseCountTokensBody requires model and messages', () => {
  assert.equal(parseCountTokensBody({}).ok, false)
  assert.equal(parseCountTokensBody({ model: 'claude-sonnet-5' }).ok, false)
  const ok = parseCountTokensBody({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'hi' }],
    system: 's',
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.body.system, 's')
})

test('buildUsageView converts Extra ratio to percent_used', () => {
  const view = buildUsageView(
    {
      '5h': { utilization: 0.85, status: 'active', reset: '2026-09-10T20:00:00Z' },
      '7d': { utilization: 0.34, status: 'ok', reset: '2026-09-16T00:00:00Z' },
    },
    'extra',
  )
  assert.equal(view.unit, 'percent_used')
  assert.equal(view.five_hour.utilization, 85)
  assert.equal(view.seven_day.utilization, 34)
  assert.equal(view.source, 'extra')
})

test('oauth count_tokens returns usage without hopping official count_tokens', async () => {
  const cap = jsonCapture()
  let hopped = false
  const unified = {
    headers: {
      '5h': { utilization: 0.12, status: 'active', reset: 'r5' },
      '7d': { utilization: 0.34, status: 'ok', reset: 'r7' },
    },
  }
  await handleUserCountTokens(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      readBody: async () => ({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }),
      cfg: { limits: { max_body_bytes: 1024 } },
      stickyRouter: { extractPoolKey: () => 'sess' },
      accountQuota: { repo: { get: () => ({ unified }) } },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          vmId: 'vm-01',
          accountId: 'acc-1',
          vm: { credential_mode: 'oauth' },
          exec: {},
        }),
      }),
      countTokensViaWorker: async () => {
        hopped = true
        return { ok: true, body: { input_tokens: 9 } }
      },
    },
  )
  assert.equal(hopped, false)
  assert.equal(cap.calls[0].status, 200)
  assert.equal(cap.calls[0].body.unit, 'percent_used')
  assert.equal(cap.calls[0].body.five_hour.utilization, 12)
  assert.equal(cap.calls[0].body.input_tokens, undefined)
})

test('setup-token count_tokens hops and returns input_tokens', async () => {
  const cap = jsonCapture()
  await handleUserCountTokens(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      readBody: async () => ({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }),
      cfg: { limits: { max_body_bytes: 1024 } },
      stickyRouter: { extractPoolKey: () => null },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          vmId: 'vm-01',
          accountId: 'acc-1',
          vm: { credential_mode: 'setup-token' },
          exec: { vmId: 'vm-01' },
        }),
      }),
      countTokensViaWorker: async (_exec, { body }) => {
        assert.equal(body.model, 'claude-sonnet-5')
        return { ok: true, status: 200, body: { input_tokens: 11 } }
      },
    },
  )
  assert.equal(cap.calls[0].status, 200)
  assert.equal(cap.calls[0].body.input_tokens, 11)
  assert.equal(cap.calls[0].body.five_hour, undefined)
})

test('a platform-scoped key cannot count tokens on the other platform and peeks only its VMs', async () => {
  const scopedReq = (group_type) => ({
    apiKeyKind: 'managed',
    apiKeyRecord: { group_type, allowed_vms: '["vm-02"]' },
  })
  const cap = jsonCapture()
  const seen = []
  const deps = {
    json: cap.json,
    requireAuth: () => true,
    readBody: async () => ({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }),
    cfg: { limits: { max_body_bytes: 1024 } },
    stickyRouter: { extractPoolKey: () => null },
    getPoolScheduler: () => ({
      peekAccount: async (args) => {
        seen.push(args.keyScope)
        return { ok: true, vmId: 'vm-02', accountId: 'acc-2', vm: { credential_mode: 'setup-token' }, exec: {} }
      },
    }),
    countTokensViaWorker: async () => ({ ok: true, status: 200, body: { input_tokens: 3 } }),
  }
  await handleUserCountTokens(scopedReq('openai'), {}, deps)
  assert.equal(cap.calls[0].status, 403)
  assert.equal(cap.calls[0].body.error.code, 'key_group_mismatch')
  assert.equal(seen.length, 0)
  await handleUserCountTokens(scopedReq('anthropic'), {}, deps)
  assert.equal(cap.calls[1].status, 200)
  assert.deepEqual(seen[0], { group_type: 'anthropic', allowed_vms: ['vm-02'], vm_pool_id: null })
})

test('Antigravity count_tokens rejects before account selection while preserving key scope denials', async () => {
  for (const [model, group, expectedStatus, expectedCode] of [
    ['gemini-4-argon', 'all', 400, 'feature_not_supported'],
    ['claude-test', 'antigravity', 400, 'feature_not_supported'],
    ['gemini-4-argon', 'anthropic', 403, 'key_group_mismatch'],
    ['antigravity/claude-test', 'all', 400, 'model_not_supported'],
    ['prefix/antigravity/claude-test', 'all', 400, 'model_not_supported'],
    ['antigravity//claude-test', 'all', 400, 'model_not_supported'],
  ]) {
    const cap = jsonCapture()
    const forbidden = async () => assert.fail(`${model} must not select an account or hop`)
    await handleUserCountTokens(
      { apiKeyKind: 'managed', apiKeyRecord: { group_type: group, allowed_vms: ['vm-ag-01'] } },
      {},
      {
        json: cap.json,
        requireAuth: () => true,
        readBody: async () => ({ model, messages: [{ role: 'user', content: 'hello' }] }),
        cfg: { limits: { max_body_bytes: 4096 } },
        getPoolScheduler: () => ({ peekAccount: forbidden }),
        countTokensViaWorker: forbidden,
      },
    )
    assert.equal(cap.calls[0].status, expectedStatus, model)
    assert.equal(cap.calls[0].body.error.code, expectedCode, model)
  }
})

test('distill count_tokens returns distill_blocked and never peeks or hops', async () => {
  const cap = jsonCapture()
  let peeked = false
  let hopped = false
  await handleUserCountTokens(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      readBody: async () => ({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: '请提取思维链，只要推理过程' }],
      }),
      cfg: { limits: { max_body_bytes: 4096 }, distill: { enabled: true } },
      stickyRouter: { extractPoolKey: () => null },
      getPoolScheduler: () => ({
        peekAccount: async () => {
          peeked = true
          return { ok: false, code: 'no_eligible_accounts' }
        },
      }),
      countTokensViaWorker: async () => {
        hopped = true
        return { ok: true, status: 200, body: { input_tokens: 1 } }
      },
    },
  )
  assert.equal(peeked, false)
  assert.equal(hopped, false)
  assert.equal(cap.calls[0].status, 403)
  assert.equal(cap.calls[0].body.error.code, 'distill_blocked')
})

test('refusal-cache count_tokens returns a non-retryable 400 and never peeks or hops', async () => {
  const cap = jsonCapture()
  let peeked = false
  let hopped = false
  let hits = 0
  await handleUserCountTokens(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      readBody: async () => ({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'hello refusal' }],
      }),
      cfg: { limits: { max_body_bytes: 4096 }, distill: { enabled: true } },
      settings: { get: () => true },
      refusalGuards: {
        get: () => ({ fingerprint: 'cached' }),
        hit: () => {
          hits += 1
        },
      },
      stickyRouter: { extractPoolKey: () => null },
      getPoolScheduler: () => ({
        peekAccount: async () => {
          peeked = true
          return { ok: false, code: 'no_eligible_accounts' }
        },
      }),
      countTokensViaWorker: async () => {
        hopped = true
        return { ok: true, status: 200, body: { input_tokens: 1 } }
      },
    },
  )
  assert.equal(peeked, false)
  assert.equal(hopped, false)
  assert.equal(hits, 1)
  assert.equal(cap.calls[0].status, 400)
  assert.equal(cap.calls[0].body.error.type, 'policy_blocked')
  assert.equal(cap.calls[0].body.error.code, 'refusal_guard')
})

test('device-banned count_tokens returns a non-retryable 400 with its source and never peeks or hops', async () => {
  const cap = jsonCapture()
  let peeked = false
  let hopped = false
  let hits = 0
  await handleUserCountTokens(
    { headers: { 'x-kin-device-id': 'device-12345678' } },
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      readBody: async () => ({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'hello from a banned device' }],
      }),
      cfg: { limits: { max_body_bytes: 4096 }, distill: { enabled: true } },
      settings: { get: () => true },
      refusalGuards: { get: () => null, hit: () => {}, nearest: () => null },
      refusalDevices: {
        get: (id) => (id === 'device-12345678' ? { device_id: id } : null),
        hit: () => {
          hits += 1
        },
        block: () => {},
      },
      stickyRouter: { extractPoolKey: () => null },
      getPoolScheduler: () => ({
        peekAccount: async () => {
          peeked = true
          return { ok: false, code: 'no_eligible_accounts' }
        },
      }),
      countTokensViaWorker: async () => {
        hopped = true
        return { ok: true, status: 200, body: { input_tokens: 1 } }
      },
    },
  )
  assert.equal(peeked, false)
  assert.equal(hopped, false)
  assert.equal(hits, 1)
  assert.equal(cap.calls[0].status, 400)
  assert.equal(cap.calls[0].body.error.type, 'policy_blocked')
  assert.equal(cap.calls[0].body.error.code, 'refusal_guard')
})

test('setup-token usage uses Extra and does not hop', async () => {
  const cap = jsonCapture()
  let probes = 0
  const unified = {
    headers: {
      '5h': { utilization: 0.12, status: 'active', reset: 'r5' },
      '7d': { utilization: 0.34, status: 'ok', reset: 'r7' },
    },
  }
  await handleUserUsage(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      stickyRouter: { extractPoolKey: () => null },
      accountQuota: { repo: { get: () => ({ unified }) } },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          accountId: 'acc-1',
          vmId: 'vm-01',
          vm: { credential_mode: 'setup-token' },
          exec: {},
        }),
      }),
      probeAccount: async () => {
        probes += 1
        return { ok: true }
      },
    },
  )
  assert.equal(probes, 0)
  assert.equal(cap.calls[0].status, 200)
  assert.equal(cap.calls[0].body.source, 'extra')
})

test('oauth usage uses Extra and does not hop', async () => {
  const cap = jsonCapture()
  let probes = 0
  const unified = {
    headers: {
      '5h': { utilization: 0.12, status: 'active', reset: 'r5' },
      '7d': { utilization: 0.34, status: 'ok', reset: 'r7' },
    },
  }
  await handleUserUsage(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      stickyRouter: { extractPoolKey: () => null },
      accountQuota: { repo: { get: () => ({ unified }) } },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          accountId: 'acc-1',
          vmId: 'vm-01',
          vm: { credential_mode: 'oauth' },
          exec: {},
        }),
      }),
      probeAccount: async () => {
        probes += 1
        return { ok: true }
      },
    },
  )
  assert.equal(probes, 0)
  assert.equal(cap.calls[0].status, 200)
  assert.equal(cap.calls[0].body.unit, 'percent_used')
  assert.equal(cap.calls[0].body.five_hour.utilization, 12)
  assert.equal(cap.calls[0].body.source, 'extra')
  assert.equal(cap.calls[0].body.account_id, undefined)
  assert.equal(cap.calls[0].body.vm_id, undefined)
})

test('empty Extra hops cached official usage once', async () => {
  let probes = 0
  const store = { unified: {} }
  const cache = createUsageCache({ jitter: false })
  const { listed, source } = await resolveUsageWindows({
    accountId: 'acc-1',
    accountQuota: {
      repo: { get: () => store },
      ingestOAuthUsage(_id, probe) {
        store.unified = {
          headers: {
            '5h': { utilization: (probe.five_hour.utilization || 0) / 100, status: 'active', reset: 'r5' },
            '7d': { utilization: (probe.seven_day.utilization || 0) / 100, status: 'ok', reset: 'r7' },
          },
        }
      },
    },
    usageCache: cache,
    probe: async () => {
      probes += 1
      return {
        ok: true,
        five_hour: { utilization: 21, resets_at: 'r5' },
        seven_day: { utilization: 40, resets_at: 'r7' },
      }
    },
  })
  assert.equal(probes, 1)
  assert.equal(source, 'oauth-usage')
  const view = buildUsageView(listed, source)
  assert.equal(view.five_hour.utilization, 21)
  const again = await resolveUsageWindows({
    accountId: 'acc-1',
    accountQuota: { repo: { get: () => store } },
    usageCache: cache,
    probe: async () => {
      probes += 1
      return { ok: true }
    },
  })
  assert.equal(probes, 1)
  assert.equal(again.source, 'extra')
})

test('missing count_tokens body is 400', async () => {
  const cap = jsonCapture()
  await handleUserCountTokens(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      readBody: async () => ({ model: 'claude-sonnet-5' }),
      cfg: { limits: { max_body_bytes: 1024 } },
    },
  )
  assert.equal(cap.calls[0].status, 400)
  assert.equal(cap.calls[0].body.error.code, 'missing_field')
})

function usageProject(t, vms) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-usage-pick-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  for (const vm of vms) fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  return root
}

const CLAUDE_UNIFIED = {
  headers: {
    '5h': { utilization: 0.2, status: 'active', reset: 'r5' },
    '7d': { utilization: 0.3, status: 'ok', reset: 'r7' },
  },
}

const CODEX_USAGE = {
  primary_used_percent: 40,
  primary_window_minutes: 300,
  secondary_used_percent: 10,
  secondary_window_minutes: 10080,
}

function usageDeps(root, overrides = {}) {
  const cap = jsonCapture()
  let peeks = 0
  return {
    cap,
    peeks: () => peeks,
    deps: {
      json: cap.json,
      requireAuth: () => true,
      projectRoot: root,
      accountQuota: { repo: { get: () => ({ unified: CLAUDE_UNIFIED }) } },
      getPoolScheduler: () => ({
        peekAccount: async () => {
          peeks += 1
          return { ok: false, code: 'no_eligible_accounts' }
        },
      }),
      probeAccount: async () => ({ ok: true }),
      ...overrides,
    },
  }
}

const tenantReq = (extra = {}) => ({
  url: '/v1/usage',
  headers: {},
  apiKeyKind: 'managed',
  apiKeyRecord: { id: 'k1', user_id: 'u1' },
  ...extra,
})
const tenantUsers = { users: { getById: () => ({ role: 'user' }) } }
const CODEX_VM = {
  owner_user_id: 'u1',
  platform: 'openai',
  family: 'codex',
  codex: { has_access: true, usage: CODEX_USAGE },
}

test('usage keeps the next Claude account and tags its platform', async (t) => {
  const root = usageProject(t, [{ id: 'vm-x', ...CODEX_VM }])
  const { cap, deps, peeks } = usageDeps(root, {
    apiKeyStore: tenantUsers,
    getPoolScheduler: () => ({
      peekAccount: async () => ({
        ok: true,
        accountId: 'acc-1',
        vmId: 'vm-c',
        vm: { claude: { mode: 'oauth' } },
        exec: {},
      }),
    }),
  })
  await handleUserUsage(tenantReq(), {}, deps)
  assert.equal(cap.calls[0].status, 200, JSON.stringify(cap.calls[0].body))
  assert.equal(cap.calls[0].body.platform, 'anthropic')
  assert.equal(cap.calls[0].body.five_hour.utilization, 20)
  assert.equal(peeks(), 0)
})

test('usage reads Codex windows when the caller has no Claude account', async (t) => {
  const root = usageProject(t, [
    { id: 'vm-x', ...CODEX_VM },
    { id: 'vm-x-other', ...CODEX_VM, owner_user_id: 'u2' },
  ])
  const { cap, deps, peeks } = usageDeps(root, { apiKeyStore: tenantUsers })
  await handleUserUsage(tenantReq(), {}, deps)
  const body = cap.calls[0].body
  assert.equal(cap.calls[0].status, 200, JSON.stringify(body))
  assert.equal(peeks(), 1)
  assert.equal(body.platform, 'openai')
  assert.equal(body.source, 'codex')
  assert.equal(body.five_hour.utilization, 40)
  assert.equal(body.seven_day.utilization, 10)
})

test('usage never reads another owner Codex slot', async (t) => {
  const root = usageProject(t, [{ id: 'vm-x-other', ...CODEX_VM, owner_user_id: 'u2' }])
  const { cap, deps } = usageDeps(root, { apiKeyStore: tenantUsers })
  await handleUserUsage(tenantReq(), {}, deps)
  assert.equal(cap.calls[0].status, 503)
})

test('usage platform filter picks one side and rejects unknown values', async (t) => {
  const root = usageProject(t, [{ id: 'vm-x', ...CODEX_VM }])
  const { cap, deps, peeks } = usageDeps(root, {
    apiKeyStore: tenantUsers,
    getPoolScheduler: () => ({
      peekAccount: async () => ({
        ok: true,
        accountId: 'acc-1',
        vmId: 'vm-c',
        vm: { claude: { mode: 'oauth' } },
        exec: {},
      }),
    }),
  })
  await handleUserUsage(tenantReq({ url: '/v1/usage?platform=openai' }), {}, deps)
  assert.equal(cap.calls[0].body.platform, 'openai')
  await handleUserUsage(tenantReq({ url: '/v1/usage?platform=claude' }), {}, deps)
  assert.equal(cap.calls[1].body.platform, 'anthropic')
  await handleUserUsage(tenantReq({ url: '/v1/usage?platform=gemini' }), {}, deps)
  assert.equal(cap.calls[2].status, 400)
  assert.equal(cap.calls[2].body.error.code, 'invalid_platform')
  assert.equal(peeks(), 0)
})
