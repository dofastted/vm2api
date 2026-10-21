import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('HA accepts fixed bootstrap TLS policy and refuses missing or mutable VM-derived trust', async (t) => {
  const { loadHaNodeTrust } = await import('../../src/lib/core/ha-control-plane-policy.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ha-trust-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'nodes.json')
  const nodes = { 'ha-node': {
    address: '127.0.0.1', port: 19999, token: 'synthetic-transport-token',
    certSha256: 'a'.repeat(64), presetId: 'claude-docker-v1', policyDigest: 'b'.repeat(64),
  } }
  fs.writeFileSync(file, JSON.stringify({ nodes }), { mode: 0o600 })
  const fixed = loadHaNodeTrust(file)
  assert.equal(fixed['ha-node'].certSha256, 'a'.repeat(64))
  assert.ok(Object.isFrozen(fixed['ha-node']))
  nodes['ha-node'].token = 'changed'
  fs.writeFileSync(file, JSON.stringify({ nodes }))
  assert.equal(fixed['ha-node'].token, 'synthetic-transport-token')
  assert.throws(() => loadHaNodeTrust(), { code: 'ha_node_trust_unavailable' })
  fs.writeFileSync(file, JSON.stringify({ nodes: { 'ha-node': { ...nodes['ha-node'], presetId: 'native' } } }))
  assert.throws(() => loadHaNodeTrust(file), { code: 'ha_node_trust_unavailable' })
})

test('HA permits normal inference and PG metadata while refusing legacy management before dispatch', async () => {
  const { haRouteAllowed, assertHaRoutingPatch } = await import('../../src/lib/core/ha-control-plane-policy.mjs')
  for (const p of ['/v1/messages', '/messages', '/v1/chat/completions', '/v1/responses']) {
    assert.equal(haRouteAllowed('POST', p), true, p)
  }
  assert.equal(haRouteAllowed('GET', '/v1/responses', { upgrade: true }), true)
  assert.equal(haRouteAllowed('GET', '/api/panel/pool/stream'), true)
  assert.equal(haRouteAllowed('PUT', '/api/panel/routing'), true)
  assert.equal(haRouteAllowed('POST', '/api/panel/login'), true)
  for (const [method, p] of [
    ['POST', '/api/panel/vms/create'], ['POST', '/api/panel/vms/import'],
    ['POST', '/admin/vms/probe-all'], ['POST', '/api/panel/proxies'],
    ['GET', '/api/panel/vms/create-options'], ['GET', '/api/panel/oauth'],
    ['POST', '/api/panel/update'], ['POST', '/api/panel/backups'],
    ['POST', '/v1/alpha/search'], ['POST', '/v1/messages/count_tokens'],
    ['GET', '/api/panel/cluster/nodes/ha-node/shell'],
  ]) assert.equal(haRouteAllowed(method, p), false, p)
  assert.equal(haRouteAllowed('GET', '/api/panel/vms/x/shell', { upgrade: true }), false)
  assert.doesNotThrow(() => assertHaRoutingPatch({ pool: { queue_max: 4 }, concurrency: { default_max_per_account: 1 } }))
  for (const patch of [{ telemetry: {} }, { vm: {} }, { inference: {} }, { official_cc: {} }, { compatibility: {} }]) {
    assert.throws(() => assertHaRoutingPatch(patch), { code: 'ha_operation_unsupported' })
  }
})
