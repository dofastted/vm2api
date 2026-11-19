import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const MB = 1024 * 1024
const blocks = (message) => (Array.isArray(message?.content) ? message.content : [])
const isCall = (b) => b?.type === 'tool_use'
const isResult = (b) => b?.type === 'tool_result'
const unique = (ids) => ids.every((id) => typeof id === 'string' && id.length) && new Set(ids).size === ids.length

// Hash public messages in order without retaining transcript text. Object key
// order is immaterial; plain text and its single-block representation agree.
function appendMessage(hash, message) {
  // Breakpoints move between turns. Ignore only the protocol block's own
  // marker in this hash view; tool input and result data are semantic.
  if (blocks(message).some((b) => b?.type && Object.hasOwn(b, 'cache_control'))) {
    message = {
      ...message,
      content: message.content.map((b) => {
        if (!b?.type || !Object.hasOwn(b, 'cache_control')) return b
        const { cache_control, ...semantic } = b
        return semantic
      }),
    }
  }
  const content = message?.content
  if (
    Array.isArray(content) &&
    content.length === 1 &&
    content[0]?.type === 'text' &&
    Object.keys(content[0]).length === 2 &&
    typeof content[0].text === 'string'
  ) {
    message = { ...message, content: content[0].text }
  }
  const json = JSON.stringify(message, (_, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  )
  hash.update(json).update('\n')
}

function frequencies(messages) {
  const uses = new Map(),
    results = new Map()
  for (const msg of messages)
    for (const b of blocks(msg)) {
      const table = isCall(b) ? uses : isResult(b) ? results : null
      if (table) {
        const id = isCall(b) ? b.id : b.tool_use_id
        table.set(id, (table.get(id) || 0) + 1)
      }
    }
  return { uses, results }
}

// Multiple replies to the very same history are possible (branches/retries).
// An unchanged vector of issued IDs wins; never guess among matching branches.
function resolveBatch(variants, echo, next, { uses, results }) {
  const ids = echo.map((b) => b.id)
  if (!unique(ids) || ids.some((id) => uses.get(id) !== 1)) return null
  if (next?.role !== 'user') return null
  const refs = blocks(next)
    .filter(isResult)
    .map((b) => b.tool_use_id)
  if (refs.length !== ids.length || !unique(refs) || ids.some((id) => !refs.includes(id) || results.get(id) !== 1))
    return null
  const candidates = variants.map((json) => JSON.parse(json))
  const exact = candidates.filter((batch) => batch.length === ids.length && batch.every((b, i) => b.id === ids[i]))
  if (exact.length) return exact.length === 1 ? exact[0] : null
  const issuedIds = new Set(candidates.flat().map((b) => b.id))
  const matches = candidates.filter(
    (batch) =>
      batch.length === ids.length &&
      batch.every(
        (b, i) =>
          b.name === echo[i].name &&
          isDeepStrictEqual(b.input, echo[i].input) &&
          (b.id === ids[i] || (!issuedIds.has(ids[i]) && !uses.has(b.id) && !results.has(b.id))),
      ),
  )
  return matches.length === 1 ? matches[0] : null
}

export function createIssuedToolReplay() {
  // Evict whole prefix buckets, never just one alternative of an ambiguous match.
  const records = new Map()
  let retained = 0
  function remember(scope, messages, content) {
    if (!scope || !Array.isArray(messages) || !Array.isArray(content)) return
    const calls = content.filter(isCall)
    if (
      !calls.length ||
      !unique(calls.map((b) => b.id)) ||
      calls.some(
        (b) =>
          typeof b.name !== 'string' ||
          !b.name ||
          !b.input ||
          typeof b.input !== 'object' ||
          Array.isArray(b.input) ||
          Object.hasOwn(b, '_inputJson'),
      )
    )
      return
    try {
      const prefix = createHash('sha256').update(scope).update('\n')
      for (const message of messages) appendMessage(prefix, message)
      const key = prefix.digest('hex')
      const batch = JSON.stringify(calls)
      const bytes = Buffer.byteLength(batch)
      if (bytes > MB) return
      const bucket = records.get(key) || { variants: [], bytes: 0 }
      if (bucket.variants === null || bucket.variants.includes(batch)) return
      if (bucket.variants.length >= 8) {
        retained -= bucket.bytes
        bucket.bytes = 0
        bucket.variants = null // Saturated prefix: do not let the last reply win.
      } else {
        bucket.variants.push(batch)
        bucket.bytes += bytes
        retained += bytes
      }
      records.delete(key)
      records.set(key, bucket)
      while (records.size > 512 || retained > 16 * MB) {
        const oldest = records.keys().next().value
        retained -= records.get(oldest).bytes
        records.delete(oldest)
      }
    } catch {
      // Deep/unserializable public history is ineligible; never fail delivery for replay.
    }
  }
  function restore(scope, body) {
    const messages = body?.messages
    if (
      !scope ||
      !records.size ||
      !Array.isArray(messages) ||
      !messages.some((m) => m?.role === 'assistant' && blocks(m).some(isCall))
    )
      return body
    const prefix = createHash('sha256').update(scope).update('\n')
    const counts = frequencies(messages)
    let out
    try {
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        const echo = msg?.role === 'assistant' ? blocks(msg).filter(isCall) : []
        const variants = echo.length && records.get(prefix.copy().digest('hex'))?.variants
        const next = messages[i + 1]
        const batch = variants && resolveBatch(variants, echo, next, counts)
        if (batch) {
          out ??= messages.slice()
          const aliases = new Map()
          let n = 0
          out[i] = {
            ...msg,
            content: msg.content.map((block) => {
              if (!isCall(block)) return block
              const issued = batch[n++]
              if (issued.id !== block.id) aliases.set(block.id, issued.id)
              // The snapshot owns the call, not this request's cache breakpoint.
              if (Object.hasOwn(block, 'cache_control')) issued.cache_control = block.cache_control
              else delete issued.cache_control
              return issued
            }),
          }
          if (aliases.size)
            out[i + 1] = {
              ...next,
              content: next.content.map((block) =>
                isResult(block) && aliases.has(block.tool_use_id)
                  ? { ...block, tool_use_id: aliases.get(block.tool_use_id) }
                  : block,
              ),
            }
        }
        // Later replies were keyed on prior *public* messages, including client aliases.
        appendMessage(prefix, msg)
      }
    } catch {
      return body
    }
    return out ? { ...body, messages: out } : body
  }
  return { remember, restore }
}
