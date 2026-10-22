import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveSeatIdentity } from '../../src/lib/identity/identity-rewrite.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'

const MODEL = 'claude-test'

function setup(t, { mode = 'session', graceMs = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-session-routing-'))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(vms, { recursive: true })
  for (const index of [1, 2]) {
    const id = `vm-0${index}`
    fs.writeFileSync(
      path.join(vms, `${id}.json`),
      JSON.stringify({
        id,
        name: id,
        status: 'running',
        schedulable: true,
        proxy_cli_enabled: true,
        proxy: { id: `proxy-${id}`, url: `socks5h://127.0.0.1:${11000 + index}` },
        runtime: { worker_socket: path.join(vms, id, 'run', 'worker.sock') },
        policy: { maxConcurrency: 2, concurrencyOverride: true, sessionSlots: 4, weight: 1 },
        claude: {
          account_uuid: `account-${index}`,
          account_tier: 'max',
          access_token: `synthetic-access-${index}`,
          refresh_token: `synthetic-refresh-${index}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    )
  }
  fs.writeFileSync(path.join(vms, 'active.json'), JSON.stringify({ active_vm: 'vm-01' }))
  const states = new Map()
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: {
      get: (id) => states.get(id) || null,
      clearExpired() {},
      upsert: (state) => states.set(state.account_id, { ...states.get(state.account_id), ...state }),
    },
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { assignment_mode: mode, seat_grace_ms: graceMs },
  })
  const held = []
  const trace = []
  const record = (requestId, sessionId, selected) => {
    trace.push({
      requestId,
      sessionId,
      vmId: selected?.vmId || null,
      inFlight: { ...pool.snapshot().inflight },
      waiting: pool.queuedTotal(),
      state: selected?.ok ? 'executing' : selected?.reason || 'waiting',
    })
  }
  const select = async (sessionId, extra = {}) => {
    const requestId = `request-${trace.length + 1}`
    const inbound = {
      model: MODEL,
      metadata: { user_id: { device_id: 'shared-device', session_id: sessionId } },
      messages: [{ role: 'user', content: 'Synthetic scheduling request; no real conversation content.' }],
    }
    const identity = resolveSeatIdentity({ inbound, mode })
    const selected = await pool.selectAndReserve({
      model: MODEL,
      seatKey: identity.key,
      assignmentMode: mode,
      allowWait: false,
      ...extra,
    })
    if (selected.ok) held.push(selected)
    record(requestId, sessionId, selected)
    return selected
  }
  t.after(() => {
    for (const hold of held) hold.release()
    for (const seat of [...pool.planner.seats.values()]) pool.planner.free(seat)
    t.diagnostic(`request trace: ${JSON.stringify(trace)}`)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, pool, select, trace }
}

test('session assignment uses an idle VM when another root session on the same device fills its VM', async (t) => {
  const { pool, select, trace } = setup(t)
  const first = await select('root-a')
  const parallel = await select('root-a')
  assert.equal(first.ok, true)
  assert.equal(first.vmId, 'vm-01')
  assert.equal(parallel.vmId, first.vmId)
  assert.deepEqual(pool.snapshot().inflight, { 'account-1': 2 })

  const independent = await select('root-b')
  assert.equal(independent.ok, true, `independent root should execute on idle VM: ${JSON.stringify(trace)}`)
  assert.equal(independent.vmId, 'vm-02')
  assert.deepEqual(pool.snapshot().inflight, { 'account-1': 2, 'account-2': 1 })
  assert.equal(pool.queuedTotal(), 0)
})
