import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  codexSessionUuid,
  codexSlotIdentity,
  codexTurnMetadata,
  rewriteCodexEnvironment,
} from '../../src/lib/protocol/codex-identity.mjs'

const DESKTOP_UA = 'Codex Desktop/0.166.0-alpha.5.1 (Mac OS 27.0.0; arm64) unknown (Codex Desktop; 26.1027.30824)'

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-identity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('a slot keeps one identity whether or not the caller has the routing snapshot', (t) => {
  const root = tempRoot(t)
  const vm = { id: 'gpt-01', timezone: 'America/New_York' }
  const routed = codexSlotIdentity(root, vm, { codex: { user_agent: DESKTOP_UA } })
  const runDir = path.join(root, 'vms', 'gpt-01', 'run')
  fs.writeFileSync(path.join(runDir, 'codex-kernel.json'), JSON.stringify({ user_agent: routed.userAgent }))
  assert.deepEqual(codexSlotIdentity(root, vm), routed)
  assert.deepEqual(codexSlotIdentity(root, vm, { codex: { user_agent: DESKTOP_UA } }), routed)
  assert.match(routed.installationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.match(routed.userAgent, /^Codex Desktop\/0\.166\.0-alpha\.5\.1 \(Mac OS 2[67]\.\d+\.\d+; arm64\) unknown/)
  assert.equal(routed.originator, 'Codex Desktop')
  assert.equal(routed.version, '0.166.0-alpha.5.1')
  assert.equal(routed.clientVersion, '0.166.0')
  assert.match(routed.home, /^\/Users\/[a-z]+$/)
})

test('environment_context reports the slot workstation, not the caller machine', () => {
  const identity = { home: '/Users/sam', shell: 'zsh', timezone: 'America/New_York' }
  const env = [
    '<environment_context>',
    '  <cwd>C:\\Users\\li.wei\\code\\app</cwd>',
    '  <shell>powershell</shell>',
    '  <current_date>2026-11-01</current_date>',
    '  <timezone>Asia/Shanghai</timezone>',
    '  <filesystem><workspace_roots><root>/Users/viccy/Documents/Codex</root><root>/opt/data</root></workspace_roots></filesystem>',
    '</environment_context>',
  ].join('\n')
  const body = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: env }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'open /Users/viccy/notes.md' }] },
    ],
  }
  const out = rewriteCodexEnvironment(body, identity, new Date('2026-10-31T16:00:00Z'))
  const text = out.input[0].content[0].text
  assert.match(text, /<cwd>\/Users\/sam\/code\/app<\/cwd>/)
  assert.match(text, /<shell>zsh<\/shell>/)
  assert.match(text, /<timezone>America\/New_York<\/timezone>/)
  assert.match(text, /<current_date>2026-10-31<\/current_date>/)
  assert.match(text, /<root>\/Users\/sam\/Documents\/Codex<\/root><root>\/opt\/data<\/root>/)
  assert.equal(out.input[1], body.input[1])
})

test('turn metadata carries the slot install and follows the outbound session', () => {
  const identity = { installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sandbox: 'seatbelt' }
  const caller = JSON.stringify({
    installation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    session_id: 'caller-sess',
    thread_id: 'caller-sess',
    window_id: 'caller-sess:2',
    turn_id: 'turn-1',
    sandbox: 'linux_seccomp',
  })
  assert.deepEqual(
    JSON.parse(codexTurnMetadata(caller, identity, { sessionId: 'out-sess', callerSession: 'caller-sess' })),
    {
      installation_id: identity.installationId,
      session_id: 'out-sess',
      thread_id: 'out-sess',
      window_id: 'out-sess:2',
      turn_id: 'turn-1',
      sandbox: 'seatbelt',
    },
  )
  const built = JSON.parse(codexTurnMetadata('', identity, { sessionId: 'out-sess' }))
  assert.equal(built.installation_id, identity.installationId)
  assert.equal(built.window_id, 'out-sess:0')
  assert.equal(codexTurnMetadata('{"installation_id":"bbbb', identity, { sessionId: 'out-sess' }), '')
  assert.equal(codexTurnMetadata('', identity), '')
})

test('session uuids are time-ordered v7 like official Codex ids', () => {
  const a = codexSessionUuid(1_793_464_752_000)
  const b = codexSessionUuid(1_793_464_753_000)
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.ok(a < b)
})
