import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateGeminiQuota, quotaRetryAfter } from '../../src/lib/gemini/quota-admission.mjs'
import { indexAccountModelCatalog, resolveUpstreamModel } from '../../src/lib/gemini/model-catalog.mjs'

const now = Date.parse('2026-11-28T08:00:00Z')
const window = (id, remaining_fraction = 0, seconds = 60) => ({
  id,
  remaining_fraction,
  reset_at: new Date(now + seconds * 1000).toISOString(),
})
const account = (...windows) => ({ quota_groups: [{ name: 'Display name is not an identifier', windows }] })
const resolve = (id) =>
  resolveUpstreamModel(
    id,
    ['gemini-4-hydrogen-high', 'gemini-4-argon-high', 'claude-sonnet-4-6-high', 'gpt-oss-120b-medium'],
    { defaultEffort: 'high' },
  )
const gemini = resolve('gemini-4-hydrogen')

test('group quota gates both windows, aliases and Argon while isolating Claude/GPT', () => {
  for (const period of ['5h', 'weekly']) {
    const data = account(window(`gemini-${period}`), window(`gemini-${period === '5h' ? 'weekly' : '5h'}`, 0.5))
    for (const id of ['gemini-4-hydrogen', 'models/gemini-4-hydrogen-high', 'gemini-4-argon-high']) {
      assert.equal(evaluateGeminiQuota(data, resolve(id), now).exhausted, true, id)
    }
    for (const id of ['ag-claude-sonnet-4-6-high', 'ag-gpt-oss-120b-medium']) {
      assert.equal(evaluateGeminiQuota(data, resolve(id), now).exhausted, false, id)
      assert.equal(evaluateGeminiQuota(account(window(`3p-${period}`)), resolve(id), now).exhausted, true)
    }
  }
  const argonOnly = account(window('gemini-argon-wtu-5h'))
  assert.equal(evaluateGeminiQuota(argonOnly, gemini, now).exhausted, false)
  assert.equal(evaluateGeminiQuota(argonOnly, resolve('gemini-4-argon-high'), now).exhausted, true)
})

test('catalog quota group takes precedence over inferred model group', () => {
  const data = {
    ...account(window('gemini-argon-wtu-weekly')),
    model_catalog: [{ id: 'gemini-4-hydrogen-high', provider: 'google', quota_group: 'gemini-argon-wtu' }],
  }
  const resolved = resolveUpstreamModel('gemini-4-hydrogen-high', ['gemini-4-hydrogen-high'], {
    catalogIndex: indexAccountModelCatalog(data),
  })
  assert.equal(evaluateGeminiQuota(data, resolved, now).exhausted, true)
})

test('unknown quota values and unknown windows do not suspend accounts', () => {
  for (const value of [null, undefined, '', '0', false, NaN, -1, 0.5]) {
    assert.equal(
      evaluateGeminiQuota(account({ ...window('gemini-5h'), remaining_fraction: value }), gemini, now).exhausted,
      false,
      String(value),
    )
    assert.equal(
      evaluateGeminiQuota({ quotas: [{ model: gemini.upstreamModel, remaining_fraction: value }] }, gemini, now)
        .exhausted,
      false,
    )
  }
  for (const data of [{}, { quotas: null, quota_groups: {} }, account(window('unknown-5h')), account(null)]) {
    assert.equal(evaluateGeminiQuota(data, gemini, now).exhausted, false)
  }
})

test('reset or positive refresh restores admission; absent reset blocks only the applicable bucket', () => {
  const data = account(window('gemini-5h'))
  assert.equal(evaluateGeminiQuota(data, gemini, now + 60_000).exhausted, false)
  data.quota_groups[0].windows[0].remaining_fraction = 0.2
  assert.equal(evaluateGeminiQuota(data, gemini, now).exhausted, false)
  for (const reset_at of [null, '', 'invalid']) {
    const state = evaluateGeminiQuota(account({ id: 'gemini-5h', remaining_fraction: 0, reset_at }), gemini, now)
    assert.deepEqual(state, { exhausted: true, resetAt: null })
    assert.equal(quotaRetryAfter([state], now), null)
  }
})

test('per-model quota normalizes aliases without widening effort-specific exhaustion', () => {
  for (const model of ['gemini-4-hydrogen', 'models/gemini-4-hydrogen-high', 'gemini-4-hydrogen(high)']) {
    assert.equal(evaluateGeminiQuota({ quotas: [{ model, remaining_fraction: 0 }] }, gemini, now).exhausted, true)
  }
  assert.equal(
    evaluateGeminiQuota({ quotas: [{ model: 'gemini-4-hydrogen-medium', remaining_fraction: 0 }] }, gemini, now)
      .exhausted,
    false,
  )
})

test('retry waits for all windows on one account, then selects earliest known account recovery', () => {
  const first = evaluateGeminiQuota(account(window('gemini-5h', 0, 60), window('gemini-weekly', 0, 120)), gemini, now)
  const second = evaluateGeminiQuota(account(window('gemini-5h', 0, 90)), gemini, now)
  assert.equal(quotaRetryAfter([first], now), 120)
  assert.equal(quotaRetryAfter([first, second], now), 90)
  const unknown = evaluateGeminiQuota(
    account(window('gemini-5h'), { id: 'gemini-weekly', remaining_fraction: 0 }),
    gemini,
    now,
  )
  assert.equal(unknown.resetAt, null)
  assert.equal(quotaRetryAfter([unknown, second], now), 90)
})
