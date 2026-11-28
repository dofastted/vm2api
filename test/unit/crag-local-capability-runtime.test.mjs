import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { prepareCragPrintBody } from '../../src/lib/protocol/crag-print-prompt.mjs'
import { resolvePoolSystemPromptPolicy } from '../../src/lib/protocol/pool-prompt-policy.mjs'
import { createSchedulerRuntime } from '../../src/lib/scheduler/scheduler-runtime.mjs'

const code = 'crag_prompt_replace_empty_unsupported'
const localPrepare = (body) =>
  prepareCragPrintBody(body, {
    preset: 'zero',
    capabilities: ['generation_controls_v3', 'linux_tui_native_queue', 'prompt_replace', 'prompt_append'],
    health: { persona_preset: 'official_full' },
    promptPolicy: resolvePoolSystemPromptPolicy(
      {
        id: 'pool-test',
        provider_scope: 'anthropic',
        system_prompt_mode: 'zero_inject',
        system_prompt_preset: 'official_full',
        system_prompt_text: '',
        client_system_policy: 'prepend_pool',
      },
      {},
      { nodeProvider: 'anthropic', isInternalCall: false },
    ),
  })

for (const scenario of [
  { name: 'local rejection at attempt limit', local: true, maxAttempts: 1 },
  { name: 'local rejection on exhausted switch', local: true, maxAttempts: 2 },
  { name: 'same-code upstream 503', status: 503 },
  { name: 'same-code thrown upstream error', thrown: true },
  { name: 'transport failure', transport: true },
  { name: 'upstream timeout', status: 504 },
]) {
  test(`real scheduler: ${scenario.name} ${scenario.local ? 'preserves capacity' : 'still cools node'}`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-local-health-'))
    const runtime = createSchedulerRuntime({
      getDb: () => null,
      getVms: () => [
        {
          id: 'vm-old',
          kind: 'claude',
          status: 'running',
          schedulable: true,
          policy: { max_concurrency: 4, session_slots: 4 },
        },
      ],
      getRoutingConfig: () => ({}),
      telemetryIntervalMs: 0,
      clientOptions: {
        binPath: process.env.KIN_SCHEDULER_BIN,
        dataDir: dir,
        socketPath: path.join(dir, 'scheduler.sock'),
        tokenPath: path.join(dir, 'token'),
        capFile: path.join(dir, 'cap.json'),
      },
    })
    const held = []
    t.after(async () => {
      for (const lease of held) await runtime.releaseLease(lease.lease_id, 'aborted')
      await runtime.shutdown({ drain: false, stopProcess: true })
      fs.rmSync(dir, { recursive: true, force: true })
    })
    await runtime.start({ waitMs: 5000, startLoops: false })
    await runtime.pushTelemetryNow()
    const acquire = () =>
      runtime.acquireNode({
        originPoolId: '__virtual_claude__',
        apiKeyKind: 'master',
        ownerScope: { type: 'platform' },
        allowedNodeKeys: ['claude_vm:vm-old'],
        nodeTypes: ['claude_vm'],
        model: 'claude-sonnet-4-6',
        modelFamily: 'claude',
        protocol: 'anthropic',
        sessionId: crypto.randomUUID(),
        noQueue: true,
      })
    const scheduler = {
      resolveCandidateForNode: (node) => ({
        vmId: node.node_id,
        accountId: 'acc-old',
        vm: { id: node.node_id },
        nodeKey: node.node_key,
        release() {},
      }),
      markSuccess() {},
      markCooldown() {},
      unitCircuit: { recordFailure() {}, recordSuccess() {} },
    }
    const runner = new FailoverRunner({
      scheduler,
      schedulerRuntime: runtime,
      config: {
        max_attempts: scenario.maxAttempts || 1,
        max_account_switches: 1,
        same_account_retry_delay_ms: 0,
      },
    })
    let calls = 0
    const result = await runner.run({
      requestId: crypto.randomUUID(),
      model: 'claude-sonnet-4-6',
      requestBody: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
      applyAttempt: scenario.local ? localPrepare : undefined,
      callAttempt: async () => {
        calls++
        if (scenario.thrown) throw Object.assign(new Error('upstream failed'), { code, status: 503 })
        if (scenario.transport) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
        return { ok: false, status: scenario.status, body: { error: { code, message: 'upstream failed' } } }
      },
    })
    if (scenario.local) {
      assert.equal(calls, 0)
      assert.equal(result.status, 503)
      assert.equal(result.body.error.code, code)
      assert.equal(result.transportError, false)
      // A cooled node admits one probe. Hold both leases to exclude that false positive.
      held.push(await acquire())
      held.push(await acquire())
    } else {
      assert.equal(calls, 1)
      // Cooldown may permit one probe, but never both concurrent requests.
      let rejected = false
      for (let i = 0; i < 2; i++) {
        try {
          held.push(await acquire())
        } catch (error) {
          assert.equal(error.code, 'pool_exhausted')
          assert.match(JSON.stringify(error.explain), /node_cooldown/)
          rejected = true
          break
        }
      }
      assert.equal(rejected, true)
    }
  })
}
