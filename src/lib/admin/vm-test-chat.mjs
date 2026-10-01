/**
 * Per-VM connectivity probe.
 *
 * Claude slots loopback POST /v1/messages.
 * Codex/GPT slots loopback POST /v1/responses.
 * Pin with master-only x-kin-vm. Does not call the Go worker directly.
 *
 * Full OAuth Claude slots mimic official Claude Code (UA + 4-block rewrite).
 * Setup Token / Console Key use inference-style inbound: unofficial test UA, no
 * official four-gate inbound (context-1m / CC session scope would 401).
 */
import http from 'node:http'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import { readRoutingConfigFile } from '../core/config.mjs'
import { getVm, vmHasClaudeCredential } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { summarizeCodexSlot, readCodexAccounts, writeCodexAccounts } from '../vm/codex-slot.mjs'
import { boundProxyUrl, isLocalEgressProxy, localEgressProxyUrl } from '../vm/egress.mjs'
import { loadVmIdentity } from '../identity/vm-identity.mjs'
import { snapshotOauth } from '../vm/execution-context.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { applyCrsUnofficialPersona } from '../identity/crs-persona.mjs'
import { claudeCodeInboundBody, claudeCodeInboundHeaders } from '../protocol/claude-code-inbound.mjs'
import { credentialModeFromOauth, credentialModeOfVm } from '../oauth/credential-mode.mjs'
import { isModelEnabled, getModelParams, getCapabilities, listPolicyModels } from '../protocol/model-policy.mjs'
import { listGptPolicyModels, isGptModelEnabled, syncGptIdsIntoPolicy } from '../protocol/gpt-model-policy.mjs'
import { listOfficialModels, validateOfficialModel } from '../protocol/models.mjs'
import {
  fetchChatgptModelCatalog,
  refreshCodexAccessToken,
  resolveCodexCatalogVersion,
  CODEX_USER_AGENT,
} from '../protocol/codex-models.mjs'
import { isGptSeriesId } from '../protocol/gpt-ids.mjs'
import {
  resolveInferenceEngine,
  resolveOfficialCcInference,
  resolveCliSystemLayout,
  resolveKernelDataplane,
} from '../vm/slot-engine.mjs'
import {
  codexTextInput,
  DEFAULT_CODEX_REASONING_EFFORT,
  normalizeCodexReasoningEffort,
} from '../protocol/codex-convert.mjs'

const DEFAULT_PROMPT = 'hello'
const DEFAULT_MAX_TOKENS = 64
const DEFAULT_BASE_URL = 'http://127.0.0.1:8787'

export function normalizeTestPlatform(platform) {
  const s = String(platform || '')
    .trim()
    .toLowerCase()
  if (s === 'openai' || s === 'gpt' || s === 'codex' || s === 'chatgpt') return 'openai'
  if (s === 'anthropic' || s === 'claude') return 'anthropic'
  return 'all'
}

export function isGptTestModel(model = {}) {
  const id = typeof model === 'string' ? model : model?.id
  const family = typeof model === 'object' && model ? String(model.family || '').toLowerCase() : ''
  return family === 'codex' || isGptSeriesId(id)
}

function gptRank(id) {
  const s = String(id || '').toLowerCase()
  const mini = /mini|nano/.test(s) ? 1 : 0
  const m = s.match(/gpt-(\d+)(?:\.(\d+))?/i) || s.match(/codex-(\d+)(?:\.(\d+))?/i)
  const major = m ? Number(m[1]) : 0
  const minor = m && m[2] ? Number(m[2]) : 0
  return mini * 1000 - major * 10 - minor
}

export function listTestableModels(platform) {
  const kind = normalizeTestPlatform(platform)
  const rank = (id) => {
    if (kind === 'openai' || isGptSeriesId(id)) return gptRank(id)
    const s = String(id || '').toLowerCase()
    if (s.includes('haiku')) return 0
    if (s.includes('sonnet')) return 1
    if (s.includes('opus')) return 2
    return 3
  }
  const map = (m, source) => ({
    id: m.id,
    label: m.label || m.display_name || m.id,
    family: m.family || (isGptSeriesId(m.id) ? 'codex' : ''),
    source,
  })
  if (kind === 'openai') {
    return listGptPolicyModels()
      .map((m) => map(m, 'gpt-policy'))
      .sort((a, b) => rank(a.id) - rank(b.id) || String(a.id).localeCompare(String(b.id)))
  }
  const effective = listOfficialModels().map((m) => map(m, 'effective'))
  const list = effective.length
    ? effective
    : listPolicyModels()
        .filter((m) => m.enabled !== false)
        .map((m) => map(m, 'policy'))
  const filtered = list.filter((m) => !isGptTestModel(m))
  return filtered.sort((a, b) => rank(a.id) - rank(b.id) || String(a.id).localeCompare(String(b.id)))
}

export function testModelsView(platform) {
  const kind = normalizeTestPlatform(platform)
  return {
    items: listTestableModels(kind),
    platform: kind,
    protocol: kind === 'openai' ? 'openai.responses' : kind === 'anthropic' ? 'anthropic.messages' : null,
    inbound_path: kind === 'openai' ? '/v1/responses' : kind === 'anthropic' ? '/v1/messages' : null,
  }
}

function listCodexVmsForCatalog(projectRoot, vm) {
  if (vm && isCodexVm(vm)) return [vm]
  const dir = path.join(projectRoot, 'vms')
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || name === 'active.json') continue
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (raw?.id && isCodexVm(raw)) out.push(raw)
    } catch {}
  }
  return out
}

function persistRefreshedCodexAccount(projectRoot, vmId, patch = {}, previous = {}) {
  const accounts = readCodexAccounts(projectRoot, vmId)
  let idx = accounts.findIndex(
    (row) =>
      (previous.refresh_token && row.refresh_token === previous.refresh_token) ||
      (previous.access_token && row.access_token === previous.access_token),
  )
  if (idx < 0) idx = 0
  const cur = { ...(accounts[idx] || {}), ...patch }
  if (!cur.id) cur.id = cur.email || cur.chatgpt_account_id || 'codex'
  if (!accounts.length) accounts.push(cur)
  else accounts[idx] = cur
  writeCodexAccounts(projectRoot, vmId, accounts)
  return cur
}

/**
 * Pull ChatGPT GPT/Codex ids into model_policy.
 * rotate=true (panel sync) may refresh OAuth via refresh_token.
 * rotate=false (test-models probe) never rotates.
 */
export async function syncCodexCatalog({
  projectRoot,
  vmId,
  fetchImpl,
  rotate = true,
  catalogClientVersion = 'auto',
} = {}) {
  if (!projectRoot) {
    return { ok: false, error: 'invalid_request', message: 'projectRoot required', ids: [], synced: 0 }
  }
  const vm = vmId ? getVm(projectRoot, vmId) : null
  const targets = listCodexVmsForCatalog(projectRoot, vm && isCodexVm(vm) ? vm : null)
  if (!targets.length) {
    return { ok: false, error: 'no_codex_slot', message: '没有可用的 GPT OAuth 槽', ids: [], synced: 0 }
  }
  const catalogVersion = await resolveCodexCatalogVersion({
    configuredVersion: catalogClientVersion,
    cachePath: path.join(
      String(process.env.KIN_DATA_DIR || '').trim() || path.join(projectRoot, 'data'),
      'codex-catalog-client.json',
    ),
    // Unit callers can provide the already resolved version while keeping
    // their fetch mock reserved for ChatGPT catalog traffic.
  })
  if (!catalogVersion.ok) {
    return {
      ok: false,
      error: catalogVersion.error,
      message: '无法获取 Codex catalog client 版本',
      ids: [],
      synced: 0,
    }
  }
  const merged = new Map()
  let usedVm = null
  let lastError = null
  for (const target of targets) {
    const proxyUrl = boundProxyUrl(target.proxy) || localEgressProxyUrl(target.proxy)
    const direct = isLocalEgressProxy(target.proxy) && !proxyUrl
    if (!proxyUrl && !fetchImpl && !direct) {
      lastError = {
        ok: false,
        error: 'proxy_required',
        message: 'GPT 槽未绑定 SOCKS5',
        vm_id: target.id,
      }
      continue
    }
    const accounts = readCodexAccounts(projectRoot, target.id)
    const rows = accounts.length ? accounts : [target.codex || {}]
    for (const account of rows) {
      let access = account.access_token || target.codex?.access_token
      const accountId = account.chatgpt_account_id || target.codex?.chatgpt_account_id
      const refreshToken = account.refresh_token || target.codex?.refresh_token
      const fetchOnce = () =>
        fetchChatgptModelCatalog({
          accessToken: access,
          accountId,
          proxyUrl,
          fetchImpl,
          direct,
          catalogVersion: catalogVersion.version,
        })
      let live = await fetchOnce()
      if (live.error === 'upstream_auth' && rotate && refreshToken) {
        const tok = await refreshCodexAccessToken({ refreshToken, proxyUrl, fetchImpl })
        if (!tok.ok) {
          lastError = {
            ok: false,
            error: tok.error || 'refresh_failed',
            message: 'GPT OAuth 刷新失败，请重新登录',
            vm_id: target.id,
          }
          continue
        }
        persistRefreshedCodexAccount(
          projectRoot,
          target.id,
          {
            access_token: tok.access_token,
            refresh_token: tok.refresh_token,
            id_token: tok.id_token || account.id_token,
            expires_at: tok.expires_at || account.expires_at,
          },
          account,
        )
        access = tok.access_token
        live = await fetchOnce()
      }
      if (!live.ok || !live.ids?.length) {
        const auth = live.error === 'upstream_auth'
        lastError = {
          ok: false,
          error: live.error || 'empty_catalog',
          message: auth ? 'GPT OAuth 已过期，请重新登录' : '同步 GPT 目录失败',
          vm_id: target.id,
        }
        continue
      }
      usedVm = target.id
      const rowsLive = live.models?.length ? live.models : live.ids.map((id) => ({ id }))
      for (const row of rowsLive) {
        const id = String(row?.id || row || '').trim()
        if (!id) continue
        merged.set(id.toLowerCase(), typeof row === 'object' ? row : { id })
      }
    }
  }
  if (!merged.size) {
    return {
      ok: false,
      error: lastError?.error || 'empty_catalog',
      message: lastError?.message || '同步 GPT 目录失败',
      vm_id: lastError?.vm_id || targets[0].id,
      catalog_version: catalogVersion.version,
      ids: [],
      synced: 0,
    }
  }
  const models = [...merged.values()]
  syncGptIdsIntoPolicy(models)
  return {
    ok: true,
    vm_id: usedVm,
    catalog_version: catalogVersion.version,
    ids: models.map((row) => row.id),
    synced: models.length,
    source: 'chatgpt',
  }
}

async function refreshCodexCatalogFromSlot({ projectRoot, vm, fetchImpl, catalogClientVersion = 'auto' } = {}) {
  const result = await syncCodexCatalog({
    projectRoot,
    vmId: vm?.id,
    fetchImpl,
    rotate: false,
    catalogClientVersion,
  })
  if (!result.ok) return { ok: false, error: result.error, ids: result.ids || [] }
  return { ok: true, ids: result.ids, source: result.source }
}

/**
 * Panel test-model dropdown. vm_id wins over platform.
 * refresh=true hops ChatGPT /backend-api/models via the slot SOCKS; 401 does not rotate OAuth.
 */
export async function resolveTestModels({
  projectRoot,
  vmId,
  platform,
  refresh = false,
  fetchImpl,
  catalogClientVersion = 'auto',
} = {}) {
  const vm = vmId && projectRoot ? getVm(projectRoot, vmId) : null
  const kind = vm ? (isCodexVm(vm) ? 'openai' : 'anthropic') : normalizeTestPlatform(platform)
  let source = 'policy'
  if (refresh && kind === 'openai' && projectRoot) {
    const live = await refreshCodexCatalogFromSlot({
      projectRoot,
      vm: vm && isCodexVm(vm) ? vm : null,
      fetchImpl,
      catalogClientVersion,
    })
    if (live.ok) source = 'chatgpt'
  }
  return { ...testModelsView(kind), source }
}

function extractText(body) {
  if (!body || typeof body !== 'object') return ''
  const blocks = Array.isArray(body.content) ? body.content : []
  const parts = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && b.text) parts.push(String(b.text))
    else if (b.type === 'thinking' && b.thinking) parts.push('[thinking] ' + String(b.thinking).slice(0, 200))
  }
  if (parts.length) return parts.join('\n')
  if (typeof body.output_text === 'string' && body.output_text) return body.output_text
  const err = body.error
  if (err && typeof err === 'object') {
    const bits = [err.message, err.type, err.code].filter((x) => x && String(x) !== 'Error')
    if (bits.length) return bits.join(' · ')
    try {
      return JSON.stringify(err).slice(0, 800)
    } catch {}
  }
  if (typeof body.message === 'string' && body.message && body.message !== 'Error') return body.message
  try {
    return JSON.stringify(body).slice(0, 800)
  } catch {
    return ''
  }
}

function extractError(result, { wrapHop = true } = {}) {
  const body = result?.body
  const err = body?.error && typeof body.error === 'object' ? body.error : {}
  const headers = result?.headers || {}
  const retry = headers['retry-after'] || headers['anthropic-ratelimit-requests-reset'] || null
  const requestId = headers['request-id'] || headers['x-request-id'] || err.request_id || null
  let message = extractText(body) || 'upstream error'
  const code = String(err.code || '')
  const blob = code + message
  if (!wrapHop && /ENOENT|bin_missing|codex-kernel|codex_kernel/i.test(blob)) {
    message = 'Codex kernel 未就绪。GPT 槽走独立 kernel，不是 wrap cli-hop。'
  } else if (wrapHop && /GLIBC_2\.3[89]|glibc 2\.36|ld-linux.*not found/i.test(blob)) {
    message =
      'wrap cli-hop 未就绪，未回退 Go HTTP（避免 OAuth extra usage）。Debian 12 / glibc 2.36 跑不了当前 wrap kernel。'
  } else if (
    wrapHop &&
    /rust_unavailable|bin_missing|kernel_binary|kernel_start_failed|kernel_health|kernel\.sock/i.test(blob)
  ) {
    message = 'wrap cli-hop 未就绪，未回退 Go HTTP（避免 OAuth extra usage）。'
  } else if (wrapHop && /no free slot|slot_busy/i.test(blob)) {
    message = 'VM 内核槽已占满（不是 Anthropic 上游）。连续 session 半截后槽没释放。'
  } else if (wrapHop && /provider error:.*connection error/i.test(blob)) {
    message = 'VM wrap CLI 连接失败（不是 Anthropic 上游）。已回收槽内 kernel 并应同号重试。'
  } else if (
    result?.status === 429 &&
    (message === 'Error' || /rate_limit/i.test(message) || message === 'upstream error')
  ) {
    message = wrapHop
      ? '上游 429 rate_limit（OAuth extra usage / 模型额度）。rust 槽测试应走 cli-hop，不应回退 Go HTTP。'
      : '上游 429 rate_limit。'
  }
  const slotBusy = /no free slot|slot_busy/i.test(blob)
  const wrapConn = /provider error:.*connection error|wrap_connection_error/i.test(blob)
  const out = {
    type:
      err.type ||
      (result?.status === 429
        ? 'rate_limit_error'
        : slotBusy
          ? 'overloaded_error'
          : wrapConn
            ? 'api_error'
            : 'upstream_error'),
    code:
      err.code ||
      (result?.status === 429
        ? 'upstream_rate_limit'
        : slotBusy
          ? 'slot_busy'
          : wrapConn
            ? 'wrap_connection_error'
            : 'upstream_error'),
    message,
  }
  if (retry) out.retry_after = retry
  if (requestId) out.request_id = requestId
  if (result?.status) out.status = result.status
  if (err.message && err.message !== message) out.upstream_message = String(err.message).slice(0, 400)
  return out
}

function looksLikeCodexUnauthorized(result) {
  if (Number(result?.status) === 401) return true
  const err = extractError(result)
  const blob = `${result?.status || ''} ${err.code || ''} ${err.message || ''} ${JSON.stringify(result?.body || {})}`
  return /\b401\b|unauthorized/i.test(blob)
}

function loadRouting(projectRoot) {
  return readRoutingConfigFile(projectRoot)
}

export function buildVmTestInbound({
  model,
  prompt,
  maxTokens,
  sessionId,
  deviceId,
  accountUuid,
  identity = null,
  rewrite = false,
  personaMode = 'rewrite',
} = {}) {
  const caps = getCapabilities(model) || {}
  const thinking = caps.requires_adaptive || caps.thinking_mode === 'adaptive_only' ? { type: 'adaptive' } : null
  let inbound = claudeCodeInboundBody({
    model,
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
    thinking,
    sessionId,
    deviceId,
    accountUuid,
    stream: true,
  })
  if (rewrite) {
    // Force the official system shape first. Do not pass officialClient /
    // official headers here — that would skip rewrite and leave a string system.
    // The complete request (UA + user_id + rewritten body) is what /v1 classifies.
    inbound = applyCrsUnofficialPersona(inbound, {
      officialClient: false,
      mode: personaMode,
      sessionId,
      model,
      ...(identity ? { identity } : {}),
    })
  }
  const headers = claudeCodeInboundHeaders({ sessionId })
  return { inbound, headers }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function testChatCredentialMode(vm = {}) {
  if (isCodexVm(vm)) return 'codex'
  const inferred = credentialModeFromOauth({
    type: vm.claude?.type || vm.claude?.mode,
    mode: vm.claude?.mode,
    scope: vm.claude?.scope,
    scopes: vm.claude?.scopes,
    flavor: vm.claude?.flavor,
    source: vm.claude?.source,
  })
  if (inferred === 'setup-token' || inferred === 'apikey') return inferred
  return credentialModeOfVm(vm)
}

export function slotTestIdentity(projectRoot, vm) {
  const homeDir = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  const identity = loadVmIdentity({
    vmId: vm.id,
    homeDir,
    timezone: vm.timezone,
    locale: vm.locale,
    oauth: snapshotOauth(vm),
    vm,
  })
  const prevSession = String(identity.sessionId || vm.fingerprint?.session_id || '').trim()
  const sessionId =
    UUID_RE.test(prevSession) && !/^vm-test-/i.test(prevSession) ? prevSession : globalThis.crypto.randomUUID()
  if (vm.fingerprint?.session_id !== sessionId && sessionId) {
    try {
      const vmPath = path.join(projectRoot, 'vms', `${vm.id}.json`)
      atomicWriteJson(
        vmPath,
        {
          ...vm,
          fingerprint: { ...(vm.fingerprint || {}), session_id: sessionId },
          updated_at: new Date().toISOString(),
        },
        { mode: 0o600 },
      )
    } catch {}
  }
  return {
    deviceId: identity.deviceId,
    accountUuid: identity.accountUuid,
    sessionId,
    identity_source: identity.fingerprint?.identity_source || null,
    identity: { ...identity, sessionId },
  }
}

function parseSseBuffer(buffer, onEvent) {
  let rest = buffer
  for (;;) {
    const idx = rest.indexOf('\n')
    if (idx < 0) return rest
    let line = rest.slice(0, idx)
    rest = rest.slice(idx + 1)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line.startsWith('data:')) continue
    const raw = line.slice(5).trim()
    if (!raw || raw === '[DONE]') continue
    try {
      onEvent(JSON.parse(raw))
    } catch {}
  }
}

async function consumeMessagesResponse(res) {
  const status = res.status
  const headers = {}
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v
  })
  if (status < 200 || status >= 300) {
    let body = null
    try {
      body = await res.json()
    } catch {
      try {
        body = { error: { message: await res.text() } }
      } catch {
        body = { error: { message: 'upstream error' } }
      }
    }
    return { ok: false, status, headers, body, text: '', usage: null, stop_reason: null, model: null }
  }

  const ctype = String(headers['content-type'] || '')
  if (!ctype.includes('text/event-stream') && !ctype.includes('text/plain')) {
    const body = await res.json().catch(() => null)
    const blocks = Array.isArray(body?.content) ? body.content : []
    const text = blocks
      .filter((b) => b?.type === 'text')
      .map((b) => b.text || '')
      .join('')
    return {
      ok: true,
      status,
      headers,
      body,
      text,
      usage: body?.usage || null,
      stop_reason: body?.stop_reason || null,
      model: body?.model || null,
      vm_id: body?.kin?.vm_id || null,
    }
  }

  const blocks = []
  let usage = null
  let stopReason = null
  let stopSequence = null
  let model = null
  let messageId = null
  let lastError = null
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const onEvent = (ev) => {
    if (!ev || typeof ev !== 'object') return
    if (ev.type === 'message_start' && ev.message) {
      if (ev.message.id) messageId = ev.message.id
      if (ev.message.usage) usage = { ...usage, ...ev.message.usage }
      if (ev.message.model) model = ev.message.model
    }
    if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason
      if (ev.delta && Object.prototype.hasOwnProperty.call(ev.delta, 'stop_sequence')) {
        stopSequence = ev.delta.stop_sequence
      }
      if (ev.usage) usage = { ...usage, ...ev.usage }
    }
    if (ev.type === 'content_block_start' && ev.content_block) {
      blocks[ev.index] = { ...ev.content_block }
    } else if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index] || {}
      const d = ev.delta || {}
      if (d.type === 'text_delta') b.text = (b.text || '') + (d.text || '')
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + (d.thinking || '')
      else if (d.type === 'signature_delta' && d.signature) b.signature = d.signature
      blocks[ev.index] = b
    } else if (ev.type === 'error') {
      lastError = ev.error || ev
    }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    buf = parseSseBuffer(buf, onEvent)
  }
  if (buf) parseSseBuffer(buf + '\n', onEvent)

  const compact = blocks.filter(Boolean)
  const text = compact
    .filter((b) => b.type === 'text')
    .map((b) => b.text || '')
    .join('')
  if (lastError) {
    return {
      ok: false,
      status,
      headers,
      body: { error: lastError },
      text,
      usage,
      stop_reason: stopReason,
      model,
    }
  }
  return {
    ok: true,
    status,
    headers,
    body: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: compact,
      stop_reason: stopReason,
      stop_sequence: stopSequence,
      usage,
    },
    text,
    usage,
    stop_reason: stopReason,
    model,
  }
}

function extractResponsesText(body) {
  if (!body || typeof body !== 'object') return ''
  if (typeof body.output_text === 'string' && body.output_text) return body.output_text
  const out = Array.isArray(body.output) ? body.output : []
  const parts = []
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : []
    for (const c of content) {
      if (!c || typeof c !== 'object') continue
      if ((c.type === 'output_text' || c.type === 'text') && c.text) parts.push(String(c.text))
    }
  }
  return parts.join('')
}

async function consumeResponsesResponse(res) {
  const status = res.status
  const headers = {}
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v
  })
  if (status < 200 || status >= 300) {
    let body = null
    try {
      body = await res.json()
    } catch {
      try {
        body = { error: { message: await res.text() } }
      } catch {
        body = { error: { message: 'upstream error' } }
      }
    }
    return { ok: false, status, headers, body, text: '', usage: null, stop_reason: null, model: null }
  }

  const ctype = String(headers['content-type'] || '')
  if (!ctype.includes('text/event-stream') && !ctype.includes('text/plain')) {
    const body = await res.json().catch(() => null)
    return {
      ok: true,
      status,
      headers,
      body,
      text: extractResponsesText(body),
      usage: body?.usage || null,
      stop_reason: body?.status || body?.stop_reason || null,
      model: body?.model || null,
      vm_id: body?.kin?.vm_id || null,
    }
  }

  let text = ''
  let usage = null
  let model = null
  let responseId = null
  let lastError = null
  let stopReason = null
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const onEvent = (ev) => {
    if (!ev || typeof ev !== 'object') return
    const type = String(ev.type || '')
    if (type === 'response.output_text.delta') {
      text += String(ev.delta || ev.text || '')
      return
    }
    if (type === 'response.completed' && ev.response) {
      if (ev.response.id) responseId = ev.response.id
      if (ev.response.model) model = ev.response.model
      if (ev.response.usage) usage = ev.response.usage
      const completed = extractResponsesText(ev.response)
      if (completed && !text) text = completed
      stopReason = ev.response.status || 'completed'
      return
    }
    if (type === 'error' || type === 'response.failed') {
      lastError = ev.error || ev.response?.error || ev
    }
    if (ev.model) model = ev.model
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    buf = parseSseBuffer(buf, onEvent)
  }
  if (buf) parseSseBuffer(buf + '\n', onEvent)

  if (lastError) {
    return {
      ok: false,
      status,
      headers,
      body: { error: lastError, id: responseId },
      text,
      usage,
      stop_reason: stopReason,
      model,
    }
  }
  return {
    ok: true,
    status,
    headers,
    body: {
      id: responseId,
      object: 'response',
      model,
      output_text: text,
      usage,
      status: stopReason || 'completed',
    },
    text,
    usage,
    stop_reason: stopReason,
    model,
  }
}

function freshLoopbackRequest(rawUrl, init = {}) {
  const target = new URL(rawUrl)
  if (target.protocol !== 'http:') throw new Error('loopback requires http')
  const payload = init.body == null ? null : Buffer.from(String(init.body))
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: init.method || 'GET',
        headers: {
          ...(init.headers || {}),
          ...(payload ? { 'content-length': payload.byteLength } : {}),
          connection: 'close',
        },
        agent: false,
        signal: init.signal,
      },
      (res) => {
        const status = Number(res.statusCode) || 500
        const body = status === 204 || status === 304 ? null : Readable.toWeb(res)
        resolve(new Response(body, { status, statusText: res.statusMessage, headers: res.headers }))
      },
    )
    req.once('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function postV1Loopback({ path, baseUrl, apiKey, inbound, headers, vmId, timeoutMs, extraHeaders = {} }) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const endpoint = path === '/v1/responses' ? '/v1/responses' : '/v1/messages'
  try {
    const res = await freshLoopbackRequest(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'x-kin-vm': vmId,
        'x-session-id': headers['x-claude-code-session-id'] || '',
        ...headers,
        ...extraHeaders,
      },
      body: JSON.stringify(inbound),
      signal: ac.signal,
    })
    return endpoint === '/v1/responses' ? await consumeResponsesResponse(res) : await consumeMessagesResponse(res)
  } catch (e) {
    const aborted = ac.signal.aborted
    return {
      ok: false,
      status: 0,
      headers: {},
      body: {
        error: {
          type: aborted ? 'cancelled' : 'worker_error',
          code: aborted ? 'aborted' : e.cause?.code || e.code || 'fetch_error',
          message: aborted ? `loopback ${endpoint} timed out` : String(e.message || e).slice(0, 300),
        },
      },
      text: '',
      usage: null,
      stop_reason: null,
      model: null,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function postV1Messages(opts) {
  return postV1Loopback({ ...opts, path: '/v1/messages' })
}

async function postV1Responses(opts) {
  return postV1Loopback({ ...opts, path: '/v1/responses' })
}

/**
 * @param {{ projectRoot: string, vmId: string, model?: string, prompt?: string, max_tokens?: number, timeoutMs?: number, baseUrl?: string, apiKey?: string, accountQuota?: object }} opts
 */
export async function runVmTestChat(opts = {}) {
  const projectRoot = opts.projectRoot
  const vmId = String(opts.vmId || '').trim()
  const started = Date.now()
  const log = []
  const push = (level, message) => {
    log.push({ at: new Date().toISOString(), level, message: String(message) })
  }
  const done = (payload) => payload

  if (!projectRoot || !vmId) {
    return done({ ok: false, error: { code: 'invalid_request', message: 'vm_id required' }, log, duration_ms: 0 })
  }

  const apiKey = String(opts.apiKey || '').trim()
  if (!apiKey) {
    return done({
      ok: false,
      error: { code: 'missing_api_key', message: 'gateway master key missing' },
      log,
      duration_ms: 0,
    })
  }
  const baseUrl = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')

  const vm = getVm(projectRoot, vmId)
  if (!vm) {
    return done({ ok: false, error: { code: 'vm_not_found', message: `vm not found: ${vmId}` }, log, duration_ms: 0 })
  }

  push('info', `开始测试凭证槽 ${vm.name || vmId}`)
  push('info', `状态 running=${vm.status === 'running'} schedulable=${vm.schedulable !== false}`)
  const routing = loadRouting(projectRoot)
  const codex = isCodexVm(vm)
  const inferenceEngine = codex ? null : resolveInferenceEngine(vm, routing)
  const cliHop = !codex && resolveOfficialCcInference(vm, routing) === 'cli-hop'
  const dataplane = codex ? null : resolveKernelDataplane(vm, routing) || 'wrap'
  push(
    'info',
    codex
      ? '推理 codex-kernel / ChatGPT'
      : cliHop
        ? `推理 ${inferenceEngine} / cli-hop ${dataplane}`
        : `推理 ${inferenceEngine} / http hop`,
  )

  const credMode = testChatCredentialMode(vm)
  if (codex) {
    const slot = summarizeCodexSlot(projectRoot, vm)
    if (!slot.has_token) {
      push('error', '无 Codex OAuth')
      return done({
        ok: false,
        vm_id: vmId,
        error: { code: 'no_credential', message: 'VM has no Codex credential' },
        log,
        duration_ms: Date.now() - started,
      })
    }
  } else if (!vmHasClaudeCredential(vm)) {
    push('error', '无 OAuth / Setup Token / Console Key')
    return done({
      ok: false,
      vm_id: vmId,
      error: { code: 'no_credential', message: 'VM has no Claude credential' },
      log,
      duration_ms: Date.now() - started,
    })
  }
  const unofficial =
    !codex && (cliHop || opts.unofficial === true || credMode === 'setup-token' || credMode === 'apikey')
  const cliLayout = !codex && cliHop ? resolveCliSystemLayout(vm, routing) : null
  push(
    'info',
    codex
      ? '凭证 Codex OAuth · OpenAI Responses 入站'
      : `凭证 ${credMode}${
          cliHop
            ? cliLayout === 'identity'
              ? ' · cli-hop CLI 官方提示词'
              : ' · cli-hop 0注入'
            : unofficial
              ? ' · 非官方 inference 入站'
              : ' · 官方 Claude Code 入站'
        }`,
  )

  if (!vm.proxy?.url && !vm.proxy?.host) {
    push('error', '未绑定 SOCKS5，拒绝测试。请先绑代理，不要测无出口的旧槽。')
    return done({
      ok: false,
      vm_id: vmId,
      error: { code: 'proxy_required', message: 'slot SOCKS5 is required for test-chat' },
      log,
      duration_ms: Date.now() - started,
    })
  }
  push('info', `代理 ${vm.proxy?.host || 'bound'}`)

  let model = String(opts.model || '').trim()
  if (!model) {
    const models = listTestableModels(codex ? 'openai' : 'anthropic')
    model = models[0]?.id || (codex ? 'gpt-5.4' : 'claude-haiku-4-5-20251001')
  }
  push('info', `模型 ${model}`)

  if (codex) {
    if (!isGptSeriesId(model) || !isGptModelEnabled(model)) {
      push('error', `模型不可用: ${model}`)
      return done({
        ok: false,
        vm_id: vmId,
        model,
        error: { code: 'model_not_allowed', message: 'GPT slot only accepts GPT models' },
        log,
        duration_ms: Date.now() - started,
      })
    }
  } else {
    const validated = validateOfficialModel(model)
    if (validated?.error) {
      push('error', `模型不可用: ${validated.error.message || validated.error}`)
      return done({
        ok: false,
        vm_id: vmId,
        model,
        error: validated.error || { code: 'model_not_allowed', message: 'model not allowed' },
        log,
        duration_ms: Date.now() - started,
      })
    }
    if (!isModelEnabled(model)) {
      push('error', '模型在策略中已禁用')
      return done({
        ok: false,
        vm_id: vmId,
        model,
        error: { code: 'model_disabled', message: 'model disabled by policy' },
        log,
        duration_ms: Date.now() - started,
      })
    }
  }
  if (codex !== isGptTestModel(model)) {
    const message = codex ? 'Codex slot only accepts GPT models' : 'Claude slot only accepts Claude models'
    push('error', message)
    return done({
      ok: false,
      vm_id: vmId,
      model,
      error: { code: 'model_not_allowed', message },
      log,
      duration_ms: Date.now() - started,
    })
  }

  const prompt = String(opts.prompt || DEFAULT_PROMPT).trim() || DEFAULT_PROMPT
  const params = getModelParams(model) || {}
  const caps = getCapabilities(model) || {}
  const rawEffort = opts.reasoning_effort ?? opts.effort
  const effort = normalizeCodexReasoningEffort(
    rawEffort == null || rawEffort === '' ? (codex ? DEFAULT_CODEX_REASONING_EFFORT : '') : rawEffort,
  )
  let maxTokens = Number(opts.max_tokens)
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    maxTokens = Number(params.max_tokens_default) || DEFAULT_MAX_TOKENS
  }
  maxTokens = Math.min(Math.max(1, Math.floor(maxTokens)), Number(params.max_tokens_cap) || 128000)

  push(
    'info',
    codex
      ? `prompt=${JSON.stringify(prompt).slice(0, 120)} effort=${effort || 'none'}`
      : `prompt=${JSON.stringify(prompt).slice(0, 120)} max_tokens=${maxTokens} thinking=${caps.requires_adaptive ? 'adaptive' : 'off'}`,
  )

  let inbound
  let headers
  let identitySource = 'slot'
  if (codex) {
    inbound = {
      model,
      input: codexTextInput(prompt),
      stream: true,
      store: false,
    }
    if (effort) inbound.reasoning = { effort }
    headers = {
      'user-agent': CODEX_USER_AGENT,
      'x-codex-installation-id': String(vm.device_id || vm.id),
      'session-id': `kin-test-${vmId}`,
      accept: 'text/event-stream',
    }
    identitySource = 'codex'
  } else {
    const slot = slotTestIdentity(projectRoot, vm)
    identitySource = slot.identity_source || 'slot'
    if (unofficial) {
      inbound = {
        model,
        max_tokens: maxTokens,
        stream: true,
        temperature: 1,
        messages: [{ role: 'user', content: prompt }],
      }
      headers = {
        'user-agent': String(opts.userAgent || 'kin-console-test/1.0'),
        'anthropic-version': '2023-06-01',
        accept: 'text/event-stream',
      }
    } else {
      ;({ inbound, headers } = buildVmTestInbound({
        model,
        prompt,
        maxTokens,
        sessionId: slot.sessionId,
        deviceId: slot.deviceId,
        accountUuid: slot.accountUuid,
        identity: slot.identity,
        rewrite: true,
        personaMode: opts.personaMode || 'rewrite',
      }))
    }
  }

  const v1Path = codex ? '/v1/responses' : '/v1/messages'
  push(
    'info',
    `入站 ua=${headers['user-agent'] || '—'} beta=${headers['anthropic-beta'] || '(none)'} identity=${identitySource}`,
  )
  push('info', `loopback POST ${v1Path} pin=x-kin-vm:${vmId}（站点用户路径，不直调 worker）`)

  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 90000, 10000), 180000)
  let result
  try {
    result = await (codex ? postV1Responses : postV1Messages)({
      baseUrl,
      apiKey,
      inbound,
      headers,
      vmId,
      timeoutMs,
      extraHeaders: opts.extraHeaders || {},
    })
    if (codex && !result?.ok && looksLikeCodexUnauthorized(result)) {
      const first = readCodexAccounts(projectRoot, vmId)[0] || {}
      const refreshToken = String(first.refresh_token || '').trim()
      if (refreshToken) {
        push('info', 'Codex hop 401，尝试刷新 OAuth')
        const tok = await refreshCodexAccessToken({
          refreshToken,
          proxyUrl: boundProxyUrl(vm.proxy),
          fetchImpl: opts.fetchImpl,
        })
        if (tok.ok) {
          persistRefreshedCodexAccount(projectRoot, vmId, {
            access_token: tok.access_token,
            refresh_token: tok.refresh_token,
            id_token: tok.id_token || first.id_token,
            expires_at: tok.expires_at || first.expires_at,
          })
          result = await postV1Responses({
            baseUrl,
            apiKey,
            inbound,
            headers,
            vmId,
            timeoutMs,
            extraHeaders: opts.extraHeaders || {},
          })
        } else {
          push('error', `Codex OAuth 刷新失败: ${tok.error || 'refresh_failed'}`)
        }
      }
    }
  } catch (e) {
    push('error', `/v1 loopback 异常: ${e.message || e}`)
    return done({
      ok: false,
      vm_id: vmId,
      model,
      error: { code: 'loopback_error', message: String(e.message || e).slice(0, 400) },
      log,
      duration_ms: Date.now() - started,
    })
  }

  const duration = Date.now() - started
  const text = result?.text || extractText(result?.body)
  const usage = result?.usage || result?.body?.usage || null
  let errObj = result?.ok ? null : extractError(result, { wrapHop: !codex })
  if (errObj && result?.status === 401 && credMode === 'setup-token') {
    errObj = {
      ...errObj,
      code: 'setup_token_invalid',
      message: `${errObj.message}。Setup Token 已按 inference 入站；上游仍 401 表示票已失效，请重新走官方 claude setup-token 导入。`,
    }
  } else if (errObj && result?.status === 401 && credMode === 'apikey') {
    errObj = {
      ...errObj,
      code: 'apikey_invalid',
      message: `${errObj.message}。Console Key 入站已去掉 oauth beta；上游仍 401 表示密钥无效。`,
    }
  } else if (errObj && credMode === 'codex' && looksLikeCodexUnauthorized(result)) {
    const refreshFailed = log.some((row) => /OAuth 刷新失败/.test(String(row.message || '')))
    errObj = {
      ...errObj,
      code: refreshFailed ? 'oauth_expired' : 'oauth_unauthorized',
      message: refreshFailed
        ? 'GPT OAuth 已失效（refresh_token 被拒绝）。请重新导入 Codex auth.json / ChatGPT OAuth。'
        : errObj.message,
    }
  }

  if (result?.ok) {
    push(
      'ok',
      `成功 status=${result.status} stop=${result.stop_reason || result.body?.stop_reason || '—'} ${duration}ms`,
    )
    if (result.vm_id) push('info', `命中槽 ${result.vm_id}`)
    if (text) push('content', text.slice(0, 2000))
    if (usage) {
      push(
        'info',
        `usage in=${usage.input_tokens ?? '—'} out=${usage.output_tokens ?? '—'} cache_read=${usage.cache_read_input_tokens ?? 0}`,
      )
    }
  } else {
    push('error', `失败 status=${result?.status || 0}: ${errObj.message}`)
    if (errObj.request_id) push('info', `request_id=${errObj.request_id}`)
    if (result?.status === 401 && /revoked/i.test(String(errObj.message || errObj.upstream_message || ''))) {
      try {
        opts.accountQuota?.recordLastProbe?.(vm.claude?.account_uuid || vm.account_uuid || vmId, {
          ok: false,
          source: 'test-chat',
          error: errObj.message,
          status: 401,
        })
      } catch {}
    }
  }

  return done({
    ok: !!result?.ok,
    vm_id: vmId,
    vm_name: vm.name || null,
    account_uuid: vm.claude?.account_uuid || vm.account_uuid || null,
    model,
    prompt,
    max_tokens: maxTokens,
    status: result?.status || 0,
    stop_reason: result?.stop_reason || result?.body?.stop_reason || null,
    usage,
    text: text ? text.slice(0, 4000) : null,
    body: result?.ok ? result.body : null,
    error: result?.ok ? null : errObj,
    duration_ms: duration,
    via: 'v1-loopback',
    credential_mode: credMode,
    inference_engine: inferenceEngine,
    dataplane,
    official_cc_inference: codex ? null : cliHop ? 'cli-hop' : 'http',
    debug: {
      path: v1Path,
      pin_vm: vmId,
      inbound_ua: headers['user-agent'] || null,
      inbound_beta: headers['anthropic-beta'] || null,
      inbound_class: codex
        ? 'openai_responses'
        : cliHop
          ? 'cli_hop_passthrough'
          : unofficial
            ? credMode === 'apikey'
              ? 'unofficial_apikey'
              : 'unofficial_setup_token'
            : 'claude_code_official',
      rewritten: Array.isArray(inbound?.system) && inbound.system.length >= 4,
      thinking: inbound?.thinking?.type || null,
      hit_vm: result?.vm_id || null,
      upstream_model: result?.model || result?.body?.model || null,
      inference_engine: inferenceEngine,
      dataplane,
      official_cc_inference: codex ? null : cliHop ? 'cli-hop' : 'http',
    },
    log,
  })
}
