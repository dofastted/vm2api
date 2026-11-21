import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cragCoreCheckable,
  cragSlotHealthy,
  matchingCragCore,
  waitForCragCore,
} from '../../src/lib/vm/crag-core-check.mjs'

const SHA = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

// The window is wall-clock based, so a stubbed sleep has to move the clock it
// is measured against; a no-op sleep would spin instead of waiting.
function fakeClock(start = 1_000_000) {
  let at = start
  let slept = 0
  return {
    now: () => at,
    sleep: async (ms) => {
      slept++
      at += ms
    },
    slept: () => slept,
  }
}

test('only a locally reachable slot has inspectable core processes', () => {
  assert.equal(cragCoreCheckable({ id: 'vm-1' }), process.platform === 'linux')
  assert.equal(cragCoreCheckable({ id: 'vm-2', node_id: 'node-one' }), false)
})

test('every running core must come from the installed tree', () => {
  assert.equal(matchingCragCore([SHA], SHA), true)
  // A v2 process pool legitimately runs several cores.
  assert.equal(matchingCragCore([SHA, SHA], SHA), true)
  assert.equal(matchingCragCore([SHA, OTHER], SHA), false)
  assert.equal(matchingCragCore([], SHA), false)
})

test('a core already up from the installed tree verifies without waiting', async () => {
  let probes = 0
  let slept = 0
  const result = await waitForCragCore({ id: 'vm-1' }, SHA, {
    coreHashes: async () => (probes++, [SHA]),
    sleep: async () => void slept++,
  })
  assert.deepEqual(result, { ok: true, state: 'verified', sha: SHA })
  assert.equal(probes, 1)
  assert.equal(slept, 0)
})

test('a core from another tree fails at once and does not burn the window', async () => {
  let slept = 0
  const result = await waitForCragCore({ id: 'vm-1' }, SHA, {
    coreHashes: async () => [OTHER],
    sleep: async () => void slept++,
    timeoutMs: 60_000,
    intervalMs: 1000,
  })
  assert.equal(result.ok, false)
  assert.equal(result.state, 'mismatch')
  assert.equal(result.code, 'crag_running_core_mismatch')
  assert.deepEqual(result.hashes, [OTHER])
  assert.equal(slept, 0, '真故障不该等待')
})

test('a core that appears within the window is still verified', async () => {
  let probes = 0
  const clock = fakeClock()
  const result = await waitForCragCore({ id: 'vm-1' }, SHA, {
    coreHashes: async () => (++probes < 3 ? [] : [SHA]),
    ...clock,
    timeoutMs: 30_000,
    intervalMs: 1000,
  })
  assert.deepEqual(result, { ok: true, state: 'verified', sha: SHA })
  assert.equal(probes, 3)
})

test('a slot with no core up is pending, not a mismatch', async () => {
  // Cores spawn lazily, so a slot that has just restarted can legitimately run
  // none. Reporting that as a mismatch failed a whole update that an unchanged
  // re-run then passed.
  let probes = 0
  const clock = fakeClock()
  const result = await waitForCragCore({ id: 'vm-30' }, SHA, {
    coreHashes: async () => (probes++, []),
    ...clock,
    timeoutMs: 3000,
    intervalMs: 1000,
  })
  assert.deepEqual(result, { ok: true, state: 'pending' })
  // Probes at 0s, 1s, 2s and 3s use the whole window before giving up.
  assert.equal(probes, 4)
  assert.equal(clock.slept(), 3)
})

test('a window of zero takes exactly one probe', async () => {
  let probes = 0
  const clock = fakeClock()
  const result = await waitForCragCore({ id: 'vm-1' }, SHA, {
    coreHashes: async () => (probes++, []),
    ...clock,
    timeoutMs: 0,
  })
  assert.deepEqual(result, { ok: true, state: 'pending' })
  assert.equal(probes, 1)
  assert.equal(clock.slept(), 0)
})

test('a slot that cannot be inspected is unknown, never pending', async () => {
  const clock = fakeClock()
  const result = await waitForCragCore({ id: 'vm-1' }, SHA, {
    coreHashes: async () => {
      throw new Error('container_gone')
    },
    ...clock,
    timeoutMs: 2000,
    intervalMs: 1000,
  })
  assert.equal(result.ok, false)
  assert.equal(result.state, 'unknown')
  assert.equal(result.code, 'crag_core_probe_failed')
})

test('a transient probe failure does not hide a core that comes back', async () => {
  let probes = 0
  const result = await waitForCragCore({ id: 'vm-1' }, SHA, {
    coreHashes: async () => {
      if (++probes === 1) throw new Error('exec_busy')
      return [SHA]
    },
    ...fakeClock(),
    timeoutMs: 10_000,
    intervalMs: 1000,
  })
  assert.deepEqual(result, { ok: true, state: 'verified', sha: SHA })
})

test('an unusable expected digest is refused before any slot is probed', async () => {
  for (const expected of ['', undefined, 'not-a-sha', SHA.toUpperCase()]) {
    const result = await waitForCragCore({ id: 'vm-1' }, expected, {
      coreHashes: async () => assert.fail('不该探测槽位'),
      sleep: async () => {},
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'crag_core_expected_invalid')
  }
})

test('CRAG identity is only trusted from an authenticated internal probe', async () => {
  const full = {
    status: 200,
    ok: true,
    internalTokenAuthenticated: true,
    healthy: true,
    runtime_variant: 'crag-v2',
    license_valid: true,
  }
  let asked
  assert.equal(
    await cragSlotHealthy(
      { vm: { id: 'vm-1' } },
      {
        health: async (_exec, options) => {
          asked = options
          return full
        },
      },
    ),
    true,
  )
  assert.equal(asked.requireInternalToken, true, '必须要求内部令牌')
  for (const weaken of [
    { internalTokenAuthenticated: false },
    { internalTokenAuthenticated: undefined },
    { status: 503 },
    { ok: false },
    { healthy: false },
    { runtime_variant: 'wrap' },
    { license_valid: false },
  ]) {
    assert.equal(
      await cragSlotHealthy({ vm: { id: 'vm-1' } }, { health: async () => ({ ...full, ...weaken }) }),
      false,
      `${JSON.stringify(weaken)} 不该算健康`,
    )
  }
  assert.equal(await cragSlotHealthy({ vm: { id: 'vm-1' } }, { health: async () => null }), false)
})
