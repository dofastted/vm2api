import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeSlotSeedFiles, inferProjectRootFromCliHome } from '../../src/lib/vm/slot-seed.mjs'
import { standardSeedPolicy } from '../../src/lib/protocol/seed-policy.mjs'
import { KIN_SEED_SCHEMA } from '../../src/lib/identity/workstation-profile.mjs'
import { applySeedAfterOfficialInit } from '../../src/lib/oauth/official-cc-bootstrap.mjs'

test('inferProjectRootFromCliHome walks vms/<id>/cli-home', () => {
  const root = '/opt/kin-gateway'
  const home = path.join(root, 'vms', 'vm-10', 'cli-home')
  assert.equal(inferProjectRootFromCliHome(home), path.resolve(root))
  assert.equal(inferProjectRootFromCliHome('/tmp/not-a-slot'), null)
})

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
        FOO: 'from-old-script',
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
  assert.equal(settings.env.FOO, undefined)
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
