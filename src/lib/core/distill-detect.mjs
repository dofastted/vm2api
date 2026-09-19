/**
 * Distill harvest detector.
 * Runs in handleProtocol before credential / slot hop.
 * Match layers: question fingerprint, prompt needles, contest+request structure.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { ErrorType, ErrorCode, makeError } from './errors.mjs'

export const DISTILL_BLOCK_MESSAGE = '不允许蒸馏'

const HIGH_EFFORT = new Set(['high', 'xhigh', 'max'])
const CONTEST_RE = /prove that|\\boxed|\baime\b|olympiad|\bgpqa\b|which of the following|livecodebench|amc[_\s-]?aime/i

export const DEFAULT_DISTILL_RULES = {
  enabled: true,
  skip_official: true,
  skip_zero: true,
  error: {
    status: 403,
    type: ErrorType.PERMISSION,
    code: ErrorCode.DISTILL_BLOCKED,
    message: DISTILL_BLOCK_MESSAGE,
  },
  structure: {
    min_max_tokens: 8192,
    require_no_tools: true,
    require_single_turn: true,
  },
  needles: [
    '<think>',
    '</think>',
    '<answer>',
    '<|begin_of_thought|>',
    '<|end_of_thought|>',
    '<|begin_of_solution|>',
    'Return your final response within \\boxed{}',
    'Generate an executable Python function generated from the given prompt',
    'systematic long thinking process',
    'as an internal monologue',
    'Please reason step by step, and put your final answer within \\boxed{}',
    'Respond in the following format: <think>',
    'Memory-stage-one extractor',
    'Persistable response items',
    'You MUST extract durable memory now',
    'MUST distill reusable, durable rollout knowledge',
    'x-anthropic-billing-header',
  ],
  fingerprints: [
    'Let  $a,b,A,B$  be given reals. We consider the function defined by',
    'The graph of the function $y=\\cos x - \\sin x$ has a line of symmetry given by',
    'Prove that if $\\alpha, \\beta, \\gamma$ are the angles of a triangle, then',
    "Jia walks from home to Yi's house. At the same time, Yi rides a bicycle",
    'Colonoscopy reveals a fungating hemorrhagic mass in the ascending colon',
    'reactant: Cc1ccc2c(cnn2C2CCCCO2)c1B1OC(C)(C)C(C)(C)O1',
    'What is the area, in square units, of an isosceles right triangle with a hypotenuse of 20 units?',
  ],
}

const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../config/distill-rules.json')

export function defaultDistillFile() {
  return DEFAULT_FILE
}

export function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\\\s+/g, '\\')
    .trim()
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        if (part && typeof part.content === 'string') return part.content
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content.text === 'string') return content.text
  return ''
}

function systemText(body) {
  if (!body || typeof body !== 'object') return ''
  const parts = []
  if (typeof body.system === 'string') parts.push(body.system)
  else if (Array.isArray(body.system)) parts.push(contentToText(body.system))
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const m of messages) {
    const role = String(m?.role || '').toLowerCase()
    if (role === 'system' || role === 'developer') parts.push(contentToText(m.content))
  }
  return parts.filter(Boolean).join('\n')
}

function userTexts(body) {
  if (!body || typeof body !== 'object') return []
  const out = []
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const m of messages) {
    if (m?.role === 'user') out.push(contentToText(m.content))
  }
  if (typeof body.input === 'string') out.push(body.input)
  else if (Array.isArray(body.input)) out.push(contentToText(body.input))
  return out.filter(Boolean)
}

export function extractPrompt(inbound, body) {
  const users = [...userTexts(inbound), ...userTexts(body)]
  const systems = [systemText(inbound), systemText(body)].filter(Boolean)
  return {
    system: systems[0] || '',
    user: users[0] || '',
    joined: [...systems, ...users].join('\n'),
  }
}

function messageCount(body) {
  if (Array.isArray(body?.messages)) return body.messages.length
  if (body?.input != null) return 1
  return 0
}

function toolsCount(body) {
  return Array.isArray(body?.tools) ? body.tools.length : 0
}

function maxTokensOf(body) {
  const n = body?.max_tokens ?? body?.max_output_tokens ?? body?.max_new_tokens
  return n == null ? null : Number(n)
}

export function extractStructure(inbound, body) {
  const src = body && typeof body === 'object' ? body : inbound || {}
  return {
    messages_count: messageCount(src),
    tools_count: toolsCount(src) || toolsCount(inbound),
    max_tokens: maxTokensOf(src) ?? maxTokensOf(inbound),
  }
}

function inboundWantsThinkingText(inbound) {
  const t = inbound?.thinking
  if (t && typeof t === 'object') {
    if (String(t.display || '').toLowerCase() === 'summarized') return true
    const budget = Number(t.budget_tokens || 0)
    if (String(t.type || '').toLowerCase() === 'enabled' && budget >= 8192) return true
  }
  const effort = inbound?.reasoning_effort || inbound?.reasoning?.effort
  if (effort && HIGH_EFFORT.has(String(effort).toLowerCase())) return true
  const n = Number(inbound?.n || inbound?.num_generations || 1)
  return n > 1
}

function isHarvest(inbound, structure, rules) {
  const st = rules.structure || DEFAULT_DISTILL_RULES.structure
  if (st.require_no_tools && structure.tools_count > 0) return false
  if (st.require_single_turn && structure.messages_count > 1) return false
  const minTok = Number(st.min_max_tokens || 8192)
  if (structure.max_tokens != null && Number(structure.max_tokens) < minTok) return false
  return inboundWantsThinkingText(inbound)
}

function matchFingerprints(text, fingerprints) {
  const hay = normalizeText(text)
  if (!hay) return ''
  for (const raw of fingerprints || []) {
    const needle = normalizeText(raw)
    if (needle && hay.includes(needle)) return String(raw).slice(0, 80)
  }
  return ''
}

function matchNeedles(text, needles) {
  const hay = String(text || '').toLowerCase()
  if (!hay) return ''
  for (const raw of needles || []) {
    const needle = String(raw || '').toLowerCase()
    if (needle && hay.includes(needle)) return String(raw)
  }
  return ''
}

function asStringList(v, fallback) {
  if (!Array.isArray(v)) return fallback.slice()
  return v.map((x) => String(x || '').trim()).filter(Boolean)
}

function clampStatus(n) {
  const s = Number(n)
  if (!Number.isFinite(s) || s < 400 || s > 599) return 403
  return Math.floor(s)
}

export function normalizeDistillRules(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const err = src.error && typeof src.error === 'object' ? src.error : {}
  const st = src.structure && typeof src.structure === 'object' ? src.structure : {}
  const message = String(err.message || DISTILL_BLOCK_MESSAGE).trim() || DISTILL_BLOCK_MESSAGE
  return {
    enabled: src.enabled !== false,
    skip_official: src.skip_official !== false,
    skip_zero: src.skip_zero !== false,
    error: {
      status: clampStatus(err.status ?? 403),
      type: String(err.type || ErrorType.PERMISSION),
      code: String(err.code || ErrorCode.DISTILL_BLOCKED),
      message: message.slice(0, 200),
    },
    structure: {
      min_max_tokens: Math.max(256, Number(st.min_max_tokens || 8192) || 8192),
      require_no_tools: st.require_no_tools !== false,
      require_single_turn: st.require_single_turn !== false,
    },
    needles: asStringList(src.needles, DEFAULT_DISTILL_RULES.needles),
    fingerprints: asStringList(src.fingerprints, DEFAULT_DISTILL_RULES.fingerprints),
  }
}

function typeProblems(body) {
  const problems = []
  if (body.enabled != null && typeof body.enabled !== 'boolean') problems.push('enabled 必须是布尔')
  if (body.skip_official != null && typeof body.skip_official !== 'boolean') {
    problems.push('skip_official 必须是布尔')
  }
  if (body.skip_zero != null && typeof body.skip_zero !== 'boolean') {
    problems.push('skip_zero 必须是布尔')
  }
  if (body.needles != null && !Array.isArray(body.needles)) problems.push('needles 必须是数组')
  if (body.fingerprints != null && !Array.isArray(body.fingerprints)) {
    problems.push('fingerprints 必须是数组')
  }
  return problems
}

function sizeProblems(body) {
  const problems = []
  if (Array.isArray(body.needles) && body.needles.length > 200) problems.push('needles 最多 200 条')
  if (Array.isArray(body.fingerprints) && body.fingerprints.length > 200) {
    problems.push('fingerprints 最多 200 条')
  }
  return problems
}

function errorProblems(err) {
  if (err == null) return []
  if (typeof err !== 'object') return ['error 必须是对象']
  const problems = []
  if (err.message != null && !String(err.message).trim()) problems.push('error.message 不能为空')
  if (err.status == null) return problems
  const s = Number(err.status)
  if (!Number.isFinite(s) || s < 400 || s > 599) problems.push('error.status 必须是 400–599')
  return problems
}

export function validateDistillPatch(body = {}) {
  return [...typeProblems(body), ...sizeProblems(body), ...errorProblems(body.error)]
}

export function loadDistillRules(file) {
  try {
    if (!file || !fs.existsSync(file)) return normalizeDistillRules(DEFAULT_DISTILL_RULES)
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return normalizeDistillRules(data)
  } catch {
    return normalizeDistillRules(DEFAULT_DISTILL_RULES)
  }
}

export function saveDistillRules(file, patch) {
  const cur = loadDistillRules(file)
  const src = patch && typeof patch === 'object' ? patch : {}
  const next = normalizeDistillRules({
    ...cur,
    ...src,
    error: { ...cur.error, ...(src.error || {}) },
    structure: { ...cur.structure, ...(src.structure || {}) },
  })
  atomicWriteJson(file, next)
  return next
}

export function distillBlockError(rules, requestId) {
  const r = normalizeDistillRules(rules)
  return makeError({
    type: r.error.type,
    code: r.error.code,
    message: r.error.message,
    status: r.error.status,
    request_id: requestId,
  })
}

/**
 * @param {{ inbound?: object, body?: object, official?: boolean }} ctx
 * @param {object} [rules]
 */
export function detectDistill(ctx = {}, rules) {
  const r = normalizeDistillRules(rules)
  if (!r.enabled) return { action: 'pass', hits: [] }
  if (r.skip_official && ctx.official) return { action: 'pass', hits: [] }
  if (r.skip_zero && ctx.zeroInject) return { action: 'pass', hits: [] }
  const prompt = extractPrompt(ctx.inbound, ctx.body)
  const structure = extractStructure(ctx.inbound, ctx.body)
  const hits = []

  const fp = matchFingerprints(prompt.user || prompt.joined, r.fingerprints)
  if (fp) hits.push({ layer: 'content', rule: 'fingerprint', evidence: fp })

  const needle = matchNeedles(prompt.joined, r.needles)
  if (needle) hits.push({ layer: 'content', rule: 'needle', evidence: needle })

  const contest = CONTEST_RE.test(prompt.joined)
  const harvest = contest && isHarvest(ctx.inbound, structure, r)
  if (harvest) hits.push({ layer: 'structure', rule: 'harvest', evidence: 'contest+harvest' })

  if (!fp && !needle && !harvest) return { action: 'pass', hits }
  return { action: 'block', hits, error: r.error }
}
