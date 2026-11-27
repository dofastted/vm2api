/**
 * Native `claude` one-click atomic store updater for the Custom Debian 13 OS
 * host read-only shared store (`/opt/kin/store`).
 *
 * Lifecycle:
 *   1. Initial `2.1.321` seeding into `<storeRoot>/claude/versions/2.1.321/claude` (0555).
 *   2. Staged candidate validation: ELF64 arch, max GLIBC <= 2.41, exact SHA-256,
 *      and mandatory Ed25519 signature over `CRAG-OFFICIAL-CLAUDE-V1\0` (async light manifest).
 *   3. 4-gate fail-closed Shadow Canary precheck:
 *        - Gate 1: Valid WireProfile v2 (`probe_mode === 'tui_pty'`, matching `elf_sha256`,
 *                  required headers & `tui_system_template`) -> persisted read-only to `/profiles/<sha>.json`.
 *        - Gate 2: `T_WORKER_READY` received within timeout (proves `BUN_OPTIONS` preload active).
 *        - Gate 3: Streaming SSE + AbortController cancel + native x86-64 CCH `cch=00000` replacement.
 *        - Gate 4: `/etc/claude-code/managed-settings.json` active (`autoUpdates: false`, no Self-Probe
 *                  conflict) + idle worker PSS <= 80 MiB.
 *   4. Same-filesystem atomic A/B symlink switch (`current` / `previous`, relative targets so
 *      links resolve identically on host and inside container/KVM `/opt/kin/store:ro`), with
 *      live-PID version locks protecting in-use ELF inodes from pruning.
 *   5. One-click atomic rollback (`current` <-> `previous`).
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { decodeLicenseBytes } from './crag-license.mjs'
import { CRAG_CLAUDE_SEMVER_RE, CRAG_CLAUDE_VERSION } from './slot-engine.mjs'
import { validateReadOnlyNoFollowPath } from './custom-os-runtime.mjs'

export const INITIAL_CLAUDE_VERSION = CRAG_CLAUDE_VERSION // '2.1.321'
export const MAX_SUPPORTED_GLIBC = Object.freeze([2, 41])
export const DEFAULT_MAX_IDLE_PSS_MIB = 80
export const DEFAULT_WORKER_READY_TIMEOUT_MS = 3000
export const DEFAULT_RETAIN_VERSIONS = 2

const GLIBC_SYMBOL_RE = /GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g

export function storePaths(storeRoot) {
  const root = path.resolve(storeRoot)
  const claudeDir = path.join(root, 'claude')
  return {
    root,
    claudeDir,
    versionsDir: path.join(claudeDir, 'versions'),
    stagingDir: path.join(claudeDir, 'staging'),
    locksDir: path.join(claudeDir, 'locks'),
    profilesDir: path.join(root, 'profiles'),
    manifestsDir: path.join(root, 'manifests'),
    currentLink: path.join(claudeDir, 'current'),
    previousLink: path.join(claudeDir, 'previous'),
    stateFile: path.join(claudeDir, 'store-state.json'),
  }
}

export function ensureStoreLayout(storeRoot) {
  const p = storePaths(storeRoot)
  for (const dir of [p.root, p.claudeDir, p.versionsDir, p.stagingDir, p.locksDir, p.profilesDir, p.manifestsDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
  }
  return p
}

function sha256File(filePath) {
  const bytes = fs.readFileSync(filePath)
  return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
}

export function compareGlibcTuple(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

function parseGlibcStrings(text) {
  const found = []
  GLIBC_SYMBOL_RE.lastIndex = 0
  let match
  while ((match = GLIBC_SYMBOL_RE.exec(text)) !== null) {
    found.push([Number(match[1]), Number(match[2]), Number(match[3] || 0)])
  }
  return found
}

export function inspectElfAndGlibc(
  binaryPath,
  { arch = 'amd64', maxGlibc = MAX_SUPPORTED_GLIBC, inspectGlibc = null } = {},
) {
  let bytes
  try {
    bytes = fs.readFileSync(binaryPath)
  } catch (err) {
    return { ok: false, code: 'claude_binary_unreadable', error: `cannot read binary: ${err?.message || err}` }
  }
  if (
    bytes.length < 64 ||
    bytes.readUInt32BE(0) !== 0x7f454c46 ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes[6] !== 1 ||
    ![2, 3].includes(bytes.readUInt16LE(16))
  ) {
    return { ok: false, code: 'claude_elf_invalid', error: 'staged binary is not a valid Linux ELF64 executable' }
  }
  const expectedMachine = arch === 'arm64' ? 183 : 62
  const actualMachine = bytes.readUInt16LE(18)
  if (actualMachine !== expectedMachine) {
    return {
      ok: false,
      code: 'claude_arch_mismatch',
      error: `ELF machine ${actualMachine} does not match ${arch} (${expectedMachine})`,
    }
  }

  let versions = []
  if (typeof inspectGlibc === 'function') {
    const custom = inspectGlibc(binaryPath, bytes)
    if (Array.isArray(custom)) {
      for (const item of custom) {
        if (typeof item === 'string') versions.push(...parseGlibcStrings(item))
        else if (Array.isArray(item)) versions.push([Number(item[0] || 0), Number(item[1] || 0), Number(item[2] || 0)])
      }
    }
  } else {
    const hasSectionHeaders = bytes.readBigUInt64LE(40) > 0n && bytes.readUInt16LE(60) > 0
    let usedReadelf = false
    if (hasSectionHeaders && process.platform !== 'win32') {
      try {
        const out = execFileSync('readelf', ['-V', binaryPath], {
          encoding: 'utf8',
          timeout: 15_000,
          maxBuffer: 8 * 1024 * 1024,
        })
        versions = parseGlibcStrings(out)
        usedReadelf = true
      } catch {}
    }
    if (!usedReadelf) {
      // Fallback for synthetic test ELFs or environments without binutils readelf:
      // scan NUL-terminated `GLIBC_<major>.<minor>[.<patch>]\0` version tags.
      const text = bytes.toString('latin1')
      const nulRe = /GLIBC_(\d+)\.(\d+)(?:\.(\d+))?\0/g
      let m
      while ((m = nulRe.exec(text)) !== null) {
        versions.push([Number(m[1]), Number(m[2]), Number(m[3] || 0)])
      }
    }
  }

  let highest = null
  for (const v of versions) {
    if (!highest || compareGlibcTuple(v, highest) > 0) highest = v
  }
  if (highest && compareGlibcTuple(highest, maxGlibc) > 0) {
    const fmt = (t) => (t[2] ? `${t[0]}.${t[1]}.${t[2]}` : `${t[0]}.${t[1]}`)
    return {
      ok: false,
      code: 'claude_glibc_incompatible',
      error: `binary requires GLIBC_${fmt(highest)}, exceeding Debian 13 ceiling GLIBC_${fmt(maxGlibc)}`,
      maxGlibcDetected: fmt(highest),
    }
  }

  return {
    ok: true,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    maxGlibcDetected: highest
      ? highest[2]
        ? `${highest[0]}.${highest[1]}.${highest[2]}`
        : `${highest[0]}.${highest[1]}`
      : null,
  }
}

export function verifyOfficialClaudeLightManifest(
  manifest,
  { issuerPublicKeyPem, expectedIssuerPublicKeyId = null, expectedArch = 'amd64' } = {},
) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, code: 'manifest_invalid', error: 'official Claude light manifest must be an object' }
  }
  const version = String(manifest.version || '').trim()
  if (!CRAG_CLAUDE_SEMVER_RE.test(version)) {
    return { ok: false, code: 'manifest_version_invalid', error: `invalid semver version: ${version}` }
  }
  const arch = String(manifest.arch || expectedArch).trim()
  if (!['amd64', 'arm64'].includes(arch) || arch !== expectedArch) {
    return { ok: false, code: 'manifest_arch_mismatch', error: `manifest arch ${arch} does not match ${expectedArch}` }
  }
  const expectedRelPath = `claude-code-${version}/claude`
  const relPath = String(manifest.path || expectedRelPath).trim()
  if (relPath !== expectedRelPath) {
    return { ok: false, code: 'manifest_path_invalid', error: `manifest path must be ${expectedRelPath}` }
  }
  const sha256 = String(manifest.sha256 || '').trim()
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    return { ok: false, code: 'manifest_sha256_invalid', error: 'manifest sha256 must be 64 lowercase hex chars' }
  }
  if (typeof manifest.signature !== 'string' || !manifest.signature) {
    return { ok: false, code: 'manifest_signature_missing', error: 'light manifest Ed25519 signature is required' }
  }
  if (
    typeof issuerPublicKeyPem !== 'string' ||
    !/^-----BEGIN PUBLIC KEY-----\s+[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(issuerPublicKeyPem)
  ) {
    return { ok: false, code: 'issuer_pubkey_invalid', error: 'issuer public key PEM is missing or malformed' }
  }

  let pub
  let issuerPublicKeyId
  try {
    pub = crypto.createPublicKey(issuerPublicKeyPem)
    if (pub.asymmetricKeyType !== 'ed25519') {
      return { ok: false, code: 'issuer_pubkey_invalid', error: 'issuer public key must be Ed25519' }
    }
    const raw = pub.export({ format: 'der', type: 'spki' }).subarray(-32)
    issuerPublicKeyId = crypto.createHash('sha256').update(raw).digest('hex')
  } catch (err) {
    return { ok: false, code: 'issuer_pubkey_invalid', error: `invalid issuer public key: ${err?.message || err}` }
  }

  if (expectedIssuerPublicKeyId && issuerPublicKeyId !== expectedIssuerPublicKeyId) {
    return {
      ok: false,
      code: 'issuer_identity_mismatch',
      error: `issuer public key id ${issuerPublicKeyId} does not match expected ${expectedIssuerPublicKeyId}`,
    }
  }

  let sigBytes
  try {
    sigBytes = decodeLicenseBytes(manifest.signature, 64)
  } catch {
    return { ok: false, code: 'manifest_signature_invalid', error: 'signature is not valid unpadded base64url(64)' }
  }

  const signedPayload = {
    product: 'crag-v2',
    arch,
    version,
    path: relPath,
    sha256,
  }
  const verified = crypto.verify(
    null,
    Buffer.concat([Buffer.from('CRAG-OFFICIAL-CLAUDE-V1\0'), Buffer.from(JSON.stringify(signedPayload))]),
    pub,
    sigBytes,
  )
  if (!verified) {
    return { ok: false, code: 'manifest_signature_invalid', error: 'Ed25519 signature verification failed' }
  }

  return { ok: true, version, arch, path: relPath, sha256, issuerPublicKeyId }
}

export function validateShadowCanaryResult(
  report,
  {
    expectedSha256,
    maxIdlePssMib = DEFAULT_MAX_IDLE_PSS_MIB,
    workerReadyTimeoutMs = DEFAULT_WORKER_READY_TIMEOUT_MS,
  } = {},
) {
  const failedGates = []
  if (!report || typeof report !== 'object') {
    return { ok: false, code: 'shadow_canary_failed', failedGates: ['probe_result_missing'] }
  }

  // Gate 1: WireProfile v2 matches CRAG V4 `src/v2/bridge/types.rs` (`schema_version === 2`,
  // `probe_mode === 'tui'` — never degraded `print_fallback`, matching `elf_sha256`,
  // non-empty `claude_version`, `user_agent`, `anthropic_version`, `header_order`,
  // `anthropic_beta.default` containing `oauth-2025-04-20`, `billing_header.{prefix,cc_version_base}`,
  // and captured `tui_system_template`).
  const profile = report.wireProfile
  const profileValid =
    profile &&
    typeof profile === 'object' &&
    profile.schema_version === 2 &&
    profile.probe_mode === 'tui' &&
    profile.elf_sha256 === expectedSha256 &&
    typeof profile.claude_version === 'string' &&
    profile.claude_version.trim().length > 0 &&
    typeof profile.user_agent === 'string' &&
    profile.user_agent.trim().length > 0 &&
    typeof profile.anthropic_version === 'string' &&
    profile.anthropic_version.trim().length > 0 &&
    Array.isArray(profile.header_order) &&
    profile.header_order.length > 0 &&
    Array.isArray(profile.anthropic_beta?.default) &&
    profile.anthropic_beta.default.includes('oauth-2025-04-20') &&
    typeof profile.billing_header?.prefix === 'string' &&
    profile.billing_header.prefix.trim().length > 0 &&
    typeof profile.billing_header?.cc_version_base === 'string' &&
    profile.billing_header.cc_version_base.trim().length > 0 &&
    Array.isArray(profile.tui_system_template) &&
    profile.tui_system_template.length > 0
  if (!profileValid) {
    failedGates.push('gate1_wire_profile_invalid')
  }

  // Gate 2: T_WORKER_READY received within timeout (proves BUN_OPTIONS preload works).
  const readyOk =
    report.workerReady === true &&
    typeof report.workerReadyMs === 'number' &&
    Number.isFinite(report.workerReadyMs) &&
    report.workerReadyMs >= 0 &&
    report.workerReadyMs <= workerReadyTimeoutMs
  if (!readyOk) {
    failedGates.push('gate2_worker_ready_failed')
  }

  // Gate 3: Streaming SSE + AbortController cancel + native x86-64 CCH scanner replacement.
  const cch = typeof report.cchObserved === 'string' ? report.cchObserved.trim() : ''
  const cchValid =
    report.sseOk === true &&
    report.abortOk === true &&
    report.cchReplaced === true &&
    cch.length > 0 &&
    cch !== '00000' &&
    !cch.includes('cch=00000')
  if (!cchValid) {
    failedGates.push('gate3_sse_abort_cch_failed')
  }

  // Gate 4: /etc/claude-code/managed-settings.json active & conflict-free + idle PSS within budget.
  const managedOk =
    report.managedSettingsActive === true &&
    report.autoUpdatesDisabled === true &&
    report.selfProbeConflictFree === true &&
    typeof report.idlePssMib === 'number' &&
    Number.isFinite(report.idlePssMib) &&
    report.idlePssMib > 0 &&
    report.idlePssMib <= maxIdlePssMib
  if (!managedOk) {
    failedGates.push('gate4_managed_settings_or_pss_failed')
  }

  if (failedGates.length > 0) {
    return {
      ok: false,
      code: 'shadow_canary_failed',
      failedGates,
      error: `shadow canary failed closed on gates: ${failedGates.join(', ')}`,
    }
  }
  return { ok: true, failedGates: [] }
}

function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

export function acquireVersionLock(storeRoot, version, { pid = process.pid } = {}) {
  if (!CRAG_CLAUDE_SEMVER_RE.test(String(version || ''))) {
    throw new Error(`invalid version for lock: ${version}`)
  }
  const p = ensureStoreLayout(storeRoot)
  const lockFile = path.join(p.locksDir, `${version}.${pid}.lock`)
  const body = `${JSON.stringify({ version, pid, acquired_at: new Date().toISOString() })}\n`
  const tmp = `${lockFile}.tmp.${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, body, { mode: 0o644 })
  fs.renameSync(tmp, lockFile)
  return lockFile
}

export function releaseVersionLock(lockFile) {
  if (!lockFile) return
  try {
    fs.rmSync(lockFile, { force: true })
  } catch {}
}

export function listActiveLockedVersions(storeRoot, { isProcessAlive = defaultIsProcessAlive } = {}) {
  const p = storePaths(storeRoot)
  const active = new Set()
  if (!fs.existsSync(p.locksDir)) return active
  for (const name of fs.readdirSync(p.locksDir)) {
    if (!name.endsWith('.lock')) continue
    const full = path.join(p.locksDir, name)
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
      const pid = Number(parsed?.pid)
      const version = String(parsed?.version || '')
      if (CRAG_CLAUDE_SEMVER_RE.test(version) && isProcessAlive(pid)) {
        active.add(version)
      } else {
        fs.rmSync(full, { force: true })
      }
    } catch {
      try {
        fs.rmSync(full, { force: true })
      } catch {}
    }
  }
  return active
}

function readSymlinkVersion(linkPath) {
  try {
    const raw = fs.readlinkSync(linkPath)
    const normalized = raw.replaceAll('\\', '/')
    const match = /^versions\/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)\/claude$/.exec(normalized)
    return match ? match[1] : null
  } catch {
    return null
  }
}

function atomicReplaceSymlink(linkPath, relativeTarget) {
  const dir = path.dirname(linkPath)
  const base = path.basename(linkPath)
  const tmpLink = path.join(dir, `.${base}.next.${crypto.randomBytes(6).toString('hex')}`)
  try {
    fs.symlinkSync(relativeTarget, tmpLink)
    fs.renameSync(tmpLink, linkPath)
  } catch (err) {
    try {
      fs.rmSync(tmpLink, { force: true })
    } catch {}
    throw err
  }
}

function writeJsonAtomic(filePath, value, { mode = 0o644 } = {}) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${crypto.randomBytes(6).toString('hex')}`)
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  if (process.platform !== 'win32') {
    fs.chmodSync(tmp, mode)
  }
  fs.renameSync(tmp, filePath)
}

function readStoreState(storeRoot) {
  const p = storePaths(storeRoot)
  try {
    return JSON.parse(fs.readFileSync(p.stateFile, 'utf8'))
  } catch {
    return { current: readSymlinkVersion(p.currentLink), previous: readSymlinkVersion(p.previousLink), history: [] }
  }
}

export function atomicSwitchCurrent(storeRoot, nextVersion) {
  if (!CRAG_CLAUDE_SEMVER_RE.test(String(nextVersion || ''))) {
    return { ok: false, code: 'invalid_version', error: `invalid version: ${nextVersion}` }
  }
  const p = ensureStoreLayout(storeRoot)
  const targetRel = `versions/${nextVersion}/claude`
  const targetAbs = path.join(p.claudeDir, targetRel)
  if (!fs.existsSync(targetAbs)) {
    return { ok: false, code: 'target_version_missing', error: `target version binary missing: ${targetAbs}` }
  }

  const prevVersion = readSymlinkVersion(p.currentLink)
  if (prevVersion && prevVersion !== nextVersion) {
    atomicReplaceSymlink(p.previousLink, `versions/${prevVersion}/claude`)
  }
  atomicReplaceSymlink(p.currentLink, targetRel)

  const state = readStoreState(storeRoot)
  const nextState = {
    current: nextVersion,
    previous: prevVersion && prevVersion !== nextVersion ? prevVersion : state.previous || null,
    updated_at: new Date().toISOString(),
    history: [
      ...(Array.isArray(state.history) ? state.history.slice(-19) : []),
      { action: 'switch', from: prevVersion || null, to: nextVersion, at: new Date().toISOString() },
    ],
  }
  writeJsonAtomic(p.stateFile, nextState, { mode: 0o644 })
  return {
    ok: true,
    fromVersion: prevVersion || null,
    toVersion: nextVersion,
    currentTarget: targetRel,
    previousTarget: nextState.previous ? `versions/${nextState.previous}/claude` : null,
  }
}

export function pruneUnusedVersions(
  storeRoot,
  { retainCount = DEFAULT_RETAIN_VERSIONS, isProcessAlive = defaultIsProcessAlive } = {},
) {
  const p = storePaths(storeRoot)
  if (!fs.existsSync(p.versionsDir)) return { removed: [], kept: [] }

  const currentVer = readSymlinkVersion(p.currentLink)
  const previousVer = readSymlinkVersion(p.previousLink)
  const locked = listActiveLockedVersions(storeRoot, { isProcessAlive })

  const versions = fs
    .readdirSync(p.versionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && CRAG_CLAUDE_SEMVER_RE.test(d.name))
    .map((d) => {
      const dirPath = path.join(p.versionsDir, d.name)
      const st = fs.statSync(dirPath)
      return { version: d.name, dirPath, mtimeMs: st.mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  const protectedSet = new Set(locked)
  if (currentVer) protectedSet.add(currentVer)
  if (previousVer) protectedSet.add(previousVer)

  const removed = []
  const kept = []
  let nonProtectedKept = 0
  const extraKeep = Math.max(
    0,
    retainCount - (currentVer ? 1 : 0) - (previousVer && previousVer !== currentVer ? 1 : 0),
  )

  for (const item of versions) {
    if (protectedSet.has(item.version)) {
      kept.push(item.version)
      continue
    }
    if (nonProtectedKept < extraKeep) {
      nonProtectedKept += 1
      kept.push(item.version)
      continue
    }
    try {
      // Restore write bit temporarily on the retired version directory/file so rm succeeds cleanly.
      const binPath = path.join(item.dirPath, 'claude')
      if (process.platform !== 'win32' && fs.existsSync(binPath)) {
        fs.chmodSync(binPath, 0o600)
      }
      fs.rmSync(item.dirPath, { recursive: true, force: true })
      removed.push(item.version)
    } catch {
      kept.push(item.version)
    }
  }
  return { removed, kept, locked: [...locked] }
}

function installBinaryReadOnly(sourcePath, destPath) {
  const destDir = path.dirname(destPath)
  fs.mkdirSync(destDir, { recursive: true, mode: 0o755 })
  const tmp = path.join(destDir, `.claude.tmp.${crypto.randomBytes(6).toString('hex')}`)
  try {
    fs.copyFileSync(sourcePath, tmp)
    if (process.platform !== 'win32') {
      fs.chmodSync(tmp, 0o555)
    }
    fs.renameSync(tmp, destPath)
    if (process.platform !== 'win32') {
      fs.chmodSync(destPath, 0o555)
    }
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
    throw err
  }
}

export function seedInitialClaudeVersion({
  storeRoot,
  sourceBinaryPath,
  version = INITIAL_CLAUDE_VERSION,
  manifest,
  issuerPublicKeyPem,
  expectedIssuerPublicKeyId = null,
  arch = 'amd64',
  wireProfile = null,
  inspectGlibc = null,
} = {}) {
  const p = ensureStoreLayout(storeRoot)
  const manifestCheck = verifyOfficialClaudeLightManifest(
    { ...manifest, version: manifest?.version || version, arch: manifest?.arch || arch },
    { issuerPublicKeyPem, expectedIssuerPublicKeyId, expectedArch: arch },
  )
  if (!manifestCheck.ok) return manifestCheck

  const elfCheck = inspectElfAndGlibc(sourceBinaryPath, { arch, inspectGlibc })
  if (!elfCheck.ok) return elfCheck
  if (elfCheck.sha256 !== manifestCheck.sha256) {
    return {
      ok: false,
      code: 'claude_sha256_mismatch',
      error: `binary SHA-256 ${elfCheck.sha256} does not match signed manifest ${manifestCheck.sha256}`,
    }
  }

  const destBin = path.join(p.versionsDir, manifestCheck.version, 'claude')
  installBinaryReadOnly(sourceBinaryPath, destBin)
  writeJsonAtomic(
    path.join(p.manifestsDir, `claude-official-${manifestCheck.version}.sig.json`),
    {
      product: 'crag-v2',
      arch: manifestCheck.arch,
      version: manifestCheck.version,
      path: manifestCheck.path,
      sha256: manifestCheck.sha256,
      signature: manifest.signature,
      issuer_public_key_id: manifestCheck.issuerPublicKeyId,
    },
    { mode: 0o444 },
  )

  let profilePath = null
  if (wireProfile && typeof wireProfile === 'object') {
    profilePath = path.join(p.profilesDir, `${manifestCheck.sha256}.json`)
    writeJsonAtomic(profilePath, wireProfile, { mode: 0o444 })
  }

  const switched = atomicSwitchCurrent(storeRoot, manifestCheck.version)
  if (!switched.ok) return switched

  return {
    ok: true,
    version: manifestCheck.version,
    sha256: manifestCheck.sha256,
    binaryPath: destBin,
    profilePath,
    currentTarget: switched.currentTarget,
    maxGlibcDetected: elfCheck.maxGlibcDetected,
  }
}

export async function upgradeClaudeStore({
  storeRoot,
  sourceBinaryPath,
  manifest,
  issuerPublicKeyPem,
  expectedIssuerPublicKeyId = null,
  arch = 'amd64',
  runShadowProbe,
  maxIdlePssMib = DEFAULT_MAX_IDLE_PSS_MIB,
  workerReadyTimeoutMs = DEFAULT_WORKER_READY_TIMEOUT_MS,
  inspectGlibc = null,
  retainVersions = DEFAULT_RETAIN_VERSIONS,
  isProcessAlive = defaultIsProcessAlive,
} = {}) {
  if (typeof runShadowProbe !== 'function') {
    return {
      ok: false,
      code: 'shadow_probe_runner_required',
      error: 'upgradeClaudeStore requires a fail-closed runShadowProbe runner',
    }
  }

  const p = ensureStoreLayout(storeRoot)
  const manifestCheck = verifyOfficialClaudeLightManifest(manifest, {
    issuerPublicKeyPem,
    expectedIssuerPublicKeyId,
    expectedArch: arch,
  })
  if (!manifestCheck.ok) return manifestCheck

  const stageDir = fs.mkdtempSync(path.join(p.stagingDir, `${manifestCheck.version}-`))
  const stagedBin = path.join(stageDir, 'claude')
  try {
    fs.copyFileSync(sourceBinaryPath, stagedBin)
    if (process.platform !== 'win32') fs.chmodSync(stagedBin, 0o555)

    const elfCheck = inspectElfAndGlibc(stagedBin, { arch, inspectGlibc })
    if (!elfCheck.ok) return elfCheck
    if (elfCheck.sha256 !== manifestCheck.sha256) {
      return {
        ok: false,
        code: 'claude_sha256_mismatch',
        error: `staged binary SHA-256 ${elfCheck.sha256} does not match signed manifest ${manifestCheck.sha256}`,
      }
    }

    let probeReport
    try {
      probeReport = await runShadowProbe({
        binaryPath: stagedBin,
        version: manifestCheck.version,
        sha256: manifestCheck.sha256,
        arch,
        storeRoot: p.root,
      })
    } catch (err) {
      return {
        ok: false,
        code: 'shadow_canary_failed',
        failedGates: ['probe_execution_error'],
        error: `shadow canary execution threw: ${err?.message || err}`,
      }
    }

    const gateCheck = validateShadowCanaryResult(probeReport, {
      expectedSha256: manifestCheck.sha256,
      maxIdlePssMib,
      workerReadyTimeoutMs,
    })
    if (!gateCheck.ok) return gateCheck

    // All 4 shadow gates passed: promote binary, read-only WireProfile cache, and signed manifest.
    const destBin = path.join(p.versionsDir, manifestCheck.version, 'claude')
    installBinaryReadOnly(stagedBin, destBin)

    const profilePath = path.join(p.profilesDir, `${manifestCheck.sha256}.json`)
    writeJsonAtomic(profilePath, probeReport.wireProfile, { mode: 0o444 })

    const manifestPath = path.join(p.manifestsDir, `claude-official-${manifestCheck.version}.sig.json`)
    writeJsonAtomic(
      manifestPath,
      {
        product: 'crag-v2',
        arch: manifestCheck.arch,
        version: manifestCheck.version,
        path: manifestCheck.path,
        sha256: manifestCheck.sha256,
        signature: manifest.signature,
        issuer_public_key_id: manifestCheck.issuerPublicKeyId,
      },
      { mode: 0o444 },
    )

    const switched = atomicSwitchCurrent(storeRoot, manifestCheck.version)
    if (!switched.ok) return switched

    const pruned = pruneUnusedVersions(storeRoot, { retainCount: retainVersions, isProcessAlive })
    return {
      ok: true,
      version: manifestCheck.version,
      fromVersion: switched.fromVersion,
      toVersion: switched.toVersion,
      sha256: manifestCheck.sha256,
      binaryPath: destBin,
      profilePath,
      manifestPath,
      currentTarget: switched.currentTarget,
      previousTarget: switched.previousTarget,
      pruned,
      requiresDrainRestart: true,
    }
  } finally {
    try {
      if (process.platform !== 'win32' && fs.existsSync(stagedBin)) fs.chmodSync(stagedBin, 0o600)
      fs.rmSync(stageDir, { recursive: true, force: true })
    } catch {}
  }
}

export function rollbackClaudeStore(storeRoot, { requireReadOnly = process.platform !== 'win32' } = {}) {
  const p = storePaths(storeRoot)
  const currentVersion = readSymlinkVersion(p.currentLink)
  const previousVersion = readSymlinkVersion(p.previousLink)
  if (!previousVersion) {
    return { ok: false, code: 'rollback_previous_missing', error: 'no previous Claude version recorded for rollback' }
  }
  const targetAbs = path.join(p.versionsDir, previousVersion, 'claude')
  const check = validateReadOnlyNoFollowPath(targetAbs, p.versionsDir, {
    requireExecutable: true,
    requireNotWritable: requireReadOnly,
  })
  if (!check.ok) {
    return { ok: false, code: check.code, error: `rollback target invalid: ${check.error}` }
  }

  const switched = atomicSwitchCurrent(storeRoot, previousVersion)
  if (!switched.ok) return switched

  const { sha256 } = sha256File(targetAbs)
  return {
    ok: true,
    rolledBackFrom: currentVersion || null,
    activeVersion: previousVersion,
    sha256,
    currentTarget: switched.currentTarget,
    previousTarget: switched.previousTarget,
    requiresDrainRestart: true,
  }
}
