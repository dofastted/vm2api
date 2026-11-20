import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLAUDE_CLI_UA_RE,
  isOfficialClaudeUa,
  isUnofficialClaudeEntrypointUa,
} from '../../src/lib/identity/official-claude-ua.mjs'

test('matches only user agents with a claude-cli semver prefix', () => {
  assert.equal(CLAUDE_CLI_UA_RE.test('claude-cli/2.1.241 (external, claude-vscode, agent-sdk/0.3.241)'), true)
  assert.equal(isOfficialClaudeUa('CLAUDE-CLI/2.1.241 (external, local-agent, agent-sdk/0.3.241)'), true)
  assert.equal(isOfficialClaudeUa('claude-cli/2.1.241'), true)
  assert.equal(isOfficialClaudeUa('cwork/2.1.241'), false)
  assert.equal(isOfficialClaudeUa('Go-http-client/2.0'), false)
  assert.equal(isOfficialClaudeUa('claude-cli/'), false)
  assert.equal(isUnofficialClaudeEntrypointUa('claude-cli/2.1.241 (external, claude-vscode)'), false)
})
