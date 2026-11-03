import { createHash, createHmac, randomBytes } from 'node:crypto'

const MARKER = '\n\n[... tool result middle pruned ...]\n\n'
const SCOPE_SECRET = randomBytes(32)
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_MESSAGES = 8192

/** A request id is normally ephemeral; only DSH's explicit session UUID is stable. */
export function dshPruneScope({ headers = {}, apiKey } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  const ua = lower['user-agent']
  const session = lower['x-client-request-id']
  if (
    typeof apiKey !== 'string' ||
    !apiKey ||
    apiKey.length > 8192 ||
    typeof ua !== 'string' ||
    !/^deepseek-harness\/\S+(?:\s|$)/i.test(ua) ||
    typeof session !== 'string' ||
    !SESSION_ID.test(session)
  )
    return null
  return createHmac('sha256', SCOPE_SECRET).update(apiKey).update('\0').update(session.toLowerCase()).digest('hex')
}

function withoutMarker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const { cache_control: _marker, ...rest } = value
  return rest
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest()
}

function messageHash(message) {
  return hash({
    ...message,
    ...(Array.isArray(message?.content) ? { content: message.content.map(withoutMarker) } : {}),
  })
}

function headerHash(body) {
  const {
    messages: _messages,
    max_tokens: _max,
    stream: _stream,
    metadata: _metadata,
    cache_control: _marker,
    ...header
  } = body
  if (Array.isArray(header.system)) header.system = header.system.map(withoutMarker)
  if (Array.isArray(header.tools)) header.tools = header.tools.map(withoutMarker)
  return hash(header)
}

function texts(content) {
  if (typeof content === 'string') return [content]
  if (
    !Array.isArray(content) ||
    !content.length ||
    content.some(
      (block) =>
        !block ||
        block.type !== 'text' ||
        typeof block.text !== 'string' ||
        Object.keys(block).some((key) => key !== 'type' && key !== 'text'),
    )
  )
    return null
  return content.map((block) => block.text)
}

function prunedContent(content) {
  const strings = texts(content)
  if (!strings) return null
  const points = strings.map((text) => Array.from(text))
  const total = points.reduce((sum, part) => sum + part.length, 0)
  if (total <= 8192) return null
  const end = total - 1024
  let consumed = 0
  let marked = false
  const pruned = points.flatMap((part) => {
    const headEnd = Math.min(part.length, Math.max(0, 4096 - consumed))
    const tailStart = Math.min(part.length, Math.max(0, end - consumed))
    const marker = consumed < end && consumed + part.length > 4096 && !marked ? MARKER : ''
    if (marker) marked = true
    consumed += part.length
    const text = part.slice(0, headEnd).join('') + marker + part.slice(tailStart).join('')
    return text ? [{ type: 'text', text }] : []
  })
  return typeof content === 'string' ? pruned[0].text : pruned
}

function recordsOf(body, maxTextBytes, maxEntryBytes) {
  const calls = new Set()
  const results = new Set()
  const records = []
  let bytes = body.messages.length * 32 + 288
  for (const [message, entry] of body.messages.entries()) {
    if (!Array.isArray(entry?.content)) continue
    for (const [part, block] of entry.content.entries()) {
      if (entry.role === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string') {
        if (calls.has(block.id)) return null
        calls.add(block.id)
      }
      if (block?.type !== 'tool_result') continue
      const id = block.tool_use_id
      if (typeof id !== 'string' || !id || results.has(id)) return null
      results.add(id)
      if (entry.role !== 'user' || !calls.has(id)) continue
      const strings = texts(block.content)
      if (!strings || strings.reduce((sum, text) => sum + text.length, 0) <= 8192) continue
      if (strings.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > maxTextBytes) continue
      const raw = Buffer.from(JSON.stringify(block.content))
      if (raw.length > maxTextBytes || prunedContent(block.content) === null) continue
      bytes += raw.length + Buffer.byteLength(id) + 128
      if (bytes > maxEntryBytes) return null
      records.push({ message, part, id, raw })
    }
  }
  return records
}

function snapshot(body, maxTextBytes, maxEntryBytes) {
  const records = recordsOf(body, maxTextBytes, maxEntryBytes)
  if (!records) return null
  const hashes = Buffer.concat(body.messages.map(messageHash))
  const header = headerHash(body)
  const bytes =
    hashes.length +
    header.length +
    records.reduce((sum, record) => sum + record.raw.length + Buffer.byteLength(record.id) + 128, 0) +
    256
  return { records, hashes, header, length: body.messages.length, bytes }
}

function samePrefix(previous, body) {
  if (body.messages.length < previous.length || !headerHash(body).equals(previous.header)) return false
  return body.messages
    .slice(0, previous.length)
    .every((message, index) => messageHash(message).equals(previous.hashes.subarray(index * 32, (index + 1) * 32)))
}

function restore(previous, body) {
  if (!previous || body.messages.length < previous.length || !headerHash(body).equals(previous.header)) {
    return { body, restored: 0, reason: previous ? 'history_changed' : 'cold' }
  }
  let messages = null
  let restored = 0
  for (const saved of previous.records) {
    const message = (messages || body.messages)[saved.message]
    const block = message?.content?.[saved.part]
    if (block?.type !== 'tool_result' || block.tool_use_id !== saved.id) continue
    const original = JSON.parse(saved.raw.toString())
    const expected = prunedContent(original)
    if (expected === null || JSON.stringify(block.content) !== JSON.stringify(expected)) continue
    messages ??= body.messages.slice()
    const content = message.content.slice()
    content[saved.part] = { ...block, content: original }
    messages[saved.message] = { ...message, content }
    restored++
  }
  if (!restored) return { body, restored: 0, reason: 'unchanged' }
  const candidate = { ...body, messages }
  // A marker in genuinely edited history is not permission to resurrect old text.
  return samePrefix(previous, candidate)
    ? { body: candidate, restored, reason: 'restored' }
    : { body, restored: 0, reason: 'history_changed' }
}

function unpricedBlocks(content) {
  if (typeof content === 'string') return false
  if (!Array.isArray(content)) return true
  return content.some((block) => {
    if (!block || typeof block !== 'object') return true
    if (block.type === 'tool_result') return unpricedBlocks(block.content)
    return !['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type)
  })
}

function containsUnpricedContent(messages) {
  return messages.some((message) => unpricedBlocks(message?.content))
}

function fitsContext(previous, body, contextWindow, headroomTokens) {
  if (!previous?.inputTokens || !Number.isFinite(contextWindow) || contextWindow <= 0) return false
  const tail = body.messages.slice(previous.length)
  // Images, documents and other expanded content have no byte-based token upper bound.
  if (containsUnpricedContent(tail)) return false
  const added = Buffer.byteLength(JSON.stringify(tail))
  const output = Number(body.max_tokens)
  if (!Number.isFinite(output) || output <= 0) return false
  return previous.inputTokens + previous.outputTokens + added + output + headroomTokens <= contextWindow
}

function noop(body, reason) {
  return { body, restored: 0, reason, commit() {}, rollback() {} }
}

function scanWithinBudget(body) {
  let left = 8 * 1024 * 1024
  const visit = (value, depth) => {
    if (depth > 64 || left < 0) return false
    if (typeof value === 'string') left -= Buffer.byteLength(value) + 2
    else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        left -= Buffer.byteLength(key) + 4
        if (!visit(value[key], depth + 1)) return false
      }
    } else left -= 16
    return left >= 0
  }
  return visit(body, 0)
}

/** Bounded, process-local original text; only terminally verified requests seed it. */
export class ToolResultPruneCache {
  constructor({
    ttlMs = 3600000,
    maxBytes = 16 * 1024 * 1024,
    maxEntryBytes = 2 * 1024 * 1024,
    maxTextBytes = 256 * 1024,
    maxSessions = 128,
    maxPending = 20,
    headroomTokens = 16384,
    clock = Date.now,
  } = {}) {
    Object.assign(this, {
      ttlMs,
      maxBytes,
      maxEntryBytes,
      maxTextBytes,
      maxSessions,
      maxPending,
      headroomTokens,
      clock,
    })
    this.entries = new Map()
    this.locks = new Set()
    this.bytes = 0
    this.pendingBytes = 0
  }

  stats() {
    return { entries: this.entries.size, bytes: this.bytes + this.pendingBytes, pending: this.locks.size }
  }

  remove(key) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.bytes -= entry.bytes
  }

  sweep(now) {
    for (const [key, entry] of this.entries) if (!this.locks.has(key) && now - entry.at >= this.ttlMs) this.remove(key)
  }

  prepare({ scope, body, contextWindow, maxBodyBytes = 128 * 1024 * 1024 } = {}) {
    if (
      typeof scope !== 'string' ||
      !scope.trim() ||
      typeof body?.model !== 'string' ||
      !body.model.trim() ||
      !Array.isArray(body.messages) ||
      body.messages.length > MAX_MESSAGES ||
      !body.messages.length
    )
      return noop(body, 'unscoped')
    if (!scanWithinBudget(body)) return noop(body, 'scan_budget')
    const now = this.clock()
    this.sweep(now)
    const key = `${scope}:${body.model}`
    if (this.locks.has(key) || this.locks.size >= this.maxPending) return noop(body, 'concurrent')
    const previous = this.entries.get(key)
    const live = previous && now - previous.at < this.ttlMs ? previous : null
    let prepared = restore(live, body)
    if (prepared.restored) {
      if (!fitsContext(live, prepared.body, contextWindow, this.headroomTokens))
        prepared = { body, restored: 0, reason: 'context_budget' }
      else if (Buffer.byteLength(JSON.stringify(prepared.body)) > maxBodyBytes)
        prepared = { body, restored: 0, reason: 'body_budget' }
    }
    const candidate = snapshot(prepared.body, this.maxTextBytes, this.maxEntryBytes)
    if (!candidate || candidate.bytes > this.maxEntryBytes) return noop(body, 'entry_budget')
    // Reservations count both the old baseline and the pending immutable snapshot.
    while (
      this.bytes + this.pendingBytes + candidate.bytes > this.maxBytes ||
      this.entries.size +
        [...this.locks].filter((pending) => !this.entries.has(pending)).length +
        (this.entries.has(key) ? 0 : 1) >
        this.maxSessions
    ) {
      const victim = [...this.entries.keys()].find((entryKey) => entryKey !== key && !this.locks.has(entryKey))
      if (!victim) return noop(body, 'memory_budget')
      this.remove(victim)
    }
    this.locks.add(key)
    this.pendingBytes += candidate.bytes
    let settled = false
    const release = () => {
      if (settled) return false
      settled = true
      this.locks.delete(key)
      this.pendingBytes -= candidate.bytes
      return true
    }
    return {
      ...prepared,
      commit: ({ verified, inputTokens, outputTokens = 0, attemptCount = 1 } = {}) => {
        if (!release()) return
        if (
          !verified ||
          attemptCount !== 1 ||
          !Number.isFinite(inputTokens) ||
          inputTokens <= 0 ||
          !Number.isFinite(outputTokens) ||
          outputTokens < 0
        )
          return
        this.remove(key)
        // Empty snapshots invalidate older originals after genuine editing/compaction.
        if (!candidate.records.length) return
        this.entries.set(key, { ...candidate, at: this.clock(), inputTokens, outputTokens })
        this.bytes += candidate.bytes
      },
      rollback: () => {
        release()
      },
    }
  }
}
