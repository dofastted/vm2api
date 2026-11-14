import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  finishOAuthImport,
  prepareSlotOAuth,
  runGuestOAuthAuthService,
} from '../../src/lib/oauth/guest-oauth-helper.mjs'

test('OAuth without native telemetry uses the persisted bound exit without starting the slot', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-legacy-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  for (const health of [{ ok: true }, { ok: true, vm_telemetry: true, telemetry_ready: false }]) {
    for (const proxy of [{ id: 'px-bound', host: '127.0.0.1', port: 20881 }, { id: 'px-local' }]) {
      const vm = { id: 'vm-01', runtime: { type: 'docker' }, status: 'running', schedulable: false, proxy }
      const vmFile = path.join(root, 'vms', `${vm.id}.json`)
      const before = JSON.stringify(vm)
      fs.writeFileSync(vmFile, before)
      const inputs = []
      for (const payload of [
        { operation: 'exchange_code', code: 'fixture-code', code_verifier: 'fixture-verifier', state: 'fixture-state' },
        { operation: 'session_key', session_key: 'sk-ant-sid-fixture', runtime_mode: 'setup-token' },
      ]) {
        const credential = await runGuestOAuthAuthService(
          { ...payload, proxy_url: 'socks5h://127.0.0.1:1' },
          {
            exec: {
              projectRoot: root,
              vmId: vm.id,
              vm: { ...vm, proxy: { id: 'px-stale', host: '127.0.0.1', port: 1 } },
            },
            prepare: (options) =>
              prepareSlotOAuth({
                ...options,
                readHealth: async () => health,
                startReady: async () => assert.fail('OAuth must not start or restart a legacy slot'),
              }),
            runDocker: async () => assert.fail('Legacy OAuth must not execute in the slot'),
            postTelemetry: async () => assert.fail('Missing telemetry must not delay OAuth'),
            runNative: async (input) => {
              inputs.push(input)
              return { access_token: 'fixture-access', refresh_token: 'fixture-refresh' }
            },
          },
        )
        assert.equal(credential.access_token, 'fixture-access')
        assert.equal(await finishOAuthImport(credential, true), null)
        assert.deepEqual(inputs.at(-1), {
          ...payload,
          proxy_url: proxy.id === 'px-local' ? '' : 'socks5h://127.0.0.1:20881',
        })
      }
      assert.equal(inputs.length, 2)
      assert.equal(fs.readFileSync(vmFile, 'utf8'), before)
    }
  }
})

test('guest OAuth helper delegates egress selection to the slot network', async () => {
  const inputs = []
  const proxies = [
    { id: 'px-loopback', host: '127.0.0.1', port: 20881 },
    { id: 'px-remote', host: '192.0.2.10', port: 1080 },
  ]

  for (const proxy of proxies) {
    const exec = {
      projectRoot: '/srv/vm2api',
      vmId: 'vm-01',
      vm: { id: 'vm-01', runtime: { type: 'docker' }, proxy },
    }
    const credential = await runGuestOAuthAuthService(
      {
        operation: 'exchange_code',
        code: 'fixture-code',
        code_verifier: 'fixture-verifier',
        proxy_url: 'socks5h://127.0.0.1:1',
      },
      {
        exec,
        prepare: async () => ({
          exec,
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
          return {
            code: 0,
            stdout: JSON.stringify({ ok: true, credential: { access_token: 'fixture-access' } }),
          }
        },
      },
    )
    assert.equal(credential.access_token, 'fixture-access')
  }

  assert.equal(inputs.length, proxies.length)
  for (const input of inputs) {
    assert.equal(input.proxy_url, '')
    assert.equal(input.code, 'fixture-code')
  }
})
