import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'
import { normalizeLoggingConfig, validateLoggingRoutingPatch } from '../../src/lib/admin/request-log.mjs'
import { validateQuotaRoutingPatch } from '../../src/lib/pool/pool-scheduler.mjs'
import { validateInferenceWebsocketPatch } from '../../src/lib/protocol/codex-route.mjs'
import { applyEagerToolStreaming, eagerToolStreamingEnabled } from '../../src/lib/protocol/eager-tool-streaming.mjs'
import { normalizeRedaction, validateRedactionPatch } from '../../src/lib/redaction/policy.mjs'
import { ensureRedaction, publishRedactionForTests, redactionStatus } from '../../src/lib/redaction/runtime.mjs'

function writeSyntheticRedactBin(binPath, { rejectInvalidRegex = false } = {}) {
  fs.mkdirSync(path.dirname(binPath), { recursive: true })
  fs.writeFileSync(
    binPath,
    `#!${process.execPath}
import fs from 'node:fs'
import http from 'node:http'
const arg = (name) => process.argv[process.argv.indexOf(name) + 1]
const rejectInvalidRegex = ${JSON.stringify(rejectInvalidRegex)}
const server = http.createServer((req, res) => {
  req.resume()
  if (req.url === '/health') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ protocol: 1, request_body_limit: true }))
    return
  }
  if (req.url === '/v1/validate') {
    const raw = String(req.headers['x-kin-redact-policy'] || '')
    const policy = raw ? JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) : {}
    if (rejectInvalidRegex) {
      for (const rule of policy.rules || []) {
        if (rule.regex && rule.regex.includes('[')) {
          res.statusCode = 400
          res.end('invalid_redaction_config')
          return
        }
      }
    }
    res.statusCode = 204
    res.end()
    return
  }
  res.statusCode = 200
  res.end('{}')
})
server.listen(arg('-sock'), () => {
  fs.writeFileSync(arg('-capability'), 'synthetic-cap-' + process.pid)
})
process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
`,
    { mode: 0o700 },
  )
}

function makePanelHarness({
  routingConfig = {},
  maxBodyBytes = 32 * 1024 * 1024,
  persistRoutingPatch,
  projectRoot,
} = {}) {
  const response = {}
  const ctx = {
    cfg: { paths: { project: projectRoot || os.tmpdir() }, limits: { max_body_bytes: maxBodyBytes } },
    routingConfig,
    stickyRouter: { stats: () => ({}), reloadConfig() {} },
    accountQuota: { reloadConfig() {}, applyTierConcurrency() {}, applyTierRpm() {} },
    requestLog: { setConfig() {} },
    persistRoutingPatch:
      persistRoutingPatch ||
      (() => {
        throw new Error('must not persist invalid patch')
      }),
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
  }
  const invoke = async (method, body = {}) => {
    const handlePanel = createPanelHandler({
      ...ctx,
      readBody: async () => body,
    })
    await handlePanel({ method }, {}, new URL('http://localhost/api/panel/routing'))
    return { status: response.status, body: response.body }
  }
  return { invoke, ctx }
}

test('P1-04: ensureRedaction terminates old helper on policy replacement and disable, resetting redactionStatus', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-p1-04-runtime-'))
  const bin = path.join(root, 'bin', 'kin-redact')
  writeSyntheticRedactBin(bin)
  const children = []
  t.after(async () => {
    for (const child of children) {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close')
        child.kill()
        await closed
      }
    }
    publishRedactionForTests(null)
    fs.rmSync(root, { recursive: true, force: true })
  })

  publishRedactionForTests(null)
  const first = await ensureRedaction(
    { redaction: { enabled: true, secrets: true, personal: false, words: ['alpha'], rules: [] } },
    { projectRoot: root, binPath: bin },
  )
  children.push(first.child)
  assert.equal(redactionStatus().enabled, true)
  assert.equal(redactionStatus().ready, true)
  assert.equal(first.child.exitCode, null)

  // Policy replacement must terminate the previous helper before spawning the new one.
  const second = await ensureRedaction(
    { redaction: { enabled: true, secrets: true, personal: false, words: ['beta'], rules: [] } },
    { projectRoot: root, binPath: bin },
  )
  children.push(second.child)
  assert.notEqual(second.child.pid, first.child.pid)
  assert.ok(first.child.exitCode !== null || first.child.signalCode !== null)
  assert.equal(redactionStatus().enabled, true)
  assert.equal(redactionStatus().ready, true)

  // Disabling redaction must terminate the live helper and flip redactionStatus to disabled.
  await ensureRedaction(
    { redaction: { enabled: false, secrets: true, personal: false, words: ['beta'], rules: [] } },
    { projectRoot: root, binPath: bin },
  )
  assert.ok(second.child.exitCode !== null || second.child.signalCode !== null)
  assert.deepEqual(redactionStatus(), { enabled: false, ready: true, error: null })
})

test('P1-04: persistRoutingPatch disables live redaction runtime and PUT /api/panel/routing preserves 400 and rolls back on validate error', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-p1-04-panel-'))
  const bin = path.join(root, 'bin', 'kin-redact')
  const routingFile = path.join(root, 'routing.json')
  const previousBin = process.env.KIN_REDACT_BIN
  writeSyntheticRedactBin(bin, { rejectInvalidRegex: true })
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const routingConfig = {
    concurrency: {},
    tiers: {},
    redaction: { enabled: false, secrets: true, personal: true, words: [], rules: [], kinds: {}, allow: [] },
  }
  fs.writeFileSync(routingFile, JSON.stringify(routingConfig))
  process.env.KIN_REDACT_BIN = bin

  t.after(async () => {
    try {
      await ensureRedaction(
        { redaction: { enabled: false, secrets: true, personal: true } },
        { projectRoot: root, binPath: bin },
      )
    } finally {
      publishRedactionForTests(null)
      if (previousBin === undefined) delete process.env.KIN_REDACT_BIN
      else process.env.KIN_REDACT_BIN = previousBin
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  publishRedactionForTests(null)
  const runtime = createRoutingRuntime({
    cfg: { paths: { project: root } },
    routingConfigPath: routingFile,
    routingConfig,
    stickyRouter: { reloadConfig() {} },
    accountQuota: { reloadConfig() {}, applyTierConcurrency() {}, applyTierRpm() {} },
  })

  // Enable via persistRoutingPatch
  await runtime.persistRoutingPatch({
    redaction: { enabled: true, secrets: true, personal: false, words: [], rules: [] },
  })
  assert.deepEqual(redactionStatus(), { enabled: true, ready: true, error: null })

  // Disable via persistRoutingPatch must also call ensureRedaction and update redactionStatus
  await runtime.persistRoutingPatch({
    redaction: { enabled: false, secrets: true, personal: false, words: [], rules: [] },
  })
  assert.deepEqual(redactionStatus(), { enabled: false, ready: true, error: null })

  // Empty policy rejected at 400 validation stage before persist
  const harness = makePanelHarness({
    projectRoot: root,
    routingConfig,
    persistRoutingPatch: (patch) => runtime.persistRoutingPatch(patch),
  })
  const emptyRes = await harness.invoke('PUT', {
    redaction: { enabled: true, secrets: false, personal: false, words: [], rules: [] },
  })
  assert.equal(emptyRes.status, 400)
  assert.equal(emptyRes.body?.error?.code, 'invalid_redaction_config')
  assert.deepEqual(redactionStatus(), { enabled: false, ready: true, error: null })

  // Invalid RE2 regex caught during helper validate returns 400 (not 503) and restores prior disabled runtime
  const badRegexRes = await harness.invoke('PUT', {
    redaction: {
      enabled: true,
      secrets: true,
      personal: false,
      words: [],
      rules: [{ kind: 'BAD', prefix: '', regex: '[unclosed' }],
    },
  })
  assert.equal(badRegexRes.status, 400)
  assert.equal(badRegexRes.body?.error?.code, 'invalid_redaction_config')
  assert.deepEqual(redactionStatus(), { enabled: false, ready: true, error: null })
})

test('P2-03: eager_tool_streaming defaults to enabled when omitted and turns off only on explicit false', () => {
  assert.equal(eagerToolStreamingEnabled(undefined), true)
  assert.equal(eagerToolStreamingEnabled({}), true)
  assert.equal(eagerToolStreamingEnabled({ failover: {} }), true)
  assert.equal(eagerToolStreamingEnabled({ failover: { eager_tool_streaming: true } }), true)
  assert.equal(eagerToolStreamingEnabled({ failover: { eager_tool_streaming: false } }), false)

  const body = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'Write', input_schema: { type: 'object' } }],
  }
  assert.equal(applyEagerToolStreaming(body, {}).tools[0].eager_input_streaming, true)
  assert.equal(
    applyEagerToolStreaming(body, { failover: { eager_tool_streaming: false } }).tools[0].eager_input_streaming,
    undefined,
  )
})

test('P2-06: PUT /api/panel/routing rejects exhaustion_guard_new_session > exhaustion_guard_stop with 400', async () => {
  assert.throws(
    () => validateQuotaRoutingPatch({ quota: { exhaustion_guard_new_session: 0.95, exhaustion_guard_stop: 0.8 } }),
    (err) => err.code === 'invalid_quota_config',
  )
  // Valid ordering passes
  validateQuotaRoutingPatch({ quota: { exhaustion_guard_new_session: 0.85, exhaustion_guard_stop: 0.85 } })

  const { invoke } = makePanelHarness({
    routingConfig: { quota: { exhaustion_guard_new_session: 0.85, exhaustion_guard_stop: 0.9 } },
  })
  const res = await invoke('PUT', {
    quota: { exhaustion_guard_new_session: 0.95, exhaustion_guard_stop: 0.8 },
  })
  assert.equal(res.status, 400)
  assert.equal(res.body?.error?.code, 'invalid_quota_config')

  // Partial update against existing stop threshold is also validated
  const partialRes = await invoke('PUT', {
    quota: { exhaustion_guard_new_session: 0.95 },
  })
  assert.equal(partialRes.status, 400)
  assert.equal(partialRes.body?.error?.code, 'invalid_quota_config')
})

test('P2-07: GET /api/panel/routing exposes effective KIN_MAX_BODY ceiling', async () => {
  const { invoke } = makePanelHarness({ maxBodyBytes: 48 * 1024 * 1024 })
  const res = await invoke('GET')
  assert.equal(res.status, 200)
  assert.equal(res.body?.data?.max_body_bytes, 48 * 1024 * 1024)
  assert.equal(res.body?.data?.max_body_mib, 48)
})

test('P2-08: PUT /api/panel/routing validates codex.catalog_client_version against auto or semver', async () => {
  validateInferenceWebsocketPatch({ codex: { catalog_client_version: 'auto' } })
  validateInferenceWebsocketPatch({ codex: { catalog_client_version: '0.170.0' } })
  validateInferenceWebsocketPatch({ codex: { catalog_client_version: 'v0.171.2' } })
  for (const bad of ['', '   ', 'latest', '0.170', '1.2.3-beta', 123]) {
    assert.throws(
      () => validateInferenceWebsocketPatch({ codex: { catalog_client_version: bad } }),
      (err) => err.code === 'invalid_catalog_client_version',
    )
  }

  const { invoke } = makePanelHarness()
  const res = await invoke('PUT', { codex: { catalog_client_version: 'latest' } })
  assert.equal(res.status, 400)
  assert.equal(res.body?.error?.code, 'invalid_catalog_client_version')
})

test('P2-10: strict redaction validation rejects blank rules and length/count overflows while disk normalize stays legacy-tolerant', async () => {
  // Legacy tolerant disk read still skips blank rule entries
  const legacy = normalizeRedaction({
    enabled: false,
    secrets: true,
    personal: true,
    rules: [{ kind: 'EMPTY', prefix: '  ', regex: '' }],
  })
  assert.deepEqual(legacy.rules, [])

  // Strict API validation rejects blank rules, too-short/long prefixes, and >300-byte regexes
  assert.throws(
    () =>
      validateRedactionPatch({
        redaction: { enabled: false, secrets: true, personal: true, rules: [{ kind: 'EMPTY', prefix: '', regex: '' }] },
      }),
    { code: 'invalid_redaction_config', status: 400 },
  )
  assert.throws(
    () =>
      validateRedactionPatch({
        redaction: {
          enabled: false,
          secrets: true,
          personal: true,
          rules: [{ kind: 'SHORT', prefix: 'ab', regex: '' }],
        },
      }),
    { code: 'invalid_redaction_config', status: 400 },
  )
  assert.throws(
    () =>
      validateRedactionPatch({
        redaction: {
          enabled: false,
          secrets: true,
          personal: true,
          rules: [{ kind: 'LONG', prefix: 'a'.repeat(65), regex: '' }],
        },
      }),
    { code: 'invalid_redaction_config', status: 400 },
  )
  assert.throws(
    () =>
      validateRedactionPatch({
        redaction: {
          enabled: false,
          secrets: true,
          personal: true,
          rules: [{ kind: 'LONG_RE', prefix: '', regex: 'a'.repeat(301) }],
        },
      }),
    { code: 'invalid_redaction_config', status: 400 },
  )

  const { invoke } = makePanelHarness()
  const res = await invoke('PUT', {
    redaction: {
      enabled: true,
      secrets: true,
      personal: true,
      rules: [{ kind: 'BLANK', prefix: '', regex: '' }],
    },
  })
  assert.equal(res.status, 400)
  assert.equal(res.body?.error?.code, 'invalid_redaction_config')
})

test('P2-13: PUT /api/panel/routing rejects out-of-range logging bounds and debug_retain_days > retain_days with 400', async () => {
  // Valid payload passes
  validateLoggingRoutingPatch({ logging: { mode: 'normal', retain_days: 7, debug_retain_days: 3, max_mb: 2048 } })
  validateLoggingRoutingPatch({ logging: { retain_days: 90, debug_retain_days: 90, max_mb: 102400 } })
  validateLoggingRoutingPatch({ logging: { max_mb: 0 } })
  // Legacy disk normalization keeps clamping compatibility
  assert.equal(normalizeLoggingConfig({ retain_days: 2, debug_retain_days: 10 }).debug_retain_days, 2)

  const { invoke } = makePanelHarness({
    routingConfig: { logging: { mode: 'normal', retain_days: 7, debug_retain_days: 3, max_mb: 2048 } },
  })
  for (const logging of [
    { retain_days: 0 },
    { retain_days: 91 },
    { debug_retain_days: 0 },
    { retain_days: 5, debug_retain_days: 6 },
    { max_mb: -1 },
    { max_mb: 102401 },
    { mode: 'verbose' },
  ]) {
    const res = await invoke('PUT', { logging })
    assert.equal(res.status, 400, JSON.stringify(logging))
    assert.equal(res.body?.error?.code, 'invalid_logging_config', JSON.stringify(logging))
  }
})
