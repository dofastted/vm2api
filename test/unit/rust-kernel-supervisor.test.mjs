import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clusterProbeMs, writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'

test('clusterProbeMs keeps the local budget for local slots', () => {
  const local = { vm: { id: 'vm-01' } }
  assert.equal(clusterProbeMs(local, 400), 400)
  assert.equal(clusterProbeMs(local, 1500), 1500)
})

test('clusterProbeMs floors cluster-slot probes at 3s', () => {
  const cluster = { vm: { id: 'vm-19', node_id: 'node-22ff49a5' } }
  assert.equal(clusterProbeMs(cluster, 400), 3000)
  assert.equal(clusterProbeMs(cluster, 1500), 3000)
  // An already generous budget is not shrunk.
  assert.equal(clusterProbeMs(cluster, 5000), 5000)
})

test('clusterProbeMs tolerates a missing vm object', () => {
  assert.equal(clusterProbeMs({}, 400), 400)
  assert.equal(clusterProbeMs(null, 400), 400)
})

test('writeKernelConfig writes configured slot locale alongside timezone', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sup-locale-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routing = { inference: { engine: 'rust', dataplane: 'crag', crag_kernel_version: 'v2' } }
  const written = writeKernelConfig(
    root,
    { id: 'vm-loc-1', dataplane: 'crag', timezone: 'Asia/Shanghai', locale: 'zh-CN' },
    { routing, token: 'tok-loc', publish: false },
  )
  const doc = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(doc.timezone, 'Asia/Shanghai')
  assert.equal(doc.locale, 'zh-CN')
})
