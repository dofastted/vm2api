#!/usr/bin/env node
/**
 * official_303 outbound replay: real inbound fixtures (crag replay schema v1) through the
 * real chain (Node handler → kin-kernel → cli-node → capture upstream), judged on the bytes
 * cli-node finally sends. Fixtures, wires and verdicts are private; `summary` prints counts,
 * rule ids and paths only.
 *
 *   node scripts/outbound-replay.mjs select  --pool <jsonl...> --out <selected.jsonl> [--routing <base.json>] [--per-cell 3] [--max 200]
 *   node scripts/outbound-replay.mjs run     --input <selected.jsonl> [--sessions <jsonl...>] --bin-dir <dir> --out <dir> [--routing <base.json>]
 *   node scripts/outbound-replay.mjs summary --out <dir>
 *   node scripts/outbound-replay.mjs leak-check --fixtures <jsonl...> --files <file...> [--samples 20]
 *
 * Run matrix (design §2.3): A = profile cli · official_303 · 5m, A' = same at 1h,
 * B = profile cli · official_full, C:<preset> = base cli, D:<preset> = profile cli, for the
 * four 2.1.296 presets. Ordered sessions run A and A' only, plus the cross-turn prefix check.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRealChain } from '../test/e2e/helpers/real-chain.mjs'
import {
  checkCallerPlacement,
  checkOfficial303Rules,
  checkOfficial303Wire,
  diffShapes,
  isAllowedSkeletonDiff,
  outboundShape,
} from '../src/lib/protocol/outbound-shape.mjs'
import { officialPromptShape } from '../src/lib/identity/official-profiles.mjs'
import {
  detectProxiedOfficialCcFromRouting,
  isOfficialClaudeCodeTraffic,
  isProxiedOfficialClaudeCode,
} from '../src/lib/identity/crs-persona.mjs'
import { classifyClaudeRequestPurpose } from '../src/lib/protocol/request-purpose.mjs'
import { validateOfficialModel } from '../src/lib/protocol/models.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKELETON = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/official-2.1.303-skeleton.json'), 'utf8'))
const PRESETS_296 = ['official', 'official_full', 'zero', 'custom']
const PROTOCOL_BY_PATH = {
  '/v1/messages': 'anthropic.messages',
  '/v1/chat/completions': 'openai.chat',
  '/v1/responses': 'openai.responses',
}
const DIMS = {
  protocol: ['anthropic.messages', 'openai.chat'],
  shape: ['lean', 'full', 'classifier'],
  caller: ['official', 'unofficial'],
  turns: ['single', 'multi'],
  system: ['sys', 'nosys'],
}
const VERSION_WIRE_RULES = new Set([
  'wire.kin_outbound_shape',
  'wire.billing_missing',
  'wire.billing_version',
  'wire.user_agent',
  'wire.cch',
  'wire.content_length',
])
// Per-attempt or per-connection headers; everything else must match between compared wires.
const VOLATILE_HEADERS = new Set([
  'content-length',
  'host',
  'connection',
  'x-claude-code-session-id',
  'x-claude-code-prompt-id',
  'x-client-request-id',
])

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      out._.push(arg)
      continue
    }
    const values = []
    while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) values.push(argv[++i])
    out[arg.slice(2)] = values.length > 1 ? values : (values[0] ?? true)
  }
  return out
}

const list = (value) => (value == null || value === true ? [] : Array.isArray(value) ? value : [value])

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

function writePrivate(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

function appendPrivate(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

const sha12 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 12)

function lowerKeys(headers) {
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), value]))
}

function protocolOf(fixture) {
  return fixture.source?.protocol || PROTOCOL_BY_PATH[String(fixture.request?.path || '').split('?')[0]] || ''
}

function hasRedactedImage(value) {
  if (typeof value === 'string') return value === '[omitted-image]' || /^…\[\d+ bytes\]$/.test(value)
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasRedactedImage)
  if (['image', 'input_image'].includes(value.type) && value.source && typeof value.source.data !== 'string') {
    if (typeof value.source.url !== 'string') return true
  }
  return Object.values(value).some(hasRedactedImage)
}

function hasCallerSystem(body, protocol) {
  if (protocol === 'openai.chat')
    return (body.messages || []).some((message) => message?.role === 'system' || message?.role === 'developer')
  if (typeof body.system === 'string') return body.system.trim() !== ''
  return Array.isArray(body.system) && body.system.some((block) => String(block?.text ?? block ?? '').trim())
}

function isMultiTurn(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (messages.filter((message) => message?.role === 'user').length >= 2) return true
  return messages.some((message) => message?.role === 'assistant' || message?.role === 'tool')
}

/** The same caller decisions handle-protocol makes, computed on the raw inbound. */
export function labelFixture(fixture, routing = {}) {
  const protocol = protocolOf(fixture)
  const body = fixture.request?.body
  if (!body || typeof body !== 'object' || '_truncated' in body || '_raw' in body)
    return { protocol, skip: 'truncated' }
  // Claude models on /v1/responses are rejected before cli-hop; other models go to the codex route.
  if (protocol === 'openai.responses') return { protocol, skip: 'responses_not_cli_hop' }
  if (!DIMS.protocol.includes(protocol)) return { protocol, skip: 'protocol' }
  const modelCheck = validateOfficialModel(body.model)
  if (!modelCheck.ok) return { protocol, skip: 'model_not_claude' }
  const headers = lowerKeys(fixture.request?.headers)
  const official =
    isOfficialClaudeCodeTraffic(headers, body) ||
    (detectProxiedOfficialCcFromRouting(routing) && isProxiedOfficialClaudeCode(body, headers))
  const classifier = Boolean(classifyClaudeRequestPurpose(body, { officialTraffic: official }))
  return {
    protocol,
    shape: classifier ? 'classifier' : officialPromptShape(modelCheck.model),
    caller: official ? 'official' : 'unofficial',
    turns: isMultiTurn(body) ? 'multi' : 'single',
    system: hasCallerSystem(body, protocol) ? 'sys' : 'nosys',
    image_redacted: hasRedactedImage(body),
  }
}

const cellOf = (labels) =>
  Object.keys(DIMS)
    .map((key) => labels[key])
    .join('|')

function allCells() {
  let cells = ['']
  for (const values of Object.values(DIMS))
    cells = cells.flatMap((prefix) => values.map((value) => (prefix ? `${prefix}|${value}` : value)))
  return cells
}

function select(args) {
  const routing = args.routing ? JSON.parse(fs.readFileSync(args.routing, 'utf8')) : {}
  const perCell = Number(args['per-cell'] || 3)
  const max = Number(args.max || 200)
  const seen = new Set()
  const skipped = {}
  const byCell = new Map()
  let imageRedacted = 0
  for (const file of list(args.pool)) {
    for (const fixture of readJsonl(file)) {
      if (seen.has(fixture.id)) continue
      seen.add(fixture.id)
      const labels = labelFixture(fixture, routing)
      if (labels.skip) {
        skipped[labels.skip] = (skipped[labels.skip] || 0) + 1
        continue
      }
      const cell = cellOf(labels)
      if (!byCell.has(cell)) byCell.set(cell, [])
      byCell.get(cell).push({ ...fixture, replay: { labels, cell } })
    }
  }
  // Deterministic spread within a cell, then round-robin across cells up to --max.
  const queues = [...byCell.values()].map((items) =>
    items.sort((a, b) => sha12(a.id).localeCompare(sha12(b.id))).slice(0, perCell),
  )
  const picked = []
  for (let round = 0; picked.length < max && queues.some((queue) => queue.length > round); round++) {
    for (const queue of queues) if (queue[round] && picked.length < max) picked.push(queue[round])
  }
  for (const fixture of picked) if (fixture.replay.labels.image_redacted) imageRedacted++
  writePrivate(args.out, picked.map((fixture) => JSON.stringify(fixture)).join('\n') + (picked.length ? '\n' : ''))
  const coverage = {
    pool: seen.size,
    selected: picked.length,
    image_redacted: imageRedacted,
    skipped,
    cells: Object.fromEntries(
      allCells().map((cell) => [
        cell,
        {
          pool: byCell.get(cell)?.length || 0,
          selected: picked.filter((fixture) => fixture.replay.cell === cell).length,
        },
      ]),
    ),
  }
  writePrivate(`${args.out}.coverage.json`, `${JSON.stringify(coverage, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ pool: coverage.pool, selected: picked.length, skipped }, null, 2)}\n`)
}

/** Structural first difference between two JSON values: a path plus lengths, never text. */
function firstDiff(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null
  const aObj = a && typeof a === 'object'
  const bObj = b && typeof b === 'object'
  if (aObj && bObj && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const inner = firstDiff(a[i], b[i], `${at}[${i}]`)
        if (inner) return inner
      }
      return { at: at || '.' }
    }
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const inner = firstDiff(a[key], b[key], at ? `${at}.${key}` : key)
      if (inner) return inner
    }
    return { at: at || '.', kind: 'key_order' }
  }
  const lengthOf = (value) => (typeof value === 'string' ? value.length : null)
  return { at: at || '.', a_len: lengthOf(a), b_len: lengthOf(b) }
}

function mapSystemText(system, fn) {
  if (typeof system === 'string') return fn(system)
  if (!Array.isArray(system)) return system
  return system.map((block) =>
    typeof block === 'string'
      ? fn(block)
      : typeof block?.text === 'string'
        ? { ...block, text: fn(block.text) }
        : block,
  )
}

/** Same neutral form as the e2e 296 regression: metadata, CCH and the per-attempt prompt id. */
function neutral296(wire) {
  const scrub = (text) =>
    text.replace(/cch=[0-9a-f]{5}/, 'cch=X').replace(/cc_prompt_id=[0-9a-f-]{36}/, 'cc_prompt_id=X')
  return {
    body: { ...wire.body, metadata: null, system: mapSystemText(wire.body.system, scrub) },
    headers: Object.fromEntries(Object.entries(wire.headers || {}).filter(([key]) => !VOLATILE_HEADERS.has(key))),
  }
}

/** 303 full vs official_full: also the CLI version in billing and UA. */
function neutralVersion(wire) {
  const base = neutral296(wire)
  const version = (text) => String(text).replace(/\b2\.1\.\d{3}\b/g, 'V')
  return {
    body: {
      ...base.body,
      system: mapSystemText(base.body.system, (text) => text.replace(/cc_version=[^;\s]+/, 'cc_version=X')),
    },
    headers: Object.fromEntries(Object.entries(base.headers).map(([key, value]) => [key, version(value)])),
  }
}

function compareWires(id, a, b, neutral) {
  if (a.status !== b.status) return [{ id: `${id}.status`, a: a.status, b: b.status }]
  if (!a.body || !b.body) return a.body || b.body ? [{ id: `${id}.capture` }] : []
  const x = neutral(a)
  const y = neutral(b)
  const problems = []
  const diff = firstDiff(x.body, y.body)
  if (diff) problems.push({ id: `${id}.body`, ...diff })
  for (const key of new Set([...Object.keys(x.headers), ...Object.keys(y.headers)]))
    if (x.headers[key] !== y.headers[key]) problems.push({ id: `${id}.header`, key })
  return problems
}

function sendProblems(wire) {
  if (wire.status !== 200) return [{ id: 'send.status', status: wire.status }]
  if (!wire.body) return [{ id: 'send.no_upstream' }]
  return null
}

/**
 * The skeleton is a capture with tools and thinking. 303 never fills fields the caller did not
 * send, so optional keys absent from the body are dropped from the expectation; their order is
 * still checked by `wire.top_level_order`.
 */
function skeletonFor(body) {
  const skeleton = structuredClone(SKELETON)
  skeleton.top_level = skeleton.top_level.filter((key) => Object.hasOwn(body, key))
  for (const key of ['tools', 'thinking', 'metadata_keys', 'output_config_keys']) {
    const field = key.replace(/_keys$/, '')
    if (!Object.hasOwn(body, field)) skeleton[key] = null
  }
  return skeleton
}

function judgeLean(wire, fixture, labels, ttl, log) {
  const early = sendProblems(wire)
  if (early) return early
  const body = wire.body
  const problems = [
    ...checkOfficial303Rules(body).map((rule) => ({ id: 'rules', rule })),
    ...diffShapes(skeletonFor(body), outboundShape(body))
      .filter((diff) => !isAllowedSkeletonDiff(diff))
      .map((diff) => ({ id: 'skeleton', path: diff.path })),
    ...checkOfficial303Wire(wire),
    ...checkCallerPlacement(body, fixture.request.body, {
      officialCaller: labels.caller === 'official',
      protocol: labels.protocol,
    }),
  ]
  const ttls = [...new Set(outboundShape(body).markers.at.map((marker) => marker.ttl))]
  if (ttls.length !== 1 || ttls[0] !== ttl) problems.push({ id: 'ttl.panel', expected: ttl, actual: ttls })
  if (log?.outbound_profile?.shape !== 'lean')
    problems.push({ id: 'shape.log', actual: log?.outbound_profile?.shape ?? null })
  return problems
}

function judgeFull(wire, log) {
  const early = sendProblems(wire)
  if (early) return early
  const problems = checkOfficial303Wire(wire).filter((problem) => VERSION_WIRE_RULES.has(problem.id))
  if (log?.outbound_profile?.shape === 'lean') problems.push({ id: 'shape.log', actual: 'lean' })
  return problems
}

function judgeClassifier(wire, log) {
  const early = sendProblems(wire)
  if (early) return early
  const problems = []
  if (Object.hasOwn(wire.body, 'kin_outbound_shape') || log?.outbound_profile?.shape === 'lean')
    problems.push({ id: 'classifier.lean' })
  return problems
}

const isBlocking = (problem) => problem.blocking !== false

function stripMarkers(value) {
  return JSON.parse(JSON.stringify(value ?? null, (key, inner) => (key === 'cache_control' ? undefined : inner)))
}

function isExtension(prevBody, curBody) {
  const a = stripMarkers(prevBody?.messages || [])
  const b = stripMarkers(curBody?.messages || [])
  return b.length > a.length && JSON.stringify(b.slice(0, a.length)) === JSON.stringify(a)
}

/** R5: the next turn keeps system and every message up to the previous last user byte-identical. */
function prefixProblems(prev, cur) {
  if (!prev.body || !cur.body) return [{ id: 'prefix.capture' }]
  const system = (body) =>
    stripMarkers(
      mapSystemText(body.system, (text) =>
        text.replace(/cch=[0-9a-f]{5}/, 'cch=X').replace(/cc_prompt_id=[0-9a-f-]{36}/, 'cc_prompt_id=X'),
      ),
    )
  const problems = []
  const systemDiff = firstDiff(system(prev.body), system(cur.body))
  if (systemDiff) problems.push({ id: 'prefix.system', ...systemDiff })
  let lastUser = -1
  prev.body.messages.forEach((message, i) => {
    if (message?.role === 'user') lastUser = i
  })
  const head = (body) => stripMarkers(body.messages.slice(0, lastUser + 1))
  const messageDiff = firstDiff(head(prev.body), head(cur.body))
  if (messageDiff) problems.push({ id: 'prefix.messages', ...messageDiff })
  const toolDiff = firstDiff(stripMarkers(prev.body.tools), stripMarkers(cur.body.tools))
  if (toolDiff) problems.push({ id: 'prefix.tools', ...toolDiff })
  return problems
}

function readShaSums(binDir) {
  const file = path.join(binDir, 'SHA256SUMS')
  if (!fs.existsSync(file)) return {}
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/))
      .map(([sum, name]) => [path.basename(name), sum]),
  )
}

async function run(args) {
  const outDir = args.out
  const binDir = args['bin-dir']
  if (!outDir || !binDir || !args.input) throw new Error('run needs --input, --bin-dir and --out')
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const verdictsFile = path.join(outDir, 'verdicts.jsonl')
  const wiresFile = path.join(outDir, 'wires-fail.jsonl')
  for (const file of [verdictsFile, wiresFile]) fs.rmSync(file, { force: true })
  const routingBase = args.routing ? JSON.parse(fs.readFileSync(args.routing, 'utf8')) : null
  const fixtures = readJsonl(args.input)
  const sessions = list(args.sessions).map((file) => ({
    file: path.basename(file),
    turns: readJsonl(file).sort((a, b) => String(a.source?.ts).localeCompare(String(b.source?.ts))),
  }))
  const kernelBin = path.join(binDir, 'kin-kernel')
  const startedAt = new Date().toISOString()
  const profile = await startRealChain({
    kernelBin,
    cliBin: path.join(binDir, 'cli-node.profile'),
    preset: 'official_303',
    routingBase,
  })
  const base = await startRealChain({
    kernelBin,
    cliBin: path.join(binDir, 'cli-node.base'),
    preset: 'official',
    routingBase,
  })
  const state = new Map([
    [profile, { preset: 'official_303', ttl: '5m' }],
    [base, { preset: 'official', ttl: '5m' }],
  ])
  const sendAs = async (chain, preset, ttl, fixture) => {
    const now = state.get(chain)
    if (now.preset !== preset) chain.switchPreset(preset)
    if (now.ttl !== ttl) chain.setCacheTtl(ttl)
    state.set(chain, { preset, ttl })
    const before = chain.logs.length
    const wire = await chain.send(fixture)
    return { wire, log: chain.logs[before] }
  }
  const keepFailures = (id, wires, checks) => {
    for (const [round, problems] of Object.entries(checks)) {
      const wire = wires[round.split('~')[0]]
      if (wire?.raw && problems.some(isBlocking))
        appendPrivate(wiresFile, { id, round, raw: wire.raw, headers: wire.headers })
    }
  }
  const counts = { fixtures: 0, session_turns: 0, skipped: {} }
  const skip = (reason) => {
    counts.skipped[reason] = (counts.skipped[reason] || 0) + 1
  }
  try {
    for (const fixture of fixtures) {
      const labels = fixture.replay?.labels || labelFixture(fixture, routingBase || {})
      if (labels.skip) {
        skip(labels.skip)
        continue
      }
      counts.fixtures++
      const wires = {}
      const logs = {}
      for (const [round, chain, preset, ttl] of [
        ['A', profile, 'official_303', '5m'],
        ["A'", profile, 'official_303', '1h'],
        ['B', profile, 'official_full', '5m'],
        ...PRESETS_296.filter((preset) => preset !== 'official_full').map((preset) => [
          `D:${preset}`,
          profile,
          preset,
          '5m',
        ]),
        ...PRESETS_296.map((preset) => [`C:${preset}`, base, preset, '5m']),
      ]) {
        const sent = await sendAs(chain, preset, ttl, fixture)
        wires[round] = sent.wire
        logs[round] = sent.log
      }
      wires['D:official_full'] = wires.B
      if (Object.values(wires).every((wire) => wire.status === 200 && wire.count === 0)) {
        skip('answered_locally')
        continue
      }
      const checks = {}
      if (labels.shape === 'lean') {
        checks.A = judgeLean(wires.A, fixture, labels, '5m', logs.A)
        checks["A'"] = judgeLean(wires["A'"], fixture, labels, '1h', logs["A'"])
      } else if (labels.shape === 'full') {
        checks.A = judgeFull(wires.A, logs.A)
        checks["A'"] = judgeFull(wires["A'"], logs["A'"])
        checks['A~B'] = compareWires('full', wires.A, wires.B, neutralVersion)
      } else {
        checks.A = judgeClassifier(wires.A, logs.A)
        checks['A~B'] = compareWires('classifier', wires.A, wires.B, neutralVersion)
      }
      for (const preset of PRESETS_296)
        checks[`D:${preset}~C`] = compareWires('296', wires[`D:${preset}`], wires[`C:${preset}`], neutral296)
      const pass = Object.values(checks).every((problems) => !problems.some(isBlocking))
      appendPrivate(verdictsFile, { id: fixture.id, kind: 'fixture', cell: cellOf(labels), labels, pass, checks })
      if (!pass) keepFailures(fixture.id, wires, checks)
    }
    for (const session of sessions) {
      const previous = {}
      for (const fixture of session.turns) {
        const labels = labelFixture(fixture, routingBase || {})
        if (labels.skip) {
          skip(`session:${labels.skip}`)
          continue
        }
        counts.session_turns++
        const wires = {}
        const checks = {}
        for (const [round, ttl] of [
          ['A', '5m'],
          ["A'", '1h'],
        ]) {
          const { wire, log } = await sendAs(profile, 'official_303', ttl, fixture)
          wires[round] = wire
          checks[round] =
            labels.shape === 'lean'
              ? judgeLean(wire, fixture, labels, ttl, log)
              : labels.shape === 'full'
                ? judgeFull(wire, log)
                : judgeClassifier(wire, log)
          const prev = previous[round]
          if (prev && labels.shape !== 'classifier' && prev.labels.shape === labels.shape) {
            if (isExtension(prev.fixture.request.body, fixture.request.body))
              checks[`${round}~prev`] = prefixProblems(prev.wire, wire)
            else checks[`${round}~prev`] = [{ id: 'prefix.not_extension', blocking: false }]
          }
          if (labels.shape !== 'classifier') previous[round] = { fixture, labels, wire }
        }
        const pass = Object.values(checks).every((problems) => !problems.some(isBlocking))
        appendPrivate(verdictsFile, {
          id: fixture.id,
          kind: 'session',
          session: sha12(session.file),
          cell: cellOf(labels),
          labels,
          pass,
          checks,
        })
        if (!pass) keepFailures(fixture.id, wires, checks)
      }
    }
  } finally {
    await profile.close()
    await base.close()
  }
  const meta = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    binaries: readShaSums(binDir),
    routing_base: Boolean(routingBase),
    input: { fixtures: fixtures.length, sessions: sessions.length },
    counts,
  }
  writePrivate(path.join(outDir, 'run-meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  return summary({ out: outDir })
}

/** Rule id plus the non-text detail that groups it; indexes collapse to N. */
function problemKey(problem) {
  const detail = problem.rule ?? problem.path ?? problem.at ?? problem.key ?? problem.status ?? ''
  return `${problem.id}${detail === '' ? '' : ` ${String(detail).replace(/\d+/g, 'N')}`}`
}

function summary(args) {
  const verdicts = fs.existsSync(path.join(args.out, 'verdicts.jsonl'))
    ? readJsonl(path.join(args.out, 'verdicts.jsonl'))
    : []
  const metaFile = path.join(args.out, 'run-meta.json')
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null
  const checks = {}
  const cells = {}
  const pairs = { extension: 0, not_extension: 0, failed: 0 }
  for (const verdict of verdicts) {
    const cell = (cells[`${verdict.kind}:${verdict.cell}`] ||= { total: 0, pass: 0 })
    cell.total++
    if (verdict.pass) cell.pass++
    for (const [name, problems] of Object.entries(verdict.checks)) {
      const entry = (checks[`${verdict.kind}:${name}`] ||= { total: 0, fail: 0, problems: {} })
      entry.total++
      const blocking = problems.filter(isBlocking)
      if (blocking.length) entry.fail++
      for (const problem of problems) {
        const key = `${isBlocking(problem) ? '' : '(note) '}${problemKey(problem)}`
        entry.problems[key] = (entry.problems[key] || 0) + 1
      }
      if (name.endsWith('~prev')) {
        if (problems.some((problem) => problem.id === 'prefix.not_extension')) pairs.not_extension++
        else {
          pairs.extension++
          if (blocking.length) pairs.failed++
        }
      }
    }
  }
  const result = {
    meta,
    verdicts: verdicts.length,
    pass: verdicts.filter((verdict) => verdict.pass).length,
    cells,
    checks,
    session_pairs: pairs,
  }
  writePrivate(path.join(args.out, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result.pass === result.verdicts ? 0 : 1
}

/** Gate for anything leaving the private dir: random fixture text fragments must not appear. */
function leakCheck(args) {
  const samples = Number(args.samples || 20)
  const fragments = []
  const collect = (value) => {
    if (typeof value === 'string') {
      for (const part of value.split(/\n+/)) if (part.trim().length >= 30) fragments.push(part.trim().slice(0, 60))
    } else if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  for (const file of list(args.fixtures)) for (const fixture of readJsonl(file)) collect(fixture.request?.body)
  const unique = [...new Set(fragments)].sort((a, b) => sha12(a).localeCompare(sha12(b)))
  const picked = unique.slice(0, samples)
  const hits = []
  for (const file of list(args.files)) {
    const text = fs.readFileSync(file, 'utf8')
    picked.forEach((fragment, i) => {
      if (text.includes(fragment)) hits.push({ file: path.basename(file), sample: i, sha: sha12(fragment) })
    })
  }
  process.stdout.write(`${JSON.stringify({ samples: picked.length, files: list(args.files).length, hits }, null, 2)}\n`)
  return hits.length ? 1 : 0
}

async function main(argv) {
  const [command, ...rest] = argv
  const args = parseArgs(rest)
  if (command === 'select' && args.pool && args.out) return select(args)
  if (command === 'run') return run(args)
  if (command === 'summary' && args.out) return summary(args)
  if (command === 'leak-check' && args.fixtures && args.files) return leakCheck(args)
  process.stderr.write(
    'usage: outbound-replay.mjs select --pool <jsonl...> --out <f> | run --input <f> --bin-dir <d> --out <d> | summary --out <d> | leak-check --fixtures <jsonl...> --files <f...>\n',
  )
  return 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = (await main(process.argv.slice(2))) ?? 0
}
