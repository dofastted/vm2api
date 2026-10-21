import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { startGateway, api } from '../harness.mjs'
import { nodeManagementFixture } from '../fixtures/node-management-fixture.mjs'
import { syntheticClaudeNode } from '../fixtures/synthetic-claude-node.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const model = 'claude-haiku-4-5-20251001'

async function fixture(t) {
  const fx = await nodeManagementFixture(t)
  let kernel
  let gateway
  const close = async () => {
    if (gateway) {
      if (gateway.child.exitCode == null && gateway.child.signalCode == null) {
        const exited = once(gateway.child, 'exit')
        gateway.child.kill('SIGKILL')
        await exited
      }
      await gateway.db.close()
    }
    await kernel?.close()
    await fx.close()
  }
  try {
    const credential = { ...JSON.parse(fx.payload).credential, expires_at: Date.now() + 3600000 }
    const payload = Buffer.from(JSON.stringify({ credential }))
    const published = await fx.run('node_publish_initial', (operation) =>
      fx.service.publishInitial(fx.input(operation, { payload })),
    )
    const launched = await fx.run('node_launch', (operation) =>
      fx.service.launch(
        fx.input(operation, { payload, commandId: 'shutdown-launch', manifestDigest: published.manifest_digest }),
      ),
    )
    const socket = path.join(
      fx.node.root,
      'runtime',
      'vms',
      fx.vmId,
      'incarnations',
      launched.fence.incarnation,
      'run',
      'kernel.sock',
    )
    kernel = await syntheticClaudeNode(socket)
    await new VmsRepo(fx.db).upsertFromVmJson({
      id: fx.vmId,
      name: 'synthetic-shutdown',
      node_id: fx.nodeId,
      status: 'running',
      schedulable: true,
      timezone: 'UTC',
      locale: 'en_US.UTF-8',
      fingerprint: { device_id: 'shutdown-device', session_id: 'shutdown-session' },
      policy: { maxConcurrency: 2, weight: 1 },
      claude: {
        account_uuid: credential.account_uuid,
        has_access: true,
        has_refresh: true,
        expires_at: credential.expires_at,
      },
    })
    const trust = path.join(fx.root, 'nodes.json')
    fs.writeFileSync(
      trust,
      JSON.stringify({
        nodes: { [fx.nodeId]: { ...fx.node.link, policyDigest: fx.policyDigest, presetId: 'claude-docker-v1' } },
      }),
      { mode: 0o600 },
    )
    const project = path.join(fx.root, 'controller')
    fs.mkdirSync(path.join(project, 'vms'), { recursive: true })
    fs.writeFileSync(path.join(project, 'vms', 'active.json'), '{}')
    gateway = await startGateway({
      project,
      env: {
        VM2API_CONTROL_PLANE_MODE: 'kubernetes-ha',
        KIN_DATABASE_SCHEMA: fx.db.schema,
        VM2API_NODE_CONFIG_FILE: trust,
        VM2API_SHUTDOWN_TIMEOUT_MS: '3000',
        KIN_BACKUP_DISABLED: '1',
        VM2API_TEST_HOST_BARRIER_FILE: path.join(fx.root, 'legacy-effects.log'),
        NODE_OPTIONS: `--import=${new URL('../fixtures/ha-flow-no-host-loader.mjs', import.meta.url).href}`,
      },
    })
    return { ...fx, gateway, kernel, close }
  } catch (error) {
    await close()
    throw error
  }
}

function request(gateway, agent, endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      gateway.baseUrl + endpoint,
      {
        agent,
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${gateway.apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('error', reject)
        res.on('end', () => resolve({ status: res.statusCode, text, connection: res.headers.connection }))
      },
    )
    req.on('error', reject)
    req.setTimeout(7000, () => req.destroy(new Error('synthetic shutdown HTTP timeout')))
    req.end(body ? JSON.stringify(body) : undefined)
  })
}

async function terminated(gateway, exit, diagnostic) {
  let timer
  try {
    const result = await Promise.race([
      exit,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('normal SIGTERM did not exit within 5s: ' + diagnostic())), 5000)
      }),
    ])
    assert.deepEqual(result, [0, null], diagnostic())
  } finally {
    clearTimeout(timer)
  }
}

test('an idle real HA process exits zero on SIGTERM without the harness SIGKILL fallback', {
  timeout: 20000,
}, async (t) => {
  const fx = await fixture(t)
  try {
    await delay(1200) // Include the real shared routing poll.
    const exit = once(fx.gateway.child, 'exit')
    fx.gateway.child.kill('SIGTERM')
    await terminated(fx.gateway, exit, () => fx.gateway.stdout().slice(-1500) + fx.gateway.stderr().slice(-1500))
  } finally {
    await fx.close()
  }
})

test('an HA process finishes an accepted SSE then exits zero under continued keepalive requests', {
  timeout: 25000,
}, async (t) => {
  const fx = await fixture(t)
  const gw = fx.gateway
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  let traffic
  let held
  let pumping = true
  const responses = []
  const diagnostic = () =>
    JSON.stringify({
      keepalive: responses.slice(-8),
      stdout: gw.stdout().slice(-2000),
      stderr: gw.stderr().slice(-1500),
    })
  try {
    const first = await api(gw, 'POST', '/v1/messages', {
      body: { model, max_tokens: 16, messages: [{ role: 'user', content: 'completed before SIGTERM' }] },
    })
    assert.equal(first.status, 200, first.text)
    await delay(1200)
    await fetch(fx.kernel.controlUrl + '/pause', { method: 'POST' })
    held = request(gw, agent, '/v1/messages', {
      model,
      max_tokens: 16,
      stream: true,
      messages: [{ role: 'user', content: 'accepted before SIGTERM' }],
    })
    held.catch(() => {})
    let active = 0
    for (let i = 0; i < 80; i++) {
      active = (await (await fetch(fx.kernel.controlUrl + '/status')).json()).active
      if (active === 1) break
      await delay(20)
    }
    assert.equal(active, 1, 'the real node must own an active SSE request before SIGTERM')
    // The first queued request uses exactly the active SSE connection once it
    // finishes. Continuing its keepalive must not postpone process shutdown.
    traffic = (async () => {
      while (pumping && gw.child.exitCode == null && gw.child.signalCode == null) {
        try {
          const response = await request(gw, agent, '/v1/meta')
          responses.push({ status: response.status, connection: response.connection })
        } catch {}
        await delay(20)
      }
    })()
    const exit = once(gw.child, 'exit')
    gw.child.kill('SIGTERM')
    for (let i = 0; i < 100 && !gw.stdout().includes('[shutdown] SIGTERM'); i++) await delay(10)
    assert.match(gw.stdout(), /\[shutdown\] SIGTERM/)
    await delay(150)
    await fetch(fx.kernel.controlUrl + '/resume', { method: 'POST' })
    const streamed = await held
    assert.equal(streamed.status, 200, streamed.text)
    assert.match(streamed.text, /message_stop/)
    await terminated(gw, exit, diagnostic)
    assert.equal(
      (await fx.peer.query('SELECT count(*)::int AS n FROM execution_jobs WHERE ended_at IS NULL')).rows[0].n,
      0,
    )
    t.diagnostic(`normal SIGTERM exit=0; post-drain keepalive responses=${responses.length}`)
  } finally {
    pumping = false
    agent.destroy()
    await Promise.allSettled([traffic, held])
    await fx.close()
  }
})
