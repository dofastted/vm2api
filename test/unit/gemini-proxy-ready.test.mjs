import assert from 'node:assert/strict'
import test from 'node:test'
import { createGeminiPanelHandler } from '../../src/lib/gemini/routes.mjs'

const root = '/api/panel/gemini'
const record = { id: 'gemini-fixture', proxy_id: 'px-fixture', name: 'Fixture', auth_state: 'authorized' }
const proxyUrl = 'socks5h://fixture:private@203.0.113.10:1080'

function setup(proxy) {
  const response = { setHeader() {} }
  const panel = createGeminiPanelHandler({
    json: (_response, status, body) => ({ status, body }),
    readBody: async (req) => req.body,
    proxyPool: () => ({
      snapshot: () => ({ proxies: [proxy] }),
      getProxyByIdWithAuth: (id) => (id === proxy.id ? { url: proxyUrl } : null),
    }),
    callHost: () => ({ environments: [{ ...record, runtime_ready: true }] }),
  })
  return (method, pathname, body) => panel({ method, pathname, body }, response, pathname)
}

test('Gemini inventory keeps proxy_ready while pool row is fail but still enabled', async () => {
  const run = setup({
    id: record.proxy_id,
    enabled: true,
    status: 'fail',
    consecutive_failures: 1,
    last_error: 'timeout',
    owner_user_id: null,
  })
  const { body } = await run('GET', root)
  assert.equal(body.data.environments[0].proxy_ready, true)
})

test('Gemini create and rebind reject pool rows in fail state', async () => {
  const failProxy = {
    id: 'px-fail-bind',
    enabled: true,
    status: 'fail',
    consecutive_failures: 1,
    last_error: 'timeout',
    owner_user_id: null,
  }
  const response = { setHeader() {} }
  const operations = []
  const panel = createGeminiPanelHandler({
    json: (_response, status, body) => ({ status, body }),
    readBody: async (req) => req.body,
    proxyPool: () => ({
      snapshot: () => ({ proxies: [failProxy] }),
      getProxyByIdWithAuth: (id) => (id === failProxy.id ? { url: proxyUrl } : null),
    }),
    callHost: (operation) => {
      operations.push(operation)
      return { ...record, proxy_id: failProxy.id }
    },
  })
  const run = (method, pathname, body) => panel({ method, pathname, body }, response, pathname)
  const create = await run('POST', `${root}/environments`, { name: 'New', proxy_id: failProxy.id })
  assert.equal(create.status, 409)
  assert.equal(create.body.error.code, 'gemini_proxy_unavailable')
  assert.deepEqual(operations, [])
  const rebind = await run('PUT', `${root}/environments/${record.id}/proxy`, { proxy_id: failProxy.id })
  assert.equal(rebind.status, 409)
  assert.equal(rebind.body.error.code, 'gemini_proxy_unavailable')
  assert.deepEqual(operations, ['get'])
})

test('Gemini inventory reports proxy_ready=false only after pool disables the row', async () => {
  const run = setup({
    id: record.proxy_id,
    enabled: false,
    status: 'dead',
    consecutive_failures: 2,
    last_error: 'timeout',
    owner_user_id: null,
  })
  const { body } = await run('GET', root)
  assert.equal(body.data.environments[0].proxy_ready, false)
})
