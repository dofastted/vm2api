import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { getDb } from '../../src/lib/db/database.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

for (const kind of ['update', 'disable']) {
  test(`proxy ${kind} waits for persistence before responding`, async () => {
    const pool = await new ProxyPool({ db: getDb() }).init()
    const added = await pool.importLines('127.0.0.1:1080')
    const id = added.items[0].id
    await pool.flush()
    const entered = deferred()
    const persist = deferred()
    const name = kind === 'update' ? 'update' : 'setEnabled'
    const original = pool[name].bind(pool)
    let operation
    pool[name] = (...args) => {
      operation = (async () => {
        entered.resolve()
        await persist.promise
        return await original(...args)
      })()
      return operation
    }
    let response
    const handler = createPanelHandler({
      cfg: { paths: { project: '/tmp/vm2api-648-proxy-panel-no-vms' } },
      proxyPool: pool,
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
        return true
      },
      readBody: async () => ({ label: 'persisted label' }),
      json(_res, status, body) {
        response = { status, body }
        return true
      },
    })
    const pathname = `/api/panel/proxies/${id}${kind === 'disable' ? '/disable' : ''}`
    const request = handler({ method: kind === 'update' ? 'PUT' : 'POST', headers: {} }, {}, { pathname })
    try {
      await entered.promise
      await setImmediate()
      assert.equal(response, undefined, 'an unfinished database write cannot produce a success or false failure response')
    } finally {
      persist.resolve()
      await operation
      await request
      await pool.flush()
    }
    assert.equal(response.status, 200)
    const persisted = await getDb().prepare('SELECT enabled, label FROM proxies WHERE id = $1').get(id)
    if (kind === 'disable') assert.equal(persisted.enabled, 0)
    else assert.equal(persisted.label, 'persisted label')
  })
}
