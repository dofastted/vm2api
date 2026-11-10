import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bindPlacement, unbindPlacement } from '../../src/lib/cluster/placement.mjs'
import { raiseDockerSlotMemory } from '../../src/lib/vm/docker-slot-memory.mjs'

const SCENARIO = '--remote-memory-bridge-scenario'
const CONTAINER_ID = 'a'.repeat(64)
const EXEC_ID = 'b'.repeat(64)
const INITIAL_MEMORY = 512 * 1024 ** 2
const TARGET_MEMORY = 1024 ** 3

function stdoutFrame(text) {
  const payload = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = 1
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

// Only the legacy path needs a Docker CLI. Keep this regression runnable on a
// machine without one: the shim is a real child HTTP client, not a canned exec
// result. It still waits on the socket served by the blocked parent process.
function prepareLegacyDocker(root) {
  for (const key of ['DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION']) {
    delete process.env[key]
  }
  const probe = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 3000 })
  if (probe.status === 0) return 'installed Docker CLI'
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(
    path.join(bin, 'docker'),
    `#!${process.execPath}\n` +
      `const http = require('node:http');\n` +
      `const args = process.argv.slice(2);\n` +
      `if (args[0] !== 'inspect') throw new Error('legacy probe expected docker inspect');\n` +
      `const name = args[args.length - 1];\n` +
      `const req = http.get({ socketPath: process.env.DOCKER_HOST.slice(7), path: '/containers/' + encodeURIComponent(name) + '/json' }, res => {\n` +
      `let body = ''; res.on('data', b => body += b); res.on('end', () => {\n` +
      `const value = JSON.parse(body); process.stdout.write(value.HostConfig.Memory + ' ' + value.HostConfig.MemorySwap + ' ' + value.State.Running);\n` +
      `}); }); req.on('error', err => { console.error(err.message); process.exitCode = 1; });\n`,
    { mode: 0o700 },
  )
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH || ''}`
  return 'isolated HTTP Docker CLI shim'
}

async function runScenario() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mb-'))
  const socketPath = path.join(root, 'd.sock')
  const requests = []
  const vm = {
    id: 'vm-remote',
    node_id: 'node-fixture',
    status: 'running',
    machine: { memory: '512m' },
    runtime: { type: 'docker', memory: '512m' },
    account_marker: 'must-survive-memory-raise',
  }
  fs.mkdirSync(path.join(root, 'vms'))
  const recordPath = path.join(root, 'vms', `${vm.id}.json`)
  fs.writeFileSync(recordPath, JSON.stringify(vm))
  const cli = prepareLegacyDocker(root)
  let memory = INITIAL_MEMORY
  let swap = TARGET_MEMORY
  let heartbeat = 0
  let largestHeartbeatGap = 0
  let lastHeartbeat = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    largestHeartbeatGap = Math.max(largestHeartbeatGap, now - lastHeartbeat)
    lastHeartbeat = now
    heartbeat += 1
  }, 10)
  const server = http.createServer(async (req, res) => {
    const parts = []
    for await (const chunk of req) parts.push(chunk)
    const raw = Buffer.concat(parts).toString()
    const body = raw ? JSON.parse(raw) : null
    const pathname = new URL(req.url, 'http://docker').pathname.replace(/^\/v\d+\.\d+/, '')
    requests.push({ method: req.method, path: pathname, body })
    // Deliberately keep each request outstanding across heartbeat ticks. This
    // checks event-loop progress without a tight wall-clock performance limit.
    await new Promise((resolve) => setTimeout(resolve, 30))
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (pathname === '/_ping') {
      res.writeHead(200, { 'API-Version': '1.48', 'Docker-Experimental': 'false' })
      res.end('OK')
    } else if (req.method === 'GET' && /^\/containers\/[^/]+\/json$/.test(pathname)) {
      json(200, { Id: CONTAINER_ID, HostConfig: { Memory: memory, MemorySwap: swap }, State: { Running: true } })
    } else if (req.method === 'POST' && pathname === `/containers/${CONTAINER_ID}/update`) {
      memory = body.Memory
      swap = body.MemorySwap
      json(200, { Warnings: null })
    } else if (req.method === 'POST' && pathname === `/containers/${CONTAINER_ID}/exec`) {
      json(201, { Id: EXEC_ID })
    } else if (req.method === 'POST' && pathname === `/exec/${EXEC_ID}/start`) {
      res.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' })
      res.end(stdoutFrame(`${memory}\n`))
    } else if (req.method === 'GET' && pathname === `/exec/${EXEC_ID}/json`) {
      json(200, { ID: EXEC_ID, ContainerID: CONTAINER_ID, Running: false, ExitCode: 0 })
    } else {
      json(404, { message: `Unexpected fixture request: ${req.method} ${pathname}` })
    }
  })
  const connect = () =>
    new Promise((resolve, reject) => {
      const stream = net.connect(socketPath)
      stream.once('connect', () => resolve(stream))
      stream.once('error', reject)
    })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    bindPlacement({
      projectRoot: root,
      getRouting: () => ({}),
      manager: {
        bridgeSocketPath: () => socketPath,
        docker: () => connect,
        nodePlatform: () => 'linux',
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    const heartbeatBefore = heartbeat
    const started = performance.now()
    const result = await raiseDockerSlotMemory(root, vm, '1g', { connect })
    const elapsedMs = Math.round(performance.now() - started)
    const heartbeatDuringRaise = heartbeat - heartbeatBefore
    await new Promise((resolve) => setTimeout(resolve, 40))
    return {
      cli,
      result,
      elapsed_ms: elapsedMs,
      heartbeat_during_raise: heartbeatDuringRaise,
      largest_heartbeat_gap_ms: Math.round(largestHeartbeatGap),
      requests,
      saved: JSON.parse(fs.readFileSync(recordPath, 'utf8')),
      final_memory: memory,
    }
  } finally {
    clearInterval(timer)
    unbindPlacement()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv.includes(SCENARIO)) {
  try {
    console.log(JSON.stringify(await runScenario()))
  } catch (error) {
    console.error(error.stack)
    process.exitCode = 1
  }
} else {
  test('remote memory raise serves its own Docker socket without blocking the event loop', {
    timeout: 45_000,
  }, async (t) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), SCENARIO], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      signal: t.signal,
    })
    t.after(() => child.kill())
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    assert.equal(exitCode, 0, stderr || stdout)
    const observed = JSON.parse(stdout.trim())
    t.diagnostic(JSON.stringify(observed))
    assert.doesNotMatch(
      observed.result.message || '',
      /ENOENT|command not found/,
      'a missing CLI is not the deadlock regression',
    )
    assert.equal(observed.result.ok, true, JSON.stringify(observed.result))
    assert.ok(observed.heartbeat_during_raise > 0, 'heartbeat must progress while the Docker socket is being served')
    assert.equal(observed.result.memory, '1g')
    assert.equal(observed.final_memory, TARGET_MEMORY)
    assert.equal(observed.saved.machine.memory, '1g')
    assert.equal(observed.saved.runtime.memory, '1g')
    assert.equal(observed.saved.account_marker, 'must-survive-memory-raise')
    const requests = observed.requests
    assert.equal(requests[0].path, '/containers/kin-remote/json')
    const inspectRequests = requests.filter(
      (request) =>
        request.method === 'GET' && request.path.endsWith('/json') && request.path.startsWith('/containers/'),
    )
    assert.ok(
      inspectRequests.length >= 3,
      'inspect before and after update, then recheck the named container before saving',
    )
    assert.equal(inspectRequests.at(-1).path, '/containers/kin-remote/json')
    for (const request of inspectRequests.slice(1, -1)) {
      assert.equal(request.path, `/containers/${CONTAINER_ID}/json`, 'verify updates against the original container ID')
    }
    for (const request of requests.filter((entry) => entry.method !== 'GET' && entry.path.startsWith('/containers/'))) {
      assert.ok(
        request.path.startsWith(`/containers/${CONTAINER_ID}/`),
        'pin every container mutation and exec to the inspected ID',
      )
    }
    const update = requests.find((request) => request.path === `/containers/${CONTAINER_ID}/update`)
    assert.equal(update?.method, 'POST')
    assert.equal(update?.body.Memory, TARGET_MEMORY)
    const createExec = requests.find((request) => request.path === `/containers/${CONTAINER_ID}/exec`)
    assert.equal(createExec?.method, 'POST')
    assert.deepEqual(createExec?.body.Cmd, ['cat', '/sys/fs/cgroup/memory.max'])
    assert.ok(requests.some((request) => request.method === 'POST' && request.path === `/exec/${EXEC_ID}/start`))
    assert.ok(requests.some((request) => request.method === 'GET' && request.path === `/exec/${EXEC_ID}/json`))
  })
}
