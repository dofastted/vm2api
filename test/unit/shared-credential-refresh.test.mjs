import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'

async function fixture(t) {
  const { SharedCredentialRefresh } = await import('../../src/lib/oauth/shared-credential-refresh.mjs')
  const db = getDb()
  const peer = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-refresh-'))
  const file = path.join(root, 'credential.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      generation: 'generation-one',
      credential: { access_token: 'SYNTHETIC_AT_ONE', refresh_token: 'SYNTHETIC_RT_ONE' },
    }),
  )
  t.after(async () => {
    await peer.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const readCurrent = async () => JSON.parse(fs.readFileSync(file, 'utf8'))
  const publish = async (_current, value) => {
    const next = {
      generation: 'generation-two',
      credential: { access_token: value.access_token, refresh_token: value.refresh_token },
    }
    const pending = file + '.next'
    fs.writeFileSync(pending, JSON.stringify(next))
    fs.renameSync(pending, file)
    return readCurrent()
  }
  return {
    db,
    peer,
    file,
    readCurrent,
    publish,
    first: new SharedCredentialRefresh(db),
    second: new SharedCredentialRefresh(peer),
  }
}

const input = () => ({
  platform: 'codex',
  vmId: 'refresh-vm',
  accountId: 'refresh-account',
  expectedGeneration: 'generation-one',
})
const success = () => ({
  finished: true,
  value: { ok: true, access_token: 'SYNTHETIC_AT_TWO', refresh_token: 'SYNTHETIC_RT_TWO' },
})

test('two connections share one actual refresh and read published credentials without storing tokens in PostgreSQL', async (t) => {
  const f = await fixture(t)
  let calls = 0
  const refresh = async () => {
    calls++
    await new Promise((resolve) => setTimeout(resolve, 30))
    return success()
  }
  const results = await Promise.all(
    [f.first, f.second].map((service) =>
      service.run(input(), { readCurrent: f.readCurrent, publish: f.publish, refresh }),
    ),
  )
  assert.equal(calls, 1)
  assert.ok(results.every((result) => result.finished && result.current.generation === 'generation-two'))
  const stored = JSON.stringify((await f.db.query('SELECT shared_result FROM background_task_runs')).rows)
  assert.equal(stored.includes('SYNTHETIC_AT'), false)
  assert.equal(stored.includes('SYNTHETIC_RT'), false)
})

test('an expected generation superseded before admission adopts the new credential without refreshing', async (t) => {
  const f = await fixture(t)
  await f.publish(null, success().value)
  let calls = 0
  const result = await f.first.run(input(), {
    readCurrent: f.readCurrent,
    publish: f.publish,
    refresh: async () => {
      calls++
      return success()
    },
  })
  assert.equal(calls, 0)
  assert.equal(result.shared, true)
  assert.equal(result.current.generation, 'generation-two')
})

test('an uncertain refresh retains both claims and cannot retry after any timeout age', async (t) => {
  const f = await fixture(t)
  let calls = 0
  const callbacks = {
    readCurrent: f.readCurrent,
    publish: f.publish,
    refresh: async () => {
      calls++
      return { finished: false, value: { ok: false, error: 'synthetic_transport' } }
    },
  }
  const first = await f.first.run(input(), callbacks)
  assert.equal(first.unknown, true)
  await f.db.exec(
    "UPDATE background_task_runs SET claimed_at=clock_timestamp()-interval '10 years'; UPDATE vm_operations SET created_at=clock_timestamp()-interval '10 years'",
  )
  const second = await f.second.run(input(), callbacks)
  assert.equal(second.unknown, true)
  assert.equal(calls, 1)
  const task = (await f.db.query('SELECT finished_at,unknown_at FROM background_task_runs')).rows[0]
  const operation = (await f.db.query('SELECT released_at,uncertain_at FROM vm_operations')).rows[0]
  assert.equal(task.finished_at, null)
  assert.ok(task.unknown_at)
  assert.equal(operation.released_at, null)
  assert.ok(operation.uncertain_at)
})

test('a later caller may retry a definitively ended failure with the same credential generation', async (t) => {
  const f = await fixture(t)
  let calls = 0
  const callbacks = {
    readCurrent: f.readCurrent,
    publish: f.publish,
    refresh: async () => {
      calls++
      return { finished: true, value: { ok: false, error: 'synthetic_rejection' } }
    },
  }
  await f.first.run(input(), callbacks)
  await f.second.run(input(), callbacks)
  assert.equal(calls, 2)
  assert.equal(
    (await f.db.query('SELECT count(*) AS n FROM background_task_runs WHERE finished_at IS NOT NULL')).rows[0].n,
    2,
  )
})

test('missing expected generation or unreadable current credential never falls back to a raw refresh', async (t) => {
  const f = await fixture(t)
  let calls = 0
  const callbacks = {
    readCurrent: f.readCurrent,
    publish: f.publish,
    refresh: async () => {
      calls++
      return success()
    },
  }
  await assert.rejects(f.first.run({ ...input(), expectedGeneration: null }, callbacks), {
    code: 'credential_generation_required',
  })
  await assert.rejects(
    f.first.run(input(), {
      ...callbacks,
      readCurrent: async () => {
        throw new Error('synthetic missing credential')
      },
    }),
    /synthetic missing credential/,
  )
  assert.equal(calls, 0)
})

test('a failed terminal commit after publication keeps refresh ownership unavailable', async (t) => {
  const f = await fixture(t)
  await f.db.exec(`CREATE FUNCTION refuse_refresh_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.finished_at IS NOT NULL THEN RAISE EXCEPTION 'synthetic completion failure' USING ERRCODE='P6487'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER refuse_refresh_completion BEFORE UPDATE ON background_task_runs FOR EACH ROW EXECUTE FUNCTION refuse_refresh_completion()`)
  let calls = 0
  await assert.rejects(
    f.first.run(input(), {
      readCurrent: f.readCurrent,
      publish: f.publish,
      refresh: async () => {
        calls++
        return success()
      },
    }),
    { code: 'P6487' },
  )
  assert.equal(calls, 1)
  const operation = (await f.db.query('SELECT released_at,uncertain_at FROM vm_operations')).rows[0]
  assert.equal(operation.released_at, null)
  assert.ok(operation.uncertain_at)
  const task = (await f.db.query('SELECT finished_at FROM background_task_runs')).rows[0]
  assert.equal(task.finished_at, null)
})
