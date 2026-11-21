import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MODEL = /^[a-z0-9][a-z0-9._-]{0,99}$/
const RUN_ID = /^[a-f0-9]{32}$/
const POLL_MS = 250
const TURN_MS = 120_000

const FAILURES = {
  gemini_host_unavailable: [503, 'Gemini host is not available.'],
  gemini_host_protocol_error: [502, 'Gemini host returned an unusable response.'],
  gemini_no_account: [503, 'No authorized Gemini account is ready.'],
  gemini_model_unavailable: [404, 'This Gemini model is not available on an authorized account.'],
  gemini_proxy_unavailable: [503, 'The selected Gemini account has no usable proxy.'],
  gemini_operation_busy: [503, 'Gemini accounts are busy. Retry shortly.'],
  gemini_oauth_required: [503, 'The selected Gemini account needs authorization again.'],
  gemini_api_key_invalid: [503, 'The selected Gemini API key is not valid.'],
  gemini_location_unsupported: [403, 'Google rejected this account location for Antigravity.'],
  gemini_proxy_error: [502, 'The bound Gemini proxy could not reach Google.'],
  gemini_quota_exhausted: [429, 'The selected Gemini account quota is exhausted.'],
  gemini_inference_timeout: [504, 'The Gemini turn timed out.'],
  gemini_inference_invalid_output: [502, 'Gemini returned an unreadable response.'],
  gemini_inference_start_failed: [503, 'Gemini could not start the turn.'],
  gemini_inference_cancelled: [499, 'The Gemini turn was cancelled.'],
  gemini_inference_output_limit: [502, 'The Gemini response exceeded the text limit.'],
  gemini_inference_tool_blocked: [400, 'This Gemini route accepts one plain-text turn and no tools.'],
  gemini_inference_failed: [502, 'The Gemini turn failed.'],
  gemini_egress_unavailable: [503, 'Gemini egress is not available.'],
  gemini_oauth_tools_missing: [503, 'Gemini OAuth runtime tools are missing.'],
  gemini_ipv4_forwarding_unavailable: [503, 'Gemini IPv4 forwarding is not available.'],
}

function fail(status, code, message = FAILURES[code]?.[1] || code) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function known(error) {
  const code = error?.code
  if (typeof code === 'string' && Object.hasOwn(FAILURES, code)) {
    const [status, message] = FAILURES[code]
    return fail(Number.isInteger(error.status) ? error.status : status, code, message)
  }
  return null
}

function modelAccounts(accounts, model) {
  const ready = accounts.filter((account) => account.models.includes(model))
  const start = ready.length ? crypto.randomInt(ready.length) : 0
  return [...ready.slice(start), ...ready.slice(0, start)]
}

async function readRun(callHost, id, runId, signal) {
  const deadline = Date.now() + TURN_MS
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const result = await callHost('test-chat-status', { id, run_id: runId })
    if (result?.state === 'completed' || result?.state === 'failed') return result
    if (result?.state !== 'running') throw fail(502, 'gemini_host_protocol_error')
    await sleep(POLL_MS, undefined, { signal })
  }
  throw fail(504, 'gemini_inference_timeout')
}

export function createGeminiScheduler({ callHost, resolveProxy, apiKeyStore, groupsRepo }) {
  return {
    async catalog() {
      const view = await callHost('list', {})
      if (!Array.isArray(view?.environments)) throw fail(502, 'gemini_host_protocol_error')
      if (view.payload_state !== 'installed') return { models: [], accounts: [] }
      const accounts = []
      for (const environment of view.environments) {
        if (
          environment?.auth_state !== 'authorized' ||
          environment.oauth_imported === true ||
          (environment.auth_method === 'oauth' && view.oauth_runtime_issue) ||
          typeof environment.id !== 'string' ||
          !ID.test(environment.id) ||
          typeof environment.proxy_id !== 'string' ||
          !ID.test(environment.proxy_id) ||
          environment.models_discovered !== true ||
          !Array.isArray(environment.models)
        )
          continue
        if (resolveProxy) {
          try {
            resolveProxy(environment.proxy_id)
          } catch (error) {
            if (error?.code === 'gemini_proxy_unavailable') continue
            throw error
          }
        }
        const models = []
        for (const model of environment.models || []) {
          if (typeof model === 'string' && MODEL.test(model)) models.push(model)
        }
        if (models.length) accounts.push({ id: environment.id, models })
      }
      return {
        models: [...new Set(accounts.flatMap((account) => account.models))].map((id) => ({
          id,
          object: 'model',
          owned_by: 'google',
        })),
        accounts,
      }
    },

    async complete({ model, text, signal, apiKeyRecord }) {
      const gate = apiKeyStore?.acquire?.(apiKeyRecord)
      if (gate && !gate.ok) throw fail(gate.status || 429, gate.code, gate.message)
      let run = null
      try {
        signal?.throwIfAborted()
        const catalog = await this.catalog()
        const candidates = modelAccounts(catalog.accounts, model)
        if (!candidates.length) {
          throw fail(
            catalog.accounts.length ? 404 : 503,
            catalog.accounts.length ? 'gemini_model_unavailable' : 'gemini_no_account',
          )
        }
        for (const account of candidates) {
          const listed = await callHost('get', { id: account.id })
          const proxyId = listed?.proxy_id
          if (typeof proxyId !== 'string' || !ID.test(proxyId)) throw fail(502, 'gemini_host_protocol_error')
          const proxyUrl = resolveProxy ? resolveProxy(proxyId) : undefined
          signal?.throwIfAborted()
          let started
          try {
            started = await callHost('test-chat', {
              id: account.id,
              proxy_id: proxyId,
              proxy_url: proxyUrl,
              model,
              prompt: text,
            })
          } catch (error) {
            // Busy is a host admission refusal before any upstream work starts.
            if (error?.code === 'gemini_operation_busy') continue
            throw error
          }
          if (typeof started?.run_id !== 'string' || !RUN_ID.test(started.run_id)) {
            throw fail(502, 'gemini_host_protocol_error')
          }
          run = { id: account.id, run_id: started.run_id }
          break
        }
        if (!run) throw fail(503, 'gemini_operation_busy')
        const { id: accountId, run_id: runId } = run
        const result = await readRun(callHost, accountId, runId, signal)
        run = null
        if (result.state === 'failed') {
          const code = typeof result.error?.code === 'string' ? result.error.code : 'gemini_inference_failed'
          const mapped = Object.hasOwn(FAILURES, code) ? FAILURES[code] : null
          throw fail(mapped?.[0] || 502, mapped ? code : 'gemini_inference_failed')
        }
        if (typeof result.text !== 'string') throw fail(502, 'gemini_host_protocol_error')
        const usage = {}
        for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
          const count = result.usage?.[key]
          if (Number.isSafeInteger(count) && count >= 0) usage[key] = count
        }
        if (apiKeyRecord && apiKeyStore?.recordUsage) {
          const multiplier = groupsRepo?.rateMultiplier?.(apiKeyRecord.group_id ?? 1) ?? 1
          apiKeyStore.recordUsage(
            apiKeyRecord,
            { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 },
            { model, rateMultiplier: multiplier },
          )
        }
        return { text: result.text, usage, account_id: accountId, model }
      } catch (error) {
        if (run) {
          try {
            await callHost('test-chat-cancel', run)
          } catch {
            // Host idle cleanup releases the account.
          }
        }
        throw known(error) || error
      } finally {
        try {
          apiKeyStore?.release?.(apiKeyRecord)
        } catch {
          // Releasing a missing hold must not hide the turn result.
        }
      }
    },
  }
}
