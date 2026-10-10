import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { clearReleaseCache } from '../../src/lib/admin/release.mjs'

test('panel version remains the loaded backend version until a new handler boots', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-update-'))
  clearReleaseCache()
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ tag_name: 'v1.2.7' }),
  }))
  try {
    fs.writeFileSync(path.join(project, 'VERSION'), '1.2.6\n')
    const response = {}
    const context = {
      cfg: { paths: { project } },
      routingConfig: {},
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, payload) {
        response.status = status
        response.body = payload
        return true
      },
      readBody: async () => ({ confirm: false }),
    }
    const oldBackend = createPanelHandler(context)
    fs.writeFileSync(path.join(project, 'VERSION'), '1.2.7\n')
    await oldBackend({ method: 'GET' }, {}, new URL('http://localhost/api/panel/version'))
    assert.equal(response.status, 200)
    assert.equal(response.body.data.current, '1.2.6')
    assert.equal(response.body.data.update_available, true)
    await oldBackend({ method: 'GET' }, {}, new URL('http://localhost/api/panel/me'))
    assert.equal(response.body.data.version, '1.2.6')
    await oldBackend({ method: 'GET' }, {}, new URL('http://localhost/api/panel/changelog'))
    assert.equal(response.body.data.current, '1.2.6')
    await oldBackend({ method: 'POST' }, {}, new URL('http://localhost/api/panel/update'))
    assert.equal(response.body.data.current, '1.2.6')
    assert.equal(response.body.data.update_available, true)
    const newBackend = createPanelHandler(context)
    await newBackend({ method: 'GET' }, {}, new URL('http://localhost/api/panel/version'))
    assert.equal(response.body.data.current, '1.2.7')
    assert.equal(response.body.data.update_available, false)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
    clearReleaseCache()
  }
})
