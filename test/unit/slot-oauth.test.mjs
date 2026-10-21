import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { runSlotOauth } from '../../src/lib/transport/slot-oauth.mjs'

const exec = { vmId: 'vm-07', homeDir: '/tmp/vm-07/cli-home', vm: {} }

test('runSlotOauth builds the usage command with the slot owner and container', async () => {
  let argvSeen = null
  await runSlotOauth(exec, 'usage', {
    runDocker: async (argv) => {
      argvSeen = argv
      return { code: 0, stdout: '{"ok":true,"status":200,"body":{},"headers":{}}', stderr: '', timed_out: false }
    },
  })
  assert.deepEqual(argvSeen, [
    'exec',
    '-i',
    '-u',
    '10007:987',
    'kin-07',
    '/usr/local/bin/kin-worker',
    'oauth',
    'usage',
    '--config',
    '/run/kin/worker.json',
  ])
})

test('runSlotOauth builds the worker argv and sends count-tokens stdin', async () => {
  let seen = null
  const result = await runSlotOauth(exec, 'count-tokens', {
    body: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] },
    headers: { 'anthropic-version': '2023-06-01' },
    timeoutMs: 1234,
    runDocker: async (argv, options) => {
      seen = { argv, options }
      return {
        code: 0,
        stdout: 'diagnostic line\n{"ok":true,"status":200,"body":{"input_tokens":12},"headers":{"x-test":"ok"}}\n',
        stderr: '',
        timed_out: false,
      }
    },
  })

  assert.deepEqual(seen.argv, [
    'exec',
    '-i',
    '-u',
    '10007:987',
    'kin-07',
    '/usr/local/bin/kin-worker',
    'oauth',
    'count-tokens',
    '--config',
    '/run/kin/worker.json',
  ])
  assert.deepEqual(JSON.parse(seen.options.stdin), {
    body: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] },
    headers: { 'anthropic-version': '2023-06-01' },
  })
  assert.equal(seen.options.timeoutMs, 1234)
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    body: { input_tokens: 12 },
    headers: { 'x-test': 'ok' },
    via: 'slot-worker',
    attemptFinished: true,
  })
})

test('runSlotOauth sends reset-redeem stdin without wrapping it', async () => {
  let seen = null
  await runSlotOauth(exec, 'reset-redeem', {
    body: {
      organization_uuid: '11111111-1111-4111-8111-111111111111',
      grant_id: 'grant_next',
      request_id: 'a'.repeat(64),
    },
    runDocker: async (argv, options) => {
      seen = { argv, options }
      return {
        code: 0,
        stdout: '{"ok":true,"status":200,"body":{"result":"reset"},"headers":{}}\n',
        stderr: '',
        timed_out: false,
      }
    },
  })
  assert.equal(seen.argv[7], 'reset-redeem')
  assert.deepEqual(JSON.parse(seen.options.stdin), {
    organization_uuid: '11111111-1111-4111-8111-111111111111',
    grant_id: 'grant_next',
    request_id: 'a'.repeat(64),
  })
})

test('runSlotOauth includes --force only when requested', async () => {
  const calls = []
  const runDocker = async (argv) => {
    calls.push(argv)
    return {
      code: 0,
      stdout: '{"ok":true,"status":200,"body":{"refreshed":true},"headers":{}}',
      stderr: '',
      timed_out: false,
    }
  }
  await runSlotOauth(exec, 'refresh', { runDocker })
  await runSlotOauth(exec, 'refresh', { force: true, runDocker })
  assert.equal(calls[0].at(-1), '/run/kin/worker.json')
  assert.equal(calls[1].at(-1), '--force')
})

test('runSlotOauth parses the last non-empty JSON line', async () => {
  const result = await runSlotOauth(exec, 'usage', {
    runDocker: async () => ({
      code: 0,
      stdout: '\nworker started\n\n{"ok":true,"status":200,"body":{"five_hour":{"utilization":0.1}},"headers":{}}\n\n',
      stderr: '',
      timed_out: false,
    }),
  })
  assert.equal(result.body.five_hour.utilization, 0.1)
})

test('runSlotOauth maps timeout to a transport error', async () => {
  const result = await runSlotOauth(exec, 'profile', {
    timeoutMs: 5,
    runDocker: async () => ({ code: null, stdout: '', stderr: '', timed_out: true }),
  })
  assert.deepEqual(result, {
    ok: false,
    status: 0,
    body: { error: { code: 'worker_timeout' } },
    headers: {},
    via: 'slot-worker',
    transportError: true,
    attemptFinished: false,
  })
})

test('runSlotOauth reports invalid worker output with stderr context', async () => {
  const result = await runSlotOauth(exec, 'models', {
    runDocker: async () => ({
      code: 1,
      stdout: 'not json\n',
      stderr: 'worker failed\nsecret details',
      timed_out: false,
    }),
  })
  assert.deepEqual(result, {
    ok: false,
    status: 0,
    body: { error: { code: 'worker_output_invalid', message: 'worker failed\nsecret details' } },
    headers: {},
    via: 'slot-worker',
    transportError: true,
    attemptFinished: false,
  })
})

test('slot oauth guard prevents node-fetch Anthropic host calls', () => {
  const srcRoot = path.resolve('src')
  const files = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && file.endsWith('.mjs')) files.push(file)
    }
  }
  visit(srcRoot)
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    const hasNodeFetch = source.includes('node-fetch')
    const hasAnthropicHost =
      source.includes('api.anthropic.com') || source.includes('platform.claude.com/v1/oauth/token')
    assert.equal(
      hasNodeFetch && hasAnthropicHost,
      false,
      `forbidden host fetch in ${path.relative(process.cwd(), file)}`,
    )
  }
})
