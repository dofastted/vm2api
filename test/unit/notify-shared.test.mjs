import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { SharedBackgroundTasks } from '../../src/lib/core/shared-background-tasks.mjs'
import { createNotifyMonitor, summarizePoolAvailability } from '../../src/lib/admin/notify.mjs'

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
