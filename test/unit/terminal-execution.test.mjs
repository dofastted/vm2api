import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter, once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { createClusterRoutes } from '../../src/lib/cluster/cluster-routes.mjs'

async function cluster(t, authorized = true) {
  const events = []
  const stream = new EventEmitter()
  stream.close = () => {}
  let opens = 0
  const routes = createClusterRoutes({
    manager: {
      consumeShellTicket: () => authorized,
      openShell: async () => {
        opens++
        return stream
      },
    },
    onExecutionState: async (_req, execution) => {
      events.push(execution)
    },
  })
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => routes.handleUpgrade(req, socket, head))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/panel/cluster/nodes/node-a/shell?ticket=t`)
  ws.on('error', () => {})
  t.after(async () => {
    ws.terminate()
    await routes.drain()
    await new Promise((resolve) => server.close(resolve))
  })
  return { events, stream, ws, opens: () => opens }
}

test('cluster shell reports a stable execution ID and only SSH exit confirms execution ended', async (t) => {
  const f = await cluster(t)
  await once(f.ws, 'open')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.events[0]?.started, true)
  assert.equal(f.events[0]?.ended, false)
  assert.ok(f.events[0].requestId)
  f.stream.emit('exit', 0)
  f.stream.emit('close')
  await once(f.ws, 'close')
  assert.equal(f.events.at(-1).ended, true)
  assert.equal(f.events.at(-1).requestId, f.events[0].requestId)
})

test('cluster channel or WebSocket close without exit never confirms execution ended', async (t) => {
  const f = await cluster(t)
  await once(f.ws, 'open')
  await new Promise((resolve) => setImmediate(resolve))
  f.stream.emit('close')
  await once(f.ws, 'close')
  assert.equal(f.events[0]?.started, true)
  assert.equal(f.events.at(-1)?.ended, false)
})

test('cluster shell rejects an invalid ticket with an explicit not-started outcome', async (t) => {
  const f = await cluster(t, false)
  await new Promise((resolve) => f.ws.once('error', resolve))
  assert.equal(f.opens(), 0)
  assert.equal(f.events.length, 1)
  assert.equal(f.events[0].started, false)
  assert.equal(f.events[0].ended, true)
})

for (const running of ['true', 'false']) {
  test(`slot shell accepts Docker termination proof only when Running is false (${running})`, () => {
    const env = { ...process.env, VM2API_TERMINAL_INSPECT_RUNNING: running }
    delete env.NODE_TEST_CONTEXT
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-test-module-mocks',
        fileURLToPath(new URL('../fixtures/terminal-execution.mjs', import.meta.url)),
      ],
      {
        env,
        encoding: 'utf8',
        timeout: 5000,
      },
    )
    assert.equal(child.status, 0, child.stdout + child.stderr || child.error?.message)
  })
}
