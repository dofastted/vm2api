import '../fixtures/kin-computer-test-env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { seedEncryptedPackage } from '../fixtures/crag-license.mjs'

const GiB = 1024 ** 3

function createVm(project, body, extra = {}) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project } },
    routingConfig: extra.routingConfig,
    ...(extra.pickPlacement ? { pickPlacement: extra.pickPlacement } : {}),
    ...(extra.clusterManager ? { clusterManager: extra.clusterManager } : {}),
    ...(extra.readLocalHost ? { readLocalHost: extra.readLocalHost } : {}),
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
    readBody: async () => body,
    proxyPool: {
      allocateForVm() {
        throw new Error('no healthy SOCKS5')
      },
      getProxyForVm() {
        return null
      },
    },
  })
  return handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create')).then(() => response)
}

const AUTO = { cluster: { auto_placement: { enabled: true } } }
const BODY = { runtime_type: 'docker', start: false, auto_allocate_proxy: false }

function withProject(fn, { packages = true } = {}) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-place-'))
    try {
      if (packages && process.platform === 'linux' && process.arch === 'x64') {
        const wrap = path.join(root, 'share/wrap-cli')
        fs.mkdirSync(wrap, { recursive: true })
        for (const file of ['kin-kernel.bin', 'cli-node']) fs.writeFileSync(path.join(wrap, file), 'fixture')
        seedEncryptedPackage(root)
      }
      await fn(root)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

const saved = (root, id) => JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))

test(
  'auto placement puts the slot on the chosen node and reports why',
  withProject(async (root) => {
    let released = 0
    let seen = null
    const response = await createVm(root, BODY, {
      routingConfig: AUTO,
      pickPlacement: async (args) => {
        seen = args
        return {
          node_id: 'node-a',
          release: () => {
            released += 1
          },
          report: { mode: 'auto', chosen: 'node-a', candidates: [], fallback: false },
        }
      },
    })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(saved(root, response.body.data.vm.id).node_id, 'node-a')
    assert.equal(response.body.data.placement.chosen, 'node-a')
    assert.equal(released, 1)
    assert.equal(seen.policy.enabled, true)
    assert.equal(typeof seen.preflight, 'function')
  }),
)

test(
  'placement=local or auto off never consults auto placement',
  withProject(async (root) => {
    const pickPlacement = async () => {
      throw new Error('must not be called')
    }
    for (const [body, routingConfig] of [
      [{ ...BODY, placement: 'local' }, AUTO],
      [BODY, {}],
    ]) {
      const response = await createVm(root, body, { routingConfig, pickPlacement })
      assert.equal(response.status, 200, JSON.stringify(response.body))
      assert.equal(saved(root, response.body.data.vm.id).node_id, undefined)
      assert.equal(response.body.data.placement, undefined)
    }
  }),
)

test(
  'a node whose preflight fails is skipped; with no room left the slot stays local',
  withProject(async (root) => {
    const node = {
      id: 'node-a',
      platform: 'linux',
      link: { state: 'ready' },
      health: { docker: { ok: true }, host: { cpu_count: 8, load1: 0, mem_total: 128 * GiB, mem_used: 0 } },
    }
    const response = await createVm(root, BODY, {
      routingConfig: AUTO,
      clusterManager: { list: () => [node] },
      // Too small for even one slot: forces the fallback path.
      readLocalHost: () => ({ cpu_count: 8, load1: 0, mem_total: 0.25 * GiB, mem_used: 0 }),
    })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(saved(root, response.body.data.vm.id).node_id, undefined)
    const report = response.body.data.placement
    assert.equal(report.fallback, true)
    assert.equal(report.candidates.find((r) => r.id === 'node-a').reason, 'preflight_failed')
  }),
)

test('auto placement releases its reservation when required packages are missing', async (t) => {
  if (process.platform !== 'linux' || process.arch !== 'x64') return t.skip('requires Linux amd64')
  await withProject(
    async (root) => {
      let released = 0
      const response = await createVm(root, BODY, {
        routingConfig: AUTO,
        pickPlacement: async () => ({
          node_id: null,
          release: () => {
            released += 1
          },
          report: { mode: 'auto', chosen: 'local' },
        }),
      })
      assert.equal(response.status, 409)
      assert.equal(response.body.error.code, 'kernel_package_missing')
      assert.equal(released, 1)
      assert.equal(fs.existsSync(path.join(root, 'vms/vm-01.json')), false)
    },
    { packages: false },
  )()
})

test(
  'on_full=reject refuses the create without writing a slot',
  withProject(async (root) => {
    const response = await createVm(root, BODY, {
      routingConfig: { cluster: { auto_placement: { enabled: true, on_full: 'reject' } } },
      clusterManager: { list: () => [] },
      readLocalHost: () => ({ cpu_count: 8, load1: 0, mem_total: 0.25 * GiB, mem_used: 0 }),
    })
    assert.equal(response.status, 409)
    assert.equal(response.body.error.code, 'placement_no_capacity')
    assert.deepEqual(
      fs.readdirSync(path.join(root, 'vms')).filter((f) => f.endsWith('.json')),
      [],
    )
  }),
)
