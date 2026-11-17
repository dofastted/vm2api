import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { bindPlacement, unbindPlacement } from '../../src/lib/cluster/placement.mjs'
import { ClusterError } from '../../src/lib/cluster/ssh-link.mjs'
import { reloadActiveVm } from '../../src/lib/core/config.mjs'
import { getVm } from '../../src/lib/vm/vm-registry.mjs'
import { readCodexAccounts, writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
import { invalidateReadCache } from '../../src/lib/vm/vm-file.mjs'

function seed(root, id, { active = false, ...extra } = {}) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, name: id, status: 'stopped', schedulable: false, policy: { maxConcurrency: 2 }, ...extra }),
  )
  if (active) fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ active_vm: id }))
}

function handler(project, { role = 'admin', ...extra } = {}) {
  const response = {}
  const cfg = { paths: { project }, vm: { id: 'stale' } }
  const handlePanel = createPanelHandler({
    cfg,
    requireAuth(req) {
      if (role === 'admin') req.apiKeyKind = 'master'
      else req.panelUser = 'operator'
      req.panelRole = role
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => ({}),
    proxyPool: { unbindVm() {} },
    ...extra,
  })
  return { handlePanel, response, cfg }
}

test('fresh deploy can delete its only active VM', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-only-'))
  try {
    seed(root, 'vm-01', { active: true })
    const { handlePanel, response, cfg } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body?.data?.deleted, 'vm-01')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01.json')), false)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'active.json')), false)
    reloadActiveVm(cfg)
    assert.equal(cfg.vm.id, null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('active VM stays when another slot exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-active-'))
  try {
    seed(root, 'vm-01', { active: true })
    seed(root, 'vm-02')
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 409)
    assert.match(response.body?.error?.message, /switch active first/)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01.json')), true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'active.json'), 'utf8')).active_vm, 'vm-01')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('non-active VM deletes while the active pointer stays', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-other-'))
  try {
    seed(root, 'vm-01', { active: true })
    seed(root, 'vm-02')
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-02'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-02.json')), false)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01.json')), true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'active.json'), 'utf8')).active_vm, 'vm-01')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('startup reconcile does not resurrect a deleted sole active VM', async () => {
  const { openDatabase, closeDatabase } = await import('../../src/lib/db/database.mjs')
  const { initVmDbSync, stopVmWatch, reconcileVms } = await import('../../src/lib/vm/vm-db-sync.mjs')
  const { setVmWriteHook } = await import('../../src/lib/vm/vm-file.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-db-'))
  try {
    openDatabase({ dataDir: path.join(root, 'data') })
    seed(root, 'vm-01', { active: true })
    initVmDbSync(root, { watch: false })
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const again = reconcileVms(root)
    assert.equal(again.rebuilt, 0)
    assert.equal(again.active, null)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01.json')), false)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'active.json')), false)
  } finally {
    stopVmWatch()
    setVmWriteHook(null)
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('deleting a slot removes its account-pool membership', async () => {
  const { openDatabase, closeDatabase, getDb } = await import('../../src/lib/db/database.mjs')
  const { initVmDbSync, stopVmWatch } = await import('../../src/lib/vm/vm-db-sync.mjs')
  const { setVmWriteHook } = await import('../../src/lib/vm/vm-file.mjs')
  const { VmPoolsRepo } = await import('../../src/lib/db/repos/vm-pools-repo.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-pool-'))
  try {
    openDatabase({ dataDir: path.join(root, 'data') })
    seed(root, 'vm-01')
    seed(root, 'vm-02')
    initVmDbSync(root, { watch: false })
    const pools = new VmPoolsRepo(getDb())
    const pool = pools.insert({ name: 'shared' })
    pools.setMembers(pool.id, ['vm-01', 'vm-02'])
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.deepEqual(pools.get(pool.id).vm_ids, ['vm-02'])
  } finally {
    stopVmWatch()
    setVmWriteHook(null)
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('deleting a slot drops cached record and credential entries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-cache-'))
  try {
    seed(root, 'vm-02')
    fs.mkdirSync(path.join(root, 'vms', 'vm-02'), { recursive: true })
    writeCodexAccounts(root, 'vm-02', [{ access_token: 'stay-secret' }])
    const recPath = path.join(root, 'vms', 'vm-02.json')
    const credPath = path.join(root, 'vms', 'vm-02', 'codex-credentials.json')
    assert.equal(getVm(root, 'vm-02').id, 'vm-02')
    assert.equal(readCodexAccounts(root, 'vm-02')[0].access_token, 'stay-secret')
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-02'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(invalidateReadCache(recPath), false)
    assert.equal(invalidateReadCache(credPath), false)
    assert.equal(getVm(root, 'vm-02'), null)
    assert.deepEqual(readCodexAccounts(root, 'vm-02'), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function goneNode({ reachable = false } = {}) {
  const calls = { checked: [], dropped: [] }
  return {
    calls,
    async confirmNodeUnreachable(id) {
      calls.checked.push(id)
      if (reachable) throw new ClusterError(409, 'node_reachable', '节点仍可连接，请用普通删除清理节点上的容器')
      return { state: 'backoff', error: 'ssh_timeout' }
    },
    async dropSlotRelays(id) {
      calls.dropped.push(id)
    },
  }
}

function seedNodeSlot(root, id) {
  seed(root, id, { node_id: 'node-a' })
  fs.mkdirSync(path.join(root, 'vms', id, 'run'), { recursive: true })
}

test('a slot on an unreachable node is force-deleted locally without touching the node', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-gone-'))
  // The bound manager is what the normal teardown dials; it must never be reached with force.
  bindPlacement({
    manager: {
      nodePlatform: () => 'linux',
      client() {
        throw new ClusterError(409, 'node_not_ready', '节点未连接（backoff）')
      },
    },
    projectRoot: root,
  })
  try {
    seed(root, 'vm-01', { active: true })
    seedNodeSlot(root, 'vm-02')
    const unbound = []
    const manager = goneNode()
    const { handlePanel, response } = handler(root, {
      clusterManager: manager,
      proxyPool: { unbindVm: (id) => unbound.push(id) },
    })
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-02'))
    assert.equal(response.status, 409, 'without force the node teardown still runs and fails')
    assert.equal(response.body?.error?.code, 'node_not_ready')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-02.json')), true)
    assert.deepEqual(manager.calls.checked, [])

    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-02?force=1'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body?.data?.deleted, 'vm-02')
    assert.equal(response.body?.data?.remote_teardown, 'skipped')
    assert.equal(response.body?.data?.node_state, 'backoff')
    assert.deepEqual(manager.calls.checked, ['node-a'])
    assert.deepEqual(manager.calls.dropped, ['vm-02'])
    assert.deepEqual(unbound, ['vm-02'])
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-02.json')), false)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-02')), false)
    assert.equal(getVm(root, 'vm-02'), null)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'active.json'), 'utf8')).active_vm, 'vm-01')
  } finally {
    unbindPlacement()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('force delete is refused while the node still answers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-alive-'))
  try {
    seedNodeSlot(root, 'vm-02')
    const unbound = []
    const manager = goneNode({ reachable: true })
    const { handlePanel, response } = handler(root, {
      clusterManager: manager,
      proxyPool: { unbindVm: (id) => unbound.push(id) },
    })
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-02?force=1'))
    assert.equal(response.status, 409)
    assert.equal(response.body?.error?.code, 'node_reachable')
    assert.deepEqual(manager.calls.checked, ['node-a'])
    assert.deepEqual(manager.calls.dropped, [])
    assert.deepEqual(unbound, [])
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-02.json')), true)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-02', 'run')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('force delete is only for node slots and only for admins', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-scope-'))
  try {
    seed(root, 'vm-01')
    seedNodeSlot(root, 'vm-02')
    const manager = goneNode()
    const admin = handler(root, { clusterManager: manager })
    await admin.handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-01?force=1'))
    assert.equal(admin.response.status, 400)
    assert.equal(admin.response.body?.error?.code, 'force_delete_local_slot')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01.json')), true)
    for (const role of ['super', 'user']) {
      const other = handler(root, { role, clusterManager: manager })
      await other.handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-02?force=1'))
      assert.equal(other.response.status, 403, role)
    }
    assert.deepEqual(manager.calls.checked, [])
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-02.json')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('force delete still releases the CRAG host-subscription permit the slot held', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-crag-'))
  try {
    seedNodeSlot(root, 'vm-02')
    const released = []
    const cragSubscription = {
      // Same contract as crag-subscription teardown: release only after a confirmed teardown.
      async teardown(vm, destroy) {
        const result = await destroy(true)
        if (result.teardownConfirmed !== true) throw new Error('crag_subscription_teardown_unconfirmed')
        released.push(vm.id)
        return { ...result, reclaim_pending: true }
      },
    }
    const manager = goneNode()
    const { handlePanel, response } = handler(root, { clusterManager: manager, cragSubscription })
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-02?force=1'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.deepEqual(released, ['vm-02'])
    assert.deepEqual(manager.calls.dropped, ['vm-02'])
    assert.equal(response.body?.data?.reclaim_pending, true)
    assert.equal(response.body?.data?.remote_teardown, 'skipped')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-02.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
