import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRedactionClient } from './client.mjs'
import { normalizeRedaction } from './policy.mjs'

const disabled = {
  enabled: false,
  ready: true,
  policy: null,
  error: null,
}

let state = disabled
let boot = null

function unavailable(message, code = 'redaction_unavailable', status = 503) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

export function redactionStatus() {
  return {
    enabled: state.enabled === true,
    ready: state.ready === true,
    error: state.error || null,
  }
}

export function publishRedactionForTests(next) {
  state = next || disabled
  boot = null
}

function policyView(policy) {
  return {
    secrets: policy.secrets,
    personal: policy.personal,
    words: policy.words,
    wordsAnyCase: policy.wordsAnyCase === true,
    rules: policy.rules,
    kinds: policy.kinds || {},
    allow: policy.allow || [],
  }
}

async function waitForFile(file, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim()
      if (text) return text
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw unavailable('redaction helper did not publish a capability')
}

function startHelper({ bin, directory }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const sock = path.join(directory, 'kin-redact.sock')
  const key = path.join(directory, 'redact.key')
  const capabilityFile = path.join(directory, 'capability')
  for (const file of [sock, capabilityFile]) {
    try {
      fs.rmSync(file, { force: true })
    } catch {}
  }
  const child = spawn(bin, ['-sock', sock, '-key', key, '-capability', capabilityFile], {
    stdio: 'ignore',
  })
  return { child, sock, capabilityFile }
}

export async function ensureRedaction(routing, { projectRoot, binPath } = {}) {
  let policy
  try {
    policy = normalizeRedaction(routing?.redaction)
  } catch (error) {
    state = { enabled: true, ready: false, policy: null, error: error.code || 'invalid_redaction_config' }
    throw error
  }
  if (!policy.enabled) {
    state = { ...disabled, policy }
    return state
  }
  if (state.ready && state.enabled && JSON.stringify(state.policy) === JSON.stringify(policy) && state.client) {
    return state
  }
  if (!boot) {
    boot = bootHelper(policy, { projectRoot, binPath }).finally(() => {
      boot = null
    })
  }
  return boot
}

async function bootHelper(policy, { projectRoot, binPath }) {
  const bundled = path.join(projectRoot || '', 'bin', 'kin-redact')
  const bin = binPath || process.env.KIN_REDACT_BIN || (fs.existsSync(bundled) ? bundled : '')
  if (!bin || !fs.existsSync(bin)) {
    state = { enabled: true, ready: false, policy, client: null, error: 'redaction_unavailable' }
    throw unavailable('redaction helper is not installed')
  }
  const directory = path.join(projectRoot || os.tmpdir(), 'data', 'redact')
  const helper = startHelper({ bin, directory })
  try {
    const capability = await waitForFile(helper.capabilityFile)
    const client = createRedactionClient({ socketPath: helper.sock, capability })
    await client.health()
    await client.validate({ policy: policyView(policy) })
    state = { enabled: true, ready: true, policy, client, child: helper.child, error: null }
    return state
  } catch (error) {
    helper.child.kill()
    state = { enabled: true, ready: false, policy, client: null, error: 'redaction_unavailable' }
    throw error.status ? error : unavailable(error.message || 'redaction helper failed')
  }
}

function identityOf(ctx = {}) {
  const principal = String(ctx.principal || ctx.redactionPrincipal || '').trim()
  const session = String(ctx.session || ctx.redactionSession || '').trim()
  if (!principal) throw unavailable('redaction principal is missing')
  return { principal, session }
}

export async function maskJson(value, ctx = {}) {
  if (!state.enabled) return value
  if (!state.ready || !state.client) throw unavailable('redaction helper is not ready')
  const { principal, session } = identityOf(ctx)
  const { body } = await state.client.mask({
    principal,
    session,
    policy: policyView(state.policy),
    body: JSON.stringify(value),
  })
  return JSON.parse(body)
}

export async function restoreJsonText(text, ctx = {}) {
  if (!state.enabled || text == null) return text
  if (!state.ready || !state.client) throw unavailable('redaction helper is not ready')
  const { principal, session } = identityOf(ctx)
  const { body } = await state.client.restore({
    principal,
    session,
    policy: policyView(state.policy),
    body: String(text),
    codec: 'json',
  })
  return body
}

export async function restoreJsonValue(value, ctx = {}) {
  if (!state.enabled || value == null || typeof value !== 'object') return value
  const text = await restoreJsonText(JSON.stringify(value), ctx)
  return JSON.parse(text)
}

export async function restoreSseLine(line, ctx = {}) {
  if (!state.enabled || typeof line !== 'string' || !line.startsWith('data:')) return line
  const piece = line.slice(5).trim()
  if (!piece || piece === '[DONE]') return line
  const restored = await restoreJsonText(piece, ctx)
  return `data: ${restored}`
}

const TEXT_FIELDS = [
  ['delta', 'text'],
  ['delta', 'thinking'],
  ['delta', 'partial_json'],
]

/** Suffix that can only be the start of a {{R_KIND_<26>}} tag. */
export function incompleteTagTail(text) {
  const at = String(text).lastIndexOf('{{')
  if (at < 0) return ''
  const tail = String(text).slice(at)
  if (tail.length > 128 || tail.includes('}}')) return ''
  if (/^\{\{R_[A-Z][A-Z0-9_]{0,23}(?:_[a-z2-7]{0,25})?$/.test(tail)) return tail
  return ''
}

/**
 * Restores one SSE data line. A tag split across two events of the same block
 * and field is held, then prepended to the next event. Other fields keep their own tail.
 */
export function createSseRestorer(ctx) {
  const carry = new Map()
  return {
    async line(line) {
      if (!state.enabled || typeof line !== 'string' || !line.startsWith('data:')) return line
      const piece = line.slice(5).trim()
      if (!piece || piece === '[DONE]') return line
      let event
      try {
        event = JSON.parse(piece)
      } catch {
        return line
      }
      const index = event.index ?? 0
      for (const [parent, field] of TEXT_FIELDS) {
        const holder = event[parent]
        if (!holder || typeof holder[field] !== 'string') continue
        const key = `${index}:${parent}.${field}`
        let text = `${carry.get(key) || ''}${holder[field]}`
        const tail = incompleteTagTail(text)
        if (tail) {
          carry.set(key, tail)
          text = text.slice(0, -tail.length)
        } else {
          carry.delete(key)
        }
        holder[field] = text
      }
      const restored = await restoreJsonText(JSON.stringify(event), ctx)
      return `data: ${restored}`
    },
  }
}
