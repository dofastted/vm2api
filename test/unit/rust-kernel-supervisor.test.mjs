import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clusterProbeMs } from '../../src/lib/transport/rust-kernel-supervisor.mjs'

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
