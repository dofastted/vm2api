import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  countTokensEnabled,
  parseCountTokensBody,
  buildUsageView,
  handleUserCountTokens,
  handleUserUsage,
  resolveUsageWindows,
  sanitizeThirdPartyCountTokensBody,
} from '../../src/lib/protocol/user-count-tokens.mjs'
import { CRS_OFFICIAL_CLI_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'
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

test('count_tokens is off unless routing says exactly true', () => {
  assert.equal(countTokensEnabled(undefined), false)
  assert.equal(countTokensEnabled({}), false)
  assert.equal(countTokensEnabled({ compatibility: {} }), false)
  assert.equal(countTokensEnabled({ compatibility: { count_tokens: true } }), true)
  // Off for anything truthy-but-not-true, so a stray string in routing.json cannot
  // open a public endpoint by accident.
  for (const value of ['true', 1, {}, [], 'yes'])
    assert.equal(countTokensEnabled({ compatibility: { count_tokens: value } }), false)
})

test('routing patch requires count_tokens to be boolean', async () => {
  const { validatePersonaRoutingPatch } = await import('../../src/lib/admin/panel-api.mjs')
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { count_tokens: true } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { count_tokens: false } }), [])
  assert.match(JSON.stringify(validatePersonaRoutingPatch({ compatibility: { count_tokens: 'on' } })), /count_tokens/)
})

test('handleUserCountTokens applies getRoutingConfig to inboundBodyLimit', async () => {
  const cap = jsonCapture()
  let seenLimit = null
  await handleUserCountTokens(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      readBody: async (_req, limit) => {
        seenLimit = limit
        return { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }
      },
      cfg: { limits: { max_body_bytes: 64 * 1024 * 1024 } },
      getRoutingConfig: () => ({ failover: { max_request_mib: 12 } }),
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
      countTokensViaWorker: async () => ({ ok: true, status: 200, body: { input_tokens: 5 } }),
    },
  )
  assert.equal(seenLimit, 12 * 1024 * 1024)
  assert.equal(cap.calls[0].status, 200)
})

test('panel count-tokens route is gated by the switch, not removed', async () => {
  const { createPanelHandler } = await import('../../src/lib/admin/panel-routes.mjs')
  const call = async (routingConfig) => {
    let response
    const panel = createPanelHandler({
      cfg: { paths: { project: os.tmpdir() } },
      routingConfig,
      requireAuth(req) {
        req.panelUser = 'operator'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, body) {
        response = { status, body }
      },
    })
    await panel({ method: 'POST' }, {}, new URL('/api/panel/vms/vm-nope/count-tokens', 'http://localhost'))
    return response
  }
  // Switch off: the generic not_found the stub returned.
  const off = await call({})
  assert.equal(off.status, 404)
  assert.equal(off.body.error.code, 'not_found')
  // Switch on: past the gate and into the restored body, which is why the code is now
  // the route's own vm_not_found rather than the gate's not_found.
  const on = await call({ compatibility: { count_tokens: true } })
  assert.equal(on.status, 404)
  assert.equal(on.body.error.code, 'vm_not_found')
})

test('V7: third-party /v1/messages/count_tokens relocates system + role=system, rewrites tools to mcp__, strips max_tokens and client headers', async () => {
  const thirdPartyBody = {
    model: 'claude-sonnet-5-5',
    system: [{ type: 'text', text: 'You are OpenCode, a coding agent.' }],
    tools: [
      { name: 'fs_read', description: 'Read file', input_schema: { type: 'object', properties: {} } },
      { name: 'mcp_resource_list', description: 'List', input_schema: { type: 'object', properties: {} } },
      { name: 'mcp__srv__ok', description: 'OK', input_schema: { type: 'object', properties: {} } },
    ],
    messages: [
      { role: 'system', content: 'Follow OpenCode system rules.' },
      { role: 'user', content: 'Count my tokens' },
    ],
  }
  const spoofHeaders = {
    'user-agent': 'claude-cli/2.1.321 (external, cli)',
    'anthropic-beta': 'evil-custom-beta-2026',
    'x-claude-code-session-id': 'spoof-sess',
  }

  // Direct helper check
  const sanitized = sanitizeThirdPartyCountTokensBody(thirdPartyBody, { routing: {} })
  assert.equal('max_tokens' in sanitized, false)
  assert.deepEqual(
    sanitized.tools.map((t) => t.name),
    ['mcp__fs_read', 'mcp__resource_list', 'mcp__srv__ok'],
  )
  assert.equal(
    sanitized.messages.some((m) => m.role === 'system'),
    false,
  )
  assert.deepEqual(sanitized.system, [{ type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM }])
  assert.ok(JSON.stringify(sanitized.messages[0]).includes('coding agent'))
  assert.ok(JSON.stringify(sanitized.messages[0]).includes('system rules'))

  // End-to-end countTokensViaKernel (count_tokens_v1)
  const capKernel = jsonCapture()
  let seenKernel = null
  await handleUserCountTokens(
    { headers: spoofHeaders },
    {},
    {
      json: capKernel.json,
      requireAuth: () => true,
      readBody: async () => structuredClone(thirdPartyBody),
      cfg: { limits: { max_body_bytes: 1024 * 1024 } },
      getRoutingConfig: () => ({ compatibility: { count_tokens: true } }),
      stickyRouter: { extractPoolKey: () => null },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          vmId: 'vm-crag',
          accountId: 'acc-1',
          vm: { credential_mode: 'oauth' },
          workerStatus: { capabilities: ['count_tokens_v1'] },
          exec: { vmId: 'vm-crag' },
        }),
      }),
      countTokensViaKernel: async (_exec, args) => {
        seenKernel = args
        return { ok: true, status: 200, body: { input_tokens: 42 } }
      },
    },
  )
  assert.equal(capKernel.calls[0].status, 200)
  assert.equal(capKernel.calls[0].body.input_tokens, 42)
  assert.deepEqual(seenKernel.headers, {})
  assert.equal('max_tokens' in seenKernel.body, false)
  assert.deepEqual(
    seenKernel.body.tools.map((t) => t.name),
    ['mcp__fs_read', 'mcp__resource_list', 'mcp__srv__ok'],
  )
  assert.equal(
    seenKernel.body.messages.some((m) => m.role === 'system'),
    false,
  )

  // End-to-end countTokensViaWorker (setup-token)
  const capWorker = jsonCapture()
  let seenWorker = null
  await handleUserCountTokens(
    { headers: spoofHeaders },
    {},
    {
      json: capWorker.json,
      requireAuth: () => true,
      readBody: async () => structuredClone(thirdPartyBody),
      cfg: { limits: { max_body_bytes: 1024 * 1024 } },
      getRoutingConfig: () => ({ compatibility: { count_tokens: true } }),
      stickyRouter: { extractPoolKey: () => null },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          vmId: 'vm-st',
          accountId: 'acc-2',
          vm: { credential_mode: 'setup-token' },
          exec: { vmId: 'vm-st' },
        }),
      }),
      countTokensViaWorker: async (_exec, args) => {
        seenWorker = args
        return { ok: true, status: 200, body: { input_tokens: 19 } }
      },
    },
  )
  assert.equal(capWorker.calls[0].status, 200)
  assert.equal(seenWorker.headers['user-agent'], 'kin-inference/1.0')
  assert.doesNotMatch(String(seenWorker.headers['anthropic-beta'] || ''), /evil-custom-beta/)
  assert.equal('max_tokens' in seenWorker.body, false)
  assert.deepEqual(
    seenWorker.body.tools.map((t) => t.name),
    ['mcp__fs_read', 'mcp__resource_list', 'mcp__srv__ok'],
  )
})

test('V7: claude_code_only on /v1/messages/count_tokens rejects bare UA spoof and preserves genuine verified CC', async () => {
  const capSpoof = jsonCapture()
  await handleUserCountTokens(
    { headers: { 'user-agent': 'claude-cli/2.1.321 (external, cli)', 'anthropic-beta': 'claude-code-20250219' } },
    {},
    {
      json: capSpoof.json,
      requireAuth: () => true,
      readBody: async () => ({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] }),
      cfg: { limits: { max_body_bytes: 1024 * 1024 } },
      getRoutingConfig: () => ({ compatibility: { count_tokens: true, claude_code_only: true } }),
    },
  )
  assert.equal(capSpoof.calls[0].status, 403)
  assert.equal(capSpoof.calls[0].body.error.code, 'claude_code_only')

  // Genuine verified official CC passes claude_code_only and keeps official tools untouched
  const sessionId = '11111111-1111-4111-8111-111111111111'
  const capOfficial = jsonCapture()
  let seenOfficial = null
  await handleUserCountTokens(
    {
      headers: {
        'user-agent': 'claude-cli/2.1.321 (external, cli)',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'anthropic-beta': 'claude-code-20250219',
        'x-app': 'cli',
        'x-stainless-lang': 'js',
        'x-stainless-os': 'Linux',
        'x-stainless-arch': 'x64',
        'x-stainless-runtime': 'node',
        'x-stainless-runtime-version': 'v24.3.0',
        'x-stainless-package-version': '0.128.0',
        'x-stainless-retry-count': '0',
        'x-stainless-timeout': '600',
        'x-claude-code-session-id': sessionId,
      },
    },
    {},
    {
      json: capOfficial.json,
      requireAuth: () => true,
      readBody: async () => ({
        model: 'claude-sonnet-5-5',
        system: [{ type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM }],
        tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
      cfg: { limits: { max_body_bytes: 1024 * 1024 } },
      getRoutingConfig: () => ({ compatibility: { count_tokens: true, claude_code_only: true } }),
      stickyRouter: { extractPoolKey: () => null },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          vmId: 'vm-crag',
          accountId: 'acc-1',
          vm: { credential_mode: 'oauth' },
          workerStatus: { capabilities: ['count_tokens_v1'] },
          exec: { vmId: 'vm-crag' },
        }),
      }),
      countTokensViaKernel: async (_exec, args) => {
        seenOfficial = args
        return { ok: true, status: 200, body: { input_tokens: 7 } }
      },
    },
  )
  assert.equal(capOfficial.calls[0].status, 200)
  assert.deepEqual(
    seenOfficial.body.tools.map((t) => t.name),
    ['Bash'],
  )
})
