import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import {
  bindPlacement,
  pruneStaleSlotImages,
  slotImageCheck,
  unbindPlacement,
  warmNodeSlotImages,
} from '../../src/lib/cluster/placement.mjs'

const quiet = { log() {}, warn() {} }
const noPrune = async () => []

function bindNodes({ platform = 'linux', docker = true, ready = () => true, routing = {} } = {}) {
  bindPlacement({
    manager: {
      nodePlatform: () => platform,
      linkReady: (id) => ready(id),
      health: new Map([['n1', { docker: { ok: docker } }]]),
    },
    projectRoot: '/nonexistent',
    getRouting: () => routing,
  })
}

const doneJob = (kernel, { skipped = false } = {}) => ({
  status: 'done',
  ref: `vm2api/kin-slot-${kernel}:abc`,
  log: skipped ? `节点已有 vm2api/kin-slot-${kernel}:abc，跳过传输\n` : '上传槽位程序层\n完成\n',
})

test('a missing slot image warns instead of blocking preflight', () => {
  const missing = slotImageCheck('vm2api/kin-slot-archlinux:abc', false)
  assert.equal(missing.ok, false)
  assert.equal(missing.level, 'warn', 'slot creation builds the image; auto placement must not skip the node')
  assert.match(missing.message, /自动构建/)
  const present = slotImageCheck('vm2api/kin-slot-archlinux:abc', true)
  assert.deepEqual([present.ok, present.level], [true, 'warn'])
})

test('warmNodeSlotImages builds each kernel in order and reports which were built', async (t) => {
  t.after(unbindPlacement)
  bindNodes()
  const calls = []
  const start = (node, kernel) => {
    calls.push(`${node}:${kernel}`)
    return doneJob(kernel, { skipped: kernel === 'debian-12' })
  }
  const logs = []
  const result = await warmNodeSlotImages('n1', {
    kernels: ['archlinux', 'debian-12'],
    start,
    prune: noPrune,
    logger: { log: (line) => logs.push(line), warn() {} },
  })
  assert.deepEqual(calls, ['n1:archlinux', 'n1:debian-12'])
  assert.deepEqual(
    result.map((r) => [r.kernel, r.status, r.built]),
    [
      ['archlinux', 'done', true],
      ['debian-12', 'done', false],
    ],
  )
  assert.equal(logs.length, 1, 'only an actual build is logged')
  assert.match(logs[0], /"event":"slot-image-warm"/)
})

test('a second warm while one runs shares the same run', async (t) => {
  t.after(unbindPlacement)
  bindNodes()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let starts = 0
  const start = (_node, kernel) => {
    starts++
    // A thenable job stands in for a running build: awaitSlotImageBuild resolves it.
    return gate.then(() => doneJob(kernel))
  }
  const a = warmNodeSlotImages('n1', { kernels: ['archlinux'], start, prune: noPrune, logger: quiet })
  const b = warmNodeSlotImages('n1', { kernels: ['archlinux'], start, prune: noPrune, logger: quiet })
  assert.equal(a, b)
  release()
  await a
  assert.equal(starts, 1)
  const again = await warmNodeSlotImages('n1', { kernels: ['archlinux'], start, prune: noPrune, logger: quiet })
  assert.equal(again.length, 1, 'a finished run does not block the next link-ready')
  assert.equal(starts, 2)
})

test('warm stops after a failure once the link is gone and never rejects', async (t) => {
  t.after(unbindPlacement)
  let linkUp = true
  bindNodes({ ready: () => linkUp })
  const calls = []
  const start = (_node, kernel) => {
    calls.push(kernel)
    linkUp = false
    throw new Error('节点未连接')
  }
  const warned = []
  const result = await warmNodeSlotImages('n1', {
    kernels: ['archlinux', 'debian-12', 'fedora-41'],
    start,
    prune: noPrune,
    logger: { log() {}, warn: (line) => warned.push(line) },
  })
  assert.deepEqual(calls, ['archlinux'])
  assert.deepEqual(
    result.map((r) => r.status),
    ['failed'],
  )
  assert.match(warned[0], /archlinux failed: 节点未连接/)
})

test('a failed kernel with the link still up does not stop the rest', async (t) => {
  t.after(unbindPlacement)
  bindNodes()
  const start = (_node, kernel) =>
    kernel === 'archlinux' ? { status: 'failed', ref: null, log: '失败：pull denied' } : doneJob(kernel)
  const result = await warmNodeSlotImages('n1', {
    kernels: ['archlinux', 'debian-12'],
    start,
    prune: noPrune,
    logger: quiet,
  })
  assert.deepEqual(
    result.map((r) => [r.kernel, r.status]),
    [
      ['archlinux', 'failed'],
      ['debian-12', 'done'],
    ],
  )
})

test('warm skips macOS nodes, nodes without Docker, and cluster.slot_image_warm=false', async (t) => {
  t.after(unbindPlacement)
  const start = () => {
    throw new Error('must not build')
  }
  bindNodes({ platform: 'darwin' })
  assert.deepEqual(await warmNodeSlotImages('n1', { start, logger: quiet }), [])
  bindNodes({ docker: false })
  assert.deepEqual(await warmNodeSlotImages('n1', { start, logger: quiet }), [])
  bindNodes({ routing: { cluster: { slot_image_warm: false } } })
  assert.deepEqual(await warmNodeSlotImages('n1', { start, logger: quiet }), [])
  unbindPlacement()
  assert.deepEqual(await warmNodeSlotImages('n1', { start, logger: quiet }), [])
})

test('warm prunes old tags only after every kernel is current', async (t) => {
  t.after(unbindPlacement)
  bindNodes()
  const pruned = []
  const prune = async (node, refs) => {
    pruned.push([node, refs])
    return ['vm2api/kin-slot-archlinux:old']
  }
  const logs = []
  await warmNodeSlotImages('n1', {
    kernels: ['archlinux', 'debian-12'],
    start: (_node, kernel) => doneJob(kernel, { skipped: true }),
    prune,
    logger: { log: (line) => logs.push(line), warn() {} },
  })
  assert.deepEqual(pruned, [['n1', ['vm2api/kin-slot-archlinux:abc', 'vm2api/kin-slot-debian-12:abc']]])
  assert.match(logs.join('\n'), /"event":"slot-image-prune".*kin-slot-archlinux:old/)

  pruned.length = 0
  await warmNodeSlotImages('n1', {
    kernels: ['archlinux', 'debian-12'],
    start: (_node, kernel) => (kernel === 'debian-12' ? { status: 'failed', log: 'x' } : doneJob(kernel)),
    prune,
    logger: quiet,
  })
  assert.deepEqual(pruned, [], 'a node missing a current image keeps its old ones')
})

test('pruneStaleSlotImages untags only stale tags of the warmed repos, never forced', async (t) => {
  const deleted = []
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/images/json')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify([
          { RepoTags: ['vm2api/kin-slot-archlinux:new'] },
          { RepoTags: ['vm2api/kin-slot-archlinux:old'] },
          { RepoTags: ['vm2api/kin-slot-archlinux:inuse'] },
          { RepoTags: ['vm2api/kin-slot-kvm-archlinux:old'] },
          { RepoTags: ['vm2api/kin-slot-fedora-41:old'] },
          { RepoTags: ['ghcr.io/dofastted/kin-os-arch:latest'] },
          { RepoTags: null },
        ]),
      )
      return
    }
    if (req.method === 'DELETE') {
      const ref = decodeURIComponent(req.url.split('?')[0].slice('/images/'.length))
      deleted.push({ ref, force: /force=(1|true)/.test(req.url) })
      res.writeHead(ref.endsWith(':inuse') ? 409 : 200, { 'content-type': 'application/json' })
      res.end(ref.endsWith(':inuse') ? '{"message":"conflict: image is being used by container"}' : '[]')
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { port } = server.address()
  const connect = () =>
    new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1')
      sock.once('connect', () => resolve(sock))
      sock.once('error', reject)
    })
  const removed = await pruneStaleSlotImages('n1', ['vm2api/kin-slot-archlinux:new'], { connect })
  assert.deepEqual(removed, ['vm2api/kin-slot-archlinux:old'])
  assert.deepEqual(
    deleted.map((d) => d.ref).sort(),
    ['vm2api/kin-slot-archlinux:inuse', 'vm2api/kin-slot-archlinux:old'],
    'kvm images, other kernels not warmed this round, and base images are left alone',
  )
  assert.equal(
    deleted.some((d) => d.force),
    false,
  )
})
