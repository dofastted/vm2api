import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

function seed(root, vm) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${vm.id}.json`), JSON.stringify({ status: 'stopped', policy: {}, ...vm }))
}

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-exit-probe-'))
  const lookups = []
  const pool = await new ProxyPool({
    dataDir: path.join(root, 'data'),
    vmNodeOf: (vmId) => JSON.parse(fs.readFileSync(path.join(root, 'vms', `${vmId}.json`), 'utf8')).node_id || null,
    localExitUrl: (nodeId) => `socks5h://${nodeId}@127.0.0.1:1080`,
    geoLookup: async (url) => {
      lookups.push(url)
      return { ok: true, geo: { ip: '203.0.113.9', country: 'Japan', city: 'Tokyo', timezone: 'Asia/Tokyo' } }
    },
    geoV6Lookup: async () => ({ ok: false, error: 'no_v6' }),
  }).init()
  pool.stopScheduler()
  t.after(() => {
    pool.stopScheduler()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: root }, vm: { id: null } },
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
    readBody: async () => ({}),
    proxyPool: pool,
  })
  const probe = (id) =>
    handlePanel({ method: 'POST' }, {}, new URL(`http://localhost/api/panel/vms/${id}/exit-probe`)).then(() => response)
  return { root, pool, probe, lookups }
}

test('an unbound slot has no exit to probe', async (t) => {
  const { root, probe, lookups } = await setup(t)
  seed(root, { id: 'vm-free', proxy: null })
  const res = await probe('vm-free')
  assert.equal(res.status, 502)
  assert.equal(res.body.error.code, 'proxy_required')
  assert.deepEqual(lookups, [])
})

test('a node slot on local egress probes its own node row and refreshes it', async (t) => {
  const { root, pool, probe, lookups } = await setup(t)
  seed(root, { id: 'vm-tokyo', node_id: 'node-a', proxy: { id: 'px-local', host: 'local', scheme: 'local' } })
  pool.ensureLocal()
  assert.equal(pool.bind('px-local', 'vm-tokyo').proxy.id, 'px-local-node-a')
  const res = await probe('vm-tokyo')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.data.via, 'node')
  assert.equal(res.body.data.proxy_id, 'px-local-node-a')
  assert.equal(res.body.data.geo.ip, '203.0.113.9')
  assert.deepEqual(lookups, ['socks5h://node-a@127.0.0.1:1080'])
  // The pool page reads the same answer from the node's row.
  assert.equal(pool.proxyTimezone('px-local-node-a'), 'Asia/Tokyo')
})

test('a control-plane Codex slot is probed through the deployment proxy', async (t) => {
  const { root, pool, probe, lookups } = await setup(t)
  const saved = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = 'socks5://deploy.example:1080'
  t.after(() => {
    if (saved === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = saved
  })
  seed(root, {
    id: 'vm-gpt',
    platform: 'openai',
    family: 'codex',
    proxy: { id: 'px-local', host: 'local', scheme: 'local' },
  })
  pool.ensureLocal()
  pool.bind('px-local', 'vm-gpt')
  const res = await probe('vm-gpt')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.data.via, 'deploy_proxy')
  assert.deepEqual(lookups, ['socks5h://deploy.example:1080'])
  // The control plane row keeps its own (host route) geo untouched.
  assert.equal(pool.proxyTimezone('px-local'), '')
})
