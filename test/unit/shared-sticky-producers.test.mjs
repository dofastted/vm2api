import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import { handleCodexProtocol } from '../../src/lib/protocol/handle-codex.mjs'
import { peekCurrentAccount } from '../../src/lib/protocol/user-count-tokens.mjs'
import { clearVmCooldown } from '../../src/lib/admin/panel-api.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(t) {
  resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-sticky-producer-'))
  fs.mkdirSync(path.join(root, 'vms', 'vm-gpt-a'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-gpt-a.json'),
    JSON.stringify({
      id: 'vm-gpt-a',
      platform: 'openai',
      family: 'codex',
      schedulable: true,
      status: 'running',
      has_token: true,
    }),
  )
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-gpt-a', 'codex-credentials.json'),
    JSON.stringify({
      accounts: [
        {
          id: 'synthetic-account',
          access_token: 'synthetic-access',
          refresh_token: 'synthetic-refresh',
          chatgpt_account_id: 'synthetic-account',
        },
      ],
    }),
  )
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const config = { sticky: { enabled: true, ttl_seconds: 60 } }
  const [router, peer] = await Promise.all([
    new StickyRouter({ db, config, shared: true }).init(),
    new StickyRouter({ db: other, config, shared: true }).init(),
  ])
  t.after(async () => {
    await router.flush()
    await peer.flush()
    await other.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const req = { headers: { 'x-session-id': 'shared-codex-session' }, apiKeyKind: 'user' }
  const body = { model: 'gpt-5.4', input: 'synthetic request', stream: false }
  const key = router.extractPoolKey(req, body, { platform: 'openai' })
  const response = { headersSent: false, write() {}, end() {} }
  const jobs = []
  return {
    root,
    router,
    peer,
    key,
    response,
    jobs,
    run({ ensure, hop, routing = {} } = {}) {
      return handleCodexProtocol({
        req,
        res: response,
        protocol: 'openai.responses',
        ctx: { body },
        inbound: body,
        logBag: {},
        stats: { errors: 0, requests: 0, by_route: {} },
        projectRoot: root,
        stickyRouter: router,
        routing,
        json(_res, status, value) {
          response.status = status
          response.body = value
          return value
        },
        writeSSEHeaders() {
          response.headersSent = true
        },
        ops: {
          writeCodexKernelConfig() {},
          ensureCodexKernel: ensure || (async () => ({ ok: true })),
          streamCodexKernel: async (args) => {
            jobs.push(args)
            if (hop) {
              const result = await hop(args)
              if (result) return result
            }
            return { ok: true, status: 200, terminalState: 'verified', body: { id: 'resp-synthetic' } }
          },
        },
      })
    },
  }
}

test('Codex awaits durable shared native-session binding before submitting a kernel job', async (t) => {
  const fx = await fixture(t)
  await fx.run({
    hop: async ({ envelope }) => {
      const stored = await fx.peer.persistence.get(fx.key)
      assert.ok(stored, 'a shared conversation must be bound before kernel submission')
      assert.equal(stored.vm_id, 'vm-gpt-a')
      assert.equal(stored.session_id, envelope.session.session_id)
      assert.equal(envelope.body.prompt_cache_key, stored.session_id)
    },
  })
  assert.equal(fx.jobs.length, 1)
  assert.equal(fx.response.status, 200)
})

test('a shared Codex pre-submission CAS conflict returns 503 without sending the old body', async (t) => {
  const fx = await fixture(t)
  await fx.run({
    ensure: async () => {
      await fx.peer.bindShared(
        fx.key,
        { accountId: 'vm-gpt-b', vmId: 'vm-gpt-b', sessionId: 'native-peer' },
        { ifGeneration: 0 },
      )
      return { ok: true }
    },
    hop: () => assert.fail('a conflicting native session cannot receive the stale outbound body'),
  })
  assert.equal(fx.jobs.length, 0)
  assert.equal(fx.response.status, 503)
  assert.equal(fx.response.body.error.code, 'sticky_binding_conflict')
  assert.equal((await fx.peer.persistence.get(fx.key)).session_id, 'native-peer')
})

test('a late Codex success cannot restore a pin moved by another controller', async (t) => {
  const fx = await fixture(t)
  await fx.run({
    hop: async () => {
      await fx.peer.refresh()
      await fx.peer.rebindFamilyShared(
        fx.key,
        { accountId: 'vm-gpt-b', vmId: 'vm-gpt-b' },
        { ifGeneration: fx.peer.versionOf(fx.key) },
      )
    },
  })
  assert.equal(fx.response.status, 200)
  const stored = await fx.peer.persistence.get(fx.key)
  assert.equal(stored.vm_id, 'vm-gpt-b')
  assert.equal(stored.session_id, null)
})

test('a shared native-session conflict stops an implicit Codex transport retry', async (t) => {
  const fx = await fixture(t)
  await fx.run({
    hop: async () => {
      await fx.peer.refresh()
      await fx.peer.rebindFamilyShared(
        fx.key,
        { accountId: 'vm-gpt-b', vmId: 'vm-gpt-b' },
        { ifGeneration: fx.peer.versionOf(fx.key) },
      )
      return { ok: false, status: 502, body: { error: { code: 'upstream_transport' } } }
    },
  })
  assert.equal(fx.jobs.length, 1, 'each actual retry must confirm the captured binding generation again')
  assert.equal(fx.response.status, 503)
  assert.equal(fx.response.body.error.code, 'sticky_binding_conflict')
  assert.equal((await fx.peer.persistence.get(fx.key)).vm_id, 'vm-gpt-b')
})

test('a late Codex failure cannot unbind a pin moved by another controller', async (t) => {
  const fx = await fixture(t)
  await fx.run({
    routing: { failover: { max_total_attempts: 1, max_account_switches: 0 } },
    hop: async () => {
      await fx.peer.refresh()
      await fx.peer.rebindFamilyShared(
        fx.key,
        { accountId: 'vm-gpt-b', vmId: 'vm-gpt-b' },
        { ifGeneration: fx.peer.versionOf(fx.key) },
      )
      return { ok: false, status: 401, body: { error: { code: 'oauth_revoked' } } }
    },
  })
  assert.equal(fx.jobs.length, 1)
  assert.equal(fx.response.status, 401)
  assert.equal((await fx.peer.persistence.get(fx.key)).vm_id, 'vm-gpt-b')
})

test('count_tokens awaits the shared read-only session helper with migrate disabled', async () => {
  const entered = deferred()
  const resume = deferred()
  let peeked = false
  const pending = peekCurrentAccount({
    req: { headers: {}, apiKeyKind: 'master' },
    inbound: {
      metadata: { user_id: JSON.stringify({ session_id: 'native-count-session', device_id: 'count-device' }) },
    },
    model: 'claude-test',
    stickyRouter: {
      shared: true,
      sessionPoolKeys() {
        throw new Error('shared callers must not use the synchronous migration helper')
      },
      async sessionPoolKeysShared(_req, _body, options) {
        assert.equal(options.migrate, false)
        entered.resolve()
        await resume.promise
        return { stickyKey: 'shared-count-key', stickyKeys: ['shared-count-key'] }
      },
    },
    poolScheduler: {
      async peekAccount({ stickyKey }) {
        peeked = true
        assert.equal(stickyKey, 'shared-count-key')
        return { ok: true }
      },
    },
  })
  try {
    await Promise.race([entered.promise, pending.then(() => assert.fail('read-only helper was not awaited'))])
    await setImmediate()
    assert.equal(peeked, false)
  } finally {
    resume.resolve()
  }
  assert.equal((await pending).ok, true)
})

test('panel cooldown clearing awaits shared sticky deletion before returning', async (t) => {
  const fx = await fixture(t)
  await fx.router.bindShared(fx.key, { accountId: 'vm-gpt-a', vmId: 'vm-gpt-a', sessionId: 'native-panel' })
  const entered = deferred()
  const resume = deferred()
  const remove = fx.router.unbindByAccountShared.bind(fx.router)
  fx.router.unbindByAccountShared = async (options) => {
    entered.resolve()
    await resume.promise
    return remove(options)
  }
  let settled = false
  const pending = Promise.resolve(
    clearVmCooldown({
      cfg: { paths: { project: fx.root } },
      id: 'vm-gpt-a',
      stickyRouter: fx.router,
    }),
  ).then((result) => {
    settled = true
    return result
  })
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => assert.fail('panel returned without shared sticky deletion')),
    ])
    await setImmediate()
    assert.equal(settled, false)
  } finally {
    resume.resolve()
  }
  assert.equal((await pending).ok, true)
  assert.equal(await fx.peer.persistence.get(fx.key), null)
})
