import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { getDb } from '../../src/lib/db/database.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'

for (const [name, patch, record] of [
  ['invalid size', { memory: '3g' }, {}],
  ['KVM', { memory: '1g' }, { runtime_type: 'kvm', runtime: { type: 'kvm', memory: '512m' } }],
]) {
  test(`memory validation for ${name} returns its unused shared VM claim`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-memory-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.mkdirSync(path.join(root, 'vms'))
    fs.writeFileSync(path.join(root, 'vms/memory-vm.json'), JSON.stringify({
      id: 'memory-vm', status: 'running', machine: { memory: '512m' },
      runtime: { type: 'docker', memory: '512m' }, ...record,
    }))
    const operations = new SharedVmOperations(getDb())
    let status
    const handler = createPanelHandler({
      cfg: { paths: { project: root } }, routingConfig: { vm: { memory: '512m' } },
      vmOperations: operations,
      requireAuth(req) { req.apiKeyKind = 'master'; req.panelRole = 'admin'; return true },
      readBody: async () => patch,
      json(_res, code) { status = code; return true },
      proxyPool: { unbindVm() {} }, accountQuota: { snapshot: () => ({ accounts: [] }) },
    })
    await handler({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/memory-vm'))
    assert.equal(status, 400)
    const next = await new SharedVmOperations(getDb()).tryAcquire({ vmId: 'memory-vm' })
    assert.equal(next.ok, true, 'validation before Docker I/O must not leave an unknown operation')
    await next.release()
  })
}
