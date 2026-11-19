import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  startAntigravityAuthLogin,
  readAntigravityAuthLogin,
  completeAntigravityAuthLogin,
  cancelAntigravityAuthLogin,
  stopAllAntigravityAuthLogins,
  antigravityAuthExecArgv,
  antigravityAuthVerifyArgv,
  validAuthUrl,
  materializeAntigravityCli,
} from '../../src/lib/oauth/antigravity-auth-login.mjs'

const vm = {
  id: 'vm-ag-auth',
  platform: 'antigravity',
  owner_user_id: 7,
  proxy: { id: 'auth-egress', host: '127.0.0.1', port: 1080 },
  runtime: { type: 'docker' },
}
const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=unique-state&code_challenge=unique-pkce'

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-auth-test-'))
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.kill = () => child.emit('exit', 0)
  child.stdin.on('finish', () => child.emit('exit', 0))
  const starts = []
  const args = {
    projectRoot: root,
    vm,
    actor: 'id:7',
    routing: { antigravity: { enabled: false } },
    ops: {
      startRuntime: async (...argv) => {
        starts.push(argv)
        return { ok: true }
      },
      materializeCli: () => '/home/kincli/.local/bin/agy',
      spawn: () => child,
    },
  }
  t.after(() => {
    stopAllAntigravityAuthLogins()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    args,
    child,
    starts,
    async begin() {
      const start = startAntigravityAuthLogin(args)
      assert.equal(start.ok, true)
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { ...args, sessionId: start.session.session_id }
    },
    event(value) {
      child.stdout.write(JSON.stringify(value) + '\n')
    },
  }
}

test('OAuth binds actor, owner and VM, and auth onboarding does not enable inference', async (t) => {
  const fixture = setup(t)
  const args = await fixture.begin()
  assert.equal(fixture.starts[0][2].forAuthentication, true)
  assert.equal(fixture.starts[0][2].routing.antigravity.enabled, false)
  fixture.event({ status: 'awaiting_code', auth_url: authUrl })
  assert.equal(readAntigravityAuthLogin(args).session.auth_url, authUrl)
  assert.equal(readAntigravityAuthLogin({ ...args, actor: 'id:8' }).status, 403)
  assert.equal(completeAntigravityAuthLogin({ ...args, actor: 'id:8', code: 'private-code' }).status, 403)
  assert.equal(startAntigravityAuthLogin({ ...args, actor: 'id:8' }).status, 409)
  assert.equal(readAntigravityAuthLogin({ ...args, vm: { ...vm, id: 'vm-other' } }).status, 404)
  assert.equal(readAntigravityAuthLogin({ ...args, vm: { ...vm, owner_user_id: 8 } }).status, 404)
})

test('Only explicit CLI authentication confirmation commits display metadata; codes never persist', async (t) => {
  const fixture = setup(t)
  const args = await fixture.begin()
  fixture.event({ status: 'awaiting_code', auth_url: authUrl })
  const code = '4/one-time-private-code'
  let input = ''
  fixture.child.stdin.on('data', (part) => {
    input += part
  })
  assert.equal(completeAntigravityAuthLogin({ ...args, code: 'bad\ncode' }).ok, false)
  const result = completeAntigravityAuthLogin({ ...args, code })
  assert.equal(result.session.status, 'verifying')
  assert.equal(result.session.auth_url, null)
  assert.equal(JSON.parse(input.trim()).code, code)
  assert.equal(completeAntigravityAuthLogin({ ...args, code }).status, 409)
  assert.equal(fs.existsSync(path.join(fixture.root, 'vms', vm.id, 'run', 'antigravity-auth.json')), false)
  fixture.event({ status: 'authenticated', authenticated: true, token: 'must-not-export' })
  const state = readAntigravityAuthLogin(args).session
  assert.equal(state.authenticated, true)
  assert.equal(state.status, 'authenticated')
  const metadata = fs.readFileSync(path.join(fixture.root, 'vms', vm.id, 'run', 'antigravity-auth.json'), 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(metadata)).sort(), ['authenticated', 'updated_at'])
  assert.equal(metadata.includes(code), false)
  assert.equal(metadata.includes('must-not-export'), false)
  assert.equal(JSON.stringify(state).includes('token'), false)
})

test('Cancel and CLI failure preserve existing official credentials and successful metadata', async (t) => {
  const fixture = setup(t)
  const file = path.join(fixture.root, 'vms', vm.id, 'run', 'antigravity-auth.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{"authenticated":true}\n')
  const args = await fixture.begin()
  fixture.event({ status: 'awaiting_code', auth_url: authUrl })
  const cancelled = cancelAntigravityAuthLogin(args)
  assert.equal(cancelled.session.status, 'cancelled')
  fixture.event({ status: 'authenticated', authenticated: true })
  assert.equal(readAntigravityAuthLogin(args).session.status, 'cancelled')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"authenticated":true}\n')
  const next = await fixture.begin()
  fixture.event({ status: 'failed', error: 'private-code and provider-token' })
  const failed = readAntigravityAuthLogin(next).session
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.includes('private-code'), false)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"authenticated":true}\n')
})

test('CLI exit and unrelated output never count as logged in', async (t) => {
  const fixture = setup(t)
  const args = await fixture.begin()
  fixture.event({ status: 'ready', authenticated: true })
  fixture.child.emit('exit', 0)
  assert.equal(readAntigravityAuthLogin(args).session.status, 'failed')
  assert.equal(fs.existsSync(path.join(fixture.root, 'vms', vm.id, 'run', 'antigravity-auth.json')), false)
})

test('Auth argv uses the slot identity and official PKCE URL validation rejects other origins', () => {
  const argv = antigravityAuthExecArgv(vm)
  assert.ok(argv.includes('10001:987'))
  assert.ok(argv.includes('HOME=/home/kincli'))
  assert.ok(argv.includes('kin-ag-auth'))
  assert.equal(
    argv.some((item) => /ANTHROPIC|OPENAI_API_KEY|GEMINI_API_KEY|HTTP_PROXY/.test(item)),
    false,
  )
  assert.equal(validAuthUrl(authUrl), true)
  assert.equal(validAuthUrl(authUrl.replace('accounts.google.com', 'accounts.google.com.example.com')), false)
  assert.equal(validAuthUrl(authUrl.replace('oauth-callback', 'other-callback')), false)
  assert.equal(validAuthUrl('javascript:alert(1)'), false)
  const verify = antigravityAuthVerifyArgv(vm, '/home/kincli/.local/bin/agy')
  assert.equal(verify.includes('-i'), false)
  assert.equal(verify.includes('-t'), false)
  assert.equal(verify.includes('10001:987'), true)
  for (const value of argv.filter((value) => /^(HOME|XDG_)/.test(value))) assert.equal(verify.includes(value), true)
  assert.deepEqual(verify.slice(-6), ['timeout', '-k', '2s', '15s', '/home/kincli/.local/bin/agy', 'models'])
})

test('auth runtime preparation persists running status without overwriting current slot fields', async (t) => {
  const fixture = setup(t)
  const record = path.join(fixture.root, 'vms', `${vm.id}.json`)
  fs.mkdirSync(path.dirname(record), { recursive: true })
  fs.writeFileSync(record, JSON.stringify({ ...vm, status: 'stopped', name: 'initial-name' }))
  const runtime = { type: 'docker', container: 'kin-ag-auth', stopped: false }
  fixture.args.ops.startRuntime = async () => {
    fs.writeFileSync(record, JSON.stringify({ ...vm, status: 'stopped', name: 'concurrent-update', custom_field: 123 }))
    return { ok: true, runtime }
  }
  await fixture.begin()
  const saved = JSON.parse(fs.readFileSync(record, 'utf8'))
  assert.deepEqual(saved.runtime, runtime)
  assert.equal(saved.status, 'running')
  assert.equal(saved.name, 'concurrent-update')
  assert.equal(saved.owner_user_id, vm.owner_user_id)
  assert.equal(saved.custom_field, 123)
})

test('Bundled CLI is materialized into the slot home without touching credential files', (t) => {
  const fixture = setup(t)
  const source = path.join(fixture.root, 'official-cli')
  fs.writeFileSync(source, 'ELF-fixture')
  const target = materializeAntigravityCli(fixture.root, vm, { source })
  assert.equal(target, '/home/kincli/.local/bin/agy')
  const local = path.join(fixture.root, 'vms', vm.id, 'cli-home', '.local', 'bin', 'agy')
  assert.equal(fs.readFileSync(local, 'utf8'), 'ELF-fixture')
  assert.equal(fs.statSync(local).mode & 0o777, 0o755)
})
