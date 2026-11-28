import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UnitCircuit, unitCircuit } from '../../src/lib/pool/unit-circuit.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'

test('a prefix scope gives its units their own threshold and open window', () => {
  let now = 1_000
  const circuit = new UnitCircuit({ failureThreshold: 3, openMs: 30_000, now: () => now })
  circuit.configureScope('gemini:', { failureThreshold: 1, openMs: 5_000 })

  circuit.recordFailure('gemini:env-a', now)
  assert.equal(circuit.inspect('gemini:env-a', now).reason, 'circuit_open')
  assert.equal(circuit.view('gemini:env-a', now).open_until, 6_000)
  assert.equal(circuit.view('gemini:env-a', now).threshold, 1)
  assert.equal(circuit.view('gemini:env-a', now).open_ms, 5_000)

  circuit.recordFailure('vm-a', now)
  circuit.recordFailure('vm-a', now)
  assert.equal(circuit.inspect('vm-a', now).ok, true, 'Claude units keep the global threshold')
  circuit.recordFailure('vm-a', now)
  assert.equal(circuit.view('vm-a', now).open_until, 31_000)

  now = 6_000
  assert.equal(circuit.admit('gemini:env-a', now).probe, true)
})

test('a scope threshold of 0 keeps that scope closed', () => {
  const circuit = new UnitCircuit({ failureThreshold: 1, openMs: 30_000, now: () => 1_000 })
  circuit.configureScope('gemini:', { failureThreshold: 0, openMs: 30_000 })
  for (let i = 0; i < 5; i++) circuit.recordFailure('gemini:env-b')
  assert.deepEqual(circuit.admit('gemini:env-b'), { ok: true, state: 'closed' })
  assert.equal(circuit.view('gemini:env-b').state, 'closed')
  assert.equal(circuit.view('gemini:env-b').threshold, 0)
  circuit.recordFailure('vm-b')
  assert.equal(circuit.inspect('vm-b').ok, false, 'disabling Gemini leaves Claude units alone')
})

test('saving gemini.pool.circuit_* changes how Gemini environments trip', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-circuit-config-'))
  const policies = []
  const runtime = createRoutingRuntime({
    cfg: { paths: { project: root } },
    routingConfigPath: path.join(root, 'routing.json'),
    stickyRouter: { reloadConfig() {} },
    accountQuota: {
      reloadConfig() {},
      applyTierConcurrency: () => ({}),
      applyTierRpm: () => ({}),
      repo: { list: () => [] },
    },
    routingConfig: { pool: { circuit_failure_threshold: 3, circuit_open_ms: 30_000 } },
    callGeminiHost: async (action, body) => {
      policies.push({ action, pool: body.policy.pool })
      return { shards_updated: 1, shards_total: 1 }
    },
  })
  const saved = { ...unitCircuit }
  const env = 'gemini:env-config'
  const vm = 'vm-config'
  t.after(() => {
    unitCircuit.failureThreshold = saved.failureThreshold
    unitCircuit.openMs = saved.openMs
    unitCircuit.clearScope('gemini:')
    unitCircuit.reset(env)
    unitCircuit.reset(vm)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const t0 = Date.now()

  await runtime.persistRoutingPatch({ pool: { circuit_failure_threshold: 3, circuit_open_ms: 30_000 } })
  await runtime.persistRoutingPatch({ gemini: { pool: { circuit_failure_threshold: 1, circuit_open_ms: 5_000 } } })
  assert.deepEqual(
    policies.map((p) => [p.action, p.pool.circuit_failure_threshold, p.pool.circuit_open_ms]),
    [['apply-policy', 1, 5_000]],
  )
  unitCircuit.recordFailure(env, t0)
  assert.equal(unitCircuit.inspect(env, t0).reason, 'circuit_open')
  assert.equal(unitCircuit.view(env, t0).open_until, t0 + 5_000)
  unitCircuit.recordFailure(vm, t0)
  assert.equal(unitCircuit.inspect(vm, t0).ok, true, 'Claude pool.circuit_failure_threshold still applies')

  unitCircuit.reset(env)
  await runtime.persistRoutingPatch({ gemini: { pool: { circuit_failure_threshold: 0 } } })
  for (let i = 0; i < 5; i++) unitCircuit.recordFailure(env, t0)
  assert.equal(unitCircuit.inspect(env, t0).ok, true)

  // A Claude-only save must not drop the Gemini scope back to Claude's numbers.
  await runtime.persistRoutingPatch({ pool: { circuit_failure_threshold: 1 } })
  unitCircuit.recordFailure(env, t0)
  assert.equal(unitCircuit.inspect(env, t0).ok, true)
  assert.equal(unitCircuit.view(vm, t0).threshold, 1)
})
