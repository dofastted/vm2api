import test from 'node:test'
import assert from 'node:assert/strict'
import { runGuestOAuthAuthService } from '../../src/lib/oauth/guest-oauth-helper.mjs'

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
