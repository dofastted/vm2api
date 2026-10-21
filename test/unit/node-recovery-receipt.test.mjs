import test from 'node:test'
import assert from 'node:assert/strict'
import { SlotgateClient } from '../../src/lib/transport/slotgate-client.mjs'
import { fakeSlotgate, syntheticFence } from '../fixtures/fake-slotgate.mjs'

const receipt = () => ({
  id: 'a'.repeat(32),
  model: 'claude-sonnet-4-5',
  usage_complete: true,
  usage: {
    input_tokens: '9007199254740993',
    output_tokens: '7',
    cache_read_input_tokens: '3',
    cache_creation_input_tokens: '5',
    cache_creation: { ephemeral_5m_input_tokens: '2', ephemeral_1h_input_tokens: '3' },
    server_tool_use: { web_search_requests: '1' },
  },
  speed: 'fast',
  service_tier: 'priority',
  stop_reason: 'end_turn',
})
const status = (command, value = receipt()) => ({
  ok: true,
  found: true,
  command: { id: command.command_id, fence: command.fence, status: 'completed', dispatched: true },
  ...(value ? { receipt: value } : {}),
})

test('history reads original command and Fence without a dead ticket, manifest, prepare or latest State', async (t) => {
  const fx = await fakeSlotgate(t, { recoveryStatus: status })
  fx.config.fence = syntheticFence('18446744073709551615')
  const client = new SlotgateClient(fx.config)
  const result = await client.recoveryStatus('original-command')
  assert.equal(result.found, true)
  assert.equal(result.command.fence.generation, '18446744073709551615')
  assert.deepEqual(result.receipt, receipt())
  assert.equal(typeof result.receipt.usage.input_tokens, 'string')
  assert.deepEqual(fx.requests, [
    { op: 'recovery-status', vm_id: fx.config.vmId, fence: fx.config.fence, command_id: 'original-command' },
  ])
})

test('notfound remains unknown and an incomplete receipt preserves missing fields', async (t) => {
  const fx = await fakeSlotgate(t, {
    recoveryStatus: (command) =>
      command.command_id === 'notfound'
        ? { ok: true, found: false, unknown: true }
        : status(command, { id: 'b'.repeat(32), usage_complete: false, usage: { output_tokens: '7' } }),
  })
  const client = new SlotgateClient(fx.config)
  assert.deepEqual(await client.recoveryStatus('notfound'), { found: false, unknown: true })
  const incomplete = await client.recoveryStatus('incomplete')
  assert.equal(incomplete.receipt.usage_complete, false)
  assert.deepEqual(incomplete.receipt.usage, { output_tokens: '7' })
  assert.equal(incomplete.receipt.model, undefined)
})

for (const malformed of [
  'numeric-count',
  'leading-zero',
  'overflow',
  'negative',
  'credential-field',
  'nested-provider',
  'missing-model',
  'missing-count',
  'wrong-command',
  'wrong-fence',
  'pending-receipt',
  'undispatched-receipt',
]) {
  test(`history rejects ${malformed} without fallback or writes`, async (t) => {
    const fx = await fakeSlotgate(t, {
      recoveryStatus: (command) => {
        const value = status(command)
        if (malformed === 'numeric-count') value.receipt.usage.input_tokens = 12
        if (malformed === 'leading-zero') value.receipt.usage.input_tokens = '01'
        if (malformed === 'overflow') value.receipt.usage.input_tokens = '9223372036854775808'
        if (malformed === 'negative') value.receipt.usage.input_tokens = '-1'
        if (malformed === 'credential-field') value.receipt.credentials = { refresh_token: 'synthetic-private-value' }
        if (malformed === 'nested-provider') value.receipt.usage.provider = { extra: true }
        if (malformed === 'missing-model') delete value.receipt.model
        if (malformed === 'missing-count') delete value.receipt.usage.output_tokens
        if (malformed === 'wrong-command') value.command.id = 'new-command'
        if (malformed === 'wrong-fence') value.command.fence = syntheticFence('2')
        if (malformed === 'pending-receipt') value.command.status = 'pending'
        if (malformed === 'undispatched-receipt') value.command.dispatched = false
        return value
      },
    })
    await assert.rejects(new SlotgateClient(fx.config).recoveryStatus('original-command'), {
      code: 'slotgate_recovery_unconfirmed',
    })
    assert.equal(fx.requests.length, 1)
    assert.equal(fx.requests[0].op, 'recovery-status')
  })
}
