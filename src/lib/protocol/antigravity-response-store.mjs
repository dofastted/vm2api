import crypto from 'node:crypto'

/** Responses continuations are private to the API key and tenant, bounded and process-local. */
export function antigravityResponseScope(req) {
  const identity = req?.apiKeyRecord?.id || (req?.apiKeyKind === 'master' ? 'master' : null)
  if (!identity) return null
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([identity, req?.apiKeyRecord?.user_id || null]))
    .digest('hex')
}

export function createAntigravityResponseStore({
  ttlMs = 30 * 60_000,
  maxEntries = 1000,
  maxBytes = 32 * 1024 * 1024,
  maxEntryBytes = 4 * 1024 * 1024,
  now = Date.now,
} = {}) {
  const entries = new Map()
  let bytes = 0
  function drop(id) {
    const old = entries.get(id)
    if (old) bytes -= old.bytes
    entries.delete(id)
  }
  function sweep() {
    for (const [id, row] of entries) if (row.expiresAt <= now()) drop(id)
  }
  return {
    put(id, { scope, model, messages, content, vmId }) {
      if (!scope || !id) return false
      sweep()
      const history = [...messages, { role: 'assistant', content }]
      const encoded = JSON.stringify(history)
      const size = Buffer.byteLength(encoded)
      if (size > maxEntryBytes || size > maxBytes) return false
      drop(id)
      while (entries.size >= maxEntries || bytes + size > maxBytes) drop(entries.keys().next().value)
      entries.set(id, { scope, model, messages: JSON.parse(encoded), vmId, bytes: size, expiresAt: now() + ttlMs })
      bytes += size
      return true
    },
    get(id, { scope, model } = {}) {
      sweep()
      const row = entries.get(id)
      if (!row || !scope || row.scope !== scope || (model && row.model !== model)) return null
      return { messages: structuredClone(row.messages), vmId: row.vmId, expiresAt: row.expiresAt }
    },
    clear() {
      entries.clear()
      bytes = 0
    },
    get size() {
      sweep()
      return entries.size
    },
  }
}

export const antigravityResponseStore = createAntigravityResponseStore()
