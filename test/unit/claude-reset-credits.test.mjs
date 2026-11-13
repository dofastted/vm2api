import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canClaudeResetCredits } from '../../src/lib/oauth/credential-mode.mjs'
import test from 'node:test'
import { buildClaudeResetQuery, buildClaudeResetRedeem } from '../../src/lib/admin/panel-api.mjs'
import {
  claudeResetCardRef,
  claudeResetGrantKind,
  claudeResetOperationId,
  claudeResetOrgId,
  parseClaudeResetStatus,
  projectClaudeResetCredits,
  queryClaudeResetCredits,
  redeemClaudeResetCredit,
  resetClaudeResetLeasesForTest,
} from '../../src/lib/oauth/claude-reset-credits.mjs'

const ORG = '11111111-1111-4111-8111-111111111111'
const NOW = Date.parse('2026-09-25T00:00:00Z')
const REDEEMABLE = {
  cedar_ember: {
    eligible: true,
    at_limit: true,
    next_grant_id: 'grant_next',
    grants: [
      {
        id: 'grant_other',
        resets_left: 1,
        usable_now: true,
        use_requires_limit: false,
        clears: ['five_hour'],
      },
      {
        id: 'grant_next',
        resets_left: 2,
        usable_now: true,
        use_requires_limit: true,
        clears: ['five_hour', 'seven_day'],
      },
    ],
  },
}

function rootDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-claude-reset-'))
}

function writeVm(root, id = 'vm-1') {
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      platform: 'anthropic',
      family: 'claude',
      claude: { mode: 'oauth', scope: 'user:profile user:inference' },
    }),
  )
  return id
}

function scripted({
  status = REDEEMABLE,
  claim = { result: 'reset', cleared: ['five_hour', 'seven_day'] },
  claimStatus = 200,
  onRedeem,
} = {}) {
  const posts = []
  const transport = async (_exec, op, opts = {}) => {
    if (op === 'profile') return { ok: true, status: 200, body: { organization: { uuid: ORG } } }
    if (op === 'reset-status') return { ok: true, status: 200, body: status }
    if (op === 'reset-redeem') {
      posts.push(opts.body)
      if (onRedeem) await onRedeem()
      if (claimStatus === 0) return { ok: false, status: 0, transportError: true, body: null }
      const body = typeof claim === 'string' ? claim : claim
      return { ok: claimStatus >= 200 && claimStatus < 300, status: claimStatus, body }
    }
    throw new Error(`unexpected ${op}`)
  }
  return { transport, posts }
}

test.beforeEach(() => {
  resetClaudeResetLeasesForTest()
})

test('query projects every held grant with an opaque card ref and hides grant ids', async () => {
  const root = rootDir()
  writeVm(root)
  const status = {
    cedar_ember: {
      eligible: true,
      at_limit: false,
      next_grant_id: 'launch',
      grants: [
        {
          id: 'launch',
          resets_left: 2,
          usable_now: true,
          use_requires_limit: false,
          ends_at: '2026-10-22T00:00:00Z',
          clears: ['five_hour'],
          percent_used: { five_hour: 65 },
          blocking: [],
        },
        { id: 'later', clears: ['five_hour'], resets_left: 1, usable_now: true, use_requires_limit: false },
      ],
    },
  }
  let calls = 0
  const result = await queryClaudeResetCredits({
    projectRoot: root,
    vmId: 'vm-1',
    now: () => NOW,
    transport: async () => {
      calls += 1
      return { ok: true, status: 200, body: status }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(calls, 1)
  const view = result.claude_reset_credits
  assert.equal(view.available_count, 3)
  assert.equal(view.held_count, 3)
  assert.deepEqual(
    view.credits.map((credit) => [credit.redeemable, credit.state, credit.kind]),
    [
      [true, 'ready', 'session'],
      [true, 'ready', 'session'],
    ],
  )
  assert.equal(view.credits[0].ref, claudeResetCardRef('vm-1', 'launch'))
  assert.equal(view.credits[1].ref, claudeResetCardRef('vm-1', 'later'))
  assert.match(view.credits[0].ref, /^[a-f0-9]{24}$/)
  assert.notEqual(view.credits[0].ref, claudeResetCardRef('vm-2', 'launch'))
  const raw = JSON.stringify(result)
  for (const secret of ['"id"', 'launch', 'later', 'synthetic-token']) assert.equal(raw.includes(secret), false)
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-1.json'), 'utf8'))
  assert.equal(JSON.stringify(saved.claude_reset_credits).includes('launch'), false)
  assert.equal(saved.claude_reset_credits.held_count, 3)
  assert.equal(saved.claude_reset_credits.credits[0].ref, view.credits[0].ref)
  assert.equal(saved.claude_reset_credits.credits[0].state, 'ready')
})

test('Fable resets and full resets are told apart', () => {
  const fable = {
    id: 'fable_launch',
    label: 'New model launch: one Fable reset for Pro and Team Standard, launch week only',
    resets_left: 1,
    usable_now: true,
    use_requires_limit: false,
    gives_back_weekly: true,
    ends_at: '2026-11-17T07:59:00Z',
    clears: ['five_hour', 'seven_day_overage_included'],
  }
  const full = {
    id: 'full_nov',
    label: 'One full limit reset (November 2026)',
    resets_left: 1,
    usable_now: true,
    use_requires_limit: false,
    ends_at: '2026-12-10T22:00:00Z',
    clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
  }
  const view = projectClaudeResetCredits(
    { eligible: true, next_grant_id: 'fable_launch', grants: [full, fable] },
    Date.parse('2026-11-13T07:00:00Z'),
    'vm-1',
  )
  assert.deepEqual(
    view.credits.map((credit) => [credit.kind, credit.state, credit.gives_back_weekly]),
    [
      ['fable', 'ready', true],
      ['full', 'ready', false],
    ],
  )
  assert.equal(view.available_count, 2)
  const { gives_back_weekly: _omit, ...plain } = fable
  assert.equal(claudeResetGrantKind(plain), 'fable')
  assert.equal(claudeResetGrantKind({ type: 'full', clears: ['five_hour', 'seven_day_overage_included'] }), 'fable')
  assert.equal(claudeResetGrantKind({ clears: ['five_hour'] }), 'session')
  assert.equal(claudeResetGrantKind({ clears: ['seven_day'] }), 'weekly')
  assert.equal(claudeResetGrantKind({ clears: ['five_hour', 'seven_day'] }), 'full')
  assert.equal(claudeResetGrantKind({ type: 'weekly', clears: ['five_hour', 'seven_day'] }), 'weekly')
  assert.equal(claudeResetGrantKind({ gives_back_weekly: true, clears: [] }), 'fable')
})

test('a cooldown keeps held cards visible and unusable cards are counted apart', () => {
  const now = Date.parse('2026-11-13T07:00:00Z')
  const card = (id, extra = {}) => ({
    id,
    resets_left: 1,
    usable_now: true,
    use_requires_limit: false,
    clears: ['five_hour', 'seven_day'],
    ...extra,
  })
  const cooling = projectClaudeResetCredits(
    {
      eligible: true,
      cooldown_until: new Date(now + 120_000).toISOString(),
      grants: [card('a', { usable_now: false }), card('b', { usable_now: false, blocking: ['seven_day'] })],
    },
    now,
    'vm-1',
  )
  assert.deepEqual(
    cooling.credits.map((credit) => credit.state),
    ['cooldown', 'unavailable'],
  )
  assert.equal(cooling.available_count, 0)
  assert.equal(cooling.held_count, 1)
  const withheld = projectClaudeResetCredits(
    { eligible: true, grants: [card('a'), card('b', { usable_now: false })] },
    now,
    'vm-1',
  )
  assert.deepEqual(
    withheld.credits.map((credit) => credit.state),
    ['ready', 'unavailable'],
  )
  assert.equal(withheld.available_count, 1)
  assert.equal(withheld.held_count, 1)
})

test('past cooldown is cleared and a future cooldown blocks', () => {
  const now = Date.now()
  const past = new Date(now - 60_000).toISOString()
  const future = new Date(now + 3_600_000).toISOString()
  const grant = { id: 'grant', resets_left: 1, usable_now: true, use_requires_limit: false, clears: ['five_hour'] }
  let view = projectClaudeResetCredits(
    { eligible: true, next_grant_id: 'grant', cooldown_until: past, grants: [grant] },
    now,
  )
  assert.equal(view.cooldown_until, undefined)
  assert.equal(view.available_count, 1)
  view = projectClaudeResetCredits(
    { eligible: true, next_grant_id: 'grant', cooldown_until: future, grants: [grant] },
    now,
  )
  assert.equal(view.available_count, 0)
  assert.ok(view.cooldown_until)
})

test('eligibility fails closed', () => {
  const now = Date.now()
  const past = new Date(now - 60_000).toISOString()
  const future = new Date(now + 3_600_000).toISOString()
  const base = { id: 'grant', resets_left: 1, usable_now: true, use_requires_limit: false, clears: ['five_hour'] }
  const cases = {
    paused: { grant: { paused: true } },
    expired: { grant: { ends_at: past } },
    future: { grant: { starts_at: future } },
    cooldown: { block: { cooldown_until: future } },
    'requires-limit': { grant: { use_requires_limit: undefined } },
    blocking: { grant: { blocking: ['seven_day'] } },
    ineligible: { block: { eligible: false } },
    spent: { grant: { resets_left: 0 } },
  }
  for (const [name, patch] of Object.entries(cases)) {
    const grant = { ...base, ...patch.grant }
    if (name === 'requires-limit') delete grant.use_requires_limit
    const block = { eligible: true, next_grant_id: grant.id, grants: [grant], ...patch.block }
    assert.equal(projectClaudeResetCredits(block, now).available_count, 0, name)
  }
  const other = { eligible: true, next_grant_id: 'other', grants: [base] }
  assert.equal(projectClaudeResetCredits(other, now).available_count, 1, 'a held card need not be the next grant')
})

test('missing profile scope does not call the worker', async () => {
  const root = rootDir()
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-1.json'),
    JSON.stringify({ id: 'vm-1', platform: 'anthropic', claude: { mode: 'oauth', scope: 'user:inference' } }),
  )
  const result = await queryClaudeResetCredits({
    projectRoot: root,
    vmId: 'vm-1',
    transport: async () => {
      throw new Error('network')
    },
  })
  assert.equal(result.error, 'CLAUDE_RESET_PROFILE_SCOPE_REQUIRED')
})

test('setup-token label with user:profile still queries', async () => {
  const root = rootDir()
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-03.json'),
    JSON.stringify({
      id: 'vm-03',
      platform: 'anthropic',
      claude: { mode: 'setup-token', has_access: true, scope: 'user:profile user:inference' },
    }),
  )
  let calls = 0
  const result = await queryClaudeResetCredits({
    projectRoot: root,
    vmId: 'vm-03',
    transport: async () => {
      calls += 1
      return { ok: true, status: 200, body: { cedar_ember: null } }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(calls, 1)
  assert.equal(result.claude_reset_credits.available_count, 0)
  assert.equal(
    canClaudeResetCredits({
      platform: 'anthropic',
      claude: { mode: 'setup-token', has_access: true, scope: 'user:profile user:inference' },
    }),
    true,
  )
  assert.equal(
    canClaudeResetCredits({
      platform: 'anthropic',
      claude: { mode: 'setup-token', has_access: true, scope: 'user:inference' },
    }),
    false,
  )
})

test('malformed or absent cedar blocks', () => {
  for (const body of [{}, { five_hour: {}, cedar_ember: null }]) {
    const parsed = parseClaudeResetStatus(body)
    assert.equal(parsed.block, null)
    assert.equal(parsed.error, undefined)
  }
  for (const body of [{ cedar_ember: { eligible: true } }, { error: { message: 'private upstream data' } }, null]) {
    const parsed = parseClaudeResetStatus(body)
    assert.equal(parsed.error, 'invalid')
    assert.equal(JSON.stringify(parsed).includes('private upstream data'), false)
  }
})

test('redeem lets the server pick the next grant and hides ids', async () => {
  const root = rootDir()
  writeVm(root)
  const { transport, posts } = scripted()
  const result = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    idempotencyKey: 'op-1',
    now: () => NOW,
    transport,
  })
  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'reset')
  assert.equal(result.replayed, false)
  assert.deepEqual(result.cleared, ['five_hour', 'seven_day'])
  assert.equal(posts.length, 1)
  assert.equal(posts[0].grant_id, 'grant_next')
  assert.equal(posts[0].organization_uuid, ORG)
  const raw = JSON.stringify(result)
  for (const secret of ['grant_next', 'grant_other', ORG, posts[0].request_id, '"id"']) {
    assert.equal(raw.includes(secret), false, secret)
  }
})

test('redeem spends the chosen card instead of the next grant', async () => {
  const root = rootDir()
  writeVm(root)
  const { transport, posts } = scripted({ claim: { result: 'reset', cleared: ['five_hour'] } })
  const result = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    idempotencyKey: 'op-card',
    card: claudeResetCardRef('vm-1', 'grant_other'),
    now: () => NOW,
    transport,
  })
  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'reset')
  assert.equal(result.kind, 'session')
  assert.equal(posts.length, 1)
  assert.equal(posts[0].grant_id, 'grant_other')
  assert.equal(JSON.stringify(result).includes('grant_other'), false)
  const again = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    idempotencyKey: 'op-card',
    card: claudeResetCardRef('vm-1', 'grant_other'),
    transport,
  })
  assert.equal(again.replayed, true)
  assert.equal(again.kind, 'session')
  assert.equal(posts.length, 1)
})

test('a chosen card that cannot be used sends no claim', async () => {
  const withheld = {
    cedar_ember: {
      ...REDEEMABLE.cedar_ember,
      grants: [{ ...REDEEMABLE.cedar_ember.grants[0], usable_now: false }, REDEEMABLE.cedar_ember.grants[1]],
    },
  }
  const cases = [
    ['not usable now', withheld, claudeResetCardRef('vm-1', 'grant_other')],
    ['unknown card', REDEEMABLE, claudeResetCardRef('vm-1', 'gone')],
    ['card of another slot', REDEEMABLE, claudeResetCardRef('vm-2', 'grant_other')],
  ]
  for (const [name, status, card] of cases) {
    resetClaudeResetLeasesForTest()
    const root = rootDir()
    writeVm(root)
    const { transport, posts } = scripted({ status })
    const result = await redeemClaudeResetCredit({
      projectRoot: root,
      vmId: 'vm-1',
      idempotencyKey: 'op-1',
      card,
      transport,
    })
    assert.equal(result.error, 'CLAUDE_RESET_NOT_AVAILABLE', name)
    assert.equal(posts.length, 0, name)
  }
  for (const card of ['grant_other', 'ABCDEF0123456789abcdef01', 42, { ref: 'x' }]) {
    let calls = 0
    const root = rootDir()
    writeVm(root)
    const result = await redeemClaudeResetCredit({
      projectRoot: root,
      vmId: 'vm-1',
      idempotencyKey: 'op-1',
      card,
      transport: async () => {
        calls += 1
        return { ok: true, status: 200, body: REDEEMABLE }
      },
    })
    assert.equal(result.error, 'CLAUDE_RESET_CARD_INVALID', String(card))
    assert.equal(calls, 0)
  }
  const routed = await buildClaudeResetRedeem({
    cfg: { paths: { project: rootDir() } },
    id: 'vm-1',
    idempotencyKey: 'op-1',
    card: 'nope',
  })
  assert.equal(routed.status, 400)
})

test('a non-redeemable status sends no claim', async () => {
  const future = new Date(Date.now() + 3_600_000).toISOString()
  const cases = [
    ['not at limit', { ...REDEEMABLE, cedar_ember: { ...REDEEMABLE.cedar_ember, at_limit: false } }],
    ['ineligible', { ...REDEEMABLE, cedar_ember: { ...REDEEMABLE.cedar_ember, eligible: false } }],
    ['cooldown', { ...REDEEMABLE, cedar_ember: { ...REDEEMABLE.cedar_ember, cooldown_until: future } }],
    ['no next grant', { ...REDEEMABLE, cedar_ember: { ...REDEEMABLE.cedar_ember, next_grant_id: 'missing' } }],
    ['absent', { cedar_ember: null }],
  ]
  for (const [name, status] of cases) {
    resetClaudeResetLeasesForTest()
    const root = rootDir()
    writeVm(root)
    const { transport, posts } = scripted({ status })
    const result = await redeemClaudeResetCredit({
      projectRoot: root,
      vmId: 'vm-1',
      idempotencyKey: 'op-1',
      transport,
    })
    assert.equal(result.error, 'CLAUDE_RESET_NOT_AVAILABLE', name)
    assert.equal(posts.length, 0, name)
  }
})

test('redeem requires an idempotency key', async () => {
  const root = rootDir()
  writeVm(root)
  const { transport, posts } = scripted()
  const missing = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', transport })
  assert.equal(missing.error, 'IDEMPOTENCY_KEY_REQUIRED')
  const blank = await buildClaudeResetRedeem({
    cfg: { paths: { project: root } },
    id: 'vm-1',
    idempotencyKey: '   ',
    transport,
  })
  assert.equal(blank.status, 400)
  assert.equal(posts.length, 0)
})

test('the same key replays and a new key gets a new request id', async () => {
  const root = rootDir()
  writeVm(root)
  const { transport, posts } = scripted()
  const first = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-1', transport })
  const again = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-1', transport })
  assert.equal(again.replayed, true)
  assert.equal(again.outcome, first.outcome)
  assert.equal(posts.length, 1)
  const second = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-2', transport })
  assert.equal(second.ok, true)
  assert.equal(posts.length, 2)
  assert.notEqual(posts[0].request_id, posts[1].request_id)
})

test('two accounts of one organization cannot claim together', async () => {
  const root = rootDir()
  writeVm(root, 'vm-1')
  writeVm(root, 'vm-2')
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let entered = 0
  const { transport, posts } = scripted({
    onRedeem: () => {
      entered += 1
      return gate
    },
  })
  const first = redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'account-one', transport })
  while (entered < 1) await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-2',
    idempotencyKey: 'account-two',
    transport,
  })
  assert.equal(second.error, 'CLAUDE_RESET_BUSY')
  release()
  const done = await first
  assert.equal(done.outcome, 'reset')
  assert.equal(posts.length, 1)
})

test('an unknown claim fences the organization', async () => {
  const claims = [
    { claimStatus: 0, claim: null },
    { claim: 'not-json', claimStatus: 200 },
    { claim: { result: 'weird' } },
    { claim: { result: 'unavailable', reason: 'stamp_indeterminate' } },
    { claim: { result: 'reset', reason: 'reset_unconfirmed' } },
    { claim: { result: 'reset' }, claimStatus: 500 },
  ]
  for (const spec of claims) {
    resetClaudeResetLeasesForTest()
    const root = rootDir()
    writeVm(root, 'vm-1')
    writeVm(root, 'vm-2')
    const { transport, posts } = scripted(spec)
    const out = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-1', transport })
    assert.equal(out.outcome, 'unknown')
    assert.equal(out.claude_reset_credits, undefined)
    assert.equal(String(out.reason || '').includes('private'), false)
    const again = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-1', transport })
    assert.equal(again.replayed, true)
    resetClaudeResetLeasesForTest()
    for (const id of ['vm-1', 'vm-2']) {
      const blocked = await redeemClaudeResetCredit({
        projectRoot: root,
        vmId: id,
        idempotencyKey: 'op-new',
        transport,
      })
      assert.equal(blocked.error, 'CLAUDE_RESET_UNRESOLVED')
    }
    assert.equal(posts.length, 1)
    const laterNow = () => Date.now() + 24 * 60 * 60 * 1000 + 60_000
    const later = await redeemClaudeResetCredit({
      projectRoot: root,
      vmId: 'vm-1',
      idempotencyKey: 'op-later',
      now: laterNow,
      transport: scripted().transport,
    })
    assert.equal(later.outcome, 'reset')
  }
})

test('a crashed claim never resends the same confirmation', async () => {
  const root = rootDir()
  writeVm(root)
  const operation = claudeResetOperationId('vm-1', 'op-1')
  const orgKey = claudeResetOrgId(ORG)
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'data', 'claude-reset-state.json'),
    JSON.stringify({
      operations: {},
      fences: {
        [orgKey]: { operation, outcome: 'unknown', reason: 'claim_unconfirmed', at: new Date().toISOString() },
      },
    }),
  )
  const { transport, posts } = scripted()
  const out = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-1', transport })
  assert.equal(out.outcome, 'unknown')
  assert.equal(out.replayed, true)
  assert.equal(posts.length, 0)
})

test('upstream results map and definite outcomes do not fence', async () => {
  const cases = [
    [{ result: 'reset' }, 'reset', 200],
    [{ result: 'already_used' }, 'already_used', 200],
    [{ result: 'not_limited' }, 'not_limited', 200],
    [{ result: 'cooldown', cooldown_until: '2099-01-01T00:00:00Z' }, 'cooldown', 200],
    [{ result: 'ineligible', reason: 'tenure' }, 'ineligible', 200],
    [{ result: 'reset' }, 'ineligible', 403],
  ]
  for (const [claim, outcome, claimStatus] of cases) {
    resetClaudeResetLeasesForTest()
    const root = rootDir()
    writeVm(root)
    const { transport, posts } = scripted({ claim, claimStatus })
    const out = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-1', transport })
    assert.equal(out.outcome, outcome)
    if (outcome === 'cooldown') assert.ok(out.cooldown_until)
    if (outcome === 'ineligible' && claimStatus === 200) assert.equal(out.reason, 'tenure')
    const again = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-2', transport })
    assert.equal(again.ok, true, outcome)
    assert.equal(posts.length, 2, outcome)
  }
})

test('unknown upstream reasons and windows are dropped', async () => {
  const root = rootDir()
  writeVm(root)
  const { transport } = scripted({
    claim: {
      result: 'ineligible',
      reason: 'Bearer synthetic-token leaked <script>',
      cleared: ['five_hour', '<bad>'],
    },
  })
  const out = await redeemClaudeResetCredit({ projectRoot: root, vmId: 'vm-1', idempotencyKey: 'op-1', transport })
  assert.equal(out.reason, undefined)
  assert.deepEqual(out.cleared, ['five_hour'])
})

test('explicit unavailable fences briefly', async () => {
  const root = rootDir()
  writeVm(root, 'vm-1')
  writeVm(root, 'vm-2')
  let clock = Date.now()
  const { transport, posts } = scripted({ claim: { result: 'unavailable', reason: 'grant_next' } })
  const out = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    idempotencyKey: 'op-1',
    now: () => clock,
    transport,
  })
  assert.equal(out.outcome, 'unknown')
  assert.equal(out.reason, 'upstream_unavailable')
  resetClaudeResetLeasesForTest()
  const blocked = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-2',
    idempotencyKey: 'op-new',
    now: () => clock,
    transport,
  })
  assert.equal(blocked.error, 'CLAUDE_RESET_UPSTREAM_UNAVAILABLE')
  assert.equal(posts.length, 1)
  clock += 15 * 60 * 1000 + 60_000
  const later = await redeemClaudeResetCredit({
    projectRoot: root,
    vmId: 'vm-1',
    idempotencyKey: 'op-later',
    now: () => clock,
    transport: scripted().transport,
  })
  assert.equal(later.outcome, 'reset')
})

test('panel query route returns the public snapshot', async () => {
  const root = rootDir()
  writeVm(root)
  const result = await buildClaudeResetQuery({
    cfg: { paths: { project: root } },
    id: 'vm-1',
    now: () => NOW,
    transport: scripted().transport,
  })
  assert.equal(result.ok, true)
  assert.equal(result.data.claude_reset_credits.available_count, 3)
  assert.equal(result.data.claude_reset_credits.held_count, 3)
  assert.equal(JSON.stringify(result).includes('grant_next'), false)
})
