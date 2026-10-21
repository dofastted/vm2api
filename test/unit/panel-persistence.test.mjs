import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

function setup({ failBefore = false } = {}) {
  const sent = []
  let writes = 0
  let changed = 0
  let maintenance = 0
  const handler = createPanelHandler({
    cfg: { paths: { project: '/missing-project' } },
    json: (_res, status, body) => sent.push({ status, body }),
    readBody: async () => ({ enabled: false }),
    requireAuth: () => true,
    clusterRoutes: { handle: (_req, res, _url, respond) => {
      changed += 1
      return respond(res, 201, { ok: true })
    } },
    onPersistenceFailure: () => { maintenance += 1 },
    proxyPool: {
      writes: { flush: async () => {
        writes += 1
        if (failBefore || writes > 1) throw new Error('synthetic persistence failure')
      } },
      snapshot: () => ({ config: {}, proxies: [] }),
      updateConfig: () => { changed += 1; return { ok: true, config: { enabled: false } } },
    },
  })
  return { handler, sent, changed: () => changed, maintenance: () => maintenance }
}

test('panel cache mutations send failure when persistence fails before a success response', async () => {
  const state = setup()
  await state.handler({ method: 'PUT', apiKeyKind: 'master' }, {}, new URL('http://test/api/panel/proxies/config'))
  assert.equal(state.changed(), 1)
  assert.equal(state.maintenance(), 1)
  assert.equal(state.sent.length, 1)
  assert.equal(state.sent[0].status, 503)
  assert.equal(state.sent[0].body.error.code, 'database_persistence_failed')
})

test('an already failed cache queue rejects a new panel mutation before changing state', async () => {
  const state = setup({ failBefore: true })
  await state.handler({ method: 'PUT', apiKeyKind: 'master' }, {}, new URL('http://test/api/panel/proxies/config'))
  assert.equal(state.changed(), 0)
  assert.equal(state.maintenance(), 1)
  assert.equal(state.sent[0].status, 503)
})

test('delegated cluster responses wait for the same persistence boundary', async () => {
  const state = setup()
  await state.handler({ method: 'POST', apiKeyKind: 'master' }, {}, new URL('http://test/api/panel/cluster/nodes'))
  assert.equal(state.changed(), 1)
  assert.equal(state.maintenance(), 1)
  assert.equal(state.sent.length, 1)
  assert.equal(state.sent[0].status, 503)
})

test('a staged panel response remains handled after persistence succeeds', async () => {
  const sent = []
  const handler = createPanelHandler({
    cfg: {},
    requireAuth: () => true,
    json: (_res, status, body) => { sent.push({ status, body }) },
  })

  const handled = await handler({ method: 'POST', apiKeyKind: 'managed' }, {}, new URL('http://test/admin/models/refresh'))
  assert.equal(handled, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].status, 403)
})
