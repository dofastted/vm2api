import test from 'node:test'
import assert from 'node:assert/strict'
import { KVM_GUEST_EXEC, slotExecArgv, slotExecCmd, slotExecContainer } from '../../src/lib/vm/slot-exec.mjs'

const docker = { id: 'vm-01', runtime: { type: 'docker' } }
const kvm = { id: 'vm-01', runtime: { type: 'kvm' } }

test('slotExecContainer prefers runtime.container then kin-<n>', () => {
  assert.equal(slotExecContainer({ id: 'vm-03' }), 'kin-03')
  assert.equal(slotExecContainer({ id: 'vm-03', runtime: { container: 'custom-slot' } }), 'custom-slot')
})

test('docker exec argv is byte-identical for flag mapping', () => {
  assert.deepEqual(slotExecArgv(docker, ['sh', '-c', 'true']), ['exec', 'kin-01', 'sh', '-c', 'true'])
  assert.deepEqual(slotExecArgv(docker, ['kill', '-CHLD', '1']), ['exec', 'kin-01', 'kill', '-CHLD', '1'])
  assert.deepEqual(
    slotExecArgv(docker, ['/usr/local/bin/kin-worker', 'telemetry', '--config', '/run/kin/worker.json'], {
      detach: true,
    }),
    ['exec', '-d', 'kin-01', '/usr/local/bin/kin-worker', 'telemetry', '--config', '/run/kin/worker.json'],
  )
  assert.deepEqual(
    slotExecArgv(docker, ['/usr/local/bin/kin-worker', 'oauth', 'refresh', '--config', '/run/kin/worker.json'], {
      interactive: true,
      user: '10001:987',
    }),
    [
      'exec',
      '-i',
      '-u',
      '10001:987',
      'kin-01',
      '/usr/local/bin/kin-worker',
      'oauth',
      'refresh',
      '--config',
      '/run/kin/worker.json',
    ],
  )
  assert.deepEqual(
    slotExecArgv(docker, ['/home/kincli/.kin/kin-kernel', '--gateway-worker', '--config', '/run/kin/kernel.json'], {
      detach: true,
      env: ['KIN_SUBMIT_WAIT_MS=30000', 'KIN_SLOT_MAX_LIFETIME_SECS=604800'],
    }),
    [
      'exec',
      '-d',
      '-e',
      'KIN_SUBMIT_WAIT_MS=30000',
      '-e',
      'KIN_SLOT_MAX_LIFETIME_SECS=604800',
      'kin-01',
      '/home/kincli/.kin/kin-kernel',
      '--gateway-worker',
      '--config',
      '/run/kin/kernel.json',
    ],
  )
  assert.deepEqual(
    slotExecArgv(docker, ['true'], { user: '0', env: ['FOO=bar baz', 'QUX=a=b', 'EMPTY='], workdir: '/home/kincli' }),
    ['exec', '-u', '0', '-e', 'FOO=bar baz', '-e', 'QUX=a=b', '-e', 'EMPTY=', '-w', '/home/kincli', 'kin-01', 'true'],
  )
  assert.deepEqual(slotExecArgv(docker, ['bash'], { interactive: true, tty: true, user: '10001:987' }), [
    'exec',
    '-i',
    '-t',
    '-u',
    '10001:987',
    'kin-01',
    'bash',
  ])
})

test('kvm moves -u/-e/-w and stdio flags onto kin-guest-exec', () => {
  assert.deepEqual(slotExecArgv(kvm, ['systemctl', 'restart', 'kin-kernel.service'], { user: '0' }), [
    'exec',
    'kin-01',
    KVM_GUEST_EXEC,
    '-u',
    '0',
    '--',
    'systemctl',
    'restart',
    'kin-kernel.service',
  ])
  assert.deepEqual(
    slotExecArgv(kvm, ['true'], {
      interactive: true,
      tty: true,
      detach: true,
      user: '10001:987',
      env: ['FOO=bar baz', 'EMPTY='],
      workdir: '/tmp',
    }),
    [
      'exec',
      '-i',
      '-t',
      '-d',
      'kin-01',
      KVM_GUEST_EXEC,
      '-u',
      '10001:987',
      '-e',
      'FOO=bar baz',
      '-e',
      'EMPTY=',
      '-w',
      '/tmp',
      '-i',
      '-t',
      '-d',
      '--',
      'true',
    ],
  )
})

test('slotExecCmd docker keeps User; kvm puts user on the shim', () => {
  assert.deepEqual(slotExecCmd(docker, ['/bin/sh', '-c', 'true'], { user: '10001:987' }), {
    Cmd: ['/bin/sh', '-c', 'true'],
    User: '10001:987',
  })
  assert.deepEqual(slotExecCmd(docker, ['/usr/local/bin/kin-worker', 'telemetry'], { detach: true }), {
    Cmd: ['/usr/local/bin/kin-worker', 'telemetry'],
    User: '',
  })
  assert.deepEqual(
    slotExecCmd(kvm, ['/usr/local/bin/kin-worker', 'telemetry', '--config', '/run/kin/worker.json'], {
      detach: true,
      user: '10001:987',
      env: ['A=b c'],
    }),
    {
      Cmd: [
        KVM_GUEST_EXEC,
        '-u',
        '10001:987',
        '-e',
        'A=b c',
        '-d',
        '--',
        '/usr/local/bin/kin-worker',
        'telemetry',
        '--config',
        '/run/kin/worker.json',
      ],
      User: '',
    },
  )
})
