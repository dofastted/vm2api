import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { loadVmIdentity, OFFICIAL_CLI_VERSION } from '../../src/lib/identity/vm-identity.mjs'

function exec(patch = {}) {
  return {
    vmId: 'vm-ha-identity',
    accountId: 'node-account',
    homeDir: '/forbidden/pod/cli-home',
    slotgate: { trusted: true, pgBindingReady: true, vmId: 'vm-ha-identity' },
    nodeIdentity: {
      ok: true,
      credential: {
        account_uuid: 'node-account',
        org_uuid: 'node-org',
        email: 'node@example.invalid',
        has_access: true,
      },
      identity: { account_uuid: 'node-account', org_uuid: 'node-org', email: 'node@example.invalid' },
    },
    oauth: { account_uuid: 'stale-pod-account', org_uuid: 'stale-pod-org', email: 'stale@example.invalid' },
    seedPolicy: { theme: 'light', telemetry_disabled: false },
    vm: {
      id: 'vm-ha-identity',
      fingerprint: {
        device_id: 'a'.repeat(64),
        session_id: 'pg-session',
        locale: 'en_US.UTF-8',
        timezone: 'Asia/Taipei',
      },
    },
    ...patch,
  }
}

function withoutFiles(callback) {
  const beforeMode = process.env.VM2API_CONTROL_PLANE_MODE
  const read = fs.readFileSync
  const calls = []
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes-ha'
  fs.readFileSync = (...args) => {
    calls.push(String(args[0]))
    throw new Error('Pod files forbidden')
  }
  try {
    callback(calls)
  } finally {
    fs.readFileSync = read
    if (beforeMode == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = beforeMode
  }
}

test('HA identity uses only captured node identity and the PG fingerprint without reading any Pod file', () => {
  withoutFiles((calls) => {
    const first = loadVmIdentity(exec())
    assert.equal(first.accountUuid, 'node-account')
    assert.equal(first.orgUuid, 'node-org')
    assert.equal(first.email, 'node@example.invalid')
    assert.equal(first.deviceId, 'a'.repeat(64))
    assert.equal(first.sessionId, 'pg-session')
    assert.equal(first.timezone, 'Asia/Taipei')
    assert.equal(first.settings.theme, 'light')
    assert.equal(first.cliVersion, OFFICIAL_CLI_VERSION)
    assert.equal(first.userId, null)
    assert.equal(first.displayName, null)
    assert.deepEqual(loadVmIdentity(exec()), first, 'two Pods produce the same identity snapshot')
    assert.equal(JSON.stringify(first).includes('stale-pod'), false)
    assert.deepEqual(calls, [])
  })
})

for (const [name, patch] of [
  ['missing node proof', { nodeIdentity: undefined }],
  ['failed node health', { nodeIdentity: { ok: false, credential: { account_uuid: 'node-account' } } }],
  ['different credential account', { nodeIdentity: { ok: true, credential: { account_uuid: 'other-account' } } }],
  [
    'identity account conflict',
    {
      nodeIdentity: {
        ok: true,
        credential: { account_uuid: 'node-account' },
        identity: { account_uuid: 'other-account' },
      },
    },
  ],
  ['missing PG fingerprint', { vm: { id: 'vm-ha-identity' } }],
  [
    'different PG VM',
    { vm: { id: 'another-vm', fingerprint: { device_id: 'a'.repeat(64), session_id: 'pg-session' } } },
  ],
  ['different captured VM', { slotgate: { trusted: true, pgBindingReady: true, vmId: 'another-vm' } }],
]) {
  test(`HA identity refuses ${name} before local IO`, () => {
    withoutFiles((calls) => {
      assert.throws(() => loadVmIdentity(exec(patch)), { code: 'ha_identity_unavailable' })
      assert.deepEqual(calls, [])
    })
  })
}
