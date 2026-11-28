/**
 * Gemini 4-protocol converter (SSOT for the isolated Gemini branch).
 *
 * Translates between Google Gemini / Code Assist wire format and:
 *   - Google Gemini native API (`gemini`)
 *   - OpenAI Chat Completions (`openai-chat`)
 *   - OpenAI Responses (`openai-responses`)
 *   - Anthropic Messages (`anthropic`)
 *   - vm2api Gemini session (`gemini-session`)
 *
 * Design aligned with Magpie's IR-based Gemini/CodeAssist gateway and
 * CRAG admission rules: parse once, preserve thinking/thoughtSignature/tools,
 * never silently drop unsupported fields on restricted native-TUI slots.
 */
import crypto from 'node:crypto'
import {
  escapeNativeTuiSlashes,
  sanitizeNativeTuiText,
  stripIllegalControlChars,
  stripVendorBillingLines,
} from '../gemini/prompt-normalizer.mjs'
import { isClientStream } from './convert.mjs'
import { extractImpliedModelEffort, isGeminiSeriesId, resolveGeminiDefaultEffort } from './gemini-model-policy.mjs'
import { firstNonEmptyEffort, isEmptyEffortValue } from './log-fields.mjs'
import { buildAnthropicSseError } from './stream-truncation.mjs'

export { escapeNativeTuiSlashes, sanitizeNativeTuiText, stripIllegalControlChars }

export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'
export const FULL_GEMINI_CAPABILITIES = Object.freeze([
  'streaming',
  'multi_turn',
  'system_instruction',
  'tools',
  'generation_config',
  'thinking',
  'multimodal',
  'full_gemini_api',
])
export const NATIVE_TUI_CAPABILITIES = Object.freeze([
  'streaming',
  'native_tui',
  'multi_turn',
  'system_instruction',
  'tools',
  'generation_config',
  'thinking',
  'multimodal',
])

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/
const SIG_MARK = '__ts'
const SIG_RAW = 'r'
const SIG_END = '__'
const NAME_LEAD = '_x_'
const GEMINI_NS = 'default_api'
const INTERRUPTED_TOOL_NOTE = '[The result of this tool call is unavailable: the turn was interrupted.]'
const TRANSIT_DEFENSE_FALLBACK_TEXT = '.'
const EMPTY_TOOL_OK_TEXT = 'Command executed successfully.'
const EMPTY_TOOL_ERR_TEXT = 'Tool execution failed with no output.'
const MAX_NATIVE_TEXT_BYTES = 256 * 1024
const MAX_SESSION_TEXT_BYTES = 4096

const GEMINI_OWN_KEYS = new Set([
  'args',
  'response',
  'parameters',
  'parametersJsonSchema',
  'responseSchema',
  'responseJsonSchema',
  'labels',
])

const GEN_READ_OR_BUILT = new Set([
  'maxOutputTokens',
  'temperature',
  'topP',
  'topK',
  'stopSequences',
  'responseMimeType',
  'responseSchema',
  'responseJsonSchema',
  'thinkingConfig',
  'imageConfig',
  'candidateCount',
])

const GOOGLE_SEARCH_TOOLS = new Set(['googleSearch', 'googleSearchRetrieval'])
const CRAGGEMINI_GOOGLE_TOOLS = new Set(['googleSearch', 'googleSearchRetrieval', 'urlContext'])
const CRAGGEMINI_VALID_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CRAGGEMINI_IMAGE_ASPECT_RATIOS = new Set([
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
  '1:4',
  '4:1',
  '1:8',
  '8:1',
])
const PLAIN_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])
const GOOGLE_TOOL_NAMES = new Set([
  'urlContext',
  'codeExecution',
  'googleMaps',
  'fileSearch',
  'enterpriseWebSearch',
  'computerUse',
  'retrieval',
])

const BUILTIN_CLIENT_TOOL_SCHEMAS = Object.freeze({
  local_shell: {
    description: 'Execute a shell command on the local machine.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'array', items: { type: 'string' }, description: 'Command and arguments to execute.' },
        timeout_ms: { type: 'integer', description: 'Optional execution timeout in milliseconds.' },
        working_directory: { type: 'string', description: 'Working directory for the command.' },
        env: { type: 'object', description: 'Optional environment variables.' },
        user: { type: 'string', description: 'Optional user to execute as.' },
      },
      required: ['command'],
    },
  },
  shell: {
    description: 'Execute one or more shell commands in the client environment.',
    schema: {
      type: 'object',
      properties: {
        commands: { type: 'array', items: { type: 'string' }, description: 'Shell commands to execute.' },
        timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds.' },
        max_output_length: { type: 'integer', description: 'Maximum output length.' },
      },
      required: ['commands'],
    },
  },
  apply_patch: {
    description: 'Create, update, or delete a file using a patch operation.',
    schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['create_file', 'delete_file', 'update_file'] },
        path: { type: 'string', description: 'Target file path.' },
        diff: { type: 'string', description: 'Patch diff or file content.' },
      },
      required: ['type', 'path'],
    },
  },
  computer: {
    description: 'Execute one or more GUI computer actions.',
    schema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: { type: 'object' },
          description: 'Sequence of computer actions to perform.',
        },
      },
      required: ['actions'],
    },
  },
  computer_preview: {
    description: 'Execute a single GUI computer action.',
    schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Action type (click, double_click, type, keypress, scroll, screenshot, wait, move, drag).',
        },
        x: { type: 'integer' },
        y: { type: 'integer' },
        button: { type: 'string' },
        text: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' } },
        scroll_x: { type: 'integer' },
        scroll_y: { type: 'integer' },
        ms: { type: 'integer' },
      },
      required: ['type'],
    },
  },
  tool_search: {
    description: 'Search and dynamically load client-side tools.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for tools.' },
      },
    },
  },
  anthropic_bash: {
    description: 'Run commands in a bash shell.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run.' },
        restart: { type: 'boolean', description: 'Restart the bash session.' },
      },
    },
  },
  anthropic_text_editor: {
    description: 'View, create, and edit files.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert', 'undo_edit'] },
        path: { type: 'string' },
        file_text: { type: 'string' },
        old_str: { type: 'string' },
        new_str: { type: 'string' },
        insert_line: { type: 'integer' },
        view_range: { type: 'array', items: { type: 'integer' } },
      },
      required: ['command', 'path'],
    },
  },
  anthropic_memory: {
    description: 'Read and manage persistent memory files.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'] },
        path: { type: 'string' },
        file_text: { type: 'string' },
        old_str: { type: 'string' },
        new_str: { type: 'string' },
        insert_line: { type: 'integer' },
        new_path: { type: 'string' },
        view_range: { type: 'array', items: { type: 'integer' } },
      },
      required: ['command'],
    },
  },
  anthropic_computer: {
    description: 'Interact with a computer screen using mouse and keyboard actions.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        coordinate: { type: 'array', items: { type: 'integer' } },
        start_coordinate: { type: 'array', items: { type: 'integer' } },
        text: { type: 'string' },
        key: { type: 'string' },
        duration: { type: 'number' },
        scroll_direction: { type: 'string' },
        scroll_amount: { type: 'integer' },
      },
      required: ['action'],
    },
  },
})

function customToolSchema(format) {
  let desc = 'Raw input text for this custom tool.'
  if (isPlainObject(format)) {
    const syntax = typeof format.syntax === 'string' ? format.syntax.trim() : ''
    const definition = typeof format.definition === 'string' ? format.definition.trim() : ''
    if (syntax || definition) {
      desc = `Input must follow ${syntax || format.type || 'custom'} format${definition ? `:\n${definition}` : '.'}`
    }
  }
  return {
    type: 'object',
    properties: { input: { type: 'string', description: desc } },
    required: ['input'],
  }
}

function normalizeUserLocation(loc) {
  if (!isPlainObject(loc)) return ''
  const src = isPlainObject(loc.approximate) ? loc.approximate : loc
  const parts = [src.city, src.region, src.country].map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)
  const tz = typeof src.timezone === 'string' ? src.timezone.trim() : ''
  if (!parts.length && !tz) return ''
  let out = parts.join(', ')
  if (tz) out = out ? `${out}; time zone ${tz}` : `time zone ${tz}`
  return out
}

function mergeSearchOptions(target, raw) {
  if (!isPlainObject(raw)) return target
  const out = target ? { ...target } : {}
  const size = typeof raw.search_context_size === 'string' ? raw.search_context_size.trim().toLowerCase() : ''
  if (size) {
    if (!['low', 'medium', 'high'].includes(size)) {
      throw makeProtocolError(400, 'gemini_invalid_request', `Unsupported search_context_size: ${size}`)
    }
    out.contextSize = size
  }
  const loc = normalizeUserLocation(raw.user_location)
  if (loc) out.location = loc
  const allowedRaw = Array.isArray(raw.filters?.allowed_domains)
    ? raw.filters.allowed_domains
    : Array.isArray(raw.allowed_domains)
      ? raw.allowed_domains
      : []
  if (allowedRaw.length) {
    const merged = new Set(out.allowedDomains || [])
    for (const d of allowedRaw) {
      const clean = typeof d === 'string' ? d.trim().toLowerCase() : ''
      if (clean) merged.add(clean)
    }
    if (merged.size) out.allowedDomains = [...merged]
  }
  const blockedRaw = Array.isArray(raw.blocked_domains) ? raw.blocked_domains : []
  if (blockedRaw.length) {
    const merged = new Set(out.blockedDomains || [])
    for (const d of blockedRaw) {
      const clean = typeof d === 'string' ? d.trim().toLowerCase() : ''
      if (clean) merged.add(clean)
    }
    if (merged.size) out.blockedDomains = [...merged]
  }
  return Object.keys(out).length ? out : target
}

function sanitizeConversationId(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed && CRAGGEMINI_VALID_ID_RE.test(trimmed) ? trimmed : null
}

function domainMatchesList(urlOrHost, domains) {
  if (!domains?.length) return false
  let host = ''
  try {
    host = new URL(urlOrHost).hostname.toLowerCase()
  } catch {
    host = String(urlOrHost || '')
      .trim()
      .toLowerCase()
  }
  if (!host) return false
  return domains.some((raw) => {
    const domain = raw
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^\*\./, '')
    return domain && (host === domain || host.endsWith(`.${domain}`))
  })
}

function imageConfigFromOpenAISizeQuality(size, quality) {
  const cfg = {}
  if (typeof size === 'string') {
    const s = size.trim().toLowerCase()
    if (s === '1024x1024' || s === '512x512' || s === '1:1') cfg.aspectRatio = '1:1'
    else if (s === '1536x1024' || s === '3:2') cfg.aspectRatio = '3:2'
    else if (s === '1024x1536' || s === '2:3') cfg.aspectRatio = '2:3'
    else if (s === '1792x1024' || s === '16:9') cfg.aspectRatio = '16:9'
    else if (s === '1024x1792' || s === '9:16') cfg.aspectRatio = '9:16'
    else if (CRAGGEMINI_IMAGE_ASPECT_RATIOS.has(size.trim())) cfg.aspectRatio = size.trim()
  }
  if (typeof quality === 'string') {
    const q = quality.trim().toLowerCase()
    if (q === 'low' || q === '1k') cfg.imageSize = '1K'
    else if (q === 'medium' || q === 'standard' || q === '2k') cfg.imageSize = '2K'
    else if (q === 'high' || q === 'hd' || q === '4k') cfg.imageSize = '4K'
  }
  return Object.keys(cfg).length ? cfg : null
}

const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
const SCHEMA_ONE = new Set(['items', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema'])
const SCHEMA_LIST = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])
const PLAIN_SCHEMA_KEEP = new Set([
  'description',
  'nullable',
  'required',
  'pattern',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'propertyOrdering',
])

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function makeProtocolError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

function randomHex(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex')
}

function newCallId() {
  return `call_${randomHex(10)}`
}

function snakeToCamel(key) {
  if (!key.includes('_')) return key
  const parts = key.split('_')
  let out = parts[0]
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]
    if (part) out += part[0].toUpperCase() + part.slice(1)
  }
  return out
}

/**
 * Normalize snake_case Gemini proto-JSON fields to camelCase while leaving
 * caller-owned payloads (`args`, `response`, schemas, `labels`) untouched.
 */
export function geminiCamelCase(value) {
  if (Array.isArray(value)) {
    let out = null
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i]
      const next = geminiCamelCase(item)
      if (out) {
        out[i] = next
      } else if (next !== item) {
        out = value.slice()
        out[i] = next
      }
    }
    return out || value
  }
  if (!isPlainObject(value)) return value
  const keys = Object.keys(value)
  let changed = false
  let hasSnake = false
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].includes('_')) {
      hasSnake = true
      changed = true
      break
    }
  }
  if (!hasSnake) {
    let out = null
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i]
      const raw = value[key]
      const nextVal = GEMINI_OWN_KEYS.has(key) ? raw : geminiCamelCase(raw)
      if (out) {
        out[key] = nextVal
      } else if (nextVal !== raw) {
        out = {}
        for (let j = 0; j < i; j += 1) out[keys[j]] = value[keys[j]]
        out[key] = nextVal
      }
    }
    return out || value
  }
  const out = {}
  const originalKeys = new Set(keys)
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]
    const raw = value[key]
    const camel = snakeToCamel(key)
    const nextVal = GEMINI_OWN_KEYS.has(camel) ? raw : geminiCamelCase(raw)
    if (camel === key) {
      out[camel] = nextVal
    } else if (!originalKeys.has(camel)) {
      out[camel] = nextVal
    }
  }
  return changed ? out : value
}

export function geminiFuncName(name) {
  const s = String(name || '')
  if (s && /^[0-9\-.:]/.test(s)) return `${NAME_LEAD}${s}`
  return s
}

const MCP_CALL_PREFIXES = ['mcp__craggemini__', 'mcp_craggemini_', 'mcp__crag__', 'mcp_crag_']

export function geminiToolNameFromCall(name) {
  let s = String(name || '')
  for (const prefix of MCP_CALL_PREFIXES) {
    if (s.startsWith(prefix) && s.length > prefix.length) {
      s = s.slice(prefix.length)
      break
    }
  }
  for (const sep of [':', '.']) {
    const prefix = `${GEMINI_NS}${sep}`
    if (s.startsWith(prefix) && s.length > prefix.length) {
      s = s.slice(prefix.length)
      break
    }
  }
  if (s.startsWith(NAME_LEAD)) s = s.slice(NAME_LEAD.length)
  return s
}

// Leave room for CRAGGemini's 9-char `mcp_crag_` prefix so `mcp_crag_<wireName>`
// always fits inside `agy` 1.5.9's 64-char `ValidateToolName` ceiling without double truncation.
const MAX_WIRE_TOOL_NAME_LEN = 55

function makeWireToolName(rawName, usedNames) {
  const base = geminiFuncName(rawName)
  let safe = base.replace(/[^A-Za-z0-9_-]/g, '_')
  if (!safe || /^[0-9-]/.test(safe)) safe = `${NAME_LEAD}${safe || 'tool'}`
  if (safe.length > MAX_WIRE_TOOL_NAME_LEN) {
    const hash = crypto
      .createHash('sha256')
      .update(String(rawName || ''))
      .digest('hex')
      .slice(0, 8)
    safe = `${safe.slice(0, MAX_WIRE_TOOL_NAME_LEN - 9)}_${hash}`
  }
  if (!usedNames.has(safe)) {
    usedNames.add(safe)
    return safe
  }
  const hash = crypto
    .createHash('sha256')
    .update(String(rawName || ''))
    .digest('hex')
    .slice(0, 8)
  let candidate = `${safe.slice(0, MAX_WIRE_TOOL_NAME_LEN - 9)}_${hash}`
  let n = 1
  while (usedNames.has(candidate)) {
    const tail = `_${hash}_${n++}`
    candidate = `${safe.slice(0, Math.max(1, MAX_WIRE_TOOL_NAME_LEN - tail.length))}${tail}`
  }
  usedNames.add(candidate)
  return candidate
}

function formatSearchOptionsDirectives(searchOptions) {
  if (!isPlainObject(searchOptions)) return []
  const lines = []
  if (searchOptions.contextSize) {
    lines.push(`Use ${searchOptions.contextSize} search context depth.`)
  }
  if (searchOptions.location) {
    lines.push(
      `The user's approximate location is ${searchOptions.location}. Use it for location-dependent questions and searches.`,
    )
  }
  if (Array.isArray(searchOptions.allowedDomains) && searchOptions.allowedDomains.length) {
    lines.push(`Restrict web searches to these domains using site: queries: ${searchOptions.allowedDomains.join(', ')}`)
  }
  if (Array.isArray(searchOptions.blockedDomains) && searchOptions.blockedDomains.length) {
    lines.push(
      `Exclude these domains from web searches using -site: queries: ${searchOptions.blockedDomains.join(', ')}`,
    )
  }
  return lines
}

function formatResponseFormatDirective(responseFormat) {
  if (!isPlainObject(responseFormat)) return ''
  if (responseFormat.type === 'json_object') {
    return 'Respond with a single JSON value only, without Markdown code fences or any other text.'
  }
  if (responseFormat.type === 'json_schema' && responseFormat.schema) {
    const desc = responseFormat.description ? `${responseFormat.description}\n` : ''
    return `Respond with a single JSON value that conforms to this JSON Schema, without Markdown code fences or any other text:\n${desc}${JSON.stringify(responseFormat.schema)}`
  }
  if (responseFormat.type === 'enum' && Array.isArray(responseFormat.values) && responseFormat.values.length) {
    return `Respond with exactly one of the following values, without quotes, Markdown code fences or any other text:\n${responseFormat.values.join('\n')}`
  }
  return ''
}

function unwrapCustomInput(args) {
  if (isPlainObject(args)) {
    if (typeof args.input === 'string') return args.input
    if (args.input != null) return JSON.stringify(args.input)
  }
  if (typeof args === 'string') return args
  return JSON.stringify(args ?? {})
}

/** Encode a Gemini thoughtSignature into a tool call ID for non-Gemini clients. */
export function signedToolCallId(id, signature) {
  if (!signature) return id || newCallId()
  const baseId = id || newCallId()
  const std = Buffer.from(signature, 'base64')
  const canonicalBase64 = std.length > 0 && std.toString('base64') === signature
  const kind = canonicalBase64 ? '' : SIG_RAW
  const encoded = canonicalBase64 ? std.toString('base64url') : Buffer.from(signature, 'utf8').toString('base64url')
  return `${baseId}${SIG_MARK}${kind}${encoded.length}${SIG_END}${encoded}`
}

/** Split an ID produced by `signedToolCallId` back into `{ id, signature }`. */
export function unsignedToolCallId(rawId) {
  const id = String(rawId || '')
  for (let at = 1; at < id.length; ) {
    const rel = id.indexOf(SIG_MARK, at)
    if (rel < 0) break
    at = rel + 1
    let rest = id.slice(rel + SIG_MARK.length)
    const raw = rest.startsWith(SIG_RAW)
    if (raw) rest = rest.slice(SIG_RAW.length)
    let digits = 0
    while (digits < rest.length && rest[digits] >= '0' && rest[digits] <= '9') digits++
    if (digits === 0) continue
    const afterDigits = rest.slice(digits)
    if (!afterDigits.startsWith(SIG_END)) continue
    const encoded = afterDigits.slice(SIG_END.length)
    if (!encoded || rest.slice(0, digits) !== String(encoded.length)) continue
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) continue
    try {
      const buf = Buffer.from(encoded, 'base64url')
      if (!buf.length || buf.toString('base64url') !== encoded) continue
      const signature = raw ? buf.toString('utf8') : buf.toString('base64')
      return { id: id.slice(0, rel), signature }
    } catch {
      continue
    }
  }
  return { id, signature: '' }
}

function parseJsonObjectArgs(raw) {
  if (isPlainObject(raw)) return raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return {}
    try {
      const parsed = JSON.parse(trimmed)
      if (isPlainObject(parsed)) return parsed
      return { value: parsed }
    } catch {
      return { _raw: raw }
    }
  }
  return {}
}

function isPlaceholderText(text, { allowEllipsis = false } = {}) {
  if (typeof text !== 'string') return true
  const trimmed = text.trim()
  if (!trimmed || trimmed === '(no content)' || trimmed === '·' || trimmed === '[undefined]') return true
  if (allowEllipsis && trimmed === '...') return true
  return false
}

function stripAnthropicBillingLines(text) {
  return stripVendorBillingLines(text)
}

function sanitizeNativeTuiResponseValue(value, depth = 0) {
  if (depth > 16) return value
  if (typeof value === 'string') return sanitizeNativeTuiText(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeNativeTuiResponseValue(item, depth + 1))
  if (isPlainObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === '[undefined]') continue
      out[k] = sanitizeNativeTuiResponseValue(v, depth + 1)
    }
    return out
  }
  return value
}

function cleanUndefinedStrings(value, depth = 0) {
  if (depth > 10) return value
  if (Array.isArray(value)) return value.map((item) => cleanUndefinedStrings(item, depth + 1))
  if (isPlainObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === '[undefined]') continue
      out[k] = cleanUndefinedStrings(v, depth + 1)
    }
    return out
  }
  return value
}

function geminiGeneration(model) {
  const match = /(?:^|\/)gemini-(\d+)/i.exec(String(model || ''))
  return match ? Number.parseInt(match[1], 10) : 0
}

function normalizeEffort(raw) {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^thinking_level_/, '')
  if (!value) return ''
  if (['none', 'off', 'disabled', '0'].includes(value)) return 'none'
  if (['minimal', 'min'].includes(value)) return 'minimal'
  if (value === 'low') return 'low'
  if (value === 'medium' || value === 'med' || value === 'auto' || value === 'adaptive') return 'medium'
  if (value === 'high') return 'high'
  if (value === 'xhigh' || value === 'extra_high' || value === 'extra-high') return 'xhigh'
  if (value === 'max') return 'max'
  return ''
}

function parseInboundModelSpec(rawModel, { allowLeadingModelsPrefix = false } = {}) {
  let work = typeof rawModel === 'string' ? rawModel.trim() : ''
  if (!work) return { model: '', parenEffort: '' }
  if (allowLeadingModelsPrefix && /^models\//i.test(work)) {
    work = work.replace(/^models\//i, '')
  }
  if (/\[1m\]$/i.test(work)) {
    work = work.replace(/\[1m\]$/i, '')
  }
  let parenEffort = ''
  const pm = /\(([^()]+)\)$/.exec(work)
  if (pm && pm.index > 0) {
    const rawEff = pm[1].trim()
    if (/^\d+$/.test(rawEff)) {
      parenEffort = effortFromBudget(Number(rawEff))
    } else {
      parenEffort = normalizeEffort(rawEff)
    }
    if (!parenEffort) return { model: '', parenEffort: '' }
    work = work.slice(0, pm.index)
  }
  if (/-latest$/i.test(work) && work.length > '-latest'.length) {
    work = work.replace(/-latest$/i, '')
  }
  if (!MODEL_RE.test(work)) return { model: '', parenEffort: '' }
  return { model: work, parenEffort }
}

function effortFromBudget(budget) {
  if (!Number.isFinite(budget) || budget === 0) return 'none'
  if (budget < 0) return 'medium'
  if (budget <= 4096) return 'low'
  if (budget <= 12288) return 'medium'
  return 'high'
}

function budgetFromEffort(effort) {
  switch (effort) {
    case 'none':
      return 0
    case 'minimal':
    case 'low':
      return 4096
    case 'medium':
      return 8192
    case 'high':
    case 'xhigh':
    case 'max':
      return 16384
    default:
      return 8192
  }
}

function lowerOpenApiTypes(node) {
  if (Array.isArray(node)) return node.map(lowerOpenApiTypes)
  if (!isPlainObject(node)) return node
  const out = {}
  for (const [key, val] of Object.entries(node)) {
    if (key === 'type') {
      if (typeof val === 'string') out.type = val.toLowerCase()
      else if (Array.isArray(val)) out.type = val.map((item) => (typeof item === 'string' ? item.toLowerCase() : item))
      else out.type = val
    } else if (key === 'nullable') {
      if (val === true) out['x-nullable'] = true
    } else if (key !== 'propertyOrdering' && key !== 'example') {
      out[key] = lowerOpenApiTypes(val)
    }
  }
  return out
}

/**
 * Check whether a JSON Schema `pattern` regex stays within the RE2-compatible
 * subset accepted by CRAGGemini / agy (no lookarounds, backreferences, atomic
 * groups, conditionals, or possessive quantifiers). Character classes and
 * backslash escapes are tracked so literal sequences inside `[...]` or escaped
 * parentheses do not trigger false positives (#1985).
 */
export function isRe2CompatibleRegex(pattern) {
  if (typeof pattern !== 'string' || !pattern) return false
  let inClass = false
  let classStart = -1
  let escaped = false
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (escaped) {
      if (!inClass) {
        if (ch >= '1' && ch <= '9') return false
        if (ch === 'k' && pattern[i + 1] === '<') return false
      }
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (inClass) {
      if (ch === ']' && i > classStart) {
        inClass = false
        classStart = -1
      }
      continue
    }
    if (ch === '[') {
      inClass = true
      classStart = i + 1
      if (pattern[classStart] === '^') classStart += 1
      continue
    }
    if (ch === '(' && pattern[i + 1] === '?') {
      const next = pattern[i + 2]
      if (next === '=' || next === '!' || next === '>' || next === '(') return false
      if (next === '<' && (pattern[i + 3] === '=' || pattern[i + 3] === '!')) return false
    }
    if (ch === '+' && i > 0) {
      const prev = pattern[i - 1]
      if (prev === '*' || prev === '+' || prev === '?' || prev === '}') {
        // Count preceding backslashes to distinguish escaped literal `\+` / `\*` / `\?` / `\}`.
        let slashes = 0
        for (let j = i - 2; j >= 0 && pattern[j] === '\\'; j -= 1) slashes += 1
        if (slashes % 2 === 0) return false
      }
    }
  }
  return true
}

function shapeJsonSchemaForGemini(node, isSchema = true) {
  if (isSchema && typeof node === 'boolean') return node ? {} : undefined
  if (!isPlainObject(node) || !isSchema) return node
  const out = {}
  for (const [key, val] of Object.entries(node)) {
    if (key.startsWith('x-')) continue
    if (SCHEMA_MAPS.has(key) && isPlainObject(val)) {
      const mapped = {}
      for (const [propName, propSchema] of Object.entries(val)) {
        if (!propName) continue
        const shaped = shapeJsonSchemaForGemini(propSchema, true)
        if (shaped !== undefined) mapped[propName] = shaped
      }
      out[key] = mapped
    } else if (SCHEMA_ONE.has(key)) {
      const shaped = shapeJsonSchemaForGemini(val, true)
      if (shaped !== undefined) out[key] = shaped
    } else if (SCHEMA_LIST.has(key) && Array.isArray(val)) {
      const list = val.map((item) => shapeJsonSchemaForGemini(item, true)).filter((item) => item !== undefined)
      if (list.length) out[key] = list
    } else if (key === 'pattern') {
      if (isRe2CompatibleRegex(val)) out[key] = val
    } else {
      out[key] = val
    }
  }
  return out
}

function ownShape(node) {
  if (node.properties != null || node.items != null) return true
  if (typeof node.type === 'string') return node.type !== 'null'
  if (Array.isArray(node.type)) return node.type.some((item) => item !== 'null')
  return false
}

function requiredNames(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function distinctStrings(values) {
  return [...new Set(values)]
}

function orderedDistinctStrings(values) {
  const seen = new Set()
  const out = []
  for (const item of values) {
    if (typeof item !== 'string' || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** Parameter names CRAGGemini / agy may inject when materializing MCP tools (#1915). */
const AGY_BRIDGE_INJECTED_PARAMS = new Set(['toolSummary'])

function agyBridgeClientAlias(param) {
  return `_client_${param}`
}

/** Whether the caller's tool schema declares a bridge-colliding param at the root level only (#1915). */
export function clientDeclaredAgyBridgeParam(schema, param) {
  if (!AGY_BRIDGE_INJECTED_PARAMS.has(param) || !isPlainObject(schema)) return false
  const props = isPlainObject(schema.properties) ? schema.properties : {}
  return Object.hasOwn(props, param)
}

/**
 * Rename client-declared tool parameters that collide with agy bridge injection so
 * downstream schema merging does not duplicate `required` entries (#1915).
 * Bridge injection is top-level only; renames apply only to root `properties`, not nested objects.
 */
export function avoidAgyBridgeParamCollisions(schema) {
  if (!isPlainObject(schema)) return schema
  const out = { ...schema }
  if (!isPlainObject(out.properties)) return out
  const props = { ...out.properties }
  const renames = new Map()
  for (const key of Object.keys(props)) {
    if (AGY_BRIDGE_INJECTED_PARAMS.has(key)) {
      const alias = agyBridgeClientAlias(key)
      if (!Object.hasOwn(props, alias)) {
        renames.set(key, alias)
        props[alias] = props[key]
        delete props[key]
      }
    }
  }
  out.properties = props
  if (Array.isArray(out.required)) {
    out.required = orderedDistinctStrings(
      out.required.map((n) => (typeof n === 'string' && renames.has(n) ? renames.get(n) : n)),
    )
  }
  return out
}

/**
 * Align historical `functionCall.args` with the forwarded schema before antigravity (#1915).
 */
export function forwardAgyBridgeToolArgs(args, schema) {
  if (!isPlainObject(args)) return args
  let out = null
  for (const name of AGY_BRIDGE_INJECTED_PARAMS) {
    if (!clientDeclaredAgyBridgeParam(schema, name)) continue
    const alias = agyBridgeClientAlias(name)
    if (Object.hasOwn(args, name) && !Object.hasOwn(args, alias)) {
      const o = out ?? { ...args }
      out = o
      o[alias] = args[name]
      delete o[name]
    }
  }
  return out ?? args
}

/**
 * Restore client parameter names after antigravity forwarding (#1915).
 * Drops bare bridge-injected keys only when the caller did not declare that param in the tool schema.
 */
export function restoreAgyBridgeToolArgs(args, schema = null) {
  if (!isPlainObject(args)) return args
  let out = null
  const touch = () => {
    if (!out) out = { ...args }
    return out
  }
  for (const name of AGY_BRIDGE_INJECTED_PARAMS) {
    const alias = agyBridgeClientAlias(name)
    const hasAlias = Object.hasOwn(args, alias)
    const hasOrig = Object.hasOwn(args, name)
    const clientDeclared = clientDeclaredAgyBridgeParam(schema, name)
    if (hasAlias) {
      const o = touch()
      o[name] = args[alias]
      delete o[alias]
    } else if (hasOrig && !clientDeclared) {
      const o = touch()
      delete o[name]
    }
  }
  return out || args
}

/**
 * Clean JSON Schema for Gemini / Antigravity `functionDeclarations`.
 * When `plain: true`, reduces to Gemini's OpenAPI Schema subset (inlining
 * local `$ref`, merging `allOf`, folding `anyOf`/`oneOf`, stripping unsupported
 * keywords, normalizing `type`/`items`/`enum`/`required`).
 */
export function sanitizeGeminiSchema(raw, { plain = false } = {}) {
  const root = isPlainObject(raw) ? raw : { type: 'object', properties: {} }
  if (!plain) {
    const shaped = shapeJsonSchemaForGemini(root, true)
    const result = isPlainObject(shaped) ? shaped : { type: 'object', properties: {} }
    if (Array.isArray(result.required)) {
      const props = isPlainObject(result.properties) ? result.properties : {}
      const keep = orderedDistinctStrings(
        result.required.filter((n) => typeof n === 'string' && Object.hasOwn(props, n)),
      )
      if (keep.length) result.required = keep
      else delete result.required
    }
    return result
  }
  const defs = {}
  for (const key of ['$defs', 'definitions']) {
    if (isPlainObject(root[key])) Object.assign(defs, root[key])
  }
  const localRef = (ref) => {
    if (ref === '#') return root
    if (ref.startsWith('#/')) {
      let cur = root
      for (const rawTok of ref.slice(2).split('/')) {
        const tok = rawTok.replace(/~1/g, '/').replace(/~0/g, '~')
        if (isPlainObject(cur) && Object.hasOwn(cur, tok)) cur = cur[tok]
        else if (Array.isArray(cur) && /^\d+$/.test(tok) && Number(tok) < cur.length) cur = cur[Number(tok)]
        else {
          cur = undefined
          break
        }
      }
      if (cur !== undefined) return cur
    }
    const tail = ref.slice(ref.lastIndexOf('/') + 1)
    return Object.hasOwn(defs, tail) ? defs[tail] : undefined
  }
  const resolveNode = (value) => {
    if (!isPlainObject(value)) return null
    if (typeof value.$ref === 'string') {
      const target = localRef(value.$ref)
      return isPlainObject(target) ? target : null
    }
    return value
  }
  const expanding = new Set()
  const normalizePlainSchemaType = (raw) => {
    if (typeof raw !== 'string') return null
    const lower = raw.trim().toLowerCase()
    if (PLAIN_SCHEMA_TYPES.has(lower)) return lower
    if (lower === 'float' || lower === 'double' || lower === 'decimal') return 'number'
    if (
      lower === 'int' ||
      lower === 'int32' ||
      lower === 'int64' ||
      lower === 'uint' ||
      lower === 'uint32' ||
      lower === 'uint64' ||
      lower === 'long' ||
      lower === 'short'
    ) {
      return 'integer'
    }
    if (lower === 'bool') return 'boolean'
    if (lower === 'dict' || lower === 'map' || lower === 'record') return 'object'
    if (lower === 'list' || lower === 'tuple') return 'array'
    return null
  }
  const schemaTypeOf = (node) => {
    const normalized = normalizePlainSchemaType(node.type)
    if (normalized) return normalized
    if (node.properties != null) return 'object'
    if (node.items != null) return 'array'
    return 'object'
  }
  const walk = (value, depth = 0, pointer = '') => {
    if (typeof value === 'boolean') return value ? {} : undefined
    if (Array.isArray(value))
      return value.map((item) => walk(item, depth, pointer)).filter((item) => item !== undefined)
    if (!isPlainObject(value)) return value
    if (depth > 32) return { type: 'object' }
    if (typeof value.$ref === 'string') {
      const ref = value.$ref
      const target = localRef(ref)
      if (!target) return { type: 'object' }
      const selfRef =
        ref.startsWith('#') && (ref === '#' || pointer === ref.slice(1) || pointer.startsWith(`${ref.slice(1)}/`))
      if (expanding.has(ref) || selfRef) {
        return { type: isPlainObject(target) ? schemaTypeOf(target) : 'object' }
      }
      expanding.add(ref)
      const resolved = walk(target, depth + 1, ref.startsWith('#') ? ref.slice(1) : pointer)
      expanding.delete(ref)
      return resolved ?? { type: 'object' }
    }
    if (Array.isArray(value.allOf)) {
      const merged = {}
      for (const [k, v] of Object.entries(value)) {
        if (k !== 'allOf') merged[k] = v
      }
      const req = requiredNames(value.required)
      for (const member of value.allOf) {
        const resolved = resolveNode(member)
        if (resolved) req.push(...requiredNames(resolved.required))
        const walked = walk(member, depth + 1, `${pointer}/allOf`)
        if (!isPlainObject(walked)) continue
        for (const [k, v] of Object.entries(walked)) {
          if (k === 'required') continue
          if (k === 'properties' && isPlainObject(v)) {
            merged.properties = { ...(isPlainObject(merged.properties) ? merged.properties : {}), ...v }
          } else if (merged[k] === undefined) {
            merged[k] = v
          }
        }
      }
      if (req.length) merged.required = distinctStrings(req)
      return walk(merged, depth + 1, pointer)
    }
    if ((value.anyOf != null || value.oneOf != null) && ownShape(value)) {
      const folded = {}
      for (const [k, v] of Object.entries(value)) {
        if (k !== 'anyOf' && k !== 'oneOf') folded[k] = v
      }
      const isObj =
        value.type === 'object' ||
        value.properties != null ||
        (Array.isArray(value.type) && value.type.includes('object'))
      const props = isPlainObject(value.properties) ? { ...value.properties } : {}
      let commonReq = null
      for (const key of ['anyOf', 'oneOf']) {
        if (!Array.isArray(value[key])) continue
        for (const alt of value[key]) {
          const m = resolveNode(alt)
          if (!m) continue
          if (m.type === 'null') {
            folded.nullable = true
            continue
          }
          if (!isObj) continue
          if (isPlainObject(m.properties)) {
            for (const pk of Object.keys(m.properties).sort()) {
              if (!Object.hasOwn(props, pk)) props[pk] = m.properties[pk]
            }
          }
          const branchReq = requiredNames(m.required)
          commonReq = commonReq === null ? [...branchReq] : commonReq.filter((n) => branchReq.includes(n))
        }
      }
      if (isObj) {
        if (Object.keys(props).length) folded.properties = props
        const req = [...requiredNames(value.required), ...(commonReq || [])]
        if (req.length) folded.required = distinctStrings(req)
      }
      return walk(folded, depth + 1, pointer)
    }
    for (const unionKey of ['anyOf', 'oneOf']) {
      if (Array.isArray(value[unionKey])) {
        let pick = null
        let nullable = false
        for (const alt of value[unionKey]) {
          if (isPlainObject(alt) && alt.type === 'null') nullable = true
          else if (!pick && isPlainObject(alt)) pick = alt
        }
        const out = pick ? walk(pick, depth + 1, `${pointer}/${unionKey}`) || {} : {}
        if (typeof value.description === 'string' && out.description === undefined) out.description = value.description
        if (nullable) out.nullable = true
        if (!out.type) out.type = 'string'
        return out
      }
    }
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (PLAIN_SCHEMA_KEEP.has(k)) {
        if (k === 'pattern' && !isRe2CompatibleRegex(v)) continue
        out[k] = v
      } else if ((k === 'exclusiveMinimum' || k === 'exclusiveMaximum') && typeof v === 'number') {
        const bound = k === 'exclusiveMinimum' ? 'minimum' : 'maximum'
        if (value[bound] === undefined) out[bound] = v
      } else if (k === 'type') {
        if (Array.isArray(v)) {
          for (const t of v) {
            const rawLower = typeof t === 'string' ? t.trim().toLowerCase() : ''
            if (rawLower === 'null') out.nullable = true
            else {
              const norm = normalizePlainSchemaType(t)
              if (norm && out.type === undefined) out.type = norm
            }
          }
          for (const t of v) {
            const norm = normalizePlainSchemaType(t)
            if ((norm === 'array' && value.items != null) || (norm === 'object' && value.properties != null)) {
              out.type = norm
              break
            }
          }
        } else if (typeof v === 'string') {
          if (v.trim().toLowerCase() === 'null') {
            out.nullable = true
          } else {
            const norm = normalizePlainSchemaType(v)
            if (norm) out.type = norm
          }
        }
      } else if (k === 'properties' && isPlainObject(v)) {
        const props = {}
        for (const [pk, pv] of Object.entries(v)) {
          if (!pk) continue
          const escaped = pk.replace(/~/g, '~0').replace(/\//g, '~1')
          const walked = walk(pv, depth + 1, `${pointer}/properties/${escaped}`)
          if (walked !== undefined) props[pk] = walked
        }
        out.properties = props
      } else if (k === 'items') {
        const walked = walk(v, depth + 1, `${pointer}/items`)
        if (walked !== undefined) out.items = walked
        else if (value.maxItems === undefined) {
          out.items = {}
          out.maxItems = 0
        }
      } else if (k === 'enum' && Array.isArray(v)) {
        if (v.every((item) => typeof item === 'string')) {
          const nonBlank = v.filter((item) => item.trim() !== '')
          if (nonBlank.length) out.enum = nonBlank
        }
      }
    }
    if (typeof value.const === 'string' && value.const.trim() !== '') {
      out.enum = [value.const]
    }
    if (out.enum && out.type === 'array') {
      const enumVals = out.enum
      delete out.enum
      if (isPlainObject(out.items) && !out.items.enum && (!out.items.type || out.items.type === 'string')) {
        out.items.type = 'string'
        out.items.enum = enumVals
      }
    }
    if (!out.type) {
      if (out.properties != null) out.type = 'object'
      else if (out.items != null) out.type = 'array'
    }
    if (out.type === 'array') {
      if (Array.isArray(out.items)) out.items = {}
      if (!isPlainObject(out.items)) out.items = {}
    }
    if (typeof out.type === 'string') {
      if (out.type !== 'array') {
        delete out.items
        delete out.minItems
        delete out.maxItems
      }
      if (out.type !== 'object') {
        delete out.properties
        delete out.required
        delete out.minProperties
        delete out.maxProperties
        delete out.propertyOrdering
      }
    }
    if (Array.isArray(out.required)) {
      const props = isPlainObject(out.properties) ? out.properties : {}
      const keep = orderedDistinctStrings(out.required.filter((n) => typeof n === 'string' && Object.hasOwn(props, n)))
      if (keep.length) out.required = keep
      else delete out.required
    }
    return out
  }
  const result = walk(root, 0, '')
  if (!isPlainObject(result)) return { type: 'object', properties: {} }
  if (!result.type) result.type = 'object'
  return result
}

function parseDataUrl(url) {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(url || ''))
  if (!match) return null
  const mimeType = match[1] || 'application/octet-stream'
  const isBase64 = match[2] === ';base64'
  const raw = match[3] || ''
  if (isBase64) return { mimeType, data: raw }
  try {
    return { mimeType, data: Buffer.from(decodeURIComponent(raw), 'utf8').toString('base64') }
  } catch {
    return null
  }
}

function mediaPartFromUrl(url, fallbackMime = 'image/png') {
  const s = String(url || '').trim()
  if (!s) return null
  if (s.startsWith('data:')) {
    const parsed = parseDataUrl(s)
    if (!parsed) return null
    const kind = parsed.mimeType.startsWith('image/') ? 'image' : 'file'
    return { kind, mediaType: parsed.mimeType, data: parsed.data }
  }
  const kind = fallbackMime.startsWith('image/') ? 'image' : 'file'
  return { kind, mediaType: fallbackMime, url: s }
}

function extractGeminiSystemText(raw) {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  const parts = Array.isArray(raw) ? raw : isPlainObject(raw) && Array.isArray(raw.parts) ? raw.parts : []
  const texts = []
  for (const part of parts) {
    if (isPlainObject(part) && !part.thought && typeof part.text === 'string' && part.text) {
      texts.push(part.text)
    }
  }
  return texts.join('\n\n')
}

function extractFunctionResponseText(raw) {
  if (raw == null) return { text: '', isError: false }
  if (typeof raw === 'string') return { text: raw, isError: false }
  if (isPlainObject(raw)) {
    const keys = Object.keys(raw)
    if (keys.length === 1 && keys[0] === 'error') {
      return { text: typeof raw.error === 'string' ? raw.error : JSON.stringify(raw.error), isError: true }
    }
    if (keys.length === 1 && (keys[0] === 'output' || keys[0] === 'result' || keys[0] === 'content')) {
      const val = raw[keys[0]]
      return { text: typeof val === 'string' ? val : JSON.stringify(val), isError: false }
    }
  }
  return { text: JSON.stringify(raw), isError: false }
}

function formatExecutableCodePart(part) {
  if (isPlainObject(part.executableCode)) {
    const lang = String(part.executableCode.language || '').toLowerCase()
    const code = String(part.executableCode.code || '').replace(/\n+$/, '')
    return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`
  }
  if (isPlainObject(part.codeExecutionResult)) {
    const outcome = String(part.codeExecutionResult.outcome || '')
    const output = String(part.codeExecutionResult.output || '').replace(/\n+$/, '')
    let out = ''
    if (outcome && outcome !== 'OUTCOME_OK') out += `\n${outcome}:`
    if (output) out += `\n\`\`\`\n${output}\n\`\`\`\n`
    return out
  }
  return ''
}

function parseGeminiNativeInbound(rawBody, { routeModel, routeStream }) {
  const body = geminiCamelCase(rawBody)
  const rawSelected = routeModel || (typeof body.model === 'string' ? body.model : '')
  if (body.model != null && routeModel && body.model !== routeModel) {
    throw makeProtocolError(400, 'gemini_invalid_model', 'A valid Gemini model is required.')
  }
  const { model, parenEffort } = parseInboundModelSpec(rawSelected, { allowLeadingModelsPrefix: true })
  if (!model) {
    throw makeProtocolError(400, 'gemini_invalid_model', 'A valid Gemini model is required.')
  }
  if (!Array.isArray(body.contents) || body.contents.length === 0) {
    throw makeProtocolError(400, 'gemini_invalid_request', 'Gemini contents must be a non-empty array.')
  }
  const stream = typeof routeStream === 'boolean' ? routeStream : body.stream === true
  const systemParts = []
  const initialSystem = extractGeminiSystemText(body.systemInstruction)
  if (initialSystem) systemParts.push(initialSystem)
  const messages = []
  const lastByName = new Map()
  const openByName = new Map()
  let inLeadingSystem = true

  for (const content of body.contents) {
    if (!isPlainObject(content) || !Array.isArray(content.parts)) {
      throw makeProtocolError(400, 'gemini_invalid_request', 'Each Gemini content entry must have a parts array.')
    }
    if (content.role === 'system' || content.role === 'developer') {
      const sysText = extractGeminiSystemText(content.parts)
      if (sysText.trim()) {
        if (inLeadingSystem) systemParts.push(sysText)
        else {
          messages.push({
            role: 'user',
            parts: [{ kind: 'text', text: `<system-reminder>\n${sysText.trim()}\n</system-reminder>`, signature: '' }],
          })
        }
      }
      continue
    }
    inLeadingSystem = false
    const baseRole = content.role === 'model' || content.role === 'assistant' ? 'assistant' : 'user'
    let msg = { role: baseRole, parts: [] }
    const switchRole = (role) => {
      if (msg.role !== role) {
        if (msg.parts.length) messages.push(msg)
        msg = { role, parts: [] }
      }
    }
    for (const part of content.parts) {
      if (!isPlainObject(part)) {
        throw makeProtocolError(400, 'gemini_invalid_request', 'Each Gemini part must be an object.')
      }
      if (part.functionResponse) switchRole('user')
      else switchRole(baseRole)

      if (isPlainObject(part.functionCall)) {
        const fc = part.functionCall
        if (typeof fc.name !== 'string' || !fc.name) {
          throw makeProtocolError(400, 'gemini_invalid_request', 'functionCall.name is required.')
        }
        const id = typeof fc.id === 'string' && fc.id ? fc.id : newCallId()
        lastByName.set(fc.name, id)
        if (!openByName.has(fc.name)) openByName.set(fc.name, [])
        openByName.get(fc.name).push(id)
        msg.parts.push({
          kind: 'tool_call',
          id,
          name: fc.name,
          args: parseJsonObjectArgs(fc.args),
          signature: typeof part.thoughtSignature === 'string' ? part.thoughtSignature : '',
        })
      } else if (isPlainObject(part.functionResponse)) {
        const fr = part.functionResponse
        const name = typeof fr.name === 'string' ? fr.name : 'tool'
        let id = typeof fr.id === 'string' && fr.id ? fr.id : ''
        if (!id) {
          const queue = openByName.get(name)
          id = queue?.length ? queue[0] : lastByName.get(name) || newCallId()
        }
        if (openByName.has(name)) {
          openByName.set(
            name,
            openByName.get(name).filter((item) => item !== id),
          )
        }
        const { text, isError } = extractFunctionResponseText(fr.response)
        const images = []
        const extraFiles = []
        let mergedText = text
        if (Array.isArray(fr.parts)) {
          for (const nested of fr.parts) {
            if (!isPlainObject(nested)) continue
            if (isPlainObject(nested.inlineData) && typeof nested.inlineData.data === 'string') {
              const mediaType = nested.inlineData.mimeType || 'application/octet-stream'
              const item = {
                kind: mediaType.startsWith('image/') ? 'image' : 'file',
                mediaType,
                data: nested.inlineData.data,
              }
              if (item.kind === 'image') images.push(item)
              else extraFiles.push(item)
            } else if (isPlainObject(nested.fileData) && typeof nested.fileData.fileUri === 'string') {
              const mediaType = nested.fileData.mimeType || 'application/octet-stream'
              const item = {
                kind: mediaType.startsWith('image/') ? 'image' : 'file',
                mediaType,
                url: nested.fileData.fileUri,
              }
              if (item.kind === 'image') images.push(item)
              else extraFiles.push(item)
            } else if (typeof nested.text === 'string' && nested.text && !nested.thought) {
              mergedText = mergedText.trim() ? `${mergedText}\n\n${nested.text}` : nested.text
            }
          }
        }
        msg.parts.push({ kind: 'tool_result', callId: id, name, text: mergedText, isError, images })
        for (const f of extraFiles) msg.parts.push(f)
      } else if (isPlainObject(part.inlineData)) {
        const mimeType = typeof part.inlineData.mimeType === 'string' ? part.inlineData.mimeType.trim() : ''
        const data = typeof part.inlineData.data === 'string' ? part.inlineData.data.trim() : ''
        if (!mimeType || !data) {
          throw makeProtocolError(400, 'gemini_invalid_request', 'inlineData requires mimeType and data.')
        }
        msg.parts.push({ kind: mimeType.startsWith('image/') ? 'image' : 'file', mediaType: mimeType, data })
      } else if (isPlainObject(part.fileData)) {
        const fileUri = typeof part.fileData.fileUri === 'string' ? part.fileData.fileUri : ''
        const mimeType =
          typeof part.fileData.mimeType === 'string' ? part.fileData.mimeType : 'application/octet-stream'
        if (!fileUri) throw makeProtocolError(400, 'gemini_invalid_request', 'fileData requires fileUri.')
        msg.parts.push({ kind: mimeType.startsWith('image/') ? 'image' : 'file', mediaType: mimeType, url: fileUri })
      } else if (part.executableCode || part.codeExecutionResult) {
        const text = formatExecutableCodePart(part)
        if (text) msg.parts.push({ kind: 'text', text, signature: '' })
      } else if (part.thought === true) {
        msg.parts.push({
          kind: 'thinking',
          text: typeof part.text === 'string' ? part.text : '',
          signature: typeof part.thoughtSignature === 'string' ? part.thoughtSignature : '',
        })
      } else if (typeof part.text === 'string' || typeof part.thoughtSignature === 'string') {
        msg.parts.push({
          kind: 'text',
          text: typeof part.text === 'string' ? part.text : '',
          signature: typeof part.thoughtSignature === 'string' ? part.thoughtSignature : '',
        })
      } else {
        throw makeProtocolError(400, 'gemini_invalid_request', 'Unsupported Gemini content part.')
      }
    }
    if (msg.parts.length) messages.push(msg)
  }

  let webSearch = false
  const googleTools = []
  const tools = []
  let allowedNames = null
  const fcConfig = isPlainObject(body.toolConfig?.functionCallingConfig) ? body.toolConfig.functionCallingConfig : null
  if (
    fcConfig &&
    ['ANY', 'VALIDATED'].includes(String(fcConfig.mode || '').toUpperCase()) &&
    Array.isArray(fcConfig.allowedFunctionNames) &&
    fcConfig.allowedFunctionNames.length
  ) {
    allowedNames = new Set(fcConfig.allowedFunctionNames.filter((n) => typeof n === 'string'))
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!isPlainObject(tool))
        throw makeProtocolError(400, 'gemini_invalid_request', 'Each Gemini tool must be an object.')
      for (const key of Object.keys(tool).sort()) {
        if (key === 'functionDeclarations') continue
        if (GOOGLE_SEARCH_TOOLS.has(key)) {
          webSearch = true
        } else {
          googleTools.push({ [key]: tool[key] ?? {} })
        }
      }
      if (Array.isArray(tool.functionDeclarations)) {
        for (const decl of tool.functionDeclarations) {
          if (!isPlainObject(decl) || typeof decl.name !== 'string' || !decl.name.trim()) {
            throw makeProtocolError(400, 'gemini_invalid_request', 'functionDeclarations[].name is required.')
          }
          if (allowedNames && !allowedNames.has(decl.name)) continue
          const schema = decl.parametersJsonSchema || (decl.parameters ? lowerOpenApiTypes(decl.parameters) : null)
          tools.push({
            name: decl.name,
            description: typeof decl.description === 'string' ? decl.description : '',
            schema: schema || { type: 'object', properties: {} },
          })
        }
      }
    }
  }

  let toolChoice = ''
  let strictValidation = false
  if (fcConfig) {
    const mode = String(fcConfig.mode || 'AUTO').toUpperCase()
    if (mode === 'NONE') toolChoice = 'none'
    else if (mode === 'ANY') {
      if (
        Array.isArray(fcConfig.allowedFunctionNames) &&
        fcConfig.allowedFunctionNames.length === 1 &&
        tools.length === 1 &&
        tools[0].name === fcConfig.allowedFunctionNames[0]
      ) {
        toolChoice = `name:${fcConfig.allowedFunctionNames[0]}`
      } else {
        toolChoice = 'required'
      }
    } else if (mode === 'VALIDATED') {
      strictValidation = true
      toolChoice = 'auto'
    } else {
      toolChoice = 'auto'
    }
  }

  const gc = isPlainObject(body.generationConfig) ? body.generationConfig : null
  const generationConfig = {}
  const extraGenConfig = {}
  let thinking = null
  let hideThinking = false
  let responseFormat = null
  if (gc) {
    if (gc.speechConfig != null) {
      throw makeProtocolError(400, 'gemini_invalid_request', 'Audio output (speechConfig) is not supported.')
    }
    if (Array.isArray(gc.responseModalities) && gc.responseModalities.length) {
      const mods = gc.responseModalities.map((m) => String(m || '').toUpperCase()).filter(Boolean)
      if (mods.includes('AUDIO')) {
        throw makeProtocolError(400, 'gemini_invalid_request', 'Audio output modality is not supported.')
      }
      generationConfig.responseModalities = mods
    }
    if (Number.isInteger(gc.candidateCount) && gc.candidateCount > 0) {
      generationConfig.candidateCount = gc.candidateCount
    }
    if (Number.isInteger(gc.maxOutputTokens) && gc.maxOutputTokens > 0) {
      generationConfig.maxOutputTokens = gc.maxOutputTokens
    }
    if (typeof gc.temperature === 'number' && Number.isFinite(gc.temperature)) {
      generationConfig.temperature = gc.temperature
    }
    if (typeof gc.topP === 'number' && Number.isFinite(gc.topP)) {
      generationConfig.topP = gc.topP
    }
    if (Number.isInteger(gc.topK) && gc.topK > 0) {
      generationConfig.topK = gc.topK
    }
    if (Array.isArray(gc.stopSequences) && gc.stopSequences.length) {
      generationConfig.stopSequences = gc.stopSequences.map(String)
    }
    if (isPlainObject(gc.thinkingConfig)) {
      const tc = gc.thinkingConfig
      const effort = !isEmptyEffortValue(tc.thinkingLevel)
        ? normalizeEffort(tc.thinkingLevel)
        : typeof tc.thinkingBudget === 'number'
          ? effortFromBudget(tc.thinkingBudget)
          : ''
      if (tc.includeThoughts === false || effort === 'none' || tc.thinkingBudget === 0) {
        hideThinking = true
      }
      thinking = {
        enabled: effort !== 'none' && (Boolean(effort) || tc.includeThoughts === true),
        disabled: effort === 'none' || tc.thinkingBudget === 0,
        effort: effort && effort !== 'none' ? effort : '',
        budgetTokens: typeof tc.thinkingBudget === 'number' ? tc.thinkingBudget : undefined,
        includeThoughts: tc.includeThoughts !== false,
      }
    }
    if (typeof gc.responseMimeType === 'string' && gc.responseMimeType.startsWith('application/json')) {
      const schema = gc.responseJsonSchema || (gc.responseSchema ? lowerOpenApiTypes(gc.responseSchema) : null)
      responseFormat = schema ? { type: 'json_schema', schema } : { type: 'json_object' }
    } else if (gc.responseMimeType === 'text/x.enum') {
      const schema = gc.responseJsonSchema || (gc.responseSchema ? lowerOpenApiTypes(gc.responseSchema) : null)
      const values = Array.isArray(schema?.enum) ? schema.enum.filter((v) => typeof v === 'string') : []
      if (!values.length) {
        throw makeProtocolError(
          400,
          'gemini_invalid_request',
          'text/x.enum requires string enum values in responseSchema.',
        )
      }
      responseFormat = { type: 'enum', values }
    }
    if (isPlainObject(gc.imageConfig)) {
      generationConfig.imageConfig = gc.imageConfig
    }
    for (const [k, v] of Object.entries(gc)) {
      if (!GEN_READ_OR_BUILT.has(k) && k !== 'responseModalities' && v != null) extraGenConfig[k] = v
    }
  }
  if (!thinking && parenEffort) {
    if (parenEffort === 'none') hideThinking = true
    thinking = {
      enabled: parenEffort !== 'none',
      disabled: parenEffort === 'none',
      effort: parenEffort !== 'none' ? parenEffort : '',
      includeThoughts: !hideThinking,
    }
  }

  return {
    protocol: 'gemini',
    model,
    stream,
    system: systemParts.join('\n\n'),
    messages,
    tools,
    toolChoice,
    allowedToolNames: allowedNames ? [...allowedNames] : null,
    disableParallelTools: false,
    legacyFunctions: false,
    strictValidation,
    webSearch,
    searchOptions: null,
    googleTools,
    generationConfig,
    extraGenConfig,
    thinking,
    hideThinking,
    thinkingDisplay: null,
    includeEncryptedReasoning: false,
    responseFormat,
    safetySettings: Array.isArray(body.safetySettings) ? body.safetySettings : null,
    cachedContent: typeof body.cachedContent === 'string' ? body.cachedContent : null,
    conversationId: sanitizeConversationId(body.conversationId ?? body.conversation_id),
  }
}

function parseOpenAIChatInbound(body, { headers }) {
  const { model, parenEffort } = parseInboundModelSpec(body.model, { allowLeadingModelsPrefix: true })
  if (!model) throw makeProtocolError(400, 'gemini_invalid_model', 'A valid Gemini model is required.')
  if (body.stream != null && typeof body.stream !== 'boolean') {
    throw makeProtocolError(400, 'gemini_invalid_request', 'stream must be a boolean.')
  }
  if (body.n != null && body.n !== 1) {
    throw makeProtocolError(400, 'gemini_invalid_request', 'n > 1 is not supported.')
  }
  if (
    body.audio != null ||
    (Array.isArray(body.modalities) && body.modalities.some((m) => String(m || '').toLowerCase() === 'audio'))
  ) {
    throw makeProtocolError(400, 'gemini_invalid_request', 'Audio output is not supported.')
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw makeProtocolError(400, 'gemini_invalid_request', 'messages must be a non-empty array.')
  }
  const stream = isClientStream(body, headers)
  const systemParts = []
  const messages = []
  let inLeadingSystem = true

  const extractParts = (content) => {
    if (content == null) return []
    if (typeof content === 'string') return content ? [{ kind: 'text', text: content, signature: '' }] : []
    if (!Array.isArray(content)) throw makeProtocolError(400, 'gemini_invalid_request', 'Invalid message content.')
    const out = []
    for (const part of content) {
      if (typeof part === 'string') {
        if (part) out.push({ kind: 'text', text: part, signature: '' })
        continue
      }
      if (!isPlainObject(part))
        throw makeProtocolError(400, 'gemini_invalid_request', 'Content part must be an object.')
      if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
        if (typeof part.text !== 'string') {
          throw makeProtocolError(400, 'gemini_invalid_request', 'text content part requires a string text field.')
        }
        out.push({ kind: 'text', text: part.text, signature: '' })
      } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
        if (part.refusal) out.push({ kind: 'text', text: part.refusal, signature: '' })
      } else if (part.type === 'image_url' || part.type === 'input_image') {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url || part.url
        const media = mediaPartFromUrl(url, 'image/png')
        if (!media) throw makeProtocolError(400, 'gemini_invalid_request', 'image_url must include a valid URL.')
        out.push(media)
      } else if (part.type === 'input_audio' && isPlainObject(part.input_audio)) {
        const data = typeof part.input_audio.data === 'string' ? part.input_audio.data.trim() : ''
        const fmt = String(part.input_audio.format || 'wav')
          .trim()
          .toLowerCase()
          .replace(/^audio\//, '')
        if (!data) throw makeProtocolError(400, 'gemini_invalid_request', 'input_audio requires data.')
        const mime = fmt === 'mp3' || fmt === 'mpeg' ? 'audio/mpeg' : `audio/${fmt || 'wav'}`
        out.push({ kind: 'file', mediaType: mime, data })
      } else if (part.type === 'file' && isPlainObject(part.file)) {
        const fileData = part.file.file_data || part.file.data
        const media = mediaPartFromUrl(fileData, part.file.media_type || 'application/pdf')
        if (!media) throw makeProtocolError(400, 'gemini_invalid_request', 'file part requires file_data.')
        out.push(media)
      } else {
        throw makeProtocolError(400, 'gemini_invalid_request', `Unsupported content part type: ${String(part.type)}`)
      }
    }
    return out
  }

  for (const raw of body.messages) {
    if (!isPlainObject(raw) || typeof raw.role !== 'string') {
      throw makeProtocolError(400, 'gemini_invalid_request', 'Each message must be an object with role.')
    }
    if (raw.role === 'system' || raw.role === 'developer') {
      const text = extractParts(raw.content)
        .filter((p) => p.kind === 'text')
        .map((p) => p.text)
        .join('\n')
      if (text.trim()) {
        if (inLeadingSystem) {
          systemParts.push(text)
        } else {
          messages.push({
            role: 'user',
            parts: [{ kind: 'text', text: `<system-reminder>\n${text.trim()}\n</system-reminder>`, signature: '' }],
          })
        }
      }
    } else if (raw.role === 'user') {
      inLeadingSystem = false
      const parts = extractParts(raw.content)
      if (parts.length) messages.push({ role: 'user', parts })
    } else if (raw.role === 'assistant') {
      inLeadingSystem = false
      const parts = []
      if (typeof raw.reasoning_content === 'string' && raw.reasoning_content) {
        parts.push({ kind: 'thinking', text: raw.reasoning_content, signature: '' })
      }
      parts.push(...extractParts(raw.content))
      if (typeof raw.refusal === 'string' && raw.refusal) {
        parts.push({ kind: 'text', text: raw.refusal, signature: '' })
      }
      if (isPlainObject(raw.function_call) && typeof raw.function_call.name === 'string' && raw.function_call.name) {
        parts.push({
          kind: 'tool_call',
          id: newCallId(),
          name: raw.function_call.name,
          args: parseJsonObjectArgs(raw.function_call.arguments ?? '{}'),
          signature: '',
        })
      }
      if (Array.isArray(raw.tool_calls)) {
        for (const call of raw.tool_calls) {
          if (call?.type === 'custom' && isPlainObject(call.custom)) {
            const name = call.custom.name
            if (!name) throw makeProtocolError(400, 'gemini_invalid_request', 'tool_calls[].custom.name is required.')
            const { id, signature: idSig } = unsignedToolCallId(call.id || newCallId())
            const extraSig = call?.extra_content?.google?.thought_signature || ''
            parts.push({
              kind: 'tool_call',
              id,
              name,
              args: {
                input:
                  typeof call.custom.input === 'string' ? call.custom.input : JSON.stringify(call.custom.input ?? ''),
              },
              signature: extraSig || idSig,
            })
            continue
          }
          const name = call?.function?.name || call?.name
          if (!name) throw makeProtocolError(400, 'gemini_invalid_request', 'tool_calls[].function.name is required.')
          const { id, signature: idSig } = unsignedToolCallId(call.id || newCallId())
          const extraSig = call?.extra_content?.google?.thought_signature || ''
          parts.push({
            kind: 'tool_call',
            id,
            name,
            args: parseJsonObjectArgs(call?.function?.arguments ?? call?.arguments ?? '{}'),
            signature: extraSig || idSig,
          })
        }
      }
      if (parts.length) messages.push({ role: 'assistant', parts })
    } else if (raw.role === 'tool' || raw.role === 'function') {
      inLeadingSystem = false
      const { id } = unsignedToolCallId(raw.tool_call_id || raw.id || newCallId())
      const contentParts = extractParts(raw.content)
      const text = contentParts
        .filter((p) => p.kind === 'text')
        .map((p) => p.text)
        .join('\n')
      const images = contentParts.filter((p) => p.kind === 'image')
      const isError = raw.is_error === true || raw.isError === true
      const finalText = !text.trim() && !images.length ? (isError ? EMPTY_TOOL_ERR_TEXT : EMPTY_TOOL_OK_TEXT) : text
      messages.push({
        role: 'user',
        parts: [
          {
            kind: 'tool_result',
            callId: id,
            name: typeof raw.name === 'string' ? raw.name : '',
            text: finalText,
            isError,
            images,
          },
        ],
      })
    } else {
      throw makeProtocolError(400, 'gemini_invalid_request', `Unsupported message role: ${raw.role}`)
    }
  }

  let webSearch = false
  let searchOptions = null
  if (isPlainObject(body.web_search_options)) {
    webSearch = true
    searchOptions = mergeSearchOptions(searchOptions, body.web_search_options)
  }
  const googleTools = []
  const tools = []
  const legacyFunctions = !Array.isArray(body.tools) && Array.isArray(body.functions) && body.functions.length > 0
  const rawTools = Array.isArray(body.tools) ? body.tools : Array.isArray(body.functions) ? body.functions : []
  for (const tool of rawTools) {
    if (!isPlainObject(tool)) throw makeProtocolError(400, 'gemini_invalid_request', 'Each tool must be an object.')
    if (tool.type === 'function' && isPlainObject(tool.function)) {
      if (!tool.function.name) throw makeProtocolError(400, 'gemini_invalid_request', 'tool.function.name is required.')
      tools.push({
        name: String(tool.function.name),
        description: typeof tool.function.description === 'string' ? tool.function.description : '',
        schema: tool.function.parameters || { type: 'object', properties: {} },
        strict: tool.function.strict === true,
        kind: 'function',
      })
    } else if (tool.type === 'custom' && isPlainObject(tool.custom)) {
      if (!tool.custom.name) throw makeProtocolError(400, 'gemini_invalid_request', 'tool.custom.name is required.')
      tools.push({
        name: String(tool.custom.name),
        description: typeof tool.custom.description === 'string' ? tool.custom.description : '',
        schema: customToolSchema(tool.custom.format),
        strict: false,
        kind: 'custom_chat',
      })
    } else if (tool.name && !tool.type) {
      tools.push({
        name: String(tool.name),
        description: typeof tool.description === 'string' ? tool.description : '',
        schema: tool.parameters || tool.input_schema || { type: 'object', properties: {} },
        strict: tool.strict === true,
        kind: legacyFunctions ? 'legacy_function' : 'function',
      })
    } else if (typeof tool.type === 'string' && tool.type.startsWith('web_search')) {
      webSearch = true
      searchOptions = mergeSearchOptions(searchOptions, tool)
    } else {
      for (const [k, v] of Object.entries(tool)) {
        const camel = snakeToCamel(k)
        if (GOOGLE_SEARCH_TOOLS.has(camel)) webSearch = true
        else if (GOOGLE_TOOL_NAMES.has(camel)) googleTools.push({ [camel]: v ?? {} })
      }
    }
  }

  let toolChoice = ''
  let allowedToolNames = null
  const tc = body.tool_choice ?? body.function_call
  if (typeof tc === 'string') {
    const lower = tc.toLowerCase()
    if (['none', 'auto', 'required'].includes(lower)) toolChoice = lower
  } else if (isPlainObject(tc)) {
    if (tc.type === 'allowed_tools') {
      const cfg = isPlainObject(tc.allowed_tools) ? tc.allowed_tools : tc
      const mode = String(cfg.mode || 'auto').toLowerCase()
      toolChoice = mode === 'required' ? 'required' : 'auto'
      if (Array.isArray(cfg.tools)) {
        allowedToolNames = cfg.tools
          .map((item) => item?.function?.name || item?.custom?.name || item?.name || '')
          .filter(Boolean)
      }
    } else {
      const name = tc.function?.name || tc.custom?.name || tc.name
      if (name) toolChoice = `name:${name}`
      else if (tc.type === 'none' || tc.type === 'auto') toolChoice = tc.type
      else if (tc.type === 'required' || tc.type === 'any') toolChoice = 'required'
    }
  }
  const disableParallelTools = body.parallel_tool_calls === false || legacyFunctions

  const generationConfig = {}
  const maxTokens = body.max_completion_tokens ?? body.max_tokens
  if (Number.isInteger(maxTokens) && maxTokens > 0) generationConfig.maxOutputTokens = maxTokens
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    generationConfig.temperature = body.temperature
  }
  if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) generationConfig.topP = body.top_p
  if (typeof body.stop === 'string' && body.stop) generationConfig.stopSequences = [body.stop]
  else if (Array.isArray(body.stop) && body.stop.length) generationConfig.stopSequences = body.stop.map(String)

  let thinking = null
  let hideThinking = false
  const rawGoogleTc = body.extra_body?.google?.thinking_config ?? body.extra_body?.google?.thinkingConfig
  const googleTc = isPlainObject(rawGoogleTc) ? rawGoogleTc : null
  const tcLevel = googleTc?.thinking_level ?? googleTc?.thinkingLevel
  const tcBudget = googleTc?.thinking_budget ?? googleTc?.thinkingBudget
  const tcInclude = googleTc?.include_thoughts ?? googleTc?.includeThoughts
  const effort = normalizeEffort(
    firstNonEmptyEffort(
      tcLevel,
      body.reasoning_effort,
      body.reasoning?.effort,
      body.output_config?.effort,
      parenEffort,
    ),
  )
  if (body.reasoning?.summary === 'none' || tcInclude === false || effort === 'none') {
    hideThinking = true
  }
  if (effort) {
    thinking = {
      enabled: effort !== 'none',
      disabled: effort === 'none',
      effort: effort !== 'none' ? effort : '',
      includeThoughts: !hideThinking,
    }
  } else if (typeof tcBudget === 'number' && Number.isFinite(tcBudget)) {
    const budget = tcBudget
    if (budget === 0) hideThinking = true
    thinking = {
      enabled: budget !== 0,
      disabled: budget === 0,
      effort: budget > 0 ? effortFromBudget(budget) : '',
      budgetTokens: budget,
      includeThoughts: !hideThinking,
    }
  } else if (tcInclude === true) {
    thinking = {
      enabled: true,
      disabled: false,
      effort: '',
      includeThoughts: true,
    }
  } else if (isPlainObject(body.thinking)) {
    const type = String(body.thinking.type || '').toLowerCase()
    const budget = Number(body.thinking.budget_tokens ?? body.thinking.budgetTokens)
    if (type === 'disabled') hideThinking = true
    thinking = {
      enabled: type === 'enabled' || type === 'adaptive',
      disabled: type === 'disabled',
      effort: Number.isFinite(budget) && budget > 0 ? effortFromBudget(budget) : type === 'adaptive' ? 'medium' : '',
      budgetTokens: Number.isFinite(budget) ? budget : undefined,
      includeThoughts: !hideThinking,
    }
  }

  let responseFormat = null
  if (isPlainObject(body.response_format)) {
    if (body.response_format.type === 'json_object') responseFormat = { type: 'json_object' }
    else if (body.response_format.type === 'json_schema') {
      const spec = isPlainObject(body.response_format.json_schema)
        ? body.response_format.json_schema
        : body.response_format
      if (spec.schema !== undefined && !isPlainObject(spec.schema)) {
        throw makeProtocolError(
          400,
          'gemini_invalid_request',
          'response_format.json_schema.schema must be a JSON object.',
        )
      }
      responseFormat = {
        type: 'json_schema',
        schema: spec.schema || { type: 'object' },
        ...(typeof spec.description === 'string' && spec.description.trim()
          ? { description: spec.description.trim() }
          : {}),
      }
    }
  }

  return {
    protocol: 'openai-chat',
    model,
    stream,
    system: systemParts.join('\n\n'),
    messages,
    tools,
    toolChoice,
    allowedToolNames,
    disableParallelTools,
    legacyFunctions,
    strictValidation: tools.some((t) => t.strict),
    webSearch,
    searchOptions,
    googleTools,
    generationConfig,
    extraGenConfig: {},
    thinking,
    hideThinking,
    thinkingDisplay: null,
    includeEncryptedReasoning: false,
    responseFormat,
    safetySettings: null,
    cachedContent: null,
    conversationId: sanitizeConversationId(body.conversation_id ?? headers?.['x-conversation-id']),
  }
}

function parseOpenAIResponsesInbound(body, { headers }) {
  const { model, parenEffort } = parseInboundModelSpec(body.model, { allowLeadingModelsPrefix: true })
  if (!model) throw makeProtocolError(400, 'gemini_invalid_model', 'A valid Gemini model is required.')
  if (body.stream != null && typeof body.stream !== 'boolean') {
    throw makeProtocolError(400, 'gemini_invalid_request', 'stream must be a boolean.')
  }
  const stream = isClientStream(body, headers)
  const systemParts = []
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    systemParts.push(body.instructions)
  }
  const messages = []
  let webSearch = false
  let searchOptions = null
  const tools = []
  const generationConfig = {}

  const addResponsesTool = (tool, ns = '') => {
    if (!isPlainObject(tool)) throw makeProtocolError(400, 'gemini_invalid_request', 'Each tool must be an object.')
    if (typeof tool.type === 'string' && tool.type.startsWith('web_search')) {
      webSearch = true
      searchOptions = mergeSearchOptions(searchOptions, tool)
      return
    }
    if (tool.type === 'image_generation') {
      generationConfig.responseModalities = ['TEXT', 'IMAGE']
      const imgCfg = imageConfigFromOpenAISizeQuality(tool.size, tool.quality)
      if (imgCfg) generationConfig.imageConfig = imgCfg
      return
    }
    if (tool.type === 'namespace' && typeof tool.name === 'string' && Array.isArray(tool.tools)) {
      const nsName = tool.name.trim()
      for (const child of tool.tools) addResponsesTool(child, nsName)
      return
    }
    if (tool.type === 'custom') {
      const rawName = String(tool.name || tool.custom?.name || '').trim()
      if (!rawName) throw makeProtocolError(400, 'gemini_invalid_request', 'custom tool name is required.')
      const fullName = ns && ns !== 'functions' ? `${ns}.${rawName}` : rawName
      tools.push({
        name: fullName,
        origName: rawName,
        namespace: ns && ns !== 'functions' ? ns : '',
        description:
          typeof (tool.description ?? tool.custom?.description) === 'string'
            ? (tool.description ?? tool.custom?.description)
            : '',
        schema: customToolSchema(tool.format ?? tool.custom?.format),
        strict: false,
        kind: 'custom_responses',
      })
      return
    }
    if (tool.type === 'local_shell' || tool.type === 'shell' || tool.type === 'apply_patch') {
      const spec = BUILTIN_CLIENT_TOOL_SCHEMAS[tool.type]
      tools.push({
        name: tool.type,
        origName: tool.type,
        namespace: '',
        description: typeof tool.description === 'string' && tool.description ? tool.description : spec.description,
        schema: spec.schema,
        strict: false,
        kind: tool.type,
      })
      return
    }
    if (tool.type === 'computer' || tool.type === 'computer_use_preview') {
      const kind = tool.type === 'computer_use_preview' ? 'computer_preview' : 'computer'
      const spec = BUILTIN_CLIENT_TOOL_SCHEMAS[kind]
      tools.push({
        name: 'computer',
        origName: 'computer',
        namespace: '',
        description: typeof tool.description === 'string' && tool.description ? tool.description : spec.description,
        schema: spec.schema,
        strict: false,
        kind,
      })
      return
    }
    if (tool.type === 'tool_search') {
      const spec = BUILTIN_CLIENT_TOOL_SCHEMAS.tool_search
      tools.push({
        name: 'tool_search',
        origName: 'tool_search',
        namespace: '',
        description: typeof tool.description === 'string' && tool.description ? tool.description : spec.description,
        schema: tool.parameters || spec.schema,
        strict: false,
        kind: 'tool_search',
      })
      return
    }
    const fn = tool.type === 'function' && isPlainObject(tool.function) ? tool.function : tool
    if (typeof fn.name === 'string' && fn.name) {
      const rawName = fn.name
      const fullName = ns && ns !== 'functions' ? `${ns}.${rawName}` : rawName
      tools.push({
        name: fullName,
        origName: rawName,
        namespace: ns && ns !== 'functions' ? ns : '',
        description: typeof fn.description === 'string' ? fn.description : '',
        schema: fn.parameters || fn.input_schema || { type: 'object', properties: {} },
        strict: fn.strict === true,
        kind: 'function',
      })
    }
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) addResponsesTool(tool)
  }

  const extractItemParts = (content) => {
    if (typeof content === 'string') return content ? [{ kind: 'text', text: content, signature: '' }] : []
    if (!Array.isArray(content)) return []
    const out = []
    for (const part of content) {
      if (typeof part === 'string') {
        if (part) out.push({ kind: 'text', text: part, signature: '' })
        continue
      }
      if (!isPlainObject(part))
        throw makeProtocolError(400, 'gemini_invalid_request', 'Invalid Responses content part.')
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
        if (typeof part.text !== 'string')
          throw makeProtocolError(400, 'gemini_invalid_request', 'text must be a string.')
        out.push({ kind: 'text', text: part.text, signature: '' })
      } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
        if (part.refusal) out.push({ kind: 'text', text: part.refusal, signature: '' })
      } else if (part.type === 'input_image' || part.type === 'image_url') {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url || part.url
        const media = mediaPartFromUrl(url, 'image/png')
        if (!media) throw makeProtocolError(400, 'gemini_invalid_request', 'input_image requires image_url.')
        out.push(media)
      } else if (part.type === 'input_file') {
        const media = mediaPartFromUrl(part.file_data || part.file_url, part.media_type || 'application/pdf')
        if (!media) throw makeProtocolError(400, 'gemini_invalid_request', 'input_file requires file_data or file_url.')
        out.push(media)
      } else {
        throw makeProtocolError(400, 'gemini_invalid_request', `Unsupported Responses part type: ${String(part.type)}`)
      }
    }
    return out
  }

  const extractOutputField = (rawOutput) => {
    if (typeof rawOutput === 'string') return { text: rawOutput, images: [] }
    if (Array.isArray(rawOutput)) {
      const parts = extractItemParts(rawOutput)
      return {
        text: parts
          .filter((p) => p.kind === 'text')
          .map((p) => p.text)
          .join('\n'),
        images: parts.filter((p) => p.kind === 'image'),
      }
    }
    if (isPlainObject(rawOutput) && typeof rawOutput.type === 'string' && rawOutput.type.startsWith('input_')) {
      const parts = extractItemParts([rawOutput])
      return {
        text: parts
          .filter((p) => p.kind === 'text')
          .map((p) => p.text)
          .join('\n'),
        images: parts.filter((p) => p.kind === 'image'),
      }
    }
    return { text: rawOutput == null ? '' : JSON.stringify(rawOutput), images: [] }
  }

  let inLeadingSystem = true
  let configUpdateEffort = ''
  let pendingEncryptedSig = ''
  if (typeof body.input === 'string') {
    if (!body.input.trim()) throw makeProtocolError(400, 'gemini_invalid_request', 'input must not be empty.')
    messages.push({ role: 'user', parts: [{ kind: 'text', text: body.input, signature: '' }] })
  } else if (Array.isArray(body.input) && body.input.length) {
    for (const item of body.input) {
      if (!isPlainObject(item))
        throw makeProtocolError(400, 'gemini_invalid_request', 'Each input item must be an object.')
      if (item.type === 'configuration_update') {
        const updEff = normalizeEffort(item.reasoning?.effort ?? item.effort)
        if (updEff) configUpdateEffort = updEff
        continue
      }
      if (item.type === 'additional_tools' && Array.isArray(item.tools)) {
        for (const extraTool of item.tools) addResponsesTool(extraTool)
        continue
      }
      if (item.type === 'function_call') {
        inLeadingSystem = false
        if (typeof item.name !== 'string' || !item.name) {
          throw makeProtocolError(400, 'gemini_invalid_request', 'function_call.name is required.')
        }
        const { id, signature } = unsignedToolCallId(item.call_id || item.id || newCallId())
        const effSig = signature || pendingEncryptedSig
        pendingEncryptedSig = ''
        const ns =
          typeof item.namespace === 'string' && item.namespace && item.namespace !== 'functions' ? item.namespace : ''
        const fullName = ns ? `${ns}.${item.name}` : item.name
        messages.push({
          role: 'assistant',
          parts: [
            { kind: 'tool_call', id, name: fullName, args: parseJsonObjectArgs(item.arguments), signature: effSig },
          ],
        })
      } else if (item.type === 'custom_tool_call') {
        inLeadingSystem = false
        if (typeof item.name !== 'string' || !item.name) {
          throw makeProtocolError(400, 'gemini_invalid_request', 'custom_tool_call.name is required.')
        }
        const { id, signature } = unsignedToolCallId(item.call_id || item.id || newCallId())
        const ns =
          typeof item.namespace === 'string' && item.namespace && item.namespace !== 'functions' ? item.namespace : ''
        const fullName = ns ? `${ns}.${item.name}` : item.name
        messages.push({
          role: 'assistant',
          parts: [
            {
              kind: 'tool_call',
              id,
              name: fullName,
              args: { input: typeof item.input === 'string' ? item.input : JSON.stringify(item.input ?? '') },
              signature,
            },
          ],
        })
      } else if (item.type === 'local_shell_call' || item.type === 'shell_call') {
        inLeadingSystem = false
        const { id, signature } = unsignedToolCallId(item.call_id || item.id || newCallId())
        const action = isPlainObject(item.action) ? { ...item.action } : {}
        if (item.type === 'local_shell_call') delete action.type
        messages.push({
          role: 'assistant',
          parts: [
            {
              kind: 'tool_call',
              id,
              name: item.type === 'local_shell_call' ? 'local_shell' : 'shell',
              args: action,
              signature,
            },
          ],
        })
      } else if (item.type === 'apply_patch_call') {
        inLeadingSystem = false
        const { id, signature } = unsignedToolCallId(item.call_id || item.id || newCallId())
        messages.push({
          role: 'assistant',
          parts: [
            {
              kind: 'tool_call',
              id,
              name: 'apply_patch',
              args: isPlainObject(item.operation) ? item.operation : {},
              signature,
            },
          ],
        })
      } else if (item.type === 'computer_call') {
        inLeadingSystem = false
        const { id, signature } = unsignedToolCallId(item.call_id || item.id || newCallId())
        const args = Array.isArray(item.actions)
          ? { actions: item.actions }
          : isPlainObject(item.action)
            ? item.action
            : {}
        messages.push({
          role: 'assistant',
          parts: [{ kind: 'tool_call', id, name: 'computer', args, signature }],
        })
      } else if (item.type === 'tool_search_call') {
        inLeadingSystem = false
        const { id, signature } = unsignedToolCallId(item.call_id || item.id || newCallId())
        messages.push({
          role: 'assistant',
          parts: [{ kind: 'tool_call', id, name: 'tool_search', args: parseJsonObjectArgs(item.arguments), signature }],
        })
      } else if (
        item.type === 'function_call_output' ||
        item.type === 'custom_tool_call_output' ||
        item.type === 'local_shell_call_output' ||
        item.type === 'shell_call_output' ||
        item.type === 'apply_patch_call_output' ||
        item.type === 'computer_call_output' ||
        item.type === 'tool_search_output'
      ) {
        inLeadingSystem = false
        if (item.type === 'tool_search_output' && Array.isArray(item.tools)) {
          for (const extraTool of item.tools) addResponsesTool(extraTool)
        }
        const { id } = unsignedToolCallId(item.call_id || item.id || newCallId())
        const rawOut =
          item.type === 'apply_patch_call_output'
            ? { status: item.status || 'completed', output: item.output ?? '' }
            : item.type === 'tool_search_output' && item.output == null
              ? { loaded_tools: Array.isArray(item.tools) ? item.tools.map((t) => t?.name).filter(Boolean) : [] }
              : item.output
        const { text: out, images } = extractOutputField(rawOut)
        const finalOut = !out.trim() && !images.length ? EMPTY_TOOL_OK_TEXT : out
        const fallbackName =
          item.type === 'local_shell_call_output'
            ? 'local_shell'
            : item.type === 'shell_call_output'
              ? 'shell'
              : item.type === 'apply_patch_call_output'
                ? 'apply_patch'
                : item.type === 'computer_call_output'
                  ? 'computer'
                  : item.type === 'tool_search_output'
                    ? 'tool_search'
                    : ''
        messages.push({
          role: 'user',
          parts: [
            {
              kind: 'tool_result',
              callId: id,
              name: item.name || fallbackName,
              text: finalOut,
              isError: false,
              images,
            },
          ],
        })
      } else if (item.type === 'reasoning') {
        // Ignore unsigned foreign reasoning blocks; preserve encrypted_content thoughtSignature when present.
        if (typeof item.encrypted_content === 'string' && item.encrypted_content.trim()) {
          pendingEncryptedSig = item.encrypted_content.trim()
        }
      } else {
        if (item.type != null && item.type !== 'message' && item.type !== 'agent_message') {
          throw makeProtocolError(
            400,
            'gemini_invalid_request',
            `Unsupported Responses input item: ${String(item.type)}`,
          )
        }
        const role = item.type === 'agent_message' ? 'user' : item.role || 'user'
        const parts = extractItemParts(item.content)
        if (role === 'system' || role === 'developer') {
          const text = parts
            .filter((p) => p.kind === 'text')
            .map((p) => p.text)
            .join('\n')
          if (text.trim()) {
            if (inLeadingSystem) systemParts.push(text)
            else {
              messages.push({
                role: 'user',
                parts: [{ kind: 'text', text: `<system-reminder>\n${text.trim()}\n</system-reminder>`, signature: '' }],
              })
            }
          }
        } else if (role === 'user' || role === 'assistant') {
          inLeadingSystem = false
          if (parts.length) messages.push({ role, parts })
        } else {
          throw makeProtocolError(400, 'gemini_invalid_request', `Unsupported Responses role: ${String(role)}`)
        }
      }
    }
  } else {
    throw makeProtocolError(400, 'gemini_invalid_request', 'input must be a string or non-empty array.')
  }

  let toolChoice = ''
  let allowedToolNames = null
  if (typeof body.tool_choice === 'string') {
    const lower = body.tool_choice.toLowerCase()
    if (['none', 'auto', 'required'].includes(lower)) toolChoice = lower
  } else if (isPlainObject(body.tool_choice)) {
    const tc = body.tool_choice
    if (tc.type === 'allowed_tools') {
      const mode = String(tc.mode || 'auto').toLowerCase()
      toolChoice = mode === 'required' ? 'required' : 'auto'
      if (Array.isArray(tc.tools)) {
        allowedToolNames = tc.tools
          .map((item) => {
            if (item?.type === 'computer_use_preview') return 'computer'
            if (['local_shell', 'shell', 'apply_patch', 'computer', 'tool_search'].includes(item?.type))
              return item.type
            const ns =
              typeof item?.namespace === 'string' && item.namespace && item.namespace !== 'functions'
                ? item.namespace
                : ''
            const nm = item?.name || item?.function?.name || item?.custom?.name || ''
            return nm ? (ns ? `${ns}.${nm}` : nm) : ''
          })
          .filter(Boolean)
      }
    } else if (['local_shell', 'shell', 'apply_patch', 'computer', 'tool_search'].includes(tc.type)) {
      toolChoice = `name:${tc.type}`
    } else if (tc.type === 'computer_use_preview') {
      toolChoice = 'name:computer'
    } else {
      const ns = typeof tc.namespace === 'string' && tc.namespace && tc.namespace !== 'functions' ? tc.namespace : ''
      const rawName = tc.name || tc.function?.name || tc.custom?.name
      if (rawName) toolChoice = `name:${ns ? `${ns}.${rawName}` : rawName}`
      else if (['none', 'auto', 'required'].includes(tc.type)) toolChoice = tc.type
    }
  }
  const disableParallelTools = body.parallel_tool_calls === false

  if (Number.isInteger(body.max_output_tokens) && body.max_output_tokens > 0) {
    generationConfig.maxOutputTokens = body.max_output_tokens
  }
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    generationConfig.temperature = body.temperature
  }
  if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) generationConfig.topP = body.top_p

  let thinking = null
  let hideThinking = false
  const effort = normalizeEffort(
    firstNonEmptyEffort(
      configUpdateEffort,
      body.reasoning?.effort,
      body.reasoning_effort,
      body.output_config?.effort,
      parenEffort,
    ),
  )
  if (body.reasoning?.summary === 'none' || body.reasoning?.generate_summary === 'none' || effort === 'none') {
    hideThinking = true
  }
  if (effort) {
    thinking = {
      enabled: effort !== 'none',
      disabled: effort === 'none',
      effort: effort !== 'none' ? effort : '',
      includeThoughts: !hideThinking,
    }
  }
  const includeEncryptedReasoning =
    Array.isArray(body.include) &&
    body.include.some((item) => String(item || '').trim() === 'reasoning.encrypted_content')

  let responseFormat = null
  const fmt = body.text?.format
  if (isPlainObject(fmt)) {
    if (fmt.type === 'json_object') responseFormat = { type: 'json_object' }
    else if (fmt.type === 'json_schema') {
      if (fmt.schema !== undefined && !isPlainObject(fmt.schema)) {
        throw makeProtocolError(400, 'gemini_invalid_request', 'text.format.schema must be a JSON object.')
      }
      responseFormat = {
        type: 'json_schema',
        schema: fmt.schema || { type: 'object' },
        ...(typeof fmt.description === 'string' && fmt.description.trim()
          ? { description: fmt.description.trim() }
          : {}),
      }
    }
  }

  return {
    protocol: 'openai-responses',
    model,
    stream,
    system: systemParts.join('\n\n'),
    messages,
    tools,
    toolChoice,
    allowedToolNames,
    disableParallelTools,
    legacyFunctions: false,
    strictValidation: tools.some((t) => t.strict),
    webSearch,
    searchOptions,
    googleTools: [],
    generationConfig,
    extraGenConfig: {},
    thinking,
    hideThinking,
    thinkingDisplay: null,
    includeEncryptedReasoning,
    responseFormat,
    safetySettings: null,
    cachedContent: null,
    conversationId: sanitizeConversationId(
      body.conversation_id ?? body.previous_response_id ?? headers?.['x-conversation-id'],
    ),
  }
}

function parseAnthropicInbound(body, { headers }) {
  const { model, parenEffort } = parseInboundModelSpec(body.model, { allowLeadingModelsPrefix: true })
  if (!model) throw makeProtocolError(400, 'gemini_invalid_model', 'A valid Gemini model is required.')
  if (body.stream != null && typeof body.stream !== 'boolean') {
    throw makeProtocolError(400, 'gemini_invalid_request', 'stream must be a boolean.')
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw makeProtocolError(400, 'gemini_invalid_request', 'messages must be a non-empty array.')
  }
  const stream = isClientStream(body, headers)

  let system = ''
  if (typeof body.system === 'string') system = body.system
  else if (Array.isArray(body.system)) {
    system = body.system
      .map((b) => (typeof b === 'string' ? b : isPlainObject(b) && b.type === 'text' ? b.text || '' : ''))
      .filter(Boolean)
      .join('\n\n')
  }

  const messages = []
  const parseAnthropicSource = (source, defaultMime) => {
    if (!isPlainObject(source)) return null
    if (source.type === 'base64' && typeof source.data === 'string') {
      const mediaType = source.media_type || defaultMime
      return { kind: mediaType.startsWith('image/') ? 'image' : 'file', mediaType, data: source.data }
    }
    if (source.type === 'text' && typeof source.data === 'string') {
      return {
        kind: 'file',
        mediaType: source.media_type || 'text/plain',
        data: Buffer.from(source.data, 'utf8').toString('base64'),
      }
    }
    if (source.type === 'url' && typeof source.url === 'string') {
      const mediaType = source.media_type || defaultMime
      return { kind: mediaType.startsWith('image/') ? 'image' : 'file', mediaType, url: source.url }
    }
    return null
  }

  const extraSystemParts = []
  let inLeadingSystem = true
  let midTurnEffort = ''
  let webSearch = false
  let searchOptions = null
  const googleTools = []
  const tools = []

  const addAnthropicTool = (tool) => {
    if (!isPlainObject(tool)) throw makeProtocolError(400, 'gemini_invalid_request', 'Each tool must be an object.')
    const typeLower = typeof tool.type === 'string' ? tool.type.trim().toLowerCase() : ''
    if (typeLower.startsWith('web_search')) {
      webSearch = true
      searchOptions = mergeSearchOptions(searchOptions, tool)
      return
    }
    if (typeLower.startsWith('web_fetch')) {
      googleTools.push({ urlContext: {} })
      return
    }
    if (typeLower === 'function' && isPlainObject(tool.function) && tool.function.name) {
      tools.push({
        name: String(tool.function.name),
        description: typeof tool.function.description === 'string' ? tool.function.description : '',
        schema: tool.function.parameters || { type: 'object', properties: {} },
        strict: tool.function.strict === true,
        kind: 'anthropic_tool',
      })
      return
    }
    if (typeLower.startsWith('bash_')) {
      const spec = BUILTIN_CLIENT_TOOL_SCHEMAS.anthropic_bash
      tools.push({
        name: typeof tool.name === 'string' && tool.name ? tool.name : 'bash',
        description: typeof tool.description === 'string' && tool.description ? tool.description : spec.description,
        schema: tool.input_schema || spec.schema,
        strict: tool.strict === true,
        kind: 'anthropic_tool',
      })
      return
    }
    if (typeLower.startsWith('text_editor_') || typeLower === 'str_replace_editor') {
      const spec = BUILTIN_CLIENT_TOOL_SCHEMAS.anthropic_text_editor
      tools.push({
        name: typeof tool.name === 'string' && tool.name ? tool.name : 'str_replace_based_edit_tool',
        description: typeof tool.description === 'string' && tool.description ? tool.description : spec.description,
        schema: tool.input_schema || spec.schema,
        strict: tool.strict === true,
        kind: 'anthropic_tool',
      })
      return
    }
    if (typeLower.startsWith('memory_')) {
      const spec = BUILTIN_CLIENT_TOOL_SCHEMAS.anthropic_memory
      tools.push({
        name: typeof tool.name === 'string' && tool.name ? tool.name : 'memory',
        description: typeof tool.description === 'string' && tool.description ? tool.description : spec.description,
        schema: tool.input_schema || spec.schema,
        strict: tool.strict === true,
        kind: 'anthropic_tool',
      })
      return
    }
    if (typeLower.startsWith('computer_')) {
      const spec = BUILTIN_CLIENT_TOOL_SCHEMAS.anthropic_computer
      tools.push({
        name: typeof tool.name === 'string' && tool.name ? tool.name : 'computer',
        description: typeof tool.description === 'string' && tool.description ? tool.description : spec.description,
        schema: tool.input_schema || spec.schema,
        strict: tool.strict === true,
        kind: 'anthropic_tool',
      })
      return
    }
    if (typeof tool.name === 'string' && tool.name) {
      tools.push({
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        schema: tool.input_schema || tool.parameters || { type: 'object', properties: {} },
        strict: tool.strict === true,
        kind: 'anthropic_tool',
      })
    }
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) addAnthropicTool(tool)
  }

  for (const raw of body.messages) {
    if (!isPlainObject(raw) || !['user', 'assistant', 'system'].includes(raw.role)) {
      throw makeProtocolError(400, 'gemini_invalid_request', 'Anthropic message role must be user or assistant.')
    }
    const msgEff = normalizeEffort(raw.output_config?.effort)
    if (msgEff) midTurnEffort = msgEff
    if (raw.role === 'system') {
      const sysText =
        typeof raw.content === 'string'
          ? raw.content
          : Array.isArray(raw.content)
            ? raw.content
                .map((b) => (isPlainObject(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
                .filter(Boolean)
                .join('\n')
            : ''
      if (sysText.trim()) {
        if (inLeadingSystem) {
          extraSystemParts.push(sysText)
        } else {
          messages.push({
            role: 'user',
            parts: [{ kind: 'text', text: `<system-reminder>\n${sysText.trim()}\n</system-reminder>`, signature: '' }],
          })
        }
      }
      continue
    }
    inLeadingSystem = false
    const parts = []
    let pendingThinkingSig = ''
    if (typeof raw.content === 'string') {
      if (!isPlaceholderText(raw.content)) parts.push({ kind: 'text', text: raw.content, signature: '' })
    } else if (Array.isArray(raw.content)) {
      for (const block of raw.content) {
        if (!isPlainObject(block))
          throw makeProtocolError(400, 'gemini_invalid_request', 'Content block must be an object.')
        if (block.type === 'tool_addition') {
          const added = Array.isArray(block.tools) ? block.tools : block.tool ? [block.tool] : []
          for (const t of added) addAnthropicTool(t)
          continue
        }
        if (block.type === 'tool_removal') {
          const names = new Set(
            [
              ...(typeof block.name === 'string' ? [block.name] : []),
              ...(typeof block.tool_name === 'string' ? [block.tool_name] : []),
              ...(Array.isArray(block.names) ? block.names : []),
              ...(Array.isArray(block.tool_names) ? block.tool_names : []),
              ...(Array.isArray(block.tools) ? block.tools.map((t) => (typeof t === 'string' ? t : t?.name)) : []),
            ].filter(Boolean),
          )
          if (names.size) {
            for (let idx = tools.length - 1; idx >= 0; idx--) {
              if (names.has(tools[idx].name)) tools.splice(idx, 1)
            }
          }
          continue
        }
        if (block.type === 'text') {
          if (typeof block.text !== 'string') {
            throw makeProtocolError(400, 'gemini_invalid_request', 'text block requires string text.')
          }
          if (!isPlaceholderText(block.text)) {
            parts.push({ kind: 'text', text: block.text, signature: pendingThinkingSig })
            pendingThinkingSig = ''
          }
        } else if (block.type === 'image') {
          const media = parseAnthropicSource(block.source, 'image/png')
          if (!media) throw makeProtocolError(400, 'gemini_invalid_request', 'Invalid Anthropic image source.')
          parts.push(media)
        } else if (block.type === 'document') {
          if (block.source?.type === 'content' && Array.isArray(block.source.content)) {
            for (const sub of block.source.content) {
              if (
                isPlainObject(sub) &&
                sub.type === 'text' &&
                typeof sub.text === 'string' &&
                !isPlaceholderText(sub.text)
              ) {
                parts.push({ kind: 'text', text: sub.text, signature: '' })
              } else if (isPlainObject(sub) && sub.type === 'image') {
                const media = parseAnthropicSource(sub.source, 'image/png')
                if (media) parts.push(media)
              }
            }
          } else {
            const media = parseAnthropicSource(block.source, 'application/pdf')
            if (!media) throw makeProtocolError(400, 'gemini_invalid_request', 'Invalid Anthropic document source.')
            parts.push(media)
          }
        } else if (block.type === 'tool_use') {
          if (typeof block.name !== 'string' || !block.name) {
            throw makeProtocolError(400, 'gemini_invalid_request', 'tool_use.name is required.')
          }
          const { id, signature } = unsignedToolCallId(block.id || newCallId())
          parts.push({
            kind: 'tool_call',
            id,
            name: block.name,
            args: parseJsonObjectArgs(block.input),
            signature: signature || pendingThinkingSig,
          })
          pendingThinkingSig = ''
        } else if (block.type === 'tool_result') {
          const { id } = unsignedToolCallId(block.tool_use_id || newCallId())
          let text = ''
          const images = []
          const extraFiles = []
          if (typeof block.content === 'string') {
            text = block.content
          } else if (Array.isArray(block.content)) {
            const chunks = []
            for (const sub of block.content) {
              if (typeof sub === 'string') chunks.push(sub)
              else if (isPlainObject(sub) && sub.type === 'text' && typeof sub.text === 'string') chunks.push(sub.text)
              else if (isPlainObject(sub) && sub.type === 'tool_reference' && typeof sub.tool_name === 'string') {
                chunks.push(`Tool reference: ${sub.tool_name}`)
              } else if (isPlainObject(sub) && sub.type === 'search_result') {
                const header = `Search result: ${sub.title || ''}\n${sub.source || ''}`.trim()
                if (header) chunks.push(header)
                if (Array.isArray(sub.content)) {
                  for (const inner of sub.content) {
                    if (isPlainObject(inner) && typeof inner.text === 'string') chunks.push(inner.text)
                  }
                }
              } else if (isPlainObject(sub) && (sub.type === 'image' || sub.type === 'document')) {
                const media = parseAnthropicSource(sub.source, sub.type === 'image' ? 'image/png' : 'application/pdf')
                if (media) {
                  if (media.kind === 'image') images.push(media)
                  else extraFiles.push(media)
                }
              }
            }
            text = chunks.join('\n')
          } else if (block.content != null) {
            text = JSON.stringify(block.content)
          }
          const isError = block.is_error === true
          if (!text.trim() && !images.length && !extraFiles.length) {
            text = isError ? EMPTY_TOOL_ERR_TEXT : EMPTY_TOOL_OK_TEXT
          }
          parts.push({ kind: 'tool_result', callId: id, name: '', text, isError, images })
          for (const f of extraFiles) parts.push(f)
        } else if (block.type === 'thinking') {
          if (typeof block.signature === 'string' && block.signature.trim()) {
            pendingThinkingSig = block.signature.trim()
          }
        } else if (block.type === 'redacted_thinking') {
          if (typeof block.data === 'string' && block.data.trim()) {
            pendingThinkingSig = block.data.trim()
          }
        } else if (block.type === 'server_tool_use' || block.type === 'web_search_tool_result') {
          // Do not send foreign server tool replay blocks back to Gemini.
        } else if (
          block.type === 'search_result' ||
          block.type === 'tool_reference' ||
          block.type === 'mcp_tool_use' ||
          block.type === 'mcp_tool_result' ||
          block.type === 'web_fetch_tool_result' ||
          block.type === 'code_execution_tool_result' ||
          block.type === 'bash_code_execution_tool_result' ||
          block.type === 'text_editor_code_execution_tool_result' ||
          block.type === 'tool_search_tool_result'
        ) {
          const summary =
            block.type === 'tool_reference'
              ? `Tool reference: ${block.tool_name || ''}`
              : block.type === 'mcp_tool_use'
                ? `Server tool call ${block.name || ''}: ${JSON.stringify(block.input ?? {})}`
                : block.type === 'search_result'
                  ? `Search result: ${block.title || ''}\n${block.source || ''}`.trim()
                  : `Server tool result ${block.type}: ${JSON.stringify(block.content ?? '')}`
          if (summary.trim()) parts.push({ kind: 'text', text: summary, signature: '' })
        } else {
          throw makeProtocolError(
            400,
            'gemini_invalid_request',
            `Unsupported Anthropic block type: ${String(block.type)}`,
          )
        }
      }
    } else {
      throw makeProtocolError(400, 'gemini_invalid_request', 'Anthropic message content must be a string or array.')
    }
    if (parts.length) messages.push({ role: raw.role, parts })
  }
  if (extraSystemParts.length) {
    system = [system, ...extraSystemParts].filter(Boolean).join('\n\n')
  }

  let toolChoice = ''
  let disableParallelTools = false
  if (isPlainObject(body.tool_choice)) {
    const type = String(body.tool_choice.type || '').toLowerCase()
    if (type === 'none' || type === 'auto') toolChoice = type
    else if (type === 'any') toolChoice = 'required'
    else if (type === 'tool' && body.tool_choice.name) toolChoice = `name:${body.tool_choice.name}`
    if (body.tool_choice.disable_parallel_tool_use === true) disableParallelTools = true
  }

  const generationConfig = {}
  if (Number.isInteger(body.max_tokens) && body.max_tokens > 0) generationConfig.maxOutputTokens = body.max_tokens
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    generationConfig.temperature = body.temperature
  }
  if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) generationConfig.topP = body.top_p
  if (Number.isInteger(body.top_k) && body.top_k > 0) generationConfig.topK = body.top_k
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    generationConfig.stopSequences = body.stop_sequences.map(String)
  }

  let thinking = null
  let hideThinking = false
  let thinkingDisplay = null
  const effort = normalizeEffort(firstNonEmptyEffort(midTurnEffort, body.output_config?.effort, parenEffort))
  if (isPlainObject(body.thinking)) {
    const type = String(body.thinking.type || '').toLowerCase()
    const budget = Number(body.thinking.budget_tokens)
    if (type === 'disabled') {
      hideThinking = true
    } else if (body.thinking.display === 'omitted') {
      hideThinking = true
      thinkingDisplay = 'omitted'
    }
    thinking = {
      enabled: type === 'enabled' || type === 'adaptive',
      disabled: type === 'disabled',
      effort:
        effort && effort !== 'none'
          ? effort
          : Number.isFinite(budget) && budget > 0
            ? effortFromBudget(budget)
            : type === 'adaptive'
              ? 'medium'
              : '',
      budgetTokens: Number.isFinite(budget) && budget > 0 ? budget : undefined,
      includeThoughts: !hideThinking,
    }
  } else if (effort) {
    if (effort === 'none') hideThinking = true
    thinking = {
      enabled: effort !== 'none',
      disabled: effort === 'none',
      effort: effort !== 'none' ? effort : '',
      includeThoughts: !hideThinking,
    }
  }

  let responseFormat = null
  const outFmt = body.output_config?.format ?? body.output_format
  if (isPlainObject(outFmt)) {
    if (outFmt.type === 'json_schema') {
      if (outFmt.schema !== undefined && !isPlainObject(outFmt.schema)) {
        throw makeProtocolError(400, 'gemini_invalid_request', 'output_format.schema must be a JSON object.')
      }
      responseFormat = { type: 'json_schema', schema: outFmt.schema || { type: 'object' } }
    } else if (outFmt.type === 'json_object') {
      responseFormat = { type: 'json_object' }
    }
  }

  return {
    protocol: 'anthropic',
    model,
    stream,
    system,
    messages,
    tools,
    toolChoice,
    allowedToolNames: null,
    disableParallelTools,
    legacyFunctions: false,
    strictValidation: tools.some((t) => t.strict),
    webSearch,
    searchOptions,
    googleTools,
    generationConfig,
    extraGenConfig: {},
    thinking,
    hideThinking,
    thinkingDisplay,
    responseFormat,
    safetySettings: null,
    cachedContent: null,
    conversationId: sanitizeConversationId(body.conversation_id ?? headers?.['x-conversation-id']),
  }
}

function parseGeminiSessionInbound(body) {
  if (Object.keys(body).some((key) => !['model', 'input', 'stream'].includes(key))) {
    throw makeProtocolError(400, 'gemini_unsupported_turn', 'Gemini session accepts only model, input, and stream.')
  }
  const model = typeof body.model === 'string' ? body.model : ''
  if (!MODEL_RE.test(model)) throw makeProtocolError(400, 'gemini_invalid_model', 'A valid Gemini model is required.')
  if (body.stream != null && typeof body.stream !== 'boolean') {
    throw makeProtocolError(400, 'gemini_unsupported_turn', 'stream must be a boolean.')
  }
  if (
    typeof body.input !== 'string' ||
    !body.input.trim() ||
    Buffer.byteLength(body.input, 'utf8') > MAX_SESSION_TEXT_BYTES ||
    /[\uD800-\uDFFF]/u.test(body.input)
  ) {
    throw makeProtocolError(
      400,
      'gemini_unsupported_turn',
      'Gemini session input must be a valid non-empty UTF-8 string <= 4096 bytes.',
    )
  }
  return {
    protocol: 'gemini-session',
    model,
    stream: body.stream === true,
    system: '',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: body.input, signature: '' }] }],
    tools: [],
    toolChoice: '',
    allowedToolNames: null,
    disableParallelTools: false,
    legacyFunctions: false,
    strictValidation: false,
    webSearch: false,
    searchOptions: null,
    googleTools: [],
    generationConfig: {},
    extraGenConfig: {},
    thinking: null,
    hideThinking: false,
    thinkingDisplay: null,
    responseFormat: null,
    safetySettings: null,
    cachedContent: null,
    conversationId: null,
  }
}

function isValidNativeTuiText(text) {
  return (
    typeof text === 'string' &&
    /[^\p{White_Space}]/u.test(text) &&
    !/(?:^|\p{White_Space})\//u.test(text) &&
    !/[^\P{Cc}\n\r\t]/u.test(text) &&
    text.isWellFormed() &&
    Buffer.byteLength(text, 'utf8') <= MAX_NATIVE_TEXT_BYTES
  )
}

/**
 * Determine which backend capabilities an IR turn requires.
 * Ensures restricted `native_tui` slots (`craggemini`) never silently drop
 * caller system instructions, history, tools, generation parameters, or media.
 *
 * `unsupportedFields` names the caller-visible fields behind each capability.
 * Without it the 400 can only say the turn is unsupported, not which field made
 * it so, and the caller has to bisect their own payload to find out (#1703).
 */
export function classifyGeminiCapabilities(ir) {
  const required = new Set()
  const fields = new Set()
  if (ir.system && ir.system.trim()) {
    required.add('system_instruction')
    fields.add('systemInstruction')
  }
  if (ir.messages.length !== 1 || ir.messages[0]?.role !== 'user') {
    required.add('multi_turn')
    fields.add('contents')
  }
  if (ir.tools.length > 0 || ir.webSearch || ir.googleTools.length > 0 || ir.toolChoice) {
    required.add('tools')
    fields.add(ir.tools.length > 0 || ir.webSearch || ir.googleTools.length > 0 ? 'tools' : 'toolConfig')
  }
  const genConfig = []
  if (Object.keys(ir.generationConfig || {}).length > 0) genConfig.push('generationConfig')
  if (Object.keys(ir.extraGenConfig || {}).length > 0) genConfig.push('generationConfig')
  if (ir.thinking != null) genConfig.push('generationConfig.thinkingConfig')
  if (ir.responseFormat != null) genConfig.push('generationConfig.responseSchema')
  // A field the caller sent but left empty requests nothing, so it must not pull in
  // a capability: `safetySettings: []` and `cachedContent: ''` carry no configuration,
  // yet a presence test pushed such a turn off the plain-text path and the scheduler
  // then answered 400 for a turn the native transport could serve (#1703). The
  // non-empty tests used for `generationConfig` above were already the right shape.
  if (Array.isArray(ir.safetySettings) ? ir.safetySettings.length > 0 : ir.safetySettings != null) {
    genConfig.push('safetySettings')
  }
  if (typeof ir.cachedContent === 'string' ? ir.cachedContent.length > 0 : ir.cachedContent != null) {
    genConfig.push('cachedContent')
  }
  if (genConfig.length > 0) {
    required.add('generation_config')
    for (const name of genConfig) fields.add(name)
  }
  let plainText = ''
  if (ir.messages.length === 1 && ir.messages[0].role === 'user') {
    const pieces = []
    for (const part of ir.messages[0].parts) {
      if (part.kind === 'text' && !part.signature) {
        pieces.push(part.text)
      } else if (part.kind === 'image' || part.kind === 'file') {
        required.add('multimodal')
        fields.add(part.kind === 'image' ? 'contents[].inlineData' : 'contents[].fileData')
      } else if (part.kind === 'tool_call' || part.kind === 'tool_result') {
        required.add('tools')
        fields.add('contents[].functionCall')
      } else {
        required.add('thinking')
        fields.add('contents[].thought')
      }
    }
    plainText = pieces.join('')
  }
  if (required.size === 0 && !isValidNativeTuiText(plainText)) {
    required.add('full_gemini_api')
    fields.add('contents[].text')
  }
  return {
    requiredCapabilities: [...required],
    unsupportedFields: [...fields],
    nativeTuiCompatible: required.size === 0,
    plainText: required.size === 0 ? plainText : null,
  }
}

function finalizeToolsAndRestoreContext(protocol, ir) {
  const usedWireNames = new Set()
  const nameToWire = new Map()
  const toolMap = new Map()
  const normalizedTools = []

  const defaultKind = protocol === 'anthropic' ? 'anthropic_tool' : protocol === 'gemini' ? 'gemini_fn' : 'function'

  for (const raw of ir.tools || []) {
    const keyName = String(raw.name || '')
    if (!keyName) continue
    // Deduplicate repeated declarations of the exact same tool name (last wins).
    let wireName = nameToWire.get(keyName)
    if (!wireName) {
      wireName = makeWireToolName(keyName, usedWireNames)
      nameToWire.set(keyName, wireName)
    }
    const origName = typeof raw.origName === 'string' && raw.origName ? raw.origName : keyName
    const entry = {
      name: keyName,
      wireName,
      origName,
      namespace: typeof raw.namespace === 'string' ? raw.namespace : '',
      kind: raw.kind || defaultKind,
      description: typeof raw.description === 'string' ? raw.description : '',
      schema: raw.schema || { type: 'object', properties: {} },
      strict: raw.strict === true,
    }
    toolMap.set(wireName, entry)
    if (origName !== wireName && !toolMap.has(origName)) {
      toolMap.set(origName, entry)
    }
    const existingIdx = normalizedTools.findIndex((t) => t.wireName === wireName)
    if (existingIdx >= 0) normalizedTools[existingIdx] = entry
    else normalizedTools.push(entry)
  }

  // Also map tool names that only appear in history calls/results so history remains consistent.
  const wireNameFor = (rawName) => {
    const s = String(rawName || '')
    if (!s) return ''
    if (nameToWire.has(s)) return nameToWire.get(s)
    const computed = makeWireToolName(s, usedWireNames)
    nameToWire.set(s, computed)
    if (!toolMap.has(computed)) {
      toolMap.set(computed, {
        name: s,
        wireName: computed,
        origName: s,
        namespace: '',
        kind: defaultKind,
        description: '',
        schema: { type: 'object', properties: {} },
        strict: false,
      })
    }
    return computed
  }

  let allowedWireNames = null
  if (Array.isArray(ir.allowedToolNames) && ir.allowedToolNames.length) {
    allowedWireNames = new Set(ir.allowedToolNames.map((n) => nameToWire.get(n) || geminiFuncName(n)))
  }

  let effectiveTools = normalizedTools
  if (allowedWireNames && allowedWireNames.size) {
    effectiveTools = normalizedTools.filter((t) => allowedWireNames.has(t.wireName))
  }
  if (typeof ir.toolChoice === 'string' && ir.toolChoice.startsWith('name:')) {
    const wantedRaw = ir.toolChoice.slice(5)
    const wantedWire = nameToWire.get(wantedRaw) || geminiFuncName(wantedRaw)
    if (!allowedWireNames) allowedWireNames = new Set([wantedWire])
  }

  const restoreContext = {
    protocol,
    toolMap,
    wireNameFor,
    toolChoice: ir.toolChoice || '',
    allowedToolNames: allowedWireNames,
    disableParallelTools: Boolean(ir.disableParallelTools),
    legacyFunctions: Boolean(ir.legacyFunctions),
    strictValidation: Boolean(ir.strictValidation),
    stopSequences: Array.isArray(ir.generationConfig?.stopSequences) ? ir.generationConfig.stopSequences : [],
    maxOutputTokens: Number.isInteger(ir.generationConfig?.maxOutputTokens) ? ir.generationConfig.maxOutputTokens : 0,
    hideThinking: Boolean(ir.hideThinking),
    thinkingDisplay: ir.thinkingDisplay || null,
    includeEncryptedReasoning: Boolean(ir.includeEncryptedReasoning),
    responseFormat: ir.responseFormat || null,
    searchOptions: ir.searchOptions || null,
  }

  return {
    ...ir,
    protocol,
    tools: effectiveTools,
    restoreContext,
  }
}

/**
 * Parse an inbound request from any supported protocol into canonical Gemini IR + capability profile.
 */
export function parseInboundToGemini(protocol, body, { routeModel = null, routeStream, headers = {} } = {}) {
  if (!isPlainObject(body)) {
    throw makeProtocolError(400, 'gemini_invalid_request', 'Request body must be a JSON object.')
  }
  let rawIr
  if (protocol === 'gemini') rawIr = parseGeminiNativeInbound(body, { routeModel, routeStream })
  else if (protocol === 'openai-chat') rawIr = parseOpenAIChatInbound(body, { headers })
  else if (protocol === 'openai-responses') rawIr = parseOpenAIResponsesInbound(body, { headers })
  else if (protocol === 'anthropic') rawIr = parseAnthropicInbound(body, { headers })
  else if (protocol === 'gemini-session') rawIr = parseGeminiSessionInbound(body)
  else throw makeProtocolError(400, 'gemini_unsupported_protocol', `Unsupported protocol: ${String(protocol)}`)

  const ir = finalizeToolsAndRestoreContext(protocol, rawIr)
  const capabilities = classifyGeminiCapabilities(ir)
  return { ...ir, ...capabilities }
}

function hasFunctionResponse(parts) {
  return parts.some((part) => part.functionResponse != null)
}

function dropDuplicateToolResults(messages) {
  const answered = new Set()
  const out = []
  for (const msg of messages) {
    const parts = []
    for (const part of msg.parts) {
      if (part.kind === 'tool_call' && part.id) {
        answered.delete(part.id)
        parts.push(part)
      } else if (part.kind === 'tool_result' && part.callId) {
        if (answered.has(part.callId)) continue
        answered.add(part.callId)
        parts.push(part)
      } else {
        parts.push(part)
      }
    }
    if (parts.length) out.push({ role: msg.role, parts })
  }
  return out
}

function pairFunctionTurns(contents, { responseKey = 'output' } = {}) {
  if (!contents.length) return contents
  const answeredIds = new Set()
  const answeredNames = new Set()
  for (const c of contents) {
    for (const p of c.parts) {
      if (p.functionResponse) {
        if (p.functionResponse.id) answeredIds.add(p.functionResponse.id)
        else if (p.functionResponse.name) answeredNames.add(p.functionResponse.name)
      }
    }
  }
  const out = []
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i]
    out.push(c)
    if (c.role !== 'model') continue
    const synth = []
    for (const p of c.parts) {
      const fc = p.functionCall
      if (!fc) continue
      if ((fc.id && answeredIds.has(fc.id)) || (!fc.id && answeredNames.has(fc.name))) continue
      const fr = { name: fc.name, response: { [responseKey]: INTERRUPTED_TOOL_NOTE } }
      if (fc.id) fr.id = fc.id
      synth.push({ functionResponse: fr })
    }
    if (!synth.length) continue
    const next = contents[i + 1]
    if (next && next.role === 'user' && hasFunctionResponse(next.parts)) {
      next.parts = [...synth, ...next.parts]
    } else {
      out.push({ role: 'user', parts: synth })
    }
  }
  return out
}

function modelSupportsGeminiDefaultThinking(model) {
  if (!isGeminiSeriesId(model)) return false
  const lower = String(model || '')
    .trim()
    .toLowerCase()
  if (/(?:^|[-_/])(embedding|imagen|veo|aqa|tts)(?:$|[-_])/.test(lower)) return false
  if (/gemini-1[.-]/.test(lower)) return false
  if (/gemini-2\.0(?![0-9])/.test(lower) && !lower.includes('thinking')) return false
  const gen = geminiGeneration(lower)
  if (gen >= 3) return true
  if (/gemini-2\.5/.test(lower) || lower.includes('thinking')) return true
  return false
}

function supportsGeminiXhighThinkingLevel(model) {
  return /(?:hydrogen|neon)/i.test(String(model || ''))
}

function mapGemini3ThinkingLevel(effort, model) {
  if (effort === 'minimal') return /flash/i.test(model) ? 'minimal' : 'low'
  if (effort === 'low') return 'low'
  if (effort === 'medium') return 'medium'
  if ((effort === 'xhigh' || effort === 'max') && supportsGeminiXhighThinkingLevel(model)) return 'xhigh'
  return 'high'
}

function buildThinkingConfig(ir, model, { defaultEffort = null } = {}) {
  const gen = geminiGeneration(model)
  const explicit = ir.thinking
  const modelImplied =
    extractImpliedModelEffort(ir.requestedModel || '') ||
    extractImpliedModelEffort(model) ||
    extractImpliedModelEffort(ir.model)
  if (explicit?.disabled || (!explicit && modelImplied === 'none')) {
    if (gen >= 3) return { thinkingLevel: 'low', includeThoughts: false }
    return { thinkingBudget: 0 }
  }
  const hasExplicit = Boolean(explicit && (explicit.enabled || explicit.effort || explicit.budgetTokens != null))
  const fallbackEffort =
    (modelImplied && modelImplied !== 'none' ? normalizeEffort(modelImplied) : '') ||
    (defaultEffort && defaultEffort !== 'off' ? normalizeEffort(defaultEffort) || 'medium' : null)
  if (!hasExplicit) {
    const supportsThinking = modelSupportsGeminiDefaultThinking(model) || Boolean(modelImplied)
    if (!fallbackEffort || fallbackEffort === 'none' || !supportsThinking) {
      return null
    }
    const tc = { includeThoughts: explicit ? explicit.includeThoughts !== false : !ir.hideThinking }
    if (gen >= 3 || (modelImplied && !isGeminiSeriesId(model))) {
      tc.thinkingLevel = mapGemini3ThinkingLevel(fallbackEffort, model)
      return tc
    }
    tc.thinkingBudget = budgetFromEffort(fallbackEffort)
    return tc
  }
  const tc = { includeThoughts: explicit.includeThoughts !== false }
  const effort = explicit.effort || fallbackEffort || 'medium'
  if (gen >= 3) {
    tc.thinkingLevel = mapGemini3ThinkingLevel(effort, model)
    return tc
  }
  const budget = explicit.budgetTokens || budgetFromEffort(effort)
  tc.thinkingBudget = budget
  return tc
}

function isSubstantiveTurnPart(part, { allowEllipsis = false } = {}) {
  if (!isPlainObject(part)) return false
  if (part.functionCall || part.functionResponse || part.inlineData || part.fileData) return true
  if (typeof part.text === 'string') return !isPlaceholderText(part.text, { allowEllipsis })
  return false
}

/**
 * Antigravity-Manager transit defense: guarantee valid non-empty contents ending
 * with a substantive user (or tool functionResponse) turn, and satisfy CRAGGemini's
 * non-empty delta invariants when `target === 'antigravity'`.
 */
function ensureGeminiContentsValid(contents, { antigravity = false } = {}) {
  const out = contents.filter((turn) => Array.isArray(turn?.parts) && turn.parts.length > 0)
  if (!out.length) {
    out.push({ role: 'user', parts: [{ text: TRANSIT_DEFENSE_FALLBACK_TEXT }] })
    return out
  }
  if (out[0].role === 'model') {
    out.unshift({ role: 'user', parts: [{ text: '[Continuing from previous AI thoughts...]' }] })
  }
  for (let i = 0; i < out.length - 1; i++) {
    if (!out[i].parts.length) {
      out[i].parts.push({ text: out[i].role === 'model' ? '...' : TRANSIT_DEFENSE_FALLBACK_TEXT })
    }
  }
  while (out.length && out[out.length - 1].role === 'model') {
    const last = out[out.length - 1]
    if (hasFunctionResponse(last.parts)) break
    const hasSubstantive = last.parts.some((part) => isSubstantiveTurnPart(part, { allowEllipsis: true }))
    if (!hasSubstantive) {
      out.pop()
      continue
    }
    out.push({ role: 'user', parts: [{ text: 'Continue.' }] })
    break
  }
  if (!out.length) {
    out.push({ role: 'user', parts: [{ text: TRANSIT_DEFENSE_FALLBACK_TEXT }] })
    return out
  }
  const last = out[out.length - 1]
  if (last.role === 'user') {
    const hasSubstantive = last.parts.some((part) => isSubstantiveTurnPart(part))
    if (!hasSubstantive) {
      last.parts = [{ text: TRANSIT_DEFENSE_FALLBACK_TEXT }]
    } else if (antigravity) {
      const hasNonEmptyText = last.parts.some(
        (part) => part.thought !== true && typeof part.text === 'string' && !isPlaceholderText(part.text),
      )
      const hasInlineMedia = last.parts.some((part) => part.inlineData != null)
      const hasFileMedia = last.parts.some((part) => part.fileData != null)
      const hasFr = hasFunctionResponse(last.parts)
      // CRAGGemini's single-message build_delta reads `messages[0].text` directly; ensure
      // non-empty text when a single-turn payload only has functionResponse, or when the
      // trailing user turn only carries fileData URLs (which CRAGGemini does not stage as inline media).
      if (!hasNonEmptyText && !hasInlineMedia && ((out.length === 1 && hasFr) || (hasFileMedia && !hasFr))) {
        last.parts.push({ text: hasFileMedia && !hasFr ? 'Inspect the attached media.' : 'Continue.' })
      }
    }
  }
  return out
}

/**
 * Build a canonical Google Gemini `generateContent` request body from IR.
 * `target`: `'gemini'` (Google Gemini API) or `'antigravity'` (Antigravity / Code Assist).
 */
export function buildGeminiRequest(
  ir,
  { target = 'gemini', model = ir.model, defaultEffort, includeThinkingConfig = false } = {},
) {
  const ag = target === 'antigravity'
  const claude = /claude/i.test(model)
  const callNames = new Map()
  const contents = []
  const cleanedMessages = dropDuplicateToolResults(ir.messages)
  const resolveWireName = (rawName) =>
    ir.restoreContext?.wireNameFor ? ir.restoreContext.wireNameFor(rawName) : geminiFuncName(rawName)
  const schemaByToolName = new Map()
  for (const tool of ir.tools || []) {
    if (!tool?.name) continue
    schemaByToolName.set(tool.name, tool.schema)
    if (tool.wireName) schemaByToolName.set(tool.wireName, tool.schema)
    if (tool.origName) schemaByToolName.set(tool.origName, tool.schema)
  }

  for (const msg of cleanedMessages) {
    const role = msg.role === 'assistant' ? 'model' : 'user'
    const parts = []
    const signedTurn = msg.parts.some((p) => p.kind === 'tool_call' && p.signature)
    for (const p of msg.parts) {
      if (p.kind === 'thinking') {
        // CRAGGemini / native agy does not replay historical thought blocks over SHM;
        // omit them on `antigravity` to minimize payload size while preserving direct Gemini API replay.
        if (!ag && p.signature && !claude) {
          parts.push({ text: p.text || '', thought: true, thoughtSignature: p.signature })
        }
      } else if (p.kind === 'text') {
        let text = stripAnthropicBillingLines(p.text || '')
        if (ag) text = sanitizeNativeTuiText(text)
        const substantive = !isPlaceholderText(text)
        const realSig = p.signature && p.signature !== SKIP_THOUGHT_SIGNATURE ? p.signature : ''
        if (substantive || (realSig && !claude)) {
          const part = { text: substantive ? text : '' }
          if (realSig && !claude) part.thoughtSignature = realSig
          parts.push(part)
        }
      } else if (p.kind === 'image' || p.kind === 'file') {
        if (p.data) parts.push({ inlineData: { mimeType: p.mediaType, data: p.data } })
        else if (p.url) {
          if (ag) {
            const refText = sanitizeNativeTuiText(`[Attached ${p.mediaType || 'file'}: ${p.url}]`)
            if (refText.trim()) parts.push({ text: refText })
          } else {
            parts.push({ fileData: { mimeType: p.mediaType, fileUri: p.url } })
          }
        }
      } else if (p.kind === 'tool_call') {
        const safeName = resolveWireName(p.name)
        if (p.id) callNames.set(p.id, safeName)
        let callArgs = isPlainObject(p.args) ? cleanUndefinedStrings(p.args) : {}
        if (ag) {
          const toolSchema = schemaByToolName.get(p.name) || schemaByToolName.get(safeName)
          callArgs = forwardAgyBridgeToolArgs(callArgs, toolSchema)
        }
        const fnCall = { name: safeName, args: callArgs }
        if (p.id) fnCall.id = ag ? p.id.replace(/[^a-zA-Z0-9_-]/g, '_') : p.id
        const part = { functionCall: fnCall }
        if (ag) {
          // On CRAGGemini only preserve genuine thoughtSignature anchors (never inject dummy validator strings).
          if (!claude && p.signature && p.signature !== SKIP_THOUGHT_SIGNATURE) {
            part.thoughtSignature = p.signature
          }
        } else if (claude) {
          part.thoughtSignature = SKIP_THOUGHT_SIGNATURE
        } else if (p.signature) {
          part.thoughtSignature = p.signature
        } else if (!signedTurn) {
          part.thoughtSignature = SKIP_THOUGHT_SIGNATURE
        }
        parts.push(part)
      } else if (p.kind === 'tool_result') {
        const safeName = p.name ? resolveWireName(p.name) : callNames.get(p.callId) || 'tool'
        const key = ag ? 'result' : p.isError ? 'error' : 'output'
        let resultText = typeof p.text === 'string' ? p.text : ''
        if (ag) resultText = sanitizeNativeTuiText(resultText)
        if (!resultText.trim() && !(Array.isArray(p.images) && p.images.length)) {
          resultText = p.isError ? EMPTY_TOOL_ERR_TEXT : EMPTY_TOOL_OK_TEXT
        }
        const fr = {
          name: safeName,
          response: ag ? sanitizeNativeTuiResponseValue({ [key]: resultText }) : { [key]: resultText },
        }
        if (p.callId) fr.id = ag ? p.callId.replace(/[^a-zA-Z0-9_-]/g, '_') : p.callId
        parts.push({ functionResponse: fr })
        if (Array.isArray(p.images)) {
          for (const img of p.images) {
            if (img.data) parts.push({ inlineData: { mimeType: img.mediaType, data: img.data } })
            else if (img.url) {
              if (ag) {
                const refText = sanitizeNativeTuiText(`[Attached ${img.mediaType || 'image'}: ${img.url}]`)
                if (refText.trim()) parts.push({ text: refText })
              } else {
                parts.push({ fileData: { mimeType: img.mediaType, fileUri: img.url } })
              }
            }
          }
        }
      }
    }

    // Separate user text from functionResponse into distinct user turns (Gemini rejects mixed turns).
    let toolParts = parts
    let userTextParts = []
    if (role === 'user' && hasFunctionResponse(parts)) {
      toolParts = []
      for (const part of parts) {
        if (part.functionResponse || part.inlineData || part.fileData) toolParts.push(part)
        else userTextParts.push(part)
      }
    }
    for (const group of [toolParts, userTextParts]) {
      if (!group.length) continue
      const prev = contents[contents.length - 1]
      if (
        prev &&
        prev.role === role &&
        (role !== 'user' || hasFunctionResponse(prev.parts) === hasFunctionResponse(group))
      ) {
        prev.parts.push(...group)
      } else {
        contents.push({ role, parts: group })
      }
    }
  }

  const paired = ensureGeminiContentsValid(pairFunctionTurns(contents, { responseKey: ag ? 'result' : 'output' }), {
    antigravity: ag,
  })

  const req = ag && model ? { model, contents: paired } : { contents: paired }
  let cleanedSystem = stripAnthropicBillingLines(ir.system || '').trim()
  if (ag && cleanedSystem) cleanedSystem = stripIllegalControlChars(cleanedSystem).trim()
  if (ag) {
    // Inject concise behavioral directives only for caller contracts that CRAGGemini
    // cannot receive via generationConfig (parallel_tool_calls, search options, response_format).
    const directives = []
    const toolsActive = ir.tools.length > 0 && ir.toolChoice !== 'none'
    if (ir.disableParallelTools && toolsActive) {
      directives.push('Call at most one function in this response.')
    }
    if (ir.webSearch && ir.searchOptions && ir.toolChoice !== 'none') {
      directives.push(...formatSearchOptionsDirectives(ir.searchOptions))
    }
    if (ir.responseFormat) {
      const fmtDirective = formatResponseFormatDirective(ir.responseFormat)
      if (fmtDirective) directives.push(fmtDirective)
    }
    if (directives.length) {
      const block = stripIllegalControlChars(directives.join('\n')).trim()
      if (block) cleanedSystem = cleanedSystem ? `${cleanedSystem}\n\n${block}` : block
    }
  }
  if (cleanedSystem) {
    req.systemInstruction = { parts: [{ text: cleanedSystem }] }
  }

  if (ag) {
    // CRAGGemini minimal tool forwarding:
    // - `toolChoice === 'none'` omits both `tools` and `toolConfig` so native `agy` never registers unused tools.
    // - Supports combining `functionDeclarations` with allowed native Google tools (`googleSearch`, `urlContext`).
    // - Omits default `{ mode: 'AUTO' }` `toolConfig` unless `allowedFunctionNames` narrows the set.
    if (ir.toolChoice !== 'none') {
      const agTools = []
      if (ir.tools.length > 0) {
        const decls = ir.tools.map((tool) => {
          const wireName = tool.wireName || resolveWireName(tool.name)
          const decl = { name: wireName }
          if (tool.description) decl.description = stripIllegalControlChars(tool.description)
          decl.parameters = avoidAgyBridgeParamCollisions(sanitizeGeminiSchema(tool.schema, { plain: true }))
          return decl
        })
        agTools.push({ functionDeclarations: decls })
      }
      if (ir.webSearch) agTools.push({ googleSearch: {} })
      for (const gt of ir.googleTools || []) {
        const keys = isPlainObject(gt) ? Object.keys(gt) : []
        if (!keys.length || !keys.every((k) => CRAGGEMINI_GOOGLE_TOOLS.has(k))) continue
        if (keys.length === 1 && keys[0] === 'googleSearch' && ir.webSearch) continue
        agTools.push(gt)
      }
      if (agTools.length) req.tools = agTools

      if (ir.tools.length > 0) {
        const fc = {}
        if (ir.toolChoice === 'required') {
          fc.mode = 'ANY'
          if (ir.restoreContext?.allowedToolNames?.size) {
            fc.allowedFunctionNames = [...ir.restoreContext.allowedToolNames]
          }
        } else if (typeof ir.toolChoice === 'string' && ir.toolChoice.startsWith('name:')) {
          fc.mode = 'ANY'
          fc.allowedFunctionNames = [resolveWireName(ir.toolChoice.slice(5))]
        } else if (ir.restoreContext?.allowedToolNames?.size) {
          fc.mode = 'AUTO'
          fc.allowedFunctionNames = [...ir.restoreContext.allowedToolNames]
        }
        if (fc.mode) req.toolConfig = { functionCallingConfig: fc }
      }
    }

    // Minimal CRAGGemini generationConfig: strip all sampling/token/thinking/schema fields
    // ignored by CRAGGemini SHM, retaining ONLY image-generation controls when requested.
    const rawGen = { ...ir.extraGenConfig, ...ir.generationConfig }
    const agGen = {}
    if (Array.isArray(rawGen.responseModalities)) {
      const mods = rawGen.responseModalities
        .map((m) => String(m || '').toUpperCase())
        .filter((m) => m === 'TEXT' || m === 'IMAGE')
      if (mods.includes('IMAGE')) agGen.responseModalities = mods
    }
    if (isPlainObject(rawGen.imageConfig)) {
      const cleanImageCfg = {}
      const ratio = typeof rawGen.imageConfig.aspectRatio === 'string' ? rawGen.imageConfig.aspectRatio.trim() : ''
      if (ratio && CRAGGEMINI_IMAGE_ASPECT_RATIOS.has(ratio)) cleanImageCfg.aspectRatio = ratio
      const size =
        typeof rawGen.imageConfig.imageSize === 'string' ? rawGen.imageConfig.imageSize.trim().toUpperCase() : ''
      if (size === '1K' || size === '2K' || size === '4K') cleanImageCfg.imageSize = size
      if (Object.keys(cleanImageCfg).length) agGen.imageConfig = cleanImageCfg
    }
    if (
      (agGen.responseModalities || agGen.imageConfig) &&
      Number.isInteger(rawGen.candidateCount) &&
      rawGen.candidateCount > 0 &&
      rawGen.candidateCount <= 8
    ) {
      agGen.candidateCount = rawGen.candidateCount
    }
    if (includeThinkingConfig) {
      const effectiveDefaultEffort =
        defaultEffort !== undefined ? defaultEffort : resolveGeminiDefaultEffort(ir.requestedModel || model)
      const tc = buildThinkingConfig(ir, ir.requestedModel || model, {
        defaultEffort: effectiveDefaultEffort,
      })
      if (tc) agGen.thinkingConfig = tc
    }
    if (Object.keys(agGen).length) req.generationConfig = agGen

    if (ir.conversationId) req.conversation_id = ir.conversationId
    return req
  }

  // Direct Google Gemini API (`target === 'gemini'`): preserve full native Gemini API fields.
  if (ir.tools.length > 0 && ir.toolChoice !== 'none') {
    const decls = ir.tools.map((tool) => {
      const decl = { name: tool.wireName || resolveWireName(tool.name) }
      if (tool.description) decl.description = tool.description
      decl.parametersJsonSchema = sanitizeGeminiSchema(tool.schema, { plain: false })
      return decl
    })
    req.tools = [{ functionDeclarations: decls }]
    const fc = { mode: 'AUTO' }
    if (ir.toolChoice === 'required') fc.mode = 'ANY'
    else if (typeof ir.toolChoice === 'string' && ir.toolChoice.startsWith('name:')) {
      fc.mode = 'ANY'
      fc.allowedFunctionNames = [resolveWireName(ir.toolChoice.slice(5))]
    }
    if (ir.restoreContext?.allowedToolNames?.size && !fc.allowedFunctionNames) {
      fc.allowedFunctionNames = [...ir.restoreContext.allowedToolNames]
    }
    req.toolConfig = { functionCallingConfig: fc }
  } else if (ir.toolChoice === 'none' && ir.tools.length > 0) {
    req.toolConfig = { functionCallingConfig: { mode: 'NONE' } }
  } else if (ir.webSearch || ir.googleTools.length > 0) {
    const tools = []
    if (ir.webSearch) tools.push({ googleSearch: {} })
    for (const gt of ir.googleTools) tools.push(gt)
    if (tools.length) req.tools = tools
  }

  const gen = { ...ir.extraGenConfig, ...ir.generationConfig }
  const effectiveDefaultEffort = defaultEffort !== undefined ? defaultEffort : resolveGeminiDefaultEffort(model)
  const tc = buildThinkingConfig(ir, model, { defaultEffort: effectiveDefaultEffort })
  if (tc) gen.thinkingConfig = tc
  if (ir.responseFormat) {
    if (ir.responseFormat.type === 'enum' && Array.isArray(ir.responseFormat.values)) {
      gen.responseMimeType = 'text/x.enum'
      gen.responseJsonSchema = { type: 'string', enum: ir.responseFormat.values }
    } else {
      gen.responseMimeType = 'application/json'
      if (ir.responseFormat.type === 'json_schema' && ir.responseFormat.schema) {
        gen.responseJsonSchema = sanitizeGeminiSchema(ir.responseFormat.schema, { plain: false })
      }
    }
  }
  if (Object.keys(gen).length) req.generationConfig = gen
  if (Array.isArray(ir.safetySettings) && ir.safetySettings.length > 0) {
    req.safetySettings = ir.safetySettings
  }
  if (typeof ir.cachedContent === 'string' && ir.cachedContent.length > 0) {
    req.cachedContent = ir.cachedContent
  }
  return req
}

export function normalizeGeminiUsage(metadata) {
  if (!isPlainObject(metadata)) return null
  const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0)
  const rawPrompt = int(metadata.promptTokenCount ?? metadata.prompt_token_count)
  const rawCached = int(metadata.cachedContentTokenCount ?? metadata.cached_content_token_count)
  const candidates = int(metadata.candidatesTokenCount ?? metadata.candidates_token_count)
  const thoughts = int(metadata.thoughtsTokenCount ?? metadata.thoughts_token_count)
  const total = int(metadata.totalTokenCount ?? metadata.total_token_count)
  const output = candidates + thoughts
  let prompt = rawPrompt
  if (prompt === 0 && total > 0) {
    prompt = Math.max(total - output, 0)
  }
  if (prompt === 0 && rawCached > 0) {
    prompt = rawCached
  }
  const cached = Math.min(prompt, rawCached)
  return {
    input_tokens: Math.max(prompt - cached, 0),
    output_tokens: output,
    cache_read_tokens: cached,
    reasoning_tokens: thoughts,
    total_tokens: total || prompt + output,
  }
}

export function toGoogleUsageMetadata(usage = {}) {
  const input = Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : 0
  const cached = Number.isSafeInteger(usage.cache_read_tokens)
    ? usage.cache_read_tokens
    : Number.isSafeInteger(usage.cache_read_input_tokens)
      ? usage.cache_read_input_tokens
      : 0
  const output = Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : 0
  const thoughts = Number.isSafeInteger(usage.reasoning_tokens) ? usage.reasoning_tokens : 0
  const prompt = input + cached
  const out = {
    promptTokenCount: prompt,
    candidatesTokenCount: Math.max(output - thoughts, 0),
    totalTokenCount:
      Number.isSafeInteger(usage.total_tokens) && usage.total_tokens > 0 ? usage.total_tokens : prompt + output,
  }
  if (cached > 0) out.cachedContentTokenCount = cached
  if (thoughts > 0) out.thoughtsTokenCount = thoughts
  return out
}

export function toOpenAIChatUsage(usage = {}) {
  const input = Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : 0
  const cached = Number.isSafeInteger(usage.cache_read_tokens)
    ? usage.cache_read_tokens
    : Number.isSafeInteger(usage.cache_read_input_tokens)
      ? usage.cache_read_input_tokens
      : 0
  const prompt = input + cached
  const output = Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : 0
  const thoughts = Number.isSafeInteger(usage.reasoning_tokens) ? usage.reasoning_tokens : 0
  const out = {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens:
      Number.isSafeInteger(usage.total_tokens) && usage.total_tokens > 0 ? usage.total_tokens : prompt + output,
  }
  if (cached > 0) out.prompt_tokens_details = { cached_tokens: cached }
  if (thoughts > 0) out.completion_tokens_details = { reasoning_tokens: thoughts }
  return out
}

export function toOpenAIResponsesUsage(usage = {}) {
  const input = Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : 0
  const cached = Number.isSafeInteger(usage.cache_read_tokens)
    ? usage.cache_read_tokens
    : Number.isSafeInteger(usage.cache_read_input_tokens)
      ? usage.cache_read_input_tokens
      : 0
  const prompt = input + cached
  const output = Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : 0
  const thoughts = Number.isSafeInteger(usage.reasoning_tokens) ? usage.reasoning_tokens : 0
  const out = {
    input_tokens: prompt,
    output_tokens: output,
    total_tokens:
      Number.isSafeInteger(usage.total_tokens) && usage.total_tokens > 0 ? usage.total_tokens : prompt + output,
  }
  if (cached > 0) out.input_tokens_details = { cached_tokens: cached }
  if (thoughts > 0) out.output_tokens_details = { reasoning_tokens: thoughts }
  return out
}

export function toAnthropicUsage(usage = {}) {
  const input = Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : 0
  const output = Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : 0
  const cached = Number.isSafeInteger(usage.cache_read_tokens)
    ? usage.cache_read_tokens
    : Number.isSafeInteger(usage.cache_read_input_tokens)
      ? usage.cache_read_input_tokens
      : 0
  const out = { input_tokens: input, output_tokens: output }
  if (cached > 0) out.cache_read_input_tokens = cached
  return out
}

function stopReasonFromGemini(finishReason, sawTool) {
  const raw = String(finishReason || '').toUpperCase()
  if (raw === 'MAX_TOKENS') return 'length'
  if (
    ['STOP', 'FINISH_REASON_UNSPECIFIED', 'OTHER', 'MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', ''].includes(raw)
  ) {
    return sawTool ? 'tool' : 'stop'
  }
  return 'filter'
}

function stopToGeminiFinish(stop) {
  if (stop === 'length') return 'MAX_TOKENS'
  if (stop === 'filter') return 'SAFETY'
  return 'STOP'
}

function stopToOpenAIFinish(stop, { legacyFunctions = false } = {}) {
  if (stop === 'tool') return legacyFunctions ? 'function_call' : 'tool_calls'
  if (stop === 'length') return 'length'
  if (stop === 'filter') return 'content_filter'
  return 'stop'
}

function stopToAnthropicReason(stop) {
  if (stop === 'tool') return 'tool_use'
  if (stop === 'length') return 'max_tokens'
  if (stop === 'stop_sequence') return 'stop_sequence'
  if (stop === 'filter') return 'refusal'
  return 'end_turn'
}

/** Parse one raw SSE frame (`data: ...\n\n`) from Gemini API or Code Assist. */
export function parseGeminiSseFrame(frame) {
  const normalized = String(frame || '').replace(/\r\n/g, '\n')
  const dataLines = []
  let eventName = ''
  for (const line of normalized.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const field = line.slice(0, colon)
    const rawVal = line.slice(colon + 1)
    const value = rawVal.startsWith(' ') ? rawVal.slice(1) : rawVal
    if (field === 'event') eventName = value.trim()
    else if (field === 'data') dataLines.push(value)
  }
  if (eventName === 'error') {
    const raw = dataLines.join('\n')
    try {
      const parsed = JSON.parse(raw)
      const status = Number.isInteger(parsed?.status)
        ? parsed.status
        : Number.isInteger(parsed?.error?.code)
          ? parsed.error.code
          : 502
      return {
        kind: 'error',
        status,
        code:
          (typeof parsed?.error?.code === 'string' && parsed.error.code) ||
          (typeof parsed?.error?.status === 'string' && parsed.error.status) ||
          (typeof parsed?.code === 'string' && parsed.code) ||
          'gemini_inference_failed',
        message: parsed?.error?.message || parsed?.message || 'Gemini stream error',
      }
    } catch {
      return { kind: 'error', status: 502, code: 'gemini_inference_failed', message: raw || 'Gemini stream error' }
    }
  }
  if (!dataLines.length) return { kind: 'ignore' }
  const raw = dataLines.join('\n').trim()
  if (!raw || raw === '[DONE]') return { kind: 'done' }
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return { kind: 'invalid', message: 'Invalid JSON in Gemini SSE frame' }
  }
  if (!isPlainObject(payload)) return { kind: 'invalid', message: 'Gemini SSE frame must be a JSON object' }
  if (isPlainObject(payload.error)) {
    return {
      kind: 'error',
      status: Number.isInteger(payload.error.code) ? payload.error.code : 502,
      code: payload.error.status || 'gemini_inference_failed',
      message: payload.error.message || 'Gemini returned an error frame',
    }
  }
  const response = payload.response !== undefined ? payload.response : payload
  if (!isPlainObject(response)) return { kind: 'invalid', message: 'Invalid wrapped Gemini response' }
  if (isPlainObject(response.error)) {
    return {
      kind: 'error',
      status: Number.isInteger(response.error.code) ? response.error.code : 502,
      code: response.error.status || 'gemini_inference_failed',
      message: response.error.message || 'Gemini returned an error frame',
    }
  }
  const meta = isPlainObject(payload.craggeminiMeta)
    ? payload.craggeminiMeta
    : isPlainObject(response.craggeminiMeta)
      ? response.craggeminiMeta
      : null
  return { kind: 'chunk', chunk: response, meta }
}

/**
 * Stateful decoder: converts Gemini/CodeAssist response chunks (from SSE or JSON)
 * into normalized IR events for streaming encoders and non-streaming collectors.
 */
export function createGeminiEventDecoder({ fallbackModel = '' } = {}) {
  let started = false
  let reportedModel = null
  let sawTool = false
  let stopped = false
  let searched = false
  let mergedRawUsage = null
  let latestUsage = null
  let emittedUsage = null

  function mergeRawUsage(raw) {
    if (!isPlainObject(raw)) return null
    const next = mergedRawUsage ? { ...mergedRawUsage } : {}
    let changed = false
    for (const [k, v] of Object.entries(raw)) {
      if (v != null) {
        next[k] = v
        changed = true
      }
    }
    if (!changed && !mergedRawUsage) return null
    mergedRawUsage = next
    return normalizeGeminiUsage(mergedRawUsage)
  }

  function decodeChunk(chunk, emit, meta = null) {
    if (!isPlainObject(chunk)) return
    const usage = mergeRawUsage(chunk.usageMetadata ?? chunk.usage_metadata)
    if (usage) latestUsage = usage
    const chunkModel =
      typeof chunk.modelVersion === 'string' && chunk.modelVersion.trim() ? chunk.modelVersion.trim() : null
    if (!started) {
      started = true
      if (chunkModel) reportedModel = chunkModel
      emit({
        kind: 'start',
        responseId:
          typeof chunk.responseId === 'string' && chunk.responseId ? chunk.responseId : `resp_${randomHex(10)}`,
        model: chunkModel || fallbackModel,
        ...(chunkModel ? { reportedModel: chunkModel } : {}),
        usage: latestUsage
          ? { input_tokens: latestUsage.input_tokens, cache_read_tokens: latestUsage.cache_read_tokens }
          : null,
      })
    } else if (chunkModel && chunkModel !== reportedModel) {
      reportedModel = chunkModel
      emit({ kind: 'model', model: chunkModel, reportedModel: chunkModel })
    }
    const effectiveMeta = meta || (isPlainObject(chunk.craggeminiMeta) ? chunk.craggeminiMeta : null)
    if (effectiveMeta) {
      emit({
        kind: 'meta',
        conversationId: typeof effectiveMeta.conversation_id === 'string' ? effectiveMeta.conversation_id : '',
        nativeConversationId:
          typeof effectiveMeta.native_conversation_id === 'string' ? effectiveMeta.native_conversation_id : '',
        awaitingToolResults: effectiveMeta.awaiting_tool_results === true,
      })
    }
    const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : []
    for (const candidate of candidates) {
      if (!isPlainObject(candidate)) continue
      const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : []
      for (const part of parts) {
        if (!isPlainObject(part)) continue
        if (isPlainObject(part.functionCall)) {
          sawTool = true
          const rawId =
            typeof part.functionCall.id === 'string' && part.functionCall.id ? part.functionCall.id : newCallId()
          const sig = typeof part.thoughtSignature === 'string' ? part.thoughtSignature : ''
          const name = geminiToolNameFromCall(part.functionCall.name)
          const args = isPlainObject(part.functionCall.args) ? part.functionCall.args : {}
          emit({ kind: 'tool_call', id: rawId, signedId: signedToolCallId(rawId, sig), name, args, signature: sig })
        } else if (part.thought === true) {
          if (typeof part.text === 'string' && part.text) {
            emit({ kind: 'thinking', text: part.text })
          }
          if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
            emit({ kind: 'thinking_signature', signature: part.thoughtSignature })
          }
        } else if (isPlainObject(part.inlineData) && typeof part.inlineData.data === 'string' && part.inlineData.data) {
          emit({
            kind: 'image',
            mediaType: part.inlineData.mimeType || 'image/png',
            data: part.inlineData.data,
          })
        } else if (part.executableCode || part.codeExecutionResult) {
          const formatted = formatExecutableCodePart(part)
          if (formatted) emit({ kind: 'text', text: formatted })
        } else if (typeof part.text === 'string' || typeof part.thoughtSignature === 'string') {
          if (typeof part.text === 'string' && part.text) emit({ kind: 'text', text: part.text })
          if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
            emit({ kind: 'text_signature', signature: part.thoughtSignature })
          }
        }
      }

      const grounding = candidate.groundingMetadata
      if (isPlainObject(grounding) && !searched) {
        const queries = Array.isArray(grounding.webSearchQueries)
          ? grounding.webSearchQueries.filter((q) => typeof q === 'string' && q.trim())
          : []
        const hits = Array.isArray(grounding.groundingChunks)
          ? grounding.groundingChunks
              .filter((c) => isPlainObject(c?.web) && typeof c.web.uri === 'string' && c.web.uri)
              .map((c) => ({ title: c.web.title || c.web.uri, url: c.web.uri }))
          : []
        if (queries.length || hits.length) {
          searched = true
          emit({ kind: 'search', queries, hits })
        }
      }

      const finishReason = candidate.finishReason
      if (
        typeof finishReason === 'string' &&
        finishReason &&
        finishReason !== 'FINISH_REASON_UNSPECIFIED' &&
        !stopped
      ) {
        stopped = true
        emit({
          kind: 'stop',
          finishReason,
          stopReason: stopReasonFromGemini(finishReason, sawTool),
        })
      }
    }
    if (stopped && latestUsage && emittedUsage !== latestUsage) {
      emittedUsage = latestUsage
      emit({ kind: 'usage', usage: latestUsage })
    }
  }

  return {
    decodeChunk,
    decodeSseFrame(frame, emit) {
      const parsed = parseGeminiSseFrame(frame)
      if (parsed.kind === 'chunk') decodeChunk(parsed.chunk, emit, parsed.meta)
      else if (parsed.kind === 'error') {
        emit({ kind: 'error', status: parsed.status, code: parsed.code, message: parsed.message })
      } else if (parsed.kind === 'invalid') {
        emit({ kind: 'error', status: 502, code: 'gemini_inference_invalid_output', message: parsed.message })
      }
      return parsed.kind
    },
    flush(emit) {
      if (latestUsage && emittedUsage !== latestUsage) {
        emittedUsage = latestUsage
        emit({ kind: 'usage', usage: latestUsage })
      }
    },
    get usage() {
      return latestUsage
    },
    get sawFinish() {
      return stopped
    },
  }
}

function unquoteClaudeEnumArgs(args, schema) {
  if (!isPlainObject(args) || !isPlainObject(schema?.properties)) return args
  let changed = false
  const out = { ...args }
  for (const [key, val] of Object.entries(args)) {
    const prop = schema.properties[key]
    if (!isPlainObject(prop)) continue
    if (typeof val === 'string' && Array.isArray(prop.enum) && prop.enum.length && !prop.enum.includes(val)) {
      try {
        const parsed = JSON.parse(val)
        if (typeof parsed === 'string' && prop.enum.includes(parsed)) {
          out[key] = parsed
          changed = true
        }
      } catch {}
    } else if (isPlainObject(val) && isPlainObject(prop.properties)) {
      const nested = unquoteClaudeEnumArgs(val, prop)
      if (nested !== val) {
        out[key] = nested
        changed = true
      }
    }
  }
  return changed ? out : args
}

function unwrapStructuredText(rawText, responseFormat) {
  let text = String(rawText ?? '').trim()
  const fence = /^```(?:json|JSON|[a-zA-Z0-9_-]+)?\s*\r?\n([\s\S]*?)\r?\n```$/.exec(text)
  if (fence) text = fence[1].trim()
  if (responseFormat?.type === 'enum') {
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      text = text.slice(1, -1).trim()
    }
  }
  return text
}

/**
 * Outbound restoration middleware: restores tool names/shapes/namespaces,
 * enforces caller contracts stripped for CRAGGemini (stopSequences, maxOutputTokens,
 * hideThinking, disableParallelTools, allowedToolNames, responseFormat fences,
 * search domain filters, Claude double-quoted enum fix) uniformly across all 4 protocols.
 */
export function createGeminiRestoreTransform(
  restoreContext,
  { target = 'antigravity', model = '', onEarlyStop = null } = {},
) {
  const ctx = isPlainObject(restoreContext) ? restoreContext : null
  if (!ctx) {
    return {
      push(event, emit) {
        emit(event)
      },
      flush() {},
    }
  }

  const ag = target === 'antigravity'
  const claudeModel = /claude/i.test(model)
  const stopSeqs = Array.isArray(ctx.stopSequences)
    ? ctx.stopSequences.filter((s) => typeof s === 'string' && s.length > 0)
    : []
  const maxStopLen = stopSeqs.reduce((acc, s) => Math.max(acc, s.length), 0)
  const bufferForResponseFormat = ag && isPlainObject(ctx.responseFormat)
  const enforceMaxTokens = ag && Number.isInteger(ctx.maxOutputTokens) && ctx.maxOutputTokens > 0

  let terminated = false
  let stopBuf = ''
  let formatBuf = ''
  let emittedToolCalls = 0
  let emittedChars = 0
  let observedOutputTokens = 0
  let latestUsage = null

  const triggerEarlyStop = (stopEvent, emit) => {
    if (terminated) return
    terminated = true
    emit(stopEvent)
    if (latestUsage) emit({ kind: 'usage', usage: latestUsage })
    onEarlyStop?.()
  }

  const flushStopMatch = (incomingText, emit) => {
    const combined = stopBuf + incomingText
    let bestIdx = -1
    let bestSeq = ''
    for (const seq of stopSeqs) {
      const idx = combined.indexOf(seq)
      if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
        bestIdx = idx
        bestSeq = seq
      }
    }
    if (bestIdx >= 0) {
      const prefix = combined.slice(0, bestIdx)
      stopBuf = ''
      if (prefix) {
        emittedChars += prefix.length
        emit({ kind: 'text', text: prefix })
      }
      triggerEarlyStop({ kind: 'stop', finishReason: 'STOP', stopReason: 'stop_sequence', stopSequence: bestSeq }, emit)
      return true
    }
    if (maxStopLen > 1 && combined.length >= maxStopLen) {
      const safeLen = combined.length - (maxStopLen - 1)
      const safe = combined.slice(0, safeLen)
      stopBuf = combined.slice(safeLen)
      if (safe) {
        emittedChars += safe.length
        emit({ kind: 'text', text: safe })
      }
    } else if (maxStopLen <= 1) {
      stopBuf = ''
      if (combined) {
        emittedChars += combined.length
        emit({ kind: 'text', text: combined })
      }
    } else {
      stopBuf = combined
    }
    return false
  }

  const checkTokenCap = (emit) => {
    if (!enforceMaxTokens || terminated) return false
    const estTokens = Math.max(observedOutputTokens, Math.ceil(emittedChars / 4))
    if (estTokens >= ctx.maxOutputTokens) {
      if (stopBuf) {
        emit({ kind: 'text', text: stopBuf })
        stopBuf = ''
      }
      triggerEarlyStop({ kind: 'stop', finishReason: 'MAX_TOKENS', stopReason: 'length' }, emit)
      return true
    }
    return false
  }

  return {
    push(event, emit) {
      if (!event) return
      if (event.kind === 'usage' && event.usage) {
        latestUsage = event.usage
        if (Number.isSafeInteger(event.usage.output_tokens)) {
          observedOutputTokens = Math.max(observedOutputTokens, event.usage.output_tokens)
        }
        if (terminated) return
        emit(event)
        return
      }
      if (event.kind === 'meta' || event.kind === 'start' || event.kind === 'error') {
        if (terminated && event.kind !== 'meta') return
        emit(event)
        return
      }
      if (terminated) return

      if (event.kind === 'thinking') {
        if (ctx.hideThinking) return
        emittedChars += (event.text || '').length
        emit(event)
        checkTokenCap(emit)
        return
      }

      if (event.kind === 'thinking_signature') {
        if (ctx.hideThinking && ctx.thinkingDisplay !== 'omitted' && ctx.protocol !== 'gemini') return
        emit(event)
        return
      }

      if (event.kind === 'search') {
        const allowed = ctx.searchOptions?.allowedDomains
        const blocked = ctx.searchOptions?.blockedDomains
        if (allowed?.length || blocked?.length) {
          const hits = (event.hits || []).filter((hit) => {
            const targetUrl = hit?.url || hit?.title || ''
            if (allowed?.length && !domainMatchesList(targetUrl, allowed)) return false
            if (blocked?.length && domainMatchesList(targetUrl, blocked)) return false
            return true
          })
          emit({ ...event, hits })
          return
        }
        emit(event)
        return
      }

      if (event.kind === 'tool_call') {
        if (ctx.toolChoice === 'none') return
        const cleanName = geminiToolNameFromCall(event.name)
        const entry = ctx.toolMap?.get(event.name) || ctx.toolMap?.get(cleanName) || null
        if (ctx.allowedToolNames?.size) {
          const matchedWire = entry?.wireName || cleanName
          if (
            !ctx.allowedToolNames.has(matchedWire) &&
            !ctx.allowedToolNames.has(event.name) &&
            !ctx.allowedToolNames.has(cleanName)
          ) {
            return
          }
        }
        if (ctx.disableParallelTools && emittedToolCalls >= 1) return
        emittedToolCalls += 1
        let args = event.args || {}
        if (ag) args = restoreAgyBridgeToolArgs(args, entry?.schema)
        if (claudeModel && entry?.schema) {
          args = unquoteClaudeEnumArgs(args, entry.schema)
        }
        emit({
          ...event,
          name: entry?.origName || cleanName,
          wireName: entry?.wireName || cleanName,
          namespace: entry?.namespace || '',
          toolKind: entry?.kind || (ctx.legacyFunctions ? 'legacy_function' : 'function'),
          args,
        })
        return
      }

      if (event.kind === 'text') {
        let piece = event.text || ''
        if (!piece) return
        if (bufferForResponseFormat) {
          formatBuf += piece
          return
        }
        if (enforceMaxTokens) {
          const budgetChars = ctx.maxOutputTokens * 4
          const remaining = budgetChars - (emittedChars + stopBuf.length)
          if (remaining <= 0) {
            checkTokenCap(emit)
            return
          }
          if (piece.length > remaining) {
            piece = piece.slice(0, remaining)
          }
        }
        if (stopSeqs.length) {
          if (flushStopMatch(piece, emit)) return
        } else {
          emittedChars += piece.length
          emit({ ...event, text: piece })
        }
        checkTokenCap(emit)
        return
      }

      if (event.kind === 'stop') {
        if (bufferForResponseFormat && formatBuf) {
          const clean = unwrapStructuredText(formatBuf, ctx.responseFormat)
          formatBuf = ''
          if (clean) {
            if (stopSeqs.length) {
              if (flushStopMatch(clean, emit)) return
            } else {
              emit({ kind: 'text', text: clean })
            }
          }
        }
        if (stopBuf) {
          emit({ kind: 'text', text: stopBuf })
          stopBuf = ''
        }
        emit({
          ...event,
          stopReason:
            event.stopReason === 'stop' && emittedToolCalls > 0
              ? 'tool'
              : event.stopReason === 'tool' && emittedToolCalls === 0
                ? 'stop'
                : event.stopReason,
        })
        return
      }

      emit(event)
    },
    flush(emit) {
      if (terminated) return
      if (bufferForResponseFormat && formatBuf) {
        const clean = unwrapStructuredText(formatBuf, ctx.responseFormat)
        formatBuf = ''
        if (clean) emit({ kind: 'text', text: clean })
      }
      if (stopBuf) {
        emit({ kind: 'text', text: stopBuf })
        stopBuf = ''
      }
    },
  }
}

/** Accumulate decoded IR events into a complete turn object for JSON rendering and billing. */
export function createGeminiCollector({ fallbackModel = '' } = {}) {
  let id = `resp_${randomHex(10)}`
  let model = fallbackModel
  let reportedModel = null
  const parts = []
  let stopReason = 'stop'
  let finishReason = 'STOP'
  let stopSequence = null
  let sawFinish = false
  let usage = null
  let error = null
  let meta = null
  const searches = []

  return {
    push(event) {
      if (!event) return
      switch (event.kind) {
        case 'start':
          if (event.responseId) id = event.responseId
          if (event.model) model = event.model
          if (event.reportedModel) reportedModel = event.reportedModel
          if (event.usage && !usage) usage = { ...event.usage, output_tokens: 0, total_tokens: 0 }
          break
        case 'model':
          if (event.model) model = event.model
          if (event.reportedModel) reportedModel = event.reportedModel
          break
        case 'meta':
          meta = {
            conversationId: event.conversationId || meta?.conversationId || '',
            nativeConversationId: event.nativeConversationId || meta?.nativeConversationId || '',
            awaitingToolResults: event.awaitingToolResults === true || meta?.awaitingToolResults === true,
          }
          break
        case 'thinking': {
          const last = parts[parts.length - 1]
          if (last && last.kind === 'thinking' && !last.signature) last.text += event.text
          else parts.push({ kind: 'thinking', text: event.text, signature: '' })
          break
        }
        case 'thinking_signature': {
          const last = parts[parts.length - 1]
          if (last && last.kind === 'thinking' && !last.signature) last.signature = event.signature
          else parts.push({ kind: 'thinking', text: '', signature: event.signature })
          break
        }
        case 'text': {
          const last = parts[parts.length - 1]
          if (last && last.kind === 'text' && !last.signature) last.text += event.text
          else parts.push({ kind: 'text', text: event.text, signature: '' })
          break
        }
        case 'text_signature': {
          const last = parts[parts.length - 1]
          if (last && last.kind === 'text' && !last.signature) last.signature = event.signature
          else parts.push({ kind: 'text', text: '', signature: event.signature })
          break
        }
        case 'image':
          parts.push({ kind: 'image', mediaType: event.mediaType, data: event.data })
          break
        case 'tool_call':
          parts.push({
            kind: 'tool_call',
            id: event.id,
            signedId: event.signedId,
            name: event.name,
            namespace: event.namespace || '',
            toolKind: event.toolKind || 'function',
            args: event.args,
            signature: event.signature || '',
          })
          break
        case 'search':
          searches.push({ queries: event.queries || [], hits: event.hits || [] })
          break
        case 'stop':
          sawFinish = true
          stopReason = event.stopReason || 'stop'
          finishReason = event.finishReason || 'STOP'
          if (typeof event.stopSequence === 'string') stopSequence = event.stopSequence
          break
        case 'usage':
          usage = event.usage
          break
        case 'error':
          error = event
          break
        default:
          break
      }
    },
    result() {
      const text = parts
        .filter((p) => p.kind === 'text')
        .map((p) => p.text)
        .join('')
      const thinking = parts
        .filter((p) => p.kind === 'thinking')
        .map((p) => p.text)
        .join('')
      const toolCalls = parts.filter((p) => p.kind === 'tool_call')
      const images = parts.filter((p) => p.kind === 'image')
      return {
        id,
        model,
        reportedModel,
        parts,
        text,
        thinking,
        toolCalls,
        images,
        searches,
        stopReason: toolCalls.length && stopReason === 'stop' ? 'tool' : stopReason,
        finishReason,
        stopSequence,
        sawFinish,
        meta,
        usage: usage || {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: 0,
        },
        error,
      }
    },
  }
}

function buildGroundingMetadata(searches) {
  if (!searches?.length) return null
  const queries = []
  const chunks = []
  const seen = new Set()
  for (const s of searches) {
    for (const q of s.queries || []) {
      if (q && !queries.includes(q)) queries.push(q)
    }
    for (const hit of s.hits || []) {
      if (!hit?.url || seen.has(hit.url)) continue
      seen.add(hit.url)
      chunks.push({ web: { uri: hit.url, title: hit.title || hit.url } })
    }
  }
  if (!queries.length && !chunks.length) return null
  return {
    ...(queries.length ? { webSearchQueries: queries } : {}),
    groundingChunks: chunks,
  }
}

function renderGoogleParts(parts) {
  const out = []
  for (const p of parts) {
    if (p.kind === 'thinking') {
      if (p.text || p.signature) {
        const part = { text: p.text || '', thought: true }
        if (p.signature) part.thoughtSignature = p.signature
        out.push(part)
      }
    } else if (p.kind === 'text') {
      if (p.text || p.signature) {
        const part = { text: p.text || '' }
        if (p.signature) part.thoughtSignature = p.signature
        out.push(part)
      }
    } else if (p.kind === 'image') {
      out.push({ inlineData: { mimeType: p.mediaType, data: p.data } })
    } else if (p.kind === 'tool_call') {
      const part = { functionCall: { id: p.id, name: p.name, args: p.args || {} } }
      if (p.signature) part.thoughtSignature = p.signature
      out.push(part)
    }
  }
  return out
}

function responsesItemFromToolCall(tc, itemHex = randomHex(10)) {
  const callId = tc.signedId || tc.id
  const kind = tc.toolKind || 'function'
  const ns = tc.namespace || ''
  if (kind === 'custom_responses') {
    return {
      id: `ctc_${itemHex}`,
      type: 'custom_tool_call',
      status: 'completed',
      call_id: callId,
      name: tc.name,
      ...(ns ? { namespace: ns } : {}),
      input: unwrapCustomInput(tc.args),
    }
  }
  if (kind === 'local_shell') {
    return {
      id: `lsh_${itemHex}`,
      type: 'local_shell_call',
      status: 'completed',
      call_id: callId,
      action: { type: 'exec', ...(isPlainObject(tc.args) ? tc.args : {}) },
    }
  }
  if (kind === 'shell') {
    return {
      id: `sh_${itemHex}`,
      type: 'shell_call',
      status: 'completed',
      call_id: callId,
      action: isPlainObject(tc.args) ? tc.args : {},
    }
  }
  if (kind === 'apply_patch') {
    return {
      id: `ap_${itemHex}`,
      type: 'apply_patch_call',
      status: 'completed',
      call_id: callId,
      operation: isPlainObject(tc.args) ? tc.args : {},
    }
  }
  if (kind === 'computer' || kind === 'computer_preview') {
    const args = isPlainObject(tc.args) ? tc.args : {}
    return {
      id: `cu_${itemHex}`,
      type: 'computer_call',
      status: 'completed',
      call_id: callId,
      ...(kind === 'computer' ? { actions: Array.isArray(args.actions) ? args.actions : [] } : { action: args }),
    }
  }
  if (kind === 'tool_search') {
    return {
      id: `tsc_${itemHex}`,
      type: 'tool_search_call',
      status: 'completed',
      call_id: callId,
      execution: 'client',
      arguments: isPlainObject(tc.args) ? tc.args : {},
    }
  }
  return {
    id: `fc_${itemHex}`,
    type: 'function_call',
    status: 'completed',
    call_id: callId,
    name: tc.name,
    ...(ns ? { namespace: ns } : {}),
    arguments: JSON.stringify(tc.args || {}),
    ...(ns === 'collaboration' ? { encrypted_function_args: [] } : {}),
  }
}

function markdownImageFor(mediaType, data) {
  return `![image](data:${mediaType || 'image/png'};base64,${data})`
}

/** Render a collected Gemini turn as a non-streaming JSON body in any target protocol. */
export function renderGeminiProtocolResponse(
  protocol,
  collected,
  { model, sessionId, accountId, restoreContext = null } = {},
) {
  const effectiveModel = model || collected.model
  const usage = collected.usage || {}
  const legacyFunctions = Boolean(restoreContext?.legacyFunctions)
  if (protocol === 'gemini') {
    const parts = renderGoogleParts(collected.parts)
    const candidate = {
      content: { role: 'model', parts: parts.length ? parts : [{ text: '' }] },
      finishReason: stopToGeminiFinish(collected.stopReason),
      index: 0,
    }
    const grounding = buildGroundingMetadata(collected.searches)
    if (grounding) candidate.groundingMetadata = grounding
    return {
      candidates: [candidate],
      usageMetadata: toGoogleUsageMetadata(usage),
      modelVersion: effectiveModel,
      ...(collected.id ? { responseId: collected.id } : {}),
    }
  }
  if (protocol === 'anthropic') {
    const content = []
    for (const p of collected.parts) {
      if (p.kind === 'thinking' && (p.text || p.signature)) {
        const block = { type: 'thinking', thinking: p.text || '' }
        if (p.signature) block.signature = p.signature
        content.push(block)
      } else if (p.kind === 'text' && p.text) {
        content.push({ type: 'text', text: p.text })
      } else if (p.kind === 'image' && p.data) {
        content.push({ type: 'text', text: markdownImageFor(p.mediaType, p.data) })
      } else if (p.kind === 'tool_call') {
        content.push({ type: 'tool_use', id: p.signedId || p.id, name: p.name, input: p.args || {} })
      }
    }
    return {
      id: `msg_${randomHex(12)}`,
      type: 'message',
      role: 'assistant',
      model: effectiveModel,
      content,
      stop_reason: stopToAnthropicReason(collected.stopReason),
      stop_sequence: collected.stopSequence ?? null,
      usage: toAnthropicUsage(usage),
    }
  }
  if (protocol === 'openai-chat') {
    let textContent = collected.text || ''
    if (collected.images?.length) {
      const md = collected.images.map((img) => markdownImageFor(img.mediaType, img.data)).join('\n')
      textContent = textContent ? `${textContent.endsWith('\n') ? textContent : `${textContent}\n`}${md}\n` : `${md}\n`
    }
    const message = {
      role: 'assistant',
      content: textContent || (collected.toolCalls.length ? null : ''),
    }
    if (collected.thinking) message.reasoning_content = collected.thinking
    if (collected.toolCalls.length) {
      if (legacyFunctions) {
        const first = collected.toolCalls[0]
        message.function_call = { name: first.name, arguments: JSON.stringify(first.args || {}) }
      } else {
        message.tool_calls = collected.toolCalls.map((tc) => {
          if (tc.toolKind === 'custom_chat') {
            return {
              id: tc.signedId || tc.id,
              type: 'custom',
              custom: { name: tc.name, input: unwrapCustomInput(tc.args) },
              ...(tc.signature ? { extra_content: { google: { thought_signature: tc.signature } } } : {}),
            }
          }
          return {
            id: tc.signedId || tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
            ...(tc.signature ? { extra_content: { google: { thought_signature: tc.signature } } } : {}),
          }
        })
      }
    }
    return {
      id: `chatcmpl_${randomHex(12)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: effectiveModel,
      choices: [{ index: 0, message, finish_reason: stopToOpenAIFinish(collected.stopReason, { legacyFunctions }) }],
      usage: toOpenAIChatUsage(usage),
    }
  }
  if (protocol === 'openai-responses') {
    const output = []
    const includeEnc = Boolean(restoreContext?.includeEncryptedReasoning)
    let lastThinkingSig = ''
    for (const p of collected.parts || []) {
      if (p.kind === 'thinking' && p.signature) lastThinkingSig = p.signature
    }
    if (collected.thinking || (includeEnc && lastThinkingSig)) {
      output.push({
        id: `rs_${randomHex(12)}`,
        type: 'reasoning',
        status: 'completed',
        summary: collected.thinking ? [{ type: 'summary_text', text: collected.thinking }] : [],
        ...(includeEnc && lastThinkingSig ? { encrypted_content: lastThinkingSig } : {}),
      })
    }
    if (collected.text || (!collected.toolCalls.length && !collected.images?.length)) {
      output.push({
        id: `msg_${randomHex(12)}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: collected.text || '', annotations: [] }],
      })
    }
    for (let i = 0; i < (collected.images?.length || 0); i++) {
      output.push({
        id: `ig_${randomHex(8)}_${i}`,
        type: 'image_generation_call',
        status: 'completed',
        result: collected.images[i].data,
      })
    }
    for (const tc of collected.toolCalls) {
      output.push(responsesItemFromToolCall(tc))
    }
    const status = collected.stopReason === 'length' || collected.stopReason === 'filter' ? 'incomplete' : 'completed'
    const out = {
      id: `resp_${randomHex(12)}`,
      object: 'response',
      status,
      model: effectiveModel,
      output,
      usage: toOpenAIResponsesUsage(usage),
    }
    if (status === 'incomplete') {
      out.incomplete_details = { reason: collected.stopReason === 'length' ? 'max_output_tokens' : 'content_filter' }
    }
    return out
  }
  return {
    id: sessionId || collected.id,
    model: effectiveModel,
    ...(accountId ? { account_id: accountId } : {}),
    output_text: collected.text || '',
    ...(collected.thinking ? { reasoning_text: collected.thinking } : {}),
    ...(collected.toolCalls.length
      ? { tool_calls: collected.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.args })) }
      : {}),
    usage: {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      ...(usage.total_tokens ? { total_tokens: usage.total_tokens } : {}),
      ...(usage.cache_read_tokens ? { cache_read_tokens: usage.cache_read_tokens } : {}),
      ...(usage.reasoning_tokens ? { reasoning_tokens: usage.reasoning_tokens } : {}),
    },
  }
}

export function formatGeminiProtocolError(protocol, status, code, message, details = null) {
  const hasDetails = Boolean(details && typeof details === 'object' && Object.keys(details).length)
  if (protocol === 'gemini') {
    const grpcStatus =
      status === 400
        ? 'INVALID_ARGUMENT'
        : status === 401
          ? 'UNAUTHENTICATED'
          : status === 403
            ? 'PERMISSION_DENIED'
            : status === 404
              ? 'NOT_FOUND'
              : status === 409
                ? 'ABORTED'
                : status === 402 || status === 429
                  ? 'RESOURCE_EXHAUSTED'
                  : status === 504
                    ? 'DEADLINE_EXCEEDED'
                    : 'UNAVAILABLE'
    const info = { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: code }
    if (hasDetails) {
      const metadata = {}
      for (const [k, v] of Object.entries(details)) {
        if (v != null) metadata[k] = String(v)
      }
      if (Object.keys(metadata).length) info.metadata = metadata
    }
    return {
      error: {
        code: status,
        message,
        status: grpcStatus,
        details: [info],
      },
    }
  }
  const type =
    status === 401
      ? 'authentication_error'
      : status === 403
        ? 'permission_error'
        : status === 404
          ? 'not_found_error'
          : code === 'api_key_quota_exhausted'
            ? 'quota_error'
            : code === 'api_key_rate_limit' ||
                code === 'api_key_concurrency_limit' ||
                code === 'user_concurrency_limit' ||
                status === 429
              ? 'rate_limit_error'
              : status >= 500
                ? 'api_error'
                : 'invalid_request_error'
  if (protocol === 'anthropic') {
    return { type: 'error', error: hasDetails ? { type, message, code, details } : { type, message, code } }
  }
  return { error: hasDetails ? { type, code, message, details } : { type, code, message } }
}

export function formatGeminiProtocolStreamError(protocol, status, code, message) {
  const payload = formatGeminiProtocolError(protocol, status, code, message)
  if (protocol === 'anthropic') {
    return buildAnthropicSseError(payload.error)
  }
  if (protocol === 'openai-responses') {
    return `event: error\ndata: ${JSON.stringify({ type: 'error', error: payload.error })}\n\n`
  }
  if (protocol === 'openai-chat') {
    return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

/**
 * Incremental SSE encoder translating normalized Gemini IR events into
 * real-time wire frames for `gemini`, `openai-chat`, `openai-responses`, or `anthropic`.
 */
export function createGeminiProtocolStreamEncoder(
  protocol,
  { model = '', responseId = '', restoreContext = null } = {},
) {
  const collector = createGeminiCollector({ fallbackModel: model })
  const legacyFunctions = Boolean(restoreContext?.legacyFunctions)
  let started = false
  let finished = false
  let resolvedModel = model
  let resolvedId = responseId

  if (protocol === 'gemini') {
    const emitChunk = (parts, finish, usage, grounding) => {
      const candidate = { content: { role: 'model', parts: parts || [] }, index: 0 }
      if (finish) candidate.finishReason = finish
      if (grounding) candidate.groundingMetadata = grounding
      const frame = {
        candidates: [candidate],
        modelVersion: resolvedModel,
        ...(resolvedId ? { responseId: resolvedId } : {}),
      }
      if (usage) frame.usageMetadata = usage
      return `data: ${JSON.stringify(frame)}\n\n`
    }
    return {
      push(event) {
        if (finished || !event) return ''
        collector.push(event)
        if (event.kind === 'start') {
          started = true
          if (event.model) resolvedModel = event.model
          if (event.responseId) resolvedId = event.responseId
          return ''
        }
        if (event.kind === 'model') {
          if (event.model) resolvedModel = event.model
          return ''
        }
        if (event.kind === 'thinking') return emitChunk([{ text: event.text, thought: true }])
        if (event.kind === 'thinking_signature') {
          return emitChunk([{ text: '', thought: true, thoughtSignature: event.signature }])
        }
        if (event.kind === 'text') return emitChunk([{ text: event.text }])
        if (event.kind === 'text_signature') return emitChunk([{ text: '', thoughtSignature: event.signature }])
        if (event.kind === 'image') return emitChunk([{ inlineData: { mimeType: event.mediaType, data: event.data } }])
        if (event.kind === 'tool_call') {
          const part = { functionCall: { id: event.id, name: event.name, args: event.args || {} } }
          if (event.signature) part.thoughtSignature = event.signature
          return emitChunk([part])
        }
        if (event.kind === 'search') {
          const grounding = buildGroundingMetadata([{ queries: event.queries, hits: event.hits }])
          return grounding ? emitChunk([], '', null, grounding) : ''
        }
        if (event.kind === 'error') {
          finished = true
          return formatGeminiProtocolStreamError('gemini', event.status || 502, event.code, event.message)
        }
        return ''
      },
      finish() {
        if (finished) return ''
        finished = true
        const res = collector.result()
        return emitChunk([], stopToGeminiFinish(res.stopReason), toGoogleUsageMetadata(res.usage))
      },
      result: () => collector.result(),
    }
  }

  if (protocol === 'openai-chat') {
    const id = `chatcmpl_${randomHex(12)}`
    const created = Math.floor(Date.now() / 1000)
    let sentRole = false
    let toolIndex = 0
    const chunk = (delta, finishReason = null, extra = {}) =>
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: resolvedModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...extra,
      })}\n\n`
    return {
      push(event) {
        if (finished || !event) return ''
        collector.push(event)
        if (event.kind === 'start') {
          started = true
          if (event.model) resolvedModel = event.model
          return ''
        }
        if (event.kind === 'model') {
          if (event.model) resolvedModel = event.model
          return ''
        }
        if (event.kind === 'thinking') {
          const delta = sentRole
            ? { reasoning_content: event.text }
            : { role: 'assistant', reasoning_content: event.text }
          sentRole = true
          return chunk(delta)
        }
        if (event.kind === 'text') {
          const delta = sentRole ? { content: event.text } : { role: 'assistant', content: event.text }
          sentRole = true
          return chunk(delta)
        }
        if (event.kind === 'image' && event.data) {
          const md = `${markdownImageFor(event.mediaType, event.data)}\n`
          const delta = sentRole ? { content: md } : { role: 'assistant', content: md }
          sentRole = true
          return chunk(delta)
        }
        if (event.kind === 'tool_call') {
          if (legacyFunctions) {
            const fc = { name: event.name, arguments: JSON.stringify(event.args || {}) }
            const delta = sentRole ? { function_call: fc } : { role: 'assistant', function_call: fc }
            sentRole = true
            return chunk(delta)
          }
          const idx = toolIndex++
          const tc =
            event.toolKind === 'custom_chat'
              ? {
                  index: idx,
                  id: event.signedId || event.id,
                  type: 'custom',
                  custom: { name: event.name, input: unwrapCustomInput(event.args) },
                  ...(event.signature ? { extra_content: { google: { thought_signature: event.signature } } } : {}),
                }
              : {
                  index: idx,
                  id: event.signedId || event.id,
                  type: 'function',
                  function: { name: event.name, arguments: JSON.stringify(event.args || {}) },
                  ...(event.signature ? { extra_content: { google: { thought_signature: event.signature } } } : {}),
                }
          const delta = sentRole ? { tool_calls: [tc] } : { role: 'assistant', tool_calls: [tc] }
          sentRole = true
          return chunk(delta)
        }
        if (event.kind === 'error') {
          finished = true
          return formatGeminiProtocolStreamError('openai-chat', event.status || 502, event.code, event.message)
        }
        return ''
      },
      finish() {
        if (finished) return ''
        finished = true
        const res = collector.result()
        let out = ''
        if (!sentRole) out += chunk({ role: 'assistant', content: '' })
        out += chunk({}, stopToOpenAIFinish(res.stopReason, { legacyFunctions }), {
          usage: toOpenAIChatUsage(res.usage),
        })
        out += 'data: [DONE]\n\n'
        return out
      },
      result: () => collector.result(),
    }
  }

  if (protocol === 'anthropic') {
    const msgId = `msg_${randomHex(12)}`
    let blockIndex = 0
    let openBlock = null // { index, type: 'thinking' | 'text' }
    const sse = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
    const ensureStart = (initialUsage) => {
      if (started) return ''
      started = true
      return sse('message_start', {
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model: resolvedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: toAnthropicUsage(initialUsage || {}),
        },
      })
    }
    const closeOpen = () => {
      if (!openBlock) return ''
      const out = sse('content_block_stop', { index: openBlock.index })
      openBlock = null
      return out
    }
    return {
      push(event) {
        if (finished || !event) return ''
        collector.push(event)
        if (event.kind === 'start') {
          if (event.model) resolvedModel = event.model
          return ensureStart(event.usage)
        }
        if (event.kind === 'model') {
          if (event.model) resolvedModel = event.model
          return ''
        }
        if (event.kind === 'thinking') {
          let out = ensureStart()
          if (openBlock?.type !== 'thinking' || openBlock.signed) {
            out += closeOpen()
            const index = blockIndex++
            openBlock = { index, type: 'thinking', signed: false }
            out += sse('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } })
          }
          out += sse('content_block_delta', {
            index: openBlock.index,
            delta: { type: 'thinking_delta', thinking: event.text },
          })
          return out
        }
        if (event.kind === 'thinking_signature') {
          let out = ensureStart()
          if (openBlock?.type !== 'thinking' || openBlock.signed) {
            out += closeOpen()
            const index = blockIndex++
            openBlock = { index, type: 'thinking', signed: false }
            out += sse('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } })
          }
          openBlock.signed = true
          out += sse('content_block_delta', {
            index: openBlock.index,
            delta: { type: 'signature_delta', signature: event.signature },
          })
          return out
        }
        if (event.kind === 'text') {
          let out = ensureStart()
          if (openBlock?.type !== 'text') {
            out += closeOpen()
            const index = blockIndex++
            openBlock = { index, type: 'text' }
            out += sse('content_block_start', { index, content_block: { type: 'text', text: '' } })
          }
          out += sse('content_block_delta', { index: openBlock.index, delta: { type: 'text_delta', text: event.text } })
          return out
        }
        if (event.kind === 'image' && event.data) {
          let out = ensureStart() + closeOpen()
          const index = blockIndex++
          out += sse('content_block_start', { index, content_block: { type: 'text', text: '' } })
          out += sse('content_block_delta', {
            index,
            delta: { type: 'text_delta', text: markdownImageFor(event.mediaType, event.data) },
          })
          out += sse('content_block_stop', { index })
          return out
        }
        if (event.kind === 'tool_call') {
          let out = ensureStart() + closeOpen()
          const index = blockIndex++
          out += sse('content_block_start', {
            index,
            content_block: { type: 'tool_use', id: event.signedId || event.id, name: event.name, input: {} },
          })
          out += sse('content_block_delta', {
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(event.args || {}) },
          })
          out += sse('content_block_stop', { index })
          return out
        }
        if (event.kind === 'error') {
          finished = true
          return formatGeminiProtocolStreamError('anthropic', event.status || 502, event.code, event.message)
        }
        return ''
      },
      finish() {
        if (finished) return ''
        finished = true
        const res = collector.result()
        let out = ensureStart(res.usage) + closeOpen()
        out += sse('message_delta', {
          delta: { stop_reason: stopToAnthropicReason(res.stopReason), stop_sequence: res.stopSequence ?? null },
          usage: toAnthropicUsage(res.usage || {}),
        })
        out += sse('message_stop', {})
        return out
      },
      result: () => collector.result(),
    }
  }

  // OpenAI Responses streaming encoder
  const respId = `resp_${randomHex(12)}`
  const includeEnc = Boolean(restoreContext?.includeEncryptedReasoning)
  let outputIndex = 0
  let openReasoning = null // { index, id, text, signature }
  let openText = null // { index, id, text }
  const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const ensureStart = () => {
    if (started) return ''
    started = true
    const base = { id: respId, object: 'response', status: 'in_progress', model: resolvedModel, output: [] }
    return sse('response.created', { response: base }) + sse('response.in_progress', { response: base })
  }
  const closeReasoning = () => {
    if (!openReasoning) return ''
    const { index, id, text, signature } = openReasoning
    openReasoning = null
    const part = { type: 'summary_text', text }
    const item = {
      id,
      type: 'reasoning',
      status: 'completed',
      summary: text ? [part] : [],
      ...(includeEnc && signature ? { encrypted_content: signature } : {}),
    }
    return (
      (text
        ? sse('response.reasoning_summary_text.done', { item_id: id, output_index: index, summary_index: 0, text }) +
          sse('response.reasoning_summary_part.done', { item_id: id, output_index: index, summary_index: 0, part })
        : '') + sse('response.output_item.done', { output_index: index, item })
    )
  }
  const closeText = () => {
    if (!openText) return ''
    const { index, id, text } = openText
    openText = null
    const part = { type: 'output_text', text, annotations: [] }
    const item = { id, type: 'message', role: 'assistant', status: 'completed', content: [part] }
    return (
      sse('response.output_text.done', { item_id: id, output_index: index, content_index: 0, text }) +
      sse('response.content_part.done', { item_id: id, output_index: index, content_index: 0, part }) +
      sse('response.output_item.done', { output_index: index, item })
    )
  }

  return {
    push(event) {
      if (finished || !event) return ''
      collector.push(event)
      if (event.kind === 'start') {
        if (event.model) resolvedModel = event.model
        return ensureStart()
      }
      if (event.kind === 'model') {
        if (event.model) resolvedModel = event.model
        return ''
      }
      if (event.kind === 'thinking_signature') {
        if (openReasoning) {
          openReasoning.signature = event.signature
        } else if (includeEnc && event.signature) {
          let out = ensureStart() + closeText()
          const index = outputIndex++
          const id = `rs_${randomHex(10)}`
          openReasoning = { index, id, text: '', signature: event.signature }
          out += sse('response.output_item.added', {
            output_index: index,
            item: { id, type: 'reasoning', status: 'in_progress', summary: [] },
          })
          return out
        }
        return ''
      }
      if (event.kind === 'thinking') {
        let out = ensureStart() + closeText()
        if (!openReasoning) {
          const index = outputIndex++
          const id = `rs_${randomHex(10)}`
          openReasoning = { index, id, text: '', signature: '' }
          out += sse('response.output_item.added', {
            output_index: index,
            item: { id, type: 'reasoning', status: 'in_progress', summary: [] },
          })
          out += sse('response.reasoning_summary_part.added', {
            item_id: id,
            output_index: index,
            summary_index: 0,
            part: { type: 'summary_text', text: '' },
          })
        }
        openReasoning.text += event.text
        out += sse('response.reasoning_summary_text.delta', {
          item_id: openReasoning.id,
          output_index: openReasoning.index,
          summary_index: 0,
          delta: event.text,
        })
        return out
      }
      if (event.kind === 'text') {
        let out = ensureStart() + closeReasoning()
        if (!openText) {
          const index = outputIndex++
          const id = `msg_${randomHex(10)}`
          openText = { index, id, text: '' }
          out += sse('response.output_item.added', {
            output_index: index,
            item: { id, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
          })
          out += sse('response.content_part.added', {
            item_id: id,
            output_index: index,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          })
        }
        openText.text += event.text
        out += sse('response.output_text.delta', {
          item_id: openText.id,
          output_index: openText.index,
          content_index: 0,
          delta: event.text,
        })
        return out
      }
      if (event.kind === 'image' && event.data) {
        let out = ensureStart() + closeReasoning() + closeText()
        const index = outputIndex++
        const item = {
          id: `ig_${randomHex(8)}_${index}`,
          type: 'image_generation_call',
          status: 'completed',
          result: event.data,
        }
        out += sse('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress' } })
        out += sse('response.output_item.done', { output_index: index, item })
        return out
      }
      if (event.kind === 'tool_call') {
        let out = ensureStart() + closeReasoning() + closeText()
        const index = outputIndex++
        const item = responsesItemFromToolCall(event)
        if (item.type === 'function_call') {
          out += sse('response.output_item.added', {
            output_index: index,
            item: { ...item, status: 'in_progress', arguments: '' },
          })
          out += sse('response.function_call_arguments.delta', {
            item_id: item.id,
            output_index: index,
            delta: item.arguments,
          })
          out += sse('response.function_call_arguments.done', {
            item_id: item.id,
            output_index: index,
            name: item.name,
            arguments: item.arguments,
          })
          out += sse('response.output_item.done', { output_index: index, item })
        } else if (item.type === 'custom_tool_call') {
          out += sse('response.output_item.added', {
            output_index: index,
            item: { ...item, status: 'in_progress', input: '' },
          })
          out += sse('response.custom_tool_call_input.delta', {
            item_id: item.id,
            output_index: index,
            delta: item.input,
          })
          out += sse('response.custom_tool_call_input.done', {
            item_id: item.id,
            output_index: index,
            input: item.input,
          })
          out += sse('response.output_item.done', { output_index: index, item })
        } else {
          out += sse('response.output_item.added', {
            output_index: index,
            item: { ...item, status: 'in_progress' },
          })
          out += sse('response.output_item.done', { output_index: index, item })
        }
        return out
      }
      if (event.kind === 'error') {
        finished = true
        return formatGeminiProtocolStreamError('openai-responses', event.status || 502, event.code, event.message)
      }
      return ''
    },
    finish() {
      if (finished) return ''
      finished = true
      const res = collector.result()
      let out = ensureStart() + closeReasoning() + closeText()
      const finalResp = {
        ...renderGeminiProtocolResponse('openai-responses', res, { model: resolvedModel, restoreContext }),
        id: respId,
      }
      const eventName = finalResp.status === 'incomplete' ? 'response.incomplete' : 'response.completed'
      out += sse(eventName, { response: finalResp })
      return out
    },
    result: () => collector.result(),
  }
}

/** Convenience helper: split incremental raw bytes into complete SSE frames. */
export function createSseFrameSplitter(onFrame) {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  const drain = () => {
    while (true) {
      const lf = buffer.indexOf('\n\n')
      const crlf = buffer.indexOf('\r\n\r\n')
      let boundary = -1
      let width = 0
      if (crlf >= 0 && (lf < 0 || crlf < lf)) {
        boundary = crlf
        width = 4
      } else if (lf >= 0) {
        boundary = lf
        width = 2
      } else {
        break
      }
      const frame = buffer.slice(0, boundary + width)
      buffer = buffer.slice(boundary + width)
      onFrame(frame)
    }
  }
  return {
    push(chunk) {
      if (typeof chunk === 'string') {
        buffer += chunk
      } else if (chunk != null) {
        const bytes = ArrayBuffer.isView(chunk)
          ? chunk
          : chunk instanceof ArrayBuffer
            ? new Uint8Array(chunk)
            : Buffer.from(chunk)
        buffer += decoder.decode(bytes, { stream: true })
      }
      drain()
    },
    flush() {
      buffer += decoder.decode()
      drain()
      const rem = buffer.trim()
      buffer = ''
      if (rem) onFrame(`${rem}\n\n`)
    },
  }
}
