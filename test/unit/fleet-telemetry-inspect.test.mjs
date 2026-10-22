import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runFleetUpdate } from '../../src/lib/vm/fleet-update.mjs'
import { restartTelemetrySidecar } from '../../src/lib/vm/slot-process-status.mjs'

function writeSlot(root, id) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      name: id.replace('vm-', ''),
      status: 'running',
      runtime: { type: 'docker', worker: 'go' },
    }),
  )
}

test('restartTelemetrySidecar skips only when inspect confirms the container is missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-miss-'))
  const skipped = await restartTelemetrySidecar({
    projectRoot: root,
    vm: { id: 'vm-11', runtime: { type: 'docker' } },
    enabled: true,
    inspectContainerOutcome: () => ({ status: 'missing' }),
    run: async () => {
      throw new Error('docker exec must not run when the container is absent')
    },
  })
  assert.equal(skipped.skipped, true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('restartTelemetrySidecar fails when inspect cannot reach docker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-daemon-'))
  const failed = await restartTelemetrySidecar({
    projectRoot: root,
    vm: { id: 'vm-12', runtime: { type: 'docker' } },
    enabled: true,
    inspectContainerOutcome: () => ({
      status: 'error',
      error: 'Cannot connect to the Docker daemon',
    }),
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'docker_inspect_failed')
  assert.equal(failed.skipped, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

test('restartTelemetrySidecar fails when the container exists but exec fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-exec-'))
  const failed = await restartTelemetrySidecar({
    projectRoot: root,
    vm: { id: 'vm-13', runtime: { type: 'docker' } },
    enabled: true,
    inspectContainerOutcome: () => ({
      status: 'found',
      container: { name: 'kin-13', running: true },
    }),
    run: async () => {
      throw new Error('permission denied')
    },
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.action, 'restart_failed')
  assert.match(failed.error, /permission denied/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('fleet telemetry fails the batch when local inspect errors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fleet-inspect-'))
  writeSlot(root, 'vm-14')
  const report = await runFleetUpdate(root, {
    action: 'telemetry',
    telemetryFn: async () => ({
      ok: false,
      code: 'docker_inspect_failed',
      error: 'Cannot connect to the Docker daemon',
    }),
  })
  assert.equal(report.failed_count, 1)
  assert.equal(report.skipped_count, 0)
  fs.rmSync(root, { recursive: true, force: true })
})
