import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { initVmDbSync, reconcileVms } from '../../src/lib/vm/vm-db-sync.mjs'
import { setVmWriteHook } from '../../src/lib/vm/vm-file.mjs'
import { getActiveVmId, setActiveVm } from '../../src/lib/vm/vm-registry.mjs'
import { reloadActiveVm } from '../../src/lib/core/config.mjs'

let project
let cfg
let response
let handle

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-deactivate-'))
  fs.mkdirSync(path.join(project, 'vms'))
  for (const id of ['vm-01', 'vm-02']) {
    fs.writeFileSync(
      path.join(project, 'vms', `${id}.json`),
      JSON.stringify({
        id,
        name: id,
        status: 'running',
        schedulable: true,
        policy: { maxConcurrency: 2 },
      }),
    )
  }
  openDatabase({ dataDir: path.join(project, 'data') })
  initVmDbSync(project, { watch: false })
  setActiveVm(project, 'vm-01')
  cfg = { paths: { project }, vm: { id: null } }
  reloadActiveVm(cfg)
  response = {}
  handle = createPanelHandler({
    cfg,
    requireAuth(req) {
      req.panelRole = req.role || 'admin'
      if (req.panelRole === 'admin') req.apiKeyKind = 'master'
      return true
    },
    json(_res, status, body) {
      Object.assign(response, { status, body })
      return true
    },
    accountQuota: { ensure() {} },
  })
})

afterEach(() => {
  setVmWriteHook(null)
  closeDatabase()
  // Keep test cleanup recoverable, matching the workspace deletion policy.
  // The OS owns the temporary directory's eventual cleanup.
})

async function post(route, role = 'admin') {
  await handle({ method: 'POST', role }, {}, new URL(`http://localhost${route}`))
  return response
}

for (const prefix of ['/api/panel', '/admin']) {
  test(`${prefix}: clear active pointer, runtime and DB without changing scheduling`, async () => {
    const file = path.join(project, 'vms', 'vm-01.json')
    const before = fs.readFileSync(file, 'utf8')
    assert.equal(cfg.vm.id, 'vm-01')
    assert.equal(new VmsRepo().getActiveVmId(), 'vm-01')
    assert.equal((await post(`${prefix}/vms/vm-01/deactivate`)).status, 200)
    assert.equal(getActiveVmId(project), null)
    assert.equal(cfg.vm.id, null)
    assert.equal(new VmsRepo().getActiveVmId(), null)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    reconcileVms(project)
    reloadActiveVm(cfg)
    assert.equal(getActiveVmId(project), null)
    assert.equal(cfg.vm.id, null)
    assert.equal((await post(`${prefix}/vms/vm-01/deactivate`)).status, 200)
    assert.equal((await post(`${prefix}/vms/vm-02/activate`)).status, 200)
    assert.equal(getActiveVmId(project), 'vm-02')
    assert.equal(cfg.vm.id, 'vm-02')
  })

  test(`${prefix}: stale deactivate request preserves another active VM`, async () => {
    assert.equal((await post(`${prefix}/vms/vm-02/deactivate`)).status, 200)
    assert.equal(getActiveVmId(project), 'vm-01')
    assert.equal(cfg.vm.id, 'vm-01')
    assert.equal(new VmsRepo().getActiveVmId(), 'vm-01')
  })

  test(`${prefix}: nonexistent VM returns 404`, async () => {
    assert.equal((await post(`${prefix}/vms/vm-missing/deactivate`)).status, 404)
    assert.equal(getActiveVmId(project), 'vm-01')
  })
}

for (const role of ['user', 'super']) {
  test(`panel: ${role} cannot change global active pointer`, async () => {
    assert.equal((await post('/api/panel/vms/vm-01/deactivate', role)).status, 403)
    assert.equal(getActiveVmId(project), 'vm-01')
  })
}
