import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  extractClaudeCodeHeaders,
  resolveCrsHeaders,
  storeAccountHeaders,
  loadStoredHeaders,
  isOfficialClaudeUa,
  isUnofficialClaudeEntrypointUa,
} from '../../src/lib/identity/crs-headers.mjs'
import { mergeGuestFingerprint } from '../../src/lib/vm/guest-identity.mjs'
import { loadVmIdentity } from '../../src/lib/identity/vm-identity.mjs'

test('sub2api-style prefix treats vscode / cowork / desktop as official UA', () => {
  assert.equal(isOfficialClaudeUa('claude-cli/2.1.234 (external, cli)'), true)
  assert.equal(isOfficialClaudeUa('claude-cli/2.1.234 (external, sdk-cli)'), true)
  assert.equal(isOfficialClaudeUa('claude-cli/2.1.241 (external, claude-vscode, agent-sdk/0.3.241)'), true)
  assert.equal(isOfficialClaudeUa('claude-cli/2.1.241 (external, local-agent, agent-sdk/0.3.241)'), true)
  assert.equal(isOfficialClaudeUa('claude-cli/2.1.215 (external, claude-desktop-3p, agent-sdk/0.3.215)'), true)
  assert.equal(isOfficialClaudeUa('claude-cli/2.1.128 (external, claude-desktop)'), true)
  assert.equal(isUnofficialClaudeEntrypointUa('claude-cli/2.1.128 (external, claude-desktop)'), false)
  assert.equal(isUnofficialClaudeEntrypointUa('claude-cli/2.1.165 (external, local-agent)'), false)
  assert.equal(isOfficialClaudeUa('Go-http-client/2.0'), false)
  assert.equal(isOfficialClaudeUa('claude-cli/'), false)
})

test('official family UA stores protocol and still pins slot UA', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-desk-'))
  const identity = {
    userAgent: 'claude-cli/2.1.234 (external, cli)',
    fingerprint: { x_app: 'cli', stainless_os: 'Linux' },
  }
  const stored = resolveCrsHeaders(
    {
      'user-agent': 'claude-cli/2.1.241 (external, claude-vscode, agent-sdk/0.3.241)',
      'anthropic-beta': 'claude-code-20250219,context-1m-2025-08-07',
    },
    dir,
    identity,
    'claude-sonnet-5',
  )
  assert.equal(stored['user-agent'], 'claude-cli/2.1.234 (external, cli)')
  assert.doesNotMatch(stored['user-agent'], /claude-vscode|agent-sdk/)
  assert.match(String(stored['anthropic-beta'] || ''), /context-1m/)
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'kin-cc-headers.json')), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('does not keep authorization or x-api-key', () => {
  const h = extractClaudeCodeHeaders({
    authorization: 'Bearer secret',
    'x-api-key': 'sk-ant',
    'user-agent': 'claude-cli/2.1.234 (external, cli)',
    'anthropic-version': '2023-06-01',
  })
  assert.equal(h.authorization, undefined)
  assert.equal(h['x-api-key'], undefined)
  assert.equal(h['user-agent'].startsWith('claude-cli/'), true)
})

test('unofficial UA replays stored official headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-h-'))
  resolveCrsHeaders(
    {
      'user-agent': 'claude-cli/2.1.234 (external, sdk-cli)',
      'x-stainless-os': 'Linux',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    dir,
  )
  const replayed = resolveCrsHeaders({ 'user-agent': 'python-requests/2.24.0' }, dir)
  assert.equal(replayed['user-agent'].startsWith('claude-cli/'), true)
  assert.equal(isOfficialClaudeUa('python-requests/2.24.0'), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('official sonnet-5 keeps context-1m; others and unofficial drop it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-1m-'))
  const officialSonnet = resolveCrsHeaders(
    {
      'user-agent': 'claude-cli/2.1.234 (external, cli)',
      'anthropic-beta': 'context-1m-2025-08-07,oauth-2025-04-20',
    },
    dir,
    null,
    'claude-sonnet-5',
  )
  assert.match(String(officialSonnet['anthropic-beta'] || ''), /context-1m-2025-08-07/)
  const officialOpus = resolveCrsHeaders(
    {
      'user-agent': 'claude-cli/2.1.234 (external, cli)',
      'anthropic-beta': 'context-1m-2025-08-07,oauth-2025-04-20',
    },
    dir,
    null,
    'claude-opus-5',
  )
  assert.doesNotMatch(String(officialOpus['anthropic-beta'] || ''), /context-1m-2025-08-07/)
  const unofficial = resolveCrsHeaders(
    {
      'user-agent': 'RikkaHub/1.0',
      'anthropic-beta': 'context-1m-2025-08-07,oauth-2025-04-20',
    },
    dir,
    null,
    'claude-sonnet-5',
  )
  assert.doesNotMatch(String(unofficial['anthropic-beta'] || ''), /context-1m-2025-08-07/)
  assert.match(String(unofficial['anthropic-beta'] || ''), /context-management-2025-06-27/)
  const unofficial1m = resolveCrsHeaders(
    {
      'user-agent': 'Go-http-client/2.0',
    },
    dir,
    null,
    'claude-sonnet-5[1m]',
  )
  assert.match(String(unofficial1m['anthropic-beta'] || ''), /context-1m-2025-08-07/)
  const unofficialWant = resolveCrsHeaders(
    {
      'user-agent': 'Go-http-client/2.0',
    },
    dir,
    null,
    'claude-sonnet-5',
    { want1m: true },
  )
  assert.match(String(unofficialWant['anthropic-beta'] || ''), /context-1m-2025-08-07/)
  const unofficialOpus1m = resolveCrsHeaders(
    {
      'user-agent': 'Go-http-client/2.0',
    },
    dir,
    null,
    'claude-opus-5[1m]',
  )
  assert.doesNotMatch(String(unofficialOpus1m['anthropic-beta'] || ''), /context-1m-2025-08-07/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('official empty beta uses sub2api DefaultBetaHeader; unofficial uses full mimicry set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-def-'))
  const official = resolveCrsHeaders(
    {
      'user-agent': 'claude-cli/2.1.234 (external, cli)',
      'anthropic-version': '2023-06-01',
    },
    dir,
    null,
    'claude-sonnet-5',
  )
  assert.match(String(official['anthropic-beta'] || ''), /claude-code-20250219/)
  assert.match(String(official['anthropic-beta'] || ''), /oauth-2025-04-20/)
  assert.match(String(official['anthropic-beta'] || ''), /thinking-token-count-2026-05-13/)
  assert.match(String(official['anthropic-beta'] || ''), /mid-conversation-system-2026-04-07/)
  assert.match(String(official['anthropic-beta'] || ''), /context-management-2025-06-27/)
  assert.doesNotMatch(String(official['anthropic-beta'] || ''), /fine-grained-tool-streaming/)
  assert.doesNotMatch(String(official['anthropic-beta'] || ''), /context-1m/)
  const haiku = resolveCrsHeaders(
    {
      'user-agent': 'claude-cli/2.1.234 (external, cli)',
    },
    dir,
    null,
    'claude-haiku-4-5-20251001',
  )
  assert.match(String(haiku['anthropic-beta'] || ''), /oauth-2025-04-20/)
  assert.doesNotMatch(String(haiku['anthropic-beta'] || ''), /claude-code-20250219/)
  const unofficial = resolveCrsHeaders({ 'user-agent': 'RikkaHub/1.0' }, dir, null, 'claude-opus-5')
  assert.match(String(unofficial['anthropic-beta'] || ''), /claude-code-20250219/)
  assert.match(String(unofficial['anthropic-beta'] || ''), /thinking-token-count-2026-05-13/)
  assert.match(String(unofficial['anthropic-beta'] || ''), /mid-conversation-system-2026-04-07/)
  assert.match(String(unofficial['anthropic-beta'] || ''), /context-management-2025-06-27/)
  assert.doesNotMatch(String(unofficial['anthropic-beta'] || ''), /context-1m-2025-08-07/)
  assert.equal(unofficial['anthropic-dangerous-direct-browser-access'], 'true')
  assert.equal(unofficial['x-stainless-runtime-version'], 'v26.3.0')
  assert.equal(unofficial['x-stainless-retry-count'], '0')
  assert.equal(unofficial['x-stainless-timeout'], '600')
  assert.match(unofficial['user-agent'], /\(external, sdk-cli\)$/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('unofficial inbound two-token beta does not leak; UA is Claude Code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-leak-'))
  const identity = {
    userAgent: 'claude-cli/2.1.234 (external, cli)',
    fingerprint: {
      x_app: 'cli',
      stainless_lang: 'js',
      stainless_os: 'Linux',
      stainless_arch: 'x64',
      stainless_runtime: 'node',
      stainless_runtime_version: 'v24.3.0',
      stainless_package_version: '0.112.1',
    },
  }
  const out = resolveCrsHeaders(
    {
      'user-agent': 'Go-http-client/2.0',
      'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
      'x-stainless-os': 'Windows',
    },
    dir,
    identity,
    'claude-fable-5',
  )
  assert.match(out['user-agent'], /^claude-cli\//)
  assert.doesNotMatch(out['user-agent'], /Go-http-client/)
  assert.equal(out['x-stainless-os'], 'Linux')
  assert.equal(out['x-stainless-runtime-version'], 'v26.3.0')
  assert.match(String(out['anthropic-beta'] || ''), /oauth-2025-04-20/)
  assert.match(String(out['anthropic-beta'] || ''), /context-management-2025-06-27/)
  const tokens = String(out['anthropic-beta'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  assert.ok(tokens.length >= 5)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('official inbound does not persist device headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-lock-'))
  const wrote = storeAccountHeaders(dir, {
    'user-agent': 'claude-cli/2.1.234 (external, cli)',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
    'x-stainless-os': 'Windows',
    'x-stainless-arch': 'arm64',
    'x-claude-code-session-id': 'user-session-aaa',
    'accept-language': 'zh-CN,zh;q=0.9',
  })
  assert.equal(wrote.stored, true)
  const stored = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'kin-cc-headers.json'), 'utf8'))
  assert.equal(stored.headers['anthropic-beta'].includes('oauth-2025-04-20'), true)
  assert.equal(stored.headers['x-stainless-os'], undefined)
  assert.equal(stored.headers['x-claude-code-session-id'], undefined)
  assert.equal(stored.headers['accept-language'], undefined)
  assert.equal(stored.headers['user-agent'], undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('outbound session and stainless come from the slot, not inbound', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-slot-'))
  const identity = {
    userAgent: 'claude-cli/2.1.233 (external, cli)',
    sessionId: 'slot-session-bbb',
    callerSessionId: 'user-session-aaa',
    locale: 'en_US.UTF-8',
    fingerprint: {
      x_app: 'cli',
      session_id: 'slot-session-bbb',
      locale: 'en_US.UTF-8',
      stainless_os: 'Linux',
      stainless_arch: 'x64',
    },
  }
  const out = resolveCrsHeaders(
    {
      'user-agent': 'claude-cli/2.1.234 (external, cli)',
      'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
      'x-stainless-os': 'Windows',
      'x-stainless-arch': 'arm64',
      'x-claude-code-session-id': 'user-session-aaa',
      'accept-language': 'zh-CN',
    },
    dir,
    identity,
    'claude-sonnet-5',
  )
  assert.equal(out['user-agent'], 'claude-cli/2.1.233 (external, cli)')
  assert.equal(out['x-stainless-os'], 'Linux')
  assert.equal(out['x-stainless-arch'], 'x64')
  assert.equal(out['x-claude-code-session-id'], 'user-session-aaa')
  assert.equal(out['accept-language'], 'en-US')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('legacy stored device headers are stripped on load and not replayed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-legacy-'))
  const file = path.join(dir, '.claude', 'kin-cc-headers.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({
      headers: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': 'claude-cli/9.9.9 (external, cli)',
        'x-stainless-os': 'Windows',
        'x-claude-code-session-id': 'legacy-user-session',
        'accept-language': 'ja',
      },
    }),
  )
  const loaded = loadStoredHeaders(dir)
  assert.equal(loaded['anthropic-beta'], 'oauth-2025-04-20')
  assert.equal(loaded['x-stainless-os'], undefined)
  assert.equal(loaded['x-claude-code-session-id'], undefined)
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(onDisk.headers['x-stainless-os'], undefined)
  const out = resolveCrsHeaders(
    {
      'user-agent': 'python-requests/2.24.0',
    },
    dir,
    {
      userAgent: 'claude-cli/2.1.233 (external, cli)',
      sessionId: 'slot-session-ccc',
      callerSessionId: 'user-session-ccc',
      fingerprint: { session_id: 'slot-session-ccc', stainless_os: 'Linux' },
    },
    'claude-opus-5',
  )
  assert.equal(out['x-stainless-os'], 'Linux')
  assert.equal(out['x-claude-code-session-id'], 'user-session-ccc')
  assert.doesNotMatch(out['user-agent'], /9\.9\.9/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('unofficial Haiku uses short beta set without context-management', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-haiku-'))
  const out = resolveCrsHeaders(
    {
      'user-agent': 'Go-http-client/2.0',
      'anthropic-beta': 'claude-code-20250219,context-management-2025-06-27,effort-2025-11-24',
    },
    dir,
    {
      userAgent: 'claude-cli/2.1.234 (external, cli)',
      fingerprint: { x_app: 'cli', stainless_os: 'Linux' },
    },
    'claude-haiku-4-5-20251001',
  )
  assert.match(out['user-agent'], /^claude-cli\//)
  assert.match(String(out['anthropic-beta'] || ''), /oauth-2025-04-20/)
  assert.doesNotMatch(String(out['anthropic-beta'] || ''), /context-management-2025-06-27/)
  assert.doesNotMatch(String(out['anthropic-beta'] || ''), /effort-2025-11-24/)
  assert.doesNotMatch(String(out['anthropic-beta'] || ''), /context-1m/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('gateway and wiggly Claude headers never reach outbound', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-drop-'))
  const inbound = {
    'user-agent': 'claude-cli/2.1.303 (external, cli)',
    'x-app': 'cli',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    'x-stainless-lang': 'js',
    'x-stainless-runtime': 'node',
    'x-stainless-package-version': '0.128.0',
    'x-claude-code-session-id': '3218348e-644b-49c0-a2d1-6d40d5eba9dc',
    'x-claude-code-wiggly-dove': 'drop-me',
    cc_gateway: 'drop-me',
  }
  const out = resolveCrsHeaders(
    inbound,
    dir,
    { userAgent: 'claude-cli/2.1.296 (external, cli)', callerSessionId: 'slot-session' },
    'claude-opus-5-5',
  )
  assert.equal(out['x-claude-code-wiggly-dove'], undefined)
  assert.equal(out.cc_gateway, undefined)
  assert.equal(out['x-claude-code-session-id'], 'slot-session')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('guest locale and amd64 arch map onto outbound /v1 headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-guest-'))
  const merged = mergeGuestFingerprint(
    { device_id: 'dev-keep', session_id: 'sess-keep' },
    {
      locale: 'en_US.UTF-8',
      timezone: 'America/Los_Angeles',
      arch: 'amd64',
      goos: 'linux',
      os_pretty: 'Ubuntu 24.04',
      hostname: '01',
    },
  )
  const identity = loadVmIdentity({
    vmId: 'vm-02',
    homeDir: dir,
    vm: { fingerprint: merged, claude_code_version: '2.1.234' },
  })
  identity.callerSessionId = 'user-sess-keep'
  const out = resolveCrsHeaders(
    {
      'user-agent': 'Go-http-client/2.0',
      'x-stainless-arch': 'arm64',
      'accept-language': 'zh-CN',
    },
    dir,
    identity,
    'claude-sonnet-5',
  )
  assert.equal(out['x-stainless-arch'], 'x64')
  assert.equal(out['x-stainless-os'], 'Linux')
  assert.equal(out['x-stainless-runtime-version'], 'v26.3.0')
  assert.equal(out['x-stainless-retry-count'], '0')
  assert.equal(out['x-stainless-timeout'], '600')
  assert.equal(out['accept-language'], 'en-US')
  assert.equal(out['x-claude-code-session-id'], 'user-sess-keep')
  assert.equal(identity.fingerprint.session_id, 'sess-keep')
  assert.equal(identity.fingerprint.device_id, 'dev-keep')
  assert.equal(identity.fingerprint.locale, 'en_US.UTF-8')
  assert.equal(identity.fingerprint.timezone, 'America/Los_Angeles')
  fs.rmSync(dir, { recursive: true, force: true })
})
