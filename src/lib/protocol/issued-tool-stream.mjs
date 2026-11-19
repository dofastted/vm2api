// Only replay complete public calls. The general message assembler is deliberately
// forgiving (e.g. invalid partial_json falls back to {}); that is not evidence.
export function createIssuedToolStream() {
  const open = new Set()
  const seen = new Set()
  const calls = new Map()
  let started = false
  let stopped = false
  let invalid = false
  let bytes = 0
  function observe(line) {
    if (invalid) return
    const raw = String(line).trim()
    if (!raw.startsWith('data:')) return
    try {
      const event = JSON.parse(raw.slice(5))
      const i = event.index
      if (event.type === 'ping') return
      if (event.type === 'error' || stopped) invalid = true
      else if (event.type === 'message_start') {
        invalid = started || !event.message || !!event.message.content?.length
        started = true
      } else if (!started) invalid = true
      else if (event.type === 'content_block_start') {
        const block = event.content_block
        invalid = !Number.isSafeInteger(i) || i < 0 || seen.has(i) || seen.size >= 4096 || !block?.type
        if (invalid) return
        seen.add(i)
        open.add(i)
        if (block.type === 'tool_use') {
          bytes += Buffer.byteLength(raw)
          calls.set(i, { block, chunks: [] })
        }
      } else if (event.type === 'content_block_delta') {
        invalid = !open.has(i)
        const call = calls.get(i)
        if (call) {
          const delta = event.delta
          if (delta?.type !== 'input_json_delta' || typeof delta.partial_json !== 'string') invalid = true
          else if (delta.partial_json) {
            bytes += Buffer.byteLength(delta.partial_json) + 16
            call.chunks.push(delta.partial_json)
          }
        } else if (event.delta?.type === 'input_json_delta') invalid = true
      } else if (event.type === 'content_block_stop') {
        invalid = !open.delete(i)
        const call = calls.get(i)
        if (call?.chunks.length) {
          call.block.input = JSON.parse(call.chunks.join(''))
          call.chunks = []
        }
      } else if (event.type === 'message_stop') {
        invalid = open.size !== 0
        stopped = true
      }
      if (bytes > 1024 * 1024) invalid = true
    } catch {
      // Display is independent of replay: malformed or non-JSON frames are not cached.
      invalid = true
    }
  }
  return {
    observe,
    completedContent: () =>
      stopped && !invalid && calls.size ? [...calls].sort(([a], [b]) => a - b).map(([, c]) => c.block) : null,
  }
}
