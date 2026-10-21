import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway } from '../harness.mjs'

test('two HA processes start with PG-only metadata and never enter legacy host bootstrap', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-648-ha-bootstrap-'))
  const gateways = []
  t.after(async () => {
    for (const gateway of gateways.reverse()) await gateway.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const trust = path.join(root, 'nodes.json')
  fs.writeFileSync(trust, JSON.stringify({ nodes: { 'fixture-node': {
    address: '127.0.0.1', port: 19999, token: 'synthetic-bootstrap-token',
    certSha256: 'a'.repeat(64), policyDigest: 'b'.repeat(64), presetId: 'claude-docker-v1',
  } } }), { mode: 0o600 })
  const barrier = path.join(root, 'legacy-effects.log')
  const env = {
    VM2API_CONTROL_PLANE_MODE: 'kubernetes-ha', VM2API_NODE_CONFIG_FILE: trust,
    VM2API_TEST_HOST_BARRIER_FILE: barrier,
    NODE_OPTIONS: `--import=${new URL('../fixtures/ha-no-host-loader.mjs', import.meta.url).href}`,
    KIN_BACKUP_DISABLED: '1',
  }
  for (let index = 0; index < 2; index++) {
    const project = path.join(root, `pod-${index}`)
    fs.mkdirSync(path.join(project, 'vms'), { recursive: true })
    fs.writeFileSync(path.join(project, 'vms', 'active.json'), '{}')
    const gateway = await startGateway({ project, env: { ...env, ...(gateways[0] ? { KIN_DATABASE_SCHEMA: gateways[0].schema } : {}) } })
    gateways.push(gateway)
    assert.equal((await fetch(`${gateway.baseUrl}/readyz`)).status, 200)
  }
  const login = await fetch(`${gateways[0].baseUrl}/api/panel/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'testpass' }),
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(`${gateways[1].baseUrl}/api/panel/me`, { headers: { cookie } })).status, 200)
  const blocked = await fetch(`${gateways[1].baseUrl}/api/panel/vms/create`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(blocked.status, 503)
  assert.equal((await blocked.json()).error.code, 'ha_operation_unsupported')
  assert.equal(fs.existsSync(barrier) ? fs.readFileSync(barrier, 'utf8') : '', '')
  for (const gateway of gateways) {
    assert.equal(fs.existsSync(gateway.runtimeCallsFile) ? fs.readFileSync(gateway.runtimeCallsFile, 'utf8') : '', '')
  }
})
