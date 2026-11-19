/** Slot-local adapter for the official Antigravity 1.4.4 subscription service.
 * Protocol provenance: the official CLI's observed Cloud Code v1internal traffic;
 * the inner request is the Gemini GenerateContent schema. OAuth tokens never leave
 * this slot except as Authorization to the fixed official origins. CLI `models` owns token refresh.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

// Official CLI 1.4.4 sends every inference, quota and project lookup to Cloud Code; the
// gateway rejects other client identities (HTTP 404), so the CLI's own UA is reproduced.
const CODE_ASSIST = 'https://daily-cloudcode-pa.googleapis.com'
const QUOTA_ORIGINS = [CODE_ASSIST, 'https://cloudcode-pa.googleapis.com']
const USERINFO = 'https://www.googleapis.com/oauth2/v2/userinfo'
const USER_AGENT =
  'antigravity/cli/1.4.4 (aidev_client; os_type=linux; arch=amd64; cl=1003595037; auth_method=consumer)'
const MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
// Google's documented bypass for replayed function calls whose signature the caller dropped.
const SKIP_SIGNATURE = 'skip_thought_signature_validator'
const SIGNATURE_TTL_MS = 30 * 60_000
const SIGNATURE_CACHE_LIMIT = 4096
export const ANTIGRAVITY_API_CAPABILITIES = Object.freeze({
  text: true,
  stream: true,
  system: true,
  history: true,
  images: true,
  inline_images: true,
  remote_images: false,
  client_tools: true,
  reasoning: true,
  usage: true,
})
function reject(code, message, status = 400) {
  throw Object.assign(new Error(message), { code, status })
}
function signature(block) {
  return block.thought_signature || block.signature
}
function callKey(id, name, input) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([id, name, input]))
    .digest('hex')
}
function inlineImage(block) {
  const source = block.source
  if (source?.type !== 'base64')
    reject(
      'feature_not_supported',
      'Antigravity images require inline base64 data; remote image URLs are not supported',
    )
  if (
    !MIME.has(source.media_type) ||
    typeof source.data !== 'string' ||
    source.data.length > 24 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(source.data)
  )
    reject('invalid_image', 'Invalid inline image')
  return { inlineData: { mimeType: source.media_type, data: source.data } }
}

/** Keep native roles, tool IDs, schemas and multimodal parts intact. Never execute tools. */
export function antigravityNativeRequest(request) {
  if (!request || typeof request !== 'object' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(request.model || ''))
    reject('invalid_model', 'Invalid Antigravity model')
  if (!Array.isArray(request.messages) || !request.messages.length) reject('invalid_messages', 'Messages are required')
  if (request.parallel_tool_calls === false || request.tool_choice?.disable_parallel_tool_use === true)
    reject('feature_not_supported', 'Antigravity cannot guarantee that parallel tool calls are disabled')
  if (request.tools?.some((tool) => tool.strict === true) || request.response_format?.strict === true)
    reject('feature_not_supported', 'Antigravity does not expose the requested strict schema guarantee')
  const toolNames = new Map()
  const part = (block) => {
    let value
    if (block.type === 'text') value = { text: block.text }
    else if (block.type === 'thinking') value = { text: block.thinking, thought: true }
    else if (block.type === 'refusal') value = { text: block.refusal }
    else if (block.type === 'image') value = inlineImage(block)
    else if (block.type === 'tool_use') {
      toolNames.set(block.id, block.name)
      value = { functionCall: { id: block.id, name: block.name, args: block.input } }
    } else if (block.type === 'tool_result') {
      const name = toolNames.get(block.tool_use_id)
      if (!name) reject('invalid_tool_result', 'Tool result has no preceding tool call')
      const parts = block.content.map((item) =>
        item.type === 'image'
          ? inlineImage(item)
          : item.type === 'text'
            ? { text: item.text }
            : reject('feature_not_supported', 'Unsupported tool result part'),
      )
      value = {
        functionResponse: {
          id: block.tool_use_id,
          name,
          response: {
            [block.is_error ? 'error' : 'result']: parts
              .filter((item) => item.text != null)
              .map((item) => item.text)
              .join('\n'),
          },
          ...(parts.some((item) => item.inlineData) ? { parts: parts.filter((item) => item.inlineData) } : {}),
        },
      }
    } else reject('feature_not_supported', `Antigravity does not support content type ${String(block.type)}`)
    if (signature(block)) value.thoughtSignature = signature(block)
    return value
  }
  const contents = request.messages.map((message) => {
    if (!['user', 'assistant'].includes(message.role) || !Array.isArray(message.content))
      reject('invalid_messages', 'Invalid structured message')
    const parts = message.content.map(part)
    // Gemini 3+ rejects a model turn whose function calls carry no signature (HTTP 400).
    const calls = parts.filter((item) => item.functionCall)
    if (calls.length && !calls.some((item) => item.thoughtSignature)) calls[0].thoughtSignature = SKIP_SIGNATURE
    return { role: message.role === 'assistant' ? 'model' : 'user', parts }
  })
  const generationConfig = {}
  for (const [from, to] of Object.entries({
    max_tokens: 'maxOutputTokens',
    temperature: 'temperature',
    top_p: 'topP',
    top_k: 'topK',
    stop_sequences: 'stopSequences',
  }))
    if (request[from] != null) generationConfig[to] = request[from]
  if (request.response_format && request.response_format.type !== 'text') {
    generationConfig.responseMimeType = 'application/json'
    if (request.response_format.type === 'json_schema')
      generationConfig.responseJsonSchema = request.response_format.schema
  }
  // The control plane resolves the level and selects the matching variant; Gemini's
  // thinkingLevel carries it. Token budgets are not part of the level contract.
  if (request.reasoning?.effort) {
    const level = { minimal: 'MINIMAL', low: 'LOW', medium: 'MEDIUM', high: 'HIGH' }[request.reasoning.effort]
    if (!level) reject('feature_not_supported', 'Unsupported Antigravity reasoning effort')
    generationConfig.thinkingConfig = { includeThoughts: request.thinking?.type !== 'disabled', thinkingLevel: level }
  }
  const body = { contents, generationConfig }
  if (request.system?.length)
    body.systemInstruction = {
      parts: request.system.map((block) => {
        if (block.type !== 'text') reject('feature_not_supported', 'System instruction must contain text')
        return { text: block.text }
      }),
    }
  if (request.tools?.length)
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description || '',
          parametersJsonSchema: tool.input_schema,
        })),
      },
    ]
  if (request.tool_choice) {
    const choice = request.tool_choice
    const mode = { auto: 'AUTO', none: 'NONE', any: 'ANY', tool: 'ANY' }[choice.type]
    if (!mode) reject('feature_not_supported', 'Unsupported Antigravity tool choice')
    body.toolConfig = {
      functionCallingConfig: { mode, ...(choice.type === 'tool' ? { allowedFunctionNames: [choice.name] } : {}) },
    }
  }
  return body
}

export function antigravityNativeUsage(value) {
  if (!value || !Number.isSafeInteger(value.promptTokenCount) || !Number.isSafeInteger(value.candidatesTokenCount))
    return null
  const cached = value.cachedContentTokenCount || 0,
    thoughts = value.thoughtsTokenCount || 0
  if (
    [value.promptTokenCount, value.candidatesTokenCount, cached, thoughts].some(
      (n) => !Number.isSafeInteger(n) || n < 0,
    ) ||
    cached > value.promptTokenCount
  )
    return null
  if (
    value.totalTokenCount != null &&
    (!Number.isSafeInteger(value.totalTokenCount) ||
      value.totalTokenCount !== value.promptTokenCount + value.candidatesTokenCount + thoughts)
  )
    return null
  return {
    input_tokens: value.promptTokenCount - cached,
    output_tokens: value.candidatesTokenCount + thoughts,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    ...(thoughts ? { thinking_tokens: thoughts } : {}),
  }
}

// A stalled refresh (e.g. slot DNS down) must outlive short callers such as the 20 s quota poll.
const REFRESH_TIMEOUT_MS = 90_000
function refreshFailureDetail(error, stderr, stdout) {
  if (error.killed || error.signal) return `official CLI did not finish within ${REFRESH_TIMEOUT_MS / 1000}s`
  const line = String(stderr || stdout || '')
    .split('\n')
    .map((text) => text.trim())
    .filter(Boolean)
    .at(-1)
  const safe = line?.replace(/ya29\.[\w.-]+|1\/\/[\w.-]+|eyJ[\w.-]+/g, '[redacted]').slice(0, 200)
  return `official CLI exited with ${error.code ?? 'error'}${safe ? `: ${safe}` : ''}`
}
function cliRefresh(config) {
  return new Promise((resolve, rejectPromise) => {
    const home = process.env.HOME || '/home/kincli'
    execFile(
      config.cli_bin || 'agy',
      ['models'],
      {
        cwd: home,
        env: { HOME: home, PATH: `${home}/.local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8' },
        timeout: REFRESH_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error ? rejectPromise(new Error(refreshFailureDetail(error, stderr, stdout))) : resolve(),
    )
  })
}
function untilAborted(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, rejectPromise) => {
    const onAbort = () => rejectPromise(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, rejectPromise).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
function loadProject(token, fetchImpl, signal) {
  return fetchImpl(`${CODE_ASSIST}/v1internal:loadCodeAssist`, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
    signal,
  }).then(async (response) => {
    if (!response.ok) {
      await response.body?.cancel()
      reject(
        response.status === 401 ? 'antigravity_auth_expired' : 'antigravity_project_unavailable',
        `Antigravity project lookup returned HTTP ${response.status}`,
        response.status === 401 ? 401 : 503,
      )
    }
    const project = (await response.json())?.cloudaicompanionProject
    if (typeof project !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(project))
      reject('antigravity_project_unavailable', 'Antigravity account has no assigned project', 503)
    return project
  })
}
function readToken() {
  const filename = path.join(
    process.env.HOME || '/home/kincli',
    '.gemini',
    'antigravity-cli',
    'antigravity-oauth-token',
  )
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('invalid credential file')
    const value = JSON.parse(fs.readFileSync(fd, 'utf8')).token
    if (!value || typeof value.access_token !== 'string' || !value.access_token)
      throw new Error('invalid credential file')
    return value
  } finally {
    fs.closeSync(fd)
  }
}

// Display only: a missing email never fails the quota read.
async function accountEmail(token, fetchImpl, signal) {
  try {
    const response = await fetchImpl(USERINFO, {
      redirect: 'error',
      headers: { authorization: `Bearer ${token}` },
      signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      return null
    }
    const email = (await response.json())?.email
    return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null
  } catch {
    return null
  }
}

export function createAntigravityUpstream(config = {}, dependencies = {}) {
  const fetchImpl = dependencies.fetch || fetch
  const projectOf = dependencies.loadProject || ((access, signal) => loadProject(access, fetchImpl, signal))
  const tokenReader = dependencies.readToken || readToken
  const refresh = dependencies.refresh || cliRefresh
  let refreshWork,
    projectCache,
    projectToken,
    active = new Set(),
    closed = false
  // Anthropic/OpenAI clients drop the non-standard tool signature, so replays are restored here.
  const signatures = new Map()
  function rememberSignature(block) {
    const now = Date.now()
    for (const [key, entry] of signatures) {
      if (entry.expires > now && signatures.size < SIGNATURE_CACHE_LIMIT) break
      signatures.delete(key)
    }
    const key = callKey(block.id, block.name, block.input)
    signatures.delete(key)
    signatures.set(key, { signature: block.thought_signature, expires: now + SIGNATURE_TTL_MS })
  }
  function withCachedSignatures(request) {
    const now = Date.now()
    let restored = false
    const messages = request.messages.map((message) => {
      if (message.role !== 'assistant') return message
      const content = message.content.map((block) => {
        if (block.type !== 'tool_use' || signature(block)) return block
        const entry = signatures.get(callKey(block.id, block.name, block.input))
        if (!entry || entry.expires <= now) return block
        restored = true
        return { ...block, thought_signature: entry.signature }
      })
      return { ...message, content }
    })
    return restored ? { ...request, messages } : request
  }
  async function token(signal, force = false) {
    let value
    try {
      value = tokenReader()
    } catch {
      reject('antigravity_auth_expired', 'Antigravity credentials are unavailable; authorize this slot again', 401)
    }
    if (force || !Number.isFinite(Date.parse(value.expiry)) || Date.parse(value.expiry) <= Date.now() + 60_000) {
      refreshWork ||= Promise.resolve()
        .then(() => refresh(config))
        .finally(() => {
          refreshWork = null
          projectCache = null
        })
      try {
        await untilAborted(refreshWork, signal)
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        reject('antigravity_token_refresh_failed', `Antigravity token refresh failed: ${error?.message || error}`, 503)
      }
      value = tokenReader()
      if (!(Date.parse(value.expiry) > Date.now()))
        reject(
          'antigravity_token_refresh_failed',
          'Antigravity token refresh failed: official CLI left the token expired (check slot network and DNS)',
          503,
        )
    }
    return value.access_token
  }
  return {
    close() {
      closed = true
      for (const controller of active) controller.abort()
    },
    async infer(request, { signal, onEvent } = {}) {
      let content = [],
        usage = null,
        finishReason,
        committed = false,
        current = null,
        bytes = 0,
        timedOut = false
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      // Idle, not total: Gemini emits a function call only once its arguments are complete, so a
      // large tool call (a whole file) streams nothing for minutes while still generating.
      const idleMs = Number(config.timeout_ms) || 180_000
      let timer
      const arm = () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          timedOut = true
          abort()
        }, idleMs)
      }
      arm()
      const emit = (event) => {
        committed = true
        onEvent?.(event)
      }
      const closeBlock = () => {
        if (current != null) emit({ type: 'content_block_stop', index: current })
        current = null
      }
      const setSignature = (index, sig) => {
        const block = content[index],
          field = block.type === 'thinking' ? 'signature' : 'thought_signature'
        if (typeof sig !== 'string' || !sig) throw new Error('invalid signature')
        if (block[field] === sig) return
        if (block[field]) throw new Error('conflicting signature')
        block[field] = sig
        if (block.type === 'tool_use') rememberSignature(block)
        if (block.type === 'thinking' && current === index)
          emit({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: sig } })
        else emit({ type: 'thought_signature', index, signature: sig })
      }
      const append = (part) => {
        const sig = part.thoughtSignature
        if (part.text != null) {
          const type = part.thought ? 'thinking' : 'text',
            field = part.thought ? 'thinking' : 'text'
          if (typeof part.text !== 'string') throw new Error('invalid text part')
          if (!part.text && sig && content.length) {
            setSignature(content.length - 1, sig)
            return
          }
          if (!part.text) return
          if (current == null || content[current]?.type !== type || signature(content[current])) {
            closeBlock()
            current = content.length
            content.push({ type, [field]: '' })
            emit({ type: 'content_block_start', index: current, content_block: { ...content[current] } })
          }
          content[current][field] += part.text
          emit({ type: 'content_block_delta', index: current, delta: { type: `${type}_delta`, [field]: part.text } })
          if (sig) setSignature(current, sig)
        } else if (part.functionCall) {
          closeBlock()
          const call = part.functionCall
          if (call.args == null) call.args = {}
          if (typeof call.name !== 'string' || typeof call.args !== 'object' || Array.isArray(call.args))
            throw new Error('invalid function call')
          const block = {
            type: 'tool_use',
            id: call.id || `call_${crypto.randomBytes(12).toString('hex')}`,
            name: call.name,
            input: call.args,
            ...(sig ? { thought_signature: sig } : {}),
          }
          if (sig) rememberSignature(block)
          const index = content.length
          content.push(block)
          emit({ type: 'content_block_start', index, content_block: { ...block, input: {} } })
          emit({
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) },
          })
          emit({ type: 'content_block_stop', index })
        } else if (sig && content.length) {
          setSignature(content.length - 1, sig)
        } else throw new Error('unsupported output part')
      }
      try {
        if (closed) reject('antigravity_shutdown', 'Antigravity bridge is shutting down', 503)
        if (active.size >= Math.min(20, Number(config.max_sessions) || 1))
          reject('antigravity_busy', 'Antigravity slot is at capacity', 429)
        const allowed = (config.models || [])
          .filter((row) => row?.enabled !== false)
          .map((row) => (typeof row === 'string' ? row : row.id))
        if (!allowed.includes(request?.model)) reject('model_not_supported', 'Antigravity model is not enabled', 404)
        // Validate all caller-controlled inputs before touching credentials/network.
        antigravityNativeRequest(request)
        active.add(controller)
        if (signal?.aborted) abort()
        if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
        let access = await token(controller.signal)
        const project =
          projectToken === access && projectCache ? projectCache : await projectOf(access, controller.signal)
        projectCache = project
        projectToken = access
        const native = antigravityNativeRequest(withCachedSignatures(request))
        const send = () =>
          fetchImpl(`${CODE_ASSIST}/v1internal:streamGenerateContent?alt=sse`, {
            method: 'POST',
            redirect: 'error',
            headers: {
              authorization: `Bearer ${access}`,
              'content-type': 'application/json',
              'user-agent': USER_AGENT,
            },
            body: JSON.stringify({
              project,
              requestId: `agent/${crypto.randomUUID()}`,
              model: request.model,
              userAgent: 'antigravity',
              requestType: 'agent',
              request: native,
            }),
            signal: controller.signal,
          })
        let response = await send()
        if (response.status === 401) {
          await response.body?.cancel()
          access = await token(controller.signal, true)
          response = await send()
        }
        if (!response.ok) {
          await response.body?.cancel()
          reject(
            response.status === 401
              ? 'antigravity_auth_expired'
              : response.status === 429
                ? 'antigravity_rate_limited'
                : 'antigravity_upstream_error',
            `Antigravity service returned HTTP ${response.status}`,
            response.status,
          )
        }
        let buffer = '',
          decoder = new TextDecoder()
        const consume = (event) => {
          const data = event
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (!data.trim() || data === '[DONE]') return
          const frame = JSON.parse(data)
          if (frame.error || !frame.response || typeof frame.response !== 'object')
            throw new Error('upstream stream error')
          const chunk = frame.response
          if (chunk.usageMetadata) usage = antigravityNativeUsage(chunk.usageMetadata)
          if (chunk.promptFeedback?.blockReason)
            reject('antigravity_content_blocked', 'Antigravity rejected this request', 400)
          for (const candidate of chunk.candidates || []) {
            if (candidate.index && candidate.index !== 0) throw new Error('unexpected extra candidate')
            if (finishReason) throw new Error('content after terminal')
            for (const part of candidate.content?.parts || []) append(part)
            if (candidate.finishReason) finishReason = candidate.finishReason
          }
        }
        if (!response.body) throw new Error('missing stream')
        for await (const chunk of response.body) {
          arm()
          bytes += chunk.length
          if (bytes > (Number(config.max_response_bytes) || 16 * 1024 * 1024)) throw new Error('response too large')
          buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n')
          let at
          while ((at = buffer.indexOf('\n\n')) >= 0) {
            consume(buffer.slice(0, at))
            buffer = buffer.slice(at + 2)
          }
        }
        buffer += decoder.decode()
        if (buffer.trim()) consume(buffer)
        if (!finishReason) throw new Error('missing terminal')
        closeBlock()
        if (!['STOP', 'MAX_TOKENS'].includes(finishReason))
          reject('antigravity_content_blocked', `Antigravity generation ended with ${finishReason}`, 400)
        return {
          ok: true,
          status: 200,
          content,
          usage,
          stop_reason:
            finishReason === 'MAX_TOKENS'
              ? 'max_tokens'
              : content.some((block) => block.type === 'tool_use')
                ? 'tool_use'
                : 'end_turn',
          output_committed: committed,
          terminalState: 'verified',
          upstream_status: finishReason,
        }
      } catch (error) {
        controller.abort()
        const cancelled = signal?.aborted || closed
        // The abort raises a DOMException whose numeric `code` (20) must not mask the timeout.
        const code = typeof error?.code === 'string' ? error.code : null
        return {
          ok: false,
          status: cancelled ? 499 : timedOut ? 504 : error.status || 502,
          code: cancelled
            ? 'client_cancelled'
            : timedOut
              ? 'antigravity_timeout'
              : code || 'antigravity_stream_incomplete',
          message: cancelled
            ? 'Request cancelled'
            : timedOut
              ? `Antigravity sent no data for ${Math.round(idleMs / 1000)} s; raise antigravity.timeout_ms for long outputs`
              : error.status
                ? error.message
                : 'Antigravity did not return a complete valid response',
          content,
          usage,
          stop_reason: null,
          output_committed: committed,
          terminalState: cancelled ? 'cancelled' : committed ? 'incomplete' : 'rejected',
          upstream_status: finishReason || null,
        }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        active.delete(controller)
      }
    },
    async quota({ signal } = {}) {
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(abort, 20_000)
      try {
        if (closed) reject('antigravity_shutdown', 'Antigravity bridge is shutting down', 503)
        let access = await token(controller.signal)
        let response
        for (const origin of QUOTA_ORIGINS) {
          const send = () =>
            fetchImpl(`${origin}/v1internal:retrieveUserQuotaSummary`, {
              method: 'POST',
              redirect: 'error',
              headers: {
                authorization: `Bearer ${access}`,
                'content-type': 'application/json',
                'user-agent': USER_AGENT,
              },
              body: '{}',
              signal: controller.signal,
            })
          response = await send()
          if (response.status === 401) {
            await response.body?.cancel()
            access = await token(controller.signal, true)
            response = await send()
          }
          if (response.status !== 429 && response.status < 500) break
          await response.body?.cancel()
        }
        if (!response.ok) {
          await response.body?.cancel()
          reject(
            response.status === 401
              ? 'antigravity_auth_expired'
              : response.status === 429
                ? 'antigravity_rate_limited'
                : 'antigravity_upstream_error',
            `Antigravity quota service returned HTTP ${response.status}`,
            response.status,
          )
        }
        const text = await response.text()
        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('quota response too large')
        const summary = JSON.parse(text)
        if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw new Error('invalid quota summary')
        return { ok: true, summary, email: await accountEmail(access, fetchImpl, controller.signal) }
      } catch (error) {
        const cancelled = signal?.aborted || closed
        return {
          ok: false,
          status: cancelled ? 499 : error.status || 502,
          code: cancelled ? 'client_cancelled' : error.code || 'antigravity_quota_invalid',
          message: error.status
            ? error.message
            : cancelled
              ? 'Request cancelled'
              : 'Antigravity did not return a valid quota summary',
        }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
    },
  }
}
