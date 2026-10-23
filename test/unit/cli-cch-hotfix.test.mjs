import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CCH_HOTFIXES, planCliCchHotfix, repairCliCch } from '../../scripts/fix-cli-cch.mjs'

const current = CCH_HOTFIXES.at(-1)
const artifact = process.env.KIN_CCH_CLI || path.resolve(import.meta.dirname, '../../share/wrap-cli/cli-node')

function manifest(fix = current, release = fix.releases[0]) {
  return {
    repo: 'dofastted/vm2api',
    release,
    files: [
      { path: 'bin/kin-kernel', asset: 'kin-kernel', size: 1, sha256: 'unchanged-kernel' },
      { path: 'share/wrap-cli/cli-node', asset: 'cli-node', size: fix.beforeSize, sha256: fix.before },
      { path: 'bin/kin-codex-kernel', asset: 'kin-codex-kernel', size: 2, sha256: 'unchanged-openai' },
    ],
  }
}

function installation(t, value = manifest()) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cch-hotfix-'))
  t.after(() => fs.rmSync(dest, { force: true, recursive: true }))
  fs.mkdirSync(path.join(dest, 'deploy'))
  fs.writeFileSync(path.join(dest, 'VERSION'), '1.3.207\n')
  fs.writeFileSync(path.join(dest, 'deploy/payload.json'), `${JSON.stringify(value, null, 2)}\n`)
  return dest
}

test('historical CCH repair selects exact per-build payloads without modifying other pins', () => {
  for (const fix of CCH_HOTFIXES)
    for (const release of fix.releases) {
      const value = manifest(fix, release)
      const before = structuredClone(value)
      assert.deepEqual(planCliCchHotfix(value), { file: value.files[1], fix, fixed: false })
      assert.deepEqual(value, before)
      Object.assign(value.files[1], { sha256: fix.sha256, size: fix.size, asset: fix.asset })
      assert.equal(planCliCchHotfix(value).fixed, true)
    }
})

test('unknown hashes, releases, repositories and inconsistent metadata fail closed', () => {
  for (const mutate of [
    (m) => {
      m.repo = 'someone/else'
    },
    (m) => {
      m.release = 'unknown-release'
    },
    (m) => {
      m.files[1].sha256 = 'unknown'
    },
    (m) => {
      m.files[1].size++
    },
    (m) => {
      m.files[1].asset = 'unknown'
    },
    (m) => {
      m.files.push({ ...m.files[1] })
    },
    (m) => {
      m.files.splice(1, 1)
    },
  ]) {
    const value = manifest()
    mutate(value)
    assert.throws(() => planCliCchHotfix(value))
  }
})

test('check and bad artifacts leave the historical installation untouched', async (t) => {
  const dest = installation(t)
  const manifestPath = path.join(dest, 'deploy/payload.json')
  const before = fs.readFileSync(manifestPath)
  await assert.rejects(repairCliCch({ dest, check: true }), /repair required/)
  const bad = path.join(dest, 'bad-artifact')
  fs.writeFileSync(bad, 'not the verified ELF')
  await assert.rejects(repairCliCch({ dest, artifact: bad }), /size\/SHA256 verification/)
  assert.deepEqual(fs.readFileSync(manifestPath), before)
  assert.equal(fs.existsSync(path.join(dest, 'share')), false)
  assert.equal(
    fs.readdirSync(dest).some((name) => /lock|deploy-bak/.test(name)),
    false,
  )
})

test('old Node CCH implementations and unknown installed CLI bytes are not silently upgraded', async (t) => {
  const dest = installation(t)
  fs.writeFileSync(path.join(dest, 'VERSION'), '1.3.197\n')
  await assert.rejects(repairCliCch({ dest, check: true }), /v1.3.198/)
  fs.writeFileSync(path.join(dest, 'VERSION'), '1.3.219\n')
  fs.mkdirSync(path.join(dest, 'share/wrap-cli'), { recursive: true })
  fs.writeFileSync(path.join(dest, 'share/wrap-cli/cli-node'), 'unknown binary')
  await assert.rejects(repairCliCch({ dest, artifact }), /installed CLI/)
})

test('an existing repair lock is preserved and blocks a second writer', async (t) => {
  const dest = installation(t)
  const lock = path.join(dest, '.cli-cch-hotfix.lock')
  fs.writeFileSync(lock, 'another repair')
  await assert.rejects(repairCliCch({ dest, artifact }), { code: 'EEXIST' })
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another repair')
  assert.equal(fs.existsSync(path.join(dest, 'share')), false)
})

test('a verified repair is backed up, pins only CLI, and is idempotent', async (t) => {
  assert.ok(fs.existsSync(artifact), 'fetch the pinned payload before running this integration test')
  const value = manifest()
  const dest = installation(t, value)
  const before = fs.readFileSync(path.join(dest, 'deploy/payload.json'))
  const result = await repairCliCch({ dest, artifact })
  assert.equal(result.changed, true)
  assert.equal(result.sha256, current.sha256)
  assert.deepEqual(fs.readFileSync(path.join(result.backup, 'payload.json')), before)
  const updated = JSON.parse(fs.readFileSync(path.join(dest, 'deploy/payload.json')))
  assert.equal(updated.release, value.release)
  assert.deepEqual(updated.files[0], value.files[0])
  assert.deepEqual(updated.files[2], value.files[2])
  assert.equal(updated.files[1].sha256, current.sha256)
  assert.deepEqual(fs.readFileSync(path.join(dest, 'share/wrap-cli/cli-node')), fs.readFileSync(artifact))
  assert.equal(fs.statSync(path.join(dest, 'share/wrap-cli/cli-node')).mode & 0o111, 0o111)
  assert.equal((await repairCliCch({ dest, check: true })).changed, false)
  assert.equal((await repairCliCch({ dest, artifact })).changed, false)
  // Also recover the safe interruption point: new template with the original manifest.
  fs.writeFileSync(path.join(dest, 'deploy/payload.json'), before)
  assert.equal((await repairCliCch({ dest, artifact })).changed, true)
})
