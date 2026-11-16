import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { assertCragSubscriptionTarget } from '../../src/lib/vm/vm-runtime.mjs'
import { seedEncryptedPackage } from '../fixtures/crag-license.mjs'

const helper = fileURLToPath(new URL('../../docker/kin-kvm/guest/kin-crag-subscription', import.meta.url))
const linux = process.platform === 'linux'
const namespaces =
  linux &&
  process.getuid() === 0 &&
  spawnSync('unshare', ['--mount', '--propagation', 'private', 'true'], { timeout: 3000 }).status === 0
const mountTest = namespaces ? test : test.skip

// Every mutation is inside a private namespace. /run is a fresh tmpfs and the
// machine-id bind exists only there, so these tests never alter host identity.
const guest = String.raw`
import errno, hashlib, json, os, pathlib, subprocess, sys

helper = sys.argv[1]
scenario = json.load(sys.stdin)
subprocess.run(['mount', '-t', 'tmpfs', '-o', 'mode=0755,nodev,nosuid', 'tmpfs', '/run'], check=True)
run = pathlib.Path('/run/kin')
run.mkdir()
machine_id = 'a' * 32
machine_file = pathlib.Path('/run/fixture-machine-id')
machine_file.write_text(machine_id + '\n')
subprocess.run(['mount', '--bind', str(machine_file), '/etc/machine-id'], check=True)
base = pathlib.Path('/run/vm2api-crag')
request = {
  'action': 'publish', 'vm_id': 'vm-subscription-test',
  'machine_id': machine_id, 'uid': 1000, 'gid': 1000,
  'files': {
    'device': json.dumps({'vm_id': 'vm-subscription-test', 'machine_id_hash': hashlib.sha256(machine_id.encode()).hexdigest()}),
    'permit': 'CRAGS1.fixture-permit-one',
    'hostId': 'b' * 64,
    'entitlement': 'CRAGH2.fixture-entitlement-one',
  },
}

def invoke(action=None, overrides=None):
  value = dict(request)
  if action is not None: value['action'] = action
  if overrides: value.update(overrides)
  result = subprocess.run(['python3', helper], input=json.dumps(value), text=True, capture_output=True, timeout=10)
  return {'status': result.returncode, 'stdout': result.stdout.strip(), 'stderr': result.stderr.strip()}

def success(result):
  assert result['status'] == 0, result
  assert json.loads(result['stdout'])['ok'] is True, result

def rejected(result):
  assert result['status'] != 0, result
  assert 'fixture-permit' not in result['stdout'] + result['stderr'], result
  assert 'fixture-entitlement' not in result['stdout'] + result['stderr'], result

def metadata(file):
  stat = file.stat()
  return [stat.st_mode & 0o777, stat.st_uid, stat.st_gid]

def readonly(directory):
  try:
    (directory / 'must-not-write').write_text('forbidden')
  except OSError as error:
    return error.errno == errno.EROFS
  return False

def mounted(directory):
  return subprocess.run(['mountpoint', '-q', str(directory)]).returncode == 0

license = run / 'crag-license'
host = run / 'crag-host'
if scenario['name'] == 'publish':
  success(invoke())
  result = {
    'base': metadata(base), 'license': metadata(license), 'host': metadata(host),
    'device': metadata(license / 'device.json'), 'permit': metadata(license / 'registration.code'),
    'host_id': metadata(host / 'host_id'), 'entitlement': metadata(host / 'entitlement.code'),
    'readonly': [readonly(license), readonly(host)],
    'pending': (host / 'sync-pending').exists(),
    'permit_bytes': (license / 'registration.code').read_text().strip() == request['files']['permit'],
    'filesystem': subprocess.check_output(['stat', '-f', '-c', '%T', str(license)], text=True).strip(),
  }
elif scenario['name'] == 'renew':
  success(invoke())
  previous = (host / 'entitlement.code').open()
  success(invoke('block'))
  assert (host / 'sync-pending').exists()
  assert (host / 'entitlement.code').read_text().strip() == request['files']['entitlement']
  files = {**request['files'], 'permit': 'CRAGS1.fixture-permit-two', 'entitlement': 'CRAGH2.fixture-entitlement-two'}
  success(invoke(overrides={'files': files}))
  result = {
    'pending': (host / 'sync-pending').exists(),
    'old_fd': previous.read().strip() == request['files']['entitlement'],
    'new_path': (host / 'entitlement.code').read_text().strip() == files['entitlement'],
    'new_permit': (license / 'registration.code').read_text().strip() == files['permit'],
    'readonly': [readonly(license), readonly(host)],
  }
elif scenario['name'] == 'universal':
  offline = {'files': {'permit': 'CRAGU1.fixture-offline'}, 'machine_id': None, 'vm_id': None}
  machine_file.write_text('not-a-machine-id\n')
  success(invoke('publish-universal', offline))
  previous = (license / 'registration.code').stat()
  success(invoke('publish-universal', offline))
  current = (license / 'registration.code').stat()
  result = {
    'license': metadata(license), 'permit': metadata(license / 'registration.code'),
    'readonly': readonly(license), 'host_mounted': mounted(host),
    'no_device': not (license / 'device.json').exists(),
    'exact': (license / 'registration.code').read_text() == offline['files']['permit'],
    'unchanged': (previous.st_ino, previous.st_mtime_ns) == (current.st_ino, current.st_mtime_ns),
  }
elif scenario['name'] == 'subscription-universal-switch':
  success(invoke())
  host_fd = os.open(host, os.O_RDONLY | os.O_DIRECTORY)
  offline = {'files': {'permit': 'CRAGU1.fixture-offline'}, 'machine_id': None, 'vm_id': None}
  success(invoke('publish-universal', offline))
  marker = os.open('sync-pending', os.O_RDONLY, dir_fd=host_fd)
  assert os.read(marker, 64) == b'pending\n'
  os.close(marker)
  assert not mounted(host)
  assert readonly(license)
  assert (license / 'registration.code').read_text() == offline['files']['permit']
  success(invoke())
  os.close(host_fd)
  result = {
    'readonly': [readonly(license), readonly(host)],
    'pending': (host / 'sync-pending').exists(),
    'restored': (license / 'registration.code').read_text() == request['files']['permit'],
  }
elif scenario['name'] == 'identity':
  changes = scenario['changes']
  if changes == 'machine':
    overrides = {'machine_id': 'c' * 32}
  elif changes == 'device':
    overrides = {'files': {**request['files'], 'device': json.dumps({'vm_id': request['vm_id'], 'machine_id_hash': '0' * 64})}}
  else:
    overrides = {'uid': 0}
  rejected(invoke(overrides=overrides))
  result = {'mounted': mounted(license) or mounted(host)}
elif scenario['name'] == 'symlink':
  protected = pathlib.Path('/run/protected')
  protected.mkdir()
  sentinel = protected / 'sentinel'
  sentinel.write_text('keep')
  license.symlink_to(protected, target_is_directory=True)
  rejected(invoke())
  result = {'preserved': sentinel.read_text() == 'keep', 'link': license.is_symlink(), 'contents': sorted(p.name for p in protected.iterdir())}
elif scenario['name'] == 'failed-renew':
  success(invoke())
  success(invoke('block'))
  protected = pathlib.Path('/run/protected')
  protected.write_text('keep')
  source = base / 'license' / 'device.json'
  source.unlink()
  source.symlink_to(protected)
  rejected(invoke())
  result = {'pending': (host / 'sync-pending').exists(), 'preserved': protected.read_text() == 'keep'}
elif scenario['name'] == 'partial-renew':
  success(invoke())
  protected = pathlib.Path('/run/protected')
  protected.write_text('keep')
  source = base / 'host' / 'entitlement.code'
  source.unlink()
  source.symlink_to(protected)
  files = {**request['files'], 'permit': 'CRAGS1.fixture-permit-two', 'entitlement': 'CRAGH2.fixture-entitlement-two'}
  rejected(invoke(overrides={'files': files}))
  result = {
    'pending': (host / 'sync-pending').exists(),
    'updated_permit': (license / 'registration.code').read_text() == files['permit'],
    'preserved': protected.read_text() == 'keep',
  }
elif scenario['name'] == 'changed-directory-owner':
  success(invoke())
  success(invoke('block'))
  os.chown(base / 'license', 2000, 2000)
  rejected(invoke())
  result = {'pending': (host / 'sync-pending').exists(), 'owner': metadata(license)[1:]}
elif scenario['name'] == 'unchanged':
  success(invoke())
  before = [(p.stat().st_ino, p.stat().st_mtime_ns) for p in [license / 'device.json', license / 'registration.code', host / 'host_id', host / 'entitlement.code']]
  success(invoke())
  after = [(p.stat().st_ino, p.stat().st_mtime_ns) for p in [license / 'device.json', license / 'registration.code', host / 'host_id', host / 'entitlement.code']]
  result = {'unchanged': before == after, 'pending': (host / 'sync-pending').exists()}
elif scenario['name'] == 'large-entitlement':
  content = 'CRAGH2.' + 'A' * (scenario['bytes'] - 7)
  request['files']['entitlement'] = content
  success(invoke())
  file = host / 'entitlement.code'
  before = file.stat()
  success(invoke())
  after = file.stat()
  result = {
    'bytes': after.st_size,
    'exact': file.read_text() == content,
    'unchanged': (before.st_ino, before.st_mtime_ns) == (after.st_ino, after.st_mtime_ns),
    'pending': (host / 'sync-pending').exists(),
  }
elif scenario['name'] == 'oversized':
  success(invoke())
  success(invoke('block'))
  if scenario['field'] == 'entitlement':
    rejected(invoke(overrides={'files': {**request['files'], 'entitlement': 'A' * (1536 * 1024 + 1)}}))
  else:
    raw = subprocess.run(['python3', helper], input='A' * (2 * 1024 * 1024 + 1), text=True, capture_output=True, timeout=10)
    rejected({'status': raw.returncode, 'stdout': raw.stdout, 'stderr': raw.stderr})
  result = {'pending': (host / 'sync-pending').exists(), 'preserved': (host / 'entitlement.code').read_text() == request['files']['entitlement']}
elif scenario['name'] == 'status':
  def status(machine=machine_id, vm=request['vm_id']):
    value = subprocess.run(['python3', helper, '--status', machine, vm], text=True, capture_output=True, timeout=10)
    return {'status': value.returncode, 'stdout': value.stdout, 'stderr': value.stderr}
  rejected(status())
  success(invoke())
  success(status())
  rejected(status(vm='vm-another-slot'))
  rejected(status(machine='c' * 32))
  machine_file.write_text('c' * 32 + '\n')
  rejected(status())
  machine_file.write_text(machine_id + '\n')
  success(status())
  success(invoke('block'))
  rejected(status())
  success(invoke())
  success(status())
  success(invoke('clear'))
  rejected(status())
  result = {'checked': True}
elif scenario['name'] == 'wrong-filesystem':
  base.mkdir(mode=0o700)
  subprocess.run(['mount', '-t', 'ramfs', 'ramfs', str(base)], check=True)
  os.chmod(base, 0o700)
  marker = base / 'managed'
  marker.write_text('vm2api-crag-subscription-v1\n')
  marker.chmod(0o600)
  rejected(invoke())
  result = {
    'mounted': mounted(license) or mounted(host),
    'filesystem': subprocess.check_output(['stat', '-f', '-c', '%T', str(base)], text=True).strip(),
  }
elif scenario['name'] == 'setup-barrier':
  signal = pathlib.Path('/run/kin-guest/slot.env')
  signal.parent.mkdir()
  kind = scenario['signal']
  if kind == 'regular':
    signal.write_text('KIN_VM_ID=vm-subscription-test\n')
  elif kind == 'symlink':
    target = pathlib.Path('/run/fixture-setup-marker')
    target.write_text('KIN_VM_ID=vm-subscription-test\n')
    signal.symlink_to(target)
  elif kind == 'directory':
    signal.mkdir()
  outcome = invoke(overrides={'wait_for_setup': True})
  if kind == 'regular':
    success(outcome)
  else:
    rejected(outcome)
  result = {
    'status': outcome['status'],
    'retryable': outcome['stderr'] == 'CRAG guest setup is not ready',
    'created': base.exists(),
    'mounted': mounted(license) or mounted(host),
  }
elif scenario['name'] == 'foreign-mount':
  foreign = pathlib.Path('/run/foreign')
  foreign.mkdir()
  (foreign / 'sentinel').write_text('keep')
  host.mkdir()
  subprocess.run(['mount', '--bind', str(foreign), str(host)], check=True)
  original = host.stat()
  rejected(invoke('block'))
  assert not (base / 'host' / 'sync-pending').exists()
  rejected(invoke())
  rejected(invoke('clear'))
  current = host.stat()
  result = {
    'mounted': mounted(host),
    'identity': [original.st_dev, original.st_ino] == [current.st_dev, current.st_ino],
    'preserved': (host / 'sentinel').read_text() == 'keep',
    'contents': sorted(p.name for p in foreign.iterdir()),
  }
elif scenario['name'] == 'unmanaged-tmpfs':
  license.mkdir()
  subprocess.run(['mount', '-t', 'tmpfs', 'tmpfs', str(license)], check=True)
  original = license.stat()
  (license / 'registration.code').write_text('CRAGU1.previous-official-grant')
  rejected(invoke('block'))
  assert not (base / 'host' / 'sync-pending').exists()
  rejected(invoke('publish-universal', {'files': {'permit': 'CRAGU1.fixture-offline'}}))
  rejected(invoke())
  rejected(invoke('clear'))
  current = license.stat()
  result = {
    'mounted': mounted(license),
    'identity': [original.st_dev, original.st_ino] == [current.st_dev, current.st_ino],
    'preserved': (license / 'registration.code').read_text() == 'CRAGU1.previous-official-grant',
  }
elif scenario['name'] == 'clear':
  license.mkdir()
  (license / 'registration.code').write_text('CRAGU1.previous-grant')
  unrelated = pathlib.Path('/run/unrelated')
  unrelated.mkdir()
  subprocess.run(['mount', '-t', 'tmpfs', 'tmpfs', str(unrelated)], check=True)
  (unrelated / 'sentinel').write_text('keep')
  success(invoke())
  success(invoke('clear'))
  result = {
    'unmounted': not mounted(license) and not mounted(host),
    'original': (license / 'registration.code').read_text() == 'CRAGU1.previous-grant',
    'unrelated': mounted(unrelated) and (unrelated / 'sentinel').read_text() == 'keep',
  }
else:
  raise AssertionError('unknown scenario')
print(json.dumps(result))
`

function runGuest(scenario) {
  const result = spawnSync('unshare', ['--mount', '--propagation', 'private', 'python3', '-c', guest, helper], {
    input: JSON.stringify(scenario),
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stderr || String(result.error))
  return JSON.parse(result.stdout)
}

test('guest subscription helper rejects unprivileged publication before touching runtime files', {
  skip: !linux,
}, () => {
  const result = spawnSync('python3', ['-c', fs.readFileSync(helper, 'utf8')], {
    input: JSON.stringify({ action: 'publish', vm_id: 'vm-test', machine_id: 'a'.repeat(32), uid: 1000, gid: 1000 }),
    encoding: 'utf8',
    timeout: 5000,
    ...(process.getuid() === 0 ? { uid: 65534, gid: 65534 } : {}),
  })
  assert.notEqual(result.status, 0)
  assert.equal(result.error, undefined)
})

test('prepared subscription targets accept local and remote KVM aliases and reject unsupported identity', {
  skip: !linux,
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-kvm-prepared-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedEncryptedPackage(root)
  const vm = { id: 'vm-prepared', fingerprint: { guest_machine_id: 'a'.repeat(32) } }
  const machineDir = path.join(root, 'vms', vm.id)
  fs.mkdirSync(machineDir, { recursive: true })
  fs.writeFileSync(path.join(machineDir, 'machine-id'), `${vm.fingerprint.guest_machine_id}\n`)
  const prepared = (target) => assertCragSubscriptionTarget(root, target, {}, { allowPrepared: true })
  for (const runtime of [
    { runtime_type: 'kvm' },
    ...['kvm', 'qemu', 'libvirt'].map((type) => ({ runtime: { type } })),
  ]) {
    const target = { ...vm, ...runtime }
    assert.equal(prepared(target), true)
    assert.equal(prepared({ ...target, node_id: 'node-remote' }), true)
    for (const unsupported of [
      { node_platform: 'darwin' },
      { kind: 'codex' },
      { fingerprint: { guest_machine_id: 'b'.repeat(32) } },
    ]) {
      assert.throws(() => prepared({ ...target, ...unsupported }), { code: 'crag_subscription_target_unready' })
    }
  }
  assert.equal(fs.readFileSync(path.join(machineDir, 'machine-id'), 'utf8'), `${vm.fingerprint.guest_machine_id}\n`)
  fs.unlinkSync(path.join(machineDir, 'machine-id'))
  assert.equal(prepared({ ...vm, runtime_type: 'kvm' }), true)
  assert.equal(fs.existsSync(path.join(machineDir, 'machine-id')), false)
})

mountTest('guest subscription files use local storage, private ownership and read-only binds', () => {
  assert.deepEqual(runGuest({ name: 'publish' }), {
    base: [0o700, 0, 0],
    license: [0o700, 1000, 1000],
    host: [0o755, 0, 0],
    device: [0o600, 1000, 1000],
    permit: [0o600, 1000, 1000],
    host_id: [0o644, 0, 0],
    entitlement: [0o644, 0, 0],
    readonly: [true, true],
    pending: false,
    permit_bytes: true,
    filesystem: 'tmpfs',
  })
})

mountTest('blocking and renewal retain pending until fresh files are atomically published', () => {
  assert.deepEqual(runGuest({ name: 'renew' }), {
    pending: false,
    old_fd: true,
    new_path: true,
    new_permit: true,
    readonly: [true, true],
  })
})

mountTest('offline U1 publishes read-only private files without device or machine identity', () => {
  assert.deepEqual(runGuest({ name: 'universal' }), {
    license: [0o700, 1000, 1000],
    permit: [0o600, 1000, 1000],
    readonly: true,
    host_mounted: false,
    no_device: true,
    exact: true,
    unchanged: true,
  })
})

mountTest('managed S1 and U1 switch both ways while old host guards remain blocked', () => {
  assert.deepEqual(runGuest({ name: 'subscription-universal-switch' }), {
    readonly: [true, true],
    pending: false,
    restored: true,
  })
})

for (const changes of ['machine', 'device', 'uid']) {
  mountTest(`guest subscription publication rejects ${changes} identity mismatch`, () => {
    assert.deepEqual(runGuest({ name: 'identity', changes }), { mounted: false })
  })
}

mountTest('guest subscription publication rejects linked mount targets without changing their destinations', () => {
  assert.deepEqual(runGuest({ name: 'symlink' }), { preserved: true, link: true, contents: ['sentinel'] })
})

mountTest('a failed renewal leaves the guest blocked and never follows a private-file symlink', () => {
  assert.deepEqual(runGuest({ name: 'failed-renew' }), { pending: true, preserved: true })
})

mountTest('partial publication retains pending after a new permit but before the new entitlement', () => {
  assert.deepEqual(runGuest({ name: 'partial-renew' }), { pending: true, updated_permit: true, preserved: true })
})

mountTest('unexpected private-directory ownership fails closed without silently repairing identity', () => {
  assert.deepEqual(runGuest({ name: 'changed-directory-owner' }), { pending: true, owner: [2000, 2000] })
})

mountTest('an unchanged admission snapshot leaves file identities and timestamps intact', () => {
  assert.deepEqual(runGuest({ name: 'unchanged' }), { unchanged: true, pending: false })
})

for (const bytes of [70 * 1024, 1536 * 1024]) {
  mountTest(`a ${bytes}-byte H2 entitlement publishes without truncation or repeated rewrites`, () => {
    assert.deepEqual(runGuest({ name: 'large-entitlement', bytes }), {
      bytes,
      exact: true,
      unchanged: true,
      pending: false,
    })
  })
}

for (const field of ['entitlement', 'request']) {
  mountTest(`an oversized ${field} is rejected without exposing a stale unblocked grant`, () => {
    assert.deepEqual(runGuest({ name: 'oversized', field }), { pending: true, preserved: true })
  })
}

mountTest('guest readiness rejects changed machine identity, another slot, pending grants and cleared mounts', () => {
  assert.deepEqual(runGuest({ name: 'status' }), { checked: true })
})

mountTest('guest publication rejects storage which is not guest-local tmpfs', () => {
  assert.deepEqual(runGuest({ name: 'wrong-filesystem' }), { mounted: false, filesystem: 'ramfs' })
})

for (const signal of ['missing', 'regular', 'symlink', 'directory']) {
  mountTest(`guest publication waits for a regular setup marker: ${signal}`, () => {
    const ready = signal === 'regular'
    assert.deepEqual(runGuest({ name: 'setup-barrier', signal }), {
      status: ready ? 0 : signal === 'missing' ? 75 : 1,
      retryable: signal === 'missing',
      created: ready,
      mounted: ready,
    })
  })
}

mountTest('publication and cleanup preserve an administrator-owned mount', () => {
  assert.deepEqual(runGuest({ name: 'foreign-mount' }), {
    mounted: true,
    identity: true,
    preserved: true,
    contents: ['sentinel'],
  })
})

mountTest('unmarked upstream tmpfs requires a full guest reboot before managed publication', () => {
  assert.deepEqual(runGuest({ name: 'unmanaged-tmpfs' }), { mounted: true, identity: true, preserved: true })
})

mountTest('clearing managed binds restores the original grant and keeps unrelated mounts', () => {
  assert.deepEqual(runGuest({ name: 'clear' }), { unmounted: true, original: true, unrelated: true })
})
