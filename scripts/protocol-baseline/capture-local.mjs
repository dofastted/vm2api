#!/usr/bin/env node
/**
 * Local real-request recorder & sanitizer for vm2api protocol baseline.
 *
 * Modes:
 *   1) Transparent loopback proxy recorder:
 *      node scripts/protocol-baseline/capture-local.mjs \
 *        --listen 127.0.0.1:18787 --target http://127.0.0.1:8787 --out corpus.json
 *   2) Directory importer (rejects non-HTTP session transcripts, sanitizes secrets):
 *      node scripts/protocol-baseline/capture-local.mjs \
 *        --import /path/to/raw-json-dir --out corpus.json
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const SECRET_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-kin-internal-token',
  'x-internal-token',
])

const ALLOWED_CAPTURED_HEADERS = new Set([
  'content-type',
  'accept',
  'user-agent',
  'anthropic-version',
  'anthropic-beta',
  'x-app',
  'x-claude-code-session-id',
  'originator',
  'openai-beta',
  'session-id',
  'thread-id',
  'x-session-id',
  'x-conversation-id',
  'x-codex-beta-features',
  'x-codex-installation-id',
  'x-codex-turn-metadata',
  'x-codex-turn-state',
  'x-goog-api-client',
  'x-kin-cache-ttl',
])

const SECRET_RE = [
  [/\bsk-(?:ant|proj|live|test|or|key)-[A-Za-z0-9_-]{12,}\b/g, 'sk-fixture-redacted'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, 'AIzaFixtureRedactedKey000000000000'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer fixture-token'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'fixture@example.invalid'],
]

export function detectProtocolFromPath(rawPath = '') {
  const clean = String(rawPath).split('?')[0]
  if (clean === '/v1/messages' || clean === '/messages') return 'anthropic.messages'
  if (clean === '/v1/chat/completions' || clean === '/chat/completions') return 'openai.chat'
  if (clean === '/v1/completions' || clean === '/completions') return 'openai.completions'
  if (clean === '/v1/responses' || clean === '/responses') return 'openai.responses'
  if (/^\/(v1beta|v1)\/models\/[^/:]+:(generateContent|streamGenerateContent)$/.test(clean)) {
    return 'google.gemini'
  }
  return null
}

export function isValidHttpRequestBody(protocol, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  if (protocol === 'google.gemini') {
    return Array.isArray(body.contents) && body.contents.length > 0
  }
  if (typeof body.model !== 'string' || !body.model.trim()) return false
  if (protocol === 'anthropic.messages' || protocol === 'openai.chat') {
    return Array.isArray(body.messages) && body.messages.length > 0
  }
  if (protocol === 'openai.completions') return body.prompt != null
  if (protocol === 'openai.responses') return body.input != null
  return false
}

export function sanitizeString(str) {
  let out = String(str)
  for (const [re, repl] of SECRET_RE) out = out.replace(re, repl)
  return out
}

export function sanitizeValue(value) {
  if (typeof value === 'string') return sanitizeString(value)
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    const lk = k.toLowerCase()
    if (lk === 'api_key' || lk === 'authorization' || lk === 'access_token' || lk === 'refresh_token') {
      out[k] = 'fixture-redacted'
      continue
    }
    if (lk === 'user_id' && typeof v === 'string' && v.startsWith('{')) {
      try {
        const parsed = JSON.parse(v)
        out[k] = JSON.stringify({
          device_id: 'a'.repeat(64),
          account_uuid: '10000000-0000-4000-a000-000000000001',
          session_id: '20000000-0000-4000-a000-000000000002',
          ...(parsed.account_email ? { account_email: 'fixture@example.invalid' } : {}),
        })
        continue
      } catch {}
    }
    out[k] = sanitizeValue(v)
  }
  return out
}

export function sanitizeHeaders(rawHeaders = {}) {
  const out = {}
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    const lk = k.toLowerCase()
    if (SECRET_HEADERS.has(lk)) continue
    if (!ALLOWED_CAPTURED_HEADERS.has(lk) && !lk.startsWith('x-stainless-')) continue
    const val = Array.isArray(v) ? v.join(', ') : String(v ?? '')
    if (val) out[lk] = sanitizeString(val)
  }
  return out
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) args[key] = true
      else {
        args[key] = next
        i++
      }
    }
  }
  return args
}

function inferTargetFamily(protocol, body, rawPath) {
  const model = String(body?.model || '').toLowerCase()
  if (protocol === 'google.gemini' || /gemini|ag-/.test(model) || /\/v1beta\/models\//.test(rawPath)) {
    return 'gemini_craggemini'
  }
  if (/^(gpt-|o[134]-|codex)/.test(model)) return 'codex_kernel'
  return 'claude_crag'
}

function loadExisting(outPath) {
  if (!fs.existsSync(outPath)) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cases) ? parsed.cases : []
  } catch {
    return []
  }
}

function saveCorpus(outPath, cases) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify({ version: 1, count: cases.length, cases }, null, 2) + '\n', {
    mode: 0o600,
  })
}

function importDirectory(importDir, outPath) {
  const files = fs
    .readdirSync(importDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
  const cases = []
  let skipped = 0
  for (const file of files) {
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(path.join(importDir, file), 'utf8'))
    } catch {
      skipped++
      continue
    }
    const items = Array.isArray(raw) ? raw : [raw]
    for (const item of items) {
      const reqPath = item.path || item.inbound_path || '/v1/messages'
      const body = item.body || item.inbound_body || item.input?.body || item.input || item
      const protocol =
        detectProtocolFromPath(reqPath) ||
        (Array.isArray(body?.contents)
          ? 'google.gemini'
          : body?.input != null
            ? 'openai.responses'
            : body?.prompt != null
              ? 'openai.completions'
              : Array.isArray(body?.messages)
                ? 'anthropic.messages'
                : null)
      if (!protocol || !isValidHttpRequestBody(protocol, body)) {
        skipped++
        continue
      }
      const cleanBody = sanitizeValue(body)
      const hash = crypto.createHash('sha256').update(JSON.stringify(cleanBody)).digest('hex').slice(0, 10)
      cases.push({
        id: `imported-${protocol.replace('.', '-')}-${cases.length + 1}-${hash}`,
        source: 'local_import',
        inbound_protocol: protocol,
        target_family: inferTargetFamily(protocol, cleanBody, reqPath),
        request: {
          method: 'POST',
          path: reqPath,
          headers: sanitizeHeaders(item.headers || item.inbound_headers || {}),
          body: cleanBody,
        },
        mock_upstream: { mode: 'ok_text', stream: cleanBody.stream === true },
      })
    }
  }
  saveCorpus(outPath, cases)
  console.log(`Imported ${cases.length} sanitized HTTP requests (skipped ${skipped} non-HTTP/invalid) -> ${outPath}`)
}

function runRecorder(listenAddr, targetBase, outPath) {
  const [host, portRaw] = listenAddr.split(':')
  const port = Number(portRaw)
  const target = new URL(targetBase)
  const cases = loadExisting(outPath)
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const rawBody = Buffer.concat(chunks)
    const protocol = detectProtocolFromPath(req.url || '')
    if (req.method === 'POST' && protocol) {
      try {
        const parsed = JSON.parse(rawBody.toString('utf8'))
        if (isValidHttpRequestBody(protocol, parsed)) {
          const cleanBody = sanitizeValue(parsed)
          const hash = crypto.createHash('sha256').update(JSON.stringify(cleanBody)).digest('hex').slice(0, 8)
          cases.push({
            id: `captured-${protocol.replace('.', '-')}-${cases.length + 1}-${hash}`,
            source: 'local_capture',
            inbound_protocol: protocol,
            target_family: inferTargetFamily(protocol, cleanBody, req.url || ''),
            request: {
              method: 'POST',
              path: req.url || '/',
              headers: sanitizeHeaders(req.headers),
              body: cleanBody,
            },
            mock_upstream: { mode: 'ok_text', stream: cleanBody.stream === true },
          })
          saveCorpus(outPath, cases)
          console.log(`[capture] #${cases.length} ${protocol} ${req.url} -> ${outPath}`)
        }
      } catch {}
    }
    const fwdHeaders = { ...req.headers, host: target.host }
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: req.url,
        method: req.method,
        headers: fwdHeaders,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers)
        upRes.pipe(res)
      },
    )
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `recorder target error: ${err.message}` } }))
      }
    })
    upstream.end(rawBody)
  })
  server.listen(port, host, () => {
    console.log(`[capture-local] listening on http://${host}:${port} -> forwarding to ${targetBase}`)
    console.log(`[capture-local] writing sanitized corpus to ${outPath} (existing: ${cases.length})`)
  })
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('capture-local.mjs')) {
  const args = parseArgs(process.argv.slice(2))
  if (args.import) {
    importDirectory(args.import, args.out || 'scripts/protocol-baseline/corpus/imported.json')
  } else if (args.listen && args.target) {
    runRecorder(args.listen, args.target, args.out || 'scripts/protocol-baseline/corpus/local-captured.json')
  } else {
    console.log('Usage:')
    console.log('  --listen 127.0.0.1:18787 --target http://127.0.0.1:8787 --out <path>')
    console.log('  --import <dir> --out <path>')
  }
}
