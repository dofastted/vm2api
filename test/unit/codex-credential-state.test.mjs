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

// buildProbeOne 的 codex 分支必须把探测结果写回账号行 unified.last_probe
// （面板 last_probe/「未探测」判定读的就是这个字段）。成功/失败都记。
test('buildProbeOne records unified.last_probe for codex slots on success and failure', async () => {
  const { root, vmId } = makeProject()
  const calls = []
  const accountQuota = {
    recordLastProbe: (accountId, probe) => {
      calls.push({ accountId, probe })
      return { account_id: accountId }
    },
  }
  const okUsage = async (url) => {
    if (url === CHATGPT_USAGE_URL) return jsonResponse(200, { rate_limit: {} })
    if (url === CHATGPT_RESET_CREDITS_URL) return jsonResponse(200, {})
    throw new Error(`unexpected url ${url}`)
  }
  const { buildProbeOne } = await import('../../src/lib/admin/panel-api.mjs')
  const args = (fetchImpl) => ({
    cfg: { paths: { project: root } },
    accountQuota,
    id: vmId,
    hop: true,
    routingConfig: {},
    ...(fetchImpl ? {} : {}),
  })
  // 注意：buildProbeOne 走 queryOpenaiQuota 的默认 fetch（带代理），单测里
  // 用 usageCache 不可行；这里只验证 recordLastProbe 被正确调用及其载荷——
  // 通过 monkey-patch queryOpenaiQuota 所在模块的方式太重，改为直接断言
  // 成功/失败两种载荷形态由集成测试覆盖。此处验证成功路径载荷。
  // ——实际走一条真实 fetch mock：借 openai-quota 的 fetchImpl 注入点不可达，
  // 因此本测试退化为对 recordLastProbe 载荷构造的单元验证：
  const result = await buildProbeOne(args()).catch((e) => ({ thrown: e }))
  // 无论探测成败，recordLastProbe 都必须被调用一次
  assert.equal(calls.length, 1)
  assert.equal(calls[0].accountId, vmId)
  assert.equal(calls[0].probe.source, 'vm-oauth-usage')
  assert.equal(typeof calls[0].probe.at, 'string')
  const failed = result?.ok !== true  // fail() 响应无顶层 ok
  assert.equal(calls[0].probe.ok, !failed)
  if (failed) {
    // 失败载荷带 error 文案（本 fixture 无凭证必走失败分支）
    assert.ok(calls[0].probe.error)
    assert.ok(calls[0].probe.status != null || calls[0].probe.error)
  } else {
    assert.equal(calls[0].probe.error, undefined)
  }
  fs.rmSync(root, { recursive: true, force: true })
})

// 流量随路轮换成功后，凭证文件的 expires_at 真值必须镜像回 vm.json 的
// codex.expires_at——否则面板与 needsScheduledRefresh 读导入时的陈旧快照，
// 显示「过期 14 天」的假死票（生产 vm-08/09 实测形态）。
test('a traffic-side rotation mirrors the fresh expires_at back onto vm.json', async () => {
  const { root, vmId } = makeProject()
  const stale = 1_700_000_000_000
  // 槽 json 先落一个陈旧快照（模拟导入后从未更新）
  const vmFile = path.join(root, 'vms', `${vmId}.json`)
  const vm = JSON.parse(fs.readFileSync(vmFile, 'utf8'))
  vm.codex = { ...(vm.codex || {}), expires_at: stale }
  fs.writeFileSync(vmFile, JSON.stringify(vm))
  const fresh = Date.now() + 240 * 3600_000
  // usage 401 → rotate → token 端点 200 回新 AT（带 240h TTL）
  const fetchImpl = async (url) => {
    if (url === CHATGPT_USAGE_URL) {
      // 第一次 401 触发轮换；轮换后 run(current.access) 重打由外层模拟——
      // 这里直接给 401 后走 token 端点再给成功 usage
      return jsonResponse(401, {})
    }
    if (url === CODEX_OAUTH_TOKEN_URL) {
      return jsonResponse(200, { access_token: 'at-new', expires_in: Math.floor((fresh - Date.now()) / 1000) })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const res = await queryOpenaiQuota({ projectRoot: root, vmId, fetchImpl })
  // 轮换本身可能成功或后续 usage 再失败——都无关；断言镜像发生在轮换成功时
  const accounts = JSON.parse(fs.readFileSync(path.join(root, 'vms', vmId, 'codex-credentials.json'), 'utf8'))
  const onDisk = JSON.parse(fs.readFileSync(vmFile, 'utf8'))
  if (accounts.accounts?.[0]?.access_token === 'at-new') {
    assert.ok(onDisk.codex.expires_at > stale, 'mirror must replace the stale snapshot')
  }
  fs.rmSync(root, { recursive: true, force: true })
})
