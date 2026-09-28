/**
 * Codex hop routing. Claude traffic never reads this object.
 */
import { isCodexVm } from '../vm/vm-kind.mjs'

export { isCodexVm, normalizeVmKind } from '../vm/vm-kind.mjs'

export const CODEX_PROTOCOLS = Object.freeze(['openai.responses', 'openai.chat', 'openai.completions'])

export const DEFAULT_CODEX_ROUTING = Object.freeze({
  enabled: true,
  // `auto` resolves the official Codex catalog client version at sync time,
  // falling back to 0.158.0 when the registry is unavailable.
  catalog_client_version: 'auto',
  protocols: {
    'openai.responses': { mode: 'native', enabled: true },
    'openai.chat': { mode: 'convert', enabled: true },
    'openai.completions': { mode: 'convert', enabled: true },
    'anthropic.messages': { mode: 'reject', enabled: false },
  },
  convert: {
    chat_to_codex: true,
    completions_to_codex: true,
    anthropic_to_codex: false,
  },
  clients: {
    official_codex: 'allow',
    openai_compatible: 'allow',
    claude_code: 'reject',
    unknown: 'allow',
  },
})

export function normalizeCodexRouting(raw = {}) {
  const protocols = { ...DEFAULT_CODEX_ROUTING.protocols, ...(raw.protocols || {}) }
  for (const key of Object.keys(protocols)) {
    const item = protocols[key] || {}
    const mode = ['native', 'convert', 'reject'].includes(item.mode) ? item.mode : 'reject'
    protocols[key] = { mode, enabled: item.enabled !== false && mode !== 'reject' }
  }
  const clients = { ...DEFAULT_CODEX_ROUTING.clients, ...(raw.clients || {}) }
  for (const [key, value] of Object.entries(clients)) {
    clients[key] = value === 'allow' ? 'allow' : 'reject'
  }
  return {
    enabled: raw.enabled !== false,
    catalog_client_version:
      typeof raw.catalog_client_version === 'string' && raw.catalog_client_version.trim()
        ? raw.catalog_client_version.trim()
        : 'auto',
    protocols,
    convert: {
      chat_to_codex: raw.convert?.chat_to_codex !== false,
      completions_to_codex: raw.convert?.completions_to_codex !== false,
      anthropic_to_codex: raw.convert?.anthropic_to_codex === true,
    },
    clients,
  }
}

export function isCodexProtocolAllowed(protocol, routing = {}) {
  const codex = normalizeCodexRouting(routing.codex || routing)
  if (!codex.enabled) return { ok: false, code: 'codex_disabled', mode: 'reject' }
  const entry = codex.protocols[protocol]
  if (!entry || entry.enabled === false || entry.mode === 'reject') {
    return { ok: false, code: 'protocol_not_allowed', mode: 'reject' }
  }
  return { ok: true, mode: entry.mode }
}

export function listCodexVms(vms = []) {
  return (vms || []).filter((vm) => isCodexVm(vm))
}
