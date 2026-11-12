import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { kernelCpuCommand, usesKernelCpuLimit } from '../../src/lib/vm/kernel-cpu.mjs'

const guestDir = fileURLToPath(new URL('../../docker/kin-kvm/guest/', import.meta.url))
const script = fs.readFileSync(path.join(guestDir, 'kin-kernel-cpu'), 'utf8')
const unixTest = process.platform === 'win32' ? test.skip : test

function fixture(context, { affinity = '0-7', cgroup = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-cpu-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const proc = path.join(root, 'proc')
  const mount = path.join(root, 'cpu mount')
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  if (affinity !== null) write(path.join(proc, 'self/status'), `Name:\tfixture\nCpus_allowed_list:\t${affinity}\n`)
  write(path.join(proc, 'self/cgroup'), cgroup)
  write(path.join(proc, 'self/stat'), '42 (fixture awk process) S 1 2 3\n')
  write(path.join(proc, 'self/mountinfo'), '')
  const env = {
    ...process.env,
    KIN_KERNEL_PROC_ROOT: proc,
    KIN_KERNEL_CPU_CEILING: '',
    KIN_KVM_KERNEL_CPU_LIMIT: '',
    TOKIO_WORKER_THREADS: '999',
  }
  const run = (argv = ['--count'], extraEnv = {}) =>
    spawnSync('/bin/sh', kernelCpuCommand(argv).slice(1), {
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
    })
  const count = (extraEnv = {}) => {
    const result = run(['--count'], extraEnv)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /^[1-9][0-9]*\n$/)
    return Number(result.stdout.trim())
  }
  const mountInfo = (version, mountRoot = '/', location = mount, controllers = 'cpu,cpuacct') => {
    const encode = (value) => value.replaceAll('\\', '\\134').replaceAll(' ', '\\040')
    const filesystem = version === 2 ? 'cgroup2 cgroup rw' : `cgroup cgroup rw,${controllers}`
    return `30 20 0:30 ${encode(mountRoot)} ${encode(location)} rw - ${filesystem}\n`
  }
  const markCurrent = (location, suffix = '') => write(path.join(location, suffix, 'cgroup.procs'), '42\n')
  return { root, proc, mount, write, env, run, count, mountInfo, markCurrent }
}

test('Docker CPU command inlines the repository script without changing argv', () => {
  const argv = ['/kernel with spaces', '--config', '', '$HOME;echo no', 'line\nbreak']
  assert.deepEqual(kernelCpuCommand(argv), ['/bin/sh', '-c', script, 'kin-kernel-cpu', ...argv])
  assert.deepEqual(argv, ['/kernel with spaces', '--config', '', '$HOME;echo no', 'line\nbreak'])
  assert.equal(usesKernelCpuLimit({}, {}), true)
  assert.equal(usesKernelCpuLimit({ dataplane: 'cc' }), true)
  assert.equal(usesKernelCpuLimit({ dataplane: 'crag' }), false)
  assert.equal(usesKernelCpuLimit({}, { inference: { dataplane: 'crag' } }), false)
  assert.equal(usesKernelCpuLimit({ platform: 'openai', family: 'codex' }), false)
})

for (const [affinity, expected] of [
  ['0-3,8,10-11', 7],
  ['12', 1],
  ['2-5', 4],
  [null, 1],
  ['', 1],
  ['bad', 1],
  ['5-2', 1],
]) {
  unixTest(`CPU affinity ${JSON.stringify(affinity)} resolves to ${expected}`, (context) => {
    assert.equal(fixture(context, { affinity }).count(), expected)
  })
}

unixTest('v2 quotas follow the current mount root and all visible ancestors', (context) => {
  const fx = fixture(context, { cgroup: '0::/tenant/group/leaf\n' })
  fx.write(path.join(fx.proc, 'self/mountinfo'), fx.mountInfo(2, '/tenant'))
  fs.rmSync(path.join(fx.proc, 'self/stat'))
  fx.write(path.join(fx.mount, 'group/leaf/cpu.max'), 'max 100000\n')
  fx.write(path.join(fx.mount, 'group/cpu.max'), '150000 100000\n')
  fx.write(path.join(fx.mount, 'cpu.max'), '450000 100000\n')
  assert.equal(fx.count(), 2)
  fx.write(path.join(fx.mount, 'group/leaf/cpu.max'), '10000 100000\n')
  assert.equal(fx.count(), 1)
})

unixTest('v1 CPU controller quotas ceil fractional limits and include the mount itself', (context) => {
  const fx = fixture(context, { cgroup: '3:memory:/irrelevant\n4:cpuacct,cpu:/tenant/leaf\n' })
  fx.write(path.join(fx.proc, 'self/mountinfo'), fx.mountInfo(1, '/tenant'))
  fx.write(path.join(fx.mount, 'leaf/cpu.cfs_quota_us'), '-1\n')
  fx.write(path.join(fx.mount, 'leaf/cpu.cfs_period_us'), '100000\n')
  fx.write(path.join(fx.mount, 'cpu.cfs_quota_us'), '250000\n')
  fx.write(path.join(fx.mount, 'cpu.cfs_period_us'), '100000\n')
  assert.equal(fx.count(), 3)
  fx.write(path.join(fx.mount, 'cpu.cfs_quota_us'), '0\n')
  assert.equal(fx.count(), 1)
})

unixTest('hybrid cgroups take the minimum across readable CPU mounts', (context) => {
  const fx = fixture(context, { cgroup: '0::/leaf\n5:cpu:/leaf\n' })
  const legacy = path.join(fx.root, 'legacy')
  fx.write(path.join(fx.proc, 'self/mountinfo'), fx.mountInfo(2) + fx.mountInfo(1, '/', legacy))
  fx.write(path.join(fx.mount, 'leaf/cpu.max'), '350000 100000\n')
  fx.write(path.join(legacy, 'leaf/cpu.cfs_quota_us'), '110000\n')
  fx.write(path.join(legacy, 'leaf/cpu.cfs_period_us'), '100000\n')
  assert.equal(fx.count(), 2)
  assert.equal(fx.count({ KIN_KERNEL_CPU_CEILING: '1' }), 1)
})

unixTest('unrelated mounts, unlimited, missing and malformed quotas do not reduce affinity', (context) => {
  const fx = fixture(context, { cgroup: '0::/tenant2/leaf\n4:cpu:/tenant2/leaf\n' })
  const unrelated = path.join(fx.root, 'unrelated')
  fx.write(
    path.join(fx.proc, 'self/mountinfo'),
    fx.mountInfo(2) + fx.mountInfo(2, '/tenant', unrelated) + fx.mountInfo(1, '/', unrelated, 'cpuacct'),
  )
  fx.write(path.join(unrelated, 'cpu.max'), '1 100000\n')
  fx.write(path.join(unrelated, 'cpu.cfs_quota_us'), '1\n')
  fx.write(path.join(unrelated, 'cpu.cfs_period_us'), '100000\n')
  for (const quota of ['max 100000', 'broken', '100000 0', '-1 100000']) {
    fx.write(path.join(fx.mount, 'tenant2/leaf/cpu.max'), `${quota}\n`)
    assert.equal(fx.count(), 8)
  }
})

unixTest('affinity and an optional positive integer ceiling bound quotas', (context) => {
  const fx = fixture(context, { affinity: '2-4', cgroup: '0::/\n' })
  fx.write(path.join(fx.proc, 'self/mountinfo'), fx.mountInfo(2))
  fx.write(path.join(fx.mount, 'cpu.max'), '1600000 100000\n')
  assert.equal(fx.count(), 3)
  assert.equal(fx.count({ KIN_KERNEL_CPU_CEILING: '2' }), 2)
  assert.equal(fx.count({ KIN_KERNEL_CPU_CEILING: '100' }), 3)
  for (const ceiling of ['0', '-1', 'bad', '1.5']) {
    assert.equal(fx.count({ KIN_KERNEL_CPU_CEILING: ceiling }), 3)
  }
})

unixTest('non-root cgroup mount roots map verified namespace-relative members', (context) => {
  for (const member of ['/', '/leaf']) {
    const fx = fixture(context, { cgroup: `0::${member}\n` })
    fx.write(path.join(fx.proc, 'self/mountinfo'), fx.mountInfo(2, '/host/namespace'))
    const suffix = member === '/' ? '' : 'leaf'
    fx.markCurrent(fx.mount, suffix)
    fx.write(path.join(fx.mount, suffix, 'cpu.max'), '150000 100000\n')
    assert.equal(fx.count(), 2)
  }
})

unixTest('cgroup members with dot or dot-dot components cannot escape the mount', (context) => {
  const fx = fixture(context, { cgroup: '0::/tenant/../leaf\n' })
  fx.write(path.join(fx.proc, 'self/mountinfo'), fx.mountInfo(2))
  fx.write(path.join(fx.mount, 'cpu.max'), '10000 100000\n')
  assert.equal(fx.count(), 8)
})

unixTest('unsafe cgroup mount points cannot escape the mount', (context) => {
  const fx = fixture(context, { cgroup: '0::/\n' })
  fx.write(path.join(fx.proc, 'self/mountinfo'), fx.mountInfo(2, '/', `${fx.mount}/../escaped`))
  fx.write(path.join(fx.root, 'escaped/cpu.max'), '10000 100000\n')
  assert.equal(fx.count(), 8)
})

unixTest('missing proc data falls back to one even with an existing Tokio value', (context) => {
  const fx = fixture(context, { affinity: null })
  fs.rmSync(fx.proc, { recursive: true, force: true })
  assert.equal(fx.count({ KIN_KERNEL_CPU_CEILING: '4' }), 1)
})

unixTest('exec preserves PID, argv, exit status and exports the computed thread count', (context) => {
  const fx = fixture(context, { affinity: '0-2' })
  const argv = ['', 'two words', '"quotes"', "single'quote", '$HOME; touch nope', '*', 'line\nbreak', '中文']
  const result = fx.run([
    process.execPath,
    '-e',
    'console.log(JSON.stringify({pid:process.pid,argv:process.argv.slice(1),threads:process.env.TOKIO_WORKER_THREADS}));process.exit(23)',
    '--',
    ...argv,
  ])
  assert.equal(result.status, 23, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { pid: result.pid, argv, threads: '3' })
})

unixTest('KVM seed cap is generated only for explicit opt-in', (context) => {
  const fx = fixture(context, { affinity: '0-3' })
  const runner = fs.readFileSync(new URL('../../docker/kin-kvm/kin-kvm-entry', import.meta.url), 'utf8')
  const seedFunction = runner
    .slice(runner.indexOf('write_seed() {'), runner.indexOf('\nqmp_cmd() {'))
    .replaceAll('/opt/kin-kvm/guest', guestDir.replace(/\/$/, ''))
    .replaceAll('/tmp/kin-seed', path.join(fx.root, 'seed'))
  fx.write(path.join(fx.root, 'id_ed25519.pub'), 'fixture-key\n')
  fx.write(path.join(fx.root, 'instance-id'), 'fixture\n')
  const capture = path.join(fx.root, 'captured.env')
  for (const enabled of ['', '0', 'true', '1']) {
    const result = spawnSync(
      '/bin/bash',
      ['-c', `set -eu\ngenisoimage() { cp guest.env "$CAPTURE"; }\n${seedFunction}\nwrite_seed`],
      {
        env: {
          ...fx.env,
          KIN_KVM_KERNEL_CPU_LIMIT: enabled,
          SLOT_KVM: fx.root,
          CAPTURE: capture,
          KIN_VM_ID: 'vm-fixture',
          KIN_VM_NAME: 'fixture',
          KIN_VM_OS: 'ubuntu-24.04',
          KIN_KVM_UID: '1000',
          KIN_KVM_GID: '1000',
          KIN_KVM_HOSTNAME: 'fixture',
          KIN_KVM_MACHINE_ID: 'fixture',
          KIN_KVM_SHARES: 'home,run',
          TZ: 'UTC',
          LANG: 'C.UTF-8',
        },
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 0, result.stderr)
    const env = fs.readFileSync(capture, 'utf8')
    assert.equal(env.includes('KIN_KERNEL_CPU_CEILING=4\n'), enabled === '1')
    if (enabled !== '1') assert.equal(env.includes('KIN_KERNEL_CPU_CEILING='), false)
  }
})

unixTest('guest setup projects the seed cap into slot.env and removes a stale cap', (context) => {
  const fx = fixture(context)
  const setup = fs.readFileSync(path.join(guestDir, 'kin-guest-setup'), 'utf8')
  const writeEnv = setup
    .match(/write_slot_env\(\) \{[\s\S]*?\n\}/)[0]
    .replaceAll('/run/kin-guest', path.join(fx.root, 'run'))
    .replaceAll('/etc/systemd/system', path.join(fx.root, 'units'))
  for (const ceiling of ['2', '']) {
    const result = spawnSync(
      '/bin/sh',
      ['-c', `set -eu\nchown() { :; }\nsystemctl() { :; }\n${writeEnv}\nwrite_slot_env`],
      {
        env: { ...fx.env, KIN_KERNEL_CPU_CEILING: ceiling, KIN_KVM_GID: '1000' },
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 0, result.stderr)
    const env = fs.readFileSync(path.join(fx.root, 'run/slot.env'), 'utf8')
    assert.equal(env.includes('KIN_KERNEL_CPU_CEILING=2\n'), ceiling === '2')
    if (!ceiling) assert.equal(env.includes('KIN_KERNEL_CPU_CEILING='), false)
  }
  const install = fs.readFileSync(path.join(guestDir, 'install-guest.sh'), 'utf8')
  assert.ok(install.includes('install -m 0755 "$SEED/kin-kernel-cpu" /usr/local/sbin/kin-kernel-cpu'))
})
