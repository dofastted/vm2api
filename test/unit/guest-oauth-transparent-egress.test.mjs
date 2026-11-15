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

test('guest OAuth uses the installed native Claude version, and does not exchange when it is unreadable', async () => {
  const exec = {
    projectRoot: '/srv/vm2api',
    vmId: 'vm-01',
    vm: { id: 'vm-01', dataplane: 'crag', crag_kernel_version: 'v2', runtime_type: 'kvm' },
  }
  const calls = []
  const run = (stdout) =>
    runGuestOAuthAuthService(
      { operation: 'exchange_code', claude_version: '0.0.0' },
      {
        exec,
        prepare: async () => ({
          exec,
          host: {
            bakedKernel: true,
            bins: { oauthAuth: '/usr/local/bin/kin-oauth-auth' },
            dockerEnv: () => ({}),
            execUser: () => 'kincli',
          },
          configDir: '/home/kincli/.claude',
          home: '/home/kincli',
        }),
        postTelemetry: async () => ({ ok: true }),
        runDocker: async (argv, { stdin }) => {
          calls.push({ argv, stdin })
          if (argv.at(-1) === '--version') return { code: 0, stdout }
          return { code: 0, stdout: JSON.stringify({ ok: true, credential: { access_token: 'fixture-access' } }) }
        },
      },
    )
  await run('2.1.321 (Claude Code)\n')
  assert.equal(calls[0].argv.at(-1), '--version')
  assert.ok(calls[0].argv.includes('/usr/local/bin/kin-guest-exec'))
  assert.equal(JSON.parse(calls[1].stdin).claude_version, '2.1.321')
  await assert.rejects(run('unknown'), { code: 'oauth_cli_version_unavailable' })
  assert.equal(calls.length, 3)
})
