import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initializeSlotSeedFiles,
  writeSlotSeedFiles,
  inferProjectRootFromCliHome,
} from '../../src/lib/vm/slot-seed.mjs'
import { seedFreshCliHome } from '../../src/lib/vm/vm-recreate.mjs'
import { runtimeFileOwner } from '../../src/lib/oauth/oauth-credentials.mjs'
import { standardSeedPolicy } from '../../src/lib/protocol/seed-policy.mjs'
import { KIN_SEED_SCHEMA } from '../../src/lib/identity/workstation-profile.mjs'
import { applySeedAfterOfficialInit } from '../../src/lib/oauth/official-cc-bootstrap.mjs'

test('inferProjectRootFromCliHome walks vms/<id>/cli-home', () => {
  const root = '/opt/kin-gateway'
  const home = path.join(root, 'vms', 'vm-10', 'cli-home')
  assert.equal(inferProjectRootFromCliHome(home), path.resolve(root))
  assert.equal(inferProjectRootFromCliHome('/tmp/not-a-slot'), null)
})

for (const dataplane of ['wrap', 'crag']) {
  test(`fresh ${dataplane} VM has private, VM-owned first-launch settings`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fresh-settings-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const vm = { id: 'vm-13', node_id: 'node-a', dataplane, timezone: 'Asia/Shanghai' }
    const { homeDir } = seedFreshCliHome(root, vm)
    const file = path.join(homeDir, '.claude', 'settings.json')
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(settings.env.TZ, 'Asia/Shanghai')
    assert.equal(settings.autoUpdates, false)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    for (const dir of [homeDir, path.dirname(file)]) {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
      if (process.getuid?.() === 0) {
        assert.equal(fs.statSync(dir).uid, runtimeFileOwner(vm).uid)
        assert.equal(fs.statSync(dir).gid, runtimeFileOwner(vm).gid)
      }
    }
  })
}

test('seed initialization merges authoritative node settings and waits for publication', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-node-settings-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = { id: 'vm-13', node_id: 'node-a', timezone: 'UTC' }
  writeSlotSeedFiles(root, vm, null, { existingSettings: { controller_only: true } })
  let published = false
  const seed = await initializeSlotSeedFiles(root, vm, {
    async seedFiles() {
      return {
        files: { 'settings.json': JSON.stringify({ permissions: { allow: ['Read'] }, env: { CUSTOM: 'node' } }) },
      }
    },
    async syncSeed(_vm, slotDir) {
      const settings = JSON.parse(fs.readFileSync(path.join(slotDir, 'cli-home', '.claude', 'settings.json')))
      assert.equal(settings.controller_only, undefined)
      assert.equal(settings.env.CUSTOM, 'node')
      assert.deepEqual(settings.permissions, { allow: ['Read'] })
      published = true
      return { published: true }
    },
  })
  assert.equal(seed.wrote, true)
  assert.equal(published, true)
})

for (const stage of ['read', 'parse', 'publish']) {
  test(`seed initialization propagates ${stage} failures`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-init-failure-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    let published = false
    await assert.rejects(
      initializeSlotSeedFiles(
        root,
        { id: 'vm-13' },
        {
          async seedFiles() {
            if (stage === 'read') throw new Error('node_read_failed')
            return { files: { 'settings.json': stage === 'parse' ? '{invalid' : null } }
          },
          async syncSeed() {
            published = true
            return { published: false }
          },
        },
      ),
    )
    assert.equal(published, stage === 'publish')
  })
}

test('writeSlotSeedFiles writes latest settings and workstation kin-seed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-seed-'))
  const vm = {
    id: 'vm-10',
    kernel: 'ubuntu-24.04',
    timezone: 'America/Los_Angeles',
    locale: 'en_US.UTF-8',
    seed_policy: standardSeedPolicy({
      telemetry_disabled: false,
      extra_env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', KEEP: '1' },
    }),
  }
  const leftover = path.join(root, 'vms', vm.id, 'cli-home', '.claude')
  fs.mkdirSync(leftover, { recursive: true })
  fs.writeFileSync(
    path.join(leftover, 'settings.json'),
    JSON.stringify({
      env: {
        DISABLE_TELEMETRY: '1',
        ANTHROPIC_API_KEY: 'old',
      },
    }),
  )
  const out = writeSlotSeedFiles(root, vm)
  assert.equal(out.wrote, true)
  const settings = JSON.parse(fs.readFileSync(path.join(leftover, 'settings.json'), 'utf8'))
  const claudeSetting = fs.readFileSync(path.join(leftover, 'claude.setting'), 'utf8')
  const seed = JSON.parse(fs.readFileSync(path.join(leftover, 'kin-seed.json'), 'utf8'))
  assert.equal(settings.env.DISABLE_TELEMETRY, undefined)
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1')
  assert.equal(settings.env.ANTHROPIC_BASE_URL, undefined)
  assert.equal(settings.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(settings.env.KEEP, '1')
  assert.equal(settings.env.TZ, 'America/Los_Angeles')
  assert.equal(settings.autoUpdates, false)
  assert.equal(settings.grove_enabled, false)
  assert.equal(claudeSetting, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\n')
  assert.equal(out.claude_setting, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1')
  assert.equal(seed.seed_policy.grove_enabled, false)
  assert.equal(seed.seed_policy.disable_nonessential_traffic, true)
  assert.equal(seed.schema, KIN_SEED_SCHEMA)
  assert.equal(seed.kernel, 'ubuntu-24.04')
  assert.equal(seed.linux_kernel, '6.8.0-52-generic')
  assert.equal(seed.workstation_sku, '2c4g')
  assert.equal(seed.telemetry, 'enabled')
  assert.notEqual(seed.linux_kernel, '7.0.0-14-generic')
  fs.rmSync(root, { recursive: true, force: true })
})

test('writeSlotSeedFiles preserves an editable claude.setting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-setting-'))
  const vm = {
    id: 'vm-setting',
    seed_policy: standardSeedPolicy({ claude_setting: 'FOO=bar\r\nBAZ=qux\n' }),
  }
  writeSlotSeedFiles(root, vm)
  assert.equal(
    fs.readFileSync(path.join(root, 'vms', vm.id, 'cli-home', '.claude', 'claude.setting'), 'utf8'),
    'FOO=bar\nBAZ=qux\n',
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('applySeedAfterOfficialInit uses the same writer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-init-seed-'))
  const vm = {
    id: 'vm-05',
    kernel: 'debian-12',
    timezone: 'America/New_York',
    locale: 'en_US.UTF-8',
    seed_policy: { telemetry_disabled: false },
  }
  const home = path.join(root, 'vms', vm.id, 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const out = applySeedAfterOfficialInit(home, vm, vm.seed_policy, root)
  assert.equal(out.wrote, true)
  const seed = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'kin-seed.json'), 'utf8'))
  assert.equal(seed.schema, KIN_SEED_SCHEMA)
  assert.equal(seed.kernel, 'debian-12')
  assert.match(seed.linux_kernel, /amd64$/)
  assert.equal(seed.workstation_sku, '4c8g')
  fs.rmSync(root, { recursive: true, force: true })
})

test('seed writes preserve VM-owned settings and never write runtime config or identities', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-private-'))
  try {
    const vm = { id: 'vm-11', seed_policy: { theme: 'light' } }
    const home = path.join(root, 'vms', vm.id, 'cli-home')
    const dir = path.join(home, '.claude')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Read'] }, env: { CUSTOM: 'vm-owned', DISABLE_TELEMETRY: '0' } }),
    )
    fs.writeFileSync(path.join(dir, 'credentials.json'), 'credential-marker')
    fs.writeFileSync(path.join(home, '.claude.json'), '{"userID":"stable-user"}')
    const out = writeSlotSeedFiles(root, vm)
    assert.deepEqual(out.settings.permissions, { allow: ['Read'] })
    assert.equal(out.settings.theme, 'light')
    assert.equal(out.settings.env.DISABLE_TELEMETRY, '1')
    assert.equal(out.settings.env.CUSTOM, 'vm-owned')
    assert.equal(out.kin_seed.seed_policy.telemetry_disabled, true)
    assert.equal(fs.existsSync(path.join(root, 'vms', vm.id, 'run', 'kernel.json')), false)
    assert.equal(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'), 'credential-marker')
    assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), '{"userID":"stable-user"}')
    for (const name of ['settings.json', 'claude.setting', 'kin-seed.json']) {
      assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('explicit env replacement removes deleted custom keys without changing privacy authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-env-replace-'))
  try {
    const vm = { id: 'vm-14', seed_policy: { telemetry_disabled: true, extra_env: { KEEP: 'new' } } }
    const existingSettings = { env: { REMOVE: 'old', KEEP: 'old', DO_NOT_TRACK: '0' } }
    const result = writeSlotSeedFiles(root, vm, null, { existingSettings, replaceEnv: true })
    assert.equal(result.settings.env.REMOVE, undefined)
    assert.equal(result.settings.env.KEEP, 'new')
    assert.equal(result.settings.env.DO_NOT_TRACK, '1')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('seed writes refuse a linked Claude directory without touching its target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-link-'))
  try {
    const home = path.join(root, 'vms', 'vm-12', 'cli-home')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'settings.json'), '{"marker":"untouched"}')
    fs.symlinkSync(outside, path.join(home, '.claude'))
    assert.throws(() => writeSlotSeedFiles(root, { id: 'vm-12' }))
    assert.equal(fs.readFileSync(path.join(outside, 'settings.json'), 'utf8'), '{"marker":"untouched"}')
    assert.deepEqual(fs.readdirSync(outside), ['settings.json'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('malformed existing settings fail instead of silently overwriting VM settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-invalid-'))
  try {
    const dir = path.join(root, 'vms', 'vm-13', 'cli-home', '.claude')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'settings.json'), '{broken')
    assert.throws(() => writeSlotSeedFiles(root, { id: 'vm-13' }))
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{broken')
    assert.equal(fs.existsSync(path.join(dir, 'kin-seed.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
