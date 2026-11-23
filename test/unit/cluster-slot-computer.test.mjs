import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clusterComputerPolicy, slotContainerBody } from '../../src/lib/cluster/remote-slot.mjs'
import {
  clusterComputerBinds,
  hasClusterComputerBinds,
  localComputerFiles,
} from '../../src/lib/cluster/slot-computer-files.mjs'

const remoteDir = '/root/.vm2api/vms/cf-test'

function project({ complete = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-computer-'))
  const system = path.join(root, 'vms', 'cf-test', 'kvm', 'fingerprint', 'system')
  fs.mkdirSync(path.join(system, 'etc'), { recursive: true })
  fs.mkdirSync(path.join(system, 'dmi', 'id'), { recursive: true })
  fs.mkdirSync(path.join(system, 'hardware'), { recursive: true })
  if (complete) fs.writeFileSync(path.join(system, 'etc', 'kin-computer'), 'hostname=ms-7851-c962dd\n')
  fs.writeFileSync(path.join(system, 'dmi', 'id', 'sys_vendor'), 'MSI\n')
  fs.writeFileSync(path.join(system, 'dmi', 'id', 'product_name'), 'MS-7851\n')
  fs.writeFileSync(path.join(system, 'hardware', 'mac'), '02:42:ac:11:00:02\n')
  fs.symlinkSync('/etc/shadow', path.join(system, 'hardware', 'leak'))
  return root
}

const vm = (seed_policy = {}) => ({
  id: 'cf-test',
  platform: 'anthropic',
  node_id: 'node-a',
  kernel: 'debian-12',
  runtime: { type: 'docker' },
  seed_policy,
})

function body(computer) {
  return slotContainerBody(vm(), {
    image: 'vm2api/kin-slot-debian-12:abc',
    network: 'kin-cf-test-net',
    remoteDir,
    user: '10001:987',
    routing: {},
    computer,
  })
}

test('cluster Docker slots bind the computer identity read-only like a local slot', () => {
  const binds = body(true).HostConfig.Binds
  for (const bind of clusterComputerBinds(remoteDir)) assert.ok(binds.includes(bind), bind)
  assert.ok(binds.includes(`${remoteDir}/computer/etc/kin-computer:/etc/kin-computer:ro`))
  assert.ok(binds.includes(`${remoteDir}/computer/dmi/id:/etc/kin-dmi:ro`))
  assert.ok(binds.includes(`${remoteDir}/computer/hardware:/etc/kin-hardware:ro`))
  assert.equal(hasClusterComputerBinds(body(true), remoteDir), true)
})

test('without a published identity the container layout is unchanged', () => {
  const binds = body(false).HostConfig.Binds
  assert.equal(
    binds.some((b) => b.includes('/etc/kin-')),
    false,
  )
  assert.equal(hasClusterComputerBinds(body(false), remoteDir), false)
})

test('only regular files of a complete local identity are published', () => {
  const root = project()
  const files = localComputerFiles(root, vm())
  assert.deepEqual(
    files.map((f) => f.rel),
    ['etc/kin-computer', 'dmi/id/product_name', 'dmi/id/sys_vendor', 'hardware/mac'],
  )
  assert.equal(localComputerFiles(project({ complete: false }), vm()), null)
})

test('a running slot is recreated for the identity only when its telemetry is on', () => {
  const root = project()
  assert.deepEqual(clusterComputerPolicy(root, vm({ telemetry_disabled: true })), { computer: true, required: false })
  assert.deepEqual(clusterComputerPolicy(root, vm({ telemetry_disabled: false })), { computer: true, required: true })
  const missing = project({ complete: false })
  assert.deepEqual(clusterComputerPolicy(missing, vm({ telemetry_disabled: false })), {
    computer: false,
    required: false,
  })
  assert.deepEqual(clusterComputerPolicy(root, { ...vm({ telemetry_disabled: false }), runtime: { type: 'kvm' } }), {
    computer: false,
    required: false,
  })
})
