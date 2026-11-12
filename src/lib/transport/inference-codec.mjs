import { Worker } from 'node:worker_threads'
import { CODEC_LIMITS, encodeInferenceJson, inspectCodecValue, parseWorkerJson } from './inference-codec-json.mjs'

export { CODEC_LIMITS } from './inference-codec-json.mjs'

function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
}

export class InferenceCodec {
  constructor({
    createWorker = () =>
      new Worker(new URL('./inference-codec-worker.mjs', import.meta.url), {
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      }),
  } = {}) {
    this.createWorker = createWorker
    this.slots = new Set()
    this.reservedBytes = 0
    this.restartAt = 0
    this.closed = false
  }

  async encode(value, { signal } = {}) {
    if (signal?.aborted) throw abortError()
    const inspected = inspectCodecValue(value, CODEC_LIMITS.jobBytes / 3, true)
    if (!inspected || inspected.bytes < CODEC_LIMITS.thresholdBytes) return encodeInferenceJson(value)
    const slot = this.acquire(inspected.bytes * 3)
    if (!slot) return encodeInferenceJson(value)
    const fallback = () => encodeInferenceJson(inspected.value)
    return this.run(
      slot,
      {
        operation: 'encode',
        value: inspected.value,
        resultBytes: inspected.bytes,
      },
      [],
      fallback,
      signal,
      (result) => Buffer.from(result.buffer, result.byteOffset, result.byteLength),
    )
  }

  async decode(value, { status = 0, signal } = {}) {
    if (signal?.aborted) throw abortError()
    const cost = value.length * 10 + 1024
    if (value.length < CODEC_LIMITS.thresholdBytes || cost > CODEC_LIMITS.jobBytes) {
      return parseWorkerJson(value, status)
    }
    const slot = this.acquire(cost)
    if (!slot) return parseWorkerJson(value, status)
    const bytes = new Uint8Array(value.length)
    bytes.set(value)
    return this.run(
      slot,
      {
        operation: 'decode',
        value: bytes,
        status,
        resultBytes: cost - value.length * 2,
      },
      [bytes.buffer],
      () => parseWorkerJson(value, status),
      signal,
    )
  }

  acquire(bytes) {
    if (this.closed || this.reservedBytes + bytes > CODEC_LIMITS.totalBytes || Date.now() < this.restartAt) return null
    let slot = [...this.slots].find((entry) => !entry.retired && !entry.job)
    if (!slot) {
      if (this.slots.size >= CODEC_LIMITS.threads) return null
      try {
        slot = { worker: this.createWorker(), job: null, retired: false }
        this.slots.add(slot)
        slot.worker.on('message', (message) => {
          if (!slot.retired) this.complete(slot, message)
        })
        slot.worker.on('error', () => this.retire(slot))
        slot.worker.on('exit', () => this.retire(slot))
        slot.worker.unref()
      } catch {
        this.restartAt = Date.now() + CODEC_LIMITS.restartDelayMs
        return null
      }
    }
    this.reservedBytes += bytes
    slot.job = { bytes }
    return slot
  }

  run(slot, message, transfer, fallback, signal, convert = (value) => value) {
    return new Promise((resolve, reject) => {
      const job = slot.job
      Object.assign(job, { resolve, reject, fallback, convert, signal })
      job.onAbort = () => {
        job.reject?.(abortError())
        job.resolve = null
        job.reject = null
        job.fallback = null
        slot.worker.unref()
      }
      signal?.addEventListener('abort', job.onAbort, { once: true })
      if (signal?.aborted) {
        job.onAbort()
        this.complete(slot, { fallback: true })
        return
      }
      job.timer = setTimeout(() => this.retire(slot), CODEC_LIMITS.jobTimeoutMs)
      job.timer.unref?.()
      slot.worker.ref()
      try {
        slot.worker.postMessage(message, transfer)
      } catch {
        this.retire(slot)
      }
    })
  }

  complete(slot, message) {
    const job = slot.job
    if (!job) return
    slot.job = null
    clearTimeout(job.timer)
    job.signal?.removeEventListener('abort', job.onAbort)
    this.reservedBytes -= job.bytes
    slot.worker.unref()
    if (!job.resolve) return
    try {
      job.resolve(message?.fallback ? job.fallback() : job.convert(message.value))
    } catch (error) {
      job.reject(error)
    }
  }

  retire(slot) {
    if (slot.retired) return
    slot.retired = true
    this.restartAt = Date.now() + CODEC_LIMITS.restartDelayMs
    slot.retirement = Promise.resolve(slot.worker.terminate())
      .catch(() => {})
      .then(() => {
        this.complete(slot, { fallback: true })
        this.slots.delete(slot)
      })
  }

  async close() {
    this.closed = true
    await Promise.all(
      [...this.slots].map(async (slot) => {
        this.retire(slot)
        await slot.retirement
      }),
    )
  }
}

export const inferenceCodec = new InferenceCodec()
