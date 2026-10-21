import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { startGateway, api } from '../harness.mjs'
import { nodeManagementFixture } from '../fixtures/node-management-fixture.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const model = 'claude-haiku-4-5-20251001'

async function holdableKernel(socket, afterHeaders) {
  let paused = false
  let active = 0
  let closing = false
  const waits = new Set()
  const resume = () => {
    paused = false
    for (const resolve of waits) resolve()
    waits.clear()
  }
  const server = http.createServer(async (req, res) => {
    if (req.url === '/internal/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, healthy: true, ready_slots: 8 }))
    }
    try {
      for await (const _ of req) {
      }
    } catch {
      return res.destroy()
    }
    const frames = [
      {
        type: 'message_start',
        message: {
          id: 'msg_shutdown',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic accepted stream' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    active++
    let emittedPrefix = false
    try {
      if (paused && afterHeaders) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(frames.slice(0, 3).join(''))
        res.flushHeaders()
        emittedPrefix = true
      }
      if (paused) await new Promise((resolve) => waits.add(resolve))
      if (closing) return res.destroy()
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(frames.slice(emittedPrefix ? 3 : 0).join(''))
    } finally {
      active--
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  return {
    pause() {
      paused = true
    },
    resume,
    status() {
      return { active }
    },
    async close() {
      closing = true
      resume()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function fixture(t, afterHeaders = false) {
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
    kernel = await holdableKernel(socket, afterHeaders)
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

function request(gateway, agent, endpoint, body, onHeaders = () => {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      gateway.baseUrl + endpoint,
      {
        agent,
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${gateway.apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      },
      (res) => {
        onHeaders()
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

for (const afterHeaders of [false, true])
  test(`HA SIGTERM ${afterHeaders ? 'after' : 'before'} SSE headers preserves the stream and exits zero under continued keepalive`, {
    timeout: 25000,
  }, async (t) => {
    const fx = await fixture(t, afterHeaders)
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
      assert.equal(first.json.usage.input_tokens, 5)
      assert.equal(first.json.usage.output_tokens, 7)
      await delay(1200)
      fx.kernel.pause()
      let headersSeen = false
      held = request(
        gw,
        agent,
        '/v1/messages',
        {
          model,
          max_tokens: 16,
          stream: true,
          messages: [{ role: 'user', content: 'accepted before SIGTERM' }],
        },
        () => {
          headersSeen = true
        },
      )
      held.catch(() => {})
      let active = 0
      for (let i = 0; i < 80; i++) {
        active = fx.kernel.status().active
        if (active === 1 && (!afterHeaders || headersSeen)) break
        await delay(20)
      }
      assert.equal(active, 1, 'the real node must own an active SSE request before SIGTERM')
      assert.equal(headersSeen, afterHeaders)
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
      fx.kernel.resume()
      const streamed = await held
      assert.equal(streamed.status, 200, streamed.text)
      assert.match(streamed.text, /message_stop/)
      const frames = streamed.text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice(5)))
      assert.equal(frames.find((event) => event.type === 'message_delta').usage.output_tokens, 7)
      await terminated(gw, exit, diagnostic)
      assert.equal(
        (await fx.peer.query('SELECT count(*)::int AS n FROM execution_jobs WHERE ended_at IS NULL')).rows[0].n,
        0,
      )
      const jobs = (await fx.peer.query('SELECT request_id,node_binding,node_completion,ended_at FROM execution_jobs'))
        .rows
      assert.equal(jobs.length, 2)
      for (const job of jobs) {
        assert.equal(job.node_binding.protocol, 'KSG2')
        assert.equal(job.node_completion.id, job.request_id)
        assert.equal(job.node_completion.status, 'completed')
        assert.equal(job.node_completion.dispatched, true)
        assert.deepEqual(job.node_completion.fence, job.node_binding.fence)
        assert.ok(job.ended_at)
      }
      t.diagnostic(`normal SIGTERM exit=0; post-drain keepalive responses=${responses.length}`)
    } finally {
      pumping = false
      agent.destroy()
      await Promise.allSettled([traffic, held])
      await fx.close()
    }
  })
