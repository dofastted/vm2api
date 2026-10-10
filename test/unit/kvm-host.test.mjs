import test from 'node:test'
import assert from 'node:assert/strict'
import { probeLocalKvm, resetKvmProbeCache } from '../../src/lib/vm/kvm-host.mjs'

test.beforeEach(() => resetKvmProbeCache())

test('host without /dev/kvm fails unless allow_tcg', async () => {
  const denied = await probeLocalKvm({
    routing: { vm: { allow_tcg: false } },
    inContainer: false,
    accessKvm() {
      throw new Error('EACCES')
    },
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.accel, null)
  assert.match(denied.error, /\/dev\/kvm/)

  const tcg = await probeLocalKvm({
    routing: { vm: { allow_tcg: true } },
    inContainer: false,
    accessKvm() {
      throw new Error('EACCES')
    },
  })
  assert.equal(tcg.ok, true)
  assert.equal(tcg.accel, 'tcg')
})

test('writable /dev/kvm reports kvm even when allow_tcg is off', async () => {
  const out = await probeLocalKvm({
    routing: { vm: { allow_tcg: false } },
    inContainer: false,
    accessKvm() {},
  })
  assert.deepEqual(out, { ok: true, accel: 'kvm', error: null })
})

test('cache is keyed by allow_tcg and force bypasses it', async () => {
  let hits = 0
  const accessKvm = () => {
    hits += 1
    throw new Error('missing')
  }
  const first = await probeLocalKvm({ routing: { vm: { allow_tcg: false } }, inContainer: false, accessKvm })
  const cached = await probeLocalKvm({ routing: { vm: { allow_tcg: false } }, inContainer: false, accessKvm })
  assert.equal(hits, 1)
  assert.deepEqual(first, cached)

  const tcg = await probeLocalKvm({ routing: { vm: { allow_tcg: true } }, inContainer: false, accessKvm })
  assert.equal(hits, 2)
  assert.equal(tcg.accel, 'tcg')

  await probeLocalKvm({ routing: { vm: { allow_tcg: false } }, inContainer: false, accessKvm, force: true })
  assert.equal(hits, 3)
})

test('in-container device probe uses the self image', async () => {
  const seen = []
  const out = await probeLocalKvm({
    routing: { vm: { allow_tcg: false } },
    inContainer: true,
    sockPath: '/tmp',
    docker: async () => ({}),
    async resolveImage() {
      return 'ghcr.io/example/vm2api:test'
    },
    async probeContainer(_docker, image) {
      seen.push(image)
      return true
    },
  })
  assert.deepEqual(seen, ['ghcr.io/example/vm2api:test'])
  assert.equal(out.accel, 'kvm')
})
