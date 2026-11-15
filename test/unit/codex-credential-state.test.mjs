import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  persistCodexCredentialState,
  persistCodexQuotaSnapshot,
  writeCodexAccounts,
} from '../../src/lib/vm/codex-slot.mjs'
import { queryOpenaiQuota, CHATGPT_USAGE_URL, CHATGPT_RESET_CREDITS_URL } from '../../src/lib/oauth/openai-quota.mjs'
import { CODEX_OAUTH_TOKEN_URL } from '../../src/lib/protocol/codex-models.mjs'

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cred-state-'))
  const vmId = 'vm-cred-1'
  fs.mkdirSync(path.join(root, 'vms', vmId), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${vmId}.json`),
    JSON.stringify({ id: vmId, name: 'cred-state', platform: 'codex', status: 'normal', schedulable: true }),
  )
  writeCodexAccounts(root, vmId, [
    { id: 'user@example.com', access_token: 'at-1', refresh_token: 'rt-1', chatgpt_account_id: 'org-1' },
  ])
  return { root, vmId }
}

function readVm(root, vmId) {
  return JSON.parse(fs.readFileSync(path.join(root, 'vms', `${vmId}.json`), 'utf8'))
}

function jsonResponse(status, payload) {
  return { status, json: async () => payload }
}

test('persistCodexCredentialState marks top-level and codex fields', () => {
  const { root, vmId } = makeProject()
  const vm = persistCodexCredentialState(root, vmId, { error: 'refresh_rejected', at: '2026-11-15T00:00:00Z' })
  assert.equal(vm.refresh_error, 'refresh_rejected')
  assert.equal(vm.codex.refresh_error, 'refresh_rejected')
  assert.equal(vm.codex.refresh_error_at, '2026-11-15T00:00:00Z')
  const onDisk = readVm(root, vmId)
  assert.equal(onDisk.refresh_error, 'refresh_rejected')
  assert.equal(onDisk.codex.refresh_error, 'refresh_rejected')
  fs.rmSync(root, { recursive: true, force: true })
})

test('persistCodexCredentialState is idempotent while the mark is unchanged', () => {
  const { root, vmId } = makeProject()
  persistCodexCredentialState(root, vmId, { error: 'refresh_rejected', at: '2026-11-15T00:00:00Z' })
  persistCodexCredentialState(root, vmId, { error: 'refresh_rejected', at: '2026-11-15T09:00:00Z' })
  const onDisk = readVm(root, vmId)
  assert.equal(onDisk.codex.refresh_error_at, '2026-11-15T00:00:00Z')
  fs.rmSync(root, { recursive: true, force: true })
})

test('persistCodexCredentialState with null error clears an existing mark', () => {
  const { root, vmId } = makeProject()
  persistCodexCredentialState(root, vmId, { error: 'refresh_rejected' })
  persistCodexCredentialState(root, vmId, { error: null })
  const onDisk = readVm(root, vmId)
  assert.equal(onDisk.refresh_error, undefined)
  assert.equal(onDisk.codex.refresh_error, undefined)
  assert.equal(onDisk.codex.refresh_error_at, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

test('persistCodexQuotaSnapshot clears a stale credential mark on success', () => {
  const { root, vmId } = makeProject()
  persistCodexCredentialState(root, vmId, { error: 'refresh_rejected' })
  persistCodexQuotaSnapshot(root, vmId, { extra: { codex_5h_used_percent: 10 } })
  const onDisk = readVm(root, vmId)
  assert.equal(onDisk.refresh_error, undefined)
  assert.equal(onDisk.codex.refresh_error, undefined)
  assert.equal(onDisk.codex.refresh_error_at, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

test('queryOpenaiQuota persists refresh_rejected when the refresh token is revoked', async () => {
  const { root, vmId } = makeProject()
  const fetchImpl = async (url) => {
    if (url === CHATGPT_USAGE_URL) return jsonResponse(401, {})
    if (url === CODEX_OAUTH_TOKEN_URL) return jsonResponse(401, { error: 'invalid_grant' })
    throw new Error(`unexpected url ${url}`)
  }
  const res = await queryOpenaiQuota({ projectRoot: root, vmId, fetchImpl })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'refresh_rejected')
  const onDisk = readVm(root, vmId)
  assert.equal(onDisk.refresh_error, 'refresh_rejected')
  assert.equal(onDisk.codex.refresh_error, 'refresh_rejected')
  assert.ok(onDisk.codex.refresh_error_at)
  fs.rmSync(root, { recursive: true, force: true })
})

test('queryOpenaiQuota leaves the ticket unmarked on transient network failures', async () => {
  const { root, vmId } = makeProject()
  const fetchImpl = async (url) => {
    if (url === CHATGPT_USAGE_URL) return jsonResponse(401, {})
    if (url === CODEX_OAUTH_TOKEN_URL) throw new Error('ECONNRESET')
    throw new Error(`unexpected url ${url}`)
  }
  const res = await queryOpenaiQuota({ projectRoot: root, vmId, fetchImpl })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'fetch_failed')
  const onDisk = readVm(root, vmId)
  assert.equal(onDisk.refresh_error, undefined)
  assert.equal(onDisk.codex?.refresh_error, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a successful quota query after revival clears the persisted mark', async () => {
  const { root, vmId } = makeProject()
  persistCodexCredentialState(root, vmId, { error: 'refresh_rejected' })
  const fetchImpl = async (url) => {
    if (url === CHATGPT_USAGE_URL) return jsonResponse(200, { rate_limit: {} })
    if (url === CHATGPT_RESET_CREDITS_URL) return jsonResponse(200, {})
    throw new Error(`unexpected url ${url}`)
  }
  const res = await queryOpenaiQuota({ projectRoot: root, vmId, fetchImpl })
  assert.equal(res.ok, true)
  const onDisk = readVm(root, vmId)
  assert.equal(onDisk.refresh_error, undefined)
  assert.equal(onDisk.codex.refresh_error, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})
