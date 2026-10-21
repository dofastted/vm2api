import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { nodeManagementFixture } from '../fixtures/node-management-fixture.mjs'
import { startGateway, api } from '../harness.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'

const model = 'claude-haiku-4-5-20251001'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('HA flow barrier observes legacy I/O even with the gateway mock loader installed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-flow-canary-'))
  const barrier = path.join(root, 'effects.log')
  try {
    const cases = [
      [new URL('../../src/lib/oauth/oauth-credentials.mjs', import.meta.url).href, 'readSlotCredentialIdentity'],
      [new URL('../../src/lib/cluster/docker-remote.mjs', import.meta.url).href, 'dockerInfo'],
      [new URL('../../src/lib/cluster/ssh-link.mjs', import.meta.url).href, 'connectSsh'],
      [new URL('../../src/lib/cluster/remote-fs.mjs', import.meta.url).href, 'openSftp'],
    ]
    const script = `for (const [url,name] of ${JSON.stringify(cases)}) { const module=await import(url);try { await module[name]() } catch {} }`
    await promisify(execFile)(
      process.execPath,
      [
        '--import',
        new URL('../fixtures/mock-gateway-runtime-loader.mjs', import.meta.url).pathname,
        '--input-type=module',
        '-e',
        script,
      ],
      {
        env: {
          ...process.env,
          KIN_CRS_MOCK: '1',
          VM2API_TEST_HOST_BARRIER_FILE: barrier,
          NODE_OPTIONS: `--import=${new URL('../fixtures/ha-flow-no-host-loader.mjs', import.meta.url).href}`,
        },
        timeout: 10000,
      },
    )
    assert.deepEqual(
      fs.readFileSync(barrier, 'utf8').trim().split('\n'),
      cases.map(([, name]) => name),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('two normal HA HTTP processes execute through PG grants and node completion before releasing shared admissions', {
  timeout: 120000,
}, async (t) => {
  const fx = await nodeManagementFixture(t)
  const gateways = []
  const manifestFile = path.join(os.tmpdir(), `vm2api-648-ha-flow-${process.pid}-resources.json`)
  const manifest = {
    root: fx.root,
    nodeRoot: fx.node.root,
    ...fx.resources,
    projectDirs: [],
    gatewayPids: [],
    state: 'active',
  }
  const saveManifest = () => fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  saveManifest()
  t.diagnostic(`resource manifest: ${manifestFile}`)
  let kernel
  let release
  let deadline
  let inFlight = []
  try {
    const credential = { ...JSON.parse(fx.payload).credential, expires_at: Date.now() + 3600000 }
    const payload = Buffer.from(JSON.stringify({ credential }))
    const published = await fx.run('node_publish_initial', (operation) =>
      fx.service.publishInitial(fx.input(operation, { payload })),
    )
    const launched = await fx.run('node_launch', (operation) =>
      fx.service.launch(
        fx.input(operation, {
          payload,
          commandId: 'http-flow-launch',
          manifestDigest: published.manifest_digest,
        }),
      ),
    )
    assert.equal(launched.fence.executor.kind, 'container')
    const managementCalls = [...fx.calls]
    const nodeRoot = path.join(fx.node.root, 'runtime', 'vms', fx.vmId, 'incarnations', launched.fence.incarnation)
    const arrivals = []
    let active = 0
    let peak = 0
    let healthCalls = 0
    let released = false
    let signalEntered
    const bothEntered = new Promise((resolve) => {
      signalEntered = resolve
    })
    const overlap = new Promise((resolve) => {
      release = () => {
        released = true
        resolve()
      }
    })
    kernel = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/internal/health') {
        healthCalls++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, healthy: true, ready_slots: 8, version: 'synthetic-kernel' }))
        return
      }
      if (req.method !== 'POST' || req.url !== '/internal/v1/messages') {
        res.writeHead(404).end()
        return
      }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const envelope = JSON.parse(Buffer.concat(chunks))
      arrivals.push({
        id: envelope.request_id,
        nodeAuthenticated:
          !!req.headers['x-kin-internal-token'] && req.headers['x-kin-internal-token'] !== 'synthetic-client-forgery',
      })
      active++
      peak = Math.max(peak, active)
      if (active === 2 && !released) signalEntered(true)
      await overlap
      const id = 'msg_' + envelope.request_id.replaceAll('-', '')
      const events = [
        {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic-node-response' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
        { type: 'message_stop' },
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-terminal-state': 'verified' })
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
      active--
    })
    await new Promise((resolve, reject) => {
      kernel.once('error', reject)
      kernel.listen(path.join(nodeRoot, 'run', 'kernel.sock'), resolve)
    })
    await new VmsRepo(fx.db).upsertFromVmJson({
      id: fx.vmId,
      name: 'synthetic-ha-http',
      node_id: fx.nodeId,
      status: 'running',
      schedulable: true,
      timezone: 'UTC',
      locale: 'en_US.UTF-8',
      fingerprint: { device_id: 'ha-http-device', session_id: 'ha-http-native-session', machineID: 'ha-http-machine' },
      policy: { maxConcurrency: 2, maxConcurrencyOverride: true, weight: 1 },
      claude: {
        account_uuid: credential.account_uuid,
        org_uuid: credential.org_uuid,
        email: credential.email,
        has_access: true,
        has_refresh: true,
        expires_at: credential.expires_at,
        source: 'synthetic-node-publish',
      },
    })
    const trust = path.join(fx.root, 'trusted-nodes.json')
    fs.writeFileSync(
      trust,
      JSON.stringify({
        nodes: { [fx.nodeId]: { ...fx.node.link, policyDigest: fx.policyDigest, presetId: 'claude-docker-v1' } },
      }),
      { mode: 0o600 },
    )
    const barrier = path.join(fx.root, 'legacy-effects.log')
    for (let index = 0; index < 2; index++) {
      const project = path.join(fx.root, `controller-${index}`)
      fs.mkdirSync(path.join(project, 'vms'), { recursive: true })
      fs.writeFileSync(path.join(project, 'vms', 'active.json'), '{}')
      gateways.push(
        await startGateway({
          project,
          readyMs: 15000,
          env: {
            VM2API_CONTROL_PLANE_MODE: 'kubernetes-ha',
            KIN_DATABASE_SCHEMA: fx.db.schema,
            VM2API_NODE_CONFIG_FILE: trust,
            VM2API_TEST_HOST_BARRIER_FILE: barrier,
            NODE_OPTIONS: `--import=${new URL('../fixtures/ha-flow-no-host-loader.mjs', import.meta.url).href}`,
            KIN_BACKUP_DISABLED: '1',
          },
        }),
      )
      manifest.projectDirs.push(project)
      manifest.gatewayPids.push(gateways.at(-1).child.pid)
      saveManifest()
    }
    assert.notEqual(gateways[0].child.pid, gateways[1].child.pid)
    const created = await api(gateways[0], 'POST', '/api/panel/api-keys', {
      body: { name: 'ha-node-flow', max_concurrency: 2, rpm: 0, quota_requests: 20 },
    })
    assert.equal(created.status, 201, created.text)
    const key = created.json.item.key
    deadline = setTimeout(() => {
      signalEntered(false)
      release()
    }, 10000)
    inFlight = gateways.map((gateway, index) =>
      api(gateway, 'POST', '/v1/messages', {
        headers: {
          authorization: `Bearer ${key}`,
          'x-session-id': `ha-http-session-${index}`,
          'x-internal-token': 'synthetic-client-forgery',
        },
        body: {
          model,
          max_tokens: 32,
          stream: index === 1,
          messages: [{ role: 'user', content: 'synthetic request' }],
        },
      }),
    )
    const entered = await Promise.race([bothEntered, Promise.all(inFlight).then(() => false)])
    assert.equal(entered, true, 'both controllers must dispatch before either kernel execution finishes')
    const activeClaims = (
      await fx.peer.query(`SELECT
      (SELECT count(*)::int FROM execution_admissions WHERE released_at IS NULL) AS executions,
      (SELECT count(*)::int FROM api_key_admissions WHERE released_at IS NULL) AS keys,
      (SELECT count(*)::int FROM session_turns WHERE state='active') AS turns,
      (SELECT count(*)::int FROM execution_jobs WHERE ended_at IS NULL AND node_binding IS NOT NULL) AS bound_jobs`)
    ).rows[0]
    assert.deepEqual(activeClaims, { executions: 2, keys: 2, turns: 2, bound_jobs: 2 })
    release()
    const responses = await Promise.all(inFlight)
    clearTimeout(deadline)
    for (const response of responses) assert.equal(response.status, 200, response.text)
    assert.equal(responses[0].json?.type, 'message', responses[0].text)
    assert.match(responses[0].text, /synthetic-node-response/)
    assert.match(responses[1].headers.get('content-type'), /text\/event-stream/)
    assert.match(responses[1].text, /event: message_stop/)
    assert.match(responses[1].text, /synthetic-node-response/)
    assert.ok(peak >= 2, `actual simultaneous kernel executions=${peak}`)
    assert.equal(arrivals.length, 2)
    assert.equal(new Set(arrivals.map((row) => row.id)).size, 2)
    assert.ok(arrivals.every((row) => row.nodeAuthenticated))
    assert.ok(healthCalls >= 2)
    const jobs = (
      await fx.peer.query(
        'SELECT request_id,node_binding,node_completion,ended_at FROM execution_jobs ORDER BY request_id',
      )
    ).rows
    assert.equal(jobs.length, 2)
    for (const job of jobs) {
      assert.ok(arrivals.some((row) => row.id === job.request_id))
      assert.equal(job.node_binding.protocol, 'KSG2')
      assert.equal(job.node_binding.nodeId, fx.nodeId)
      assert.equal(job.node_completion.id, job.request_id)
      assert.equal(job.node_completion.status, 'completed')
      assert.equal(job.node_completion.dispatched, true)
      assert.deepEqual(job.node_completion.fence, job.node_binding.fence)
      assert.ok(job.ended_at)
    }
    let counts
    for (let poll = 0; poll < 60; poll++) {
      counts = (
        await fx.peer.query(`SELECT
        (SELECT count(*)::int FROM execution_admissions WHERE released_at IS NULL) AS executions,
        (SELECT count(*)::int FROM api_key_admissions WHERE released_at IS NULL) AS keys,
        (SELECT count(*)::int FROM session_turns) AS turns`)
      ).rows[0]
      if (Object.values(counts).every((count) => count === 0)) break
      await pause(25)
    }
    assert.deepEqual(counts, { executions: 0, keys: 0, turns: 0 })
    assert.equal((await fx.peer.query('SELECT count(*)::int AS n FROM api_key_admissions')).rows[0].n, 2)
    assert.equal(
      (await fx.peer.query('SELECT count(*)::int AS n FROM api_key_admissions WHERE settled_at IS NOT NULL')).rows[0].n,
      2,
    )
    assert.deepEqual(fx.calls, managementCalls, 'controllers must not call legacy Docker or mutate executors')
    assert.equal(fs.existsSync(barrier) ? fs.readFileSync(barrier, 'utf8') : '', '')
    for (const gateway of gateways) {
      assert.equal(fs.existsSync(gateway.runtimeCallsFile) ? fs.readFileSync(gateway.runtimeCallsFile, 'utf8') : '', '')
      assert.equal(fs.existsSync(path.join(gateway.project, 'vms', fx.vmId, 'cli-home')), false)
    }
    t.diagnostic(
      `normal HTTP processes=2 kernel peak=${peak} jobs=${jobs.length} PG active executions/keys/turns=0/0/0; legacy I/O=0`,
    )
  } finally {
    clearTimeout(deadline)
    release?.()
    for (const gateway of gateways.reverse()) await gateway.stop()
    await Promise.allSettled(inFlight)
    if (kernel) {
      kernel.closeAllConnections()
      await new Promise((resolve) => kernel.close(resolve))
    }
    await fx.close()
    manifest.state = 'cleaned'
    manifest.remainingDirs = [fx.root, fx.node.root].filter((file) => fs.existsSync(file))
    manifest.remainingRoles = (
      await fx.db.pool.query('SELECT rolname FROM pg_roles WHERE rolname=$1', [fx.resources.readerRole])
    ).rows
    manifest.remainingPrivateSchemas = (
      await fx.db.pool.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])', [
        [fx.resources.authoritySchema, fx.resources.maintenanceSchema],
      ])
    ).rows
    saveManifest()
    assert.deepEqual(manifest.remainingDirs, [])
    assert.deepEqual(manifest.remainingRoles, [])
    assert.deepEqual(manifest.remainingPrivateSchemas, [])
  }
})
