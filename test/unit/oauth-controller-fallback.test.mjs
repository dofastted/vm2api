// Slots whose kernel predates guest OAuth (no vm_telemetry in health) exchange on the
// controller through the slot's bound SOCKS instead of restarting the kernel and failing
// in prepareSlotOAuth.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  carryOAuthAttempt,
  exchangedOnController,
  runGuestOAuthAuthService,
} from '../../src/lib/oauth/guest-oauth-helper.mjs'
import { sessionKeyToOAuth } from '../../src/lib/oauth/cookie-auth.mjs'
import { exchangeAuthCode, generateAuthUrl, resetAuthUrlSessions } from '../../src/lib/oauth/oauth-auth-url.mjs'
import { slotExec } from '../../src/lib/vm/slot-runtime.mjs'

const CONTROLLER_PROXY = 'socks5h://127.0.0.1:1080'
const OLD_KERNEL = { ok: true, status: 200, engine: 'rust', cli_pid: 9531, ready_slots: 20, vm_telemetry: false }
const GUEST_KERNEL = { ...OLD_KERNEL, vm_telemetry: true, telemetry_ready: true }

function fixtureVm(t, proxy = { id: 'px-fixture', host: '127.0.0.1', port: 1080 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-fallback-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = { id: 'vm-01', runtime: { type: 'docker' }, ...(proxy ? { proxy } : {}) }
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  return { root, vm, exec: slotExec(root, vm) }
}

/** Guest-path seams that record what ran; prepare fails loudly so a wrong route is visible. */
function recorder(calls, { prepareResult } = {}) {
  return {
    prepare: async ({ exec }) => {
      calls.push('prepare')
      if (!prepareResult) throw Object.assign(new Error('guest path must not run'), { code: 'guest_path_used' })
      return { ...prepareResult, exec }
    },
    runDocker: async () => {
      calls.push('docker')
      return { code: 0, stdout: JSON.stringify({ ok: true, credential: { access_token: 'sk-ant-oat01-guest' } }) }
    },
    postTelemetry: async () => {
      calls.push('telemetry')
      return { ok: true }
    },
  }
}

const PAYLOAD = { operation: 'exchange_code', code: 'fixture-code', code_verifier: 'fixture-verifier', proxy_url: null }

test('old slot kernel: exchange runs on the controller via the bound SOCKS; the VM is not started or exec-ed', async (t) => {
  const { root, exec } = fixtureVm(t)
  const calls = []
  const seen = []
  const credential = await runGuestOAuthAuthService(PAYLOAD, {
    exec,
    projectRoot: root,
    controllerProxyUrl: CONTROLLER_PROXY,
    probeHealth: async (probeExec, opts) => {
      calls.push('probe')
      assert.equal(probeExec.vmId, 'vm-01')
      assert.ok(opts.timeoutMs > 0 && opts.timeoutMs <= 5000)
      return OLD_KERNEL
    },
    runNative: async (payload) => {
      calls.push('native')
      seen.push(payload)
      return { access_token: 'sk-ant-oat01-controller', refresh_token: 'sk-ant-ort01-controller' }
    },
    ...recorder(calls),
  })
  assert.deepEqual(calls, ['probe', 'native'])
  assert.equal(seen[0].proxy_url, CONTROLLER_PROXY)
  assert.equal(seen[0].operation, 'exchange_code')
  assert.equal(seen[0].code, 'fixture-code')
  assert.equal(seen[0].code_verifier, 'fixture-verifier')
  assert.equal(credential.access_token, 'sk-ant-oat01-controller')
  assert.equal(exchangedOnController(credential), true)
  // The marker is a symbol: it never reaches stored credentials or JSON responses.
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(credential))).sort(), ['access_token', 'refresh_token'])
})

test('unreachable slot kernel also takes the controller route instead of a restart', async (t) => {
  const { root, exec } = fixtureVm(t)
  const calls = []
  const credential = await runGuestOAuthAuthService(PAYLOAD, {
    exec,
    projectRoot: root,
    controllerProxyUrl: CONTROLLER_PROXY,
    probeHealth: async () => {
      throw new Error('ECONNREFUSED')
    },
    runNative: async () => {
      calls.push('native')
      return { access_token: 'sk-ant-oat01-controller' }
    },
    ...recorder(calls),
  })
  assert.deepEqual(calls, ['native'])
  assert.equal(exchangedOnController(credential), true)
})

test('a kernel that advertises vm_telemetry keeps the upstream in-VM exchange', async (t) => {
  const { root, exec } = fixtureVm(t)
  const calls = []
  const prepareResult = {
    host: {
      bins: { oauthAuth: '/usr/local/bin/kin-oauth-auth' },
      dockerEnv: () => ({}),
      execUser: () => 'kincli',
    },
    configDir: '/home/kincli/.claude',
    home: '/home/kincli',
  }
  const credential = await runGuestOAuthAuthService(PAYLOAD, {
    exec,
    projectRoot: root,
    controllerProxyUrl: CONTROLLER_PROXY,
    probeHealth: async () => GUEST_KERNEL,
    runNative: async () => {
      calls.push('native')
      return { access_token: 'wrong-route' }
    },
    ...recorder(calls, { prepareResult }),
  })
  assert.deepEqual(calls, ['prepare', 'telemetry', 'docker'])
  assert.equal(credential.access_token, 'sk-ant-oat01-guest')
  assert.equal(exchangedOnController(credential), false)
})

test('a VM without bound egress never falls back to a controller proxy', async (t) => {
  const { root, exec } = fixtureVm(t, null)
  const calls = []
  await assert.rejects(
    () =>
      runGuestOAuthAuthService(PAYLOAD, {
        exec,
        projectRoot: root,
        controllerProxyUrl: CONTROLLER_PROXY,
        probeHealth: async () => {
          calls.push('probe')
          return OLD_KERNEL
        },
        runNative: async () => {
          calls.push('native')
          return { access_token: 'wrong-route' }
        },
      }),
    { code: 'proxy_required' },
  )
  assert.deepEqual(calls, [])
})

test('old kernel without a controller route is refused, not exchanged directly', async (t) => {
  const { root, exec } = fixtureVm(t)
  const calls = []
  await assert.rejects(
    () =>
      runGuestOAuthAuthService(PAYLOAD, {
        exec,
        projectRoot: root,
        controllerProxyUrl: null,
        probeHealth: async () => OLD_KERNEL,
        runNative: async () => {
          calls.push('native')
          return { access_token: 'wrong-route' }
        },
        ...recorder(calls),
      }),
    { code: 'proxy_required' },
  )
  assert.deepEqual(calls, [])
})

test('callers that do not offer a controller route keep the upstream path', async (t) => {
  const { root, exec } = fixtureVm(t)
  const calls = []
  await assert.rejects(
    () =>
      runGuestOAuthAuthService(PAYLOAD, {
        exec,
        projectRoot: root,
        probeHealth: async () => {
          calls.push('probe')
          return OLD_KERNEL
        },
        runNative: async () => {
          calls.push('native')
          return { access_token: 'wrong-route' }
        },
        ...recorder(calls),
      }),
    { code: 'guest_path_used' },
  )
  assert.deepEqual(calls, ['prepare'])
})

test('controller helper output without an access token is rejected', async (t) => {
  const { root, exec } = fixtureVm(t)
  await assert.rejects(
    () =>
      runGuestOAuthAuthService(PAYLOAD, {
        exec,
        projectRoot: root,
        controllerProxyUrl: CONTROLLER_PROXY,
        probeHealth: async () => OLD_KERNEL,
        runNative: async () => ({ refresh_token: 'only-refresh' }),
      }),
    { code: 'oauth_auth_output_invalid' },
  )
})

test('carryOAuthAttempt keeps the controller marker on the rebuilt credential', async (t) => {
  const { root, exec } = fixtureVm(t)
  const credential = await runGuestOAuthAuthService(PAYLOAD, {
    exec,
    projectRoot: root,
    controllerProxyUrl: CONTROLLER_PROXY,
    probeHealth: async () => OLD_KERNEL,
    runNative: async () => ({ access_token: 'sk-ant-oat01-controller' }),
  })
  const rebuilt = carryOAuthAttempt(credential, { access_token: credential.access_token, source: 'oauth-auth-url' })
  assert.equal(exchangedOnController(rebuilt), true)
  assert.equal(exchangedOnController(carryOAuthAttempt({}, {})), false)
  assert.equal(exchangedOnController(null), false)
})

/** Real panel entry points with the shipped controller spawn, using a stand-in helper binary. */
function fakeHelper(t, root) {
  const bin = path.join(root, 'kin-oauth-auth')
  const stdinFile = path.join(root, 'helper-stdin.json')
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'cat > "$KIN_TEST_OAUTH_STDIN"',
      `printf '%s\\n' '{"ok":true,"credential":{"access_token":"sk-ant-oat01-fixture","refresh_token":"sk-ant-ort01-fixture","expires_in":3600}}'`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const saved = { bin: process.env.KIN_OAUTH_AUTH_BIN, stdin: process.env.KIN_TEST_OAUTH_STDIN }
  process.env.KIN_OAUTH_AUTH_BIN = bin
  process.env.KIN_TEST_OAUTH_STDIN = stdinFile
  t.after(() => {
    if (saved.bin === undefined) delete process.env.KIN_OAUTH_AUTH_BIN
    else process.env.KIN_OAUTH_AUTH_BIN = saved.bin
    if (saved.stdin === undefined) delete process.env.KIN_TEST_OAUTH_STDIN
    else process.env.KIN_TEST_OAUTH_STDIN = saved.stdin
  })
  return () => JSON.parse(fs.readFileSync(stdinFile, 'utf8'))
}

test('authorization-link exchange on a slot without a guest kernel runs the controller helper via the link proxy', async (t) => {
  const { root, vm } = fixtureVm(t)
  const readStdin = fakeHelper(t, root)
  resetAuthUrlSessions()
  const link = generateAuthUrl({ vmId: vm.id, proxyUrl: 'socks5://127.0.0.1:1080', flavor: 'setup_token' })
  const state = new URL(link.auth_url).searchParams.get('state')
  const oauth = await exchangeAuthCode({
    sessionId: link.session_id,
    code: `fixture-code#${state}`,
    vmId: vm.id,
    exec: slotExec(root, vm),
    projectRoot: root,
  })
  const sent = readStdin()
  assert.equal(sent.operation, 'exchange_code')
  assert.equal(sent.code, 'fixture-code')
  assert.equal(sent.state, state)
  assert.ok(sent.code_verifier)
  assert.equal(sent.proxy_url, CONTROLLER_PROXY)
  assert.equal(oauth.access_token, 'sk-ant-oat01-fixture')
  assert.equal(oauth.refresh_token, 'sk-ant-ort01-fixture')
  assert.equal(exchangedOnController(oauth), true)
})

test('Cookie (sessionKey) import on a slot without a guest kernel runs the controller helper via the bound SOCKS', async (t) => {
  const { root, vm } = fixtureVm(t)
  const readStdin = fakeHelper(t, root)
  const oauth = await sessionKeyToOAuth('sk-ant-sid-unit-cookie', {
    exec: slotExec(root, vm),
    projectRoot: root,
    proxyUrl: CONTROLLER_PROXY,
    scope: 'inference',
  })
  const sent = readStdin()
  assert.equal(sent.operation, 'session_key')
  assert.equal(sent.session_key, 'sk-ant-sid-unit-cookie')
  assert.equal(sent.runtime_mode, 'setup-token')
  assert.equal(sent.proxy_url, CONTROLLER_PROXY)
  assert.equal(oauth.access_token, 'sk-ant-oat01-fixture')
  assert.equal(oauth.type, 'setup-token')
  assert.equal(exchangedOnController(oauth), true)
})
