const WORD_LIMIT = 256
const WORD_BYTES = 1024
const WORDS_BYTES = 64 * 1024
const RULE_LIMIT = 32

export function defaultRedaction() {
  return { enabled: false, secrets: true, personal: true, words: [], rules: [] }
}

function fail(message) {
  const error = new Error(message)
  error.status = 400
  error.code = 'invalid_redaction_config'
  return error
}

function cleanWords(words) {
  if (!Array.isArray(words)) throw fail('redaction.words must be a list')
  const out = []
  const seen = new Set()
  let total = 0
  for (const raw of words) {
    if (typeof raw !== 'string') throw fail('redaction.words entries must be strings')
    const word = raw.trim()
    if (!word || seen.has(word)) continue
    if (Buffer.byteLength(word) > WORD_BYTES) throw fail('redaction.words entry exceeds 1 KiB')
    total += Buffer.byteLength(word)
    if (total > WORDS_BYTES || out.length >= WORD_LIMIT) throw fail('redaction.words exceeds its limit')
    seen.add(word)
    out.push(word)
  }
  return out
}

function cleanRules(rules) {
  if (!Array.isArray(rules)) throw fail('redaction.rules must be a list')
  if (rules.length > RULE_LIMIT) throw fail('redaction.rules exceeds 32')
  return rules
    .map((rule) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw fail('redaction.rules entry is invalid')
      const kind = rule.kind == null ? '' : String(rule.kind)
      const prefix = rule.prefix == null ? '' : String(rule.prefix).trim()
      const regex = rule.regex == null ? '' : String(rule.regex).trim()
      if (prefix && regex) throw fail('a redaction rule has a prefix or a regex, not both')
      if (!prefix && !regex) return null
      return { kind, prefix, regex }
    })
    .filter(Boolean)
}

/**
 * Normalize a routing.redaction object. Missing means the default off policy.
 * Explicit garbage is rejected; it is not coerced to disabled.
 */
export function normalizeRedaction(value) {
  if (value == null) return defaultRedaction()
  if (typeof value !== 'object' || Array.isArray(value)) throw fail('redaction must be an object')
  const allowed = new Set(['enabled', 'secrets', 'personal', 'words', 'rules'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw fail(`unknown redaction field ${key}`)
  }
  if (typeof value.enabled !== 'boolean') throw fail('redaction.enabled must be boolean')
  if (typeof value.secrets !== 'boolean') throw fail('redaction.secrets must be boolean')
  if (typeof value.personal !== 'boolean') throw fail('redaction.personal must be boolean')
  const words = cleanWords(value.words || [])
  const rules = cleanRules(value.rules || [])
  if (value.enabled && !value.secrets && !value.personal && words.length === 0 && rules.length === 0) {
    throw fail('redaction.enabled requires secrets, personal, words, or rules')
  }
  return { enabled: value.enabled, secrets: value.secrets, personal: value.personal, words, rules }
}
