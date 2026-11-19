import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { startGateway } from '../harness.mjs'

async function stopGateway(gateway) {
  if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) return
  const exited = once(gateway.child, 'exit')
  gateway.child.kill('SIGKILL')
  await exited
}

test('two control planes sharing egress state cannot run, even on different ports', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-owner-'))
  let host, replacement
  t.after(async () => {
    if (host) await stopGateway(host)
    if (replacement) await stopGateway(replacement)
    fs.rmSync(project, { recursive: true, force: true })
  })
  host = await startGateway({ project, readyMs: 20_000, env: { KIN_EGRESS_RUNTIME: 'process' } })
  const startContainerRuntime = () =>
    startGateway({
      project,
      readyMs: 20_000,
      env: { KIN_EGRESS_RUNTIME: 'container', KIN_DATA_DIR: path.join(project, 'other-db') },
    })
  await assert.rejects(async () => {
    const contender = await startContainerRuntime()
    await stopGateway(contender)
  }, /vm2api_control_plane_already_running/)
  assert.equal(fs.existsSync(path.join(project, 'other-db')), false, 'reject before opening SQLite')

  const bootstrap = spawnSync('sh', ['scripts/docker-entrypoint.sh'], {
    env: { ...process.env, KIN_PROJECT_ROOT: project },
    encoding: 'utf8',
    timeout: 3000,
  })
  assert.equal(bootstrap.status, 75, bootstrap.stderr)
  assert.match(bootstrap.stderr, /vm2api_control_plane_already_running/)
  assert.equal(fs.existsSync(path.join(project, 'bin')), false, 'rejected bootstrap must not touch shared binaries')
  assert.equal((await fetch(`${host.baseUrl}/health`)).status, 200)

  await stopGateway(host)
  replacement = await startContainerRuntime()
  assert.equal((await fetch(`${replacement.baseUrl}/health`)).status, 200)
})
