import test from 'node:test'
import assert from 'node:assert/strict'
import { destroyVmRuntime, inspectContainerOutcome } from '../../src/lib/vm/vm-runtime.mjs'
import { isDockerInspectNotFound } from '../../src/lib/vm/docker-container.mjs'

test('isDockerInspectNotFound matches docker inspect stderr for absent names', () => {
  assert.equal(isDockerInspectNotFound({ stderr: 'Error: No such object: kin-05' }), true)
  assert.equal(isDockerInspectNotFound({ stderr: 'Error response from daemon: No such container: kin-05' }), true)
  assert.equal(isDockerInspectNotFound({ stderr: 'Cannot connect to the Docker daemon' }), false)
})

test('inspectContainerOutcome: missing container', () => {
  const outcome = inspectContainerOutcome('kin-ghost', {
    run: () => ({
      ok: false,
      stderr: 'Error: No such object: kin-ghost',
      stdout: '',
      code: 1,
    }),
  })
  assert.deepEqual(outcome, { status: 'missing' })
})

test('inspectContainerOutcome: daemon down is an error, not missing', () => {
  const outcome = inspectContainerOutcome('kin-01', {
    run: () => ({
      ok: false,
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
      stdout: '',
      code: 1,
    }),
  })
  assert.equal(outcome.status, 'error')
  assert.match(outcome.error, /Cannot connect/)
})

test('inspectContainerOutcome: found parses running state', () => {
  const outcome = inspectContainerOutcome('kin-01', {
    run: () => ({
      ok: true,
      stdout: 'true|12345|kin-px-net|2026-01-01T00:00:00Z|img|host|docker||false',
      stderr: '',
    }),
  })
  assert.equal(outcome.status, 'found')
  assert.equal(outcome.container.running, true)
  assert.equal(outcome.container.pid, 12345)
})

const containerId = 'a'.repeat(64)
const found = { ok: true, stdout: containerId }
const removed = { ok: true, stdout: containerId }
const missing = { ok: false, code: 1, stderr: 'Error: No such container: kin-01' }
const unavailable = { ok: false, code: 1, stderr: 'Cannot connect to the Docker daemon' }

test('reclaim teardown removes the inspected container ID and confirms absence by name', () => {
  const replies = [found, removed, missing]
  const calls = []
  const outcome = destroyVmRuntime(
    { id: 'vm-01' },
    {
      requireConfirmation: true,
      run(argv) {
        calls.push(argv)
        return replies.shift()
      },
    },
  )
  assert.equal(outcome.teardownConfirmed, true)
  assert.equal(outcome.action, 'removed')
  assert.deepEqual(calls, [
    ['docker', 'container', 'inspect', '--format', '{{.Id}}', 'kin-01'],
    ['docker', 'rm', '-f', containerId],
    ['docker', 'container', 'inspect', '--format', '{{.Id}}', 'kin-01'],
  ])
})

test('no verified teardown on daemon failure, failed removal, or a replaced container', () => {
  for (const replies of [[unavailable], [found, unavailable], [found, removed, unavailable], [found, removed, found]]) {
    const outcome = destroyVmRuntime({ id: 'vm-01' }, { requireConfirmation: true, run: () => replies.shift() })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.teardownConfirmed, undefined)
  }
  const absent = destroyVmRuntime({ id: 'vm-01' }, { requireConfirmation: true, run: () => missing })
  assert.equal(absent.teardownConfirmed, true)
  assert.equal(absent.action, 'absent')
})
