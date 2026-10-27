import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'

function runFleet(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/fleet-services.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, KIN_FLEET_POLL_MS: '10', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** Control-plane stub. `routes[url]` returns `[status, body]` or a body (200), per call. */
async function withServer(routes, fn) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body })
      res.setHeader('content-type', 'application/json')
      const route = routes[req.url]
      if (!route) {
        res.statusCode = 404
        res.end('{}')
        return
      }
      const out = route(body)
      const [status, payload] = Array.isArray(out) ? out : [200, out]
      res.statusCode = status
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, requests)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const slots = {
  ok: true,
  data: {
    items: [
      { id: 'local-a', node_id: null },
      { id: 'node-b', node_id: 'node-1' },
    ],
  },
}

function kernelSync(items) {
  const failed = items.filter((item) => !item.ok).length
  return {
    ok: true,
    data: { ok: failed === 0, total: items.length, ok_count: items.length - failed, failed_count: failed, items },
  }
}

function telemetry(items) {
  const okCount = items.filter((item) => item.ok).length
  return {
    ok: true,
    data: {
      action: 'telemetry',
      total: items.length,
      ok_count: okCount,
      skipped_count: 0,
      failed_count: items.length - okCount,
      items,
    },
  }
}

test('fleet refresh runs through the server after node links come up', async () => {
  let linkChecks = 0
  await withServer(
    {
      '/health': () => ({ status: 'ok' }),
      '/api/panel/vms': () => slots,
      '/api/panel/cluster/nodes': () => {
        linkChecks += 1
        const state = linkChecks < 2 ? 'connecting' : 'ready'
        return { ok: true, data: { items: [{ id: 'node-1', link: { state } }] } }
      },
      '/api/panel/wrap-cli/sync': () =>
        kernelSync([
          { id: 'local-a', ok: true, kernel_changed: true },
          { id: 'node-b', node_id: 'node-1', ok: true, kernel_changed: true, image: 'vm2api/kin-slot:abc' },
        ]),
      '/api/panel/vms/fleet-update': () =>
        telemetry([
          { id: 'local-a', ok: true },
          { id: 'node-b', ok: true },
        ]),
    },
    async (base, requests) => {
      const result = await runFleet({ KIN_AUTO_SYNC_BASE: base, VM2API_API_KEY: 'test-key' })
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(
        requests.map((request) => [request.method, request.url]),
        [
          ['GET', '/health'],
          ['GET', '/api/panel/vms'],
          ['GET', '/api/panel/cluster/nodes'],
          ['GET', '/api/panel/cluster/nodes'],
          ['POST', '/api/panel/wrap-cli/sync'],
          ['POST', '/api/panel/vms/fleet-update'],
        ],
      )
      for (const request of requests.slice(1)) assert.equal(request.authorization, 'Bearer test-key')
      assert.deepEqual(JSON.parse(requests[4].body), { restart: true })
      assert.deepEqual(JSON.parse(requests[5].body), { action: 'telemetry', concurrency: 4 })
      const report = JSON.parse(result.stdout)
      assert.equal(report.ok_count, 2)
      assert.equal(report.kernel_sync.ok, true)
      assert.equal(report.kernel_sync.items[1].kernel_changed, true)
    },
  )
})

test('fleet refresh goes on past an offline node and fails on its slot', async () => {
  await withServer(
    {
      '/health': () => ({ status: 'ok' }),
      '/api/panel/vms': () => slots,
      '/api/panel/cluster/nodes': () => ({ ok: true, data: { items: [{ id: 'node-1', link: { state: 'backoff' } }] } }),
      '/api/panel/wrap-cli/sync': () => {
        const body = kernelSync([
          { id: 'local-a', ok: true },
          { id: 'node-b', node_id: 'node-1', ok: false, code: 'node_not_ready', error: '节点未连接（backoff）' },
        ])
        return [400, body]
      },
      '/api/panel/vms/fleet-update': () =>
        telemetry([
          { id: 'local-a', ok: true },
          { id: 'node-b', ok: false, code: 'node_not_ready', error: '节点未连接（backoff）' },
        ]),
    },
    async (base, requests) => {
      const result = await runFleet({
        KIN_AUTO_SYNC_BASE: base,
        VM2API_API_KEY: 'test-key',
        KIN_FLEET_LINK_WAIT_MS: '50',
      })
      assert.equal(result.code, 1)
      assert.match(result.stderr, /node link not ready: node-1/)
      assert.ok(requests.some((request) => request.url === '/api/panel/vms/fleet-update'))
      const report = JSON.parse(result.stdout)
      assert.equal(report.failed_count, 1)
      assert.deepEqual(report.kernel_sync.items[1], {
        id: 'node-b',
        node_id: 'node-1',
        ok: false,
        kernel_changed: false,
        code: 'node_not_ready',
        error: '节点未连接（backoff）',
      })
    },
  )
})

test('fleet refresh with only local slots skips the node link wait', async () => {
  await withServer(
    {
      '/health': () => ({ status: 'ok' }),
      '/api/panel/vms': () => ({ ok: true, data: [{ id: 'local-a', node_id: null }] }),
      '/api/panel/wrap-cli/sync': () => kernelSync([{ id: 'local-a', ok: true }]),
      '/api/panel/vms/fleet-update': () => telemetry([{ id: 'local-a', ok: true }]),
    },
    async (base, requests) => {
      const result = await runFleet({ KIN_AUTO_SYNC_BASE: base, VM2API_API_KEY: 'test-key' })
      assert.equal(result.code, 0, result.stderr)
      assert.ok(!requests.some((request) => request.url === '/api/panel/cluster/nodes'))
    },
  )
})
