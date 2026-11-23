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
import { isClientStream } from './convert.mjs'
import { buildAnthropicSseError } from './stream-truncation.mjs'

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
export const NATIVE_TUI_CAPABILITIES = Object.freeze(['streaming', 'native_tui'])

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/
const SIG_MARK = '__ts'
const SIG_RAW = 'r'
const SIG_END = '__'
const NAME_LEAD = '_x_'
const GEMINI_NS = 'default_api'
const INTERRUPTED_TOOL_NOTE = '[The result of this tool call is unavailable: the turn was interrupted.]'
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
const GOOGLE_TOOL_NAMES = new Set([
  'urlContext',
  'codeExecution',
  'googleMaps',
  'fileSearch',
  'enterpriseWebSearch',
  'computerUse',
  'retrieval',
])

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
  if (Array.isArray(value)) return value.map(geminiCamelCase)
  if (!isPlainObject(value)) return value
  const out = {}
  const originalKeys = new Set(Object.keys(value))
  for (const [key, raw] of Object.entries(value)) {
    const camel = snakeToCamel(key)
    const nextVal = GEMINI_OWN_KEYS.has(camel) ? raw : geminiCamelCase(raw)
    if (camel === key) {
      out[camel] = nextVal
    } else if (!originalKeys.has(camel)) {
      out[camel] = nextVal
    }
  }
  return out
}

export function geminiFuncName(name) {
  const s = String(name || '')
  if (s && /^[0-9\-.:]/.test(s)) return `${NAME_LEAD}${s}`
  return s
}

export function geminiToolNameFromCall(name) {
  let s = String(name || '')
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
    const afterDigits = rest.slice(digits)
    if (!afterDigits.startsWith(SIG_END)) continue
    const encoded = afterDigits.slice(SIG_END.length)
    if (digits > 0 && rest.slice(0, digits) !== String(encoded.length)) {
      return { id, signature: '' }
    }
    if (!encoded) return { id, signature: '' }
    try {
      const buf = Buffer.from(encoded, 'base64url')
      if (!buf.length) return { id, signature: '' }
      const signature = raw ? buf.toString('utf8') : buf.toString('base64')
      return { id: id.slice(0, rel), signature }
    } catch {
      return { id, signature: '' }
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

function stripAnthropicBillingLines(text) {
  if (!text) return ''
  return text
    .split('\n')
    .filter((line) => !line.trimStart().toLowerCase().startsWith('x-anthropic-billing-header:'))
    .join('\n')
    .trim()
}

function geminiGeneration(model) {
  const match = /(?:^|\/)gemini-(\d+)/i.exec(String(model || ''))
  return match ? Number.parseInt(match[1], 10) : 0
}

function normalizeEffort(raw) {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
  if (!value) return ''
  if (['none', 'off', 'disabled', '0'].includes(value)) return 'none'
  if (['minimal', 'min'].includes(value)) return 'minimal'
  if (value === 'low') return 'low'
  if (value === 'medium' || value === 'med') return 'medium'
  if (value === 'high') return 'high'
  if (value === 'xhigh' || value === 'max') return 'high'
  return ''
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
    return isPlainObject(shaped) ? shaped : { type: 'object', properties: {} }
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
  const schemaTypeOf = (node) => {
    if (typeof node.type === 'string') return node.type.toLowerCase()
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
        out[k] = v
      } else if ((k === 'exclusiveMinimum' || k === 'exclusiveMaximum') && typeof v === 'number') {
        const bound = k === 'exclusiveMinimum' ? 'minimum' : 'maximum'
        if (value[bound] === undefined) out[bound] = v
      } else if (k === 'type') {
        if (Array.isArray(v)) {
          for (const t of v) {
            const lower = typeof t === 'string' ? t.toLowerCase() : t
            if (lower === 'null') out.nullable = true
            else if (out.type === undefined) out.type = lower
          }
          for (const t of v) {
            const lower = typeof t === 'string' ? t.toLowerCase() : t
            if ((lower === 'array' && value.items != null) || (lower === 'object' && value.properties != null)) {
              out.type = lower
              break
            }
          }
        } else if (typeof v === 'string') {
          out.type = v.toLowerCase()
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
      const keep = out.required.filter((n) => typeof n === 'string' && Object.hasOwn(props, n))
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
  return { mimeType, data: Buffer.from(decodeURIComponent(raw), 'utf8').toString('base64') }
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
  const model = routeModel || (typeof body.model === 'string' ? body.model : '')
  if (!MODEL_RE.test(model) || (body.model != null && body.model !== model)) {
    throw makeProtocolError(400, 'gemini_invalid_model', 'A valid Gemini model is required.')
  }
  if (!Array.isArray(body.contents) || body.contents.length === 0) {
    throw makeProtocolError(400, 'gemini_invalid_request', 'Gemini contents must be a non-empty array.')
  }
  const stream = typeof routeStream === 'boolean' ? routeStream : body.stream === true
  const system = extractGeminiSystemText(body.systemInstruction)
  const messages = []
  const lastByName = new Map()
  const openByName = new Map()

  for (const content of body.contents) {
    if (!isPlainObject(content) || !Array.isArray(content.parts)) {
      throw makeProtocolError(400, 'gemini_invalid_request', 'Each Gemini content entry must have a parts array.')
    }
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
        const mimeType = typeof part.inlineData.mimeType === 'string' ? part.inlineData.mimeType : ''
        const data = typeof part.inlineData.data === 'string' ? part.inlineData.data : ''
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
          if (!isPlainObject(decl) || typeof decl.name !== 'string' || !decl.name) {
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
    } else {
      toolChoice = 'auto'
    }
  }

  const gc = isPlainObject(body.generationConfig) ? body.generationConfig : null
  const generationConfig = {}
  const extraGenConfig = {}
  let thinking = null
  let responseFormat = null
  if (gc) {
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
      const effort = tc.thinkingLevel
        ? normalizeEffort(tc.thinkingLevel)
        : typeof tc.thinkingBudget === 'number'
          ? effortFromBudget(tc.thinkingBudget)
          : ''
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
    }
    if (isPlainObject(gc.imageConfig)) {
      generationConfig.imageConfig = gc.imageConfig
    }
    for (const [k, v] of Object.entries(gc)) {
      if (!GEN_READ_OR_BUILT.has(k) && v != null) extraGenConfig[k] = v
    }
  }

  return {
    model,
    stream,
    system,
    messages,
    tools,
    toolChoice,
    webSearch,
    googleTools,
    generationConfig,
    extraGenConfig,
    thinking,
    responseFormat,
    safetySettings: Array.isArray(body.safetySettings) ? body.safetySettings : null,
    cachedContent: typeof body.cachedContent === 'string' ? body.cachedContent : null,
  }
}

function parseOpenAIChatInbound(body, { headers }) {
  const model = typeof body.model === 'string' ? body.model : ''
  if (!MODEL_RE.test(model)) throw makeProtocolError(400, 'gemini_invalid_model', 'A valid Gemini model is required.')
  if (body.stream != null && typeof body.stream !== 'boolean') {
    throw makeProtocolError(400, 'gemini_invalid_request', 'stream must be a boolean.')
  }
  if (body.n != null && body.n !== 1) {
    throw makeProtocolError(400, 'gemini_invalid_request', 'n > 1 is not supported.')
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw makeProtocolError(400, 'gemini_invalid_request', 'messages must be a non-empty array.')
  }
  const stream = isClientStream(body, headers)
  const systemParts = []
  const messages = []

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
      } else if (part.type === 'image_url' || part.type === 'input_image') {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url || part.url
        const media = mediaPartFromUrl(url, 'image/png')
        if (!media) throw makeProtocolError(400, 'gemini_invalid_request', 'image_url must include a valid URL.')
        out.push(media)
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
      if (text) systemParts.push(text)
    } else if (raw.role === 'user') {
      const parts = extractParts(raw.content)
      if (parts.length) messages.push({ role: 'user', parts })
    } else if (raw.role === 'assistant') {
      const parts = extractParts(raw.content)
      if (Array.isArray(raw.tool_calls)) {
        for (const call of raw.tool_calls) {
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
      const { id } = unsignedToolCallId(raw.tool_call_id || raw.id || newCallId())
      const contentParts = extractParts(raw.content)
      const text = contentParts
        .filter((p) => p.kind === 'text')
        .map((p) => p.text)
        .join('\n')
      const images = contentParts.filter((p) => p.kind === 'image')
      messages.push({
        role: 'user',
        parts: [
          {
            kind: 'tool_result',
            callId: id,
            name: typeof raw.name === 'string' ? raw.name : '',
            text,
            isError: raw.is_error === true || raw.isError === true,
            images,
          },
        ],
      })
    } else {
      throw makeProtocolError(400, 'gemini_invalid_request', `Unsupported message role: ${raw.role}`)
    }
  }

  let webSearch = false
  const googleTools = []
  const tools = []
  const rawTools = Array.isArray(body.tools) ? body.tools : Array.isArray(body.functions) ? body.functions : []
  for (const tool of rawTools) {
    if (!isPlainObject(tool)) throw makeProtocolError(400, 'gemini_invalid_request', 'Each tool must be an object.')
    if (tool.type === 'function' && isPlainObject(tool.function)) {
      if (!tool.function.name) throw makeProtocolError(400, 'gemini_invalid_request', 'tool.function.name is required.')
      tools.push({
        name: String(tool.function.name),
        description: typeof tool.function.description === 'string' ? tool.function.description : '',
        schema: tool.function.parameters || { type: 'object', properties: {} },
      })
    } else if (tool.name && !tool.type) {
      tools.push({
        name: String(tool.name),
        description: typeof tool.description === 'string' ? tool.description : '',
        schema: tool.parameters || tool.input_schema || { type: 'object', properties: {} },
      })
    } else if (typeof tool.type === 'string' && tool.type.startsWith('web_search')) {
      webSearch = true
    } else {
      for (const [k, v] of Object.entries(tool)) {
        const camel = snakeToCamel(k)
        if (GOOGLE_SEARCH_TOOLS.has(camel)) webSearch = true
        else if (GOOGLE_TOOL_NAMES.has(camel)) googleTools.push({ [camel]: v ?? {} })
      }
    }
  }

  let toolChoice = ''
  const tc = body.tool_choice ?? body.function_call
  if (typeof tc === 'string') {
    const lower = tc.toLowerCase()
    if (['none', 'auto', 'required'].includes(lower)) toolChoice = lower
  } else if (isPlainObject(tc)) {
    const name = tc.function?.name || tc.name
    if (name) toolChoice = `name:${name}`
    else if (tc.type === 'none' || tc.type === 'auto') toolChoice = tc.type
    else if (tc.type === 'required' || tc.type === 'any') toolChoice = 'required'
  }

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
  const effort = normalizeEffort(body.reasoning_effort ?? body.reasoning?.effort)
  if (effort) {
    thinking = {
      enabled: effort !== 'none',
      disabled: effort === 'none',
      effort: effort !== 'none' ? effort : '',
      includeThoughts: true,
    }
  } else if (isPlainObject(body.thinking)) {
    const type = String(body.thinking.type || '').toLowerCase()
    const budget = Number(body.thinking.budget_tokens ?? body.thinking.budgetTokens)
    thinking = {
      enabled: type === 'enabled' || type === 'adaptive',
      disabled: type === 'disabled',
      effort: Number.isFinite(budget) && budget > 0 ? effortFromBudget(budget) : type === 'adaptive' ? 'medium' : '',
      budgetTokens: Number.isFinite(budget) ? budget : undefined,
      includeThoughts: true,
    }
  }

  let responseFormat = null
  if (isPlainObject(body.response_format)) {
    if (body.response_format.type === 'json_object') responseFormat = { type: 'json_object' }
    else if (body.response_format.type === 'json_schema') {
      const spec = isPlainObject(body.response_format.json_schema)
        ? body.response_format.json_schema
        : body.response_format
      responseFormat = { type: 'json_schema', schema: spec.schema || { type: 'object' } }
    }
  }

  return {
    model,
    stream,
    system: systemParts.join('\n\n'),
    messages,
    tools,
    toolChoice,
    webSearch,
    googleTools,
    generationConfig,
    extraGenConfig: {},
    thinking,
    responseFormat,
    safetySettings: null,
    cachedContent: null,
  }
}

function parseOpenAIResponsesInbound(body, { headers }) {
  const model = typeof body.model === 'string' ? body.model : ''
  if (!MODEL_RE.test(model)) throw makeProtocolError(400, 'gemini_invalid_model', 'A valid Gemini model is required.')
  if (body.stream != null && typeof body.stream !== 'boolean') {
    throw makeProtocolError(400, 'gemini_invalid_request', 'stream must be a boolean.')
  }
  const stream = isClientStream(body, headers)
  const systemParts = []
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    systemParts.push(body.instructions)
  }
  const messages = []

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

  if (typeof body.input === 'string') {
    if (!body.input.trim()) throw makeProtocolError(400, 'gemini_invalid_request', 'input must not be empty.')
    messages.push({ role: 'user', parts: [{ kind: 'text', text: body.input, signature: '' }] })
  } else if (Array.isArray(body.input) && body.input.length) {
    for (const item of body.input) {
      if (!isPlainObject(item))
        throw makeProtocolError(400, 'gemini_invalid_request', 'Each input item must be an object.')
      if (item.type === 'function_call') {
        if (typeof item.name !== 'string' || !item.name) {
          throw makeProtocolError(400, 'gemini_invalid_request', 'function_call.name is required.')
        }
        const { id, signature } = unsignedToolCallId(item.call_id || item.id || newCallId())
        messages.push({
          role: 'assistant',
          parts: [{ kind: 'tool_call', id, name: item.name, args: parseJsonObjectArgs(item.arguments), signature }],
        })
      } else if (item.type === 'function_call_output') {
        const { id } = unsignedToolCallId(item.call_id || item.id || newCallId())
        const out =
          typeof item.output === 'string'
            ? item.output
            : Array.isArray(item.output)
              ? extractItemParts(item.output)
                  .filter((p) => p.kind === 'text')
                  .map((p) => p.text)
                  .join('\n')
              : JSON.stringify(item.output ?? '')
        const images = Array.isArray(item.output) ? extractItemParts(item.output).filter((p) => p.kind === 'image') : []
        messages.push({
          role: 'user',
          parts: [{ kind: 'tool_result', callId: id, name: item.name || '', text: out, isError: false, images }],
        })
      } else if (item.type === 'reasoning') {
        // Ignore replayed reasoning blocks; Gemini rejects foreign thought blocks.
      } else {
        if (item.type != null && item.type !== 'message') {
          throw makeProtocolError(
            400,
            'gemini_invalid_request',
            `Unsupported Responses input item: ${String(item.type)}`,
          )
        }
        const role = item.role || 'user'
        const parts = extractItemParts(item.content)
        if (role === 'system' || role === 'developer') {
          const text = parts
            .filter((p) => p.kind === 'text')
            .map((p) => p.text)
            .join('\n')
          if (text) systemParts.push(text)
        } else if (role === 'user' || role === 'assistant') {
          if (parts.length) messages.push({ role, parts })
        } else {
          throw makeProtocolError(400, 'gemini_invalid_request', `Unsupported Responses role: ${String(role)}`)
        }
      }
    }
  } else {
    throw makeProtocolError(400, 'gemini_invalid_request', 'input must be a string or non-empty array.')
  }

  let webSearch = false
  const tools = []
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!isPlainObject(tool)) throw makeProtocolError(400, 'gemini_invalid_request', 'Each tool must be an object.')
      if (typeof tool.type === 'string' && tool.type.startsWith('web_search')) {
        webSearch = true
        continue
      }
      const fn = tool.type === 'function' && isPlainObject(tool.function) ? tool.function : tool
      if (typeof fn.name === 'string' && fn.name) {
        tools.push({
          name: fn.name,
          description: typeof fn.description === 'string' ? fn.description : '',
          schema: fn.parameters || fn.input_schema || { type: 'object', properties: {} },
        })
      }
    }
  }

  let toolChoice = ''
  if (typeof body.tool_choice === 'string') {
    const lower = body.tool_choice.toLowerCase()
    if (['none', 'auto', 'required'].includes(lower)) toolChoice = lower
  } else if (isPlainObject(body.tool_choice)) {
    const name = body.tool_choice.name || body.tool_choice.function?.name
    if (name) toolChoice = `name:${name}`
    else if (['none', 'auto', 'required'].includes(body.tool_choice.type)) toolChoice = body.tool_choice.type
  }

  const generationConfig = {}
  if (Number.isInteger(body.max_output_tokens) && body.max_output_tokens > 0) {
    generationConfig.maxOutputTokens = body.max_output_tokens
  }
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    generationConfig.temperature = body.temperature
  }
  if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) generationConfig.topP = body.top_p

  let thinking = null
  const effort = normalizeEffort(body.reasoning?.effort ?? body.reasoning_effort)
  if (effort) {
    thinking = {
      enabled: effort !== 'none',
      disabled: effort === 'none',
      effort: effort !== 'none' ? effort : '',
      includeThoughts: true,
    }
  }

  let responseFormat = null
  const fmt = body.text?.format
  if (isPlainObject(fmt)) {
    if (fmt.type === 'json_object') responseFormat = { type: 'json_object' }
    else if (fmt.type === 'json_schema') {
      responseFormat = { type: 'json_schema', schema: fmt.schema || { type: 'object' } }
    }
  }

  return {
    model,
    stream,
    system: systemParts.join('\n\n'),
    messages,
    tools,
    toolChoice,
    webSearch,
    googleTools: [],
    generationConfig,
    extraGenConfig: {},
    thinking,
    responseFormat,
    safetySettings: null,
    cachedContent: null,
  }
}

function parseAnthropicInbound(body, { headers }) {
  const model = typeof body.model === 'string' ? body.model : ''
  if (!MODEL_RE.test(model)) throw makeProtocolError(400, 'gemini_invalid_model', 'A valid Gemini model is required.')
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

  for (const raw of body.messages) {
    if (!isPlainObject(raw) || !['user', 'assistant'].includes(raw.role)) {
      throw makeProtocolError(400, 'gemini_invalid_request', 'Anthropic message role must be user or assistant.')
    }
    const parts = []
    if (typeof raw.content === 'string') {
      if (raw.content) parts.push({ kind: 'text', text: raw.content, signature: '' })
    } else if (Array.isArray(raw.content)) {
      for (const block of raw.content) {
        if (!isPlainObject(block))
          throw makeProtocolError(400, 'gemini_invalid_request', 'Content block must be an object.')
        if (block.type === 'text') {
          if (typeof block.text !== 'string') {
            throw makeProtocolError(400, 'gemini_invalid_request', 'text block requires string text.')
          }
          parts.push({ kind: 'text', text: block.text, signature: '' })
        } else if (block.type === 'image') {
          const media = parseAnthropicSource(block.source, 'image/png')
          if (!media) throw makeProtocolError(400, 'gemini_invalid_request', 'Invalid Anthropic image source.')
          parts.push(media)
        } else if (block.type === 'document') {
          const media = parseAnthropicSource(block.source, 'application/pdf')
          if (!media) throw makeProtocolError(400, 'gemini_invalid_request', 'Invalid Anthropic document source.')
          parts.push(media)
        } else if (block.type === 'tool_use') {
          if (typeof block.name !== 'string' || !block.name) {
            throw makeProtocolError(400, 'gemini_invalid_request', 'tool_use.name is required.')
          }
          const { id, signature } = unsignedToolCallId(block.id || newCallId())
          parts.push({ kind: 'tool_call', id, name: block.name, args: parseJsonObjectArgs(block.input), signature })
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
              else if (isPlainObject(sub) && (sub.type === 'image' || sub.type === 'document')) {
                const media = parseAnthropicSource(sub.source, sub.type === 'image' ? 'image/png' : 'application/pdf')
                if (media) {
                  if (media.kind === 'image') images.push(media)
                  else extraFiles.push(media)
                }
              }
            }
            text = chunks.join('\n')
          }
          parts.push({ kind: 'tool_result', callId: id, name: '', text, isError: block.is_error === true, images })
          for (const f of extraFiles) parts.push(f)
        } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          // Do not send foreign thinking back to Gemini.
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

  let webSearch = false
  const tools = []
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!isPlainObject(tool)) throw makeProtocolError(400, 'gemini_invalid_request', 'Each tool must be an object.')
      if (typeof tool.type === 'string' && tool.type.startsWith('web_search')) {
        webSearch = true
        continue
      }
      if (typeof tool.name === 'string' && tool.name) {
        tools.push({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          schema: tool.input_schema || tool.parameters || { type: 'object', properties: {} },
        })
      }
    }
  }

  let toolChoice = ''
  if (isPlainObject(body.tool_choice)) {
    const type = String(body.tool_choice.type || '').toLowerCase()
    if (type === 'none' || type === 'auto') toolChoice = type
    else if (type === 'any') toolChoice = 'required'
    else if (type === 'tool' && body.tool_choice.name) toolChoice = `name:${body.tool_choice.name}`
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
  const effort = normalizeEffort(body.output_config?.effort)
  if (isPlainObject(body.thinking)) {
    const type = String(body.thinking.type || '').toLowerCase()
    const budget = Number(body.thinking.budget_tokens)
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
      includeThoughts: true,
    }
  } else if (effort) {
    thinking = {
      enabled: effort !== 'none',
      disabled: effort === 'none',
      effort: effort !== 'none' ? effort : '',
      includeThoughts: true,
    }
  }

  let responseFormat = null
  const outFmt = body.output_config?.format
  if (isPlainObject(outFmt)) {
    if (outFmt.type === 'json_schema' && isPlainObject(outFmt.schema)) {
      responseFormat = { type: 'json_schema', schema: outFmt.schema }
    } else if (outFmt.type === 'json_object') {
      responseFormat = { type: 'json_object' }
    }
  }

  return {
    model,
    stream,
    system,
    messages,
    tools,
    toolChoice,
    webSearch,
    googleTools: [],
    generationConfig,
    extraGenConfig: {},
    thinking,
    responseFormat,
    safetySettings: null,
    cachedContent: null,
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
    model,
    stream: body.stream === true,
    system: '',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: body.input, signature: '' }] }],
    tools: [],
    toolChoice: '',
    webSearch: false,
    googleTools: [],
    generationConfig: {},
    extraGenConfig: {},
    thinking: null,
    responseFormat: null,
    safetySettings: null,
    cachedContent: null,
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
 */
export function classifyGeminiCapabilities(ir) {
  const required = new Set()
  if (ir.system && ir.system.trim()) required.add('system_instruction')
  if (ir.messages.length !== 1 || ir.messages[0]?.role !== 'user') required.add('multi_turn')
  if (ir.tools.length > 0 || ir.webSearch || ir.googleTools.length > 0 || ir.toolChoice) required.add('tools')
  if (
    Object.keys(ir.generationConfig || {}).length > 0 ||
    Object.keys(ir.extraGenConfig || {}).length > 0 ||
    ir.thinking != null ||
    ir.responseFormat != null ||
    ir.safetySettings != null ||
    ir.cachedContent != null
  ) {
    required.add('generation_config')
  }
  let plainText = ''
  if (ir.messages.length === 1 && ir.messages[0].role === 'user') {
    const pieces = []
    for (const part of ir.messages[0].parts) {
      if (part.kind === 'text' && !part.signature) {
        pieces.push(part.text)
      } else if (part.kind === 'image' || part.kind === 'file') {
        required.add('multimodal')
      } else if (part.kind === 'tool_call' || part.kind === 'tool_result') {
        required.add('tools')
      } else {
        required.add('thinking')
      }
    }
    plainText = pieces.join('')
  }
  if (required.size === 0 && !isValidNativeTuiText(plainText)) {
    required.add('full_gemini_api')
  }
  return {
    requiredCapabilities: [...required],
    nativeTuiCompatible: required.size === 0,
    plainText: required.size === 0 ? plainText : null,
  }
}

/**
 * Parse an inbound request from any supported protocol into canonical Gemini IR + capability profile.
 */
export function parseInboundToGemini(protocol, body, { routeModel = null, routeStream, headers = {} } = {}) {
  if (!isPlainObject(body)) {
    throw makeProtocolError(400, 'gemini_invalid_request', 'Request body must be a JSON object.')
  }
  let ir
  if (protocol === 'gemini') ir = parseGeminiNativeInbound(body, { routeModel, routeStream })
  else if (protocol === 'openai-chat') ir = parseOpenAIChatInbound(body, { headers })
  else if (protocol === 'openai-responses') ir = parseOpenAIResponsesInbound(body, { headers })
  else if (protocol === 'anthropic') ir = parseAnthropicInbound(body, { headers })
  else if (protocol === 'gemini-session') ir = parseGeminiSessionInbound(body)
  else throw makeProtocolError(400, 'gemini_unsupported_protocol', `Unsupported protocol: ${String(protocol)}`)

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

function buildThinkingConfig(ir, model) {
  if (!ir.thinking) return null
  const gen = geminiGeneration(model)
  if (ir.thinking.disabled) {
    if (gen >= 3) return { thinkingLevel: 'low', includeThoughts: false }
    return { thinkingBudget: 0 }
  }
  if (!ir.thinking.enabled && !ir.thinking.effort) return null
  const tc = { includeThoughts: ir.thinking.includeThoughts !== false }
  if (gen >= 3) {
    const effort = ir.thinking.effort || 'medium'
    if (effort === 'minimal') tc.thinkingLevel = /flash/i.test(model) ? 'minimal' : 'low'
    else if (effort === 'low') tc.thinkingLevel = 'low'
    else if (effort === 'medium') tc.thinkingLevel = /flash/i.test(model) || gen > 3 ? 'medium' : 'high'
    else tc.thinkingLevel = 'high'
    return tc
  }
  const budget = ir.thinking.budgetTokens || budgetFromEffort(ir.thinking.effort || 'medium')
  tc.thinkingBudget = budget
  return tc
}

/**
 * Build a canonical Google Gemini `generateContent` request body from IR.
 * `target`: `'gemini'` (Google Gemini API) or `'antigravity'` (Antigravity / Code Assist).
 */
export function buildGeminiRequest(ir, { target = 'gemini', model = ir.model } = {}) {
  const ag = target === 'antigravity'
  const claude = /claude/i.test(model)
  const callNames = new Map()
  const contents = []
  const cleanedMessages = dropDuplicateToolResults(ir.messages)

  for (const msg of cleanedMessages) {
    const role = msg.role === 'assistant' ? 'model' : 'user'
    const parts = []
    const signedTurn = msg.parts.some((p) => p.kind === 'tool_call' && p.signature)
    for (const p of msg.parts) {
      if (p.kind === 'text') {
        if (p.text || (p.signature && !claude)) {
          const part = { text: p.text || '' }
          if (p.signature && !claude) part.thoughtSignature = p.signature
          parts.push(part)
        }
      } else if (p.kind === 'image' || p.kind === 'file') {
        if (p.data) parts.push({ inlineData: { mimeType: p.mediaType, data: p.data } })
        else if (p.url) parts.push({ fileData: { mimeType: p.mediaType, fileUri: p.url } })
      } else if (p.kind === 'tool_call') {
        const safeName = geminiFuncName(p.name)
        if (p.id) callNames.set(p.id, safeName)
        const fnCall = { name: safeName, args: isPlainObject(p.args) ? p.args : {} }
        if (p.id) fnCall.id = ag ? p.id.replace(/[^a-zA-Z0-9_-]/g, '_') : p.id
        const part = { functionCall: fnCall }
        if (claude) part.thoughtSignature = SKIP_THOUGHT_SIGNATURE
        else if (p.signature) part.thoughtSignature = p.signature
        else if (!signedTurn) part.thoughtSignature = SKIP_THOUGHT_SIGNATURE
        parts.push(part)
      } else if (p.kind === 'tool_result') {
        const safeName = geminiFuncName(p.name || callNames.get(p.callId) || 'tool')
        const key = ag ? 'result' : p.isError ? 'error' : 'output'
        const fr = { name: safeName, response: { [key]: p.text || '' } }
        if (p.callId) fr.id = ag ? p.callId.replace(/[^a-zA-Z0-9_-]/g, '_') : p.callId
        parts.push({ functionResponse: fr })
        if (Array.isArray(p.images)) {
          for (const img of p.images) {
            if (img.data) parts.push({ inlineData: { mimeType: img.mediaType, data: img.data } })
            else if (img.url) parts.push({ fileData: { mimeType: img.mediaType, fileUri: img.url } })
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

  const paired = pairFunctionTurns(contents, { responseKey: ag ? 'result' : 'output' })
  if (paired.length && paired[0].role === 'model') {
    paired.unshift({ role: 'user', parts: [{ text: '[Continuing from previous AI thoughts...]' }] })
  }
  if (paired.length && paired[paired.length - 1].role === 'model') {
    paired.push({ role: 'user', parts: [{ text: 'Continue.' }] })
  }

  const req = { contents: paired }
  const cleanedSystem = stripAnthropicBillingLines(ir.system || '')
  if (cleanedSystem) {
    req.systemInstruction = { parts: [{ text: cleanedSystem }] }
  }

  if (ir.tools.length > 0 && ir.toolChoice !== 'none') {
    const decls = ir.tools.map((tool) => {
      const decl = { name: geminiFuncName(tool.name) }
      if (tool.description) decl.description = tool.description
      if (ag) decl.parameters = sanitizeGeminiSchema(tool.schema, { plain: true })
      else decl.parametersJsonSchema = sanitizeGeminiSchema(tool.schema, { plain: false })
      return decl
    })
    req.tools = [{ functionDeclarations: decls }]
    const fc = { mode: 'AUTO' }
    if (ir.toolChoice === 'required') fc.mode = 'ANY'
    else if (ir.toolChoice.startsWith('name:')) {
      fc.mode = 'ANY'
      fc.allowedFunctionNames = [geminiFuncName(ir.toolChoice.slice(5))]
    }
    req.toolConfig = { functionCallingConfig: fc }
  } else if (ir.toolChoice === 'none' && ir.tools.length > 0) {
    req.toolConfig = { functionCallingConfig: { mode: 'NONE' } }
  } else if (ir.webSearch || ir.googleTools.length > 0) {
    const tools = []
    if (ir.webSearch) tools.push({ googleSearch: {} })
    for (const gt of ir.googleTools) tools.push(gt)
    req.tools = tools
  }

  const gen = { ...ir.extraGenConfig, ...ir.generationConfig }
  const tc = buildThinkingConfig(ir, model)
  if (tc) gen.thinkingConfig = tc
  if (ir.responseFormat) {
    gen.responseMimeType = 'application/json'
    if (ir.responseFormat.type === 'json_schema' && ir.responseFormat.schema) {
      gen.responseJsonSchema = sanitizeGeminiSchema(ir.responseFormat.schema, { plain: false })
    }
  }
  if (Object.keys(gen).length) req.generationConfig = gen
  if (ir.safetySettings) req.safetySettings = ir.safetySettings
  if (ir.cachedContent) req.cachedContent = ir.cachedContent
  return req
}

export function normalizeGeminiUsage(metadata) {
  if (!isPlainObject(metadata)) return null
  const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0)
  const prompt = int(metadata.promptTokenCount)
  const cached = Math.min(prompt, int(metadata.cachedContentTokenCount))
  const candidates = int(metadata.candidatesTokenCount)
  const thoughts = int(metadata.thoughtsTokenCount)
  const total = int(metadata.totalTokenCount)
  const output = candidates + thoughts
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

function stopToOpenAIFinish(stop) {
  if (stop === 'tool') return 'tool_calls'
  if (stop === 'length') return 'length'
  if (stop === 'filter') return 'content_filter'
  return 'stop'
}

function stopToAnthropicReason(stop) {
  if (stop === 'tool') return 'tool_use'
  if (stop === 'length') return 'max_tokens'
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
      return {
        kind: 'error',
        status: parsed?.error?.code || parsed?.status || 502,
        code: parsed?.error?.code || parsed?.code || 'gemini_inference_failed',
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
  return { kind: 'chunk', chunk: response }
}

/**
 * Stateful decoder: converts Gemini/CodeAssist response chunks (from SSE or JSON)
 * into normalized IR events for streaming encoders and non-streaming collectors.
 */
export function createGeminiEventDecoder({ fallbackModel = '' } = {}) {
  let started = false
  let sawTool = false
  let stopped = false
  let searched = false
  let latestUsage = null

  function decodeChunk(chunk, emit) {
    if (!isPlainObject(chunk)) return
    const usage = normalizeGeminiUsage(chunk.usageMetadata)
    if (usage) latestUsage = usage
    if (!started) {
      started = true
      emit({
        kind: 'start',
        responseId:
          typeof chunk.responseId === 'string' && chunk.responseId ? chunk.responseId : `resp_${randomHex(10)}`,
        model: typeof chunk.modelVersion === 'string' && chunk.modelVersion ? chunk.modelVersion : fallbackModel,
        usage: latestUsage
          ? { input_tokens: latestUsage.input_tokens, cache_read_tokens: latestUsage.cache_read_tokens }
          : null,
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
    if (stopped && latestUsage) {
      emit({ kind: 'usage', usage: latestUsage })
    }
  }

  return {
    decodeChunk,
    decodeSseFrame(frame, emit) {
      const parsed = parseGeminiSseFrame(frame)
      if (parsed.kind === 'chunk') decodeChunk(parsed.chunk, emit)
      else if (parsed.kind === 'error') {
        emit({ kind: 'error', status: parsed.status, code: parsed.code, message: parsed.message })
      } else if (parsed.kind === 'invalid') {
        emit({ kind: 'error', status: 502, code: 'gemini_inference_invalid_output', message: parsed.message })
      }
      return parsed.kind
    },
    get usage() {
      return latestUsage
    },
    get sawFinish() {
      return stopped
    },
  }
}

/** Accumulate decoded IR events into a complete turn object for JSON rendering and billing. */
export function createGeminiCollector({ fallbackModel = '' } = {}) {
  let id = `resp_${randomHex(10)}`
  let model = fallbackModel
  const parts = []
  let stopReason = 'stop'
  let finishReason = 'STOP'
  let sawFinish = false
  let usage = null
  let error = null
  const searches = []

  return {
    push(event) {
      if (!event) return
      switch (event.kind) {
        case 'start':
          if (event.responseId) id = event.responseId
          if (event.model) model = event.model
          if (event.usage && !usage) usage = { ...event.usage, output_tokens: 0, total_tokens: 0 }
          break
        case 'thinking': {
          const last = parts[parts.length - 1]
          if (last && last.kind === 'thinking' && !last.signature) last.text += event.text
          else parts.push({ kind: 'thinking', text: event.text, signature: '' })
          break
        }
        case 'thinking_signature': {
          const last = parts[parts.length - 1]
          if (last && last.kind === 'thinking') last.signature = event.signature
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
        parts,
        text,
        thinking,
        toolCalls,
        images,
        searches,
        stopReason: toolCalls.length && stopReason === 'stop' ? 'tool' : stopReason,
        finishReason,
        sawFinish,
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

/** Render a collected Gemini turn as a non-streaming JSON body in any target protocol. */
export function renderGeminiProtocolResponse(protocol, collected, { model, sessionId, accountId } = {}) {
  const effectiveModel = model || collected.model
  const usage = collected.usage || {}
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
      stop_sequence: null,
      usage: toAnthropicUsage(usage),
    }
  }
  if (protocol === 'openai-chat') {
    const message = {
      role: 'assistant',
      content: collected.text || (collected.toolCalls.length ? null : ''),
    }
    if (collected.thinking) message.reasoning_content = collected.thinking
    if (collected.toolCalls.length) {
      message.tool_calls = collected.toolCalls.map((tc) => ({
        id: tc.signedId || tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
        ...(tc.signature ? { extra_content: { google: { thought_signature: tc.signature } } } : {}),
      }))
    }
    return {
      id: `chatcmpl_${randomHex(12)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: effectiveModel,
      choices: [{ index: 0, message, finish_reason: stopToOpenAIFinish(collected.stopReason) }],
      usage: toOpenAIChatUsage(usage),
    }
  }
  if (protocol === 'openai-responses') {
    const output = []
    if (collected.thinking) {
      output.push({
        id: `rs_${randomHex(12)}`,
        type: 'reasoning',
        status: 'completed',
        summary: [{ type: 'summary_text', text: collected.thinking }],
      })
    }
    if (collected.text || !collected.toolCalls.length) {
      output.push({
        id: `msg_${randomHex(12)}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: collected.text || '', annotations: [] }],
      })
    }
    for (const tc of collected.toolCalls) {
      output.push({
        id: `fc_${randomHex(10)}`,
        type: 'function_call',
        status: 'completed',
        call_id: tc.signedId || tc.id,
        name: tc.name,
        arguments: JSON.stringify(tc.args || {}),
      })
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

export function formatGeminiProtocolError(protocol, status, code, message) {
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
                : status === 429
                  ? 'RESOURCE_EXHAUSTED'
                  : status === 504
                    ? 'DEADLINE_EXCEEDED'
                    : 'UNAVAILABLE'
    return {
      error: {
        code: status,
        message,
        status: grpcStatus,
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: code }],
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
          : status === 429
            ? 'rate_limit_error'
            : status >= 500
              ? 'api_error'
              : 'invalid_request_error'
  if (protocol === 'anthropic') {
    return { type: 'error', error: { type, message, code } }
  }
  return { error: { type, code, message } }
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
export function createGeminiProtocolStreamEncoder(protocol, { model = '', responseId = '' } = {}) {
  const collector = createGeminiCollector({ fallbackModel: model })
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
        if (event.kind === 'tool_call') {
          const idx = toolIndex++
          const tc = {
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
        out += chunk({}, stopToOpenAIFinish(res.stopReason), { usage: toOpenAIChatUsage(res.usage) })
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
        if (event.kind === 'thinking') {
          let out = ensureStart()
          if (openBlock?.type !== 'thinking') {
            out += closeOpen()
            const index = blockIndex++
            openBlock = { index, type: 'thinking' }
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
          if (openBlock?.type !== 'thinking') {
            out += closeOpen()
            const index = blockIndex++
            openBlock = { index, type: 'thinking' }
            out += sse('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } })
          }
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
          delta: { stop_reason: stopToAnthropicReason(res.stopReason), stop_sequence: null },
          usage: { output_tokens: res.usage?.output_tokens || 0 },
        })
        out += sse('message_stop', {})
        return out
      },
      result: () => collector.result(),
    }
  }

  // OpenAI Responses streaming encoder
  const respId = `resp_${randomHex(12)}`
  let outputIndex = 0
  let openReasoning = null // { index, id, text }
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
    const { index, id, text } = openReasoning
    openReasoning = null
    const part = { type: 'summary_text', text }
    const item = { id, type: 'reasoning', status: 'completed', summary: [part] }
    return (
      sse('response.reasoning_summary_text.done', { item_id: id, output_index: index, summary_index: 0, text }) +
      sse('response.reasoning_summary_part.done', { item_id: id, output_index: index, summary_index: 0, part }) +
      sse('response.output_item.done', { output_index: index, item })
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
      if (event.kind === 'thinking') {
        let out = ensureStart() + closeText()
        if (!openReasoning) {
          const index = outputIndex++
          const id = `rs_${randomHex(10)}`
          openReasoning = { index, id, text: '' }
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
      if (event.kind === 'tool_call') {
        let out = ensureStart() + closeReasoning() + closeText()
        const index = outputIndex++
        const itemId = `fc_${randomHex(10)}`
        const callId = event.signedId || event.id
        const args = JSON.stringify(event.args || {})
        out += sse('response.output_item.added', {
          output_index: index,
          item: {
            id: itemId,
            type: 'function_call',
            status: 'in_progress',
            call_id: callId,
            name: event.name,
            arguments: '',
          },
        })
        out += sse('response.function_call_arguments.delta', { item_id: itemId, output_index: index, delta: args })
        out += sse('response.function_call_arguments.done', {
          item_id: itemId,
          output_index: index,
          name: event.name,
          arguments: args,
        })
        out += sse('response.output_item.done', {
          output_index: index,
          item: {
            id: itemId,
            type: 'function_call',
            status: 'completed',
            call_id: callId,
            name: event.name,
            arguments: args,
          },
        })
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
        ...renderGeminiProtocolResponse('openai-responses', res, { model: resolvedModel }),
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
  let buffer = ''
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
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
    },
    flush() {
      const rem = buffer.trim()
      buffer = ''
      if (rem) onFrame(`${rem}\n\n`)
    },
  }
}
