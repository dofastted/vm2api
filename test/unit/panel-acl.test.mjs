import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authorizePanelRoute, viewsForRole, hasCapability, canViewPage } from '../../src/lib/admin/panel-acl.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

const serverSrc = [
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/lib/admin/panel-routes.mjs'),
    'utf8',
  ),
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/server.mjs'), 'utf8'),
].join('\n')

test('user sees vm / proxies / keys / billing / logs', () => {
  assert.deepEqual(viewsForRole('user'), ['vm', 'proxies', 'keys', 'billing', 'logs'])
  assert.equal(canViewPage('user', 'vm'), true)
  assert.equal(canViewPage('user', 'overview'), false)
  assert.equal(canViewPage('super', 'vm'), true)
  assert.equal(canViewPage('admin', 'users'), false)
  assert.equal(canViewPage('admin', 'api'), true)
  assert.equal(canViewPage('user', 'api'), false)
  assert.equal(canViewPage('admin', 'database'), true)
  assert.equal(canViewPage('super', 'database'), false)
  assert.equal(canViewPage('user', 'database'), false)
  assert.equal(hasCapability('super', 'vm.schedule'), true)
  assert.equal(hasCapability('user', 'vm.schedule'), true)
})

test('user can manage owned vm/proxy/key surfaces and nothing else', () => {
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms', 'user').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01', 'user').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/create', 'user').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/schedulable', 'user').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/import', 'user').ok, true)
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-01', 'user').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/proxies', 'user').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/api-keys', 'user').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/request-logs', 'user').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/dashboard', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/usage', 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/official-cc-bootstrap', 'user').ok, false)
  assert.equal(authorizePanelRoute('PATCH', '/api/panel/vms/vm-01/owner', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/users', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/database/metrics', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/version', 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/update', 'user').ok, false)
})

test('super can schedule VMs but cannot touch credentials or delete', () => {
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01', 'super').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/schedulable', 'super').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/cooldown/clear', 'super').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/circuit/reset', 'super').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/import', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/oauth/refresh', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/oauth/generate-auth-url', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/oauth/exchange-code', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-01/oauth/to-setup-token', 'super').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01/oauth/credential', 'super').ok, false)
  assert.equal(authorizePanelRoute('PUT', '/api/panel/vms/vm-01/oauth/credential', 'super').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01/oauth/credential', 'user').ok, false)
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-01', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/create', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/users', 'super').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/database/metrics', 'super').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/version', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/update', 'super').ok, false)
})

test('admin is unrestricted', () => {
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-01', 'admin').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/settings', 'admin').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/import', 'admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/database/metrics', 'admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/version', 'admin').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/update', 'admin').ok, true)
})

test('managed keys cannot bypass admin role checks through models refresh', async () => {
  let authCalls = 0
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: {},
    requireAuth(req) {
      authCalls += 1
      req.apiKeyKind = 'managed'
      return true
    },
    json(_res, status, body) {
      response.status = status
      response.body = body
    },
  })

  const handled = await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/admin/models/refresh'))
  assert.equal(authCalls, 1)
  assert.equal(handled, true)
  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'forbidden')
})

test('admin models refresh stays delegated to the server route', async () => {
  let authCalls = 0
  const handlePanel = createPanelHandler({
    cfg: {},
    requireAuth(req) {
      authCalls += 1
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json() {
      assert.fail('delegated admin refresh must not respond in the panel handler')
    },
  })

  const handled = await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/admin/models/refresh'))
  assert.equal(authCalls, 1)
  assert.equal(handled, false)
})

test('ACL schedule POSTs have matching server handlers', () => {
  assert.match(serverSrc, /clearVmCooldown/)
  assert.match(serverSrc, /cooldown\\\/clear/)
  assert.match(serverSrc, /\/schedulable\$/)
})
