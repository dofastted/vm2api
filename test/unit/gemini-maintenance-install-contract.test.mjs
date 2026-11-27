import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('prepare_gemini_maintenance atomically installs gemini_host_apparmor.py beside daemon', () => {
  const script = fs.readFileSync(path.join(root, 'deploy/install.sh'), 'utf8')
  const start = script.indexOf('prepare_gemini_maintenance() (')
  assert.ok(start >= 0)
  const end = script.indexOf('\n)', start)
  const block = script.slice(start, end)
  assert.match(block, /"\$root\/scripts\/gemini_host_apparmor\.py"/, 'trust check must cover deployed apparmor helper')
  assert.match(
    block,
    /atomic_maintenance_file "\$bundle\/scripts\/gemini_host_apparmor\.py" "\$root\/scripts\/gemini_host_apparmor\.py" 644/,
    'bootstrap must commit apparmor helper into maintenance scripts dir',
  )
  assert.match(block, /"\$backup\/apparmor\.py"/, 'rollback must restore prior apparmor helper')
})
