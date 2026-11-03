import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { collectLocalStatus, containerMemoryUsed, localDisk } from '../../src/lib/cluster/local-status.mjs'

test('containerMemoryUsed subtracts inactive_file on cgroup v2 and v1', () => {
  assert.equal(containerMemoryUsed({ memory_stats: { usage: 1000, stats: { inactive_file: 300 } } }), 700)
  assert.equal(containerMemoryUsed({ memory_stats: { usage: 1000, stats: { total_inactive_file: 100 } } }), 900)
  assert.equal(containerMemoryUsed({ memory_stats: { usage: 1000 } }), 1000)
  assert.equal(containerMemoryUsed({ memory_stats: {} }), null)
  assert.equal(containerMemoryUsed(null), null)
})

test('localDisk reads the filesystem behind a directory, null when missing', () => {
  const disk = localDisk(process.cwd())
  assert.ok(disk.disk_total > 0 && disk.disk_used >= 0 && disk.disk_pct >= 0 && disk.disk_pct <= 100)
  assert.deepEqual(localDisk('/nonexistent-vm2api-dir'), { disk_total: null, disk_used: null, disk_pct: null })
})

/** Task-owned mock Docker API on an ephemeral loopback port; no Docker daemon or disk state. */
async function fakeDocker(t, stats) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.url)
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/version') return send(200, { Version: '29.9.2', ApiVersion: '1.51' })
    if (req.url === '/info') return send(200, { Containers: 5, ContainersRunning: 4 })
    if (req.url.startsWith('/containers/json'))
      return send(
        200,
        Object.keys(stats).map((Id) => ({ Id })),
      )
    const m = req.url.match(/^\/containers\/([^/]+)\/stats\?stream=false&one-shot=true$/)
    if (m && stats[m[1]] !== undefined) {
      return stats[m[1]] === 'fail' ? send(500, { message: 'boom' }) : send(200, stats[m[1]])
    }
    return send(404, { message: 'no' })
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  const connect = () =>
    new Promise((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port })
      s.once('connect', () => resolve(s))
      s.once('error', reject)
    })
  return { connect, seen }
}

const mem = (usage, inactive) => ({ memory_stats: { usage, stats: { inactive_file: inactive } } })
const base = { listen: { host: '127.0.0.1', port: 8787 }, observer: null, routing: {} }

test('collectLocalStatus sums slot container memory and reports the data disk', async (t) => {
  const { connect, seen } = await fakeDocker(t, { a: mem(3000, 1000), b: mem(500, 0) })
  const status = await collectLocalStatus({ ...base, docker: connect })
  assert.equal(status.docker.ok, true)
  assert.equal(status.docker.slots, 2)
  assert.equal(status.docker.slots_mem, 2500)
  assert.ok(seen.every((u) => !u.includes('stats') || u.includes('one-shot=true')))
  assert.ok('disk_pct' in status.disk)
})

test('collectLocalStatus gives null slot memory when any stats read fails', async (t) => {
  const { connect } = await fakeDocker(t, { a: mem(3000, 1000), b: 'fail' })
  const status = await collectLocalStatus({ ...base, docker: connect })
  assert.equal(status.docker.slots, 2)
  assert.equal(status.docker.slots_mem, null)
})

test('collectLocalStatus reports zero slot memory when no slot runs', async (t) => {
  const { connect } = await fakeDocker(t, {})
  const status = await collectLocalStatus({ ...base, docker: connect })
  assert.equal(status.docker.slots, 0)
  assert.equal(status.docker.slots_mem, 0)
})
