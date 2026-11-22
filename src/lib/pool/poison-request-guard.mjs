/**
 * Quarantine for a conversation whose request keeps making the slot's CLI go silent.
 *
 * The kernel's job watchdog cancels a job after 180s without one CLI frame
 * ("job idle timeout: no CLI frame"). When the cause is the request itself, every
 * retry of that conversation hangs the same 180s: Claude Code retries on its own
 * every few minutes, each retry takes a kernel job and, left alone, the per-VM
 * circuit eventually takes the whole VM out of routing.
 *
 * This remembers, per client session, the message prefix that went silent. After
 * `threshold` such timeouts, requests that start with that same prefix are refused
 * at once with a clear, non-retryable error for `quarantineMs`. Rewinding to before
 * the failing turn or starting a new conversation changes the prefix and passes.
 * Nothing here depends on knowing why the request hangs. Each failure also logs the
 * request's structure (kinds and sizes, never content) so the cause can be found.
 *
 * The same silence can be a property of the slot rather than of one conversation: on one
 * slot every session went quiet once its prompt passed roughly 54k tokens, on both Opus and
 * Sonnet, while other slots served far larger prompts. So failures are also tracked per VM.
 * When `vmSessions` different sessions went silent on one VM within the window, the smallest
 * request size that did becomes that VM's ceiling: larger requests are kept off it (served by
 * another seat, or refused when there is none) until a request at that size succeeds there or
 * the quarantine time passes and a probe is let through.
 *
 * The ceiling is evidence, so it is bounded by evidence in both directions. It is the smallest size
 * that went silent, but never below the largest request this VM answered inside the window: two
 * sessions that go quiet for a size-independent reason (an upstream incident) must not close the VM
 * to traffic it has just been shown to serve. And once learned it is fixed for the quarantine; later
 * failures do not push it further down.
 */

import crypto from 'node:crypto'

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/
const LARGEST_BLOCKS = 5
const LAST_MESSAGES = 4

const digest = (value) =>
  crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : (JSON.stringify(value) ?? ''))
    .digest('hex')
    .slice(0, 16)

/** One short hash per message, so a longer conversation can be matched by its prefix. */
export function requestBytes(body) {
  return Buffer.byteLength(JSON.stringify(body) ?? '')
}

export function messageDigests(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : null
  return messages?.length ? messages.map(digest) : null
}

function startsWith(longer, prefix) {
  if (longer.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i += 1) if (longer[i] !== prefix[i]) return false
  return true
}

function textsOf(block) {
  if (typeof block === 'string') return [block]
  const out = []
  if (typeof block?.text === 'string') out.push(block.text)
  const inner = block?.content
  if (typeof inner === 'string') out.push(inner)
  else if (Array.isArray(inner)) for (const part of inner) out.push(...textsOf(part))
  return out
}

function describeBlock(block) {
  if (typeof block === 'string') return { type: 'text', bytes: Buffer.byteLength(block) }
  const type = typeof block?.type === 'string' ? block.type : 'unknown'
  const info = { type, bytes: Buffer.byteLength(JSON.stringify(block) ?? '') }
  if (type === 'tool_use') info.name = String(block.name || '').slice(0, 64)
  if (type === 'image' || type === 'document') info.media_type = block.source?.media_type
  if (type === 'tool_result') {
    const inner = block.content
    info.result_kinds = Array.isArray(inner) ? inner.map((part) => part?.type || 'unknown') : [typeof inner]
    if (block.is_error) info.is_error = true
  }
  return info
}

/** Sizes, kinds and a few character-class flags of a request. Never any text or tool input. */
export function describeRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const flags = {}
  const blocks = []
  const perMessage = messages.map((message, index) => {
    const content = typeof message?.content === 'string' ? [message.content] : message?.content
    const described = (Array.isArray(content) ? content : []).map((block) => {
      for (const text of textsOf(block)) {
        if (CONTROL_CHARS.test(text)) flags.control_chars = true
        if (LONE_SURROGATE.test(text)) flags.lone_surrogates = true
      }
      const info = describeBlock(block)
      blocks.push({ msg_index: index, ...info })
      return info
    })
    return { role: message?.role, blocks: described }
  })
  const largest = [...blocks]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, LARGEST_BLOCKS)
    .map(({ msg_index, type, bytes, name, media_type }) => ({
      msg_index,
      type,
      bytes,
      ...(name ? { name } : {}),
      ...(media_type ? { media_type } : {}),
    }))
  return {
    bytes: Buffer.byteLength(JSON.stringify(body) ?? ''),
    messages: messages.length,
    system_bytes: body?.system == null ? 0 : Buffer.byteLength(JSON.stringify(body.system)),
    tools: Array.isArray(body?.tools) ? body.tools.length : 0,
    model: typeof body?.model === 'string' ? body.model : undefined,
    flags,
    largest_blocks: largest,
    last_messages: perMessage.slice(-LAST_MESSAGES),
  }
}

export class PoisonRequestGuard {
  constructor({
    threshold = 2,
    windowMs = 30 * 60_000,
    quarantineMs = 10 * 60_000,
    vmSessions = 2,
    maxEntries = 256,
    now = Date.now,
    logger = console,
  } = {}) {
    this.threshold = Number(threshold) || 0
    this.windowMs = Number(windowMs) || 0
    this.quarantineMs = Number(quarantineMs) || 0
    this.vmSessions = Math.max(1, Number(vmSessions) || 2)
    this.maxEntries = Math.max(1, Number(maxEntries) || 256)
    this.now = now
    this.logger = logger
    this.entries = new Map()
    this.vms = new Map()
    // Largest request each VM answered recently. Kept apart from the failure records because the proof
    // usually comes first: the VM served a 50 KB request, then went quiet.
    this.served = new Map()
  }

  get enabled() {
    return this.threshold > 0 && this.quarantineMs > 0
  }

  /** @returns {{ until: number, retryAfterSec: number, failures: number, request: object } | null} */
  check(sessionKey, body) {
    if (!this.enabled || !sessionKey) return null
    const entry = this.entries.get(sessionKey)
    if (!entry) return null
    const now = this.now()
    if (entry.until <= now) {
      // Quarantine over. Keep the record so one more failure re-quarantines at once,
      // but forget it when nothing failed for a whole window.
      if (now - entry.lastAt > this.windowMs) this.entries.delete(sessionKey)
      return null
    }
    const digests = messageDigests(body)
    if (!digests || !startsWith(digests, entry.digests)) return null
    return {
      until: entry.until,
      retryAfterSec: Math.max(1, Math.ceil((entry.until - now) / 1000)),
      failures: entry.count,
      request: entry.request,
    }
  }

  /** A hop on this session ended in a silent CLI timeout. */
  recordSilentTimeout(sessionKey, body, context = {}) {
    if (!this.enabled || !sessionKey) return null
    const digests = messageDigests(body)
    if (!digests) return null
    const now = this.now()
    const vmCeiling = this.recordVmFailure(context.vm_id, sessionKey, body, now)
    const prev = this.entries.get(sessionKey)
    const related = !!prev && now - prev.lastAt <= this.windowMs && startsWith(digests, prev.digests)
    const count = related ? prev.count + 1 : 1
    const quarantined = count >= this.threshold
    const request = describeRequest(body)
    this.entries.delete(sessionKey)
    this.entries.set(sessionKey, {
      digests,
      count,
      firstAt: related ? prev.firstAt : now,
      lastAt: now,
      until: quarantined ? now + this.quarantineMs : 0,
      request,
    })
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value)
    this.logger.warn(
      `[poison-request] ${JSON.stringify({
        session: sessionKey,
        failures: count,
        quarantined,
        quarantine_ms: quarantined ? this.quarantineMs : 0,
        ...(vmCeiling ? { vm_ceiling_bytes: vmCeiling } : {}),
        ...context,
        request,
      })}`,
    )
    return { count, quarantined }
  }

  /** Track a silent timeout against its VM; returns the VM's ceiling in bytes when one is in force. */
  recordVmFailure(vmId, sessionKey, body, now) {
    if (!vmId) return null
    const bytes = requestBytes(body)
    const prev = this.vms.get(vmId)
    const recent = (prev?.failures || []).filter((f) => now - f.at <= this.windowMs)
    recent.push({ session: sessionKey, bytes, at: now })
    const floor = this.provenBytes(vmId, now)
    const quarantined = !!prev?.ceiling && prev.until > now
    const confirmed = !!prev?.ceiling && prev.until <= now && bytes >= prev.ceiling // a learned ceiling, confirmed again
    const sessions = new Set(recent.map((f) => f.session))
    let ceiling = prev?.ceiling || 0
    let until = prev?.until || 0
    if (quarantined) {
      // Already refusing at this size: more failures do not move the ceiling, and do not extend the quarantine.
    } else if (confirmed) {
      until = now + this.quarantineMs
    } else if (sessions.size >= this.vmSessions) {
      ceiling = Math.max(floor, Math.min(...recent.map((f) => f.bytes)))
      until = now + this.quarantineMs
    }
    this.vms.delete(vmId)
    this.vms.set(vmId, {
      failures: recent.slice(-16),
      ceiling,
      until,
      lastAt: now,
    })
    while (this.vms.size > this.maxEntries) this.vms.delete(this.vms.keys().next().value)
    return until > now ? ceiling : null
  }

  /** Largest request this VM answered inside the window, 0 when there is no recent proof. */
  provenBytes(vmId, now = this.now()) {
    const served = this.served.get(vmId)
    return served && now - served.at <= this.windowMs ? served.bytes : 0
  }

  /** VMs that should not receive a request of this size right now. */
  refusedVms(body) {
    if (!this.enabled || !this.vms.size) return []
    const now = this.now()
    let bytes = null
    const out = []
    for (const [vmId, entry] of this.vms) {
      if (!entry.ceiling || entry.until <= now) continue
      bytes ??= requestBytes(body)
      if (bytes >= entry.ceiling) {
        out.push({
          vmId,
          ceilingBytes: entry.ceiling,
          requestBytes: bytes,
          retryAfterSec: Math.max(1, Math.ceil((entry.until - now) / 1000)),
        })
      }
    }
    return out
  }

  /** A hop succeeded. On a VM with a ceiling, a success at or above it proves the VM can answer again. */
  recordSuccess(sessionKey, { vmId = null, bytes = null, body = null } = {}) {
    if (sessionKey) this.entries.delete(sessionKey)
    if (!vmId) return
    const size = bytes ?? (body ? requestBytes(body) : null)
    if (size == null) return
    const now = this.now()
    const entry = this.vms.get(vmId)
    if (entry?.ceiling && size >= entry.ceiling) this.vms.delete(vmId)
    // The floor for any ceiling learned later. A bigger success replaces it; a smaller one only refreshes
    // it when the old proof has already aged out, so a lone small request cannot erase a larger proof.
    const keep = this.provenBytes(vmId, now)
    if (size >= keep) {
      this.served.delete(vmId)
      this.served.set(vmId, { bytes: size, at: now })
      while (this.served.size > this.maxEntries) this.served.delete(this.served.keys().next().value)
    }
  }

  snapshot() {
    return [...this.entries].map(([session, e]) => ({
      session,
      failures: e.count,
      until: e.until,
      last_at: e.lastAt,
      request: e.request,
    }))
  }
}
