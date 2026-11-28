/**
 * M3 parity: failover.keep_session_home against the real Rust `kin-scheduler`.
 *
 * 238 (FailoverRunner isHome / retryOrStay / waitHomeSlot / homeSlotRefused /
 * keptHome): a conversation that already had a session pin stays on the node
 * its first attempt ran on. A failed attempt retries there or returns its
 * error with session_home_kept; slot_busy waits for the home kernel; with
 * x-kin-queue off it answers 529 session_home_slot_busy. 243 dropped all of it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { createSchedulerRuntime } from '../../src/lib/scheduler/scheduler-runtime.mjs'

function resolveSchedulerBin() {
  const candidates = [
    process.env.KIN_SCHEDULER_BIN,
    '/tmp/vm2api-sched-m3-target/release/kin-scheduler',
    path.resolve(process.cwd(), 'bin/kin-scheduler'),
    path.resolve(process.cwd(), 'scheduler/target/release/kin-scheduler'),
    path.resolve(process.cwd(), 'scheduler/target/debug/kin-scheduler'),
  ].filter(Boolean)
  for (const p of candidates) if (fs.existsSync(p)) return p
  throw new Error(`kin-scheduler binary not found in candidates: ${candidates.join(', ')}`)
}

const BIN_PATH = resolveSchedulerBin()

function claudeVm(id, tier, priority) {
  return {
    id,
    name: id,
    kind: 'claude',
    status: 'running',
    schedulable: true,
    claude: { account_uuid: `acct-${id}`, account_tier: tier, account_tier_source: 'profile' },
    policy: { priority, weight: 10, max_concurrency: 4, session_slots: 4 },
  }
}

function setup(t, { vms, routing, accounts = {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-m3-home-'))
  const db = createDatabase({ dbPath: path.join(tmp, 'kin.db') })
  const state = { vms, routing }
  const accountQuota = {
    repo: { get: (id) => accounts[id] || null, list: () => Object.values(accounts) },
    snapshot: () => ({ accounts: Object.values(accounts) }),
  }
  const runtime = createSchedulerRuntime({
    getDb: () => db,
    getVms: () => state.vms,
    getRoutingConfig: () => state.routing,
    accountQuota,
    telemetryIntervalMs: 0,
    clientOptions: {
      binPath: BIN_PATH,
      dataDir: tmp,
      socketPath: path.join(tmp, 'sched.sock'),
      tokenPath: path.join(tmp, 'sched.token'),
      capFile: path.join(tmp, 'sched.cap.json'),
    },
  })
  t.after(async () => {
    await runtime.shutdown({ drain: false, stopProcess: true })
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  return { runtime, state, accountQuota }
}

const VMS = () => [claudeVm('pro-a', 'pro', 10), claudeVm('pro-b', 'pro', 9)]
const MODEL = 'claude-opus-4-6'

function ok(vmId) {
  return {
    ok: true,
    status: 200,
    committed: true,
    terminalState: 'verified',
    body: {
      id: `msg_${vmId}`,
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: vmId }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 4, output_tokens: 2 },
    },
  }
}
const RATE_LIMITED = {
  ok: false,
  status: 429,
  terminalState: 'rejected',
  body: { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } },
}
const SLOT_BUSY = {
  ok: false,
  status: 503,
  terminalState: 'rejected',
  body: { error: { type: 'api_error', code: 'slot_busy', message: 'no free slot' } },
}

async function boot(t, failover) {
  const { runtime } = setup(t, { vms: VMS(), routing: { pool: {} } })
  await runtime.start({ waitMs: 5_000, startLoops: false })
  await runtime.pushTelemetryNow()
  const runner = new FailoverRunner({
    scheduler: { markCooldown() {}, markSuccess() {}, setSchedulerRuntime() {} },
    schedulerRuntime: runtime,
    config: { max_same_account_retries: 0, same_account_retry_delay_ms: 0, home_slot_busy_retry_ms: 10, ...failover },
  })
  return runner
}

let seq = 0
async function turn(runner, sid, respond, extra = {}) {
  const calls = []
  seq += 1
  const result = await runner.run({
    requestId: `req-home-${seq}`,
    canonicalBody: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
    model: MODEL,
    stickyKey: sid,
    callAttempt: async ({ candidate, onFirstByte }) => {
      calls.push(candidate.vmId)
      const r = respond(candidate.vmId, calls.length)
      if (r.ok) onFirstByte?.()
      return r
    },
    ...extra,
  })
  return { result, calls }
}

const SID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('keep_session_home on: a continuing conversation never replays on another node (session_home_kept)', async (t) => {
  const runner = await boot(t, { keep_session_home: true })
  const sid = SID(101)
  const first = await turn(runner, sid, (vm) => ok(vm))
  assert.deepEqual(first.calls, ['pro-a'])
  const second = await turn(runner, sid, () => RATE_LIMITED)
  assert.deepEqual(second.calls, ['pro-a'], 'no hop to pro-b')
  assert.equal(second.result.ok, false)
  assert.equal(second.result.status, 429)
  assert.equal(second.result.session_home_kept, true)
})

test('keep_session_home off: 243/upstream behaviour, the failed turn moves to another node', async (t) => {
  const runner = await boot(t, { keep_session_home: false })
  const sid = SID(102)
  await turn(runner, sid, (vm) => ok(vm))
  const second = await turn(runner, sid, (vm) => (vm === 'pro-a' ? RATE_LIMITED : ok(vm)))
  assert.deepEqual(second.calls, ['pro-a', 'pro-b'])
  assert.equal(second.result.ok, true)
})

test('keep_session_home on: a new conversation (no pin yet) still fails over', async (t) => {
  const runner = await boot(t, { keep_session_home: true })
  const res = await turn(runner, SID(103), (vm) => (vm === 'pro-a' ? RATE_LIMITED : ok(vm)))
  assert.deepEqual(res.calls, ['pro-a', 'pro-b'])
  assert.equal(res.result.ok, true)
})

test('keep_session_home on: home slot_busy waits for the home kernel instead of spilling', async (t) => {
  const runner = await boot(t, { keep_session_home: true })
  const sid = SID(104)
  await turn(runner, sid, (vm) => ok(vm))
  const res = await turn(runner, sid, (vm, n) => (n === 1 ? SLOT_BUSY : ok(vm)))
  assert.deepEqual(res.calls, ['pro-a', 'pro-a'])
  assert.equal(res.result.ok, true)
})

test('keep_session_home on: home slot_busy with x-kin-queue off answers 529 session_home_slot_busy', async (t) => {
  const runner = await boot(t, { keep_session_home: true })
  const sid = SID(105)
  await turn(runner, sid, (vm) => ok(vm))
  const res = await turn(runner, sid, () => SLOT_BUSY, { allowQueue: false })
  assert.deepEqual(res.calls, ['pro-a'])
  assert.equal(res.result.status, 529)
  assert.equal(res.result.body?.error?.details?.reason, 'session_home_slot_busy')
})

test('batch member: sticky to one node across requests, two in flight at once are not serialized (238 batchMember)', async (t) => {
  const runner = await boot(t, { keep_session_home: true })
  const member = 'batch:key_x:seat:h:abc#0'
  const calls = []
  let release
  const gate = new Promise((r) => {
    release = r
  })
  let inFlight = 0
  let peak = 0
  const run = (n) =>
    runner.run({
      requestId: `req-batch-${n}`,
      canonicalBody: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
      model: MODEL,
      stickyKey: member,
      stickyKeys: [member],
      batchMember: true,
      callAttempt: async ({ candidate, onFirstByte }) => {
        calls.push(candidate.vmId)
        inFlight += 1
        peak = Math.max(peak, inFlight)
        onFirstByte?.()
        if (n === 1) await gate
        inFlight -= 1
        return ok(candidate.vmId)
      },
    })
  // Pin the member to pro-b: the only node allowed for its first request.
  const first = await runner.run({
    requestId: 'req-batch-0',
    canonicalBody: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
    model: MODEL,
    stickyKey: member,
    batchMember: true,
    allowedNodeKeys: ['claude_vm:pro-b'],
    callAttempt: async ({ candidate, onFirstByte }) => {
      onFirstByte?.()
      return ok(candidate.vmId)
    },
  })
  assert.equal(first.ok, true)
  const a = run(1)
  await new Promise((r) => setTimeout(r, 50))
  const b = run(2)
  const rb = await b
  release()
  const ra = await a
  assert.equal(ra.ok, true)
  assert.equal(rb.ok, true)
  assert.deepEqual(calls, ['pro-b', 'pro-b'], 'member stays on its node')
  assert.equal(peak, 2, 'same member runs concurrently')
})
