/**
 * Distill harvest detector.
 * Runs in handleProtocol and count_tokens before any credential / slot hop.
 * OpenAI platform models (detectInboundPlatform === openai) always pass.
 * Match layers: hard harvest needles, hard distill/CoT regex, fingerprint, prompt needles, contest structure.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectInboundPlatform } from '../protocol/platform-detect.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { ErrorType, ErrorCode, makeError } from './errors.mjs'

const HIGH_EFFORT = new Set(['high', 'xhigh', 'max'])

/** Transport wrapper used by normal agent sessions. Not a harvest needle. */
export const ENVELOPE_NEEDLES = Object.freeze(['Persistable response items'])

/**
 * Deterministic distill regexes live in HARD_POLICY_RULES (category distill).
 * This list stays empty so a saved distill config cannot grow a second copy.
 * Harvest wrappers, needles, fingerprints, and structure thresholds come from
 * distill-rules.json — the risk-audit panel — and are not reinserted here.
 */
export const HARD_DISTILL_PATTERNS = Object.freeze([])

const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../config/distill-rules.json')

export function defaultDistillFile() {
  return DEFAULT_FILE
}

function blankDistillRules() {
  return {
    enabled: true,
    skip_official: true,
    skip_zero: true,
    error: {
      status: 403,
      type: ErrorType.PERMISSION,
      code: ErrorCode.DISTILL_BLOCKED,
      message: '',
    },
    structure: {
      min_max_tokens: 1,
      require_no_tools: true,
      require_single_turn: true,
      contest_pattern: '',
    },
    hard_needles: [],
    needles: [],
    patterns: [],
    fingerprints: [],
  }
}

let factoryCache = null

/** Shipped panel file. Used only when a field is omitted, never to override an explicit value. */
function factoryRules() {
  if (factoryCache) return factoryCache
  try {
    const data = JSON.parse(fs.readFileSync(DEFAULT_FILE, 'utf8'))
    factoryCache = normalizeDistillRules(data, { fill: false })
  } catch {
    factoryCache = blankDistillRules()
  }
  return factoryCache
}
export const DEFAULT_DISTILL_RULES = factoryRules()

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
        if (part && part.type === 'tool_result') return ''
        return contentToText(part)
      })
      .filter(Boolean)
      .join('\n')
  }
  if (!content || typeof content !== 'object') return ''
  if (typeof content.text === 'string') return content.text
  // Responses items nest their parts one level deeper: message -> content -> input_text.
  if (typeof content.content === 'string') return content.content
  if (Array.isArray(content.content)) return contentToText(content.content)
  return ''
}

function systemText(body) {
  if (!body || typeof body !== 'object') return ''
  if (typeof body.system === 'string') return body.system
  if (Array.isArray(body.system)) return contentToText(body.system)
  // Responses carries the client system prompt as `instructions`.
  if (typeof body.instructions === 'string') return body.instructions
  if (Array.isArray(body.instructions)) return contentToText(body.instructions)
  return ''
}

function messageRoleTexts(body, roles) {
  if (!body || typeof body !== 'object') return []
  const want = new Set(roles)
  const out = []
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const m of messages) {
    if (want.has(m?.role)) out.push(contentToText(m.content))
  }
  return out.filter(Boolean)
}

/** Responses `input`: a plain string, or items whose roleless or user-role parts carry the prompt. */
function responsesInputTexts(input) {
  if (typeof input === 'string') return input ? [input] : []
  if (!Array.isArray(input)) return []
  const out = []
  for (const item of input) {
    if (typeof item === 'string') {
      if (item) out.push(item)
      continue
    }
    if (!item || typeof item !== 'object') continue
    const role = typeof item.role === 'string' ? item.role.toLowerCase() : ''
    if (role && role !== 'user') continue
    const text = contentToText(item.content === undefined ? item : item.content)
    if (text) out.push(text)
  }
  return out
}

function userTexts(body) {
  if (!body || typeof body !== 'object') return []
  const out = messageRoleTexts(body, ['user'])
  out.push(...responsesInputTexts(body.input))
  return out.filter(Boolean)
}

export function extractPrompt(inbound, body, opts = {}) {
  const users = [...userTexts(inbound), ...userTexts(body)]
  const latestOnly = !!opts.latestOnly
  const scanUsers = latestOnly && users.length ? [users[users.length - 1]] : users
  const systems = [
    systemText(inbound),
    systemText(body),
    ...messageRoleTexts(inbound, ['system', 'developer']),
    ...messageRoleTexts(body, ['system', 'developer']),
  ].filter(Boolean)
  return {
    system: systems[0] || '',
    user: latestOnly ? scanUsers[0] || '' : users[0] || '',
    joined: [...systems, ...scanUsers].join('\n'),
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

/** OpenAI platform models (gpt-*) never hit distill. Claude paths stay on the existing rules. */
export function isOpenaiPlatformModel(inbound, body) {
  const model = body?.model ?? inbound?.model
  const platform = detectInboundPlatform(model)
  return platform.ok === true && platform.platform === 'openai'
}

export function extractStructure(inbound, body) {
  const src = body && typeof body === 'object' ? body : inbound || {}
  return {
    messages_count: messageCount(src),
    tools_count: toolsCount(src) || toolsCount(inbound),
    max_tokens: maxTokensOf(src) ?? maxTokensOf(inbound),
  }
}

function inboundWantsThinkingText(inbound, minBudget) {
  const floor = Number(minBudget)
  const t = inbound?.thinking
  if (t && typeof t === 'object') {
    if (String(t.display || '').toLowerCase() === 'summarized') return true
    const budget = Number(t.budget_tokens || 0)
    if (String(t.type || '').toLowerCase() === 'enabled' && Number.isFinite(floor) && floor > 0 && budget >= floor) {
      return true
    }
  }
  const effort = inbound?.reasoning_effort || inbound?.reasoning?.effort
  if (effort && HIGH_EFFORT.has(String(effort).toLowerCase())) return true
  const n = Number(inbound?.n || inbound?.num_generations || 1)
  return n > 1
}

function isHarvest(inbound, structure, rules) {
  const st = rules.structure || {}
  if (st.require_no_tools && structure.tools_count > 0) return false
  if (st.require_single_turn && structure.messages_count > 1) return false
  const minTok = Number(st.min_max_tokens)
  if (!Number.isFinite(minTok) || minTok <= 0) return false
  if (structure.max_tokens != null && Number(structure.max_tokens) < minTok) return false
  return inboundWantsThinkingText(inbound, minTok)
}

function contestTest(pattern, text) {
  const source = String(pattern || '').trim()
  if (!source || source.length > 400) return false
  try {
    return new RegExp(source, 'i').test(text || '')
  } catch {
    return false
  }
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
export function isNegatedExtraction(text, index) {
  // A ban on disclosing reasoning is not itself a request to extract it.
  // Only ignore a directly negated match; another match later in the prompt still blocks.
  return /\b(?:do\s+not|don't|never|must\s+not|should\s+not)\s+$/i.test(text.slice(0, index))
}

function matchPatterns(text, patterns) {
  const hay = normalizeText(text)
  if (!hay) return ''
  for (const raw of patterns || []) {
    const source = String(raw || '').trim()
    if (!source || source.length > 400) continue
    let re
    try {
      re = new RegExp(source, 'gi')
    } catch {
      continue
    }
    for (const found of hay.matchAll(re)) {
      if (!isNegatedExtraction(hay, found.index)) return String(found[0]).slice(0, 80)
    }
  }
  return ''
}

function asStringList(v, fallback) {
  if (!Array.isArray(v)) return fallback.slice()
  return v.map((x) => String(x || '').trim()).filter(Boolean)
}

function clampStatus(n, fallback = 403) {
  const s = Number(n)
  const fb = Number(fallback)
  const safe = Number.isFinite(fb) && fb >= 400 && fb <= 599 ? Math.floor(fb) : 403
  return !Number.isFinite(s) || s < 400 || s > 599 ? safe : Math.floor(s)
}

function positiveInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

function resolveHardNeedles(src, listed, base) {
  if (Array.isArray(src.hard_needles)) return asStringList(src.hard_needles, [])
  const factoryHard = base?.hard_needles || []
  if (!Array.isArray(src.needles)) return factoryHard.slice()
  const have = new Set(listed.map((item) => item.toLowerCase()))
  return factoryHard.filter((item) => have.has(item.toLowerCase()))
}

export function normalizeDistillRules(raw, options = {}) {
  const fill = options.fill !== false
  const src = raw && typeof raw === 'object' ? raw : {}
  const base = fill ? factoryRules() : blankDistillRules()
  const err = src.error && typeof src.error === 'object' ? src.error : {}
  const st = src.structure && typeof src.structure === 'object' ? src.structure : {}
  const message = err.message == null ? base.error.message : String(err.message).trim()
  const listed = asStringList(src.needles, fill ? base.needles : [])
  const hardNeedles = resolveHardNeedles(src, listed, fill ? base : null)
  const hardSet = new Set(hardNeedles.map((item) => item.toLowerCase()))
  const patterns = asStringList(src.patterns, fill ? base.patterns : []).slice(0, 80)
  return {
    enabled: src.enabled == null ? base.enabled : src.enabled !== false,
    skip_official: src.skip_official == null ? base.skip_official : src.skip_official !== false,
    skip_zero: src.skip_zero == null ? base.skip_zero : src.skip_zero !== false,
    error: {
      status: clampStatus(err.status == null ? base.error.status : err.status, base.error.status),
      type: String(err.type || base.error.type || ErrorType.PERMISSION),
      code: String(err.code || base.error.code || ErrorCode.DISTILL_BLOCKED),
      message: message.slice(0, 200),
    },
    structure: {
      min_max_tokens: positiveInt(
        st.min_max_tokens == null ? base.structure.min_max_tokens : st.min_max_tokens,
        base.structure.min_max_tokens,
      ),
      require_no_tools:
        st.require_no_tools == null ? base.structure.require_no_tools !== false : st.require_no_tools !== false,
      require_single_turn:
        st.require_single_turn == null
          ? base.structure.require_single_turn !== false
          : st.require_single_turn !== false,
      contest_pattern: st.contest_pattern == null ? base.structure.contest_pattern : String(st.contest_pattern).trim(),
    },
    hard_needles: hardNeedles,
    needles: listed.filter((item) => !hardSet.has(item.toLowerCase())),
    patterns,
    fingerprints: asStringList(src.fingerprints, fill ? base.fingerprints : []),
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
  if (body.hard_needles != null && !Array.isArray(body.hard_needles)) problems.push('hard_needles 必须是数组')
  if (body.needles != null && !Array.isArray(body.needles)) problems.push('needles 必须是数组')
  if (body.patterns != null && !Array.isArray(body.patterns)) problems.push('patterns 必须是数组')
  if (body.fingerprints != null && !Array.isArray(body.fingerprints)) {
    problems.push('fingerprints 必须是数组')
  }
  return problems
}

function sizeProblems(body) {
  const problems = []
  if (Array.isArray(body.hard_needles) && body.hard_needles.length > 200) problems.push('hard_needles 最多 200 条')
  if (Array.isArray(body.needles) && body.needles.length > 200) problems.push('needles 最多 200 条')
  if (Array.isArray(body.patterns) && body.patterns.length > 50) problems.push('patterns 最多 50 条')
  if (Array.isArray(body.patterns)) {
    for (const item of body.patterns) {
      const source = String(item || '').trim()
      if (!source) continue
      if (source.length > 400) {
        problems.push('单条 pattern 最长 400')
        break
      }
      try {
        new RegExp(source, 'i')
      } catch {
        problems.push(`无效正则: ${source.slice(0, 80)}`)
        break
      }
    }
  }
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

function structureProblems(body) {
  const st = body.structure
  if (st == null) return []
  if (typeof st !== 'object') return ['structure 必须是对象']
  const problems = []
  if (st.min_max_tokens != null) {
    const n = Number(st.min_max_tokens)
    if (!Number.isFinite(n) || n <= 0) problems.push('min_max_tokens 必须是正数')
  }
  if (st.contest_pattern != null) {
    const source = String(st.contest_pattern).trim()
    if (source.length > 400) problems.push('contest_pattern 最长 400')
    else if (source) {
      try {
        new RegExp(source, 'i')
      } catch {
        problems.push('contest_pattern 不是有效正则')
      }
    }
  }
  return problems
}

export function validateDistillPatch(body = {}) {
  return [...typeProblems(body), ...sizeProblems(body), ...errorProblems(body.error), ...structureProblems(body)]
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
  const merged = {
    ...cur,
    ...src,
    error: { ...cur.error, ...(src.error || {}) },
    structure: { ...cur.structure, ...(src.structure || {}) },
  }
  // Old clients only had `needles`. A phrase removed from that list is removed
  // from the harvest list too. A client that sends `hard_needles` owns the list.
  if (!Object.prototype.hasOwnProperty.call(src, 'hard_needles') && Array.isArray(src.needles)) {
    const submitted = new Set(
      src.needles
        .map((item) =>
          String(item || '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    )
    merged.hard_needles = (cur.hard_needles || []).filter((item) => submitted.has(String(item).trim().toLowerCase()))
  }
  const next = normalizeDistillRules(merged)
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
  if (isOpenaiPlatformModel(ctx.inbound, ctx.body)) return { action: 'pass', hits: [] }
  const prompt = extractPrompt(ctx.inbound, ctx.body, { latestOnly: true })
  const harvestNeedle = matchNeedles(prompt.joined, r.hard_needles)
  if (harvestNeedle) {
    return {
      action: 'block',
      hits: [{ layer: 'content', rule: 'harvest_needle', evidence: harvestNeedle }],
      error: r.error,
    }
  }
  const regexHit = matchPatterns(prompt.joined, r.patterns)
  if (regexHit) {
    return {
      action: 'block',
      hits: [{ layer: 'content', rule: 'distill_regex', evidence: regexHit }],
      error: r.error,
    }
  }
  if (r.skip_official && ctx.official) return { action: 'pass', hits: [] }
  if (r.skip_zero && ctx.zeroInject) return { action: 'pass', hits: [] }
  const structure = extractStructure(ctx.inbound, ctx.body)
  const hits = []

  const fp = matchFingerprints(prompt.user || prompt.joined, r.fingerprints)
  if (fp) hits.push({ layer: 'content', rule: 'fingerprint', evidence: fp })

  const needle = matchNeedles(prompt.joined, r.needles)
  if (needle) hits.push({ layer: 'content', rule: 'needle', evidence: needle })

  const contest = contestTest(r.structure.contest_pattern, prompt.joined)
  const harvest = contest && isHarvest(ctx.inbound, structure, r)
  if (harvest) hits.push({ layer: 'structure', rule: 'harvest', evidence: 'contest+harvest' })

  if (!hits.length) return { action: 'pass', hits }
  return { action: 'block', hits, error: r.error }
}
