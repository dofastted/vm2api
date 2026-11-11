import { parentPort } from 'node:worker_threads'
import { encodeInferenceJson, inspectCodecValue, parseWorkerJson } from './inference-codec-json.mjs'

parentPort.on('message', ({ operation, value, resultBytes, status }) => {
  try {
    if (operation === 'encode') {
      const encoded = encodeInferenceJson(value)
      if (encoded.length > resultBytes) {
        parentPort.postMessage({ fallback: true })
        return
      }
      const bytes =
        encoded.byteOffset === 0 && encoded.byteLength === encoded.buffer.byteLength
          ? encoded
          : Uint8Array.from(encoded)
      parentPort.postMessage({ value: bytes }, [bytes.buffer])
      return
    }
    const parsed = parseWorkerJson(Buffer.from(value.buffer, value.byteOffset, value.byteLength), status)
    if (!inspectCodecValue(parsed, resultBytes)) {
      parentPort.postMessage({ fallback: true })
      return
    }
    parentPort.postMessage({ value: parsed })
  } catch {
    parentPort.postMessage({ fallback: true })
  }
})
