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
const runtimeDropinPath = '/etc/systemd/system/kin-kernel.service.d/40-vm2api-guest-runtime.conf'
const slotEnvPath = '/run/kin-guest/slot.env'
const currentUnit = '[Service]\nUser=kincli\n'
// Unit shipped by guest images before v1.4.133: stopping the kernel removed /run/kin-guest.
const oldUnit =
  '[Service]\nUser=kincli\nRuntimeDirectory=kin-guest\nRuntimeDirectoryMode=0770\nEnvironmentFile=-/run/kin-guest/slot.env\n'
const restrictionPath = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
const marker = '# Managed by vm2api kin-crag-apparmor.\n'
const restart = ['systemctl', 'restart', 'kin-kernel.service']

function fixture(context, { enabled = 'Y', restriction = '1', config, unit = currentUnit, slotEnv = true } = {}) {
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
  write('/etc/systemd/system/kin-kernel.service', unit)
  if (slotEnv) write(slotEnvPath, 'KIN_SLOT_ID=fixture\n')
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
entry={'command':name,'args':args,'profile_exists':(root/'etc/apparmor.d/vm2api-crag').exists(),'dropin_exists':(root/'etc/systemd/system/kin-kernel.service.d/50-vm2api-crag-userns.conf').exists(),'runtime_exists':(root/'etc/systemd/system/kin-kernel.service.d/40-vm2api-guest-runtime.conf').exists(),'slot_env_exists':(root/'run/kin-guest/slot.env').exists()}
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
elif args==['show','kin-guest-setup.service','--property=ActiveState','--value']:
 print(os.environ.get('FIXTURE_SETUP_STATE','active'))
elif args==['restart','kin-guest-setup.service']:
 if os.environ.get('FIXTURE_SETUP_WRITES','1')=='1':
  (root/'run/kin-guest').mkdir(parents=True,exist_ok=True)
  (root/'run/kin-guest/slot.env').write_text('KIN_SLOT_ID=fixture\\n')
 sys.exit(int(os.environ.get('FIXTURE_SETUP_EXIT','0')))
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

const kernelRestart = (call) =>
  call.command === 'systemctl' && call.args[0] === 'restart' && call.args[1] === 'kin-kernel.service'
const setupRestart = (call) =>
  call.command === 'systemctl' && call.args[0] === 'restart' && call.args[1] === 'kin-guest-setup.service'
const reloads = (calls) => calls.filter((call) => call.command === 'systemctl' && call.args[0] === 'daemon-reload')

unixTest('an old guest unit gets a runtime drop-in before the kernel restarts', (context) => {
  const fx = fixture(context, { unit: oldUnit })
  const result = successful(fx.run({ restart: true }))
  assert.equal(result.status, 'prepared')
  assert.equal(result.guest_runtime, 'preserved')
  assert.equal(result.guest_setup, 'present')
  const dropin = fx.read(runtimeDropinPath)
  assert.ok(dropin.startsWith(marker))
  assert.match(dropin, /^\[Service\]$/m)
  assert.match(dropin, /^RuntimeDirectory=$/m)
  assert.equal(fs.statSync(fx.file(runtimeDropinPath)).mode & 0o777, 0o644)
  assert.equal(fx.read('/etc/systemd/system/kin-kernel.service'), oldUnit)
  assert.equal(fx.read('/etc/systemd/system/kin-kernel.service.d/slot.conf'), '[Service]\nGroup=987\n')
  const calls = fx.calls()
  const firstReload = calls.findIndex((call) => call.command === 'systemctl' && call.args[0] === 'daemon-reload')
  const restartAt = calls.findIndex(kernelRestart)
  assert.ok(firstReload >= 0 && firstReload < restartAt)
  assert.equal(calls[firstReload].runtime_exists, true)
  assert.equal(calls[restartAt].runtime_exists, true)
  assert.match(fx.read(dropinPath), /^AppArmorProfile=vm2api-crag$/m)
})

unixTest('a current guest unit needs no runtime drop-in', (context) => {
  const fx = fixture(context)
  const result = successful(fx.run({ restart: true }))
  assert.equal(result.guest_runtime, 'not-needed')
  assert.equal(result.guest_setup, 'present')
  assert.equal(fx.exists(runtimeDropinPath), false)
  assert.equal(fx.calls().some(setupRestart), false)
})

for (const options of [{ enabled: 'N' }, { restriction: '0' }]) {
  unixTest(`the runtime drop-in does not depend on AppArmor: ${JSON.stringify(options)}`, (context) => {
    const fx = fixture(context, { ...options, unit: oldUnit })
    const result = successful(fx.run({ restart: true }))
    assert.equal(result.status, 'skipped')
    assert.equal(result.guest_runtime, 'preserved')
    assert.match(fx.read(runtimeDropinPath), /^RuntimeDirectory=$/m)
    noBinding(fx)
    assert.equal(
      fx.calls().some((call) => call.command === 'apparmor_parser'),
      false,
    )
    assert.equal(fx.calls().filter(kernelRestart).length, 1)
  })
}

unixTest('slot.env removed by an earlier kernel stop is restored before the restart', (context) => {
  const fx = fixture(context, { unit: oldUnit, slotEnv: false })
  const result = successful(fx.run({ restart: true }))
  assert.equal(result.guest_runtime, 'preserved')
  assert.equal(result.guest_setup, 'restored')
  assert.equal(fx.exists(slotEnvPath), true)
  const calls = fx.calls()
  const setupAt = calls.findIndex(setupRestart)
  const restartAt = calls.findIndex(kernelRestart)
  assert.ok(setupAt >= 0 && setupAt < restartAt)
  assert.equal(calls[setupAt].runtime_exists, true)
  assert.equal(calls[restartAt].slot_env_exists, true)
})

unixTest('a guest still running its first setup is left to finish it', (context) => {
  const fx = fixture(context, { unit: oldUnit, slotEnv: false })
  const result = successful(fx.run({ restart: true, env: { FIXTURE_SETUP_STATE: 'activating' } }))
  assert.equal(result.guest_setup, 'pending')
  assert.equal(fx.calls().some(setupRestart), false)
  assert.equal(fx.calls().filter(kernelRestart).length, 1)
})

for (const [name, env] of [
  ['does not restore slot.env', { FIXTURE_SETUP_WRITES: '0' }],
  ['fails', { FIXTURE_SETUP_EXIT: '14' }],
]) {
  unixTest(`a guest setup restart that ${name} stops before the kernel restart`, (context) => {
    const fx = fixture(context, { unit: oldUnit, slotEnv: false })
    const result = fx.run({ restart: true, env })
    assert.notEqual(result.status, 0)
    assert.ok(result.stderr.trim(), 'failure must provide a diagnostic')
    assert.equal(fx.calls().some(kernelRestart), false)
  })
}

unixTest('repeated preparation keeps the runtime drop-in without another reload', (context) => {
  const fx = fixture(context, { unit: oldUnit })
  successful(fx.run())
  const before = [fx.read(runtimeDropinPath), fs.statSync(fx.file(runtimeDropinPath)).mtimeMs]
  fx.clearCalls()
  const result = successful(fx.run())
  assert.equal(result.guest_runtime, 'already-preserved')
  assert.deepEqual([fx.read(runtimeDropinPath), fs.statSync(fx.file(runtimeDropinPath)).mtimeMs], before)
  assert.equal(reloads(fx.calls()).length, 0)
})

unixTest('a non-CRAG guest keeps its unit untouched', (context) => {
  const fx = fixture(context, { unit: oldUnit, config: { dataplane: 'wrap' } })
  const result = successful(fx.run({ restart: true }))
  assert.equal(result.guest_runtime, undefined)
  assert.equal(fx.exists(runtimeDropinPath), false)
  assert.equal(reloads(fx.calls()).length, 0)
})

unixTest('administrator configuration at the runtime drop-in path is preserved', (context) => {
  const fx = fixture(context, { unit: oldUnit })
  const custom = '# Operator-owned configuration\n'
  fx.write(runtimeDropinPath, custom)
  assert.notEqual(fx.run({ restart: true }).status, 0)
  assert.equal(fx.read(runtimeDropinPath), custom)
  assert.equal(
    fx.calls().some((call) => call.command === 'apparmor_parser' || kernelRestart(call)),
    false,
  )
})

unixTest('a failed reload removes the new runtime drop-in and does not restart', (context) => {
  const fx = fixture(context, { unit: oldUnit })
  const result = fx.run({ restart: true, env: { FIXTURE_RELOAD_EXIT: '13' } })
  assert.notEqual(result.status, 0)
  assert.equal(fx.exists(runtimeDropinPath), false)
  assert.equal(reloads(fx.calls()).length, 2)
  assert.equal(fx.calls().some(kernelRestart), false)
})

const workDropinPath = '/etc/systemd/system/kin-kernel.service.d/45-vm2api-crag-work.conf'

unixTest('CRAG v2 mounts guest tmpfs over its work directory before the kernel restarts', (context) => {
  const fx = fixture(context)
  const result = successful(fx.run({ restart: true }))
  assert.equal(result.work_dir, 'tmpfs')
  const dropin = fx.read(workDropinPath)
  assert.ok(dropin.startsWith(marker))
  const line = dropin.split('\n').find((entry) => entry.startsWith('ExecStartPre='))
  // "-+": runs as root despite User=kincli, and a failed mount never keeps the kernel down.
  assert.match(line, /^ExecStartPre=-\+\/bin\/sh -c '/)
  assert.match(line, /\[ ! -L \/run\/kin\/work \] && \{ mountpoint -q \/run\/kin\/work \|\| /)
  assert.match(
    line,
    /mkdir -p \/run\/kin\/work && \[ ! -L \/run\/kin\/work \] && mount -t tmpfs -o mode=0700,uid=\$\(id -u kincli\),gid=\$\(id -g kincli\),size=256m,nosuid,nodev vm2api-crag-work \/run\/kin\/work/,
  )
  assert.doesNotMatch(line, /\bchown\b/)
  const inner = line.replace(/^ExecStartPre=-\+\/bin\/sh -c '/, '').replace(/'$/, '')
  const syntax = spawnSync('sh', ['-n', '-c', inner], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
  // Symlink at /run/kin/work must be refused before mountpoint/mkdir/mount run.
  const target = fx.file('/symlink-target')
  fs.mkdirSync(target, { recursive: true })
  const workLink = fx.file('/run/kin/work')
  fs.symlinkSync(target, workLink)
  const stubLog = fx.file('/work-hook-calls.log')
  const spy = `#!/bin/sh\necho "$0 $*" >> '${stubLog}'\nexit 0\n`
  fx.write('/work-bin/mountpoint', spy, 0o755)
  fx.write('/work-bin/mount', spy, 0o755)
  const rewritten = inner.replaceAll('/run/kin/work', workLink)
  const refused = spawnSync('sh', ['-c', rewritten], {
    env: { ...process.env, PATH: `${fx.file('/work-bin')}:${process.env.PATH}` },
    encoding: 'utf8',
  })
  assert.notEqual(refused.status, 0)
  assert.equal(fx.exists('/work-hook-calls.log'), false)
  // Non-symlink path creates /run/kin/work and sets ownership atomically via mount options.
  fs.unlinkSync(workLink)
  fx.write('/work-bin/mountpoint', '#!/bin/sh\nexit 1\n', 0o755)
  fx.write(
    '/work-bin/id',
    '#!/bin/sh\n[ "$2" = "kincli" ] || exit 1\nif [ "$1" = "-u" ]; then echo 1001; elif [ "$1" = "-g" ]; then echo 1002; else exit 1; fi\n',
    0o755,
  )
  const mounted = spawnSync('sh', ['-c', rewritten], {
    env: { ...process.env, PATH: `${fx.file('/work-bin')}:${process.env.PATH}` },
    encoding: 'utf8',
  })
  assert.equal(mounted.status, 0, mounted.stderr)
  assert.equal(fs.statSync(workLink).isDirectory(), true)
  assert.ok(
    fx
      .read('/work-hook-calls.log')
      .includes(`mount -t tmpfs -o mode=0700,uid=1001,gid=1002,size=256m,nosuid,nodev vm2api-crag-work ${workLink}`),
  )
  assert.equal(fs.statSync(fx.file(workDropinPath)).mode & 0o777, 0o644)
  const calls = fx.calls()
  const lastReload = calls.findLastIndex((call) => call.command === 'systemctl' && call.args[0] === 'daemon-reload')
  assert.ok(lastReload >= 0 && calls.findIndex(kernelRestart) > lastReload)
})

unixTest('repeated CRAG preparation keeps the work drop-in without another reload', (context) => {
  const fx = fixture(context)
  successful(fx.run())
  const before = [fx.read(workDropinPath), fs.statSync(fx.file(workDropinPath)).mtimeMs]
  fx.clearCalls()
  const result = successful(fx.run())
  assert.equal(result.work_dir, 'already-tmpfs')
  assert.deepEqual([fx.read(workDropinPath), fs.statSync(fx.file(workDropinPath)).mtimeMs], before)
  assert.equal(reloads(fx.calls()).length, 0)
})

unixTest('the work directory moves to tmpfs even when AppArmor needs no exception', (context) => {
  const fx = fixture(context, { enabled: 'N' })
  const result = successful(fx.run({ restart: true }))
  assert.equal(result.reason, 'apparmor-disabled')
  assert.equal(result.work_dir, 'tmpfs')
  assert.equal(fx.exists(dropinPath), false)
  assert.ok(fx.read(workDropinPath).startsWith(marker))
})

unixTest('switching away from CRAG v2 releases the managed work drop-in', (context) => {
  const fx = fixture(context)
  successful(fx.run())
  fx.write('/run/kin/kernel.json', JSON.stringify({ dataplane: 'wrap' }))
  fx.clearCalls()
  const result = successful(fx.run({ restart: true }))
  assert.equal(result.work_dir, 'released')
  assert.equal(fx.exists(workDropinPath), false)
  assert.ok(reloads(fx.calls()).length >= 1)
  fx.clearCalls()
  assert.equal(successful(fx.run()).work_dir, 'not-crag-v2')
  assert.equal(reloads(fx.calls()).length, 0)
})

unixTest('administrator configuration at the work drop-in path is left in control', (context) => {
  const fx = fixture(context)
  const custom = '# Operator-owned configuration\n[Service]\n'
  fx.write(workDropinPath, custom)
  const result = successful(fx.run({ restart: true }))
  assert.equal(result.work_dir, 'operator-managed')
  assert.equal(fx.read(workDropinPath), custom)
  fx.write('/run/kin/kernel.json', JSON.stringify({ dataplane: 'wrap' }))
  assert.equal(successful(fx.run()).work_dir, 'operator-managed')
  assert.equal(fx.read(workDropinPath), custom)
})

unixTest('a failed reload removes the new work drop-in and does not restart', (context) => {
  const fx = fixture(context, { enabled: 'N' })
  const result = fx.run({ restart: true, env: { FIXTURE_RELOAD_EXIT: '1' } })
  assert.notEqual(result.status, 0)
  assert.equal(fx.exists(workDropinPath), false)
  assert.equal(fx.calls().some(kernelRestart), false)
})

const transcriptDropinPath = '/etc/systemd/system/kin-kernel.service.d/46-vm2api-crag-transcripts.conf'

function transcriptHook(fx) {
  const line = fx
    .read(transcriptDropinPath)
    .split('\n')
    .find((entry) => entry.startsWith('ExecStartPre='))
  assert.match(line, /^ExecStartPre=-\+\/bin\/sh -c '/)
  return line.replace(/^ExecStartPre=-\+\/bin\/sh -c '/, '').replace(/'$/, '')
}

function transcriptStubs(fx) {
  const log = fx.file('/transcript-hook-calls.log')
  fx.write('/transcript-bin/mountpoint', '#!/bin/sh\nexit 1\n', 0o755)
  fx.write('/transcript-bin/mount', `#!/bin/sh\necho "mount $*" >> '${log}'\nexit 0\n`, 0o755)
  // install -d … <dir>: record the call and create the directory without needing a kincli account.
  fx.write(
    '/transcript-bin/install',
    `#!/bin/sh\necho "install $*" >> '${log}'\nfor last; do :; done\nmkdir -p "$last"\n`,
    0o755,
  )
  fx.write(
    '/transcript-bin/id',
    '#!/bin/sh\n[ "$2" = "kincli" ] || exit 1\nif [ "$1" = "-u" ]; then echo 1001; elif [ "$1" = "-g" ]; then echo 1002; else exit 1; fi\n',
    0o755,
  )
  const run = (script) =>
    spawnSync('sh', ['-c', script], {
      env: { ...process.env, PATH: `${fx.file('/transcript-bin')}:${process.env.PATH}` },
      encoding: 'utf8',
    })
  const calls = () =>
    fx.exists('/transcript-hook-calls.log') ? fx.read('/transcript-hook-calls.log').trim().split('\n') : []
  return { run, calls }
}

unixTest('CRAG v2 also mounts guest tmpfs over the CLI resume transcripts before the kernel restarts', (context) => {
  const fx = fixture(context)
  const result = successful(fx.run({ restart: true }))
  assert.equal(result.work_dir, 'tmpfs')
  assert.equal(result.transcripts, 'tmpfs')
  const dropin = fx.read(transcriptDropinPath)
  assert.ok(dropin.startsWith(marker))
  assert.equal(fs.statSync(fx.file(transcriptDropinPath)).mode & 0o777, 0o644)
  const inner = transcriptHook(fx)
  // systemd expands ${NAME} inside ExecStartPre; the hook must only use literal paths and $(…) substitutions.
  assert.doesNotMatch(inner, /\$\{/)
  assert.doesNotMatch(inner, /\bchown\b/)
  assert.match(
    inner,
    /mount -t tmpfs -o mode=0700,uid=\$\(id -u kincli\),gid=\$\(id -g kincli\),size=512m,nosuid,nodev vm2api-crag-transcripts \/home\/kincli\/\.claude\/projects/,
  )
  const syntax = spawnSync('sh', ['-n', '-c', inner], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
  const calls = fx.calls()
  const lastReload = calls.findLastIndex((call) => call.command === 'systemctl' && call.args[0] === 'daemon-reload')
  assert.ok(lastReload >= 0 && calls.findIndex(kernelRestart) > lastReload)
})

unixTest(
  'the transcript hook refuses symlinks and creates missing directories as kincli only when absent',
  (context) => {
    const fx = fixture(context)
    successful(fx.run())
    const home = fx.file('/home/kincli')
    const rewritten = transcriptHook(fx).replaceAll('/home/kincli', home)
    const hook = transcriptStubs(fx)
    // ~/.claude as a symlink: nothing runs.
    const target = fx.file('/elsewhere')
    fs.mkdirSync(target, { recursive: true })
    fs.mkdirSync(home, { recursive: true })
    fs.symlinkSync(target, path.join(home, '.claude'))
    assert.notEqual(hook.run(rewritten).status, 0)
    assert.deepEqual(hook.calls(), [])
    // ~/.claude/projects as a symlink: nothing runs either.
    fs.unlinkSync(path.join(home, '.claude'))
    fs.mkdirSync(path.join(home, '.claude'))
    fs.symlinkSync(target, path.join(home, '.claude', 'projects'))
    assert.notEqual(hook.run(rewritten).status, 0)
    assert.deepEqual(hook.calls(), [])
    // Existing ~/.claude (holds the credentials): left as is, only the missing projects directory is created.
    fs.unlinkSync(path.join(home, '.claude', 'projects'))
    const mounted = hook.run(rewritten)
    assert.equal(mounted.status, 0, mounted.stderr)
    assert.deepEqual(hook.calls(), [
      `install -d -m 0700 -o kincli -g kincli ${home}/.claude/projects`,
      `mount -t tmpfs -o mode=0700,uid=1001,gid=1002,size=512m,nosuid,nodev vm2api-crag-transcripts ${home}/.claude/projects`,
    ])
    // Fresh home: both directories are created before the mount.
    fs.rmSync(path.join(home, '.claude'), { recursive: true })
    fs.unlinkSync(fx.file('/transcript-hook-calls.log'))
    assert.equal(hook.run(rewritten).status, 0)
    assert.deepEqual(hook.calls(), [
      `install -d -m 0700 -o kincli -g kincli ${home}/.claude`,
      `install -d -m 0700 -o kincli -g kincli ${home}/.claude/projects`,
      `mount -t tmpfs -o mode=0700,uid=1001,gid=1002,size=512m,nosuid,nodev vm2api-crag-transcripts ${home}/.claude/projects`,
    ])
  },
)

unixTest('repeated CRAG preparation keeps the transcript drop-in without another reload', (context) => {
  const fx = fixture(context)
  successful(fx.run())
  const before = [fx.read(transcriptDropinPath), fs.statSync(fx.file(transcriptDropinPath)).mtimeMs]
  fx.clearCalls()
  const result = successful(fx.run())
  assert.equal(result.transcripts, 'already-tmpfs')
  assert.deepEqual([fx.read(transcriptDropinPath), fs.statSync(fx.file(transcriptDropinPath)).mtimeMs], before)
  assert.equal(reloads(fx.calls()).length, 0)
})

unixTest('switching away from CRAG v2 releases the transcript drop-in', (context) => {
  const fx = fixture(context)
  successful(fx.run())
  fx.write('/run/kin/kernel.json', JSON.stringify({ dataplane: 'wrap' }))
  const result = successful(fx.run({ restart: true }))
  assert.equal(result.transcripts, 'released')
  assert.equal(fx.exists(transcriptDropinPath), false)
  assert.equal(successful(fx.run()).transcripts, 'not-crag-v2')
})

unixTest('administrator configuration at the transcript drop-in path is left in control', (context) => {
  const fx = fixture(context)
  const custom = '# Operator-owned configuration\n[Service]\n'
  fx.write(transcriptDropinPath, custom)
  assert.equal(successful(fx.run({ restart: true })).transcripts, 'operator-managed')
  assert.equal(fx.read(transcriptDropinPath), custom)
  fx.write('/run/kin/kernel.json', JSON.stringify({ dataplane: 'wrap' }))
  assert.equal(successful(fx.run()).transcripts, 'operator-managed')
  assert.equal(fx.read(transcriptDropinPath), custom)
})

const guestSetupPath = '/usr/local/sbin/kin-guest-setup'
const guestSetup = (cache) =>
  '#!/bin/sh\nif has_share home; then\n' +
  `  mount_9p kinhome /home/kincli ${cache}\nfi\nif has_share claude; then\n` +
  `  mount_9p kinclaude /home/kincli/.claude ${cache}\nfi\n` +
  'mount_9p kinrun /run/kin none\nmount_9p kinpayload /opt/kin-payload loose\n'

unixTest(
  'existing guests get kinhome/kinclaude switched from cache=mmap to cache=none for the next boot (#1877)',
  (context) => {
    const fx = fixture(context)
    fx.write(guestSetupPath, guestSetup('mmap'), 0o755)
    assert.equal(successful(fx.run({ restart: true })).guest_9p_cache, 'upgraded-next-boot')
    assert.equal(fx.read(guestSetupPath), guestSetup('none'))
    assert.equal(fs.statSync(fx.file(guestSetupPath)).mode & 0o777, 0o755)
    // Only the two home mounts change; kinpayload keeps cache=loose.
    assert.match(fx.read(guestSetupPath), /mount_9p kinpayload \/opt\/kin-payload loose/)
    assert.equal(successful(fx.run()).guest_9p_cache, 'current')
  },
)

unixTest('the 9p cache upgrade also runs when the slot is not on CRAG v2', (context) => {
  const fx = fixture(context, { config: { dataplane: 'wrap' } })
  fx.write(guestSetupPath, guestSetup('mmap'), 0o755)
  assert.equal(successful(fx.run()).guest_9p_cache, 'upgraded-next-boot')
  assert.equal(fx.read(guestSetupPath), guestSetup('none'))
})

unixTest('guest setup scripts that are missing, symlinked or hand-edited are left alone', (context) => {
  const fx = fixture(context)
  assert.equal(successful(fx.run()).guest_9p_cache, 'no-guest-setup')
  const doubled = guestSetup('mmap') + '  mount_9p kinhome /home/kincli mmap\n'
  fx.write(guestSetupPath, doubled, 0o755)
  assert.equal(successful(fx.run()).guest_9p_cache, 'operator-managed')
  assert.equal(fx.read(guestSetupPath), doubled)
  fs.rmSync(fx.file(guestSetupPath))
  fx.write('/usr/local/sbin/real-setup', guestSetup('mmap'), 0o755)
  fs.symlinkSync(fx.file('/usr/local/sbin/real-setup'), fx.file(guestSetupPath))
  assert.equal(successful(fx.run()).guest_9p_cache, 'operator-managed')
  assert.equal(fx.read('/usr/local/sbin/real-setup'), guestSetup('mmap'))
})
