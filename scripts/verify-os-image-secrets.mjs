#!/usr/bin/env node
/**
 * Fail-closed secret, plaintext-core, and managed-settings gate for custom Debian 13 OS
 * rootfs directories and OCI tar / tar.gz layer archives.
 *
 * Enforces:
 *   1. Zero plaintext crag-v2-core / craggemini-core ELF binaries (by name, hash, or CRAG dir whitelist).
 *   2. Zero private keys / payload keys / master keys (PEM private blocks, payload-key.json, crag-master.code, CRAGK1).
 *   3. Zero slot credentials / device licenses (.credentials.json, .claude.json, device.json, crag-host-machine-id).
 *   4. Zero loose .mjs/.cjs/.js/.rs/.ts source files or unauthorized symlinks inside CRAG package directories.
 *   5. Zero legacy glibc239/ private dynamic-linker bundles in Debian 13 custom OS images.
 *   6. Self-Probe-safe /etc/claude-code/managed-settings.json (forbids CLAUDE_CODE_ATTRIBUTION_HEADER,
 *      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, and non-empty /etc/claude-code/CLAUDE.md).
 *   7. Zero baked SSH host keys (etc/ssh/ssh_host_*_key*); read-only etc/ssh/sshd_config.kin
 *      and non-CRAG usr/local/bin/claude symlink are permitted.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const MAX_TEXT_SCAN_BYTES = 512 * 1024

export const FORBIDDEN_MANAGED_ENV_KEYS = Object.freeze([
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
])

const FORBIDDEN_CORE_BASENAMES = new Set([
  'crag-v2-core',
  'craggemini-core',
  'crag-core',
  'crag-v2-core.plain',
  'craggemini-core.plain',
])

const FORBIDDEN_KEY_BASENAMES = new Set([
  'issuer-private.pem',
  'payload-key.json',
  'crag-master.code',
  'id_ed25519',
  'id_rsa',
  'id_ecdsa',
])

const FORBIDDEN_CREDENTIAL_BASENAMES = new Set([
  '.credentials.json',
  'credentials.json',
  '.claude.json',
  'device.json',
  'crag-host-machine-id',
  'internal.token',
  'oauth.json',
])

const ALLOWED_CRAG_ELFS = new Set(['crag-v2', 'craggemini', 'claude', 'kin-kernel'])

const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/
const MASTER_KEY_RE = /\bCRAGK1[A-Za-z0-9+/=_-]{16,}/
const PAYLOAD_KEY_JSON_RE = /"(?:payload_key|payload_key_hex|master_key|private_key_pem)"\s*:/
const BAKED_SSH_HOST_KEY_RE = /(?:^|\/)etc\/ssh\/ssh_host_[^/]+_key(?:\.pub)?$/i
const SSH_HOST_PRIVATE_KEY_BASENAME_RE = /^ssh_host_[^/]+_key$/i

function normalizeRelPath(raw) {
  let s = String(raw || '').replaceAll('\\', '/')
  while (s.startsWith('./')) s = s.slice(2)
  while (s.startsWith('/')) s = s.slice(1)
  return s.replace(/\/+/g, '/').replace(/\/$/, '')
}

function isInCragDir(rel) {
  return /(?:^|\/)(?:share\/crag|opt\/kin\/store\/crag|usr\/lib\/kin\/factory\/crag|\.kin\/crag-v2)(?:\/|$)/.test(rel)
}

function isInForbiddenRuntimeDir(rel) {
  return /(?:^|\/)(?:run\/kin\/crag-license|run\/vm2api-crag)(?:\/|$)/.test(rel)
}

function isGlibc239Path(rel) {
  return /(?:^|\/)glibc239(?:\/|$)/.test(rel)
}

function isElf(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).equals(ELF_MAGIC)
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function verifyManagedSettingsContent(text, relPath = 'etc/claude-code/managed-settings.json') {
  const violations = []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    violations.push({
      code: 'managed_settings_invalid',
      path: relPath,
      detail: `invalid JSON: ${err.message}`,
    })
    return violations
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    violations.push({
      code: 'managed_settings_invalid',
      path: relPath,
      detail: 'managed-settings must be a JSON object',
    })
    return violations
  }
  const env = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env) ? parsed.env : null
  if (env) {
    for (const key of FORBIDDEN_MANAGED_ENV_KEYS) {
      if (Object.hasOwn(env, key)) {
        violations.push({
          code: 'managed_settings_self_probe_conflict',
          path: relPath,
          detail: `forbidden Self-Probe conflict env key: ${key}`,
        })
      }
    }
  }
  return violations
}

function evaluateEntry(entry, { knownPlaintextHashes, forbidGlibc239, violations }) {
  const rel = normalizeRelPath(entry.rel)
  if (!rel) return
  const base = path.posix.basename(rel)
  const lowerBase = base.toLowerCase()

  if (forbidGlibc239 && isGlibc239Path(rel)) {
    violations.push({
      code: 'forbidden_glibc239_hack',
      path: rel,
      detail: 'Debian 13 custom OS image must not ship legacy glibc239/ private loader files',
    })
  }

  if (rel === 'etc/claude-code/CLAUDE.md') {
    violations.push({
      code: 'forbidden_managed_claude_md',
      path: rel,
      detail: '/etc/claude-code/CLAUDE.md must not be present (pollutes V4 Self-Probe tui_system_template)',
    })
  }

  if (isInForbiddenRuntimeDir(rel) && entry.type !== 'dir') {
    violations.push({
      code: 'forbidden_license_material',
      path: rel,
      detail: 'runtime CRAG license projection directory must not contain baked files',
    })
  }

  if (FORBIDDEN_CORE_BASENAMES.has(lowerBase)) {
    violations.push({
      code: 'plaintext_crag_core',
      path: rel,
      detail: `forbidden plaintext core filename: ${base}`,
    })
  }

  if (BAKED_SSH_HOST_KEY_RE.test(rel) || SSH_HOST_PRIVATE_KEY_BASENAME_RE.test(base)) {
    violations.push({
      code: 'baked_ssh_host_key',
      path: rel,
      detail: `baked SSH host key must not be present in image: ${rel}`,
    })
  }

  if (FORBIDDEN_KEY_BASENAMES.has(lowerBase) || /\.pem\.key$/i.test(lowerBase) || /private.*\.pem$/i.test(lowerBase)) {
    violations.push({
      code: 'private_key_material',
      path: rel,
      detail: `forbidden private or master key file: ${base}`,
    })
  }

  if (FORBIDDEN_CREDENTIAL_BASENAMES.has(lowerBase)) {
    violations.push({
      code: 'slot_credential_material',
      path: rel,
      detail: `forbidden slot credential or device license file: ${base}`,
    })
  }

  if (isInCragDir(rel)) {
    if (entry.type === 'symlink') {
      violations.push({
        code: 'crag_dir_symlink',
        path: rel,
        detail: 'unauthorized symlink inside CRAG package directory',
      })
    }
    if (entry.type === 'file') {
      if (/\.(?:[cm]?js|ts|rs)$/i.test(lowerBase) || /(?:^|\/)(?:src|node_modules)(?:\/|$)/.test(rel)) {
        violations.push({
          code: 'crag_loose_source_file',
          path: rel,
          detail: `prohibited loose script/source inside CRAG directory: ${base}`,
        })
      }
    }
  }

  if (entry.type !== 'file' || !entry.readBytes) return

  const bytes = entry.readBytes()

  if (
    rel === 'etc/claude-code/managed-settings.json' ||
    (/^etc\/claude-code\/managed-settings\.d\/[^/]+\.json$/.test(rel) && entry.type === 'file')
  ) {
    violations.push(...verifyManagedSettingsContent(bytes.toString('utf8'), rel))
  }

  if (isElf(bytes)) {
    if (isInCragDir(rel) && !ALLOWED_CRAG_ELFS.has(base)) {
      violations.push({
        code: 'unexpected_crag_elf',
        path: rel,
        detail: `unexpected ELF binary inside CRAG directory: ${base}`,
      })
    }
    if (knownPlaintextHashes.size > 0) {
      const digest = sha256Hex(bytes)
      if (knownPlaintextHashes.has(digest)) {
        violations.push({
          code: 'plaintext_crag_core_hash_match',
          path: rel,
          detail: `ELF SHA-256 matches manifest payload.plaintext_sha256 (${digest})`,
        })
      }
    }
    return
  }

  if (bytes.length > 0 && bytes.length <= MAX_TEXT_SCAN_BYTES) {
    const text = bytes.toString('utf8')
    if (PRIVATE_KEY_RE.test(text)) {
      violations.push({
        code: 'private_key_content',
        path: rel,
        detail: 'file contains PEM private key block',
      })
    }
    if (MASTER_KEY_RE.test(text)) {
      violations.push({
        code: 'master_key_content',
        path: rel,
        detail: 'file contains CRAGK1 master key material',
      })
    }
    if (lowerBase.endsWith('.json') && PAYLOAD_KEY_JSON_RE.test(text)) {
      violations.push({
        code: 'payload_key_content',
        path: rel,
        detail: 'JSON file contains payload/private key field',
      })
    }
  }
}

function collectManifestPlaintextHashes(entries, seedHashes = []) {
  const hashes = new Set(
    seedHashes
      .map((h) =>
        String(h || '')
          .trim()
          .toLowerCase(),
      )
      .filter((h) => /^[a-f0-9]{64}$/.test(h)),
  )
  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.readBytes) continue
    const rel = normalizeRelPath(entry.rel)
    if (path.posix.basename(rel) !== 'manifest.json') continue
    try {
      const bytes = entry.readBytes()
      if (bytes.length > 128 * 1024) continue
      const parsed = JSON.parse(bytes.toString('utf8'))
      const psha = parsed?.payload?.plaintext_sha256
      if (typeof psha === 'string' && /^[a-f0-9]{64}$/.test(psha)) {
        hashes.add(psha)
      }
    } catch {}
  }
  return hashes
}

export function scanDirectoryForSecrets(rootDir, { knownPlaintextHashes = [], forbidGlibc239 = true } = {}) {
  const absRoot = path.resolve(rootDir)
  if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
    return {
      ok: false,
      scannedFiles: 0,
      violations: [{ code: 'scan_target_missing', path: absRoot, detail: 'target directory does not exist' }],
    }
  }

  const entries = []
  function walk(dir, prefix = '') {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, dirent.name)
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name
      if (dirent.isSymbolicLink()) {
        entries.push({ rel, type: 'symlink' })
      } else if (dirent.isDirectory()) {
        entries.push({ rel, type: 'dir' })
        walk(abs, rel)
      } else if (dirent.isFile()) {
        entries.push({
          rel,
          type: 'file',
          readBytes: () => fs.readFileSync(abs),
        })
      }
    }
  }
  walk(absRoot)

  const hashes = collectManifestPlaintextHashes(entries, knownPlaintextHashes)
  const violations = []
  let scannedFiles = 0
  for (const entry of entries) {
    if (entry.type === 'file') scannedFiles += 1
    evaluateEntry(entry, { knownPlaintextHashes: hashes, forbidGlibc239, violations })
  }
  return { ok: violations.length === 0, scannedFiles, violations }
}

function parseTarOctal(buf, start, len) {
  const raw = buf
    .subarray(start, start + len)
    .toString('ascii')
    .replace(/\0.*$/, '')
    .trim()
  if (!raw) return 0
  return Number.parseInt(raw, 8) || 0
}

function parsePaxRecords(buf) {
  const out = {}
  let off = 0
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off)
    if (sp <= off) break
    const recLen = Number.parseInt(buf.subarray(off, sp).toString('ascii'), 10)
    if (!Number.isInteger(recLen) || recLen <= 0 || off + recLen > buf.length) break
    const line = buf
      .subarray(sp + 1, off + recLen)
      .toString('utf8')
      .replace(/\n$/, '')
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1)
    off += recLen
  }
  return out
}

export function parseTarEntries(tarBuffer) {
  let buf = tarBuffer
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    buf = zlib.gunzipSync(buf)
  }
  const entries = []
  let off = 0
  let paxNextPath = null
  let gnuLongName = null

  while (off + 512 <= buf.length) {
    const hdr = buf.subarray(off, off + 512)
    let allZero = true
    for (let i = 0; i < 512; i += 1) {
      if (hdr[i] !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) break

    const rawName = hdr.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = hdr.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const typeFlag = String.fromCharCode(hdr[156] || 48)
    const size = parseTarOctal(hdr, 124, 12)
    off += 512
    const body = buf.subarray(off, Math.min(off + size, buf.length))
    off += Math.ceil(size / 512) * 512

    if (typeFlag === 'x') {
      const pax = parsePaxRecords(body)
      if (pax.path) paxNextPath = pax.path
      continue
    }
    if (typeFlag === 'g') {
      continue
    }
    if (typeFlag === 'L') {
      gnuLongName = body.toString('utf8').replace(/\0.*$/, '')
      continue
    }

    const name = paxNextPath ?? gnuLongName ?? (prefix ? `${prefix}/${rawName}` : rawName)
    paxNextPath = null
    gnuLongName = null

    if (typeFlag === '5') {
      entries.push({ rel: name, type: 'dir' })
    } else if (typeFlag === '2' || typeFlag === '1') {
      entries.push({ rel: name, type: 'symlink' })
    } else if (typeFlag === '0' || typeFlag === '\0') {
      entries.push({ rel: name, type: 'file', readBytes: () => body })
    }
  }
  return entries
}

export function scanTarForSecrets(tarPath, { knownPlaintextHashes = [], forbidGlibc239 = true } = {}) {
  const absTar = path.resolve(tarPath)
  if (!fs.existsSync(absTar) || !fs.statSync(absTar).isFile()) {
    return {
      ok: false,
      scannedFiles: 0,
      violations: [{ code: 'scan_target_missing', path: absTar, detail: 'target archive does not exist' }],
    }
  }
  const entries = parseTarEntries(fs.readFileSync(absTar))
  const hashes = collectManifestPlaintextHashes(entries, knownPlaintextHashes)
  const violations = []
  let scannedFiles = 0
  for (const entry of entries) {
    if (entry.type === 'file') scannedFiles += 1
    evaluateEntry(entry, { knownPlaintextHashes: hashes, forbidGlibc239, violations })
  }
  return { ok: violations.length === 0, scannedFiles, violations }
}

function runCli(argv) {
  let dir = ''
  let tar = ''
  let jsonOut = false
  let forbidGlibc239 = true
  const hashes = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dir') dir = argv[++i] || ''
    else if (arg === '--tar') tar = argv[++i] || ''
    else if (arg === '--json') jsonOut = true
    else if (arg === '--allow-glibc239') forbidGlibc239 = false
    else if (arg === '--plaintext-hash') hashes.push(argv[++i] || '')
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: verify-os-image-secrets.mjs (--dir <rootfs> | --tar <archive.tar[.gz]>) [--json]')
      return 0
    } else {
      console.error(`verify-os-image-secrets: unknown option ${arg}`)
      return 2
    }
  }

  if ((!dir && !tar) || (dir && tar)) {
    console.error('verify-os-image-secrets: specify exactly one of --dir or --tar')
    return 2
  }

  const result = dir
    ? scanDirectoryForSecrets(dir, { knownPlaintextHashes: hashes, forbidGlibc239 })
    : scanTarForSecrets(tar, { knownPlaintextHashes: hashes, forbidGlibc239 })

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result.ok) {
    console.log(`verify-os-image-secrets: PASS (${result.scannedFiles} files scanned, 0 violations)`)
  } else {
    console.error(`verify-os-image-secrets: FAIL (${result.violations.length} violation(s))`)
    for (const v of result.violations) {
      console.error(`  - [${v.code}] ${v.path}: ${v.detail}`)
    }
  }
  return result.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli(process.argv.slice(2)))
}
