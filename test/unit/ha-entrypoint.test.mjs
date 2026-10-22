import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

test('HA image startup stages only local config and requires shared secrets without Docker or payload writes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-648-ha-entrypoint-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const image = path.join(root, 'image')
  const project = path.join(root, 'project')
  const bin = path.join(root, 'stub-bin')
  fs.mkdirSync(path.join(image, 'image-config'), { recursive: true })
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(image, 'image-config', 'routing.json'), '{}')
  const called = path.join(root, 'node-called')
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nprintf '%s\\n' "$*" > '${called}'\n`, { mode: 0o700 })
  const source = fs.readFileSync(new URL('../../scripts/docker-entrypoint.sh', import.meta.url), 'utf8')
  const script = path.join(root, 'entrypoint.sh')
  // Relocate only the image's absolute fixture path; execute the actual shell logic.
  fs.writeFileSync(script, source.replaceAll('/opt/vm2api', image))
  const env = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    VM2API_CONTROL_PLANE_MODE: 'kubernetes-ha',
    KIN_PROJECT_ROOT: project,
    VM2API_DATABASE_URL: 'postgresql://synthetic@127.0.0.1:1/unreachable_test',
    VM2API_API_KEY: 'synthetic-ha-key',
    VM2API_ADMIN_PASSWORD: 'synthetic-ha-password',
    VM2API_DB_SECRET: 'synthetic-ha-encryption-secret',
  }
  const result = spawnSync('sh', [script], { env, encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(fs.readFileSync(called, 'utf8').trim(), 'src/server.mjs')
  assert.equal(fs.readFileSync(path.join(project, 'src/config/routing.json'), 'utf8'), '{}')
  assert.equal(fs.existsSync(path.join(project, 'bin')), false)
  assert.equal(fs.existsSync(path.join(project, 'share')), false)
  assert.equal(fs.existsSync(path.join(project, '.env')), false)
  fs.rmSync(called)
  delete env.VM2API_DB_SECRET
  delete env.KIN_DB_SECRET
  const refused = spawnSync('sh', [script], { env, encoding: 'utf8', timeout: 10_000 })
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /VM2API_DB_SECRET/)
  assert.equal(fs.existsSync(called), false, 'missing shared encryption key cannot start a divergent replica')
})
