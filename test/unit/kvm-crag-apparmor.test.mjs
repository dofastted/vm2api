import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { kvmCragAppArmorCommand } from '../../src/lib/vm/kvm-crag-apparmor.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test
const profilePath = '/etc/apparmor.d/vm2api-crag'
const dropinPath = '/etc/systemd/system/kin-kernel.service.d/50-vm2api-crag-userns.conf'
const restrictionPath = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
const marker = '# Managed by vm2api kin-crag-apparmor.\n'
const restart = ['systemctl', 'restart', 'kin-kernel.service']

function fixture(context, { enabled = 'Y', restriction = '1', config } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-crag-apparmor-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = (name) => path.join(root, name)
  const write = (name, text, mode = 0o644) => {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true })
    fs.writeFileSync(file(name), text, { mode })
  }
  const read = (name) => fs.readFileSync(file(name), 'utf8')
  const exists = (name) => fs.existsSync(file(name))
  if (enabled !== null) write('/sys/module/apparmor/parameters/enabled', `${enabled}\n`)
  if (restriction !== null) write(restrictionPath, `${restriction}\n`)
  write('/etc/apparmor.d/abi/4.0', 'fixture ABI\n')
  write('/run/kin/kernel.json', JSON.stringify(config || { dataplane: 'crag', crag_kernel_version: 'v2' }))
  write('/etc/systemd/system/kin-kernel.service', '[Service]\nUser=kincli\n')
  write('/etc/systemd/system/kin-kernel.service.d/slot.conf', '[Service]\nGroup=987\n')
  const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' })
  assert.equal(python.status, 0, python.stderr || String(python.error))
  const stub = `#!${python.stdout.trim()}
import json, os, pathlib, sys
root=pathlib.Path(os.environ['KIN_CRAG_APPARMOR_ROOT'])
name=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
log=root/'calls.jsonl'
previous=[json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
entry={'command':name,'args':args,'profile_exists':(root/'etc/apparmor.d/vm2api-crag').exists(),'dropin_exists':(root/'etc/systemd/system/kin-kernel.service.d/50-vm2api-crag-userns.conf').exists()}
with log.open('a') as f:f.write(json.dumps(entry)+'\\n')
if name=='apparmor_parser':
 if '-Q' in args:sys.exit(int(os.environ.get('FIXTURE_PARSE_EXIT','0')))
 if '-r' in args and not any(p['command']==name and '-r' in p['args'] for p in previous):sys.exit(int(os.environ.get('FIXTURE_LOAD_EXIT','0')))
elif args==['show','kin-kernel.service','--property=AppArmorProfile','--value']:
 print(os.environ.get('FIXTURE_ACTIVE_PROFILE',''))
elif args==['show','apparmor.service','--property=LoadState','--value']:
 print(os.environ.get('FIXTURE_APPARMOR_UNIT','loaded'))
elif args==['daemon-reload']:
 if not any(p['command']==name and p['args']==args for p in previous):sys.exit(int(os.environ.get('FIXTURE_RELOAD_EXIT','0')))
elif args==['restart','kin-kernel.service']:
 sys.exit(int(os.environ.get('FIXTURE_RESTART_EXIT','0')))
else:
 print('unexpected stub command: '+repr(args),file=sys.stderr)
 sys.exit(97)
`
  write('/bin/apparmor_parser', stub, 0o755)
  write('/bin/systemctl', stub, 0o755)
  fs.symlinkSync(python.stdout.trim(), file('/bin/python3'))
  const calls = () => (exists('/calls.jsonl') ? read('/calls.jsonl').trim().split('\n').map(JSON.parse) : [])
  const clearCalls = () => fs.rmSync(file('/calls.jsonl'), { force: true })
  const run = ({ restart = false, env = {}, uid = 0, extraArgs = [] } = {}) => {
    const command = kvmCragAppArmorCommand({ restart })
    // Tests stay inside a temporary root while exercising the production script and argv.
    command[2] = `import os\nos.geteuid = lambda: ${uid}\n${command[2]}`
    return spawnSync(command[0], [...command.slice(1), ...extraArgs], {
      env: { ...process.env, KIN_CRAG_APPARMOR_ROOT: root, PATH: file('/bin'), ...env },
      encoding: 'utf8',
      timeout: 10_000,
    })
  }
  return { root, file, write, read, exists, calls, clearCalls, run }
}

function successful(result) {
  assert.equal(result.status, 0, result.stderr || String(result.error))
  return JSON.parse(result.stdout)
}

function noBinding(fx) {
  assert.equal(fx.exists(profilePath), false)
  assert.equal(fx.exists(dropinPath), false)
}

test('KVM AppArmor command uses the same guest script for preparation and restart', () => {
  const script = fs.readFileSync(new URL('../../docker/kin-kvm/guest/kin-crag-apparmor', import.meta.url), 'utf8')
  assert.deepEqual(kvmCragAppArmorCommand(), ['python3', '-c', script])
  assert.deepEqual(kvmCragAppArmorCommand({ restart: true }), ['python3', '-c', script, '--', ...restart])
})

unixTest('restricted CRAG guest loads a dedicated profile before binding and restarting the service', (context) => {
  const fx = fixture(context)
  successful(fx.run({ restart: true }))
  const profile = fx.read(profilePath)
  assert.ok(profile.startsWith(marker))
  assert.match(profile, /profile vm2api-crag flags=\(unconfined\)/)
  assert.match(profile, /\buserns,/)
  assert.match(fx.read(dropinPath), /^AppArmorProfile=vm2api-crag$/m)
  assert.match(fx.read(dropinPath), /^After=apparmor.service$/m)
  assert.match(fx.read(dropinPath), /^Requires=apparmor.service$/m)
  assert.equal(fx.read(restrictionPath), '1\n')
  assert.equal(fx.read('/etc/systemd/system/kin-kernel.service'), '[Service]\nUser=kincli\n')
  assert.equal(fx.read('/etc/systemd/system/kin-kernel.service.d/slot.conf'), '[Service]\nGroup=987\n')
  for (const name of [profilePath, dropinPath]) assert.equal(fs.statSync(fx.file(name)).mode & 0o777, 0o644)
  const calls = fx.calls()
  const parse = calls.findIndex((call) => call.command === 'apparmor_parser' && call.args.includes('-Q'))
  const load = calls.findIndex((call) => call.command === 'apparmor_parser' && call.args.includes('-r'))
  const reload = calls.findIndex((call) => call.command === 'systemctl' && call.args[0] === 'daemon-reload')
  const reboot = calls.findIndex((call) => call.command === 'systemctl' && call.args[0] === 'restart')
  assert.ok(parse >= 0 && parse < load && load < reload && reload < reboot)
  assert.equal(calls[parse].profile_exists, false)
  assert.equal(calls[load].dropin_exists, false)
  assert.equal(calls[reload].dropin_exists, true)
})

for (const options of [
  { enabled: null },
  { enabled: 'N' },
  { restriction: null },
  { restriction: '0' },
  { config: { dataplane: 'wrap' } },
  { config: { dataplane: 'crag', crag_kernel_version: 'v1' } },
]) {
  unixTest(`unrestricted or non-native guest skips AppArmor setup: ${JSON.stringify(options)}`, (context) => {
    const fx = fixture(context, options)
    successful(fx.run({ restart: true }))
    noBinding(fx)
    assert.equal(
      fx.calls().some((call) => call.command === 'apparmor_parser'),
      false,
    )
    assert.equal(fx.calls().filter((call) => call.command === 'systemctl' && call.args[0] === 'restart').length, 1)
  })
}

unixTest('repeated preparation preserves file contents and avoids redundant daemon reloads', (context) => {
  const fx = fixture(context)
  successful(fx.run())
  const before = [profilePath, dropinPath].map((name) => [fx.read(name), fs.statSync(fx.file(name)).mtimeMs])
  fx.clearCalls()
  successful(fx.run())
  assert.deepEqual(
    [profilePath, dropinPath].map((name) => [fx.read(name), fs.statSync(fx.file(name)).mtimeMs]),
    before,
  )
  assert.equal(
    fx.calls().some((call) => call.command === 'systemctl' && call.args[0] === 'daemon-reload'),
    false,
  )
})

unixTest('switching away from CRAG removes only the managed binding without unloading an active profile', (context) => {
  const fx = fixture(context)
  successful(fx.run())
  const profile = fx.read(profilePath)
  fx.write('/run/kin/kernel.json', JSON.stringify({ dataplane: 'wrap' }))
  fx.clearCalls()
  successful(fx.run({ restart: true }))
  assert.equal(fx.exists(dropinPath), false)
  assert.equal(fx.read(profilePath), profile)
  assert.equal(fx.read('/etc/systemd/system/kin-kernel.service.d/slot.conf'), '[Service]\nGroup=987\n')
  assert.equal(
    fx.calls().some((call) => call.command === 'apparmor_parser'),
    false,
  )
  assert.ok(
    fx.calls().findIndex((call) => call.args[0] === 'daemon-reload') <
      fx.calls().findIndex((call) => call.args[0] === 'restart'),
  )
})

for (const [name, prepare, env] of [
  ['missing ABI', (fx) => fs.rmSync(fx.file('/etc/apparmor.d/abi/4.0')), {}],
  ['missing parser', (fx) => fs.rmSync(fx.file('/bin/apparmor_parser')), {}],
  ['missing AppArmor service', () => {}, { FIXTURE_APPARMOR_UNIT: 'not-found' }],
  ['parser validation failure', () => {}, { FIXTURE_PARSE_EXIT: '11' }],
  ['profile load failure', () => {}, { FIXTURE_LOAD_EXIT: '12' }],
  ['daemon reload failure', () => {}, { FIXTURE_RELOAD_EXIT: '13' }],
]) {
  unixTest(`${name} fails preparation without leaving a new binding or restarting`, (context) => {
    const fx = fixture(context)
    prepare(fx)
    const result = fx.run({ restart: true, env })
    assert.notEqual(result.status, 0)
    assert.ok(result.stderr.trim(), 'failure must provide a diagnostic')
    noBinding(fx)
    assert.equal(fx.read(restrictionPath), '1\n')
    assert.equal(
      fx.calls().some((call) => call.command === 'systemctl' && call.args[0] === 'restart'),
      false,
    )
  })
}

unixTest('a failed policy update restores existing managed configuration', (context) => {
  const fx = fixture(context)
  const oldProfile = `${marker}abi <abi/4.0>,\nprofile vm2api-crag flags=(unconfined) { userns, }\n`
  const oldDropin = `${marker}[Service]\nAppArmorProfile=vm2api-crag\n`
  fx.write(profilePath, oldProfile)
  fx.write(dropinPath, oldDropin)
  const result = fx.run({ restart: true, env: { FIXTURE_LOAD_EXIT: '12' } })
  assert.notEqual(result.status, 0)
  assert.equal(fx.read(profilePath), oldProfile)
  assert.equal(fx.read(dropinPath), oldDropin)
  assert.equal(
    fx.calls().some((call) => call.command === 'systemctl' && call.args[0] === 'restart'),
    false,
  )
})

for (const name of [profilePath, dropinPath]) {
  unixTest(`administrator configuration at ${name} is preserved`, (context) => {
    const fx = fixture(context)
    const custom = '# Operator-owned configuration\n'
    fx.write(name, custom)
    assert.notEqual(fx.run({ restart: true }).status, 0)
    assert.equal(fx.read(name), custom)
    assert.equal(
      fx.calls().some((call) => call.command === 'apparmor_parser' || call.args[0] === 'restart'),
      false,
    )
  })
}

unixTest('an explicitly selected administrator profile is left in control', (context) => {
  const fx = fixture(context)
  const result = successful(fx.run({ restart: true, env: { FIXTURE_ACTIVE_PROFILE: 'operator-profile' } }))
  assert.equal(result.reason, 'operator-managed')
  noBinding(fx)
  assert.equal(
    fx.calls().some((call) => call.command === 'apparmor_parser'),
    false,
  )
})

unixTest('an externally loaded policy with the same profile name is not replaced', (context) => {
  const fx = fixture(context)
  const result = successful(fx.run({ restart: true, env: { FIXTURE_ACTIVE_PROFILE: 'vm2api-crag' } }))
  assert.equal(result.reason, 'operator-managed')
  noBinding(fx)
  assert.equal(
    fx.calls().some((call) => call.command === 'apparmor_parser'),
    false,
  )
})

unixTest('symlinked configuration is rejected without modifying its target', (context) => {
  const fx = fixture(context)
  fx.write('/operator-profile', 'operator data\n')
  fs.symlinkSync(fx.file('/operator-profile'), fx.file(profilePath))
  assert.notEqual(fx.run({ restart: true }).status, 0)
  assert.equal(fx.read('/operator-profile'), 'operator data\n')
  assert.equal(
    fx.calls().some((call) => call.command === 'apparmor_parser' || call.args[0] === 'restart'),
    false,
  )
})

unixTest('invalid JSON, non-root calls and unrecognized commands cannot restart the service', (context) => {
  const fx = fixture(context)
  assert.notEqual(fx.run({ restart: true, uid: 1000 }).status, 0)
  assert.notEqual(fx.run({ extraArgs: ['--', 'systemctl', 'stop', 'kin-kernel.service'] }).status, 0)
  fx.write('/run/kin/kernel.json', '{broken')
  assert.notEqual(fx.run({ restart: true }).status, 0)
  noBinding(fx)
  assert.equal(
    fx.calls().some((call) => call.args[0] === 'restart'),
    false,
  )
})

unixTest('the actual restart exit status reaches the caller', (context) => {
  const fx = fixture(context)
  const result = fx.run({ restart: true, env: { FIXTURE_RESTART_EXIT: '23' } })
  assert.equal(result.status, 23, result.stderr)
  assert.equal(fx.calls().filter((call) => call.args[0] === 'restart').length, 1)
})
