import test from 'node:test'
import assert from 'node:assert/strict'
import { bindPlacement, slotImageCheck, unbindPlacement, warmNodeSlotImages } from '../../src/lib/cluster/placement.mjs'

const quiet = { log() {}, warn() {} }

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
  const a = warmNodeSlotImages('n1', { kernels: ['archlinux'], start, logger: quiet })
  const b = warmNodeSlotImages('n1', { kernels: ['archlinux'], start, logger: quiet })
  assert.equal(a, b)
  release()
  await a
  assert.equal(starts, 1)
  const again = await warmNodeSlotImages('n1', { kernels: ['archlinux'], start, logger: quiet })
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
  const result = await warmNodeSlotImages('n1', { kernels: ['archlinux', 'debian-12'], start, logger: quiet })
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
