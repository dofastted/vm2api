import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { CODEC_LIMITS, InferenceCodec } from '../../src/lib/transport/inference-codec.mjs'
import { encodeInferenceJson, parseWorkerJson } from '../../src/lib/transport/inference-codec-json.mjs'

class HeldWorker extends EventEmitter {
  messages = []
  ref() {}
  unref() {}
  postMessage(message) {
    this.messages.push(message)
  }
  terminate() {
    return Promise.resolve(1)
  }
  finish() {
    this.emit('message', { fallback: true })
  }
}

function heldCodec(t) {
  const workers = []
  const codec = new InferenceCodec({
    createWorker: () => {
      const worker = new HeldWorker()
      workers.push(worker)
      return worker
    },
  })
  t.after(() => codec.close())
  return { codec, workers }
}

const largeText = '你好\\\n"\ud800'.repeat(20000)

test('real codec threads preserve JSON and UTF-8 bytes, with no Buffer detachment', async (t) => {
  const jobs = []
  const codec = new InferenceCodec({
    createWorker: () => {
      const worker = new Worker(new URL('../../src/lib/transport/inference-codec-worker.mjs', import.meta.url))
      const postMessage = worker.postMessage.bind(worker)
      worker.postMessage = (job, transfer) => {
        jobs.push(job.operation)
        return postMessage(job, transfer)
      }
      return worker
    },
  })
  t.after(() => codec.close())
  const value = JSON.parse('{"__proto__":{"safe":true},"2":2,"1":1}')
  Object.assign(value, { text: largeText, missing: undefined, numbers: [NaN, Infinity, -0], empty: null })
  const encoded = await codec.encode(value)
  assert.deepEqual(encoded, encodeInferenceJson(value))
  assert.deepEqual(await codec.encode(largeText), Buffer.from(largeText))
  const backing = Buffer.concat([Buffer.from('prefix'), encoded, Buffer.from('suffix')])
  const input = backing.subarray(6, backing.length - 6)
  assert.deepEqual(await codec.decode(input), JSON.parse(encoded.toString('utf8')))
  assert.equal(input.length, encoded.length)
  assert.equal(backing.subarray(0, 6).toString(), 'prefix')
  assert.deepEqual(input, encoded)
  const invalid = Buffer.concat([Buffer.from('{"text":"'), Buffer.alloc(CODEC_LIMITS.thresholdBytes, 0xff)])
  assert.deepEqual(await codec.decode(invalid), parseWorkerJson(invalid))
  assert.deepEqual(await codec.decode(invalid, { status: 413 }), parseWorkerJson(invalid, 413))
  const structured = Buffer.from(JSON.stringify({ error: { code: 'specific', message: largeText } }))
  assert.deepEqual(await codec.decode(structured, { status: 413 }), JSON.parse(structured))
  const complex = Buffer.from(JSON.stringify({ text: largeText, many: Array(CODEC_LIMITS.nodes).fill(0) }))
  assert.deepEqual(await codec.decode(complex), JSON.parse(complex))
  assert.ok(jobs.filter((operation) => operation === 'encode').length >= 1)
  assert.ok(jobs.filter((operation) => operation === 'decode').length >= 4)
  assert.equal(codec.reservedBytes, 0)
})

test('small, custom, accessor, sparse and non-cloneable inputs retain native JSON semantics', async (t) => {
  const { codec, workers } = heldCodec(t)
  assert.equal((await codec.encode({ small: 'yes' })).toString(), '{"small":"yes"}')
  assert.deepEqual(await codec.decode(Buffer.from('{"small":true}')), { small: true })
  let hooks = 0
  const hooked = {
    toJSON() {
      hooks++
      return { text: largeText }
    },
  }
  assert.equal((await codec.encode(hooked)).toString(), JSON.stringify({ text: largeText }))
  assert.equal(hooks, 1)
  let reads = 0
  const accessor = {
    get text() {
      reads++
      return largeText
    },
  }
  assert.equal((await codec.encode(accessor)).toString(), JSON.stringify({ text: largeText }))
  assert.equal(reads, 1)
  const sparse = [largeText, , undefined]
  const unusual = [
    sparse,
    new Date('2026-01-01T00:00:00Z'),
    Buffer.from('buffer'),
    { text: largeText, omitted: () => true },
    new Proxy({ text: largeText }, {}),
    { text: largeText, boxed: Object.setPrototypeOf(Object(true), null) },
    ...(JSON.rawJSON ? [{ text: largeText, raw: JSON.rawJSON('9007199254740993') }] : []),
  ]
  for (const value of unusual) assert.deepEqual(await codec.encode(value), encodeInferenceJson(value))
  await assert.rejects(codec.encode({ text: largeText, bad: 1n }), TypeError)
  const cycle = { text: largeText }
  cycle.self = cycle
  await assert.rejects(codec.encode(cycle), TypeError)
  assert.equal(workers.length, 0)
})

test('two running jobs are the entire queue; saturation does not post a third IPC message', async (t) => {
  const { codec, workers } = heldCodec(t)
  const value = { text: largeText }
  const first = codec.encode(value)
  const second = codec.encode(value)
  assert.equal(workers.length, CODEC_LIMITS.threads)
  assert.deepEqual(await codec.encode(value), encodeInferenceJson(value))
  assert.equal(
    workers.reduce((count, worker) => count + worker.messages.length, 0),
    2,
  )
  assert.ok(codec.reservedBytes <= CODEC_LIMITS.totalBytes)
  for (const worker of workers) worker.finish()
  await Promise.all([first, second])
  assert.equal(codec.reservedBytes, 0)
})

test('byte reservations prevent another large IPC job even with an unused thread', async (t) => {
  const { codec, workers } = heldCodec(t)
  const value = { text: 'x'.repeat(8 * 1024 * 1024) }
  const first = codec.encode(value)
  assert.ok(codec.reservedBytes > CODEC_LIMITS.totalBytes / 2)
  assert.deepEqual(await codec.encode(value), encodeInferenceJson(value))
  assert.equal(workers.length, 1)
  assert.equal(workers[0].messages.length, 1)
  workers[0].finish()
  await first
  assert.equal(codec.reservedBytes, 0)
})

test('abort rejects promptly but retains a busy slot until its stale reply is drained', async (t) => {
  const { codec, workers } = heldCodec(t)
  const controller = new AbortController()
  const pending = codec.encode({ text: largeText }, { signal: controller.signal })
  const rejected = assert.rejects(pending, { code: 'ABORT_ERR' })
  const reserved = codec.reservedBytes
  controller.abort()
  await rejected
  assert.equal(codec.reservedBytes, reserved)
  const other = codec.encode({ text: largeText })
  assert.equal(workers.length, 2)
  workers[0].finish()
  assert.ok(codec.reservedBytes > 0)
  workers[1].finish()
  await other
  assert.equal(codec.reservedBytes, 0)
  await assert.rejects(codec.decode(Buffer.from('{}'), { signal: controller.signal }), { code: 'ABORT_ERR' })
  await assert.rejects(codec.encode({ text: largeText }, { signal: controller.signal }), { code: 'ABORT_ERR' })
  assert.equal(
    workers.reduce((count, worker) => count + worker.messages.length, 0),
    2,
  )
})

for (const event of ['error', 'exit']) {
  test(`${event} recovers only the local codec job from an immutable snapshot`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const { codec, workers } = heldCodec(t)
    const value = { body: { text: largeText } }
    const expected = encodeInferenceJson(value)
    const pending = codec.encode(value)
    value.body.text = 'mutated after submission'
    workers[0].emit(event, event === 'error' ? new Error('worker died') : 1)
    assert.deepEqual(await pending, expected)
    assert.equal(codec.reservedBytes, 0)
    assert.equal(workers[0].messages.length, 1)
    assert.deepEqual(await codec.encode({ text: largeText }), encodeInferenceJson({ text: largeText }))
    assert.equal(workers.length, 1)
    t.mock.timers.tick(CODEC_LIMITS.restartDelayMs)
    const restarted = codec.encode({ text: largeText })
    assert.equal(workers.length, 2)
    assert.equal(workers[1].messages.length, 1)
    workers[1].finish()
    assert.deepEqual(await restarted, encodeInferenceJson({ text: largeText }))
  })
}

test('retiring workers hold their byte reservation and thread slot until termination', async (t) => {
  const { codec, workers } = heldCodec(t)
  const pending = codec.encode({ text: largeText })
  let release
  workers[0].terminate = () =>
    new Promise((resolve) => {
      release = resolve
    })
  workers[0].emit('error', new Error('worker died'))
  assert.ok(codec.reservedBytes > 0)
  assert.equal(codec.slots.size, 1)
  release(1)
  await pending
  assert.equal(codec.reservedBytes, 0)
  assert.equal(codec.slots.size, 0)
})

test('startup and postMessage failures use the local codec without a retry queue', async (t) => {
  const startup = new InferenceCodec({
    createWorker() {
      throw new Error('unavailable')
    },
  })
  t.after(() => startup.close())
  assert.deepEqual(await startup.encode({ text: largeText }), encodeInferenceJson({ text: largeText }))
  const { codec, workers } = heldCodec(t)
  codec.createWorker = () => {
    const worker = new HeldWorker()
    worker.postMessage = () => {
      throw new Error('cannot clone')
    }
    workers.push(worker)
    return worker
  }
  assert.deepEqual(await codec.encode({ text: largeText }), encodeInferenceJson({ text: largeText }))
  assert.equal(workers.length, 1)
  assert.equal(codec.reservedBytes, 0)
})

test('a stalled codec job times out locally without creating another worker job', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { codec, workers } = heldCodec(t)
  const value = { text: largeText }
  const pending = codec.encode(value)
  t.mock.timers.tick(CODEC_LIMITS.jobTimeoutMs)
  assert.deepEqual(await pending, encodeInferenceJson(value))
  assert.equal(workers.length, 1)
  assert.equal(workers[0].messages.length, 1)
  assert.equal(codec.reservedBytes, 0)
})
