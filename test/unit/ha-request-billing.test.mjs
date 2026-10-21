import test from 'node:test'
import assert from 'node:assert/strict'
import {
  haBillingFixture,
  billingRequest,
  syntheticBillingSnapshot,
  syntheticUsageReceipt,
  statusFor,
} from '../fixtures/ha-billing.mjs'
import { HaRequestRecovery } from '../../src/lib/core/ha-request-recovery.mjs'
import { calculateCost } from '../../src/lib/admin/pricing.mjs'
import { setPriceCatalogTestHooks, invalidatePriceCatalog } from '../../src/lib/admin/price-catalog.mjs'

test('HA job binding persists price, group, cache TTL and speed before returning permission to dispatch', async (t) => {
  const f = await haBillingFixture(t)
  const snapshot = syntheticBillingSnapshot()
  await billingRequest(
    f,
    async (data) => {
      const row = (
        await f.peer.pool.query('SELECT billing_snapshot FROM execution_jobs WHERE request_id=$1', [data.commandIds[0]])
      ).rows[0]
      assert.deepEqual(row.billing_snapshot, snapshot)
      snapshot.rate_multiplier = 100
      assert.equal(
        (
          await f.peer.pool.query('SELECT billing_snapshot FROM execution_jobs WHERE request_id=$1', [
            data.commandIds[0],
          ])
        ).rows[0].billing_snapshot.rate_multiplier,
        2,
      )
    },
    { snapshot },
  )
})

test('frozen price snapshots keep original rates after another Pod changes overrides', async () => {
  const { captureHaBillingSnapshot, priceHaReceipt } = await import('../../src/lib/core/ha-request-billing.mjs')
  const values = {
    model_price_overrides: {
      'anthropic/claude-sonnet-4-5': {
        input: 3,
        output: 15,
        cache_read: 0.3,
        cache_5m: 3.75,
        cache_1h: 6,
        updated_at: 'before',
      },
    },
  }
  setPriceCatalogTestHooks({ settings: { get: (key, fallback) => values[key] ?? fallback }, backgroundRefresh: false })
  try {
    const snapshot = captureHaBillingSnapshot({
      model: 'claude-sonnet-4-5',
      rateMultiplier: 2,
      cacheTtl: '1h',
      requestedSpeed: null,
    })
    const receipt = syntheticUsageReceipt()
    const expected = calculateCost({ ...receipt.usage, cache_ttl: '1h' }, receipt.model)
    values.model_price_overrides['anthropic/claude-sonnet-4-5'].input = 900
    invalidatePriceCatalog()
    const actual = priceHaReceipt(receipt, snapshot)
    assert.equal(actual.known, true)
    assert.equal(actual.pricing.total_cost, expected.total_cost)
    assert.equal(actual.actualCost, expected.total_cost * 2)
  } finally {
    setPriceCatalogTestHooks(null)
  }
})

for (const absent of ['usage', 'price', 'different-model']) {
  test(`HA ${absent} stays unpriced without substituting zero or request model`, async () => {
    const { priceHaReceipt } = await import('../../src/lib/core/ha-request-billing.mjs')
    const snapshot = syntheticBillingSnapshot()
    const receipt = syntheticUsageReceipt()
    if (absent === 'usage') {
      receipt.usage_complete = false
      delete receipt.usage.output_tokens
    }
    if (absent === 'price') snapshot.resolved = null
    if (absent === 'different-model') receipt.model = 'claude-opus-4-6'
    assert.equal(priceHaReceipt(receipt, snapshot).known, false)
  })
}

async function reconcile(f, data, receipt = syntheticUsageReceipt()) {
  const recovery = new HaRequestRecovery(f.peer, { coordinator: f.recovery })
  return f.recoveryGate.run(() =>
    recovery.recover('billing-parent', {
      readRecoveryStatus: async ({ requestId }) => statusFor(data, requestId, receipt),
    }),
  )
}

test('two PG peers settle a recovered single billable command once from its original frozen rates', async (t) => {
  const f = await haBillingFixture(t)
  const data = await billingRequest(f)
  const first = await reconcile(f, data)
  assert.equal(first.recovered, true)
  assert.equal(first.billingHeld, false)
  await reconcile(f, data)
  await f.recoveryGate.run(async () => {
    const key = await new (await import('../../src/lib/admin/api-keys.mjs')).ApiKeyStore({ db: f.peer }).getById(
      data.key.id,
    )
    assert.equal(key.requests, 1)
    assert.equal(key.tokens_in, 100)
    assert.ok(Math.abs(key.quota_used - 0.001272) < 1e-12)
    const ledger = await f.peer
      .prepare('SELECT * FROM ha_request_settlements WHERE ha_request_id=$1')
      .get('billing-parent')
    assert.equal(ledger.outcome, 'charged')
    assert.equal(ledger.command_id, data.commandIds[0])
    assert.equal(ledger.reservation_id, data.reservation.reservationId)
    assert.deepEqual(ledger.node_receipt, syntheticUsageReceipt())
    assert.ok(
      (
        await f.peer
          .prepare('SELECT settled_at,released_at FROM api_key_admissions WHERE id=$1')
          .get(data.reservation.reservationId)
      ).released_at,
    )
    assert.equal((await f.peer.prepare('SELECT balance FROM users WHERE id=$1').get(data.user.id)).balance, 123)
    assert.equal(
      (
        await f.peer
          .prepare('SELECT count(*) AS n FROM api_key_admissions WHERE user_id=$1 AND released_at IS NULL')
          .get(data.user.id)
      ).n,
      0,
    )
  })
})

test('normal HA handler settlement and later orphan retry share one immutable ledger', async (t) => {
  const f = await haBillingFixture(t)
  const data = await billingRequest(f, async (current) => {
    const outcome = await current.keys.recordHaUsage({
      reservation: current.reservation,
      commandId: current.commandIds[0],
      nodeStatus: statusFor(current, current.commandIds[0]),
    })
    assert.equal(outcome.settled, true)
    assert.equal(current.reservation.settled, true)
    assert.equal(
      (
        await f.db
          .prepare('SELECT released_at FROM api_key_admissions WHERE id=$1')
          .get(current.reservation.reservationId)
      ).released_at,
      null,
    )
  })
  const recovered = await reconcile(f, data)
  assert.equal(recovered.billingHeld, false)
  await f.recoveryGate.run(async () => {
    assert.equal((await f.peer.prepare('SELECT requests FROM api_keys WHERE id=$1').get(data.key.id)).requests, 1)
    assert.equal((await f.peer.prepare('SELECT count(*) AS n FROM ha_request_settlements').get()).n, 1)
  })
})

test('a deleted key still gets a durable settlement audit and releases only its original reservation', async (t) => {
  const f = await haBillingFixture(t)
  const data = await billingRequest(f, async (current) => {
    await current.keys.remove(current.key.id)
  })
  assert.equal((await reconcile(f, data)).billingHeld, false)
  assert.equal((await reconcile(f, data)).billingHeld, false)
  await f.recoveryGate.run(async () => {
    const ledger = await f.peer
      .prepare('SELECT * FROM ha_request_settlements WHERE ha_request_id=$1')
      .get('billing-parent')
    assert.equal(ledger.outcome, 'key_deleted')
    assert.equal(ledger.key_id, data.key.id)
    assert.ok(ledger.actual_cost > 0)
    assert.equal(ledger.tokens_in, 100)
    assert.equal((await f.peer.prepare('SELECT balance FROM users WHERE id=$1').get(data.user.id)).balance, 123)
    assert.ok(
      (
        await f.peer
          .prepare('SELECT released_at FROM api_key_admissions WHERE id=$1')
          .get(data.reservation.reservationId)
      ).released_at,
    )
  })
})

test('a legacy settled reservation is audited and released without a second key increment', async (t) => {
  const f = await haBillingFixture(t)
  const data = await billingRequest(f, async (current) => {
    await current.keys.recordUsage(
      current.key,
      { input_tokens: 33 },
      { officialCost: 9, reservation: current.reservation },
    )
  })
  assert.equal((await reconcile(f, data)).billingHeld, false)
  await f.recoveryGate.run(async () => {
    const key = await f.peer.prepare('SELECT requests,tokens_in,quota_used FROM api_keys WHERE id=$1').get(data.key.id)
    assert.equal(key.requests, 1)
    assert.equal(key.tokens_in, 33)
    assert.equal(key.quota_used, 9)
    const ledger = await f.peer
      .prepare('SELECT * FROM ha_request_settlements WHERE ha_request_id=$1')
      .get('billing-parent')
    assert.equal(ledger.outcome, 'already_settled')
    assert.equal(ledger.actual_cost, null, 'prior aggregate key quota cannot reconstruct this reservation charge')
  })
})

test('bigint node counts reach key and ledger counters without Number rounding', async (t) => {
  const f = await haBillingFixture(t)
  const data = await billingRequest(f)
  const receipt = syntheticUsageReceipt()
  receipt.usage.input_tokens = '9007199254740993'
  assert.equal((await reconcile(f, data, receipt)).billingHeld, false)
  await f.recoveryGate.run(async () => {
    assert.equal(
      (await f.peer.prepare('SELECT tokens_in FROM api_keys WHERE id=$1').get(data.key.id)).tokens_in,
      '9007199254740993',
    )
    assert.equal(
      (
        await f.peer
          .prepare('SELECT tokens_in FROM ha_request_settlements WHERE ha_request_id=$1')
          .get('billing-parent')
      ).tokens_in,
      '9007199254740993',
    )
  })
})

for (const absent of ['usage', 'price', 'model']) {
  test(`orphan ${absent} evidence is held after execution ends and cannot create a zero settlement`, async (t) => {
    const f = await haBillingFixture(t)
    const snapshot = syntheticBillingSnapshot()
    if (absent === 'price') snapshot.resolved = null
    const data = await billingRequest(f, async () => {}, { snapshot })
    const receipt = syntheticUsageReceipt()
    if (absent === 'usage') {
      receipt.usage_complete = false
      delete receipt.usage.output_tokens
    }
    if (absent === 'model') receipt.model = 'claude-opus-4-6'
    const result = await reconcile(f, data, receipt)
    assert.equal(result.recovered, true)
    assert.equal(result.billingHeld, true)
    await f.recoveryGate.run(async () => {
      assert.equal((await f.peer.prepare('SELECT count(*) AS n FROM ha_request_settlements').get()).n, 0)
      assert.equal((await f.peer.prepare('SELECT requests FROM api_keys WHERE id=$1').get(data.key.id)).requests, 0)
      assert.equal(
        (
          await f.peer
            .prepare('SELECT released_at FROM api_key_admissions WHERE id=$1')
            .get(data.reservation.reservationId)
        ).released_at,
        null,
      )
    })
  })
}

test('multiple commands without a durable billable choice stay held rather than summing or selecting latest', async (t) => {
  const f = await haBillingFixture(t)
  const data = await billingRequest(f, async () => {}, { jobs: 2 })
  assert.equal((await reconcile(f, data)).billingHeld, true)
  await f.recoveryGate.run(async () => {
    assert.equal((await f.peer.prepare('SELECT requests FROM api_keys WHERE id=$1').get(data.key.id)).requests, 0)
    assert.equal((await f.peer.prepare('SELECT count(*) AS n FROM ha_request_settlements').get()).n, 0)
  })
})

for (const commandId of [null, 'unbound-pre-dispatch-id']) {
  test(`an existing job cannot become not_dispatched from an absent or unrelated final command: ${commandId}`, async (t) => {
    const f = await haBillingFixture(t)
    await billingRequest(f, async (current) => {
      const settle = () => current.keys.recordHaUsage({ reservation: current.reservation, commandId })
      if (commandId) await assert.rejects(settle(), { code: 'ha_billable_command_mismatch' })
      else assert.equal((await settle()).settled, false)
      assert.equal((await f.db.prepare('SELECT count(*) AS n FROM ha_request_settlements').get()).n, 0)
      assert.equal(
        (
          await f.db
            .prepare('SELECT released_at FROM api_key_admissions WHERE id=$1')
            .get(current.reservation.reservationId)
        ).released_at,
        null,
      )
      assert.equal((await current.keys.getById(current.key.id)).requests, 0)
      assert.equal(
        (await f.db.prepare('SELECT accepting_children FROM ha_request_contexts WHERE id=$1').get('billing-parent'))
          .accepting_children,
        true,
      )
    })
  })
}

test('a no-job handler ignores an unbound command ID, audits no dispatch and closes children before returning', async (t) => {
  const f = await haBillingFixture(t)
  const { withHaRequestAttempt } = await import('../../src/lib/core/ha-request-context.mjs')
  await billingRequest(
    f,
    async (current) => {
      const result = await current.keys.recordHaUsage({
        reservation: current.reservation,
        commandId: 'unbound-pre-dispatch-id',
      })
      assert.equal(result.settled, true)
      assert.equal(result.outcome, 'not_dispatched')
      assert.equal(current.reservation.settled, true)
      assert.equal(current.reservation.billingFailed, undefined)
      assert.equal(
        (await f.db.prepare('SELECT accepting_children FROM ha_request_contexts WHERE id=$1').get('billing-parent'))
          .accepting_children,
        false,
      )
      await assert.rejects(
        withHaRequestAttempt(1, () =>
          current.admission.bindExecution({
            requestId: 'late-command',
            nodeBinding: current.nodeBinding,
            billingSnapshot: syntheticBillingSnapshot(),
          }),
        ),
        { code: 'ha_request_context_closed' },
      )
      await current.reservation.release()
      const ledger = await f.db
        .prepare('SELECT * FROM ha_request_settlements WHERE ha_request_id=$1')
        .get('billing-parent')
      assert.equal(ledger.command_id, null)
      assert.equal(ledger.actual_cost, null)
      assert.equal(ledger.tokens_in, null)
      assert.equal((await f.db.prepare('SELECT count(*) AS n FROM execution_jobs').get()).n, 0)
      assert.equal((await current.keys.getById(current.key.id)).requests, 0)
      assert.ok(
        (
          await f.db
            .prepare('SELECT released_at FROM api_key_admissions WHERE id=$1')
            .get(current.reservation.reservationId)
        ).released_at,
      )
    },
    { jobs: 0 },
  )
})

test('an explicit final command choice bills only that original command in a multiattempt request', async (t) => {
  const f = await haBillingFixture(t)
  const data = await billingRequest(
    f,
    async (current) => {
      const { selectHaBillableCommand } = await import('../../src/lib/core/ha-request-billing.mjs')
      await selectHaBillableCommand(f.db, current.commandIds[1])
    },
    { jobs: 2 },
  )
  assert.equal((await reconcile(f, data)).billingHeld, false)
  await f.recoveryGate.run(async () => {
    const ledger = await f.peer
      .prepare('SELECT * FROM ha_request_settlements WHERE ha_request_id=$1')
      .get('billing-parent')
    assert.equal(ledger.command_id, data.commandIds[1])
    assert.equal(ledger.tokens_in, 100)
    assert.equal((await f.peer.prepare('SELECT requests FROM api_keys WHERE id=$1').get(data.key.id)).requests, 1)
  })
})

test('a sealed request with no bound jobs records not_dispatched and releases unused quota without a charge', async (t) => {
  const f = await haBillingFixture(t)
  const data = await billingRequest(f, async () => {}, { jobs: 0 })
  assert.equal((await reconcile(f, data)).billingHeld, false)
  await f.recoveryGate.run(async () => {
    const ledger = await f.peer
      .prepare('SELECT * FROM ha_request_settlements WHERE ha_request_id=$1')
      .get('billing-parent')
    assert.equal(ledger.outcome, 'not_dispatched')
    assert.equal(ledger.command_id, null)
    assert.equal(ledger.actual_cost, null)
    assert.equal(
      (await f.peer.prepare('SELECT requests,quota_requests_used FROM api_keys WHERE id=$1').get(data.key.id)).requests,
      0,
    )
    assert.ok(
      (
        await f.peer
          .prepare('SELECT released_at FROM api_key_admissions WHERE id=$1')
          .get(data.reservation.reservationId)
      ).released_at,
    )
  })
})

test('a PostgreSQL counter overflow rolls back settlement and keeps the exact reservation held', async (t) => {
  const f = await haBillingFixture(t)
  const data = await billingRequest(f, async (current) => {
    await f.db.prepare('UPDATE api_keys SET tokens_in=$2 WHERE id=$1').run(current.key.id, '9223372036854775807')
  })
  await assert.rejects(reconcile(f, data), { code: '22003' })
  await f.recoveryGate.run(async () => {
    assert.equal((await f.peer.prepare('SELECT count(*) AS n FROM ha_request_settlements').get()).n, 0)
    assert.equal(
      (
        await f.peer
          .prepare('SELECT released_at,settled_at FROM api_key_admissions WHERE id=$1')
          .get(data.reservation.reservationId)
      ).released_at,
      null,
    )
    assert.equal(
      (await f.peer.prepare('SELECT tokens_in FROM api_keys WHERE id=$1').get(data.key.id)).tokens_in,
      '9223372036854775807',
    )
  })
})
