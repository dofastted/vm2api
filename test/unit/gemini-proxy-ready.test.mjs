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
