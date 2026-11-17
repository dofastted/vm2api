import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { resolveSlotOAuthProxy } from '../../src/lib/vm/proxy-resolve.mjs'
import { hostProxyUrlForVm } from '../../src/lib/vm/slot-host.mjs'
import { prepareSlotOAuth, runGuestOAuthAuthService } from '../../src/lib/oauth/guest-oauth-helper.mjs'
import { exchangeAuthCode, generateAuthUrl, resetAuthUrlSessions } from '../../src/lib/oauth/oauth-auth-url.mjs'
import {
  exchangeCodexAuthCode,
  generateCodexAuthUrl,
  resetCodexAuthUrlSessions,
} from '../../src/lib/oauth/codex-oauth.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-exit-'))
}

/** A project root holding one VM record, as prepareSlotOAuth reads it from disk. */
function seedVm(vm) {
  const root = tmpDir()
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  return root
}

function poolWith(lines) {
  const pool = new ProxyPool({ dataDir: tmpDir() })
  pool.importLines(lines)
  pool.stopScheduler()
  return pool
}

/**
 * Exchange through the legacy-kernel path, which runs the helper on the
 * controller: whatever `proxy_url` the native helper is handed is the exit the
 * exchange actually leaves through.
 */
async function exchangeVia(root, vm, proxyPool) {
  const inputs = []
  const credential = await runGuestOAuthAuthService(
    { operation: 'session_key', session_key: 'sk-ant-sid-fixture' },
    {
      exec: { projectRoot: root, vmId: vm.id, vm },
      proxyPool,
      prepare: (options) =>
        prepareSlotOAuth({
          ...options,
          readHealth: async () => ({ ok: true }),
          startReady: async () => assert.fail('a legacy slot must not be started for OAuth'),
        }),
      runDocker: async () => assert.fail('the legacy path must not execute in the slot'),
      postTelemetry: async () => assert.fail('the legacy path posts no telemetry'),
      runNative: async (input) => {
        inputs.push(input)
        return { access_token: 'fixture-access' }
      },
    },
  )
  assert.equal(credential.access_token, 'fixture-access')
  return inputs.at(-1)
}

test('a pool reallocation inside the VM record decides the exchange exit', async () => {
  const pool = poolWith('socks5://a:pa@10.0.0.1:1080\nsocks5://b:pb@10.0.0.2:1080')
  const [first, second] = pool.snapshot().proxies.map((p) => p.id)
  // The VM record keeps the proxy it was bound to when it was written.
  const vm = { id: 'vm-realloc', runtime: { type: 'docker' }, proxy: { id: first, host: '10.0.0.1', port: 1080 } }
  const root = seedVm(vm)

  assert.equal(pool.bind(first, vm.id).ok, true)
  assert.equal((await exchangeVia(root, vm, pool)).proxy_url, 'socks5h://a:pa@10.0.0.1:1080')

  // Rebinding is the operator's move; the stale VM record must not survive it.
  assert.equal(pool.bind(second, vm.id).ok, true)
  assert.equal((await exchangeVia(root, vm, pool)).proxy_url, 'socks5h://b:pb@10.0.0.2:1080')
})

test('a disabled pool row refuses the exchange before any request leaves', async () => {
  const pool = poolWith('socks5://10.0.0.3:1080')
  const id = pool.snapshot().proxies[0].id
  const vm = { id: 'vm-dead', runtime: { type: 'docker' }, proxy: { id, host: '10.0.0.3', port: 1080 } }
  const root = seedVm(vm)
  assert.equal(pool.bind(id, vm.id).ok, true)
  pool.setEnabled(id, false)

  await assert.rejects(() => exchangeVia(root, vm, pool), { code: 'proxy_unavailable' })
})

test('IPv6 off refuses the exchange as a policy, not as a proxy fault', async () => {
  const vm = { id: 'vm-v6', runtime: { type: 'docker' }, proxy: { id: 'px-v6', host: '::1', port: 1080 } }
  const root = seedVm(vm)
  const pool = { snapshot: () => ({ proxies: [], config: { ipv6_enabled: false } }), getProxyForVm: () => null }

  await assert.rejects(() => exchangeVia(root, vm, pool), { code: 'ipv6_disabled' })
})

test('an unbound slot refuses rather than quietly taking the host route', async () => {
  const vm = { id: 'vm-unbound', runtime: { type: 'docker' }, proxy: null }
  const root = seedVm(vm)
  const pool = { snapshot: () => ({ proxies: [] }), getProxyForVm: () => null }

  await assert.rejects(() => exchangeVia(root, vm, pool), { code: 'proxy_required' })
})

test('a native node exchanges through the resolved exit, never the caller payload', async () => {
  const inputs = []
  const vm = { id: 'vm-native', node_id: 'node-mac', proxy: { id: 'px-n', host: '10.0.0.9', port: 1080 } }
  const credential = await runGuestOAuthAuthService(
    { operation: 'session_key', session_key: 'sk-ant-sid-fixture', proxy_url: 'socks5h://caller.invalid:1' },
    {
      exec: { projectRoot: '/srv/vm2api', vmId: vm.id, vm },
      // slotHost() needs a registered darwin node for host.native; the branch
      // itself is what this asserts, so prepare stands in for that lookup.
      prepare: async () => ({
        exec: { projectRoot: '/srv/vm2api', vmId: vm.id, vm },
        host: { native: true },
        controlPlane: true,
        proxyUrl: 'socks5h://10.0.0.9:1080',
      }),
      runDocker: async () => assert.fail('a native node has no container'),
      postTelemetry: async () => assert.fail('a native node posts no slot telemetry'),
      runNative: async (input) => {
        inputs.push(input)
        return { access_token: 'fixture-access' }
      },
    },
  )
  assert.equal(credential.access_token, 'fixture-access')
  assert.equal(inputs.at(-1).proxy_url, 'socks5h://10.0.0.9:1080')
})

test('guest execution stays on the transparent network even when an exit resolves', async () => {
  const inputs = []
  const vm = { id: 'vm-guest', runtime: { type: 'docker' }, proxy: { id: 'px-g', host: '10.0.0.4', port: 1080 } }
  const pool = poolWith('socks5://10.0.0.4:1080')
  const credential = await runGuestOAuthAuthService(
    { operation: 'exchange_code', code: 'fixture-code', code_verifier: 'fixture-verifier' },
    {
      exec: { projectRoot: '/srv/vm2api', vmId: vm.id, vm },
      proxyPool: pool,
      prepare: async () => ({
        exec: { projectRoot: '/srv/vm2api', vmId: vm.id, vm },
        host: {
          bins: { oauthAuth: '/usr/local/bin/kin-oauth-auth' },
          dockerEnv: () => ({}),
          execUser: () => 'kincli',
        },
        configDir: '/home/kincli/.claude',
        home: '/home/kincli',
      }),
      postTelemetry: async () => ({ ok: true }),
      runDocker: async (_argv, { stdin }) => {
        inputs.push(JSON.parse(stdin))
        return { code: 0, stdout: JSON.stringify({ ok: true, credential: { access_token: 'fixture-access' } }) }
      },
    },
  )
  assert.equal(credential.access_token, 'fixture-access')
  // The slot network picks the exit. A resolved URL may be a controller-local
  // forwarder, unreachable from the guest, so none is handed over.
  assert.equal(inputs.at(-1).proxy_url, '')
})

test('without a pool the resolved exit is what hostProxyUrlForVm gives', () => {
  for (const proxy of [
    { id: 'px-bound', host: '127.0.0.1', port: 20881 },
    { id: 'px-local', host: 'local', port: 0, scheme: 'local', url: null },
  ]) {
    const vm = { id: 'vm-nopool', runtime: { type: 'docker' }, proxy }
    assert.equal(resolveSlotOAuthProxy(vm, undefined), hostProxyUrlForVm(vm))
  }
})

test('an authorize session proxy snapshot never decides the exchange', async (t) => {
  t.after(resetAuthUrlSessions)
  const pool = poolWith('socks5://a:pa@10.0.0.5:1080\nsocks5://b:pb@10.0.0.6:1080')
  const [first, second] = pool.snapshot().proxies.map((p) => p.id)
  const vm = { id: 'vm-session', runtime: { type: 'docker' }, proxy: { id: first, host: '10.0.0.5', port: 1080 } }
  const root = seedVm(vm)
  assert.equal(pool.bind(first, vm.id).ok, true)

  // The link is minted while the slot is on the first proxy; the session keeps
  // that URL. A helper standing in for kin-oauth-auth records what it is given.
  const generated = generateAuthUrl({ vmId: vm.id, proxyUrl: 'socks5h://a:pa@10.0.0.5:1080' })
  const capture = path.join(root, 'helper-stdin.json')
  const helper = path.join(root, 'fake-oauth-auth')
  fs.writeFileSync(
    helper,
    `#!/bin/sh\ncat > ${JSON.stringify(capture)}\nprintf '%s\\n' '{"ok":true,"credential":{"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_in":28800}}'\n`,
  )
  fs.chmodSync(helper, 0o755)
  const previous = process.env.KIN_OAUTH_AUTH_BIN
  process.env.KIN_OAUTH_AUTH_BIN = helper
  t.after(() => {
    if (previous === undefined) delete process.env.KIN_OAUTH_AUTH_BIN
    else process.env.KIN_OAUTH_AUTH_BIN = previous
  })

  // The exit moves while the authorize link is still inside SESSION_TTL_MS.
  assert.equal(pool.bind(second, vm.id).ok, true)
  const linked = await exchangeAuthCode({
    sessionId: generated.session_id,
    code: 'fixture-code#fixture-state',
    vmId: vm.id,
    exec: { projectRoot: root, vmId: vm.id, vm },
    projectRoot: root,
    proxyPool: pool,
  })
  assert.equal(linked.access_token, 'fixture-access')
  assert.equal(JSON.parse(fs.readFileSync(capture, 'utf8')).proxy_url, 'socks5h://b:pb@10.0.0.6:1080')
})

/** The state the authorize link carries, as the pasted callback returns it. */
function codexCallbackFor(generated) {
  const outer = new URL(generated.auth_url)
  const inner = new URL(outer.searchParams.get('authorize_url'))
  return `http://localhost:1455/auth/callback?code=fixture-code&state=${inner.searchParams.get('state')}`
}

test('Codex exchanges on the control plane through the exit resolved now', async (t) => {
  t.after(resetCodexAuthUrlSessions)
  const pool = poolWith('socks5://a:pa@10.0.0.7:1080\nsocks5://b:pb@10.0.0.8:1080')
  const [first, second] = pool.snapshot().proxies.map((p) => p.id)
  const vm = {
    id: 'vm-codex',
    platform: 'openai',
    runtime: { type: 'docker' },
    proxy: { id: first, host: '10.0.0.7', port: 1080 },
  }
  assert.equal(pool.bind(first, vm.id).ok, true)
  const generated = generateCodexAuthUrl({ vmId: vm.id, proxyUrl: 'socks5h://a:pa@10.0.0.7:1080' })

  // The exit moves while the authorize link is still live.
  assert.equal(pool.bind(second, vm.id).ok, true)
  const seen = []
  const oauth = await exchangeCodexAuthCode({
    sessionId: generated.session_id,
    code: codexCallbackFor(generated),
    vmId: vm.id,
    vm,
    proxyPool: pool,
    exchange: async (opts) => {
      seen.push(opts.proxyUrl)
      return { ok: true, access_token: 'codex-access', refresh_token: 'codex-refresh', id_token: 'codex-id' }
    },
  })
  assert.equal(oauth.access_token, 'codex-access')
  assert.equal(oauth.flavor, 'codex')
  assert.deepEqual(seen, ['socks5h://b:pb@10.0.0.8:1080'])
})

test('Codex refuses the exchange when the pool row is unusable', async (t) => {
  t.after(resetCodexAuthUrlSessions)
  const pool = poolWith('socks5://10.0.0.9:1080')
  const id = pool.snapshot().proxies[0].id
  const vm = {
    id: 'vm-codex-dead',
    platform: 'openai',
    runtime: { type: 'docker' },
    proxy: { id, host: '10.0.0.9', port: 1080 },
  }
  assert.equal(pool.bind(id, vm.id).ok, true)
  const generated = generateCodexAuthUrl({ vmId: vm.id, proxyUrl: 'socks5h://10.0.0.9:1080' })
  pool.setEnabled(id, false)

  await assert.rejects(
    () =>
      exchangeCodexAuthCode({
        sessionId: generated.session_id,
        code: codexCallbackFor(generated),
        vmId: vm.id,
        vm,
        proxyPool: pool,
        exchange: async () => assert.fail('the exchange must not be attempted on an unusable exit'),
      }),
    { code: 'proxy_unavailable' },
  )
})
