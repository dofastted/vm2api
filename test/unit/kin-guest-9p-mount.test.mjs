// Regression on kin-guest-setup source. Existing overlays need a new kin-kvm runner
// image, cidata reinstall of /usr/local/sbin/kin-guest-setup, and guest reboot;
// see docs/crag-kvm.md «Guest 启动脚本升级».
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const setup = fs.readFileSync(new URL('../../docker/kin-kvm/guest/kin-guest-setup', import.meta.url), 'utf8')

test('kinhome and kinclaude skip mmap page cache to avoid netfs writeback hangs (#1877)', () => {
  assert.match(setup, /mount_9p kinhome \/home\/kincli none/)
  assert.match(setup, /mount_9p kinclaude \/home\/kincli\/\.claude none/)
  assert.doesNotMatch(setup, /mount_9p kinhome \/home\/kincli mmap/)
  assert.doesNotMatch(setup, /mount_9p kinclaude \/home\/kincli\/\.claude mmap/)
})

test('kinrun and kinpayload keep their established cache modes', () => {
  assert.match(setup, /mount_9p kinrun \/run\/kin none/)
  assert.match(setup, /mount_9p kinpayload \/opt\/kin-payload loose/)
})