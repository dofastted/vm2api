import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway, api } from '../harness.mjs'

test('the mock gateway never invokes host Docker network or iptables commands', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-boundary-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const trace = path.join(root, 'commands.log')
  for (const command of ['docker', 'iptables']) {
    const file = path.join(bin, command)
    fs.writeFileSync(
      file,
      `#!/bin/sh\nprintf '${command} %s\\n' "$1" >> "$VM2API_TEST_COMMAND_TRACE"\necho 'test boundary refuses host operations' >&2\nexit 1\n`,
      { mode: 0o700 },
    )
  }
  const gw = await startGateway({
    project: path.join(root, 'project'),
    env: {
      PATH: bin + path.delimiter + process.env.PATH,
      VM2API_TEST_COMMAND_TRACE: trace,
      KIN_BACKUP_DISABLED: '1',
    },
  })
  try {
    const health = await fetch(gw.baseUrl + '/health')
    assert.equal(health.status, 200)
    const commands = [trace, gw.runtimeCallsFile].filter(Boolean).flatMap((file) => {
      try {
        return fs.readFileSync(file, 'utf8').trim().split('\n')
      } catch {
        return []
      }
    })
    assert.deepEqual(
      commands.filter((line) => /^(docker network|iptables\b)/.test(line)),
      [],
    )
    const vms = await api(gw, 'GET', '/admin/vms')
    assert.equal(vms.status, 200, vms.text)
  } finally {
    await gw.stop()
  }
})
