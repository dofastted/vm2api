import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAntigravityUpstream } from '../../scripts/antigravity-upstream.mjs'
import { startAntigravityBridge } from '../../scripts/antigravity-bridge.mjs'
import { fetchAntigravityQuota } from '../../src/lib/transport/antigravity-bridge-supervisor.mjs'
import {
  normalizeAntigravityQuotaSummary,
  readAntigravityQuota,
  refreshAntigravityQuota,
} from '../../src/lib/oauth/antigravity-quota.mjs'

const summary = {
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-10-29T00:00:00Z' },
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.88 },
      ],
    },
  ],
}
const vm = { id: 'vm-ag', platform: 'antigravity', family: 'antigravity', owner_user_id: 'u1' }

function slotRoot(t, updatedAt = 'auth-1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-quota-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const run = path.join(root, 'vms', vm.id, 'run')
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(
    path.join(run, 'antigravity-auth.json'),
    JSON.stringify({ authenticated: true, updated_at: updatedAt }),
  )
  return root
}

test('quota summary refreshes an expired token once and falls back to prod when daily sheds load', async () => {
  let token = 'old'
  const calls = []
  const provider = createAntigravityUpstream(
    {},
    {
      readToken: () => ({ access_token: token, expiry: '2999-01-01T00:00:00Z' }),
      refresh: async () => {
        token = 'new'
      },
      fetch: async (url, options) => {
        calls.push([new URL(url).host, options.headers.authorization, options.body])
        if (options.headers.authorization === 'Bearer old') return new Response('', { status: 401 })
        if (url.startsWith('https://daily-cloudcode-pa.')) return new Response('', { status: 429 })
        if (url.startsWith('https://www.googleapis.com/')) return Response.json({ email: 'owner@example.com' })
        return Response.json(summary)
      },
    },
  )
  assert.deepEqual(await provider.quota(), { ok: true, summary, email: 'owner@example.com' })
  assert.deepEqual(calls, [
    ['daily-cloudcode-pa.googleapis.com', 'Bearer old', '{}'],
    ['daily-cloudcode-pa.googleapis.com', 'Bearer new', '{}'],
    ['cloudcode-pa.googleapis.com', 'Bearer new', '{}'],
    ['www.googleapis.com', 'Bearer new', undefined],
  ])
})

test('quota summary still succeeds when the account email cannot be read', async () => {
  const provider = createAntigravityUpstream(
    {},
    {
      readToken: () => ({ access_token: 't', expiry: '2999-01-01T00:00:00Z' }),
      fetch: async (url) =>
        url.startsWith('https://www.googleapis.com/') ? new Response('', { status: 403 }) : Response.json(summary),
    },
  )
  assert.deepEqual(await provider.quota(), { ok: true, summary, email: null })
})

test('refresh records the account email on the slot for the card to show', async (t) => {
  const root = slotRoot(t)
  const record = path.join(root, 'vms', `${vm.id}.json`)
  fs.writeFileSync(record, JSON.stringify({ ...vm, antigravity: {} }))
  const read = () => JSON.parse(fs.readFileSync(record, 'utf8'))
  const ok = await refreshAntigravityQuota({
    projectRoot: root,
    vm,
    ops: { fetchQuota: async () => ({ ok: true, summary, email: 'owner@example.com' }), getVm: read },
  })
  assert.equal(ok.ok, true)
  assert.equal(read().antigravity.email, 'owner@example.com')
  await refreshAntigravityQuota({
    projectRoot: root,
    vm,
    ops: { fetchQuota: async () => ({ ok: true, summary, email: null }), getVm: read },
  })
  assert.equal(read().antigravity.email, 'owner@example.com')
})

test('quota summary reports rejection without leaking upstream bodies', async () => {
  const provider = createAntigravityUpstream(
    {},
    {
      readToken: () => ({ access_token: 't', expiry: '2999-01-01T00:00:00Z' }),
      fetch: async () => new Response('secret detail', { status: 403 }),
    },
  )
  const result = await provider.quota()
  assert.equal(result.ok, false)
  assert.equal(result.status, 403)
  assert.equal(result.code, 'antigravity_upstream_error')
  assert.doesNotMatch(JSON.stringify(result), /secret detail/)
})

test('bridge serves the raw summary over the authenticated slot socket', async (t) => {
  const root = slotRoot(t)
  const run = path.join(root, 'vms', vm.id, 'run')
  fs.writeFileSync(path.join(run, 'antigravity.token'), 'internal-only')
  const bridge = await startAntigravityBridge(
    { socket_path: path.join(run, 'antigravity.sock'), internal_token: 'internal-only' },
    { pool: { size: 0, close() {} }, upstream: { close() {}, quota: async () => ({ ok: true, summary }) } },
  )
  t.after(() => bridge.close())
  const result = await fetchAntigravityQuota({
    projectRoot: root,
    vm,
    ops: { ensureBridge: async () => ({ ok: true }) },
  })
  assert.deepEqual(result, { ok: true, summary })
})

test('normalization clamps fractions, drops unusable buckets and keeps ungrouped ones', () => {
  const quota = normalizeAntigravityQuotaSummary({
    groups: [
      {
        displayName: 'Claude and GPT models',
        buckets: [{ bucketId: '3p-5h', remainingFraction: 1.5 }, { window: '5h' }],
      },
      { displayName: 'Empty', buckets: [] },
    ],
    buckets: [
      { bucketId: '3p-5h', remainingFraction: 0.2 },
      { bucketId: 'argon-weekly', displayName: 'Gemini 4 Argon Weekly Limit', remainingAmount: '12', resetTime: 'bad' },
    ],
  })
  assert.deepEqual(
    quota.groups.map((group) => [
      group.name,
      group.buckets.map((b) => [b.id, b.remaining, b.remaining_amount, b.reset_at]),
    ]),
    [
      ['Claude and GPT models', [['3p-5h', 1, null, null]]],
      [null, [['argon-weekly', null, 12, null]]],
    ],
  )
  assert.equal(normalizeAntigravityQuotaSummary({ groups: [] }), null)
  assert.equal(normalizeAntigravityQuotaSummary([]), null)
})

test('refresh keeps the last good balance on failure and hides it after the account changes', async (t) => {
  const root = slotRoot(t)
  const ok = await refreshAntigravityQuota({
    projectRoot: root,
    vm,
    ops: { fetchQuota: async () => ({ ok: true, summary }) },
  })
  assert.equal(ok.ok, true)
  assert.equal(readAntigravityQuota(root, vm).groups[0].buckets[1].remaining, 0.88)

  const failed = await refreshAntigravityQuota({
    projectRoot: root,
    vm,
    ops: { fetchQuota: async () => ({ ok: false, status: 503, code: 'antigravity_slot_unavailable', message: 'x' }) },
  })
  assert.equal(failed.ok, false)
  const stale = readAntigravityQuota(root, vm)
  assert.equal(stale.updated_at, ok.updated_at)
  assert.equal(stale.groups.length, 1)
  assert.equal(stale.error.code, 'antigravity_slot_unavailable')

  assert.equal(readAntigravityQuota(root, { ...vm, owner_user_id: 'u2' }), null)
  fs.writeFileSync(
    path.join(root, 'vms', vm.id, 'run', 'antigravity-auth.json'),
    JSON.stringify({ authenticated: true, updated_at: 'auth-2' }),
  )
  assert.equal(readAntigravityQuota(root, vm), null)
})

test('refresh refuses unauthorized slots before touching the runtime', async (t) => {
  const root = slotRoot(t)
  fs.writeFileSync(
    path.join(root, 'vms', vm.id, 'run', 'antigravity-auth.json'),
    JSON.stringify({ authenticated: false }),
  )
  const result = await refreshAntigravityQuota({
    projectRoot: root,
    vm,
    ops: { fetchQuota: () => assert.fail('runtime must not run') },
  })
  assert.equal(result.code, 'antigravity_official_login_required')
})
