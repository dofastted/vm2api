import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  extraFromRateLimit,
  parseResetCreditDetails,
  mergeResetCredits,
  buildOpenaiQuotaHeaders,
  queryOpenaiQuota,
  resetOpenaiQuota,
  CHATGPT_USAGE_URL,
  CHATGPT_RESET_CREDITS_URL,
  CHATGPT_RESET_CONSUME_URL,
} from '../../src/lib/oauth/openai-quota.mjs'
import { persistCodexQuotaSnapshot } from '../../src/lib/vm/codex-slot.mjs'

test('extraFromRateLimit maps shorter window to 5h', () => {
  const extra = extraFromRateLimit({
    primary_window: {
      used_percent: 6,
      limit_window_seconds: 18000,
      reset_after_seconds: 100,
      reset_at: 1_800_000_000,
    },
    secondary_window: {
      used_percent: 34,
      limit_window_seconds: 604800,
      reset_after_seconds: 200,
      reset_at: 1_800_100_000,
    },
  })
  assert.equal(extra.codex_5h_used_percent, 6)
  assert.equal(extra.codex_7d_used_percent, 34)
  assert.equal(extra.codex_5h_window_minutes, 300)
  assert.equal(extra.codex_7d_window_minutes, 10080)
})

test('parseResetCreditDetails accepts array and object containers', () => {
  const listed = parseResetCreditDetails([
    { expiresAt: '2026-07-04T04:05:06Z', reset_type: 'codex_rate_limits', status: 'available' },
    { expires_at: '2026-07-05T00:00:00Z', resetType: 'other' },
  ])
  assert.equal(listed.available_count, 1)
  assert.equal(listed.credits[0].expires_at, '2026-07-04T04:05:06Z')

  const boxed = parseResetCreditDetails({
    available_count: 2,
    credits: [{ expires_at: '2026-07-04T04:05:06Z', reset_type: 'codex_rate_limits', status: 'available' }],
  })
  assert.equal(boxed.available_count, 2)
  assert.equal(boxed.credits.length, 1)
})

test('mergeResetCredits prefers detail count and expiration list', () => {
  const merged = mergeResetCredits(
    { available_count: 1, credits: [] },
    {
      available_count: 2,
      credits: [{ expires_at: '2026-07-04T04:05:06Z' }, { expires_at: '2026-07-05T00:00:00Z' }],
      list_present: true,
    },
  )
  assert.equal(merged.available_count, 2)
  assert.equal(merged.credits.length, 2)
})

test('quota headers carry Codex originator and account id', () => {
  const headers = buildOpenaiQuotaHeaders({ accessToken: 'tok', accountId: 'acc-1' })
  assert.equal(headers.authorization, 'Bearer tok')
  assert.equal(headers['chatgpt-account-id'], 'acc-1')
  assert.equal(headers.originator, 'Codex Desktop')
  assert.equal(headers['openai-beta'], 'codex-1')
})

function writeGptSlot(root, id = 'vm-codex-01') {
  const dir = path.join(root, 'vms', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      platform: 'openai',
      family: 'codex',
      proxy: { url: 'socks5h://127.0.0.1:1080' },
      codex: { has_access: true, has_refresh: true, chatgpt_account_id: 'acc-1' },
    }),
  )
  fs.writeFileSync(
    path.join(dir, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ id: 'codex', access_token: 'at', refresh_token: 'rt', chatgpt_account_id: 'acc-1' }],
    }),
  )
}

test('queryOpenaiQuota persists 5h/7d extra and reset credits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-openai-quota-'))
  writeGptSlot(root)
  const seen = []
  const result = await queryOpenaiQuota({
    projectRoot: root,
    vmId: 'vm-codex-01',
    fetchImpl: async (url) => {
      seen.push(String(url))
      if (String(url).startsWith(CHATGPT_USAGE_URL)) {
        return {
          status: 200,
          json: async () => ({
            rate_limit: {
              primary_window: {
                used_percent: 12,
                limit_window_seconds: 18000,
                reset_after_seconds: 60,
                reset_at: 1_800_000_000,
              },
              secondary_window: {
                used_percent: 40,
                limit_window_seconds: 604800,
                reset_after_seconds: 120,
                reset_at: 1_800_100_000,
              },
            },
            rate_limit_reset_credits: { available_count: 1 },
          }),
        }
      }
      if (String(url).startsWith(CHATGPT_RESET_CREDITS_URL)) {
        return {
          status: 200,
          json: async () => [
            { expiresAt: '2026-07-04T04:05:06Z', reset_type: 'codex_rate_limits', status: 'available' },
          ],
        }
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.quota.utilization_5h, 0.12)
  assert.equal(result.quota.utilization_7d, 0.4)
  assert.equal(result.reset_credits.available_count, 1)
  assert.equal(result.reset_credits.credits[0].expires_at, '2026-07-04T04:05:06Z')
  assert.ok(seen.includes(CHATGPT_USAGE_URL) || seen.some((u) => u.startsWith(CHATGPT_USAGE_URL)))
  const vm = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-codex-01.json'), 'utf8'))
  assert.equal(vm.codex.extra.codex_5h_used_percent, 12)
  assert.equal(vm.codex.reset_credits.available_count, 1)
})

test('resetOpenaiQuota posts redeem_request_id then re-queries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-openai-reset-'))
  writeGptSlot(root)
  const calls = []
  const result = await resetOpenaiQuota({
    projectRoot: root,
    vmId: 'vm-codex-01',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', body: init.body })
      if (String(url) === CHATGPT_RESET_CONSUME_URL) {
        return { status: 200, json: async () => ({ code: 'ok', windows_reset: 2 }) }
      }
      if (String(url).startsWith(CHATGPT_USAGE_URL)) {
        return {
          status: 200,
          json: async () => ({
            rate_limit: {
              primary_window: {
                used_percent: 0,
                limit_window_seconds: 18000,
                reset_after_seconds: 10,
                reset_at: 1_800_000_000,
              },
              secondary_window: {
                used_percent: 1,
                limit_window_seconds: 604800,
                reset_after_seconds: 20,
                reset_at: 1_800_100_000,
              },
            },
            rate_limit_reset_credits: { available_count: 0, credits: [] },
          }),
        }
      }
      return { status: 200, json: async () => ({ available_count: 0, credits: [] }) }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.windows_reset, 2)
  assert.equal(result.quota.utilization_5h, 0)
  const consume = calls.find((c) => c.url === CHATGPT_RESET_CONSUME_URL)
  assert.equal(consume.method, 'POST')
  const body = JSON.parse(consume.body)
  assert.match(body.redeem_request_id, /^[0-9a-f-]{36}$/i)
})

test('queryOpenaiQuota rejects Claude slots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-openai-claude-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-01.json'),
    JSON.stringify({ id: 'vm-01', platform: 'anthropic', family: 'claude' }),
  )
  const result = await queryOpenaiQuota({
    projectRoot: root,
    vmId: 'vm-01',
    fetchImpl: async () => ({ status: 200, json: async () => ({}) }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'not_gpt_slot')
})

test('persistCodexQuotaSnapshot keeps expiration list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-snap-'))
  writeGptSlot(root)
  persistCodexQuotaSnapshot(root, 'vm-codex-01', {
    extra: { codex_5h_used_percent: 8, codex_7d_used_percent: 20 },
    resetCredits: { available_count: 1, credits: [{ expires_at: '2026-07-04T04:05:06Z' }] },
  })
  const vm = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-codex-01.json'), 'utf8'))
  assert.equal(vm.codex.extra.codex_5h_used_percent, 8)
  assert.equal(vm.codex.reset_credits.credits[0].expires_at, '2026-07-04T04:05:06Z')
})

test('persisted GPT quota survives summarizeVm and exposes plan_type', async () => {
  const { getVm, summarizeVm } = await import('../../src/lib/vm/vm-registry.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-openai-summary-'))
  writeGptSlot(root)
  const result = await queryOpenaiQuota({
    projectRoot: root,
    vmId: 'vm-codex-01',
    fetchImpl: async (url) => {
      if (String(url).startsWith(CHATGPT_RESET_CREDITS_URL)) return { status: 200, json: async () => ({ credits: [] }) }
      return {
        status: 200,
        json: async () => ({
          plan_type: 'team',
          rate_limit: {
            allowed: false,
            limit_reached: true,
            primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: 1_790_449_975 },
            secondary_window: { used_percent: 16, limit_window_seconds: 604800, reset_at: 1_791_012_272 },
          },
        }),
      }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.plan_type, 'team')
  const s = summarizeVm(getVm(root, 'vm-codex-01'), root)
  assert.equal(s.utilization_5h, 1)
  assert.equal(s.utilization_7d, 0.16)
  assert.equal(s.reset_5h, new Date(1_790_449_975_000).toISOString())
  assert.equal(s.reset_7d, new Date(1_791_012_272_000).toISOString())
  assert.equal(s.status_5h, 'limited')
  assert.deepEqual(
    s.codex_usage.windows.map((w) => [w.id, w.used_percent]),
    [
      ['5h', 100],
      ['7d', 16],
    ],
  )
  assert.equal(s.plan_type, 'team')
})
