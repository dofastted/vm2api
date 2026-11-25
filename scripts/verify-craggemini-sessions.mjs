#!/usr/bin/env node
/**
 * Real-session & standards replay verifier for vm2api -> CRAGGemini ingress cleaning,
 * multi-protocol consistency, gemini-host.py whitelist, craggemini Rust parser acceptance,
 * and outbound native restoration.
 *
 * Inspired by `X:/crag-standalone/scripts/replay-standards.py`.
 *
 * Privacy invariant:
 * - Reads local CLI sessions (Claude Code, Codex, Gemini CLI) in memory only.
 * - Never writes or prints raw user prompts, assistant text, credentials, or secrets;
 *   only structural diagnostics, counts, and anonymized failure reasons are emitted.
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { normalizeGeminiOutboundPrompt } from '../src/lib/gemini/prompt-normalizer.mjs'
import { createGeminiPublicHandler } from '../src/lib/gemini/routes.mjs'
import { createGeminiScheduler } from '../src/lib/gemini/scheduler.mjs'
import {
  NATIVE_TUI_CAPABILITIES,
  SKIP_THOUGHT_SIGNATURE,
  buildGeminiRequest,
  parseInboundToGemini,
} from '../src/lib/protocol/gemini-convert.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_MODEL = 'gemini-3-pro'

const MINIMAL_CRAGGEMINI_KEYS = new Set([
  'model',
  'contents',
  'systemInstruction',
  'system_prompt_mode',
  'tools',
  'toolConfig',
  'generationConfig',
  'conversation_id',
])

const CRAGGEMINI_ALLOWED_BODY_KEYS = new Set([
  'model',
  'stream',
  'contents',
  'messages',
  'input',
  'system',
  'systemInstruction',
  'system_instruction',
  'instructions',
  'system_prompt_mode',
  'crag_prompt',
  'tools',
  'toolConfig',
  'tool_config',
  'tool_choice',
  'generationConfig',
  'generation_config',
  'web_search_options',
  'thinking',
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'stop',
  'stop_sequences',
  'conversation_id',
  'previous_response_id',
  'metadata',
  'parallel_tool_calls',
  'reasoning',
  'response_format',
  'subagents',
])

const CRAGGEMINI_SUPPORTED_ASPECT_RATIOS = new Set([
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
const CRAGGEMINI_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])
const CRAGGEMINI_MAX_REQUEST_BYTES = 12 * 1024 * 1024
const VALID_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const VALID_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const UNICODE_CONTROL_RE = /[^\P{Cc}\n\r\t]/u
const UNICODE_WS_RE = /\p{White_Space}+/u

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function parseArgs(argv) {
  const home = os.homedir()
  const opts = {
    standardsDir: fs.existsSync('X:/crag-standalone/tests/fixtures/replay-standards')
      ? 'X:/crag-standalone/tests/fixtures/replay-standards'
      : fs.existsSync('/mnt/x/crag-standalone/tests/fixtures/replay-standards')
        ? '/mnt/x/crag-standalone/tests/fixtures/replay-standards'
        : '',
    claudeDir: path.join(home, '.claude', 'projects'),
    codexDir: path.join(home, '.codex', 'sessions'),
    geminiDir: path.join(home, '.gemini', 'tmp'),
    limitPerSource: 20,
    maxTurnsPerSession: 3,
    verbose: false,
    json: false,
    list: false,
    skipHostPython: false,
    only: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/verify-craggemini-sessions.mjs [options]
Options:
  --standards-dir <dir>   Path to crag-standalone replay-standards corpus
  --claude-dir <dir>      Path to local Claude Code projects dir (~/.claude/projects)
  --codex-dir <dir>       Path to local Codex sessions dir (~/.codex/sessions)
  --gemini-dir <dir>      Path to local Gemini CLI tmp dir (~/.gemini/tmp)
  --limit <n>             Max session files per CLI source (default: 20, 0 = all)
  --turns <n>             Max snapshot turns extracted per session (default: 3)
  --only <sources>        Comma-separated subset: parity,standards,packets,claude,codex,gemini,resume
  --skip-host-python      Skip invoking scripts/gemini-host.py via Python
  --list                  List discovered corpus & session samples without running
  --verbose               Print detailed per-sample summary
  --json                  Output machine-readable JSON summary`)
      process.exit(0)
    } else if (arg === '--standards-dir') opts.standardsDir = argv[++i] || ''
    else if (arg === '--claude-dir') opts.claudeDir = argv[++i] || ''
    else if (arg === '--codex-dir') opts.codexDir = argv[++i] || ''
    else if (arg === '--gemini-dir') opts.geminiDir = argv[++i] || ''
    else if (arg === '--limit') opts.limitPerSource = Math.max(0, Number(argv[++i] ?? 20))
    else if (arg === '--turns') opts.maxTurnsPerSession = Math.max(1, Number(argv[++i] ?? 3))
    else if (arg === '--only')
      opts.only = new Set(
        String(argv[++i] || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    else if (arg === '--skip-host-python') opts.skipHostPython = true
    else if (arg === '--list') opts.list = true
    else if (arg === '--verbose') opts.verbose = true
    else if (arg === '--json') opts.json = true
  }
  return opts
}

function walkFiles(dir, re, out = []) {
  if (!dir || !fs.existsSync(dir)) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, re, out)
    else if (entry.isFile() && re.test(entry.name)) out.push(full)
  }
  return out
}

function pickRepresentativeFiles(files, limit) {
  const sized = files
    .map((f) => {
      try {
        return { file: f, size: fs.statSync(f).size }
      } catch {
        return { file: f, size: 0 }
      }
    })
    .filter((x) => x.size > 0)
    .sort((a, b) => b.size - a.size)
  if (!limit || sized.length <= limit) return sized.map((x) => x.file)
  // Pick a spread across largest, median, and recent small sessions for diversity.
  const picked = []
  const topCount = Math.ceil(limit * 0.6)
  for (let i = 0; i < Math.min(topCount, sized.length); i += 1) picked.push(sized[i].file)
  const rest = sized.slice(topCount)
  const step = Math.max(1, Math.floor(rest.length / Math.max(1, limit - picked.length)))
  for (let i = 0; i < rest.length && picked.length < limit; i += step) picked.push(rest[i].file)
  return picked
}

// ---------------------------------------------------------------------------
// 1. Faithful CRAGGemini Rust Validator (mirrors X:/antigravity-cli-proxy/src/)
// ---------------------------------------------------------------------------

function cragValidText(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'text is not string' }
  if (!text.trim()) return { ok: false, reason: 'valid_text: empty or whitespace-only text' }
  if (Buffer.byteLength(text, 'utf8') > CRAGGEMINI_MAX_REQUEST_BYTES) {
    return { ok: false, reason: 'valid_text: exceeds MAX_REQUEST (12 MiB)' }
  }
  for (const token of text.trim().split(UNICODE_WS_RE)) {
    if (token.startsWith('/')) {
      return { ok: false, reason: `valid_text: whitespace-delimited token starts with '/': "${token.slice(0, 32)}"` }
    }
  }
  const ctrl = UNICODE_CONTROL_RE.exec(text)
  if (ctrl) {
    const cp = ctrl[0].codePointAt(0).toString(16).padStart(4, '0')
    return { ok: false, reason: `valid_text: illegal control char U+${cp}` }
  }
  return { ok: true }
}

function cragValidSystemPrompt(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'system_prompt is not string' }
  if (Buffer.byteLength(text, 'utf8') > CRAGGEMINI_MAX_REQUEST_BYTES) {
    return { ok: false, reason: 'valid_system_prompt: exceeds MAX_REQUEST' }
  }
  const ctrl = UNICODE_CONTROL_RE.exec(text)
  if (ctrl) {
    const cp = ctrl[0].codePointAt(0).toString(16).padStart(4, '0')
    return { ok: false, reason: `valid_system_prompt: illegal control char U+${cp}` }
  }
  return { ok: true }
}

function cragSanitizePromptLine(text) {
  let out = ''
  let prevWs = true
  for (const ch of text) {
    if (ch === '/' && prevWs) {
      out += './'
      prevWs = false
    } else {
      out += ch
      prevWs = /\p{White_Space}/u.test(ch)
    }
  }
  return out
}

function cragProjectSchemaNode(node, depth = 0) {
  if (depth > 32) return { ok: false, reason: 'schema recursion depth > 32' }
  if (node === null || node === true) return { ok: true }
  if (node === false) return { ok: false, reason: 'schema false forbids all values' }
  if (!isPlainObject(node)) return { ok: false, reason: 'schema node must be JSON object or boolean' }
  if (node.not === true || (isPlainObject(node.not) && Object.keys(node.not).length === 0)) {
    return { ok: false, reason: 'schema.not forbids all values' }
  }
  if (node.type !== undefined) {
    if (Array.isArray(node.type)) {
      const nonNull = []
      for (const item of node.type) {
        if (typeof item !== 'string') return { ok: false, reason: 'schema.type array must contain strings' }
        if (item.toLowerCase() !== 'null') nonNull.push(item.toLowerCase())
      }
      if (!nonNull.length) return { ok: false, reason: 'schema.type array has no non-null type' }
      for (const t of nonNull) {
        if (!CRAGGEMINI_SCHEMA_TYPES.has(t)) return { ok: false, reason: `unsupported schema.type: ${t}` }
      }
    } else if (typeof node.type === 'string') {
      const lower = node.type.toLowerCase()
      if (lower !== 'type_unspecified' && lower !== 'null' && !CRAGGEMINI_SCHEMA_TYPES.has(lower)) {
        return { ok: false, reason: `unsupported schema.type: ${node.type}` }
      }
    }
  }
  if (isPlainObject(node.properties)) {
    for (const [k, v] of Object.entries(node.properties)) {
      const sub = cragProjectSchemaNode(v, depth + 1)
      if (!sub.ok) return { ok: false, reason: `properties.${k}: ${sub.reason}` }
    }
  }
  if (node.items !== undefined) {
    if (Array.isArray(node.items)) {
      for (const it of node.items) {
        const sub = cragProjectSchemaNode(it, depth + 1)
        if (!sub.ok) return sub
      }
    } else {
      const sub = cragProjectSchemaNode(node.items, depth + 1)
      if (!sub.ok) return sub
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(node[key])) {
      for (const v of node[key]) {
        const sub = cragProjectSchemaNode(v, depth + 1)
        if (!sub.ok) return sub
      }
    }
  }
  return { ok: true }
}

/**
 * Validates that an outbound Gemini body produced by vm2api will be accepted by
 * `craggemini` (`X:/antigravity-cli-proxy/src/{server,tools,schema,protocol,resume}.rs`)
 * AND obeys our strict minimal-ingress cleanliness invariants.
 */
function validateCragGeminiContract(body, { expectedModel = DEFAULT_MODEL, strictMinimal = true } = {}) {
  const errors = []
  if (!isPlainObject(body)) return { ok: false, errors: ['body must be a JSON object'] }

  // 1. Minimal & ALLOWED_BODY_KEYS check
  for (const key of Object.keys(body)) {
    if (!CRAGGEMINI_ALLOWED_BODY_KEYS.has(key)) {
      errors.push(`craggemini ALLOWED_BODY_KEYS rejects top-level key "${key}"`)
    }
    if (strictMinimal && !MINIMAL_CRAGGEMINI_KEYS.has(key)) {
      errors.push(`non-minimal top-level key leaked for antigravity: "${key}"`)
    }
  }

  // 2. model check
  if (typeof body.model !== 'string' || !VALID_MODEL_RE.test(body.model)) {
    errors.push(`invalid model: ${JSON.stringify(body.model)}`)
  } else if (expectedModel && body.model !== expectedModel) {
    errors.push(`model mismatch: got ${body.model}, expected ${expectedModel}`)
  }

  // 3. system_prompt_mode check
  if (body.system_prompt_mode !== undefined && !['official_full', 'zero'].includes(body.system_prompt_mode)) {
    errors.push(`invalid system_prompt_mode: ${JSON.stringify(body.system_prompt_mode)}`)
  }

  // 4. systemInstruction check (server.rs::parse_system_instruction + valid_system_prompt)
  let systemText = ''
  if (body.systemInstruction !== undefined) {
    const si = body.systemInstruction
    if (!isPlainObject(si) || !Array.isArray(si.parts) || si.parts.length === 0) {
      errors.push('systemInstruction must be { parts: [{ text }] }')
    } else {
      for (const p of si.parts) {
        if (!isPlainObject(p) || Object.keys(p).length !== 1 || typeof p.text !== 'string') {
          errors.push('systemInstruction.parts entries must each have exactly one key "text" (string)')
        } else {
          systemText += p.text
        }
      }
      if (!systemText.trim()) errors.push('systemInstruction text is empty/whitespace')
      else {
        const vs = cragValidSystemPrompt(systemText)
        if (!vs.ok) errors.push(vs.reason)
      }
    }
  }

  // 5. conversation_id check
  if (body.conversation_id !== undefined) {
    if (typeof body.conversation_id !== 'string' || !VALID_ID_RE.test(body.conversation_id)) {
      errors.push(`invalid conversation_id: ${JSON.stringify(body.conversation_id)}`)
    }
  }

  // 6. generationConfig check (must be image-only on strictMinimal)
  let hasImageGen = false
  if (body.generationConfig !== undefined) {
    const gc = body.generationConfig
    if (!isPlainObject(gc)) {
      errors.push('generationConfig must be an object')
    } else {
      const allowedGenKeys = new Set(['responseModalities', 'imageConfig', 'candidateCount'])
      for (const k of Object.keys(gc)) {
        if (strictMinimal && !allowedGenKeys.has(k)) {
          errors.push(`non-image generationConfig key leaked: "${k}"`)
        }
      }
      if (gc.responseModalities !== undefined) {
        if (
          !Array.isArray(gc.responseModalities) ||
          !gc.responseModalities.some((m) => String(m).toUpperCase() === 'IMAGE')
        ) {
          errors.push('generationConfig.responseModalities must include IMAGE when present')
        } else {
          hasImageGen = true
        }
      }
      if (gc.imageConfig !== undefined) {
        if (!isPlainObject(gc.imageConfig)) {
          errors.push('generationConfig.imageConfig must be an object')
        } else {
          hasImageGen = true
          if (
            gc.imageConfig.aspectRatio !== undefined &&
            !CRAGGEMINI_SUPPORTED_ASPECT_RATIOS.has(gc.imageConfig.aspectRatio)
          ) {
            errors.push(`unsupported imageConfig.aspectRatio: ${gc.imageConfig.aspectRatio}`)
          }
          if (gc.imageConfig.imageSize !== undefined && !['1K', '2K', '4K'].includes(gc.imageConfig.imageSize)) {
            errors.push(`unsupported imageConfig.imageSize: ${gc.imageConfig.imageSize}`)
          }
        }
      }
      if (strictMinimal && !hasImageGen) {
        errors.push('generationConfig present without image generation fields')
      }
    }
  }

  // 7. tools & toolConfig check (tools.rs::parse_tools_and_config + schema.rs::project_tool_schema)
  const declaredTools = []
  let hasWebSearch = false
  let hasWebFetch = false
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      errors.push('tools must be a non-empty array when present')
    } else {
      for (const entry of body.tools) {
        if (!isPlainObject(entry)) {
          errors.push('tools entry must be an object')
          continue
        }
        const keys = Object.keys(entry)
        let recognized = false
        if (entry.googleSearch !== undefined) {
          hasWebSearch = true
          recognized = true
        }
        if (entry.urlContext !== undefined) {
          hasWebFetch = true
          recognized = true
        }
        if (entry.functionDeclarations !== undefined) {
          recognized = true
          if (!Array.isArray(entry.functionDeclarations)) {
            errors.push('functionDeclarations must be an array')
          } else {
            for (const decl of entry.functionDeclarations) {
              if (!isPlainObject(decl) || typeof decl.name !== 'string' || !decl.name.trim()) {
                errors.push('functionDeclaration missing valid name')
                continue
              }
              if (decl.name.length > 64 || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(decl.name)) {
                errors.push(`invalid wire functionDeclaration.name: "${decl.name}"`)
              }
              if (decl.parameters !== undefined) {
                const sc = cragProjectSchemaNode(decl.parameters)
                if (!sc.ok) errors.push(`tool "${decl.name}" schema rejected by craggemini: ${sc.reason}`)
              }
              declaredTools.push(decl.name)
            }
          }
        }
        if (!recognized) {
          errors.push(`unrecognized/unsupported tool entry keys: [${keys.join(', ')}]`)
        }
      }
    }
  }

  if (body.toolConfig !== undefined) {
    const fcc = body.toolConfig?.functionCallingConfig
    if (!isPlainObject(fcc)) {
      errors.push('toolConfig.functionCallingConfig must be an object')
    } else {
      const mode = String(fcc.mode || 'AUTO').toUpperCase()
      if (!['AUTO', 'NONE', 'ANY'].includes(mode)) {
        errors.push(`craggemini rejects functionCallingConfig.mode="${mode}"`)
      }
      if (
        strictMinimal &&
        mode === 'AUTO' &&
        (!Array.isArray(fcc.allowedFunctionNames) || !fcc.allowedFunctionNames.length)
      ) {
        errors.push('redundant AUTO toolConfig should be omitted')
      }
    }
  }

  // 8. contents check (server.rs::parse_gemini_content + resume.rs::build_delta + protocol.rs::valid_text)
  const canonicalMsgs = []
  let inlineMediaCount = 0
  if (!Array.isArray(body.contents) || body.contents.length === 0) {
    errors.push('contents must be a non-empty array')
  } else {
    for (let i = 0; i < body.contents.length; i += 1) {
      const entry = body.contents[i]
      if (!isPlainObject(entry)) {
        errors.push(`contents[${i}] must be an object`)
        continue
      }
      for (const k of Object.keys(entry)) {
        if (k !== 'role' && k !== 'parts') errors.push(`contents[${i}] has disallowed key "${k}"`)
      }
      const role = entry.role || 'user'
      if (!['user', 'model', 'assistant', 'tool', 'function'].includes(role)) {
        errors.push(`contents[${i}] invalid role "${role}"`)
      }
      if (!Array.isArray(entry.parts) || entry.parts.length === 0) {
        errors.push(`contents[${i}].parts must be a non-empty array`)
        continue
      }
      const cm = {
        role: role === 'model' ? 'assistant' : role,
        text: '',
        toolCalls: [],
        toolResults: [],
      }
      for (let j = 0; j < entry.parts.length; j += 1) {
        const p = entry.parts[j]
        if (!isPlainObject(p)) {
          errors.push(`contents[${i}].parts[${j}] must be an object`)
          continue
        }
        if (p.thought === true) {
          errors.push(`contents[${i}].parts[${j}] leaked thought:true into antigravity contents`)
        }
        if (p.thoughtSignature === SKIP_THOUGHT_SIGNATURE) {
          errors.push(`contents[${i}].parts[${j}] leaked dummy SKIP_THOUGHT_SIGNATURE`)
        }
        if ('fileData' in p || 'file_data' in p) {
          errors.push(`contents[${i}].parts[${j}] leaked unsupported fileData`)
        }
        let kindCount = 0
        if (p.text !== undefined) {
          if (typeof p.text !== 'string') errors.push(`contents[${i}].parts[${j}].text must be string`)
          else if (p.thought !== true) cm.text += p.text
          kindCount += 1
        }
        if (p.inlineData !== undefined) {
          const io = p.inlineData
          if (!isPlainObject(io) || !io.mimeType || !io.data) {
            errors.push(`contents[${i}].parts[${j}].inlineData missing mimeType or data`)
          } else {
            inlineMediaCount += 1
          }
          kindCount += 1
        }
        if (p.functionCall !== undefined) {
          const fc = p.functionCall
          if (!isPlainObject(fc) || typeof fc.name !== 'string' || !fc.name) {
            errors.push(`contents[${i}].parts[${j}].functionCall missing name`)
          } else {
            cm.toolCalls.push({ id: fc.id || null, name: fc.name })
          }
          kindCount += 1
        }
        if (p.functionResponse !== undefined) {
          const fr = p.functionResponse
          if (!isPlainObject(fr) || fr.response === undefined) {
            errors.push(`contents[${i}].parts[${j}].functionResponse missing response`)
          } else {
            cm.toolResults.push({
              callId: fr.id || null,
              name: fr.name || null,
              content: fr.response,
            })
          }
          kindCount += 1
        }
        if (kindCount !== 1) {
          errors.push(`contents[${i}].parts[${j}] has kind_count=${kindCount} (craggemini requires exactly 1)`)
        }
      }
      canonicalMsgs.push(cm)
    }
  }

  // 9. Simulate craggemini `resume::build_delta` + `compile_native_prompt` + `valid_text`
  if (canonicalMsgs.length > 0 && errors.length === 0) {
    const last = canonicalMsgs[canonicalMsgs.length - 1]
    const prior = canonicalMsgs.slice(0, -1)
    let deltaText = last.text
    if (canonicalMsgs.length > 1 && !last.text.trim() && last.toolResults.length > 0) {
      deltaText = last.toolResults
        .map((tr) => `[Tool Result \`${tr.name || 'tool'}\`]: ${JSON.stringify(tr.content)}`)
        .join('\n')
    }
    const effectiveDelta = !deltaText.trim() && inlineMediaCount > 0 ? 'Inspect the attached media.' : deltaText
    const vd = cragValidText(effectiveDelta)
    if (!vd.ok) {
      errors.push(`craggemini effective_delta rejected: ${vd.reason}`)
    } else {
      const sections = []
      if (prior.length > 0) {
        const preambleLines = []
        for (const m of prior) {
          const r = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool' : 'User'
          if (m.text.trim()) preambleLines.push(`${r}: ${m.text.trim()}`)
          for (const tc of m.toolCalls) preambleLines.push(`${r} called tool \`${tc.name}\``)
          for (const tr of m.toolResults) {
            preambleLines.push(`Tool \`${tr.name || 'tool'}\` returned: ${JSON.stringify(tr.content)}`)
          }
        }
        if (preambleLines.length) {
          sections.push(`[Conversation Context]\n${cragSanitizePromptLine(preambleLines.join('\n'))}`)
        }
      }
      const hasAnyBridge =
        prior.length > 0 ||
        declaredTools.length > 0 ||
        hasWebSearch ||
        hasWebFetch ||
        hasImageGen ||
        inlineMediaCount > 0
      const compiled = hasAnyBridge ? [...sections, effectiveDelta].join('\n\n') : effectiveDelta
      const vc = cragValidText(compiled)
      if (!vc.ok) {
        errors.push(`craggemini compiled_prompt rejected: ${vc.reason}`)
      }
    }
  }

  return { ok: errors.length === 0, errors, declaredTools }
}

// ---------------------------------------------------------------------------
// 2. Python Host `_extract_native_turn_body` Batch Validator
// ---------------------------------------------------------------------------

function runHostPythonValidator(cases) {
  const hostPyPath = path.join(REPO_ROOT, 'scripts', 'gemini-host.py')
  const pyCode = `
import json, sys, types, socketserver, importlib.util
if not hasattr(socketserver, 'UnixStreamServer'):
    socketserver.UnixStreamServer = socketserver.TCPServer
for mod in ('fcntl', 'grp', 'pwd', 'pty', 'termios', 'resource'):
    sys.modules.setdefault(mod, types.ModuleType(mod))
spec = importlib.util.spec_from_file_location('gemini_host_verify', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
extract = mod.Host._extract_native_turn_body
payload = json.loads(sys.stdin.read())
results = []
for item in payload:
    cleaned = extract(item['model'], item['body'])
    if cleaned is None:
        results.append({'id': item['id'], 'ok': False, 'reason': '_extract_native_turn_body returned None'})
    else:
        same_keys = sorted(cleaned.keys()) == sorted(item['body'].keys())
        results.append({
            'id': item['id'],
            'ok': True,
            'sameKeys': same_keys,
            'droppedKeys': sorted(set(item['body'].keys()) - set(cleaned.keys())),
            'addedKeys': sorted(set(cleaned.keys()) - set(item['body'].keys())),
        })
print(json.dumps(results))
`
  const input = JSON.stringify(cases)
  for (const bin of ['python3', 'python']) {
    const res = spawnSync(bin, ['-B', '-c', pyCode, hostPyPath], {
      input,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    if (res.status === 0 && res.stdout.trim()) {
      return { ok: true, bin, results: JSON.parse(res.stdout) }
    }
  }
  return { ok: false, bin: null, results: [], error: 'No working python3/python executable found' }
}

// ---------------------------------------------------------------------------
// 3. Synthetic Tool Schemas for Reconstructed Real CLI Sessions
// ---------------------------------------------------------------------------

function schemaForObservedTool(name, observedArgs = []) {
  const props = {}
  for (const args of observedArgs) {
    if (!isPlainObject(args)) continue
    for (const [k, v] of Object.entries(args)) {
      if (props[k]) continue
      if (typeof v === 'string') props[k] = { type: 'string' }
      else if (typeof v === 'number') props[k] = { type: Number.isInteger(v) ? 'integer' : 'number' }
      else if (typeof v === 'boolean') props[k] = { type: 'boolean' }
      else if (Array.isArray(v)) props[k] = { type: 'array', items: { type: 'string' } }
      else if (isPlainObject(v)) props[k] = { type: 'object', properties: {} }
      else props[k] = { type: 'string' }
    }
  }
  return { type: 'object', properties: props }
}

// ---------------------------------------------------------------------------
// 4. Corpus Loaders: Standards, Packets, Claude Code, Codex, Gemini CLI
// ---------------------------------------------------------------------------

function loadStandardsCorpus(standardsDir) {
  if (!standardsDir || !fs.existsSync(standardsDir)) return []
  const samples = []
  const files = [
    'chat.json',
    'gemini.json',
    'messages.json',
    'boundaries.json',
    'persona/inputs.json',
    'admission/inputs.json',
  ]
  for (const rel of files) {
    const full = path.join(standardsDir, rel)
    if (!fs.existsSync(full)) continue
    let arr
    try {
      arr = JSON.parse(fs.readFileSync(full, 'utf8'))
    } catch {
      continue
    }
    if (!Array.isArray(arr)) continue
    for (const item of arr) {
      if (!item?.id || !item.input) continue
      // Skip pure wrapper-reference items in admission/inputs.json that only declare `base` without `path`/`input`.
      const rawPath = item.path || ''
      let protocol = ''
      let url = rawPath
      let body = item.input
      if (rawPath === '/v1/chat/completions') {
        protocol = 'openai-chat'
      } else if (rawPath.startsWith('/v1beta/')) {
        protocol = 'gemini'
        url = rawPath.replace(/claude-haiku-4-5/g, DEFAULT_MODEL)
      } else if (rawPath === '/v1/messages') {
        protocol = 'anthropic'
      } else if (rawPath === '/internal/v1/messages' && isPlainObject(item.input?.body)) {
        protocol = 'anthropic'
        url = '/v1/messages'
        body = item.input.body
      } else {
        continue
      }
      // Clone and rewrite model to DEFAULT_MODEL so vm2api routes cleanly onto our test CRAGGemini model.
      const cloned = structuredClone(body)
      if (protocol !== 'gemini') cloned.model = DEFAULT_MODEL
      // `chat-bad-schema` has non-object json_schema.schema and must fail closed with 400.
      // `gemini-multiple-candidates` (non-image candidateCount) is intentionally stripped on CRAGGemini
      // while preserved for direct Gemini API Key; `tool-orphan` is hardened by ensureGeminiContentsValid.
      const expectBadRequest = item.id === 'chat-bad-schema'
      samples.push({
        source: 'standards',
        id: `std:${rel.replace(/\.json$/, '')}:${item.id}`,
        protocol,
        url,
        body: cloned,
        expectStatus: expectBadRequest ? 400 : 200,
        stream: Boolean(cloned.stream) || url.includes('streamGenerateContent'),
        originNote: `${rel}#${item.id}`,
        extraAssert:
          item.id === 'gemini-multiple-candidates'
            ? (outboundBody) =>
                outboundBody && 'generationConfig' in outboundBody
                  ? 'non-image candidateCount should be stripped from antigravity generationConfig'
                  : null
            : null,
      })
    }
  }
  return samples
}

function loadPacketFixtures() {
  const dir = path.join(REPO_ROOT, 'test', 'fixtures')
  if (!fs.existsSync(dir)) return []
  const samples = []
  for (const name of [
    'pkt-001-openai.chat.completions.json',
    'pkt-002-anthropic.messages.json',
    'pkt-003-openai.responses.json',
    'synth-tools-metadata.anthropic.json',
  ]) {
    const full = path.join(dir, name)
    if (!fs.existsSync(full)) continue
    const doc = JSON.parse(fs.readFileSync(full, 'utf8'))
    const protoMap = {
      'openai.chat.completions': ['openai-chat', '/v1/chat/completions'],
      'anthropic.messages': ['anthropic', '/v1/messages'],
      'openai.responses': ['openai-responses', '/v1/responses'],
    }
    const mapped = protoMap[doc.inbound_protocol]
    if (!mapped || !isPlainObject(doc.inbound_body)) continue
    const body = structuredClone(doc.inbound_body)
    body.model = DEFAULT_MODEL
    samples.push({
      source: 'packets',
      id: `pkt:${name.replace(/\.json$/, '')}`,
      protocol: mapped[0],
      url: mapped[1],
      body,
      expectStatus: 200,
      stream: Boolean(body.stream),
      originNote: name,
    })
  }
  return samples
}

function loadClaudeSessions(claudeDir, { limit, maxTurns }) {
  const files = pickRepresentativeFiles(walkFiles(claudeDir, /\.jsonl$/), limit)
  const samples = []
  for (const file of files) {
    const rawLines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    const messages = []
    const toolArgsMap = new Map()
    for (const line of rawLines) {
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      const msg = row?.message
      if (!isPlainObject(msg) || !['user', 'assistant'].includes(msg.role)) continue
      const content = msg.content
      if (typeof content === 'string') {
        if (!content.trim()) continue
        messages.push({ role: msg.role, content })
      } else if (Array.isArray(content) && content.length > 0) {
        const cleanBlocks = []
        for (const b of content) {
          if (!isPlainObject(b) || !b.type) continue
          if (b.type === 'tool_use' && b.name) {
            const list = toolArgsMap.get(b.name) || []
            if (list.length < 3) list.push(b.input)
            toolArgsMap.set(b.name, list)
            // Keep exact real block structure (including caller metadata if present)
            cleanBlocks.push(b)
          } else {
            cleanBlocks.push(b)
          }
        }
        if (cleanBlocks.length) messages.push({ role: msg.role, content: cleanBlocks })
      }
    }
    if (!messages.length) continue
    // Build snapshots ending on real user turns (both plain text turns and tool_result continuation turns)
    const userTurnEndIndices = []
    for (let i = 0; i < messages.length; i += 1) {
      if (messages[i].role === 'user') userTurnEndIndices.push(i)
    }
    if (!userTurnEndIndices.length) continue
    const chosen = selectTurnIndices(userTurnEndIndices, maxTurns)
    const tools = [...toolArgsMap.entries()].map(([name, argList]) => ({
      name,
      description: `Claude CLI tool ${name}`,
      input_schema: schemaForObservedTool(name, argList),
    }))
    const shortId = path.basename(file, '.jsonl').slice(0, 12)
    for (const endIdx of chosen) {
      // Slice a realistic window (up to 24 messages ending at endIdx, starting on a user turn)
      let startIdx = Math.max(0, endIdx - 23)
      while (startIdx < endIdx && messages[startIdx].role !== 'user') startIdx += 1
      const slice = messages.slice(startIdx, endIdx + 1)
      if (!slice.length) continue
      const hasToolResult =
        Array.isArray(slice[slice.length - 1].content) &&
        slice[slice.length - 1].content.some((b) => b?.type === 'tool_result')
      const body = {
        model: DEFAULT_MODEL,
        max_tokens: 4096,
        stream: true,
        system: [
          { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.321; cch=deadbeef; cc_entrypoint=cli' },
          {
            type: 'text',
            text: 'You are Claude Code, an interactive CLI agent.',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        thinking: { type: 'enabled', budget_tokens: 4096 },
        ...(tools.length ? { tools } : {}),
        messages: slice,
      }
      samples.push({
        source: 'claude',
        id: `claude:${shortId}:t${endIdx}${hasToolResult ? ':toolres' : ''}`,
        protocol: 'anthropic',
        url: '/v1/messages',
        body,
        expectStatus: 200,
        stream: true,
        originNote: `${shortId} (${slice.length} msgs, ${tools.length} tools)`,
      })
    }
  }
  return samples
}

function loadCodexSessions(codexDir, { limit, maxTurns }) {
  const files = pickRepresentativeFiles(walkFiles(codexDir, /\.jsonl$/), limit)
  const samples = []
  for (const file of files) {
    const rawLines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    let instructions = ''
    const items = []
    const toolArgsMap = new Map()
    const builtinTypes = new Set()
    for (const line of rawLines) {
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (row?.type === 'session_meta' && typeof row.payload?.base_instructions?.text === 'string') {
        instructions = row.payload.base_instructions.text.slice(0, 8000)
      } else if (row?.type === 'session_meta' && typeof row.payload?.base_instructions === 'string') {
        instructions = row.payload.base_instructions.slice(0, 8000)
      }
      if (row?.type !== 'response_item' || !isPlainObject(row.payload)) continue
      const pl = row.payload
      const t = pl.type
      if (
        t === 'message' ||
        t === 'reasoning' ||
        t === 'function_call' ||
        t === 'function_call_output' ||
        t === 'custom_tool_call' ||
        t === 'custom_tool_call_output' ||
        t === 'local_shell_call' ||
        t === 'local_shell_call_output' ||
        t === 'shell_call' ||
        t === 'shell_call_output' ||
        t === 'apply_patch_call' ||
        t === 'apply_patch_call_output'
      ) {
        if (t === 'function_call' && pl.name) {
          const list = toolArgsMap.get(pl.name) || []
          if (list.length < 3) {
            try {
              list.push(typeof pl.arguments === 'string' ? JSON.parse(pl.arguments) : pl.arguments)
            } catch {}
          }
          toolArgsMap.set(pl.name, list)
        } else if (t === 'custom_tool_call' && pl.name) {
          builtinTypes.add(`custom:${pl.name}`)
        } else if (t === 'local_shell_call') {
          builtinTypes.add('local_shell')
        } else if (t === 'shell_call') {
          builtinTypes.add('shell')
        } else if (t === 'apply_patch_call') {
          builtinTypes.add('apply_patch')
        }
        items.push(pl)
      }
    }
    if (!items.length) continue
    // Pick snapshots ending on a user message or *_output item
    const endIndices = []
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i]
      if (
        (it.type === 'message' && it.role === 'user') ||
        it.type === 'function_call_output' ||
        it.type === 'custom_tool_call_output' ||
        it.type === 'local_shell_call_output' ||
        it.type === 'shell_call_output' ||
        it.type === 'apply_patch_call_output'
      ) {
        endIndices.push(i)
      }
    }
    if (!endIndices.length) continue
    const chosen = selectTurnIndices(endIndices, maxTurns)
    const tools = []
    for (const [name, argList] of toolArgsMap.entries()) {
      tools.push({
        type: 'function',
        name,
        description: `Codex CLI tool ${name}`,
        parameters: schemaForObservedTool(name, argList),
      })
    }
    for (const bt of builtinTypes) {
      if (bt.startsWith('custom:')) tools.push({ type: 'custom', name: bt.slice(7), description: 'Codex custom tool' })
      else tools.push({ type: bt })
    }
    const shortId = path.basename(file, '.jsonl').slice(-12)
    for (const endIdx of chosen) {
      const startIdx = Math.max(0, endIdx - 29)
      const slice = items.slice(startIdx, endIdx + 1)
      if (!slice.length) continue
      const isOutput = slice[slice.length - 1].type?.endsWith('_output')
      const body = {
        model: DEFAULT_MODEL,
        stream: true,
        ...(instructions ? { instructions } : {}),
        reasoning: { effort: 'high', summary: 'auto' },
        parallel_tool_calls: true,
        ...(tools.length ? { tools } : {}),
        input: slice,
      }
      samples.push({
        source: 'codex',
        id: `codex:${shortId}:i${endIdx}${isOutput ? ':toolout' : ''}`,
        protocol: 'openai-responses',
        url: '/v1/responses',
        body,
        expectStatus: 200,
        stream: true,
        originNote: `${shortId} (${slice.length} items, ${tools.length} tools)`,
      })
    }
  }
  return samples
}

function loadGeminiCliSessions(geminiDir, { limit, maxTurns }) {
  const files = pickRepresentativeFiles(walkFiles(geminiDir, /^session-.*\.json$/), limit)
  const samples = []
  for (const file of files) {
    let doc
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const rawMsgs = Array.isArray(doc?.messages) ? doc.messages : []
    if (!rawMsgs.length) continue
    const contents = []
    const toolArgsMap = new Map()
    for (const m of rawMsgs) {
      if (!isPlainObject(m)) continue
      if (m.type === 'user') {
        const text =
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n')
              : ''
        if (text.trim()) contents.push({ role: 'user', parts: [{ text }] })
      } else if (m.type === 'gemini') {
        const modelParts = []
        if (Array.isArray(m.thoughts)) {
          for (const th of m.thoughts) {
            const t = [th?.subject, th?.description].filter(Boolean).join(': ')
            if (t) modelParts.push({ thought: true, text: t })
          }
        }
        const modelText =
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n')
              : ''
        if (modelText.trim()) modelParts.push({ text: modelText })
        const toolResults = []
        if (Array.isArray(m.toolCalls)) {
          for (const tc of m.toolCalls) {
            if (!isPlainObject(tc) || !tc.name) continue
            const args = isPlainObject(tc.args) ? tc.args : {}
            const list = toolArgsMap.get(tc.name) || []
            if (list.length < 3) list.push(args)
            toolArgsMap.set(tc.name, list)
            modelParts.push({
              functionCall: { id: tc.id || `gcall_${crypto.randomBytes(4).toString('hex')}`, name: tc.name, args },
              thoughtSignature: SKIP_THOUGHT_SIGNATURE,
            })
            let respObj = { result: 'ok' }
            if (Array.isArray(tc.result) && tc.result[0]?.functionResponse?.response) {
              respObj = tc.result[0].functionResponse.response
            } else if (isPlainObject(tc.result)) {
              respObj = tc.result
            } else if (typeof tc.resultDisplay === 'string' && tc.resultDisplay.trim()) {
              respObj = { result: tc.resultDisplay }
            }
            toolResults.push({
              functionResponse: {
                id: tc.id || undefined,
                name: tc.name,
                response: isPlainObject(respObj) ? respObj : { result: String(respObj ?? '') },
              },
            })
          }
        }
        if (modelParts.length) contents.push({ role: 'model', parts: modelParts })
        if (toolResults.length) contents.push({ role: 'user', parts: toolResults })
      }
    }
    if (!contents.length) continue
    const userEndIndices = []
    for (let i = 0; i < contents.length; i += 1) {
      if (contents[i].role === 'user') userEndIndices.push(i)
    }
    if (!userEndIndices.length) continue
    const chosen = selectTurnIndices(userEndIndices, maxTurns)
    const decls = [...toolArgsMap.entries()].map(([name, argList]) => ({
      name,
      description: `Gemini CLI tool ${name}`,
      parameters: schemaForObservedTool(name, argList),
    }))
    const shortId = path.basename(file, '.json').slice(-12)
    for (const endIdx of chosen) {
      let startIdx = Math.max(0, endIdx - 19)
      while (startIdx < endIdx && contents[startIdx].role !== 'user') startIdx += 1
      const slice = contents.slice(startIdx, endIdx + 1)
      if (!slice.length) continue
      const hasFr = slice[slice.length - 1].parts.some((p) => p.functionResponse)
      const body = {
        contents: slice,
        ...(decls.length ? { tools: [{ functionDeclarations: decls }] } : {}),
        generationConfig: {
          temperature: 0.7,
          topP: 0.95,
          maxOutputTokens: 8192,
          thinkingConfig: { includeThoughts: true, thinkingBudget: 4096 },
        },
        safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
      }
      samples.push({
        source: 'gemini',
        id: `gemini:${shortId}:c${endIdx}${hasFr ? ':fnresp' : ''}`,
        protocol: 'gemini',
        url: `/v1beta/models/${DEFAULT_MODEL}:streamGenerateContent`,
        body,
        expectStatus: 200,
        stream: true,
        originNote: `${shortId} (${slice.length} turns, ${decls.length} tools)`,
      })
    }
  }
  return samples
}

function selectTurnIndices(indices, maxTurns) {
  if (indices.length <= maxTurns) return indices
  const out = new Set([indices[0], indices[indices.length - 1]])
  if (maxTurns >= 3) out.add(indices[Math.floor(indices.length / 2)])
  const step = Math.max(1, Math.floor(indices.length / maxTurns))
  for (let i = 0; i < indices.length && out.size < maxTurns; i += step) out.add(indices[i])
  return [...out].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// 5. Cross-Protocol Parity Suite (4 protocols -> identical cleaned CRAGGemini body)
// ---------------------------------------------------------------------------

function buildParityGroups() {
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAIAAADUVFKvAAAAEElEQVR4nGP8z4ACmBjw8wEvkQEFsRIyegAAAABJRU5ErkJggg=='
  const toolSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace path' },
      limit: { type: 'integer' },
    },
    required: ['path'],
  }

  return [
    {
      group: 'parity:common-text',
      variants: [
        {
          protocol: 'gemini',
          url: `/v1beta/models/${DEFAULT_MODEL}:generateContent`,
          body: {
            systemInstruction: { parts: [{ text: 'Be precise.' }] },
            contents: [{ role: 'user', parts: [{ text: '样本 Ω\nCheck /etc/hosts now' }] }],
            generationConfig: { temperature: 0.3, topP: 0.9, maxOutputTokens: 384 },
          },
        },
        {
          protocol: 'openai-chat',
          url: '/v1/chat/completions',
          body: {
            model: DEFAULT_MODEL,
            temperature: 0.3,
            top_p: 0.9,
            max_completion_tokens: 384,
            messages: [
              { role: 'developer', content: 'Be precise.' },
              { role: 'user', content: '样本 Ω\nCheck /etc/hosts now' },
            ],
          },
        },
        {
          protocol: 'openai-responses',
          url: '/v1/responses',
          body: {
            model: DEFAULT_MODEL,
            instructions: 'Be precise.',
            temperature: 0.3,
            top_p: 0.9,
            max_output_tokens: 384,
            input: [
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: '样本 Ω\nCheck /etc/hosts now' }],
              },
            ],
          },
        },
        {
          protocol: 'anthropic',
          url: '/v1/messages',
          body: {
            model: DEFAULT_MODEL,
            temperature: 0.3,
            top_p: 0.9,
            max_tokens: 384,
            system: 'Be precise.',
            messages: [{ role: 'user', content: [{ type: 'text', text: '样本 Ω\nCheck /etc/hosts now' }] }],
          },
        },
      ],
    },
    {
      group: 'parity:paired-tool-multiturn',
      variants: [
        {
          protocol: 'gemini',
          url: `/v1beta/models/${DEFAULT_MODEL}:streamGenerateContent`,
          body: {
            contents: [
              { role: 'user', parts: [{ text: 'Read README' }] },
              {
                role: 'model',
                parts: [{ functionCall: { id: 'call_p1', name: 'read_file', args: { path: 'README.md', limit: 20 } } }],
              },
              {
                role: 'user',
                parts: [
                  { functionResponse: { id: 'call_p1', name: 'read_file', response: { result: 'line1 /usr/bin ok' } } },
                ],
              },
            ],
            tools: [
              { functionDeclarations: [{ name: 'read_file', description: 'Read file', parameters: toolSchema }] },
            ],
          },
        },
        {
          protocol: 'openai-chat',
          url: '/v1/chat/completions',
          body: {
            model: DEFAULT_MODEL,
            stream: true,
            messages: [
              { role: 'user', content: 'Read README' },
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_p1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"README.md","limit":20}' },
                  },
                ],
              },
              { role: 'tool', tool_call_id: 'call_p1', content: 'line1 /usr/bin ok' },
            ],
            tools: [
              { type: 'function', function: { name: 'read_file', description: 'Read file', parameters: toolSchema } },
            ],
          },
        },
        {
          protocol: 'openai-responses',
          url: '/v1/responses',
          body: {
            model: DEFAULT_MODEL,
            stream: true,
            input: [
              { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read README' }] },
              {
                type: 'function_call',
                call_id: 'call_p1',
                name: 'read_file',
                arguments: '{"path":"README.md","limit":20}',
              },
              { type: 'function_call_output', call_id: 'call_p1', output: 'line1 /usr/bin ok' },
            ],
            tools: [{ type: 'function', name: 'read_file', description: 'Read file', parameters: toolSchema }],
          },
        },
        {
          protocol: 'anthropic',
          url: '/v1/messages',
          body: {
            model: DEFAULT_MODEL,
            stream: true,
            max_tokens: 1024,
            messages: [
              { role: 'user', content: 'Read README' },
              {
                role: 'assistant',
                content: [
                  { type: 'tool_use', id: 'call_p1', name: 'read_file', input: { path: 'README.md', limit: 20 } },
                ],
              },
              {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'call_p1', content: 'line1 /usr/bin ok' }],
              },
            ],
            tools: [{ name: 'read_file', description: 'Read file', input_schema: toolSchema }],
          },
        },
      ],
    },
    {
      group: 'parity:inline-png',
      variants: [
        {
          protocol: 'gemini',
          url: `/v1beta/models/${DEFAULT_MODEL}:generateContent`,
          body: {
            contents: [
              {
                role: 'user',
                parts: [
                  { text: 'before PNG' },
                  { inlineData: { mimeType: 'image/png', data: pngB64 } },
                  { text: 'after PNG' },
                ],
              },
            ],
          },
        },
        {
          protocol: 'openai-chat',
          url: '/v1/chat/completions',
          body: {
            model: DEFAULT_MODEL,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'before PNG' },
                  { type: 'image_url', image_url: { url: `data:image/png;base64,${pngB64}` } },
                  { type: 'text', text: 'after PNG' },
                ],
              },
            ],
          },
        },
        {
          protocol: 'openai-responses',
          url: '/v1/responses',
          body: {
            model: DEFAULT_MODEL,
            input: [
              {
                type: 'message',
                role: 'user',
                content: [
                  { type: 'input_text', text: 'before PNG' },
                  { type: 'input_image', image_url: `data:image/png;base64,${pngB64}` },
                  { type: 'input_text', text: 'after PNG' },
                ],
              },
            ],
          },
        },
        {
          protocol: 'anthropic',
          url: '/v1/messages',
          body: {
            model: DEFAULT_MODEL,
            max_tokens: 256,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'before PNG' },
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB64 } },
                  { type: 'text', text: 'after PNG' },
                ],
              },
            ],
          },
        },
      ],
    },
    {
      group: 'parity:schema-tools-search',
      variants: [
        {
          protocol: 'gemini',
          url: `/v1beta/models/${DEFAULT_MODEL}:generateContent`,
          body: {
            systemInstruction: { parts: [{ text: 'FORMAT_RULE_8' }] },
            contents: [{ role: 'user', parts: [{ text: 'return count' }] }],
            tools: [
              { functionDeclarations: [{ name: 'read_file', description: 'Read file', parameters: toolSchema }] },
              { googleSearch: {} },
            ],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 256,
              responseMimeType: 'application/json',
              responseJsonSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
            },
          },
        },
        {
          protocol: 'openai-chat',
          url: '/v1/chat/completions',
          body: {
            model: DEFAULT_MODEL,
            temperature: 0.2,
            max_tokens: 256,
            web_search_options: {},
            messages: [
              { role: 'developer', content: 'FORMAT_RULE_8' },
              { role: 'user', content: 'return count' },
            ],
            tools: [
              { type: 'function', function: { name: 'read_file', description: 'Read file', parameters: toolSchema } },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'answer',
                schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
              },
            },
          },
        },
        {
          protocol: 'openai-responses',
          url: '/v1/responses',
          body: {
            model: DEFAULT_MODEL,
            instructions: 'FORMAT_RULE_8',
            temperature: 0.2,
            max_output_tokens: 256,
            input: 'return count',
            tools: [
              { type: 'function', name: 'read_file', description: 'Read file', parameters: toolSchema },
              { type: 'web_search' },
            ],
            text: {
              format: {
                type: 'json_schema',
                schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
              },
            },
          },
        },
        {
          protocol: 'anthropic',
          url: '/v1/messages',
          body: {
            model: DEFAULT_MODEL,
            system: 'FORMAT_RULE_8',
            temperature: 0.2,
            max_tokens: 256,
            messages: [{ role: 'user', content: 'return count' }],
            tools: [
              { name: 'read_file', description: 'Read file', input_schema: toolSchema },
              { type: 'web_search_20250305', name: 'web_search' },
            ],
            output_format: {
              type: 'json_schema',
              schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
            },
          },
        },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// 6. Full End-to-End Handler Execution & Outbound Restoration Harness
// ---------------------------------------------------------------------------

function makeRes() {
  const res = new EventEmitter()
  res.headers = {}
  res.statusCode = 200
  res.chunks = []
  res.writableEnded = false
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v
  }
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status
    for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = v
  }
  res.write = (chunk) => {
    res.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }
  res.end = (chunk) => {
    if (chunk) res.write(chunk)
    res.writableEnded = true
    res.emit('finish')
  }
  res.jsonBody = () => JSON.parse(res.chunks.join(''))
  return res
}

function makeReq({ method = 'POST', url, body, headers = {} }) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json', ...headers }
  req.body = body
  req.apiKeyKind = 'managed'
  req.apiKeyRecord = { id: 'k-verify', group_id: 2, group_type: 'gemini' }
  return req
}

function sseStream(frames) {
  const r = Readable.from(frames.map((f) => Buffer.from(f, 'utf8')))
  r.statusCode = 200
  r.headers = { 'content-type': 'text/event-stream' }
  return r
}

async function runSampleThroughHandler(sample) {
  let capturedBody = null
  let responseMode = 'text'
  let expectedToolOrigName = null
  let expectedToolWireName = null

  const scheduler = createGeminiScheduler({
    callHost: async (op) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              id: 'env-replay-1',
              proxy_id: 'proxy-1',
              auth_state: 'authorized',
              auth_method: 'oauth',
              models_discovered: true,
              models: [DEFAULT_MODEL],
              capabilities: [...NATIVE_TUI_CAPABILITIES],
            },
          ],
        }
      }
      if (op === 'get') return { id: 'env-replay-1', proxy_id: 'proxy-1', auth_method: 'oauth' }
      if (op === 'infer-cancel') return { cancelled: true }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async (_op, payload) => {
      capturedBody = payload.body
      if (responseMode === 'tool_call' && expectedToolWireName) {
        return sseStream([
          `data: ${JSON.stringify({
            craggeminiMeta: {
              conversation_id: 'conv_replay_1',
              native_conversation_id: 'native_replay_1',
              awaiting_tool_results: true,
            },
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        id: 'call_sim_1',
                        name: `mcp__craggemini__${expectedToolWireName}`,
                        args: { ok: true },
                      },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 16, candidatesTokenCount: 6, totalTokenCount: 22 },
          })}\n\n`,
        ])
      }
      return sseStream([
        `data: ${JSON.stringify({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: '{"verified":true}' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 16, candidatesTokenCount: 6, totalTokenCount: 22 },
        })}\n\n`,
      ])
    },
    resolveProxy: () => 'socks5h://127.0.0.1:1080',
  })

  const handler = createGeminiPublicHandler({
    json: (res, status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    },
    readBody: async (req) => req.body,
    scheduler,
  })

  // First check whether tools exist so we can also test tool-call restoration round-trip when tools are present
  let parsedPreview = null
  try {
    const routeModel = sample.protocol === 'gemini' ? DEFAULT_MODEL : ''
    parsedPreview = parseInboundToGemini(sample.protocol, sample.body, {
      routeModel,
      routeStream: sample.stream,
    })
  } catch {}
  if (parsedPreview?.tools?.length && parsedPreview.toolChoice !== 'none') {
    const allowed = parsedPreview.restoreContext?.allowedToolNames
    const pickedTool =
      (allowed?.size && parsedPreview.tools.find((t) => allowed.has(t.wireName))) || parsedPreview.tools[0]
    if (pickedTool && pickedTool.kind !== 'custom_chat' && pickedTool.kind !== 'custom_responses') {
      responseMode = 'tool_call'
      expectedToolOrigName = pickedTool.origName || pickedTool.name
      expectedToolWireName = pickedTool.wireName
    }
  }

  const res = makeRes()
  await handler(makeReq({ url: sample.url, body: sample.body }), res)

  const errors = []
  if (res.statusCode !== sample.expectStatus) {
    let errDetail = ''
    try {
      const parsed = JSON.parse(res.chunks.join(''))
      errDetail = parsed?.error?.message || parsed?.error?.code || ''
    } catch {}
    errors.push(`HTTP ${res.statusCode}, expected ${sample.expectStatus}${errDetail ? `: ${errDetail}` : ''}`)
  }

  let cragCheck = null
  if (sample.expectStatus === 200) {
    if (!capturedBody) {
      errors.push('handler did not dispatch outbound body to CRAGGemini')
    } else {
      cragCheck = validateCragGeminiContract(capturedBody, { expectedModel: DEFAULT_MODEL, strictMinimal: true })
      if (!cragCheck.ok) errors.push(...cragCheck.errors)
      const reNormalized = normalizeGeminiOutboundPrompt(capturedBody, { target: 'antigravity' })
      if (JSON.stringify(reNormalized.body) !== JSON.stringify(capturedBody)) {
        errors.push(
          `prompt normalization not idempotent (residual rules: ${reNormalized.report?.rules_applied?.join(', ') || 'unknown'})`,
        )
      }
      if (typeof sample.extraAssert === 'function') {
        const extraErr = sample.extraAssert(capturedBody)
        if (extraErr) errors.push(extraErr)
      }
    }

    // Verify outbound response protocol validity & tool-name restoration
    const rawOut = res.chunks.join('')
    if (sample.stream) {
      if (!rawOut.includes('data:')) errors.push('streaming response produced no SSE data frames')
      if (sample.protocol === 'openai-chat' && !rawOut.includes('[DONE]')) {
        errors.push('openai-chat stream missing [DONE] sentinel')
      }
      if (responseMode === 'tool_call' && expectedToolOrigName) {
        if (!rawOut.includes(expectedToolOrigName)) {
          errors.push(`streaming egress failed to restore tool name "${expectedToolOrigName}"`)
        }
        if (rawOut.includes('mcp__craggemini__')) {
          errors.push('streaming egress leaked internal mcp__craggemini__ prefix')
        }
      }
    } else {
      try {
        const outJson = JSON.parse(rawOut)
        if (responseMode === 'tool_call' && expectedToolOrigName) {
          const serialized = JSON.stringify(outJson)
          if (!serialized.includes(expectedToolOrigName)) {
            errors.push(`JSON egress failed to restore tool name "${expectedToolOrigName}"`)
          }
          if (serialized.includes('mcp__craggemini__')) {
            errors.push('JSON egress leaked internal mcp__craggemini__ prefix')
          }
        }
      } catch (e) {
        errors.push(`non-streaming response is invalid JSON: ${e.message}`)
      }
    }
  } else {
    if (capturedBody) {
      errors.push('negative fixture should fail closed with 0 upstream dispatches')
    }
  }

  return {
    id: sample.id,
    source: sample.source,
    protocol: sample.protocol,
    originNote: sample.originNote,
    status: res.statusCode,
    expectStatus: sample.expectStatus,
    ok: errors.length === 0,
    errors,
    outboundBody: capturedBody,
    toolCount: cragCheck?.declaredTools?.length || 0,
    turnCount: Array.isArray(capturedBody?.contents) ? capturedBody.contents.length : 0,
  }
}

// ---------------------------------------------------------------------------
// 6b. Faithful Per-Account CRAGGemini SessionStore (mirrors src/resume.rs)
//     + Resume & Account-Switch Continuity Suite
// ---------------------------------------------------------------------------

const ACCOUNT_SCOPED_CONV_RE = /^gc_[a-f0-9]{24}$/

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function cragCanonicalToolResultDigest(tr) {
  const h = crypto.createHash('sha256')
  h.update(String(tr.callId || ''))
  h.update('|')
  h.update(String(tr.name || ''))
  h.update('|')
  h.update(tr.isError ? 'err' : 'ok')
  h.update('|')
  h.update(JSON.stringify(tr.content))
  return h.digest('hex')
}

function cragCanonicalMessageDigest(msg) {
  const h = crypto.createHash('sha256')
  h.update(msg.role)
  h.update('\0')
  h.update(msg.text.trim())
  for (const tc of msg.toolCalls) {
    h.update('\x1eTC:')
    h.update(tc.name)
    h.update(':')
    h.update(tc.argsDigest)
  }
  for (const tr of msg.toolResults) {
    h.update('\x1eTR:')
    h.update(cragCanonicalToolResultDigest(tr))
  }
  for (const md of msg.mediaDigests) {
    h.update('\x1eM:')
    h.update(md)
  }
  return h.digest('hex')
}

function cragChainDigests(digests) {
  const chain = []
  let prev = ''
  for (const d of digests) {
    const next = sha256Hex(`${prev}:${d}`)
    chain.push(next)
    prev = next
  }
  return chain
}

function parseGeminiContentsToCanonical(contents) {
  const out = []
  for (const entry of contents || []) {
    const rawRole = entry?.role || 'user'
    const msg = {
      role: rawRole === 'model' ? 'assistant' : rawRole,
      text: '',
      toolCalls: [],
      toolResults: [],
      mediaDigests: [],
      thoughtSignatures: [],
    }
    for (const part of entry?.parts || []) {
      const sig = part?.thoughtSignature ?? part?.thought_signature
      if (typeof sig === 'string' && sig) msg.thoughtSignatures.push(sig)
      if (typeof part?.text === 'string' && part.thought !== true) msg.text += part.text
      const inline = part?.inlineData ?? part?.inline_data
      if (isPlainObject(inline) && inline.data) {
        msg.mediaDigests.push(sha256Hex(String(inline.data).trim()))
      }
      const fc = part?.functionCall ?? part?.function_call
      if (isPlainObject(fc) && typeof fc.name === 'string') {
        msg.toolCalls.push({
          id: typeof fc.id === 'string' ? fc.id : null,
          name: fc.name,
          argsDigest: sha256Hex(JSON.stringify(fc.args ?? {})),
        })
      }
      const fr = part?.functionResponse ?? part?.function_response
      if (isPlainObject(fr) && fr.response !== undefined) {
        const resp = fr.response
        msg.toolResults.push({
          callId: typeof fr.id === 'string' ? fr.id : null,
          name: typeof fr.name === 'string' ? fr.name : null,
          content: resp,
          isError: Boolean(isPlainObject(resp) && (resp.is_error || resp.isError)),
        })
      }
    }
    out.push(msg)
  }
  return out
}

function cragFormatHistoryPreamble(messages) {
  const lines = []
  for (const msg of messages) {
    const role = msg.role === 'assistant' || msg.role === 'model' ? 'Assistant' : msg.role === 'tool' ? 'Tool' : 'User'
    if (msg.text.trim()) lines.push(`${role}: ${msg.text.trim()}`)
    for (const tc of msg.toolCalls) lines.push(`${role} called tool \`${tc.name}\``)
    for (const tr of msg.toolResults) {
      lines.push(`Tool \`${tr.name || 'tool'}\` returned: ${JSON.stringify(tr.content)}`)
    }
  }
  return lines.join('\n')
}

function cragFormatMessagesForDelta(messages) {
  if (messages.length === 1 && messages[0].toolResults.length === 0) return messages[0].text
  const parts = []
  for (const msg of messages) {
    if (msg.text.trim()) parts.push(msg.text)
    for (const tr of msg.toolResults) {
      parts.push(`[Tool Result \`${tr.name || 'tool'}\`]: ${JSON.stringify(tr.content)}`)
    }
  }
  return parts.join('\n')
}

function cragBuildDelta(messages, matchedLen, liveHoldsHistory) {
  if (matchedLen > 0 && liveHoldsHistory) {
    return { deltaText: cragFormatMessagesForDelta(messages.slice(matchedLen)), historyPreamble: null }
  }
  if (messages.length === 1) {
    return { deltaText: messages[0].text, historyPreamble: null }
  }
  const last = messages[messages.length - 1]
  const prior = messages.slice(0, -1)
  const preamble = cragFormatHistoryPreamble(prior)
  const deltaText = !last.text.trim() && last.toolResults.length > 0 ? cragFormatMessagesForDelta([last]) : last.text
  return { deltaText, historyPreamble: preamble || null }
}

function cragTrailingToolResults(messages) {
  const results = []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].toolResults.length > 0) {
      results.push(...[...messages[i].toolResults].reverse())
    } else {
      break
    }
  }
  return results.reverse()
}

function cragMatchHistory(rec, incomingChain, incomingAnchors) {
  const maxPrefix = Math.min(rec.chain.length, Math.max(0, incomingChain.length - 1))
  let matchedPrefix = 0
  for (let i = 0; i < maxPrefix; i += 1) {
    if (rec.chain[i] === incomingChain[i]) matchedPrefix = i + 1
    else break
  }
  if (matchedPrefix > 0) {
    return [matchedPrefix, matchedPrefix === rec.chain.length ? 'digest_prefix' : 'digest_rewind']
  }
  let bestAnchor = null
  for (const [anchorHash, incomingIdx] of incomingAnchors) {
    if (rec.anchors.has(anchorHash) && incomingIdx + 1 < incomingChain.length) {
      if (bestAnchor == null || incomingIdx + 1 > bestAnchor) bestAnchor = incomingIdx + 1
    }
  }
  if (bestAnchor != null) return [bestAnchor, 'thought_signature_anchor']
  return [0, 'none']
}

/** Faithful JS mirror of `X:/antigravity-cli-proxy/src/resume.rs::SessionStore`. */
class MockCragGeminiSessionStore {
  constructor(accountId) {
    this.accountId = accountId
    this.activeConversationId = null
    this.conversations = []
    this.pendingTools = []
  }

  find(convId) {
    return this.conversations.find((c) => c.conversationId === convId || c.nativeConversationId === convId) || null
  }

  createRecord(customId) {
    const conversationId = customId || `conv_${crypto.randomBytes(16).toString('hex')}`
    const nativeConversationId = `native_${this.accountId}_${conversationId}`
    const rec = {
      conversationId,
      nativeConversationId,
      turnCount: 0,
      status: 'idle',
      digests: [],
      chain: [],
      anchors: new Map(),
      pendingToolCalls: [],
    }
    this.conversations.push(rec)
    this.activeConversationId = conversationId
    return rec
  }

  resolve(requestedConvId, forceNew, canonicalMsgs) {
    if (!canonicalMsgs.length) throw new Error('empty messages')
    const incomingDigests = canonicalMsgs.map(cragCanonicalMessageDigest)
    const incomingChain = cragChainDigests(incomingDigests)
    const incomingAnchors = []
    canonicalMsgs.forEach((m, idx) => {
      for (const sig of m.thoughtSignatures) {
        if (sig) incomingAnchors.push([sha256Hex(sig), idx])
      }
    })

    // 1. Suspended MCP tool continuation check
    const lastResults = cragTrailingToolResults(canonicalMsgs)
    if (lastResults.length > 0 && this.pendingTools.length > 0) {
      const matches = lastResults.some((tr) =>
        this.pendingTools.some(
          (p) => (tr.callId && tr.callId === p.callId) || (tr.name && (tr.name === p.name || tr.name === p.safeName)),
        ),
      )
      if (matches) {
        const rec =
          (requestedConvId && this.find(requestedConvId)) ||
          (this.activeConversationId && this.find(this.activeConversationId)) ||
          this.createRecord(null)
        return {
          kind: 'ToolContinuation',
          conversationId: rec.conversationId,
          nativeConversationId: rec.nativeConversationId,
          matchedBy: 'tool_continuation',
          toolResults: lastResults,
          incomingDigests,
          deltaText: null,
          historyPreamble: null,
        }
      }
    }

    // 2. Explicit conversation_id lookup (matches resume.rs lines 283-318)
    if (!forceNew && typeof requestedConvId === 'string' && requestedConvId.trim()) {
      const existing = this.find(requestedConvId)
      if (existing) {
        const [matchedLen, matchedBy] = cragMatchHistory(existing, incomingChain, incomingAnchors)
        const { deltaText, historyPreamble } = cragBuildDelta(canonicalMsgs, matchedLen, true)
        this.activeConversationId = existing.conversationId
        return {
          kind: 'LiveDelta',
          conversationId: existing.conversationId,
          nativeConversationId: existing.nativeConversationId,
          matchedBy: matchedLen > 0 ? matchedBy : 'explicit_id',
          matchedLen,
          deltaText,
          historyPreamble,
          incomingDigests,
        }
      }
      if (!VALID_ID_RE.test(requestedConvId)) throw new Error(`invalid conversation_id: ${requestedConvId}`)
      const created = this.createRecord(requestedConvId)
      const { deltaText, historyPreamble } = cragBuildDelta(canonicalMsgs, 0, false)
      return {
        kind: 'LiveDelta',
        conversationId: created.conversationId,
        nativeConversationId: created.nativeConversationId,
        matchedBy: 'new_explicit',
        matchedLen: 0,
        deltaText,
        historyPreamble,
        incomingDigests,
      }
    }

    const created = this.createRecord(null)
    const { deltaText, historyPreamble } = cragBuildDelta(canonicalMsgs, 0, false)
    return {
      kind: 'LiveDelta',
      conversationId: created.conversationId,
      nativeConversationId: created.nativeConversationId,
      matchedBy: canonicalMsgs.length > 1 ? 'cold_seeded' : 'new_session',
      matchedLen: 0,
      deltaText,
      historyPreamble,
      incomingDigests,
    }
  }

  markSuspendedTools(convId, incomingDigests, pendingTools) {
    const rec = this.find(convId)
    if (rec) {
      rec.digests = [...incomingDigests]
      rec.chain = cragChainDigests(rec.digests)
      rec.status = 'awaiting_tool_results'
      rec.pendingToolCalls = [...pendingTools]
    }
    this.pendingTools = [...pendingTools]
  }

  commitTurn(convId, incomingDigests, assistantText) {
    const rec = this.find(convId)
    if (rec) {
      rec.digests = [...incomingDigests]
      if (assistantText) {
        const asstMsg = {
          role: 'assistant',
          text: assistantText,
          toolCalls: [],
          toolResults: [],
          mediaDigests: [],
          thoughtSignatures: [],
        }
        rec.digests.push(cragCanonicalMessageDigest(asstMsg))
      }
      rec.chain = cragChainDigests(rec.digests)
      rec.turnCount += 1
      rec.status = 'idle'
      rec.pendingToolCalls = []
    }
    this.pendingTools = []
  }
}

function createMultiAccountResumeHarness({ accountIds = ['env-a', 'env-b'], hostBatch = [] } = {}) {
  let nowMs = 1_700_000_000_000
  let failAccounts = new Set()
  let nextToolCallSpec = null
  const stores = new Map(accountIds.map((id) => [id, new MockCragGeminiSessionStore(id)]))
  const convOwner = new Map() // conversation_id -> accountId (detects cross-account leakage!)
  const crossAccountLeaks = []
  const records = []

  const scheduler = createGeminiScheduler({
    now: () => nowMs,
    quotaCooldownMs: 30_000,
    callHost: async (op, payload) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: accountIds.map((id) => ({
            id,
            proxy_id: `proxy-${id}`,
            auth_state: 'authorized',
            auth_method: 'oauth',
            models_discovered: true,
            models: [DEFAULT_MODEL],
            capabilities: [...NATIVE_TUI_CAPABILITIES],
          })),
        }
      }
      if (op === 'get') return { id: payload.id, proxy_id: `proxy-${payload.id}`, auth_method: 'oauth' }
      if (op === 'infer-cancel') return { cancelled: true }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async (_op, payload) => {
      const accountId = payload.id
      const body = payload.body
      const convId = body?.conversation_id || null
      const contract = validateCragGeminiContract(body, { expectedModel: DEFAULT_MODEL, strictMinimal: true })
      const rec = {
        seq: records.length + 1,
        accountId,
        requestId: payload.request_id,
        convId,
        body,
        contract,
        failedStatus: null,
        decision: null,
        replyText: null,
      }
      records.push(rec)

      if (convId) {
        const prevOwner = convOwner.get(convId)
        if (prevOwner && prevOwner !== accountId) {
          crossAccountLeaks.push(`conversation_id "${convId}" reused across accounts (${prevOwner} -> ${accountId})`)
        } else if (!prevOwner) {
          convOwner.set(convId, accountId)
        }
      }

      if (failAccounts.has(accountId)) {
        rec.failedStatus = 429
        const r = Readable.from([
          Buffer.from(JSON.stringify({ code: 'gemini_quota_exhausted', message: 'rate limited' }), 'utf8'),
        ])
        r.statusCode = 429
        r.headers = { 'content-type': 'application/json' }
        return r
      }

      hostBatch.push({ id: `resume:turn-${rec.seq}:${accountId}`, model: DEFAULT_MODEL, body })

      const store = stores.get(accountId)
      const canonical = parseGeminiContentsToCanonical(body?.contents)
      const decision = store.resolve(convId, false, canonical)
      rec.decision = decision

      if (nextToolCallSpec) {
        const spec = nextToolCallSpec
        nextToolCallSpec = null
        store.markSuspendedTools(decision.conversationId, decision.incomingDigests, [
          { callId: spec.callId, name: spec.name, safeName: `mcp__craggemini__${spec.name}` },
        ])
        return sseStream([
          `data: ${JSON.stringify({
            craggeminiMeta: {
              conversation_id: decision.conversationId,
              native_conversation_id: decision.nativeConversationId,
              awaiting_tool_results: true,
            },
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        id: spec.callId,
                        name: `mcp__craggemini__${spec.name}`,
                        args: spec.args || {},
                      },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 16, candidatesTokenCount: 6, totalTokenCount: 22 },
          })}\n\n`,
        ])
      }

      const replyText = `ok-turn-${rec.seq}-acc-${accountId}`
      rec.replyText = replyText
      store.commitTurn(decision.conversationId, decision.incomingDigests, replyText)
      return sseStream([
        `data: ${JSON.stringify({
          craggeminiMeta: {
            conversation_id: decision.conversationId,
            native_conversation_id: decision.nativeConversationId,
            awaiting_tool_results: false,
          },
          candidates: [
            {
              content: { role: 'model', parts: [{ text: replyText }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 6, totalTokenCount: 24 },
        })}\n\n`,
      ])
    },
    resolveProxy: () => 'socks5h://127.0.0.1:1080',
  })

  const handler = createGeminiPublicHandler({
    json: (res, status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    },
    readBody: async (req) => req.body,
    scheduler,
  })

  return {
    records,
    crossAccountLeaks,
    setFailAccounts(ids) {
      failAccounts = new Set(ids)
    },
    advanceMs(ms) {
      nowMs += ms
    },
    setNextToolCall(spec) {
      nextToolCallSpec = spec
    },
    async post({ url, body, headers = {} }) {
      const before = records.length
      const res = makeRes()
      await handler(makeReq({ url, body, headers }), res)
      const attempts = records.slice(before)
      const okRec = attempts.find((a) => a.failedStatus == null) || null
      return {
        status: res.statusCode,
        json:
          res.statusCode === 200 && !String(res.headers['content-type'] || '').includes('text/event-stream')
            ? res.jsonBody()
            : null,
        raw: res.chunks.join(''),
        attempts,
        okRec,
      }
    },
  }
}

function extractReplyTextFromJson(protocol, json) {
  if (!json) return ''
  if (protocol === 'gemini') return json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''
  if (protocol === 'openai-chat') return json.choices?.[0]?.message?.content || ''
  if (protocol === 'anthropic') return json.content?.map((b) => b.text || '').join('') || ''
  if (protocol === 'openai-responses') {
    return (json.output || [])
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content || [])
      .map((c) => c.text || '')
      .join('')
  }
  return ''
}

function buildProtocolTurnBody(protocol, history, extra = {}) {
  if (protocol === 'gemini') {
    return {
      contents: history.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.text }],
      })),
      ...extra,
    }
  }
  if (protocol === 'openai-chat') {
    return {
      model: DEFAULT_MODEL,
      messages: history.map((m) => ({ role: m.role, content: m.text })),
      ...extra,
    }
  }
  if (protocol === 'anthropic') {
    return {
      model: DEFAULT_MODEL,
      max_tokens: 512,
      messages: history.map((m) => ({ role: m.role, content: m.text })),
      ...extra,
    }
  }
  if (protocol === 'openai-responses') {
    return {
      model: DEFAULT_MODEL,
      input: history.map((m) => ({
        type: 'message',
        role: m.role,
        content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.text }],
      })),
      ...extra,
    }
  }
  throw new Error(`unknown protocol: ${protocol}`)
}

function protocolUrlFor(protocol) {
  if (protocol === 'gemini') return `/v1beta/models/${DEFAULT_MODEL}:generateContent`
  if (protocol === 'openai-chat') return '/v1/chat/completions'
  if (protocol === 'anthropic') return '/v1/messages'
  if (protocol === 'openai-responses') return '/v1/responses'
  throw new Error(`unknown protocol: ${protocol}`)
}

function loadRealProgressiveSessions({ claudeDir, codexDir, geminiDir, maxPerCli = 3 }) {
  const out = []

  // Claude Code real sessions (extract >= 5 distinct user text turns without leaking raw text in reports)
  for (const file of pickRepresentativeFiles(walkFiles(claudeDir, /\.jsonl$/), 30)) {
    if (out.filter((x) => x.cli === 'claude').length >= maxPerCli) break
    const userTexts = []
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      const msg = row?.message
      if (msg?.role !== 'user') continue
      let text = ''
      if (typeof msg.content === 'string') text = msg.content.trim()
      else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text.trim())
          .filter(Boolean)
          .join('\n')
      }
      if (text && text.length >= 2) userTexts.push(text.slice(0, 600))
      if (userTexts.length >= 6) break
    }
    if (userTexts.length >= 5) {
      out.push({
        cli: 'claude',
        protocol: 'anthropic',
        sessionTag: `claude:${path.basename(file, '.jsonl').slice(0, 10)}`,
        userTurns: userTexts.slice(0, 6),
      })
    }
  }

  // Codex CLI real sessions
  for (const file of pickRepresentativeFiles(walkFiles(codexDir, /\.jsonl$/), 30)) {
    if (out.filter((x) => x.cli === 'codex').length >= maxPerCli) break
    const userTexts = []
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (row?.type !== 'response_item' || row.payload?.type !== 'message' || row.payload?.role !== 'user') continue
      const text = Array.isArray(row.payload.content)
        ? row.payload.content
            .filter((b) => (b?.type === 'input_text' || b?.type === 'text') && typeof b.text === 'string')
            .map((b) => b.text.trim())
            .filter(Boolean)
            .join('\n')
        : ''
      if (text && text.length >= 2) userTexts.push(text.slice(0, 600))
      if (userTexts.length >= 6) break
    }
    if (userTexts.length >= 5) {
      out.push({
        cli: 'codex',
        protocol: 'openai-responses',
        sessionTag: `codex:${path.basename(file, '.jsonl').slice(-10)}`,
        userTurns: userTexts.slice(0, 6),
      })
    }
  }

  // Gemini CLI real sessions
  for (const file of pickRepresentativeFiles(walkFiles(geminiDir, /^session-.*\.json$/), 30)) {
    if (out.filter((x) => x.cli === 'gemini').length >= maxPerCli) break
    let doc
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const userTexts = []
    for (const m of Array.isArray(doc?.messages) ? doc.messages : []) {
      if (m?.type !== 'user') continue
      const text =
        typeof m.content === 'string'
          ? m.content.trim()
          : Array.isArray(m.content)
            ? m.content
                .map((p) => (typeof p === 'string' ? p : p?.text || ''))
                .join('\n')
                .trim()
            : ''
      if (text && text.length >= 2) userTexts.push(text.slice(0, 600))
      if (userTexts.length >= 6) break
    }
    if (userTexts.length >= 5) {
      out.push({
        cli: 'gemini',
        protocol: 'gemini',
        sessionTag: `gemini:${path.basename(file, '.json').slice(-10)}`,
        userTurns: userTexts.slice(0, 6),
      })
    }
  }

  return out
}

async function runResumeAndAccountSwitchSuite({ claudeDir, codexDir, geminiDir, hostBatch = [] }) {
  const scenarios = []

  const runCase = async (name, fn) => {
    const errors = []
    try {
      await fn(errors)
    } catch (err) {
      errors.push(err?.message || String(err))
    }
    scenarios.push({ name, ok: errors.length === 0, errors })
  }

  // 1. Same-account resume across all 4 protocols (gemini, openai-chat, openai-responses, anthropic)
  for (const protocol of ['gemini', 'openai-chat', 'openai-responses', 'anthropic']) {
    await runCase(`resume:same-account:${protocol}`, async (errors) => {
      const h = createMultiAccountResumeHarness({ hostBatch })
      const url = protocolUrlFor(protocol)
      const headers = { 'x-session-id': `sess-${protocol}-sticky` }
      const history = [{ role: 'user', text: `Turn 1 start on ${protocol}` }]

      const t1 = await h.post({ url, body: buildProtocolTurnBody(protocol, history), headers })
      if (t1.status !== 200 || !t1.okRec) return errors.push(`turn 1 failed (status=${t1.status})`)
      if (!t1.okRec.contract.ok) errors.push(`turn 1 contract: ${t1.okRec.contract.errors.join('; ')}`)
      const c1 = t1.okRec.convId
      if (!ACCOUNT_SCOPED_CONV_RE.test(c1 || '')) errors.push(`turn 1 invalid outbound conversation_id: ${c1}`)
      if (t1.okRec.decision.matchedBy !== 'new_explicit') {
        errors.push(`turn 1 expected new_explicit, got ${t1.okRec.decision.matchedBy}`)
      }
      history.push({ role: 'assistant', text: extractReplyTextFromJson(protocol, t1.json) })
      history.push({ role: 'user', text: `Turn 2 follow up on ${protocol}` })

      const t2 = await h.post({ url, body: buildProtocolTurnBody(protocol, history), headers })
      if (t2.status !== 200 || !t2.okRec) return errors.push(`turn 2 failed (status=${t2.status})`)
      if (t2.okRec.accountId !== t1.okRec.accountId) errors.push('turn 2 did not stick to same account')
      if (t2.okRec.convId !== c1)
        errors.push(`turn 2 changed conversation_id on same account (${c1} -> ${t2.okRec.convId})`)
      if (t2.okRec.decision.matchedBy !== 'digest_prefix') {
        errors.push(`turn 2 expected digest_prefix resume, got ${t2.okRec.decision.matchedBy}`)
      }
      if (t2.okRec.decision.historyPreamble !== null) {
        errors.push('turn 2 live resume should omit historyPreamble (delta-only)')
      }
      history.push({ role: 'assistant', text: extractReplyTextFromJson(protocol, t2.json) })
      history.push({ role: 'user', text: `Turn 3 follow up on ${protocol}` })

      const t3 = await h.post({ url, body: buildProtocolTurnBody(protocol, history), headers })
      if (t3.status !== 200 || !t3.okRec) return errors.push(`turn 3 failed (status=${t3.status})`)
      if (t3.okRec.accountId !== t1.okRec.accountId || t3.okRec.convId !== c1) {
        errors.push('turn 3 failed to preserve account/conversation_id')
      }
      if (t3.okRec.decision.matchedBy !== 'digest_prefix' || t3.okRec.decision.historyPreamble !== null) {
        errors.push(`turn 3 expected live digest_prefix delta-only, got ${t3.okRec.decision.matchedBy}`)
      }
      if (h.crossAccountLeaks.length) errors.push(...h.crossAccountLeaks)
    })
  }

  // 2. Account switch A -> B -> A with fixed caller conversation_id (must remint on EVERY switch & preserve history!)
  await runCase('resume:account-switch:A->B->A:explicit-caller-conv', async (errors) => {
    const h = createMultiAccountResumeHarness({ hostBatch })
    const callerConv = 'caller-sticky-conv-001'
    const url = protocolUrlFor('openai-chat')
    const history = [{ role: 'user', text: 'Phase 1 establish secret token ALPHA-7' }]

    // Turn 1: env-a -> C1
    const t1 = await h.post({
      url,
      body: buildProtocolTurnBody('openai-chat', history, { conversation_id: callerConv }),
    })
    const c1 = t1.okRec?.convId
    if (!t1.okRec || t1.okRec.accountId !== 'env-a') errors.push('turn 1 expected env-a')
    if (!ACCOUNT_SCOPED_CONV_RE.test(c1 || '') || c1 === callerConv) {
      errors.push(`turn 1 must mint account-scoped conv_id != callerConv, got ${c1}`)
    }
    const a1 = extractReplyTextFromJson('openai-chat', t1.json)
    history.push({ role: 'assistant', text: a1 }, { role: 'user', text: 'Phase 2 confirm token ALPHA-7' })

    // Turn 2: env-a -> same C1, digest_prefix live resume
    const t2 = await h.post({
      url,
      body: buildProtocolTurnBody('openai-chat', history, { conversation_id: callerConv }),
    })
    if (
      t2.okRec?.accountId !== 'env-a' ||
      t2.okRec?.convId !== c1 ||
      t2.okRec?.decision?.matchedBy !== 'digest_prefix'
    ) {
      errors.push('turn 2 failed same-account digest_prefix resume on env-a')
    }
    const a2 = extractReplyTextFromJson('openai-chat', t2.json)
    history.push({ role: 'assistant', text: a2 }, { role: 'user', text: 'Phase 3 failover to env-b' })

    // Turn 3: env-a hits 429 -> intra-request failover to env-b -> MUST mint C2 !== C1 & cold-seed full history preamble
    h.setFailAccounts(['env-a'])
    const t3 = await h.post({
      url,
      body: buildProtocolTurnBody('openai-chat', history, { conversation_id: callerConv }),
    })
    if (t3.attempts.length !== 2 || t3.attempts[0].accountId !== 'env-a' || t3.attempts[1].accountId !== 'env-b') {
      errors.push(
        `turn 3 expected intra-request failover env-a->env-b, got ${t3.attempts.map((a) => a.accountId).join('->')}`,
      )
    }
    const c2 = t3.okRec?.convId
    if (!ACCOUNT_SCOPED_CONV_RE.test(c2 || '') || c2 === c1 || c2 === callerConv) {
      errors.push(`turn 3 account switch must mint fresh C2 != C1/callerConv (c1=${c1}, c2=${c2})`)
    }
    if (t3.okRec?.decision?.matchedBy !== 'new_explicit') {
      errors.push(`turn 3 on env-b expected new_explicit, got ${t3.okRec?.decision?.matchedBy}`)
    }
    const p3 = t3.okRec?.decision?.historyPreamble || ''
    if (!p3.includes('ALPHA-7') || !p3.includes(a1) || !p3.includes(a2)) {
      errors.push('turn 3 failover historyPreamble missing prior turns from env-a')
    }
    const a3 = extractReplyTextFromJson('openai-chat', t3.json)
    history.push({ role: 'assistant', text: a3 }, { role: 'user', text: 'Phase 4 resume on env-b' })

    // Turn 4: stays on env-b -> same C2, digest_prefix live resume
    const t4 = await h.post({
      url,
      body: buildProtocolTurnBody('openai-chat', history, { conversation_id: callerConv }),
    })
    if (
      t4.okRec?.accountId !== 'env-b' ||
      t4.okRec?.convId !== c2 ||
      t4.okRec?.decision?.matchedBy !== 'digest_prefix' ||
      t4.okRec?.decision?.historyPreamble !== null
    ) {
      errors.push('turn 4 failed live digest_prefix resume on env-b')
    }
    const a4 = extractReplyTextFromJson('openai-chat', t4.json)
    history.push({ role: 'assistant', text: a4 }, { role: 'user', text: 'Phase 5 switch back to env-a' })

    // Turn 5: env-a exits cooldown, env-b hits 429 -> switch BACK env-b -> env-a! MUST mint C3 !== C2 AND C3 !== C1!
    h.advanceMs(60_000)
    h.setFailAccounts(['env-b'])
    const t5 = await h.post({
      url,
      body: buildProtocolTurnBody('openai-chat', history, { conversation_id: callerConv }),
    })
    const c3 = t5.okRec?.convId
    if (t5.okRec?.accountId !== 'env-a') errors.push(`turn 5 expected return to env-a, got ${t5.okRec?.accountId}`)
    if (!ACCOUNT_SCOPED_CONV_RE.test(c3 || '') || c3 === c2 || c3 === c1 || c3 === callerConv) {
      errors.push(`turn 5 return switch MUST mint 3rd fresh C3 != C2 & != C1 (c1=${c1}, c2=${c2}, c3=${c3})`)
    }
    if (t5.okRec?.decision?.matchedBy !== 'new_explicit') {
      errors.push(`turn 5 expected new_explicit on fresh C3, got ${t5.okRec?.decision?.matchedBy}`)
    }
    const p5 = t5.okRec?.decision?.historyPreamble || ''
    if (!p5.includes('ALPHA-7') || !p5.includes(a3) || !p5.includes(a4)) {
      errors.push('turn 5 return switch historyPreamble missing turns from env-b')
    }
    const a5 = extractReplyTextFromJson('openai-chat', t5.json)
    history.push({ role: 'assistant', text: a5 }, { role: 'user', text: 'Phase 6 resume C3 on env-a' })

    // Turn 6: resumes C3 on env-a with digest_prefix
    const t6 = await h.post({
      url,
      body: buildProtocolTurnBody('openai-chat', history, { conversation_id: callerConv }),
    })
    if (
      t6.okRec?.accountId !== 'env-a' ||
      t6.okRec?.convId !== c3 ||
      t6.okRec?.decision?.matchedBy !== 'digest_prefix' ||
      t6.okRec?.decision?.historyPreamble !== null
    ) {
      errors.push('turn 6 failed live digest_prefix resume on C3')
    }
    if (h.crossAccountLeaks.length) errors.push(...h.crossAccountLeaks)
  })

  // 3. Stateless clients (Anthropic without headers + OpenAI Responses with rotating previous_response_id)
  for (const protocol of ['anthropic', 'openai-responses']) {
    await runCase(`resume:stateless-switch:${protocol}`, async (errors) => {
      const h = createMultiAccountResumeHarness({ hostBatch })
      const url = protocolUrlFor(protocol)
      const history = [{ role: 'user', text: `Stateless seed ${protocol} K9` }]

      const t1 = await h.post({ url, body: buildProtocolTurnBody(protocol, history) })
      const c1 = t1.okRec?.convId
      const a1 = extractReplyTextFromJson(protocol, t1.json)
      history.push({ role: 'assistant', text: a1 }, { role: 'user', text: 'Stateless turn 2' })

      const extra2 = protocol === 'openai-responses' && t1.json?.id ? { previous_response_id: t1.json.id } : {}
      const t2 = await h.post({ url, body: buildProtocolTurnBody(protocol, history, extra2) })
      if (t2.okRec?.accountId !== t1.okRec?.accountId || t2.okRec?.convId !== c1) {
        errors.push(`stateless ${protocol} turn 2 lost sticky binding`)
      }
      if (t2.okRec?.decision?.matchedBy !== 'digest_prefix') {
        errors.push(`stateless ${protocol} turn 2 expected digest_prefix, got ${t2.okRec?.decision?.matchedBy}`)
      }
      const a2 = extractReplyTextFromJson(protocol, t2.json)
      history.push({ role: 'assistant', text: a2 }, { role: 'user', text: 'Stateless turn 3 failover' })

      h.setFailAccounts([t1.okRec.accountId])
      const extra3 = protocol === 'openai-responses' && t2.json?.id ? { previous_response_id: t2.json.id } : {}
      const t3 = await h.post({ url, body: buildProtocolTurnBody(protocol, history, extra3) })
      const c2 = t3.okRec?.convId
      if (!t3.okRec || t3.okRec.accountId === t1.okRec.accountId) errors.push('stateless turn 3 did not fail over')
      if (!ACCOUNT_SCOPED_CONV_RE.test(c2 || '') || c2 === c1) {
        errors.push(`stateless failover failed to remint conv_id (c1=${c1}, c2=${c2})`)
      }
      if (
        t3.okRec?.decision?.matchedBy !== 'new_explicit' ||
        !(t3.okRec?.decision?.historyPreamble || '').includes('K9')
      ) {
        errors.push('stateless failover missing cold-seeded history preamble')
      }
      if (h.crossAccountLeaks.length) errors.push(...h.crossAccountLeaks)
    })
  }

  // 4. Suspended MCP Tool Continuation: same-account ToolContinuation AND account-switch failover
  await runCase('resume:mcp-tool-continuation:same-and-failover', async (errors) => {
    const h = createMultiAccountResumeHarness({ hostBatch })
    const url = protocolUrlFor('openai-chat')
    const tools = [
      {
        type: 'function',
        function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
      },
    ]

    // 4a. Same-account happy path: Turn 1 suspends on env-a, Turn 2 hits ToolContinuation with SAME convId
    h.setNextToolCall({ callId: 'call_ok_1', name: 'get_weather', args: { city: 'Tokyo' } })
    const s1 = await h.post({
      url,
      headers: { 'x-session-id': 'mcp-happy-1' },
      body: { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'Weather Tokyo' }], tools },
    })
    const cHappy = s1.okRec?.convId
    const s1CallId = s1.json?.choices?.[0]?.message?.tool_calls?.[0]?.id
    if (!s1CallId) return errors.push('mcp happy turn 1 missing tool_call')

    const s2 = await h.post({
      url,
      headers: { 'x-session-id': 'mcp-happy-1' },
      body: {
        model: DEFAULT_MODEL,
        tools,
        messages: [
          { role: 'user', content: 'Weather Tokyo' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: s1CallId, type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } },
            ],
          },
          { role: 'tool', tool_call_id: s1CallId, content: '{"temp_c":21}' },
        ],
      },
    })
    if (s2.okRec?.accountId !== s1.okRec?.accountId || s2.okRec?.convId !== cHappy) {
      errors.push('mcp happy turn 2 did not preserve account/conversation_id')
    }
    if (s2.okRec?.decision?.kind !== 'ToolContinuation') {
      errors.push(`mcp happy turn 2 expected ToolContinuation, got ${s2.okRec?.decision?.kind}`)
    }

    // 4b. Failover path: Turn 1 suspends on env-a, env-a returns 429 on Turn 2 -> env-b gets brand-new convId + full tool history!
    h.setNextToolCall({ callId: 'call_fail_2', name: 'get_weather', args: { city: 'Osaka' } })
    const f1 = await h.post({
      url,
      headers: { 'x-session-id': 'mcp-failover-2' },
      body: { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'Weather Osaka' }], tools },
    })
    const cOrig = f1.okRec?.convId
    const f1Acc = f1.okRec?.accountId
    const f1CallId = f1.json?.choices?.[0]?.message?.tool_calls?.[0]?.id
    if (!f1CallId) return errors.push('mcp failover turn 1 missing tool_call')

    h.setFailAccounts([f1Acc])
    const f2 = await h.post({
      url,
      headers: { 'x-session-id': 'mcp-failover-2' },
      body: {
        model: DEFAULT_MODEL,
        tools,
        messages: [
          { role: 'user', content: 'Weather Osaka' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: f1CallId, type: 'function', function: { name: 'get_weather', arguments: '{"city":"Osaka"}' } },
            ],
          },
          { role: 'tool', tool_call_id: f1CallId, content: '{"temp_c":19}' },
        ],
      },
    })
    const cFailover = f2.okRec?.convId
    if (!f2.okRec || f2.okRec.accountId === f1Acc) errors.push('mcp failover turn 2 did not switch account')
    if (!ACCOUNT_SCOPED_CONV_RE.test(cFailover || '') || cFailover === cOrig) {
      errors.push(`mcp failover must remint conv_id (orig=${cOrig}, failover=${cFailover})`)
    }
    if (f2.okRec?.decision?.matchedBy !== 'new_explicit') {
      errors.push(`mcp failover expected new_explicit on new account, got ${f2.okRec?.decision?.matchedBy}`)
    }
    if (
      !(f2.okRec?.decision?.historyPreamble || '').includes('Weather Osaka') ||
      !(f2.okRec?.decision?.deltaText || '').includes('19')
    ) {
      errors.push('mcp failover missing tool history preamble or tool_result delta')
    }

    // Turn 3 after failover: stays on new account with cFailover (does NOT bounce back to f1Acc!)
    h.setFailAccounts([])
    const f3 = await h.post({
      url,
      headers: { 'x-session-id': 'mcp-failover-2' },
      body: {
        model: DEFAULT_MODEL,
        tools,
        messages: [
          { role: 'user', content: 'Weather Osaka' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: f1CallId, type: 'function', function: { name: 'get_weather', arguments: '{"city":"Osaka"}' } },
            ],
          },
          { role: 'tool', tool_call_id: f1CallId, content: '{"temp_c":19}' },
          { role: 'assistant', content: extractReplyTextFromJson('openai-chat', f2.json) },
          { role: 'user', content: 'Any umbrella needed?' },
        ],
      },
    })
    if (
      f3.okRec?.accountId !== f2.okRec?.accountId ||
      f3.okRec?.convId !== cFailover ||
      f3.okRec?.decision?.matchedBy !== 'digest_prefix'
    ) {
      errors.push('mcp post-failover turn 3 failed to resume on new account')
    }
    if (h.crossAccountLeaks.length) errors.push(...h.crossAccountLeaks)
  })

  // 5. Real local CLI progressive multi-turn resume & account-switch (A -> resume A -> switch B -> resume B -> switch A)
  const realSessions = loadRealProgressiveSessions({ claudeDir, codexDir, geminiDir, maxPerCli: 3 })
  for (const rs of realSessions) {
    await runCase(`resume:real-cli:${rs.sessionTag}`, async (errors) => {
      const h = createMultiAccountResumeHarness({ hostBatch })
      const url = protocolUrlFor(rs.protocol)
      const headers = { 'x-session-id': `real-${rs.sessionTag}` }
      const seenConvIds = new Set()
      const history = []

      // Step 1: Turn 1 on env-a -> C1 (new_explicit)
      history.push({ role: 'user', text: rs.userTurns[0] })
      const r1 = await h.post({ url, body: buildProtocolTurnBody(rs.protocol, history), headers })
      if (r1.status !== 200 || !r1.okRec) return errors.push(`step 1 failed (status=${r1.status})`)
      if (!r1.okRec.contract.ok) errors.push(`step 1 contract: ${r1.okRec.contract.errors.join('; ')}`)
      const acc1 = r1.okRec.accountId
      const c1 = r1.okRec.convId
      seenConvIds.add(c1)
      history.push({ role: 'assistant', text: extractReplyTextFromJson(rs.protocol, r1.json) })

      // Step 2: Turn 2 resume on env-a -> SAME C1 (digest_prefix, delta-only)
      history.push({ role: 'user', text: rs.userTurns[1] })
      const r2 = await h.post({ url, body: buildProtocolTurnBody(rs.protocol, history), headers })
      if (r2.status !== 200 || !r2.okRec) return errors.push(`step 2 failed (status=${r2.status})`)
      if (!r2.okRec.contract.ok) errors.push(`step 2 contract: ${r2.okRec.contract.errors.join('; ')}`)
      if (r2.okRec.accountId !== acc1 || r2.okRec.convId !== c1) {
        errors.push('step 2 failed same-account sticky resume')
      }
      if (r2.okRec.decision.matchedBy !== 'digest_prefix' || r2.okRec.decision.historyPreamble !== null) {
        errors.push(`step 2 expected digest_prefix delta-only, got ${r2.okRec.decision.matchedBy}`)
      }
      history.push({ role: 'assistant', text: extractReplyTextFromJson(rs.protocol, r2.json) })

      // Step 3: Turn 3 failover acc1 -> acc2 -> NEW C2 (new_explicit + non-empty historyPreamble)
      h.setFailAccounts([acc1])
      history.push({ role: 'user', text: rs.userTurns[2] })
      const r3 = await h.post({ url, body: buildProtocolTurnBody(rs.protocol, history), headers })
      if (r3.status !== 200 || !r3.okRec) return errors.push(`step 3 failed (status=${r3.status})`)
      if (!r3.okRec.contract.ok) errors.push(`step 3 contract: ${r3.okRec.contract.errors.join('; ')}`)
      const acc2 = r3.okRec.accountId
      const c2 = r3.okRec.convId
      if (acc2 === acc1) errors.push('step 3 did not switch account')
      if (!ACCOUNT_SCOPED_CONV_RE.test(c2 || '') || seenConvIds.has(c2)) {
        errors.push('step 3 did not mint unique conversation_id on account switch')
      }
      if (r3.okRec.decision.matchedBy !== 'new_explicit' || !r3.okRec.decision.historyPreamble) {
        errors.push(`step 3 expected new_explicit with historyPreamble, got ${r3.okRec.decision.matchedBy}`)
      }
      seenConvIds.add(c2)
      history.push({ role: 'assistant', text: extractReplyTextFromJson(rs.protocol, r3.json) })

      // Step 4: Turn 4 resume on acc2 -> SAME C2 (digest_prefix, delta-only)
      history.push({ role: 'user', text: rs.userTurns[3] })
      const r4 = await h.post({ url, body: buildProtocolTurnBody(rs.protocol, history), headers })
      if (r4.status !== 200 || !r4.okRec) return errors.push(`step 4 failed (status=${r4.status})`)
      if (!r4.okRec.contract.ok) errors.push(`step 4 contract: ${r4.okRec.contract.errors.join('; ')}`)
      if (r4.okRec.accountId !== acc2 || r4.okRec.convId !== c2) {
        errors.push('step 4 failed same-account sticky resume on acc2')
      }
      if (r4.okRec.decision.matchedBy !== 'digest_prefix' || r4.okRec.decision.historyPreamble !== null) {
        errors.push(`step 4 expected digest_prefix delta-only, got ${r4.okRec.decision.matchedBy}`)
      }
      history.push({ role: 'assistant', text: extractReplyTextFromJson(rs.protocol, r4.json) })

      // Step 5: Turn 5 switch BACK acc2 -> acc1 -> 3rd NEW C3 (not C1, not C2, new_explicit + non-empty historyPreamble)
      h.advanceMs(60_000)
      h.setFailAccounts([acc2])
      history.push({ role: 'user', text: rs.userTurns[4] })
      const r5 = await h.post({ url, body: buildProtocolTurnBody(rs.protocol, history), headers })
      if (r5.status !== 200 || !r5.okRec) return errors.push(`step 5 failed (status=${r5.status})`)
      if (!r5.okRec.contract.ok) errors.push(`step 5 contract: ${r5.okRec.contract.errors.join('; ')}`)
      const c3 = r5.okRec.convId
      if (r5.okRec.accountId !== acc1) errors.push('step 5 did not switch back to acc1')
      if (!ACCOUNT_SCOPED_CONV_RE.test(c3 || '') || seenConvIds.has(c3)) {
        errors.push('step 5 return switch reused a previous conversation_id')
      }
      if (r5.okRec.decision.matchedBy !== 'new_explicit' || !r5.okRec.decision.historyPreamble) {
        errors.push(`step 5 expected new_explicit with historyPreamble, got ${r5.okRec.decision.matchedBy}`)
      }
      if (h.crossAccountLeaks.length) errors.push(...h.crossAccountLeaks)
    })
  }

  return scenarios
}

// ---------------------------------------------------------------------------
// 7. Main Execution
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const want = (src) => !opts.only || opts.only.has(src)

  const samples = []
  if (want('standards')) samples.push(...loadStandardsCorpus(opts.standardsDir))
  if (want('packets')) samples.push(...loadPacketFixtures())
  if (want('claude')) {
    samples.push(
      ...loadClaudeSessions(opts.claudeDir, { limit: opts.limitPerSource, maxTurns: opts.maxTurnsPerSession }),
    )
  }
  if (want('codex')) {
    samples.push(...loadCodexSessions(opts.codexDir, { limit: opts.limitPerSource, maxTurns: opts.maxTurnsPerSession }))
  }
  if (want('gemini')) {
    samples.push(
      ...loadGeminiCliSessions(opts.geminiDir, { limit: opts.limitPerSource, maxTurns: opts.maxTurnsPerSession }),
    )
  }

  const parityGroups = want('parity') ? buildParityGroups() : []

  if (opts.list) {
    const counts = {}
    for (const s of samples) counts[s.source] = (counts[s.source] || 0) + 1
    counts.parity_groups = parityGroups.length
    console.log(JSON.stringify({ total_samples: samples.length, counts }, null, 2))
    return
  }

  const results = []
  const hostBatch = []

  // Run cross-protocol parity groups
  const parityResults = []
  for (const grp of parityGroups) {
    const cleanedByProto = {}
    const grpErrors = []
    for (const v of grp.variants) {
      const r = await runSampleThroughHandler({
        source: 'parity',
        id: `${grp.group}:${v.protocol}`,
        protocol: v.protocol,
        url: v.url,
        body: v.body,
        expectStatus: 200,
        stream: Boolean(v.body.stream) || v.url.includes('streamGenerateContent'),
        originNote: grp.group,
      })
      results.push(r)
      if (!r.ok) grpErrors.push(`${v.protocol}: ${r.errors.join('; ')}`)
      else if (r.outboundBody) {
        cleanedByProto[v.protocol] = r.outboundBody
        hostBatch.push({ id: r.id, model: DEFAULT_MODEL, body: r.outboundBody })
      }
    }
    // Compare all 4 cleaned CRAGGemini bodies for strict structural identity
    // (normalizing the per-session account-scoped `gc_<hex>` conversation_id after validating its format).
    const normalizeForParity = (body) => {
      if (!isPlainObject(body)) return body
      const copy = { ...body }
      if (typeof copy.conversation_id === 'string' && ACCOUNT_SCOPED_CONV_RE.test(copy.conversation_id)) {
        copy.conversation_id = '<account-scoped-session>'
      }
      return copy
    }
    const protos = Object.keys(cleanedByProto)
    if (protos.length === grp.variants.length) {
      for (const p of protos) {
        const cid = cleanedByProto[p]?.conversation_id
        if (!ACCOUNT_SCOPED_CONV_RE.test(cid || '')) {
          grpErrors.push(`${p}: missing or non-account-scoped conversation_id (${JSON.stringify(cid)})`)
        }
      }
      const refProto = protos[0]
      const refJson = JSON.stringify(normalizeForParity(cleanedByProto[refProto]))
      for (let i = 1; i < protos.length; i += 1) {
        const curProto = protos[i]
        const curJson = JSON.stringify(normalizeForParity(cleanedByProto[curProto]))
        if (curJson !== refJson) {
          grpErrors.push(`cross-protocol drift between ${refProto} and ${curProto}`)
        }
      }
    }
    parityResults.push({ group: grp.group, ok: grpErrors.length === 0, errors: grpErrors })
  }

  // Run all discovered corpus & real CLI session samples
  for (const sample of samples) {
    const r = await runSampleThroughHandler(sample)
    results.push(r)
    if (r.ok && r.outboundBody) {
      hostBatch.push({ id: r.id, model: DEFAULT_MODEL, body: r.outboundBody })
    }
  }

  // Run resume & account-switch continuity suite
  const resumeResults = want('resume')
    ? await runResumeAndAccountSwitchSuite({
        claudeDir: opts.claudeDir,
        codexDir: opts.codexDir,
        geminiDir: opts.geminiDir,
        hostBatch,
      })
    : []

  // Run Layer 2: real Python `scripts/gemini-host.py` `_extract_native_turn_body` batch check
  let hostPythonSummary = {
    skipped: opts.skipHostPython,
    checked: 0,
    passed: 0,
    failed: 0,
    idempotent: 0,
    failures: [],
  }
  if (!opts.skipHostPython && hostBatch.length > 0) {
    const pyOut = runHostPythonValidator(hostBatch)
    if (!pyOut.ok) {
      hostPythonSummary = {
        skipped: false,
        error: pyOut.error,
        checked: hostBatch.length,
        passed: 0,
        failed: hostBatch.length,
        idempotent: 0,
        failures: [{ id: '*', reason: pyOut.error }],
      }
    } else {
      hostPythonSummary.bin = pyOut.bin
      hostPythonSummary.checked = pyOut.results.length
      for (const item of pyOut.results) {
        if (item.ok) {
          hostPythonSummary.passed += 1
          if (item.sameKeys) hostPythonSummary.idempotent += 1
          else {
            hostPythonSummary.failures.push({
              id: item.id,
              reason: `host-py mutated keys (dropped=${JSON.stringify(item.droppedKeys)}, added=${JSON.stringify(item.addedKeys)})`,
            })
          }
        } else {
          hostPythonSummary.failed += 1
          hostPythonSummary.failures.push({ id: item.id, reason: item.reason })
        }
      }
    }
  }

  // Aggregate by source
  const bySource = {}
  for (const r of results) {
    const bucket = (bySource[r.source] ||= { total: 0, passed: 0, failed: 0, failures: [] })
    bucket.total += 1
    if (r.ok) bucket.passed += 1
    else {
      bucket.failed += 1
      bucket.failures.push({ id: r.id, protocol: r.protocol, originNote: r.originNote, errors: r.errors })
    }
  }

  const totalFailed =
    results.filter((r) => !r.ok).length +
    parityResults.filter((p) => !p.ok).length +
    resumeResults.filter((s) => !s.ok).length +
    hostPythonSummary.failed +
    hostPythonSummary.failures.length

  const report = {
    ok: totalFailed === 0,
    total_samples: results.length,
    passed_samples: results.filter((r) => r.ok).length,
    failed_samples: results.filter((r) => !r.ok).length,
    parity: parityResults,
    resume: resumeResults,
    by_source: bySource,
    host_python: hostPythonSummary,
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log('=== CRAGGemini Real-Session & Multi-Protocol Replay Verification ===')
    for (const [src, b] of Object.entries(bySource)) {
      const mark = b.failed === 0 ? 'PASS' : 'FAIL'
      console.log(`  [${mark}] ${src.padEnd(10)} ${b.passed}/${b.total}`)
      if (opts.verbose || b.failed > 0) {
        for (const f of b.failures.slice(0, 15)) {
          console.log(`      FAIL ${f.id} (${f.protocol}, ${f.originNote}): ${f.errors.join(' | ')}`)
        }
        if (b.failures.length > 15) console.log(`      ... +${b.failures.length - 15} more failures`)
      }
    }
    for (const p of parityResults) {
      const mark = p.ok ? 'PASS' : 'FAIL'
      console.log(
        `  [${mark}] ${p.group}${p.ok ? ' (4 protocols -> identical CRAGGemini body)' : `: ${p.errors.join(' | ')}`}`,
      )
    }
    if (resumeResults.length > 0) {
      const resumePassed = resumeResults.filter((s) => s.ok).length
      const resumeMark = resumePassed === resumeResults.length ? 'PASS' : 'FAIL'
      console.log(`  [${resumeMark}] resume+switch ${resumePassed}/${resumeResults.length} scenarios`)
      for (const s of resumeResults) {
        if (!s.ok || opts.verbose) {
          console.log(`      [${s.ok ? 'PASS' : 'FAIL'}] ${s.name}${s.ok ? '' : `: ${s.errors.join(' | ')}`}`)
        }
      }
    }
    if (!opts.skipHostPython) {
      const pyOk = hostPythonSummary.failed === 0 && hostPythonSummary.failures.length === 0
      console.log(
        `  [${pyOk ? 'PASS' : 'FAIL'}] gemini-host.py (${hostPythonSummary.bin || 'none'}): ${hostPythonSummary.passed}/${hostPythonSummary.checked} accepted, ${hostPythonSummary.idempotent}/${hostPythonSummary.checked} key-idempotent`,
      )
      for (const f of hostPythonSummary.failures.slice(0, 10)) {
        console.log(`      HOST-PY FAIL ${f.id}: ${f.reason}`)
      }
    }
    console.log(
      `\nSummary: ${report.passed_samples}/${report.total_samples} samples passed, ${resumeResults.filter((s) => s.ok).length}/${resumeResults.length} resume/switch scenarios passed, total_failures=${totalFailed}`,
    )
  }

  process.exit(totalFailed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
