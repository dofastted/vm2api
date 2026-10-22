import test from 'node:test'
import assert from 'node:assert/strict'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'

async function replicas(t) {
  const db = getDb()
  const other = await createDatabase({ connectionString: process.env.VM2API_TEST_DATABASE_URL, schema: db.schema })
  const first = await new ProxyPool({ db }).init()
  const second = await new ProxyPool({ db: other }).init()
  for (const pool of [first, second]) {
    pool.stopScheduler()
    pool.probeOne = async () => ({ ok: true, scope: 'socks', latency_ms: 1 })
  }
  t.after(() => {
    first.stopScheduler()
    second.stopScheduler()
  })
  return [first, second]
}

test('a stale replica probe and flush preserve a proxy created by another connection', async (t) => {
  const [first, second] = await replicas(t)
  const existing = await first.importLines('192.0.2.1:1080')
  await first.flush()
  await second.reload()
  const created = await first.importLines('192.0.2.2:1080')
  await first.flush()
  await second.probeAll()
  await second.flush()
  const ids = (await first.repo.loadAll()).map((proxy) => proxy.id)
  assert.ok(ids.includes(existing.items[0].id))
  assert.ok(
    ids.includes(created.items[0].id),
    'a probe must not replace the whole proxy table with its stale working set',
  )
})

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('an old probe cannot overwrite a new endpoint, credentials, owner, binding or manual disable', async (t) => {
  const [first, second] = await replicas(t)
  const added = await first.importLines('192.0.2.3:1080:user:old')
  const id = added.items[0].id
  await first.bind(id, 'vm-old')
  const entered = deferred()
  const done = deferred()
  let callbacks = 0
  second.onEnableVm = second.onDisableVm = () => {
    callbacks++
  }
  second.probeOne = async () => {
    entered.resolve()
    await done.promise
    return { ok: true, scope: 'socks', latency_ms: 1 }
  }
  const probing = second.probeById(id)
  try {
    await entered.promise
    await first.update(id, { host: '192.0.2.4', port: 2080, username: 'new-user', password: 'new-password' })
    await first.repo.patchConfig(id, { owner_user_id: 'owner-new' })
    await first.unbind(id, 'vm-old')
    await first.bind(id, 'vm-new')
    await first.setEnabled(id, false)
    done.resolve()
    const result = await probing
    assert.equal(result.stale, true)
    const stored = await first.repo.getById(id)
    assert.equal(stored.host, '192.0.2.4')
    assert.equal(stored.port, 2080)
    assert.equal(stored.username, 'new-user')
    assert.equal(stored.password, 'new-password')
    assert.equal(stored.owner_user_id, 'owner-new')
    assert.equal(stored.bound_vm_id, 'vm-new')
    assert.equal(stored.enabled, false)
    assert.equal(stored.last_probe_at, null)
    assert.equal(callbacks, 0)
  } finally {
    done.resolve()
  }
})

test('stale configuration edits merge only supplied fields with the current PostgreSQL row', async (t) => {
  const [first, second] = await replicas(t)
  const added = await first.importLines('192.0.2.5:1080:user:old')
  const id = added.items[0].id
  await second.refresh()
  await first.update(id, { username: 'peer-user', password: 'peer-password', label: 'peer-label' })
  await first.bind(id, 'vm-peer')
  await second.update(id, { port: 2081 })
  const row = await first.repo.getById(id)
  assert.equal(row.port, 2081)
  assert.equal(row.username, 'peer-user')
  assert.equal(row.password, 'peer-password')
  assert.equal(row.label, 'peer-label')
  assert.equal(row.bound_vm_id, 'vm-peer')
})

test('a completed probe never recreates a proxy deleted by another replica', async (t) => {
  const [first, second] = await replicas(t)
  const {
    items: [proxy],
  } = await first.importLines('192.0.2.6:1080')
  const entered = deferred()
  const done = deferred()
  second.probeOne = async () => {
    entered.resolve()
    await done.promise
    return { ok: true, latency_ms: 1 }
  }
  const probing = second.probeById(proxy.id)
  try {
    await entered.promise
    await first.remove(proxy.id)
    done.resolve()
    assert.equal((await probing).stale, true)
    assert.equal(await first.repo.getById(proxy.id), null)
  } finally {
    done.resolve()
  }
})

test('parallel imports retain both new endpoints and deduplicate identical credentials', async (t) => {
  const [first, second] = await replicas(t)
  const distinct = await Promise.all([first.importLines('192.0.2.7:1080'), second.importLines('192.0.2.8:1080')])
  assert.equal(
    distinct.reduce((count, result) => count + result.added, 0),
    2,
  )
  const same = await Promise.all([
    first.importLines('192.0.2.9:1080:user:password'),
    second.importLines('192.0.2.9:1080:user:password'),
  ])
  assert.equal(
    same.reduce((count, result) => count + result.added, 0),
    1,
  )
  assert.equal(
    same.reduce((count, result) => count + result.skipped, 0),
    1,
  )
  assert.equal((await first.repo.loadAll()).length, 3)
})

test('binding capacity and one-proxy-per-VM checks use current PostgreSQL bindings', async (t) => {
  const [first, second] = await replicas(t)
  await first.updateConfig({ enabled: false, bind_limit: 1 })
  const {
    items: [proxy, other],
  } = await first.importLines('192.0.2.10:1080\n192.0.2.11:1080')
  const results = await Promise.all([first.bind(proxy.id, 'vm-a'), second.bind(proxy.id, 'vm-b')])
  assert.equal(results.filter((result) => result.ok).length, 1)
  assert.equal(results.find((result) => !result.ok).error, 'proxy_bind_limit')
  const winner = (await first.repo.getById(proxy.id)).bound_vm_id
  assert.equal((await second.bind(other.id, winner)).ok, true)
  assert.equal((await first.repo.getById(proxy.id)).bound_vm_id, null)
  assert.equal((await first.repo.getById(other.id)).bound_vm_id, winner)
})

test('failed health persistence never fires VM state callbacks or publishes optimistic health', async (t) => {
  const [first, second] = await replicas(t)
  await first.updateConfig({ enabled: false, max_failures: 1 })
  const {
    items: [proxy],
  } = await first.importLines('192.0.2.12:1080')
  await first.bind(proxy.id, 'vm-a')
  await second.refresh()
  let callbacks = 0
  second.onDisableVm = () => {
    callbacks++
  }
  second.probeOne = async () => ({ ok: false, scope: 'socks', error: 'mock_failure', latency_ms: null })
  await first.db.exec(`CREATE FUNCTION reject_proxy_health() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'mock health persistence failure' USING ERRCODE = 'P0001'; END $$;
    CREATE TRIGGER reject_proxy_health BEFORE UPDATE OF status ON proxies
    FOR EACH ROW EXECUTE FUNCTION reject_proxy_health();`)
  await assert.rejects(second.probeById(proxy.id), { code: 'P0001' })
  assert.equal(callbacks, 0)
  assert.equal(second.snapshot().proxies[0].status, 'unknown')
  assert.equal((await first.repo.getById(proxy.id)).enabled, true)
})

test('refresh does not wait for a network probe and a late refresh cannot overwrite newer state', {
  timeout: 2000,
}, async (t) => {
  const [first, second] = await replicas(t)
  const {
    items: [proxy],
  } = await first.importLines('192.0.2.13:1080')
  const entered = deferred()
  const done = deferred()
  second.probeOne = async () => {
    entered.resolve()
    await done.promise
    return { ok: true, latency_ms: 1 }
  }
  const probing = second.probeById(proxy.id)
  try {
    await entered.promise
    await first.update(proxy.id, { label: 'peer-label' })
    await second.refresh()
    assert.equal(second.labelOf(proxy.id), 'peer-label')
    done.resolve()
    await probing
  } finally {
    done.resolve()
  }
  const captured = deferred()
  const release = deferred()
  const snapshot = second.repo.snapshot.bind(second.repo)
  second.repo.snapshot = async () => {
    const data = await snapshot()
    captured.resolve()
    await release.promise
    return data
  }
  const older = second.refresh()
  await captured.promise
  second.repo.snapshot = snapshot
  await first.update(proxy.id, { label: 'latest-label' })
  await second.refresh()
  release.resolve()
  await older
  assert.equal(second.labelOf(proxy.id), 'latest-label')
})

test('pool configuration edits preserve fields committed by another replica', async (t) => {
  const [first, second] = await replicas(t)
  await first.updateConfig({ enabled: false, bind_limit: 7 })
  await second.updateConfig({ geo_timeout_ms: 1200 })
  const config = await first.repo.getConfig()
  assert.equal(config.enabled, false)
  assert.equal(config.bind_limit, 7)
  assert.equal(config.geo_timeout_ms, 1200)
})

test('saving a stale explicit state edit preserves peer creations and rejects changed rows', async (t) => {
  const [first, second] = await replicas(t)
  const {
    items: [proxy],
  } = await first.importLines('192.0.2.14:1080')
  await second.refresh()
  const {
    items: [peer],
  } = await first.importLines('192.0.2.15:1080')
  second.state.proxies[0].label = 'local-label'
  await second.save()
  assert.equal((await first.repo.getById(proxy.id)).label, 'local-label')
  assert.ok(await first.repo.getById(peer.id))
  await first.update(proxy.id, { password: 'peer-password', username: 'peer-user' })
  second.state.proxies.find((row) => row.id === proxy.id).label = 'outdated-edit'
  await assert.rejects(second.save(), { code: 'proxy_changed' })
  assert.equal((await first.repo.getById(proxy.id)).password, 'peer-password')
})

test('an old probe does not repair egress with obsolete connection configuration', async (t) => {
  const [first, second] = await replicas(t)
  const {
    items: [proxy],
  } = await first.importLines('192.0.2.16:1080')
  await second.refresh()
  const entered = deferred()
  const done = deferred()
  second._probeSocks = async () => {
    entered.resolve()
    await done.promise
    return { ok: true, latency_ms: 1 }
  }
  second.egressCheck = () => ({ ok: false, reason: 'mock_egress_down' })
  let repairs = 0
  second.repairEgress = () => {
    repairs++
  }
  second.probeOne = ProxyPool.prototype.probeOne
  const probing = second.probeById(proxy.id)
  try {
    await entered.promise
    await first.update(proxy.id, { port: 2080 })
    done.resolve()
    const result = await probing
    assert.equal(result.stale, true)
    assert.equal(result.probe.error, 'proxy_changed')
    assert.equal(repairs, 0)
  } finally {
    done.resolve()
  }
})
