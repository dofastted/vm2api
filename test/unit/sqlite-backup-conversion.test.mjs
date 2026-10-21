import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { createDatabase as sqlite } from '../../src/lib/db/sqlite-legacy.mjs'
let root
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
})
function fixture() {
  root = fs.mkdtempSync('/tmp/vm2api-convert-test-')
  const old = sqlite({ dbPath: root + '/source.db' })
  old.prepare('INSERT INTO vms(id,vm_json) VALUES(?,?)').run('vm-fixture', '{"id":"vm-fixture"}')
  old.close()
  fs.writeFileSync(root + '/source.db.gz', zlib.gzipSync(fs.readFileSync(root + '/source.db')))
  fs.mkdirSync(root + '/vms')
  fs.mkdirSync(root + '/config')
  fs.writeFileSync(root + '/vms/vm-fixture.json', '{"id":"vm-fixture","name":"backup fixture"}')
  fs.writeFileSync(root + '/config/routing.json', '{}')
}
test('old SQLite db-only backup converts to PG v2 only with companion files', async () => {
  fixture()
  const output = root + '/converted.tar.gz'
  const missing = spawnSync(
    process.execPath,
    ['scripts/convert-sqlite-backup.mjs', '--source', root + '/source.db.gz', '--output', output],
    { encoding: 'utf8', env: process.env },
  )
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /requires --vm-dir/)
  assert.equal(fs.existsSync(output), false)
  const converted = spawnSync(
    process.execPath,
    [
      'scripts/convert-sqlite-backup.mjs',
      '--source',
      root + '/source.db.gz',
      '--output',
      output,
      '--vm-dir',
      root + '/vms',
      '--config-dir',
      root + '/config',
    ],
    { encoding: 'utf8', env: process.env },
  )
  assert.equal(converted.status, 0, converted.stderr)
  const manifest = JSON.parse(spawnSync('tar', ['-xOzf', output, './manifest.json'], { encoding: 'utf8' }).stdout)
  assert.equal(manifest.engine, 'postgresql')
  assert.equal(manifest.version, 2)
  assert.deepEqual(manifest.includes, { db: true, vms: 1, config: 1 })
  assert.ok(manifest.sha256s['db/postgres.dump'])
  assert.ok(manifest.sha256s['vms/vm-fixture.json'])
})
