import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { createDatabase, getDb, getActivityCoordinator, quoteIdentifier } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { SharedBackgroundTasks } from '../../src/lib/core/shared-background-tasks.mjs'
import { createNotifyMonitor, dispatchNotify, summarizePoolAvailability } from '../../src/lib/admin/notify.mjs'
import { withDatabaseActivities } from '../maintenance-fixture.mjs'

const config = {
  enabled: true,
  interval_sec: 15,
  cooldown_sec: 300,
  events: { pool_empty: true, pool_low: false, pool_recovered: true, digest: false, revoked: false, invalid: false },
}

const empty = () =>
  summarizePoolAvailability([{ id: 'synthetic-vm', has_token: true, cred_status: { key: 'bad', text: 'synthetic' } }])

async function fixture(t, { nextPlan = false, notify = config } = {}) {
  const db = getDb()
  const peer = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => peer.close())
  await new SettingsRepo(db).set('routing_config', { revision: 1, config: { notify } })
  let execution = 0
  const tasks = [new SharedBackgroundTasks(db), new SharedBackgroundTasks(peer)].map((service) =>
    nextPlan
      ? {
          db: service.db,
          now: () => service.now(),
          run: (plan, callback) =>
            service.run({ taskKey: plan.taskKey, executionId: `synthetic-check-${++execution}` }, callback),
        }
      : service,
  )
  const monitors = (send) =>
    tasks.map((sharedTasks) => createNotifyMonitor({ config, snapshot: async () => empty(), send, sharedTasks }))
  return { db, peer, monitors }
}

test('two independent PostgreSQL notification monitors execute one shared check and one send', async (t) => {
  const { monitors } = await fixture(t)
  let sends = 0
  const pair = monitors(async () => {
    sends++
    await new Promise((resolve) => setTimeout(resolve, 30))
    return { ok: true }
  })
  await Promise.all(pair.map((monitor) => monitor.runOnce()))
  assert.equal(sends, 1)
})

test('another Pod reuses the persisted event baseline and cooldown on a later check', async (t) => {
  const { monitors } = await fixture(t, { nextPlan: true })
  let sends = 0
  const [first, peer] = monitors(async () => {
    sends++
    return { ok: true }
  })
  await first.runOnce()
  await peer.runOnce()
  assert.equal(sends, 1)
  assert.equal(peer.getSnapshot().available, 0)
})

test('a shared check obeys committed disabled configuration instead of its local enabled snapshot', async (t) => {
  const { monitors } = await fixture(t, { notify: { ...config, enabled: false } })
  let sends = 0
  const [monitor] = monitors(async () => {
    sends++
    return { ok: true }
  })
  await monitor.runOnce()
  assert.equal(sends, 0)
  assert.equal(monitor.getConfig().enabled, false)
})

test('an uncertain notification attempt blocks another Pod and does not expire into a retry', async (t) => {
  const { db, monitors } = await fixture(t, { nextPlan: true })
  let sends = 0
  const [first, peer] = monitors(async () => {
    sends++
    throw new Error('synthetic transport lost after send')
  })
  await first.runOnce()
  await db.exec("UPDATE background_task_runs SET claimed_at=clock_timestamp()-interval '10 years'")
  await peer.runOnce()
  assert.equal(sends, 1)
  const claims = (await db.query('SELECT finished_at, unknown_at FROM background_task_runs')).rows
  assert.equal(claims.length, 1)
  assert.equal(claims[0].finished_at, null)
  assert.ok(claims[0].unknown_at)
})

test('PostgreSQL state reservation failure prevents sending and is returned to the caller', async (t) => {
  const { db, monitors } = await fixture(t)
  await db.exec(`CREATE FUNCTION refuse_notify_state() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.key='pool_notify_state' THEN RAISE EXCEPTION 'synthetic state failure' USING ERRCODE='P6483'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER refuse_notify_state BEFORE INSERT OR UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION refuse_notify_state()`)
  let sends = 0
  const [monitor] = monitors(async () => {
    sends++
    return { ok: true }
  })
  await assert.rejects(monitor.runOnce(), { code: 'P6483' })
  assert.equal(sends, 0)
})

test('a truncated provider response cannot confirm the notification attempt ended', async () => {
  for (const channel of ['telegram', 'wecom']) {
    const cfg = {
      [channel]:
        channel === 'telegram'
          ? { enabled: true, bot_token: 'synthetic-token', chat_id: 'synthetic-chat' }
          : { enabled: true, webhook: 'synthetic-key-1234' },
    }
    const result = await dispatchNotify(
      cfg,
      { text: 'synthetic notification' },
      {
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => {
            throw new Error('synthetic truncated provider body')
          },
        }),
      },
    )
    assert.equal(result.ok, false, channel)
    assert.equal(result.uncertain, true, channel)
  }
})

test('a complete provider rejection ends its attempt and permits a later explicit check', async (t) => {
  const { db, monitors } = await fixture(t)
  const [first, peer] = monitors(() =>
    dispatchNotify(
      { telegram: { enabled: true, bot_token: 'synthetic', chat_id: 'synthetic' } },
      { text: 'synthetic' },
      { fetch: async () => ({ ok: false, status: 400, text: async () => '{"ok":false}' }) },
    ),
  )
  await first.runOnce({ digest: true })
  await peer.runOnce({ digest: true })
  const claims = (await db.query('SELECT finished_at, unknown_at FROM background_task_runs')).rows
  assert.equal(claims.length, 2)
  assert.ok(claims.every((claim) => claim.finished_at && !claim.unknown_at))
  assert.ok(peer.getStatus().last_error)
})

test('a failure committing completion after a send retains the claim and prevents another send', async (t) => {
  const { db, monitors } = await fixture(t, { nextPlan: true })
  await db.exec(`CREATE FUNCTION refuse_notify_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.finished_at IS NOT NULL THEN RAISE EXCEPTION 'synthetic completion failure' USING ERRCODE='P6484'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER refuse_notify_completion BEFORE UPDATE ON background_task_runs
    FOR EACH ROW EXECUTE FUNCTION refuse_notify_completion()`)
  let sends = 0
  const [first, peer] = monitors(async () => {
    sends++
    return { ok: true }
  })
  await assert.rejects(first.runOnce(), { code: 'P6484' })
  await peer.runOnce()
  assert.equal(sends, 1)
  const claim = (await db.query('SELECT finished_at FROM background_task_runs')).rows[0]
  assert.equal(claim.finished_at, null)
})

test('shared checks run inside fresh durable activities and finish before global maintenance', async (t) => {
  const { db, peer, monitors } = await fixture(t)
  const cleanup = new pg.Client({ connectionString: db.connectionString })
  let schema
  t.after(async () => {
    await getActivityCoordinator(db)?.stop()
    await getActivityCoordinator(peer)?.stop()
    await cleanup.connect()
    try {
      if (schema) await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
    } finally {
      await cleanup.end()
    }
  })
  let sends = 0
  const [first, second] = monitors(async () => {
    assert.equal(getActivityCoordinator(db).assertActivity().kind, 'background')
    sends++
    return { ok: true }
  })
  await withDatabaseActivities([db, peer], async () => {
    schema = getActivityCoordinator(db).schema
    await first.runOnce()
    await second.runOnce()
  })
  assert.equal(sends, 1)
  const operation = await getActivityCoordinator(db).beginMaintenance({ kind: 'backup' })
  try {
    await operation.resume()
  } finally {
    await operation.close()
  }
})
