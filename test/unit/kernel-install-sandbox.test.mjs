import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  inspectContainerOutcome,
  nativeSlotSandboxNeedsRecreate,
  suspendVmRuntimeRestart,
} from '../../src/lib/vm/vm-runtime.mjs'

const profileUrl = new URL('../../src/lib/vm/crag-v2-seccomp.json', import.meta.url)
const profile = JSON.parse(fs.readFileSync(profileUrl, 'utf8'))
const native = { id: 'vm-13', dataplane: 'crag', crag_kernel_version: 'v2' }
const output = (securityOpts, restart = 'unless-stopped') =>
  `false|0|kin-eg-local||kin-os/ubuntu:24.04|existing-host|docker||false|${restart}|${JSON.stringify(securityOpts)}`
const reorderedProfile = Object.fromEntries(Object.entries(profile).reverse())

test('later native manual start upgrades a default or unconfined container but keeps the exact narrow sandbox', () => {
  for (const securityOpts of [
    [],
    ['no-new-privileges'],
    ['no-new-privileges', 'seccomp=unconfined'],
    ['seccomp={"defaultAction":"SCMP_ACT_ALLOW"}'],
  ]) {
    const observed = inspectContainerOutcome('kin-13', { run: () => ({ ok: true, stdout: output(securityOpts) }) })
    assert.equal(observed.status, 'found')
    assert.equal(nativeSlotSandboxNeedsRecreate(observed.container, native), true)
  }
  for (const seccomp of [
    `seccomp=${JSON.stringify(profile)}`,
    `seccomp=${JSON.stringify(profile, null, 2)}`,
    `seccomp=${JSON.stringify(reorderedProfile)}`,
    `seccomp=${fileURLToPath(profileUrl)}`,
  ]) {
    const observed = inspectContainerOutcome('kin-13', {
      run: () => ({ ok: true, stdout: output(['no-new-privileges', seccomp]) }),
    })
    assert.equal(
      nativeSlotSandboxNeedsRecreate(observed.container, native),
      false,
      'already secured native target must be reused',
    )
  }
  assert.equal(
    nativeSlotSandboxNeedsRecreate(null, native),
    false,
    'new container gets the normal native creation profile',
  )
  assert.equal(nativeSlotSandboxNeedsRecreate({ securityOpts: [] }, { ...native, dataplane: 'wrap' }), false)
  assert.equal(nativeSlotSandboxNeedsRecreate({ securityOpts: [] }, { ...native, runtime: { type: 'kvm' } }), false)
})

test('stopped kernel installation disables only Docker restart policy, without start, reset or recreation', () => {
  const mutations = []
  const result = suspendVmRuntimeRestart(native, {
    run(argv) {
      if (argv[1] === 'inspect') return { ok: true, stdout: output(['no-new-privileges']) }
      mutations.push(argv)
      assert.deepEqual(argv, ['docker', 'update', '--restart', 'no', 'kin-13'])
      return { ok: true }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(mutations.length, 1)
})

test('policy suspension is idempotent and refuses uncertain Docker state rather than replacing a live slot', () => {
  for (const [run, expected] of [
    [
      (argv) => {
        assert.equal(argv[1], 'inspect')
        return { ok: true, stdout: output([], 'no') }
      },
      true,
    ],
    [
      (argv) => {
        assert.equal(argv[1], 'inspect')
        return { ok: false, code: 1, stderr: 'Error: No such object: kin-13' }
      },
      true,
    ],
    [
      (argv) => {
        assert.equal(argv[1], 'inspect')
        return { ok: false, code: 1, stderr: 'permission denied connecting to Docker daemon' }
      },
      false,
    ],
  ]) {
    const result = suspendVmRuntimeRestart(native, { run })
    assert.equal(result.ok, expected)
    if (!expected) assert.equal(result.code, 'kernel_restart_policy_failed')
  }
})
