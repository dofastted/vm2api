import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const unit = fs.readFileSync(new URL('../../docker/kin-kvm/guest/kin-kernel.service', import.meta.url), 'utf8')

function section(name) {
  const match = new RegExp(`^\\[${name}\\]\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(unit)
  assert.ok(match, `[${name}] section`)
  return match[1]
}

test('guest kernel unit keeps restarting instead of parking in start-limit-hit', () => {
  // A kernel that exits fast while its license is still being projected must come back once
  // the projection lands; systemd's default 5 starts / 10 s would give up after ~8 s.
  assert.match(section('Unit'), /^StartLimitIntervalSec=0$/m)
  assert.match(section('Service'), /^Restart=always$/m)
  assert.match(section('Service'), /^RestartSec=[1-9]\d*$/m)
})
