import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vmHasClaudeCredential, vmHasSchedulableCredential } from '../../src/lib/vm/vm-registry.mjs'

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sched-cred-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  return root
}

/** A GPT seat the way the fleet writes it: Claude bag holds a stub, OAuth in codex-credentials.json. */
const GPT_SLOT = {
  id: 'vm-01',
  name: '01',
  status: 'running',
  platform: 'openai',
  family: 'codex',
  codex_kernel: true,
  claude: { refresh_error: 'credential_required' },
  codex: {},
}

test('GPT seat is credential-ready when codex-credentials.json holds the OAuth', () => {
  const root = makeRoot()
  fs.mkdirSync(path.join(root, 'vms', 'vm-01'))
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-01', 'codex-credentials.json'),
    JSON.stringify({ accounts: [{ access_token: 'at', refresh_token: 'rt' }] }),
  )
  assert.equal(vmHasSchedulableCredential(GPT_SLOT, root), true)
  // The Claude-only probe is what used to park every GPT seat as `no_credential`.
  assert.equal(vmHasClaudeCredential(GPT_SLOT), false)
})

test('GPT seat falls back to the record when the project root is unknown', () => {
  const withAccess = { ...GPT_SLOT, codex: { has_access: true } }
  assert.equal(vmHasSchedulableCredential(withAccess), true)
  assert.equal(vmHasSchedulableCredential({ ...GPT_SLOT, codex: { has_refresh: true } }), true)
})

test('GPT seat without any codex credential is still credential-less', () => {
  const root = makeRoot()
  assert.equal(vmHasSchedulableCredential(GPT_SLOT, root), false)
})

test('Claude seats keep using the Claude credential probe', () => {
  const ready = { id: 'vm-02', platform: 'anthropic', family: 'claude', claude: { access_token: 'at' } }
  const empty = { id: 'vm-03', platform: 'anthropic', family: 'claude', claude: {} }
  assert.equal(vmHasSchedulableCredential(ready), true)
  assert.equal(vmHasSchedulableCredential(empty), false)
})

test('expired Claude access with a failed refresh is not schedulable', () => {
  const expired = Math.floor(Date.now() / 1000) - 6 * 3600
  const dead = {
    id: 'vm-04',
    platform: 'anthropic',
    family: 'claude',
    claude: { has_access: true, has_refresh: true, expires_at: expired, refresh_error: 'worker_output_invalid' },
  }
  const refreshable = {
    id: 'vm-05',
    platform: 'anthropic',
    family: 'claude',
    claude: { has_access: true, has_refresh: true, expires_at: expired },
  }
  assert.equal(vmHasSchedulableCredential(dead), false)
  assert.equal(vmHasSchedulableCredential(refreshable), true)
})

test('missing record is never credential-ready', () => {
  assert.equal(vmHasSchedulableCredential(null), false)
  assert.equal(vmHasSchedulableCredential(undefined, '/tmp'), false)
})

test('Claude seat with an expired ticket and a bare refresh_failed is not schedulable', () => {
  const vm = {
    id: 'vm-03',
    platform: 'anthropic',
    family: 'claude',
    claude: {
      has_access: true,
      has_refresh: true,
      expires_at: Math.floor((Date.now() - 3 * 86400_000) / 1000),
      refresh_error: 'refresh_failed',
    },
  }
  assert.equal(vmHasSchedulableCredential(vm), false)
})
