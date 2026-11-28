// Fork: control-plane KVM slots (no node_id, CRAG included) can be resized in place.
import test from 'node:test'
import assert from 'node:assert/strict'
import { migrationRequest, LOCAL_TARGET } from '../../src/lib/cluster/slot-migration.mjs'
import {
  LOCAL_RESIZE_IDENTITY_KEYS,
  identityDrift,
  rollbackLocalResize,
  verifyLocalResize,
} from '../../src/lib/vm/slot-resize-local.mjs'

const local = (extra = {}) => ({
  id: 'vm-local',
  status: 'running',
  runtime_type: 'kvm',
  machine: { memory: '2g' },
  ...extra,
})
const crag = { dataplane: 'crag' }

test('local slot: only in-place growth, CRAG allowed', () => {
  assert.deepEqual(migrationRequest(local(), { target_node_id: LOCAL_TARGET, memory: '4g' }, {}), {
    targetNodeId: 'local',
    memory: '4g',
  })
  assert.deepEqual(
    migrationRequest(local(crag), { target_node_id: 'local', memory: '4g' }, { inference: { dataplane: 'crag' } })
      .memory,
    '4g',
  )
  for (const body of [
    { target_node_id: 'node-b', memory: '4g' },
    { target_node_id: 'local', memory: '2g' },
    { target_node_id: 'local', memory: '1g' },
  ])
    assert.throws(() => migrationRequest(local(), body, {}))
  assert.throws(() =>
    migrationRequest({ ...local(), node_id: 'node-a' }, { target_node_id: 'local', memory: '4g' }, {}),
  )
  assert.throws(
    () => migrationRequest(local({ runtime_type: 'docker' }), { target_node_id: 'local', memory: '4g' }, {}),
    { code: 'migration_unsupported' },
  )
})

const env = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`)
const base = {
  KIN_VM_ID: 'vm-local',
  KIN_KVM_MAC: '52:54:00:aa:bb:cc',
  KIN_KVM_DISK_SERIAL: 'S1',
  KIN_KVM_MEMORY_MB: '2048',
  KIN_KVM_HOSTNAME: 'h',
}

test('identity drift ignores memory but catches MAC / serial / hostname changes', () => {
  const before = { Config: { Env: env(base) } }
  assert.deepEqual(identityDrift(before, { Config: { Env: env({ ...base, KIN_KVM_MEMORY_MB: '4096' }) } }), [])
  assert.deepEqual(identityDrift(before, { Config: { Env: env({ ...base, KIN_KVM_MAC: '52:54:00:00:00:01' }) } }), [
    'KIN_KVM_MAC',
  ])
})

test('WU-3C identity drift tracks KIN_SLOT_{USER,UID,GID} and KIN_KVM_KERNEL_TRACK while keeping legacy kincli compatible', async () => {
  for (const key of ['KIN_SLOT_USER', 'KIN_SLOT_UID', 'KIN_SLOT_GID', 'KIN_KVM_KERNEL_TRACK']) {
    assert.ok(LOCAL_RESIZE_IDENTITY_KEYS.includes(key), `missing identity key ${key}`)
  }
  // Legacy containers omitting all 4 WU-3C keys stay 100% drift-free.
  const legacyBefore = { Config: { Env: env(base) } }
  const legacyAfter = { Config: { Env: env({ ...base, KIN_KVM_MEMORY_MB: '4096' }) } }
  assert.deepEqual(identityDrift(legacyBefore, legacyAfter), [])

  const newBase = {
    ...base,
    KIN_SLOT_USER: 'mchen',
    KIN_SLOT_UID: '1000',
    KIN_SLOT_GID: '1000',
    KIN_KVM_KERNEL_TRACK: 'official',
  }
  const before = { Config: { Env: env(newBase) } }
  assert.deepEqual(identityDrift(before, { Config: { Env: env({ ...newBase, KIN_KVM_MEMORY_MB: '4096' }) } }), [])
  assert.deepEqual(identityDrift(before, { Config: { Env: env({ ...newBase, KIN_SLOT_USER: 'alex' }) } }), [
    'KIN_SLOT_USER',
  ])
  assert.deepEqual(
    identityDrift(before, { Config: { Env: env({ ...newBase, KIN_SLOT_UID: '999', KIN_SLOT_GID: '987' }) } }),
    ['KIN_SLOT_UID', 'KIN_SLOT_GID'],
  )
  assert.deepEqual(identityDrift(before, { Config: { Env: env({ ...newBase, KIN_KVM_KERNEL_TRACK: 'custom' }) } }), [
    'KIN_KVM_KERNEL_TRACK',
  ])

  const img = 'sha256:' + 'a'.repeat(64)
  const plan = { name: 'kin-local', sourceInfo: { Id: 'old', Image: img, Config: { Env: env(newBase) } } }
  const drifted = {
    Id: 'new',
    Name: '/kin-local',
    Image: img,
    State: { Running: true },
    Config: { Env: env({ ...newBase, KIN_SLOT_USER: 'otheruser' }) },
  }
  await assert.rejects(verifyLocalResize(plan, { docker: fakeDocker([drifted]).docker }), {
    code: 'migration_identity_changed',
  })
})

function fakeDocker(containers) {
  const calls = []
  const docker = (argv) => {
    calls.push(argv.join(' '))
    const [cmd, ...rest] = argv
    if (cmd === 'inspect') {
      const c = containers.find((x) => x.Id === rest[0] || x.Name === '/' + rest[0])
      return c ? { ok: true, stdout: JSON.stringify([c]) } : { ok: false }
    }
    if (cmd === 'rm') {
      const i = containers.findIndex((x) => x.Id === rest.at(-1))
      if (i >= 0) containers.splice(i, 1)
      return { ok: true }
    }
    if (cmd === 'rename') {
      containers.find((x) => x.Id === rest[0]).Name = '/' + rest[1]
      return { ok: true }
    }
    return { ok: true }
  }
  return { docker, calls }
}

test('verify needs the same base image and identity; rollback restores the original under its name', async () => {
  const img = 'sha256:' + 'a'.repeat(64)
  const plan = { name: 'kin-local', sourceInfo: { Id: 'old', Image: img, Config: { Env: env(base) } } }
  const fresh = {
    Id: 'new',
    Name: '/kin-local',
    Image: img,
    State: { Running: true },
    Config: { Env: env({ ...base, KIN_KVM_MEMORY_MB: '4096' }) },
  }
  const kept = {
    Id: 'old',
    Name: '/kin-local-resize-j',
    Image: img,
    State: { Running: false },
    Config: { Env: env(base) },
  }
  await verifyLocalResize(plan, { docker: fakeDocker([fresh, kept]).docker })
  await assert.rejects(
    verifyLocalResize(plan, { docker: fakeDocker([{ ...fresh, Image: 'sha256:' + 'b'.repeat(64) }]).docker }),
    { code: 'migration_image_mismatch' },
  )
  const containers = [fresh, kept]
  const { docker, calls } = fakeDocker(containers)
  await rollbackLocalResize(plan, { docker })
  assert.deepEqual(
    containers.map((c) => [c.Id, c.Name]),
    [['old', '/kin-local']],
  )
  assert.ok(calls.includes('rm -f new'))
})
