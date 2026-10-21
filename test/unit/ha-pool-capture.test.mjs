import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb } from '../../src/lib/db/database.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { HaVmCatalog, bindHaVmCatalog } from '../../src/lib/vm/ha-vm-catalog.mjs'

for (const available of [true, false]) {
  test(`HA scheduling ${available ? 'reuses one captured execution' : 'refuses missing node proof'} without Pod credential or worker files`, async (t) => {
    const previous = process.env.VM2API_CONTROL_PLANE_MODE
    process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes-ha'
    t.after(() => {
      bindHaVmCatalog(null)
      if (previous === undefined) delete process.env.VM2API_CONTROL_PLANE_MODE
      else process.env.VM2API_CONTROL_PLANE_MODE = previous
    })
    const db = getDb()
    const repo = new VmsRepo(db)
    await repo.upsertFromVmJson({
      id: 'ha-pool-vm',
      node_id: 'ha-node',
      status: 'running',
      schedulable: true,
      claude: {
        account_uuid: 'ha-pool-account',
        has_access: true,
        has_refresh: true,
        expires_at: Date.now() + 3600_000,
      },
    })
    const catalog = new HaVmCatalog(db)
    bindHaVmCatalog(catalog)
    let captures = 0
    let legacyHealth = 0
    const capability = Object.freeze({
      slotgate: Object.freeze({
        trusted: true,
        pgBindingReady: true,
        vmId: 'ha-pool-vm',
        nodeId: 'ha-node',
        fence: { generation: '1', incarnation: 'captured-incarnation' },
        manifest: { revision: '1', digest: 'a'.repeat(64) },
      }),
      nodeManifest: Object.freeze({ revision: '1', digest: 'a'.repeat(64) }),
      workerStatus: Object.freeze({
        ok: true,
        healthy: true,
        ready_slots: 1,
        credential: { has_access: true, has_refresh: true, account_uuid: 'ha-pool-account', generation: 1 },
      }),
    })
    const scheduler = new PoolScheduler({
      projectRoot: '/nonexistent-ha-pod-project',
      captureNodeExecution: async ({ vmId, accountId, nodeId }) => {
        captures++
        assert.deepEqual([vmId, accountId, nodeId], ['ha-pool-vm', 'ha-pool-account', 'ha-node'])
        if (!available)
          throw Object.assign(new Error('synthetic node unavailable'), { code: 'node_capability_unavailable' })
        return capability
      },
      workerHealth: async () => {
        legacyHealth++
        throw new Error('legacy worker health must not run')
      },
      executionAdmissions: {
        inspectCircuit: async () => ({ open: false }),
        getCounts: async () => ({ accountInflight: 0, vmInflight: 0, fableInflight: 0, rpmCount: 0 }),
      },
    })
    const candidates = await scheduler.eligibleCandidates({ model: 'claude-haiku-4-5' })
    assert.equal(captures, 1)
    assert.equal(legacyHealth, 0)
    assert.equal(candidates.length, available ? 1 : 0)
    if (available) {
      assert.equal(candidates[0].exec.slotgate, capability.slotgate)
      assert.equal(candidates[0].exec.nodeManifest, capability.nodeManifest)
      assert.equal(candidates[0].workerStatus, capability.workerStatus)
      assert.equal(candidates[0].exec.homeDir, undefined)
      assert.equal(candidates[0].exec.vmPath, undefined)
    }
  })
}
