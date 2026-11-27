import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PackageTar } from '../../src/lib/admin/kernel-catalog.mjs'
import { createFailoverMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'
import { resolveManifestClaudePath, resolveSlotClaude, isNativeCragV3Plus } from '../../src/lib/vm/slot-engine.mjs'
import { retainedClaudePath, stageCragV2Tree, verifyCragV2Tree } from '../../src/lib/vm/wrap-cli-runtime.mjs'
import {
  configureSlotCapacity,
  effectiveSlotCount,
  HEADLESS_BRIDGE_CAPACITY_DEFAULTS,
  isHeadlessBridgeSlot,
  resourcesForSlots,
  slotCapacityConfig,
  slotCapacityTarget,
  slotCreationLimits,
  slotsForLimits,
} from '../../src/lib/vm/slot-capacity.mjs'
import {
  expectedKernelSlots,
  writeKernelConfig,
  wrapSlotCount,
} from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import {
  callGoWorker,
  countTokensViaKernel,
  extractCragCallerHeaders,
  prepareWorkerPayload,
  sanitizeCallerUserAgentHint,
  streamGoWorker,
  workerEnvelope,
} from '../../src/lib/transport/go-worker-client.mjs'
import { handleUserCountTokens } from '../../src/lib/protocol/user-count-tokens.mjs'
import { prepareCragPrintBody, resolveCragCustomTemplate } from '../../src/lib/protocol/crag-print-prompt.mjs'
import { sanitizeCragBodyWhitelist, sanitizeCragEnv } from '../../src/lib/protocol/crag-whitelist.mjs'
import { prepareCragRequest } from '../../src/lib/protocol/kernel-request.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { clearRustHealthCache, rememberRustHealth } from '../../src/lib/transport/kernel-router.mjs'
import { verifyCragTelemetryPolicy } from '../../src/lib/transport/rust-kernel-client.mjs'
import { readSlotProcessStatus } from '../../src/lib/vm/slot-process-status.mjs'
import { applyNativeTelemetry } from '../../src/lib/vm/fleet-update.mjs'
import { CRS_COMPACT_IDENTITY, CRS_OFFICIAL_CLI_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'
import { DEFAULT_PERSONA_TEMPLATES } from '../../src/lib/identity/persona-template.mjs'
import { applyClaudeSSELineToMessage, createClaudeMessageAssembler } from '../../src/lib/protocol/convert.mjs'
import { costColumnsFromUsage, normalizeUsage } from '../../src/lib/admin/pricing.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

function makeElf(arch = 'amd64', marker = '') {
  const buf = Buffer.alloc(96 + Buffer.byteLength(marker))
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  buf.writeUInt16LE(3, 16)
  buf.writeUInt16LE(arch === 'amd64' ? 62 : 183, 18)
  buf.writeUInt32LE(1, 20)
  buf.write(marker, 96)
  return buf
}

function tarRecord(name, body = Buffer.alloc(0), { type = '0', size = body.length, mode = 0o644 } = {}) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  const octal = (offset, count, value) => header.write(`${value.toString(8).padStart(count - 1, '0')}\0`, offset, count)
  octal(100, 8, mode)
  octal(108, 8, 0)
  octal(116, 8, 0)
  octal(124, 12, size)
  octal(136, 12, 0)
  header.fill(32, 148, 156)
  header.write(type, 156, 1)
  header.write('ustar\0', 257, 6)
  header.write('00', 263, 2)
  const sum = header.reduce((total, value) => total + value, 0)
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)])
}

function buildTarBuffer(entries) {
  return Buffer.concat([
    ...entries.map(({ name, body = Buffer.alloc(0), ...opts }) => tarRecord(name, body, opts)),
    Buffer.alloc(1024),
  ])
}

function buildSignedCragTree(
  dir,
  {
    arch = 'amd64',
    claudeVersion = '2.1.321',
    includeOfficialClaude = true,
    signOfficialClaude = true,
    tamperOfficialSignature = false,
    extraCaps = [],
    authority = null,
    payloadKey = crypto.randomBytes(32),
  } = {},
) {
  const keys = authority || crypto.generateKeyPairSync('ed25519')
  const claudeDir = `claude-code-${claudeVersion}`
  const claudePath = `${claudeDir}/claude`
  fs.mkdirSync(path.join(dir, claudeDir), { recursive: true })
  const bootstrapElf = makeElf(arch, `bootstrap-${claudeVersion}`)
  const claudeElf = makeElf(arch, `claude-${claudeVersion}`)
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', payloadKey, nonce)
  cipher.setAAD(Buffer.from('CRAG-V2-PAYLOAD-V1\0'))
  const encrypted = Buffer.concat([cipher.update(bootstrapElf), cipher.final()])
  const payloadBytes = Buffer.concat([Buffer.from('CRAGV2E1'), nonce, cipher.getAuthTag(), encrypted])
  const pem = keys.publicKey.export({ format: 'pem', type: 'spki' })
  const pubRaw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const issuerPublicKeyId = sha(pubRaw)
  const payloadKeyId = sha(payloadKey)
  const payloadSigned = {
    product: 'crag-v2',
    format: 'CRAGV2E1',
    algorithm: 'aes-256-gcm',
    key_id: payloadKeyId,
    plaintext_sha256: sha(bootstrapElf),
    ciphertext_sha256: sha(payloadBytes),
  }
  const payloadSignature = crypto
    .sign(
      null,
      Buffer.concat([Buffer.from('CRAG-PAYLOAD-V1\0'), Buffer.from(JSON.stringify(payloadSigned))]),
      keys.privateKey,
    )
    .toString('base64url')

  const files = {
    'crag-v2': bootstrapElf,
    [claudePath]: claudeElf,
    'crag-v2.payload.enc': payloadBytes,
    'crag-license-public.pem': Buffer.from(pem, 'utf8'),
  }
  for (const [rel, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), bytes, { mode: rel === 'crag-v2' || rel === claudePath ? 0o755 : 0o644 })
  }

  const claudeSha = sha(claudeElf)
  let officialClaude
  if (includeOfficialClaude) {
    officialClaude = {
      version: claudeVersion,
      bundled: true,
      path: claudePath,
      sha256: claudeSha,
    }
    if (signOfficialClaude) {
      const signedOfficial = {
        product: 'crag-v2',
        arch,
        version: claudeVersion,
        path: claudePath,
        sha256: claudeSha,
      }
      const sigBuf = crypto.sign(
        null,
        Buffer.concat([Buffer.from('CRAG-OFFICIAL-CLAUDE-V1\0'), Buffer.from(JSON.stringify(signedOfficial))]),
        keys.privateKey,
      )
      if (tamperOfficialSignature) sigBuf[0] ^= 0xff
      officialClaude.signature = sigBuf.toString('base64url')
    }
  }

  const manifest = {
    family: 'crag',
    version: 'v2',
    arch,
    runtime: 'native',
    entrypoint: 'crag-v2',
    encrypted: true,
    capabilities: ['official_full', 'zero', 'cancel', 'telemetry', 'unix_socket_envelope', ...extraCaps],
    ...(officialClaude ? { officialClaude } : {}),
    authorization: {
      scheme: 'ed25519-x25519-v1',
      product: 'crag-v2',
      public_key: pubRaw.toString('base64url'),
      public_key_id: issuerPublicKeyId,
    },
    payload: {
      path: 'crag-v2.payload.enc',
      ...payloadSigned,
      signature: payloadSignature,
    },
    sha256: Object.fromEntries(Object.entries(files).map(([rel, bytes]) => [rel, sha(bytes)])),
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  return { dir, manifest, keys, issuerPublicKeyId, payloadKeyId, claudePath, files }
}

function tarEntriesFromDir(dir) {
  const entries = []
  function visit(current, prefix = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        entries.push({ name: `${rel}/`, type: '5', mode: 0o755 })
        visit(abs, rel)
      } else {
        entries.push({ name: rel, body: fs.readFileSync(abs), mode: fs.statSync(abs).mode & 0o777 })
      }
    }
  }
  visit(dir)
  return entries
}

// ---------------------------------------------------------------------------
// (a) Smooth Official CLI Upgrade: PackageTar + verifyCragV2Tree + staging + resolveSlotClaude
// ---------------------------------------------------------------------------

test('PackageTar + verifyCragV2Tree accept legacy 3.1.24 manifest AND signed claude-code-2.1.999/claude upgrade', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opt2a-pkg-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  // 1. Legacy 3.1.24 manifest (2.1.321, no officialClaude.signature)
  const legacySrc = path.join(tmp, 'legacy-src')
  const legacyPkg = buildSignedCragTree(legacySrc, {
    arch: 'amd64',
    claudeVersion: '2.1.321',
    includeOfficialClaude: true,
    signOfficialClaude: false,
  })
  const legacyOut = path.join(tmp, 'legacy-out')
  fs.mkdirSync(legacyOut, { recursive: true })
  await pipeline(Readable.from([buildTarBuffer(tarEntriesFromDir(legacySrc))]), new PackageTar(legacyOut))
  const legacyVerified = verifyCragV2Tree(legacyOut, {
    expectedArch: 'amd64',
    expectedIssuerPublicKeyId: legacyPkg.issuerPublicKeyId,
    expectedPayloadKeyId: legacyPkg.payloadKeyId,
  })
  assert.equal(legacyVerified.ok, true)
  assert.equal(legacyVerified.claudePath, 'claude-code-2.1.321/claude')
  assert.equal(legacyVerified.claudeVersion, '2.1.321')

  // 2. Future 2.1.999 signed manifest with officialClaude.signature (CRAG-OFFICIAL-CLAUDE-V1\0)
  const futureSrc = path.join(tmp, 'future-src')
  const futurePkg = buildSignedCragTree(futureSrc, {
    arch: 'amd64',
    claudeVersion: '2.1.999',
    includeOfficialClaude: true,
    signOfficialClaude: true,
    extraCaps: ['headless_claude_bridge_v1', 'count_tokens_v1'],
  })
  const futureOut = path.join(tmp, 'future-out')
  fs.mkdirSync(futureOut, { recursive: true })
  const wrappedEntries = [
    { name: 'crag-v2-licensed-amd64/', type: '5', mode: 0o755 },
    ...tarEntriesFromDir(futureSrc).map((e) => ({ ...e, name: `crag-v2-licensed-amd64/${e.name}` })),
  ]
  await pipeline(Readable.from([buildTarBuffer(wrappedEntries)]), new PackageTar(futureOut))
  const futureVerified = verifyCragV2Tree(futureOut, {
    expectedArch: 'amd64',
    expectedIssuerPublicKeyId: futurePkg.issuerPublicKeyId,
    expectedPayloadKeyId: futurePkg.payloadKeyId,
  })
  assert.equal(futureVerified.ok, true)
  assert.equal(futureVerified.claudePath, 'claude-code-2.1.999/claude')
  assert.equal(futureVerified.claudeVersion, '2.1.999')

  // Mismatched expectedIssuerPublicKeyId / expectedPayloadKeyId fails closed
  const badIssuer = verifyCragV2Tree(futureOut, {
    expectedArch: 'amd64',
    expectedIssuerPublicKeyId: '0'.repeat(64),
  })
  assert.equal(badIssuer.ok, false)
  assert.equal(badIssuer.code, 'crag_v2_identity_mismatch')

  const badPayloadKey = verifyCragV2Tree(futureOut, {
    expectedArch: 'amd64',
    expectedPayloadKeyId: 'f'.repeat(64),
  })
  assert.equal(badPayloadKey.ok, false)
  assert.equal(badPayloadKey.code, 'crag_v2_identity_mismatch')
})

test('verifyCragV2Tree rejects tampered officialClaude.signature and PackageTar rejects dual-version & unsafe archives', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opt2a-reject-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  // 1. Tampered officialClaude.signature fails closed
  const tamperedDir = path.join(tmp, 'tampered')
  buildSignedCragTree(tamperedDir, {
    arch: 'amd64',
    claudeVersion: '2.1.999',
    includeOfficialClaude: true,
    signOfficialClaude: true,
    tamperOfficialSignature: true,
  })
  const tamperedRes = verifyCragV2Tree(tamperedDir, { expectedArch: 'amd64' })
  assert.equal(tamperedRes.ok, false)
  assert.equal(tamperedRes.code, 'crag_v2_manifest_invalid')

  // 2. Dual-version tar archive is rejected by PackageTar
  const dualOut = path.join(tmp, 'dual-out')
  fs.mkdirSync(dualOut, { recursive: true })
  const dualTar = buildTarBuffer([
    { name: 'claude-code-2.1.321/', type: '5', mode: 0o755 },
    { name: 'claude-code-2.1.321/claude', body: makeElf('amd64', 'a'), mode: 0o755 },
    { name: 'claude-code-2.1.999/', type: '5', mode: 0o755 },
    { name: 'claude-code-2.1.999/claude', body: makeElf('amd64', 'b'), mode: 0o755 },
  ])
  await assert.rejects(
    pipeline(Readable.from([dualTar]), new PackageTar(dualOut)),
    (err) => err?.code === 'crag_v2_archive_invalid',
  )

  // 3. Unexpected file inside claude-code-<semver> dir is rejected
  const badMemberOut = path.join(tmp, 'bad-member-out')
  fs.mkdirSync(badMemberOut, { recursive: true })
  const badMemberTar = buildTarBuffer([{ name: 'claude-code-2.1.999/evil.js', body: Buffer.from('evil'), mode: 0o644 }])
  await assert.rejects(
    pipeline(Readable.from([badMemberTar]), new PackageTar(badMemberOut)),
    (err) => err?.code === 'crag_v2_archive_invalid',
  )

  // 4. resolveManifestClaudePath rejects traversal / version mismatch
  assert.equal(resolveManifestClaudePath({ officialClaude: { path: '../claude', version: '2.1.999' } }), null)
  assert.equal(
    resolveManifestClaudePath({ officialClaude: { path: 'claude-code-2.1.999/claude', version: '2.1.321' } }),
    null,
  )

  // 5. Strict #45 officialClaude wire checks: sha256=null, sha256 mismatch, missing sha256 when bundled+signed,
  //    wrong JSON key order in signature, padded base64url, and bundled=false all fail closed
  const strictDir = path.join(tmp, 'strict-official')
  const strictPkg = buildSignedCragTree(strictDir, {
    arch: 'amd64',
    claudeVersion: '2.1.999',
    includeOfficialClaude: true,
    signOfficialClaude: true,
  })
  const rewriteManifest = (mutate) => {
    const m = structuredClone(strictPkg.manifest)
    mutate(m)
    fs.writeFileSync(path.join(strictDir, 'manifest.json'), JSON.stringify(m))
    return verifyCragV2Tree(strictDir, { expectedArch: 'amd64' })
  }
  assert.equal(
    rewriteManifest((m) => {
      m.officialClaude.sha256 = null
    }).ok,
    false,
  )
  assert.equal(
    rewriteManifest((m) => {
      m.officialClaude.sha256 = '0'.repeat(64)
    }).ok,
    false,
  )
  assert.equal(
    rewriteManifest((m) => {
      delete m.officialClaude.sha256
    }).ok,
    false,
  )
  assert.equal(
    rewriteManifest((m) => {
      m.officialClaude.bundled = false
    }).ok,
    false,
  )
  assert.equal(
    rewriteManifest((m) => {
      m.officialClaude.signature = `${m.officialClaude.signature}=`
    }).ok,
    false,
  )
  assert.equal(
    rewriteManifest((m) => {
      const wrongOrder = {
        arch: m.arch,
        product: 'crag-v2',
        version: m.officialClaude.version,
        path: m.officialClaude.path,
        sha256: m.officialClaude.sha256,
      }
      m.officialClaude.signature = crypto
        .sign(
          null,
          Buffer.concat([Buffer.from('CRAG-OFFICIAL-CLAUDE-V1\0'), Buffer.from(JSON.stringify(wrongOrder))]),
          strictPkg.keys.privateKey,
        )
        .toString('base64url')
    }).ok,
    false,
  )
  // Legacy 3.1.24 manifest with officialClaude.bundled=true but neither sha256 nor signature still passes
  assert.equal(
    rewriteManifest((m) => {
      delete m.officialClaude.sha256
      delete m.officialClaude.signature
    }).ok,
    true,
  )
})

test('stageCragV2Tree dynamically retains immediately previous Claude dir and cleans up older superseded versions', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opt2a-stage-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const authority = crypto.generateKeyPairSync('ed25519')
  const payloadKey = crypto.randomBytes(32)

  const v1 = path.join(tmp, 'v1')
  const v2 = path.join(tmp, 'v2')
  const v3 = path.join(tmp, 'v3')
  const dest = path.join(tmp, 'live')

  buildSignedCragTree(v1, { claudeVersion: '2.1.321', authority, payloadKey })
  buildSignedCragTree(v2, { claudeVersion: '2.1.999', authority, payloadKey })
  buildSignedCragTree(v3, { claudeVersion: '2.2.0', authority, payloadKey })

  const s1 = stageCragV2Tree(v1, dest, { arch: 'amd64' })
  assert.equal(s1.ok, true)
  s1.commit()
  assert.equal(fs.existsSync(path.join(dest, 'claude-code-2.1.321/claude')), true)

  // Upgrade v1 -> v2: v1 retained for running slots, v2 active, tree validates with allowPreviousClaude
  const s2 = stageCragV2Tree(v2, dest, { arch: 'amd64' })
  assert.equal(s2.ok, true)
  s2.commit()
  assert.equal(fs.existsSync(path.join(dest, 'claude-code-2.1.999/claude')), true)
  assert.equal(fs.existsSync(path.join(dest, 'claude-code-2.1.321/claude')), true)
  assert.equal(verifyCragV2Tree(dest, { arch: 'amd64', allowPreviousClaude: true }).ok, true)
  assert.equal(retainedClaudePath('claude-code-2.1.321/claude', 'claude-code-2.1.999/claude'), true)
  assert.equal(retainedClaudePath('claude-code-2.1.999/claude', 'claude-code-2.1.999/claude'), false)

  // Same-version resync (v2 -> v2) keeps previously retained v1 intact for running slots
  const s2Resync = stageCragV2Tree(v2, dest, { arch: 'amd64' })
  assert.equal(s2Resync.ok, true)
  s2Resync.commit()
  assert.equal(fs.existsSync(path.join(dest, 'claude-code-2.1.999/claude')), true)
  assert.equal(fs.existsSync(path.join(dest, 'claude-code-2.1.321/claude')), true)

  // Upgrade v2 -> v3: v2 retained, superseded v1 cleaned up
  const s3 = stageCragV2Tree(v3, dest, { arch: 'amd64' })
  assert.equal(s3.ok, true)
  s3.commit()
  assert.equal(fs.existsSync(path.join(dest, 'claude-code-2.2.0/claude')), true)
  assert.equal(fs.existsSync(path.join(dest, 'claude-code-2.1.999/claude')), true)
  assert.equal(fs.existsSync(path.join(dest, 'claude-code-2.1.321')), false)
  assert.equal(verifyCragV2Tree(dest, { arch: 'amd64', allowPreviousClaude: true }).ok, true)
})

test('resolveSlotClaude & writeKernelConfig resolve dynamic manifest version and leave claude_bin empty on headless_claude_bridge_v1', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opt2a-sup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routing = { inference: { engine: 'rust', dataplane: 'crag', crag_kernel_version: 'v2' } }

  // 1. Legacy TUI manifest with newer 2.1.999 CLI -> dynamic path
  const tuiManifest = {
    officialClaude: { version: '2.1.999', path: 'claude-code-2.1.999/claude' },
    capabilities: ['generation_controls_v3', 'linux_tui_native_queue'],
  }
  const tuiResolved = resolveSlotClaude({}, routing, { bakedKernel: false, manifest: tuiManifest })
  assert.deepEqual(tuiResolved, {
    bin: '/home/kincli/.kin/crag-v2/claude-code-2.1.999/claude',
    native: true,
    version: '2.1.999',
  })

  // 2. Headless Bridge manifest -> bin: "" (CRAG resolves sibling manifest-verified claude)
  const bridgeManifest = {
    officialClaude: { version: '2.1.999', path: 'claude-code-2.1.999/claude' },
    capabilities: ['generation_controls_v3', 'headless_claude_bridge_v1', 'count_tokens_v1'],
  }
  const bridgeResolved = resolveSlotClaude({}, routing, { bakedKernel: false, manifest: bridgeManifest })
  assert.equal(bridgeResolved.bin, '')
  assert.equal(bridgeResolved.resolvedBin, '/home/kincli/.kin/crag-v2/claude-code-2.1.999/claude')
  assert.equal(bridgeResolved.version, '2.1.999')
  assert.equal(bridgeResolved.headlessBridge, true)

  // 3. writeKernelConfig reads installed slot manifest.json -> writes claude_bin: "" and headless capacity slots
  const vm = {
    id: 'vm-bridge-1',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    machine: { memory: '512m', pids_limit: 256 },
    claude: { rate_limit_tier: 'default_claude_max_20x' },
  }
  const cragDir = path.join(root, 'vms', vm.id, 'cli-home', '.kin', 'crag-v2')
  buildSignedCragTree(cragDir, {
    claudeVersion: '2.1.999',
    extraCaps: ['generation_controls_v3', 'headless_claude_bridge_v1', 'count_tokens_v1'],
  })
  writeKernelConfig(root, vm, { routing, token: 'tok-123' })
  const written = JSON.parse(fs.readFileSync(path.join(root, 'vms', vm.id, 'run', 'kernel.json'), 'utf8'))
  assert.equal(written.claude_bin, '')
  assert.equal(written.slots_per_worker, 20)
  assert.equal(written.session_slots, 20)
  // Headless bridge skips unnecessary TUI onboarding .claude.json patch
  assert.equal(fs.existsSync(path.join(root, 'vms', vm.id, 'cli-home', '.claude', '.claude.json')), false)
  // expectedKernelSlots preserves headless capacity from installed CRAG manifest (never shrinks 20 -> 1)
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  assert.equal(
    expectedKernelSlots({
      vmId: vm.id,
      vm,
      projectRoot: root,
      homeDir: path.join(root, 'vms', vm.id, 'cli-home'),
    }),
    20,
  )
  // Legacy TUI slot still writes onboarding .claude.json and resolves dynamic claude_bin path
  const tuiVm = {
    id: 'vm-tui-1',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    machine: { memory: '512m', pids_limit: 256 },
    claude: { rate_limit_tier: 'default_claude_max_20x' },
  }
  const tuiCragDir = path.join(root, 'vms', tuiVm.id, 'cli-home', '.kin', 'crag-v2')
  buildSignedCragTree(tuiCragDir, {
    claudeVersion: '2.1.999',
    extraCaps: ['generation_controls_v3', 'linux_tui_native_queue'],
  })
  writeKernelConfig(root, tuiVm, { routing, token: 'tok-456' })
  const tuiWritten = JSON.parse(fs.readFileSync(path.join(root, 'vms', tuiVm.id, 'run', 'kernel.json'), 'utf8'))
  assert.equal(tuiWritten.claude_bin, '/home/kincli/.kin/crag-v2/claude-code-2.1.999/claude')
  assert.equal(tuiWritten.slots_per_worker, 1)
  assert.equal(fs.existsSync(path.join(root, 'vms', tuiVm.id, 'cli-home', '.claude', '.claude.json')), true)
})

// ---------------------------------------------------------------------------
// (b) Headless Bridge Capacity Model vs Legacy TUI Formula
// ---------------------------------------------------------------------------

test('slot-capacity switches to 96 + 12*N MiB / 48 + 2*N pids on headless_claude_bridge_v1 and keeps legacy TUI formula otherwise', () => {
  configureSlotCapacity()
  assert.deepEqual(HEADLESS_BRIDGE_CAPACITY_DEFAULTS, {
    base_mib: 96,
    per_session_mib: 12,
    base_pids: 48,
    per_session_pids: 2,
  })

  const legacyMax20 = {
    id: 'vm-tui-max20',
    machine: { memory: '512m', pids_limit: 256 },
    claude: { rate_limit_tier: 'default_claude_max_20x' },
    workerStatus: { capabilities: ['generation_controls_v3', 'linux_tui_native_queue'] },
  }
  const headlessMax20 = {
    id: 'vm-bridge-max20',
    machine: { memory: '512m', pids_limit: 256 },
    claude: { rate_limit_tier: 'default_claude_max_20x' },
    workerStatus: { capabilities: ['generation_controls_v3', 'headless_claude_bridge_v1'] },
  }
  const headlessPro = {
    id: 'vm-bridge-pro',
    machine: { memory: '256m', pids_limit: 256 },
    claude: { rate_limit_tier: 'default_claude_ai' },
    runtime: { capabilities: ['headless_claude_bridge_v1'] },
  }

  assert.equal(isHeadlessBridgeSlot(legacyMax20), false)
  assert.equal(isHeadlessBridgeSlot(headlessMax20), true)
  assert.equal(isHeadlessBridgeSlot(headlessPro), true)

  // Legacy TUI formula unchanged: 256 + 320*N MiB / 128 + 64*N pids
  assert.deepEqual(resourcesForSlots(5), { slots: 5, memory: '2g', memoryMiB: 2048, pids: 448 })
  assert.deepEqual(resourcesForSlots(20), { slots: 20, memory: '8g', memoryMiB: 8192, pids: 1408 })
  assert.equal(effectiveSlotCount(legacyMax20), 1)
  assert.deepEqual(slotCapacityTarget(legacyMax20), {
    plan: 'max_20x',
    slots: 20,
    memory: '8g',
    memoryMiB: 8192,
    pids: 1408,
  })

  // Headless Bridge formula: 96 + 12*N MiB / 48 + 2*N pids
  assert.deepEqual(resourcesForSlots(5, null, { headlessBridge: true }), {
    slots: 5,
    memory: '256m',
    memoryMiB: 256,
    pids: 58,
  })
  assert.deepEqual(resourcesForSlots(12, null, { headlessBridge: true }), {
    slots: 12,
    memory: '256m',
    memoryMiB: 256,
    pids: 72,
  })
  assert.deepEqual(resourcesForSlots(20, null, { headlessBridge: true }), {
    slots: 20,
    memory: '512m',
    memoryMiB: 512,
    pids: 88,
  })
  assert.equal(slotsForLimits({ memoryMiB: 512, pids: 256 }, null, { headlessBridge: true }), 34)
  assert.equal(effectiveSlotCount(headlessMax20), 20)
  assert.equal(wrapSlotCount(headlessMax20), 20)
  assert.equal(effectiveSlotCount(headlessPro), 5)
  assert.deepEqual(slotCapacityTarget(headlessMax20), {
    plan: 'max_20x',
    slots: 20,
    memory: '512m',
    memoryMiB: 512,
    pids: 88,
  })
  assert.deepEqual(slotCreationLimits(headlessMax20), { memory: '512m', pids: 256 })
  assert.equal(slotCapacityConfig(null, { vm: headlessMax20 }).base_mib, 96)
})

// ---------------------------------------------------------------------------
// (c) Unified isNativeCragV3Plus(caps) recognizes headless_claude_bridge_v1
// ---------------------------------------------------------------------------

test('isNativeCragV3Plus recognizes headless_claude_bridge_v1 and keeps nativeOwnsHeaders=true in prepareWorkerPayload', () => {
  assert.equal(isNativeCragV3Plus(['generation_controls_v3', 'linux_tui_native_queue']), true)
  assert.equal(isNativeCragV3Plus(['generation_controls_v3', 'headless_claude_bridge_v1']), true)
  assert.equal(isNativeCragV3Plus(['headless_claude_bridge_v1']), false)
  assert.equal(isNativeCragV3Plus(['generation_controls_v3']), false)
  assert.equal(isNativeCragV3Plus(null), false)

  const prepared = prepareWorkerPayload({
    body: {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hello' }],
    },
    reqHeaders: {},
    exec: {
      vmId: 'vm-bridge-1',
      homeDir: '/tmp/vm-bridge-1',
      vm: { id: 'vm-bridge-1', dataplane: 'crag', crag_kernel_version: 'v2', claude: {} },
      workerStatus: {
        ok: true,
        dataplane: 'crag',
        kernel_version: 'v2',
        runtime_variant: 'crag-v2',
        capabilities: ['generation_controls_v3', 'headless_claude_bridge_v1', 'count_tokens_v1'],
      },
    },
    routing: {},
    cliHop: true,
    cragPrint: true,
  })
  assert.equal(prepared.headers, undefined)
})

// ---------------------------------------------------------------------------
// (d) countTokensViaKernel + user-count-tokens routing across OAuth/Setup/API-Key
// ---------------------------------------------------------------------------

unixTest(
  'countTokensViaKernel posts to /internal/v1/messages/count_tokens over kernel.sock and forwards headers & errors',
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opt2a-ct-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const sock = path.join(dir, 'kernel.sock')
    const received = []

    const server = http.createServer(async (req, res) => {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      received.push({ method: req.method, url: req.url, body })
      if (body.model === 'claude-err-400') {
        res.writeHead(400, {
          'content-type': 'application/json',
          'request-id': 'req_ct_err_400',
          'anthropic-ratelimit-unified-status': 'allowed',
        })
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'invalid tools payload' },
            request_id: 'req_ct_err_400',
          }),
        )
        return
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'request-id': 'req_ct_ok_200',
        'anthropic-ratelimit-unified-5h-utilization': '0.22',
        'cf-ray': '1234abcd-SJC',
      })
      res.end(JSON.stringify({ input_tokens: 456 }))
    })
    await new Promise((resolve) => server.listen(sock, resolve))
    t.after(() => new Promise((resolve) => server.close(resolve)))

    const exec = { vmId: 'vm-ct', vm: { id: 'vm-ct', runtime: { kernel_socket: sock } } }
    const ok = await countTokensViaKernel(exec, {
      body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(ok.ok, true)
    assert.equal(ok.status, 200)
    assert.equal(ok.via, 'rust-kernel')
    assert.equal(ok.body.input_tokens, 456)
    assert.equal(ok.headers['request-id'], 'req_ct_ok_200')
    assert.equal(ok.headers['anthropic-ratelimit-unified-5h-utilization'], '0.22')
    assert.equal(ok.headers['cf-ray'], '1234abcd-SJC')
    assert.equal(received[0].method, 'POST')
    assert.equal(received[0].url, '/internal/v1/messages/count_tokens')

    const err = await countTokensViaKernel(exec, {
      body: { model: 'claude-err-400', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(err.ok, false)
    assert.equal(err.status, 400)
    assert.equal(err.body.type, 'error')
    assert.equal(err.body.error.type, 'invalid_request_error')
    assert.equal(err.headers['request-id'], 'req_ct_err_400')
  },
)

test('user-count-tokens routes OAuth, Setup Token, and API Key through kernel.sock on count_tokens_v1 and falls back on older kernels', async () => {
  for (const credentialMode of ['oauth', 'setup-token', 'api-key']) {
    const calls = []
    let kernelCalled = 0
    let workerCalled = 0
    await handleUserCountTokens(
      {},
      {},
      {
        json: (_res, status, body, headers) => calls.push({ status, body, headers }),
        requireAuth: () => true,
        readBody: async () => ({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
        cfg: { limits: { max_body_bytes: 1024 } },
        stickyRouter: { extractPoolKey: () => null },
        getPoolScheduler: () => ({
          peekAccount: async () => ({
            ok: true,
            vmId: 'vm-bridge',
            accountId: 'acc-1',
            vm: { credential_mode: credentialMode },
            workerStatus: { capabilities: ['generation_controls_v3', 'headless_claude_bridge_v1', 'count_tokens_v1'] },
            exec: { vmId: 'vm-bridge' },
          }),
        }),
        countTokensViaKernel: async (_exec, { body }) => {
          kernelCalled++
          assert.equal(body.model, 'claude-sonnet-4-6')
          return {
            ok: true,
            status: 200,
            body: { input_tokens: 77 },
            headers: { 'request-id': `req_${credentialMode}`, 'anthropic-ratelimit-unified-status': 'allowed' },
          }
        },
        countTokensViaWorker: async () => {
          workerCalled++
          return { ok: true, status: 200, body: { input_tokens: 1 } }
        },
      },
    )
    assert.equal(kernelCalled, 1, `${credentialMode} should route through countTokensViaKernel`)
    assert.equal(workerCalled, 0, `${credentialMode} must not fall back to countTokensViaWorker`)
    assert.equal(calls[0].status, 200)
    assert.equal(calls[0].body.input_tokens, 77)
    assert.equal(calls[0].headers['request-id'], `req_${credentialMode}`)
  }

  // Error from countTokensViaKernel preserves official error envelope + headers
  const errCalls = []
  await handleUserCountTokens(
    {},
    {},
    {
      json: (_res, status, body, headers) => errCalls.push({ status, body, headers }),
      requireAuth: () => true,
      readBody: async () => ({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
      cfg: { limits: { max_body_bytes: 1024 } },
      stickyRouter: { extractPoolKey: () => null },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          vmId: 'vm-bridge',
          accountId: 'acc-1',
          vm: { credential_mode: 'oauth' },
          workerStatus: { capabilities: ['count_tokens_v1'] },
          exec: { vmId: 'vm-bridge' },
        }),
      }),
      countTokensViaKernel: async () => ({
        ok: false,
        status: 400,
        body: {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Exact upstream error' },
          request_id: 'req_400_ct',
        },
        headers: { 'request-id': 'req_400_ct' },
      }),
    },
  )
  assert.equal(errCalls[0].status, 400)
  assert.equal(errCalls[0].body.error.message, 'Exact upstream error')
  assert.equal(errCalls[0].headers['request-id'], 'req_400_ct')

  // Fallback on older kernel without count_tokens_v1: OAuth -> usage view, Setup Token -> worker
  const legacyOAuthCalls = []
  let legacyKernelCalls = 0
  await handleUserCountTokens(
    {},
    {},
    {
      json: (_res, status, body) => legacyOAuthCalls.push({ status, body }),
      requireAuth: () => true,
      readBody: async () => ({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
      cfg: { limits: { max_body_bytes: 1024 } },
      stickyRouter: { extractPoolKey: () => null },
      accountQuota: {
        repo: {
          get: () => ({
            unified: {
              headers: {
                '5h': { utilization: 0.2, status: 'allowed', reset: 'r5' },
                '7d': { utilization: 0.1, status: 'allowed', reset: 'r7' },
              },
            },
          }),
        },
      },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          vmId: 'vm-legacy',
          accountId: 'acc-legacy',
          vm: { credential_mode: 'oauth' },
          workerStatus: { capabilities: ['generation_controls_v3', 'linux_tui_native_queue'] },
          exec: { vmId: 'vm-legacy' },
        }),
      }),
      countTokensViaKernel: async () => {
        legacyKernelCalls++
        return { ok: true, status: 200, body: { input_tokens: 99 } }
      },
    },
  )
  assert.equal(legacyKernelCalls, 0)
  assert.equal(legacyOAuthCalls[0].status, 200)
  assert.equal(legacyOAuthCalls[0].body.unit, 'percent_used')

  // Fallback on older kernel without count_tokens_v1: Setup Token -> countTokensViaWorker
  const legacySetupCalls = []
  let legacySetupWorkerCalls = 0
  await handleUserCountTokens(
    {},
    {},
    {
      json: (_res, status, body) => legacySetupCalls.push({ status, body }),
      requireAuth: () => true,
      readBody: async () => ({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
      cfg: { limits: { max_body_bytes: 1024 } },
      stickyRouter: { extractPoolKey: () => null },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          vmId: 'vm-legacy-st',
          accountId: 'acc-legacy-st',
          vm: { credential_mode: 'setup-token' },
          workerStatus: { capabilities: ['generation_controls_v3', 'linux_tui_native_queue'] },
          exec: { vmId: 'vm-legacy-st' },
        }),
      }),
      countTokensViaWorker: async () => {
        legacySetupWorkerCalls++
        return { ok: true, status: 200, body: { input_tokens: 42 } }
      },
    },
  )
  assert.equal(legacySetupWorkerCalls, 1)
  assert.equal(legacySetupCalls[0].status, 200)
  assert.equal(legacySetupCalls[0].body.input_tokens, 42)
})

// ---------------------------------------------------------------------------
// (e) Phase B+ P0: Caller Header & Entrypoint Propagation
// ---------------------------------------------------------------------------

const HEADLESS_CAPS = [
  'generation_controls_v3',
  'headless_claude_bridge_v1',
  'count_tokens_v1',
  'native_handoff_v1',
  'provider_result_v2',
  'request_safeguards',
  'request_speed',
]

function makeHeadlessExec(caps = HEADLESS_CAPS, overrides = {}) {
  return {
    vmId: 'vm-bridge-p0',
    homeDir: '/tmp/vm-bridge-p0',
    vm: {
      id: 'vm-bridge-p0',
      dataplane: 'crag',
      crag_kernel_version: 'v2',
      claude: {},
    },
    workerStatus: {
      ok: true,
      ready: true,
      dataplane: 'crag',
      kernel_version: 'v2',
      runtime_variant: 'crag-v2',
      capabilities: caps,
    },
    ...overrides,
  }
}

test('Phase B+ P0: allowlisted x-claude-code-*, x-app, x-client-request-id & official user-agent propagate while auth/third-party UA stay stripped', async () => {
  assert.equal(sanitizeCallerUserAgentHint('claude-cli/2.1.321 (external, cli)'), 'claude-cli/2.1.321 (external, cli)')
  assert.equal(
    sanitizeCallerUserAgentHint('claude-cli/2.1.321 (external, cli-bg)'),
    'claude-cli/2.1.321 (external, cli-bg)',
  )
  assert.equal(
    sanitizeCallerUserAgentHint('claude-cli/2.1.321 (external, sdk-cli)'),
    'claude-cli/2.1.321 (external, sdk-cli)',
  )
  assert.equal(sanitizeCallerUserAgentHint('OpenCode/1.4.0'), null)
  assert.equal(sanitizeCallerUserAgentHint('claude-cli/2.1.321 (external, cli)\r\nX-Evil: 1'), null)

  const callerReqHeaders = {
    authorization: 'Bearer sk-vm-secret-token',
    'x-api-key': 'sk-ant-secret-key',
    cookie: 'session=secret',
    connection: 'keep-alive',
    host: 'proxy.internal',
    'user-agent': 'claude-cli/2.1.321 (external, cli-bg)',
    'x-app': 'cli-bg',
    'x-client-request-id': 'creq_subagent_001',
    'X-Claude-Code-Session-Id': 'sess_child_42',
    'x-claude-code-prompt-id': 'prompt_99',
    'x-claude-code-request-class': 'subagent',
    'x-claude-code-parent-session-id': 'sess_parent_01',
    'x-claude-code-workload': 'code-review',
    'x-claude-code-dispatch-entrypoint': 'agent-tool',
    'x-claude-code-sandy-plover': '[]',
    'x-claude-code-evil-crlf': 'ok\r\ninjected',
  }

  for (const strictPassthrough of [false, true]) {
    const { envelope } = await workerEnvelope({
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
      },
      reqHeaders: callerReqHeaders,
      exec: makeHeadlessExec(),
      routing: {},
      stream: true,
      cliHop: true,
      cragPrint: true,
      strictPassthrough,
    })
    assert.deepEqual(envelope.headers, {
      'user-agent': 'claude-cli/2.1.321 (external, cli-bg)',
      'x-app': 'cli-bg',
      'x-client-request-id': 'creq_subagent_001',
      'x-claude-code-session-id': 'sess_child_42',
      'x-claude-code-prompt-id': 'prompt_99',
      'x-claude-code-request-class': 'subagent',
      'x-claude-code-parent-session-id': 'sess_parent_01',
      'x-claude-code-workload': 'code-review',
      'x-claude-code-dispatch-entrypoint': 'agent-tool',
      'x-claude-code-sandy-plover': '[]',
    })
    assert.equal('authorization' in envelope.headers, false)
    assert.equal('x-api-key' in envelope.headers, false)
    assert.equal('cookie' in envelope.headers, false)
    assert.equal('connection' in envelope.headers, false)
    assert.equal('x-claude-code-evil-crlf' in envelope.headers, false)
  }

  // Third-party UA is stripped while trace headers still forward cleanly
  const extracted = extractCragCallerHeaders({
    authorization: 'Bearer secret',
    'user-agent': 'OpenCode/1.2.3',
    'x-claude-code-session-id': 'sess_3p',
  })
  assert.deepEqual(extracted, { 'x-claude-code-session-id': 'sess_3p' })
})

// ---------------------------------------------------------------------------
// (f) Phase B+ P0: Parent Session Cascade Cancel Context (/internal/v1/cancel)
// ---------------------------------------------------------------------------

unixTest(
  'Phase B+ P0: /internal/v1/cancel forwards session_id alongside request_id on abort and omits when absent',
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opt2a-cancel-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const sock = path.join(dir, 'worker.sock')
    const cancels = []
    let releaseCancelWait
    const waitForCancels = (count) =>
      new Promise((resolve) => {
        if (cancels.length >= count) return resolve()
        releaseCancelWait = () => {
          if (cancels.length >= count) resolve()
        }
      })

    const server = http.createServer(async (req, res) => {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (req.url === '/internal/v1/cancel') {
        cancels.push(body)
        releaseCancelWait?.()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5-5","usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
      )
      // Keep stream open until client aborts
      req.on('close', () => {
        if (!res.writableEnded) res.end()
      })
    })
    await new Promise((resolve) => server.listen(sock, resolve))
    t.after(() => new Promise((resolve) => server.close(resolve)))

    const exec = {
      ...makeHeadlessExec(),
      vm: {
        id: 'vm-bridge-cancel',
        dataplane: 'crag',
        crag_kernel_version: 'v2',
        claude: {},
        runtime: { worker_socket: sock },
      },
    }

    // 1. Stream with x-claude-code-session-id -> cancel carries session_id
    const ac1 = new AbortController()
    const streamPromise = streamGoWorker({
      exec,
      body: { model: 'claude-sonnet-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
      reqHeaders: { 'x-claude-code-session-id': 'sess_parent_cascade_1' },
      cliHop: true,
      cragPrint: true,
      signal: ac1.signal,
      onEvent: () => {
        ac1.abort()
      },
    })
    setTimeout(() => ac1.abort(), 30)
    await streamPromise
    await waitForCancels(1)
    assert.equal(typeof cancels[0].request_id, 'string')
    assert.ok(cancels[0].request_id.length > 0)
    assert.equal(cancels[0].session_id, 'sess_parent_cascade_1')

    // 2. Call without session_id -> cancel sends only request_id
    const ac2 = new AbortController()
    const callPromise = callGoWorker({
      exec,
      body: { model: 'claude-sonnet-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
      reqHeaders: {},
      cliHop: true,
      cragPrint: true,
      signal: ac2.signal,
    })
    setTimeout(() => ac2.abort(), 30)
    await callPromise
    await waitForCancels(2)
    assert.equal(typeof cancels[1].request_id, 'string')
    assert.equal(Object.hasOwn(cancels[1], 'session_id'), false)
  },
)

// ---------------------------------------------------------------------------
// (g) Phase B+ P0: 2.1.321 Passthrough Fields & Advisor Usage / 5m+1h Cache Split
// ---------------------------------------------------------------------------

test('Phase B+ P0: diagnostics, fallbacks, fallback_credit_token, request_tags pass whitelist on headless bridge and strip cleanly on legacy TUI', () => {
  const input = {
    model: 'claude-sonnet-5-5',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'check' }],
    diagnostics: { previous_message_id: 'msg_prev_123' },
    fallbacks: ['claude-sonnet-4-6'],
    fallback_credit_token: 'fb_tok_abc',
    request_tags: ['subagent', 'code-review'],
  }

  // Headless bridge preserves all 4 fields cleanly under default crag_strict_passthrough: false
  const bridge = prepareCragRequest(input, { capabilities: HEADLESS_CAPS })
  assert.deepEqual(bridge.diagnostics, { previous_message_id: 'msg_prev_123' })
  assert.deepEqual(bridge.fallbacks, ['claude-sonnet-4-6'])
  assert.equal(bridge.fallback_credit_token, 'fb_tok_abc')
  assert.deepEqual(bridge.request_tags, ['subagent', 'code-review'])

  // Legacy TUI strips cleanly without throwing 400
  const legacyCaps = ['generation_controls_v3', 'linux_tui_native_queue']
  const legacy = sanitizeCragBodyWhitelist(input, { capabilities: legacyCaps })
  assert.equal('diagnostics' in legacy.body, false)
  assert.equal('fallbacks' in legacy.body, false)
  assert.equal('fallback_credit_token' in legacy.body, false)
  assert.equal('request_tags' in legacy.body, false)
  assert.ok(legacy.strippedFields.includes('diagnostics'))
  assert.ok(legacy.strippedFields.includes('fallbacks'))
  assert.ok(legacy.strippedFields.includes('fallback_credit_token'))
  assert.ok(legacy.strippedFields.includes('request_tags'))
})

unixTest(
  'Phase B+ P0: advisor usage.iterations (advisor_message + model) and cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens survive SSE, assembly, pricing & request-log',
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opt2a-usage-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const sock = path.join(dir, 'worker.sock')
    const tokenFile = path.join(dir, 'internal.token')
    fs.writeFileSync(tokenFile, 'opt2a-usage-token')

    const sseUsage = {
      input_tokens: 120,
      output_tokens: 340,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 500,
      cache_creation: {
        ephemeral_5m_input_tokens: 200,
        ephemeral_1h_input_tokens: 300,
      },
      iterations: [
        {
          type: 'message',
          model: 'claude-sonnet-4-6',
          input_tokens: 120,
          output_tokens: 340,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 500,
        },
        {
          type: 'advisor_message',
          model: 'claude-opus-4-6',
          input_tokens: 600,
          output_tokens: 250,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 150,
          cache_creation: {
            ephemeral_5m_input_tokens: 50,
            ephemeral_1h_input_tokens: 100,
          },
        },
      ],
    }

    // Even when kin_provider_result only carries totals (omitting cache_creation & iterations),
    // native-handoff preserves the validated breakdown observed on SSE.
    const summaryTotalsOnly = {
      schema_version: 2,
      type: 'kin_provider_result',
      source: 'crag',
      http_status: 200,
      provider_complete: true,
      usage_complete: true,
      response_valid: true,
      message_id: 'msg_advisor_e2e_1',
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 120,
        output_tokens: 340,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 500,
      },
    }

    const frame = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`
    const server = http.createServer(async (req, res) => {
      for await (const _c of req) {
        // drain
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        frame({
          type: 'message_start',
          message: {
            id: 'msg_advisor_e2e_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 120,
              output_tokens: 0,
              cache_read_input_tokens: 800,
              cache_creation_input_tokens: 500,
              cache_creation: sseUsage.cache_creation,
            },
          },
        }) +
          frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
          frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done with advisor.' } }) +
          frame({ type: 'content_block_stop', index: 0 }) +
          frame({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: sseUsage,
          }) +
          frame(summaryTotalsOnly) +
          frame({ type: 'message_stop' }),
      )
      res.end()
    })
    await new Promise((resolve) => server.listen(sock, resolve))
    t.after(() => new Promise((resolve) => server.close(resolve)))

    const exec = {
      ...makeHeadlessExec(),
      vm: {
        id: 'vm-bridge-advisor',
        dataplane: 'crag',
        crag_kernel_version: 'v2',
        claude: {},
        runtime: { worker_socket: sock, worker_token_file: tokenFile },
      },
    }
    const lines = []
    const received = await streamGoWorker({
      exec,
      managedCrag: true,
      body: { model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: 'advise' }] },
      cliHop: true,
      cragPrint: true,
      onEvent: (line) => lines.push(line),
    })

    assert.equal(received.ok, true)
    assert.deepEqual(received.usage.cache_creation, sseUsage.cache_creation)
    assert.deepEqual(received.usage.iterations, sseUsage.iterations)
    assert.deepEqual(received.body.usage.cache_creation, sseUsage.cache_creation)
    assert.deepEqual(received.body.usage.iterations, sseUsage.iterations)

    // Non-streaming SSE assembler preserves both fields too
    const assembler = createClaudeMessageAssembler()
    for (const line of lines) applyClaudeSSELineToMessage(line, assembler)
    assert.deepEqual(assembler.message.usage.cache_creation, sseUsage.cache_creation)
    assert.deepEqual(assembler.message.usage.iterations, sseUsage.iterations)

    // Pricing & RequestLog preserve advisor_usage (with model) and 5m/1h cache split
    const normalized = normalizeUsage(received.usage)
    assert.equal(normalized.advisor_usage.length, 1)
    assert.equal(normalized.advisor_usage[0].model, 'claude-opus-4-6')
    assert.equal(normalized.advisor_usage[0].cache_creation_5m_tokens, 50)
    assert.equal(normalized.advisor_usage[0].cache_creation_1h_tokens, 100)
    const priced = costColumnsFromUsage(received.usage, 'claude-sonnet-4-6')
    assert.ok(priced.advisor_cost > 0, 'advisor_message iteration must be priced')
    assert.ok(priced.cache_creation_cost > 0)

    const logStore = new RequestLogStore({ dataDir: dir })
    t.after(() => logStore.db?.close?.())
    const logCtx = logStore.start(
      { method: 'POST', url: '/v1/messages', headers: {} },
      { protocol: 'anthropic.messages' },
    )
    const logged = logStore.finish(logCtx, {
      status: 200,
      model: 'claude-sonnet-4-6',
      usage: received.usage,
    })
    assert.equal(logged.cache_creation_5m_tokens, 200)
    assert.equal(logged.cache_creation_1h_tokens, 300)
    assert.ok(logged.advisor_cost > 0)
  },
)

// ---------------------------------------------------------------------------
// (h) Phase B-R: Never delete out.system or fold role:"system" on headless bridge;
//     zero (0注入) & official_full without legacy crag_prompt.mode
// ---------------------------------------------------------------------------

test('Phase B-R: default crag_strict_passthrough=false + officialPassthrough=true + headless_claude_bridge_v1 preserves native system[] and mid-conv role:"system" verbatim (unit + handleProtocol)', async (t) => {
  const nativeSystem = [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.321.abc; cc_entrypoint=cli; cch=00000;' },
    { type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM },
    {
      type: 'text',
      text: 'Official TUI harness prompt block.',
      cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' },
    },
    {
      type: 'text',
      text: 'Official guidance block.',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ]
  const nativeMessages = [
    { role: 'user', content: [{ type: 'text', text: 'Inspect the repo.' }] },
    {
      role: 'system',
      content: [{ type: 'text', text: '<system-reminder>Mid-conversation environment update</system-reminder>' }],
      clear_at: 'tool_uses',
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Checking now.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
  ]

  // 1. Unit level: prepareCragPrintBody -> prepareCragRequest
  const printed = prepareCragPrintBody(
    { model: 'claude-sonnet-5-5', max_tokens: 1024, system: nativeSystem, messages: nativeMessages },
    {
      preset: 'official_full',
      officialPassthrough: true,
      strictPassthrough: false,
      capabilities: HEADLESS_CAPS,
      foldSystemMessages: true,
    },
  )
  assert.deepEqual(printed.system, nativeSystem, 'headless bridge must NEVER delete native CC system[]')
  assert.equal(printed.messages[1].role, 'system', 'headless bridge must NEVER fold mid-conv role:"system"')
  assert.equal(printed.messages[1].clear_at, 'tool_uses')
  assert.equal('crag_prompt' in printed, false)
  assert.equal('crag_persona_preset' in printed, false)

  // 2. End-to-end handleProtocol under default crag_strict_passthrough: false
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opt2a-phasebr-hp-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  clearRustHealthCache()
  t.after(() => clearRustHealthCache())

  const routing = {
    sticky: { outbound_session: 'passthrough' },
    compatibility: {
      official_cc_passthrough: true,
      crag_strict_passthrough: false,
      crag_persona_preset: 'official_full',
      crag_fold_history_system: true,
      cache_ttl: '1h',
    },
  }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))

  const sent = []
  const vm = {
    id: 'crag-headless-native',
    node_id: 'node-fixture',
    dataplane: 'wrap',
    official_cc_inference: 'cli-hop',
  }
  const health = {
    ok: true,
    ready: true,
    status: 'ready',
    cli_pid: 22222,
    ready_slots: 10,
    runtime_variant: 'crag-v2',
    transport: 'headless_bridge',
    capabilities: HEADLESS_CAPS,
  }
  const exec = { vmId: vm.id, vm, homeDir: root, workerStatus: health }
  rememberRustHealth(exec, { ok: true, health })

  const scheduler = {
    async selectAndReserve() {
      return { ok: true, vmId: vm.id, accountId: vm.id, vm, exec, release() {} }
    },
    markSuccess() {},
    markCooldown() {},
    releaseAccountSessions() {},
  }
  const runner = new FailoverRunner({
    scheduler,
    schedulerRuntime: createFailoverMockSchedulerRuntime({ scheduler }),
    config: { max_same_account_retries: 0 },
  })

  const runRequest = async (incoming, reqHeaders, routingOverride = routing) => {
    fs.writeFileSync(routingFile, JSON.stringify(routingOverride))
    sent.length = 0
    const response = {
      headersSent: false,
      statusCode: 0,
      on() {},
      once() {},
      off() {},
      write() {},
      end() {},
    }
    const handler = createHandleProtocol({
      json(_res, status, body) {
        response.status = status
        response.statusCode = status
        response.body = body
        return body
      },
      writeSSEHeaders() {},
      readBody: async () => structuredClone(incoming),
      requireAuth: () => true,
      cfg: {
        rewrite: { enabled: false },
        intercept: { rules: [] },
        distill: { enabled: false },
        limits: { max_body_bytes: 2 * 1024 * 1024, upstream_timeout_ms: 2000 },
        paths: { data: root, project: root },
      },
      requestLog: { start: () => ({ request_id: 'phasebr-req' }), finish() {} },
      stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
      accountQuota: { ingestHeaders() {} },
      apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage() {} },
      apiScheduler: {},
      apiEndpointStore: {},
      stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
      routingConfigPath: routingFile,
      routingConfig: routingOverride,
      groupsRepo: { rateMultiplier: () => 1 },
      failoverRunner: {
        run(opts) {
          return runner.run({
            ...opts,
            callAttempt({ body, attemptMeta }) {
              const payload = prepareWorkerPayload({
                body,
                reqHeaders,
                exec,
                routing: routingOverride,
                cliHop: attemptMeta?.cliHop === true,
                cragPrint: attemptMeta?.cragPrint === true,
                strictPassthrough: attemptMeta?.strictPassthrough === true,
                safeguardsSanitized: attemptMeta?.safeguardsSanitized === true,
              })
              sent.push({ hopBody: structuredClone(body), payload, meta: attemptMeta })
              return {
                ok: true,
                status: 200,
                terminalState: 'verified',
                body: {
                  id: 'msg_br_ok',
                  type: 'message',
                  role: 'assistant',
                  model: incoming.model,
                  content: [{ type: 'text', text: 'ok' }],
                  stop_reason: 'end_turn',
                  usage: { input_tokens: 10, output_tokens: 2 },
                },
              }
            },
          })
        },
      },
    })
    await handler.handleProtocol(
      {
        method: 'POST',
        url: '/v1/messages',
        headers: reqHeaders,
        apiKeyKind: 'managed',
        apiKeyRecord: { id: 'fixture' },
        once() {},
        off() {},
      },
      response,
      'anthropic.messages',
      '/v1/messages',
    )
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return sent[0]
  }

  // Native CC request under default crag_strict_passthrough: false
  const nativeRun = await runRequest(
    {
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      stream: false,
      system: nativeSystem,
      messages: nativeMessages,
      tools: [{ name: 'Bash', description: 'Run shell', input_schema: { type: 'object', properties: {} } }],
      metadata: {
        user_id:
          'user_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_account_a_session_11111111-1111-4111-8111-111111111111',
      },
      diagnostics: { previous_message_id: 'msg_01prev' },
      request_tags: ['tui-native'],
    },
    {
      authorization: 'Bearer sk-vm-test',
      'user-agent': 'claude-cli/2.1.321 (external, cli)',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'x-app': 'cli',
      'x-claude-code-session-id': '11111111-1111-4111-8111-111111111111',
      'x-claude-code-request-class': 'main',
    },
  )
  assert.equal(nativeRun.meta.strictPassthrough, false)
  assert.equal(nativeRun.payload.gated.system.length, 3, 'all 3 non-billing native TUI system blocks survive intact')
  assert.equal(nativeRun.payload.gated.system[0].text, CRS_OFFICIAL_CLI_SYSTEM)
  assert.equal(nativeRun.payload.gated.system[1].text, 'Official TUI harness prompt block.')
  assert.deepEqual(nativeRun.payload.gated.system[1].cache_control, { type: 'ephemeral', ttl: '1h', scope: 'global' })
  assert.equal(nativeRun.payload.gated.messages[1].role, 'system')
  assert.equal(nativeRun.payload.gated.messages[1].clear_at, 'tool_uses')
  assert.deepEqual(nativeRun.payload.gated.diagnostics, { previous_message_id: 'msg_01prev' })
  assert.deepEqual(nativeRun.payload.gated.request_tags, ['tui-native'])
  assert.equal('crag_prompt' in nativeRun.payload.gated, false)
  assert.equal(nativeRun.payload.headers['x-claude-code-session-id'], '11111111-1111-4111-8111-111111111111')
  assert.equal(nativeRun.payload.headers['user-agent'], 'claude-cli/2.1.321 (external, cli)')

  // Third-party zero (0注入) preset on headless_claude_bridge_v1:
  // preserves caller system[] verbatim (NOT relocated into messages[0]!), >64KiB & citations OK,
  // sets crag_persona_preset="zero" + crag_prompt_version, NO crag_prompt!
  const hugePrompt = `You are a bespoke third-party reviewer. ${'x'.repeat(70 * 1024)}`
  const zeroSystem = [
    {
      type: 'text',
      text: hugePrompt,
      citations: [
        { type: 'char_location', cited_text: 'rule', document_index: 0, start_char_index: 0, end_char_index: 4 },
      ],
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ]
  const zeroRun = await runRequest(
    {
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      stream: false,
      system: zeroSystem,
      messages: [{ role: 'user', content: 'Review my patch.' }],
    },
    {
      authorization: 'Bearer sk-vm-3p',
      'user-agent': 'OpenCode/2.0.0',
    },
    {
      ...routing,
      compatibility: {
        ...routing.compatibility,
        crag_persona_preset: 'zero',
      },
    },
  )
  assert.equal('crag_prompt' in zeroRun.payload.gated, false)
  assert.equal(zeroRun.payload.gated.crag_persona_preset, 'zero')
  assert.equal(zeroRun.payload.gated.crag_prompt_version, CRS_OFFICIAL_CLI_SYSTEM)
  assert.equal(zeroRun.payload.gated.system.length, 1, '0 extra system blocks injected')
  assert.equal(zeroRun.payload.gated.system[0].text, hugePrompt)
  assert.deepEqual(zeroRun.payload.gated.system[0].citations, zeroSystem[0].citations)
  assert.equal(zeroRun.payload.gated.messages.length, 1)
  assert.deepEqual(zeroRun.payload.gated.messages[0].content, [{ type: 'text', text: 'Review my patch.' }])
  assert.equal(zeroRun.payload.headers, undefined, 'third-party UA is not forwarded')

  // Third-party official_full on headless_claude_bridge_v1: no crag_prompt, no citations/64KiB throw
  const fullPrinted = prepareCragPrintBody(
    {
      model: 'claude-sonnet-5-5',
      system: zeroSystem,
      messages: [{ role: 'user', content: 'hi' }],
    },
    { preset: 'official_full', officialPassthrough: false, capabilities: HEADLESS_CAPS },
  )
  assert.equal('crag_prompt' in fullPrinted, false)
  assert.equal(fullPrinted.crag_persona_preset, 'official_full')
  assert.equal('crag_prompt_version' in fullPrinted, false)
  assert.deepEqual(fullPrinted.system, zeroSystem)

  // Legacy TUI gateCragBody strips headless-only internal fields so old CRAG 3.1.24 never sees them
  const legacyPayload = prepareWorkerPayload({
    body: {
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      crag_persona_preset: 'zero',
      crag_prompt_version: CRS_OFFICIAL_CLI_SYSTEM,
    },
    reqHeaders: {},
    exec: makeHeadlessExec(['generation_controls_v3', 'linux_tui_native_queue']),
    routing,
    cliHop: true,
    cragPrint: true,
  })
  assert.equal('crag_persona_preset' in legacyPayload.gated, false)
  assert.equal('crag_prompt_version' in legacyPayload.gated, false)
})

test('Phase B-R2: legacy non-headless TUI zero preset with empty system emits prompt_replace_empty when advertised and stays no-op otherwise', () => {
  const legacyCapsWithout = ['generation_controls_v3', 'linux_tui_native_queue', 'prompt_replace', 'prompt_append']
  const legacyCapsWith = [...legacyCapsWithout, 'prompt_replace_empty']
  const emptyCases = [
    { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] },
    { model: 'claude-sonnet-5-5', system: '', messages: [{ role: 'user', content: 'hi' }] },
    {
      model: 'claude-sonnet-5-5',
      system: [{ type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM }],
      messages: [{ role: 'user', content: 'hi' }],
    },
  ]

  for (const input of emptyCases) {
    const withCap = prepareCragPrintBody(input, {
      preset: 'zero',
      officialPassthrough: false,
      capabilities: legacyCapsWith,
    })
    assert.equal('system' in withCap, false)
    assert.deepEqual(withCap.crag_prompt, { mode: 'replace', text: '' })

    const withoutCap = prepareCragPrintBody(input, {
      preset: 'zero',
      officialPassthrough: false,
      capabilities: legacyCapsWithout,
    })
    assert.equal('system' in withoutCap, false)
    assert.equal(withoutCap.crag_prompt, undefined)
  }

  // Native CC passthrough on legacy TUI must never emit empty replace even when prompt_replace_empty is advertised
  const nativeLegacy = prepareCragPrintBody(
    { model: 'claude-sonnet-5-5', system: CRS_OFFICIAL_CLI_SYSTEM, messages: [{ role: 'user', content: 'hi' }] },
    { preset: 'zero', officialPassthrough: true, capabilities: legacyCapsWith },
  )
  assert.equal(nativeLegacy.crag_prompt, undefined)

  // Non-zero official_full with empty system stays no-op even when prompt_replace_empty is advertised
  const appendLegacy = prepareCragPrintBody(
    { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] },
    { preset: 'official_full', officialPassthrough: false, capabilities: legacyCapsWith },
  )
  assert.equal(appendLegacy.crag_prompt, undefined)
})

// ---------------------------------------------------------------------------
// (i) Phase B-R3: Panel Custom system[] Direct Replace, crag_env & Telemetry
//     scope="headless_bridge" + kernel.json locale
// ---------------------------------------------------------------------------

test('Phase B-R3 Item 2: headless_claude_bridge_v1 custom persona_templates direct replace (>64KiB, keeps cache_control, strips billing) + SSOT priority + whitelist blocks-only validation', async (t) => {
  const hugeCustomText = `Custom panel system prompt ${'A'.repeat(72 * 1024)}`
  const customRouting = {
    compatibility: {
      persona_preset: 'custom',
      crag_persona_preset: 'official_full',
      persona_templates: {
        custom: [
          { id: 'billing', type: 'text', text: '{{billing}}' },
          {
            id: 'main',
            type: 'text',
            text: hugeCustomText,
            cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' },
          },
          { id: 'dynamic_boundary', type: 'text', text: '{{dynamic_boundary}}' },
          {
            id: 'tail',
            type: 'text',
            text: 'Model={{model}}\n{{caller_system}}',
            drop_if_empty: true,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      },
    },
  }

  assert.equal(resolveCragCustomTemplate({}, customRouting, 'official_full')?.preset, 'custom')
  assert.equal(
    resolveCragCustomTemplate(
      {},
      {
        compatibility: {
          crag_persona_preset: 'zero',
          persona_templates: {
            zero: [{ type: 'text', text: 'Zero tpl' }],
            official_full: [{ type: 'text', text: 'Full tpl' }],
          },
        },
      },
      'official_full',
    )?.preset,
    'official_full',
  )
  // Mixed-case billing line on a later line of a custom block is still stripped cleanly
  const mixedCaseBilling = prepareCragPrintBody(
    { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] },
    {
      preset: 'official_full',
      officialPassthrough: false,
      capabilities: HEADLESS_CAPS,
      routing: {
        compatibility: {
          persona_templates: {
            official_full: [
              {
                type: 'text',
                text: 'Keep line 1\nX-Anthropic-Billing-Header: cc_version=2.1.321; prompt_version=<CustomVer>\nKeep line 3',
                cache_control: { type: 'ephemeral', ttl: '1h' },
              },
            ],
          },
        },
      },
    },
  )
  assert.deepEqual(mixedCaseBilling.crag_prompt, {
    mode: 'replace',
    blocks: [{ type: 'text', text: 'Keep line 1\nKeep line 3', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  })
  assert.equal(mixedCaseBilling.crag_prompt_version, 'CustomVer')

  // 1. Custom template -> crag_prompt: { mode: 'replace', blocks }, >64 KiB OK, no billing, no dynamic_boundary
  const printedCustom = prepareCragPrintBody(
    {
      model: 'claude-sonnet-5-5',
      system: [{ type: 'text', text: 'Caller extra instruction' }],
      messages: [{ role: 'user', content: 'hello' }],
    },
    {
      preset: 'official_full',
      officialPassthrough: false,
      capabilities: HEADLESS_CAPS,
      routing: customRouting,
      vm: { id: 'vm-custom' },
      cacheTtl: '1h',
    },
  )
  assert.equal('system' in printedCustom, false)
  assert.equal('crag_persona_preset' in printedCustom, false)
  assert.equal('crag_prompt_version' in printedCustom, false)
  assert.equal(printedCustom.crag_prompt.mode, 'replace')
  assert.equal('text' in printedCustom.crag_prompt, false)
  assert.equal(printedCustom.crag_prompt.blocks.length, 2)
  assert.equal(printedCustom.crag_prompt.blocks[0].text, hugeCustomText)
  assert.deepEqual(printedCustom.crag_prompt.blocks[0].cache_control, {
    type: 'ephemeral',
    ttl: '1h',
    scope: 'global',
  })
  assert.equal(printedCustom.crag_prompt.blocks[1].text, 'Model=claude-sonnet-5-5\nCaller extra instruction')
  assert.deepEqual(printedCustom.crag_prompt.blocks[1].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(
    printedCustom.crag_prompt.blocks.some((b) =>
      /x-anthropic-billing-header:|__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__/i.test(b.text),
    ),
    false,
  )

  // Passes crag-whitelist & prepareWorkerPayload cleanly WITHOUT crag_prompt.text
  const preparedCustom = prepareWorkerPayload({
    body: { ...printedCustom, max_tokens: 1024 },
    reqHeaders: {},
    exec: makeHeadlessExec(),
    routing: customRouting,
    cliHop: true,
    cragPrint: true,
  })
  assert.equal(preparedCustom.gated.crag_prompt.mode, 'replace')
  assert.equal('text' in preparedCustom.gated.crag_prompt, false)
  assert.equal(preparedCustom.gated.crag_prompt.blocks.length, 2)
  assert.equal(preparedCustom.gated.crag_prompt.blocks[0].text.length, hugeCustomText.length)
  assert.deepEqual(preparedCustom.gated.crag_prompt.blocks[0].cache_control, {
    type: 'ephemeral',
    ttl: '1h',
    scope: 'global',
  })

  // 2. Explicit persona_templates[official_full] override on official_full slot
  const fullOverrideRouting = {
    compatibility: {
      persona_preset: 'official_full',
      crag_persona_preset: 'official_full',
      persona_templates: {
        official_full: [
          { id: 'billing', type: 'text', text: '{{billing}}' },
          {
            id: 'custom_full',
            type: 'text',
            text: 'Panel override for official_full.',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      },
    },
  }
  const printedOverride = prepareCragPrintBody(
    { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] },
    {
      preset: 'official_full',
      officialPassthrough: false,
      capabilities: HEADLESS_CAPS,
      routing: fullOverrideRouting,
      vm: { id: 'vm-full', persona_preset: 'official_full' },
    },
  )
  assert.deepEqual(printedOverride.crag_prompt, {
    mode: 'replace',
    blocks: [
      {
        type: 'text',
        text: 'Panel override for official_full.',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
  })
  assert.equal('crag_persona_preset' in printedOverride, false)

  // 3. zero-style custom template preserves crag_prompt_version and caller system blocks
  const zeroCustomRouting = {
    compatibility: {
      crag_persona_preset: 'zero',
      persona_templates: {
        zero: [
          {
            id: 'billing',
            type: 'text',
            text: '{{billing_semi}} prompt_version=<{{identity_compact}}>',
          },
          {
            id: 'rule',
            type: 'text',
            text: 'Zero custom header.',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      },
    },
  }
  const printedZeroCustom = prepareCragPrintBody(
    {
      model: 'claude-sonnet-5-5',
      system: [{ type: 'text', text: 'Caller zero system', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: 'hi' }],
    },
    {
      preset: 'zero',
      officialPassthrough: false,
      capabilities: HEADLESS_CAPS,
      routing: zeroCustomRouting,
      vm: { id: 'vm-zero-custom', persona_preset: 'zero' },
      cacheTtl: '1h',
    },
  )
  assert.equal(printedZeroCustom.crag_prompt.mode, 'replace')
  assert.equal(printedZeroCustom.crag_prompt_version, CRS_COMPACT_IDENTITY)
  assert.deepEqual(printedZeroCustom.crag_prompt.blocks, [
    { type: 'text', text: 'Zero custom header.', cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: 'Caller zero system', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ])

  // 4. Priority 3 (zero without custom template) & Priority 4 (official_full without custom template)
  const noTemplatesRouting = { compatibility: { persona_preset: 'official_full', persona_templates: {} } }
  const defaultFull = prepareCragPrintBody(
    {
      model: 'claude-sonnet-5-5',
      system: [{ type: 'text', text: 'Caller' }],
      messages: [{ role: 'user', content: 'hi' }],
    },
    { preset: 'official_full', officialPassthrough: false, capabilities: HEADLESS_CAPS, routing: noTemplatesRouting },
  )
  assert.equal(defaultFull.crag_persona_preset, 'official_full')
  assert.equal('crag_prompt' in defaultFull, false)

  const defaultZero = prepareCragPrintBody(
    {
      model: 'claude-sonnet-5-5',
      system: [{ type: 'text', text: 'Caller' }],
      messages: [{ role: 'user', content: 'hi' }],
    },
    { preset: 'zero', officialPassthrough: false, capabilities: HEADLESS_CAPS, routing: noTemplatesRouting },
  )
  assert.equal(defaultZero.crag_persona_preset, 'zero')
  assert.equal(defaultZero.crag_prompt_version, CRS_OFFICIAL_CLI_SYSTEM)
  assert.equal('crag_prompt' in defaultZero, false)

  // 5. Priority 1: officialPassthrough === true NEVER triggers custom template replace or persona injection
  const nativeSystem = [
    { type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM },
    { type: 'text', text: 'Real CC TUI system block.', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ]
  const nativeUntouched = prepareCragPrintBody(
    {
      model: 'claude-sonnet-5-5',
      system: nativeSystem,
      messages: [{ role: 'user', content: 'hi' }],
      crag_env: { timezone: 'UTC', inject_if_missing: true },
    },
    {
      preset: 'official_full',
      officialPassthrough: true,
      capabilities: HEADLESS_CAPS,
      routing: customRouting,
      vm: { id: 'vm-native', persona_preset: 'custom' },
    },
  )
  assert.deepEqual(nativeUntouched.system, nativeSystem)
  assert.equal('crag_prompt' in nativeUntouched, false)
  assert.equal('crag_persona_preset' in nativeUntouched, false)
  assert.equal('crag_prompt_version' in nativeUntouched, false)
  assert.equal('crag_env' in nativeUntouched, false)

  // 6. crag-whitelist.mjs validates blocks-only crag_prompt strictly (strips stray block keys, rejects invalid shapes)
  const wlOk = sanitizeCragBodyWhitelist(
    {
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'hi' }],
      crag_prompt: {
        mode: 'replace',
        blocks: [
          {
            type: 'text',
            text: 'Clean block',
            stray_meta: 'drop-me',
            cache_control: { type: 'ephemeral', ttl: '1h', extra: 'drop' },
          },
        ],
      },
    },
    { capabilities: HEADLESS_CAPS },
  )
  assert.deepEqual(wlOk.body.crag_prompt, {
    mode: 'replace',
    blocks: [{ type: 'text', text: 'Clean block', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  })

  const wlEmptyBlocks = sanitizeCragBodyWhitelist(
    {
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'hi' }],
      crag_prompt: { mode: 'replace', blocks: [] },
    },
    { capabilities: HEADLESS_CAPS },
  )
  assert.deepEqual(wlEmptyBlocks.body.crag_prompt, { mode: 'replace', blocks: [] })

  for (const badPrompt of [
    { mode: 'replace', blocks: [{ type: 'image', text: 'nope' }] },
    { mode: 'replace', blocks: [{ type: 'text', text: 123 }] },
    { mode: 'replace', blocks: 'not-array' },
    { mode: 'replace' },
    { mode: 'invalid', blocks: [] },
  ]) {
    assert.throws(
      () =>
        sanitizeCragBodyWhitelist(
          { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }], crag_prompt: badPrompt },
          { capabilities: HEADLESS_CAPS },
        ),
      (err) => err.status === 400 && err.code === 'invalid_kernel_request',
    )
  }

  // 7. End-to-end handleProtocol with custom template does NOT relocate third-party system into messages[0]
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opt2a-b3-tpl-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  clearRustHealthCache()
  t.after(() => clearRustHealthCache())
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ sticky: { outbound_session: 'passthrough' }, ...customRouting }))

  const vm = { id: 'vm-b3-tpl', node_id: 'node-fixture', dataplane: 'wrap', official_cc_inference: 'cli-hop' }
  const health = {
    ok: true,
    ready: true,
    status: 'ready',
    cli_pid: 33333,
    ready_slots: 10,
    runtime_variant: 'crag-v2',
    transport: 'headless_bridge',
    capabilities: HEADLESS_CAPS,
  }
  const exec = { vmId: vm.id, vm, homeDir: root, workerStatus: health }
  rememberRustHealth(exec, { ok: true, health })

  const captured = []
  const scheduler = {
    async selectAndReserve() {
      return { ok: true, vmId: vm.id, accountId: vm.id, vm, exec, release() {} }
    },
    markSuccess() {},
    markCooldown() {},
    releaseAccountSessions() {},
  }
  const runner = new FailoverRunner({
    scheduler,
    schedulerRuntime: createFailoverMockSchedulerRuntime({ scheduler }),
    config: { max_same_account_retries: 0 },
  })
  const response = { headersSent: false, statusCode: 0, on() {}, once() {}, off() {}, write() {}, end() {} }
  const handler = createHandleProtocol({
    json(_res, status, body) {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      stream: false,
      system: [{ type: 'text', text: 'You are OpenCode, an autonomous coding agent.' }],
      messages: [{ role: 'user', content: 'Fix bug' }],
    }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 2 * 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'b3-tpl-req' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { sticky: { outbound_session: 'passthrough' }, ...customRouting },
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: {
      run(opts) {
        return runner.run({
          ...opts,
          callAttempt({ body, attemptMeta }) {
            const payload = prepareWorkerPayload({
              body,
              reqHeaders: { 'user-agent': 'OpenCode/2.0' },
              exec,
              routing: customRouting,
              cliHop: attemptMeta?.cliHop === true,
              cragPrint: attemptMeta?.cragPrint === true,
            })
            captured.push({ hopBody: structuredClone(body), payload })
            return {
              ok: true,
              status: 200,
              terminalState: 'verified',
              body: {
                id: 'msg_b3_tpl',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-5-5',
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 2 },
              },
            }
          },
        })
      },
    },
  })
  await handler.handleProtocol(
    {
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: 'Bearer sk-test', 'user-agent': 'OpenCode/2.0' },
      apiKeyKind: 'managed',
      apiKeyRecord: { id: 'fixture' },
      once() {},
      off() {},
    },
    response,
    'anthropic.messages',
    '/v1/messages',
  )
  assert.equal(response.status, 200)
  assert.equal(captured[0].payload.gated.crag_prompt.mode, 'replace')
  assert.equal(captured[0].payload.gated.crag_prompt.blocks[0].text, hugeCustomText)
  assert.equal(captured[0].payload.gated.crag_prompt.blocks[1].text.includes('OpenCode'), true)
  assert.equal('system' in captured[0].payload.gated, false)
  assert.deepEqual(captured[0].payload.gated.messages, [{ role: 'user', content: [{ type: 'text', text: 'Fix bug' }] }])
  assert.ok(Array.isArray(DEFAULT_PERSONA_TEMPLATES.zero))
})

test('Phase B-R3 Item 3: persona_env/timezone/locale_presets control crag_env generation, whitelist validation, legacy stripping & officialPassthrough omission', async (t) => {
  // 1. sanitizeCragEnv & crag-whitelist.mjs validation
  assert.deepEqual(
    sanitizeCragEnv({ timezone: 'Asia/Shanghai', locale: 'zh-CN', inject_if_missing: true, unknown: 'drop' }),
    { timezone: 'Asia/Shanghai', locale: 'zh-CN', inject_if_missing: true },
  )
  assert.deepEqual(sanitizeCragEnv({ timezone: 'Etc/GMT+8', locale: 'en_US.UTF-8@euro', inject_if_missing: false }), {
    timezone: 'Etc/GMT+8',
    locale: 'en_US.UTF-8@euro',
    inject_if_missing: false,
  })
  assert.deepEqual(
    sanitizeCragEnv({ timezone: 'Asia/Shanghai\nInjected', locale: 'zh-CN', inject_if_missing: 'yes' }),
    { locale: 'zh-CN' },
  )
  assert.equal(sanitizeCragEnv({ timezone: 'A'.repeat(65), locale: 'bad locale' }), undefined)
  assert.equal(sanitizeCragEnv({ inject_if_missing: true }), undefined)
  assert.equal(sanitizeCragEnv('not-an-object'), undefined)

  // Whitelist preserves valid crag_env on headless_claude_bridge_v1 and strips stray keys
  const headlessCleaned = sanitizeCragBodyWhitelist(
    {
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'hi' }],
      crag_env: { timezone: 'Asia/Shanghai', locale: 'zh-CN', inject_if_missing: true, stray: 1 },
    },
    { capabilities: HEADLESS_CAPS },
  )
  assert.deepEqual(headlessCleaned.body.crag_env, {
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    inject_if_missing: true,
  })

  // Legacy non-headless caps cleanly strip crag_env in BOTH whitelist and prepareWorkerPayload/gateCragBody
  const legacyCaps = ['generation_controls_v3', 'linux_tui_native_queue']
  const legacyCleaned = sanitizeCragBodyWhitelist(
    {
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'hi' }],
      crag_env: { timezone: 'Asia/Shanghai', locale: 'zh-CN', inject_if_missing: true },
    },
    { capabilities: legacyCaps },
  )
  assert.equal('crag_env' in legacyCleaned.body, false)
  assert.ok(legacyCleaned.strippedFields.includes('crag_env'))

  const legacyWorker = prepareWorkerPayload({
    body: {
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      crag_env: { timezone: 'Asia/Shanghai', locale: 'zh-CN', inject_if_missing: true },
    },
    reqHeaders: {},
    exec: makeHeadlessExec(legacyCaps),
    routing: {},
    cliHop: true,
    cragPrint: true,
  })
  assert.equal('crag_env' in legacyWorker.gated, false)

  // 2. End-to-end handleProtocol switches: env / timezone / locale + officialPassthrough omission
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opt2a-b3-env-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  clearRustHealthCache()
  t.after(() => clearRustHealthCache())
  const routingFile = path.join(root, 'routing.json')

  const vm = {
    id: 'vm-b3-env',
    node_id: 'node-fixture',
    dataplane: 'wrap',
    official_cc_inference: 'cli-hop',
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    fingerprint: { timezone: 'Asia/Shanghai', locale: 'zh-CN' },
  }
  const health = {
    ok: true,
    ready: true,
    status: 'ready',
    cli_pid: 44444,
    ready_slots: 10,
    runtime_variant: 'crag-v2',
    transport: 'headless_bridge',
    capabilities: HEADLESS_CAPS,
  }
  const exec = { vmId: vm.id, vm, homeDir: root, workerStatus: health }
  rememberRustHealth(exec, { ok: true, health })

  const scheduler = {
    async selectAndReserve() {
      return { ok: true, vmId: vm.id, accountId: vm.id, vm, exec, release() {} }
    },
    markSuccess() {},
    markCooldown() {},
    releaseAccountSessions() {},
  }
  const runner = new FailoverRunner({
    scheduler,
    schedulerRuntime: createFailoverMockSchedulerRuntime({ scheduler }),
    config: { max_same_account_retries: 0 },
  })

  const runEnvCase = async (compat, incoming, reqHeaders) => {
    const routing = {
      sticky: { outbound_session: 'passthrough' },
      compatibility: {
        persona_preset: 'official_full',
        crag_persona_preset: 'official_full',
        official_cc_passthrough: true,
        crag_strict_passthrough: false,
        ...compat,
      },
    }
    fs.writeFileSync(routingFile, JSON.stringify(routing))
    let observed = null
    const response = { headersSent: false, statusCode: 0, on() {}, once() {}, off() {}, write() {}, end() {} }
    const handler = createHandleProtocol({
      json(_res, status, body) {
        response.status = status
        response.body = body
        return body
      },
      writeSSEHeaders() {},
      readBody: async () => structuredClone(incoming),
      requireAuth: () => true,
      cfg: {
        rewrite: { enabled: false },
        intercept: { rules: [] },
        distill: { enabled: false },
        limits: { max_body_bytes: 2 * 1024 * 1024, upstream_timeout_ms: 2000 },
        paths: { data: root, project: root },
      },
      requestLog: { start: () => ({ request_id: 'b3-env-req' }), finish() {} },
      stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
      accountQuota: { ingestHeaders() {} },
      apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage() {} },
      apiScheduler: {},
      apiEndpointStore: {},
      stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
      routingConfigPath: routingFile,
      routingConfig: routing,
      groupsRepo: { rateMultiplier: () => 1 },
      failoverRunner: {
        run(opts) {
          return runner.run({
            ...opts,
            callAttempt({ body, attemptMeta }) {
              observed = prepareWorkerPayload({
                body,
                reqHeaders,
                exec,
                routing,
                cliHop: attemptMeta?.cliHop === true,
                cragPrint: attemptMeta?.cragPrint === true,
              })
              return {
                ok: true,
                status: 200,
                terminalState: 'verified',
                body: {
                  id: 'msg_b3_env',
                  type: 'message',
                  role: 'assistant',
                  model: 'claude-sonnet-5-5',
                  content: [{ type: 'text', text: 'ok' }],
                  stop_reason: 'end_turn',
                  usage: { input_tokens: 10, output_tokens: 2 },
                },
              }
            },
          })
        },
      },
    })
    await handler.handleProtocol(
      {
        method: 'POST',
        url: '/v1/messages',
        headers: reqHeaders,
        apiKeyKind: 'managed',
        apiKeyRecord: { id: 'fixture' },
        once() {},
        off() {},
      },
      response,
      'anthropic.messages',
      '/v1/messages',
    )
    assert.equal(response.status, 200)
    return observed.gated
  }

  const thirdPartyBody = {
    model: 'claude-sonnet-5-5',
    max_tokens: 1024,
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
  }
  const thirdPartyHeaders = { authorization: 'Bearer sk-3p', 'user-agent': 'OpenCode/2.0' }

  // Switches off by default -> no crag_env
  const defaultRes = await runEnvCase({}, thirdPartyBody, thirdPartyHeaders)
  assert.equal('crag_env' in defaultRes, false)

  // Both timezone and locale enabled -> full crag_env
  const bothRes = await runEnvCase(
    {
      persona_env_presets: { official_full: true },
      persona_timezone_presets: { official_full: true },
      persona_locale_presets: { official_full: true },
    },
    thirdPartyBody,
    thirdPartyHeaders,
  )
  assert.deepEqual(bothRes.crag_env, { timezone: 'Asia/Shanghai', locale: 'zh-CN', inject_if_missing: true })

  // Only timezone enabled
  const tzOnlyRes = await runEnvCase(
    {
      persona_env_presets: { official_full: true },
      persona_timezone_presets: { official_full: true },
      persona_locale_presets: { official_full: false },
    },
    thirdPartyBody,
    thirdPartyHeaders,
  )
  assert.deepEqual(tzOnlyRes.crag_env, { timezone: 'Asia/Shanghai', inject_if_missing: true })

  // Only locale enabled
  const locOnlyRes = await runEnvCase(
    {
      persona_env_presets: { official_full: true },
      persona_timezone_presets: { official_full: false },
      persona_locale_presets: { official_full: true },
    },
    thirdPartyBody,
    thirdPartyHeaders,
  )
  assert.deepEqual(locOnlyRes.crag_env, { locale: 'zh-CN', inject_if_missing: true })

  // Master env switch disabled -> omits crag_env even when tz/locale switches are true
  const envDisabledRes = await runEnvCase(
    {
      persona_env_presets: { official_full: false },
      persona_timezone_presets: { official_full: true },
      persona_locale_presets: { official_full: true },
    },
    thirdPartyBody,
    thirdPartyHeaders,
  )
  assert.equal('crag_env' in envDisabledRes, false)

  // Native CC officialPassthrough === true -> NEVER attaches crag_env even when all switches are true
  const nativeRes = await runEnvCase(
    {
      persona_env_presets: { official_full: true },
      persona_timezone_presets: { official_full: true },
      persona_locale_presets: { official_full: true },
    },
    {
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      stream: false,
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.321.abc; cc_entrypoint=cli; cch=00000;' },
        { type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM },
      ],
      messages: [{ role: 'user', content: 'hi' }],
      metadata: {
        user_id:
          'user_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_account_a_session_11111111-1111-4111-8111-111111111111',
      },
    },
    {
      authorization: 'Bearer sk-cc',
      'user-agent': 'claude-cli/2.1.321 (external, cli)',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    },
  )
  assert.equal('crag_env' in nativeRes, false)
  assert.equal('crag_persona_preset' in nativeRes, false)
  assert.equal('crag_prompt' in nativeRes, false)
})

unixTest(
  'Phase B-R3 Item 1 & 3: writeKernelConfig writes slot locale into kernel.json and telemetry/apply accepts scope="headless_bridge" + upload_confirmed',
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opt2a-b3-tel-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const id = 'vm-b3-bridge'
    const slotDir = path.join(root, 'vms', id)
    const runDir = path.join(slotDir, 'run')
    const cliHome = path.join(slotDir, 'cli-home')
    fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
    fs.mkdirSync(runDir, { recursive: true })
    fs.mkdirSync(path.join(cliHome, '.claude'), { recursive: true })

    const vm = {
      id,
      dataplane: 'crag',
      crag_kernel_version: 'v2',
      timezone: 'Asia/Shanghai',
      locale: 'zh-CN',
      schedulable: true,
      seed_policy: { telemetry_disabled: false },
    }
    fs.writeFileSync(path.join(root, 'vms', `${id}.json`), JSON.stringify(vm))
    const routing = { inference: { engine: 'rust', dataplane: 'crag', crag_kernel_version: 'v2' } }

    // 1. writeKernelConfig writes both timezone and locale into kernel.json
    const written = writeKernelConfig(root, vm, { routing, token: 'b3-tel-token', publish: false })
    const kernelCfg = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
    assert.equal(kernelCfg.timezone, 'Asia/Shanghai')
    assert.equal(kernelCfg.locale, 'zh-CN')

    // Fingerprint locale fallback works; unconfigured locale is omitted
    const vmFp = { id: 'vm-b3-fp', dataplane: 'crag', fingerprint: { timezone: 'Asia/Tokyo', locale: 'ja-JP' } }
    const fpWritten = writeKernelConfig(root, vmFp, { routing, token: 'b3-fp-token', publish: false })
    const fpCfg = JSON.parse(fs.readFileSync(fpWritten.configPath, 'utf8'))
    assert.equal(fpCfg.timezone, 'Asia/Tokyo')
    assert.equal(fpCfg.locale, 'ja-JP')

    const vmNoLoc = { id: 'vm-b3-noloc', dataplane: 'crag' }
    const noLocWritten = writeKernelConfig(root, vmNoLoc, { routing, token: 'b3-noloc-token', publish: false })
    const noLocCfg = JSON.parse(fs.readFileSync(noLocWritten.configPath, 'utf8'))
    assert.equal('locale' in noLocCfg, false)

    // 2. Mock CRAG headless_bridge UDS server returning scope: "headless_bridge"
    let replyState = {
      scope: 'headless_bridge',
      upload_confirmed: true,
      last_upload_at: '2026-11-27T09:55:00.000Z',
      last_error: null,
    }
    const server = http.createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.headers['x-internal-token'] !== 'b3-tel-token') {
        res.writeHead(401).end('{}')
        return
      }
      if (req.url === '/internal/health') {
        res.end(
          JSON.stringify({
            ok: true,
            ready: true,
            runtime_variant: 'crag-v2',
            transport: 'headless_bridge',
            capabilities: HEADLESS_CAPS,
            crag_telemetry_apply_v1: true,
            crag_telemetry_upload_v1: true,
          }),
        )
        return
      }
      if (req.url === '/internal/v1/telemetry/apply' && req.method === 'POST') {
        let raw = ''
        for await (const chunk of req) raw += chunk
        const { enabled } = JSON.parse(raw)
        res.end(
          JSON.stringify({
            ok: true,
            applied: true,
            enabled,
            ...replyState,
          }),
        )
        return
      }
      res.writeHead(404).end('{}')
    })
    await new Promise((resolve, reject) =>
      server.once('error', reject).listen(path.join(runDir, 'kernel.sock'), resolve),
    )
    t.after(() => new Promise((resolve) => server.close(resolve)))

    const exec = { vmId: id, vm, homeDir: cliHome }
    const direct = await verifyCragTelemetryPolicy(exec, true, 3000)
    assert.deepEqual(direct, {
      ok: true,
      applied: true,
      action: 'applied',
      enabled: true,
      scope: 'headless_bridge',
      upload_confirmed: true,
      last_upload_at: '2026-11-27T09:55:00.000Z',
    })

    // Panel detail status path (readSlotProcessStatus) propagates upload_confirmed & last_upload_at cleanly
    const statusOk = await readSlotProcessStatus({ projectRoot: root, vm, routing })
    assert.deepEqual(statusOk.telemetry, {
      state: 'launch_policy',
      enabled: true,
      error: null,
      upload_confirmed: true,
      upload_supported: true,
      last_upload_at: '2026-11-27T09:55:00.000Z',
      last_error: null,
    })

    // Panel apply path (applyNativeTelemetry) succeeds cleanly with scope: "headless_bridge"
    const applied = await applyNativeTelemetry({
      projectRoot: root,
      vm,
      routing,
      ops: { retire: async () => ({ ok: true, running: true }) },
    })
    assert.equal(applied.ok, true, applied.error)
    assert.equal(applied.applied, true)
    assert.equal(applied.scope, 'headless_bridge')
    assert.equal(applied.upload_confirmed, true)
    assert.equal(applied.last_upload_at, '2026-11-27T09:55:00.000Z')

    // Error state propagates cleanly
    replyState = {
      scope: 'headless_bridge',
      upload_confirmed: false,
      last_upload_at: '2026-11-27T09:55:00.000Z',
      last_error: 'proxy_required',
    }
    const statusErr = await readSlotProcessStatus({ projectRoot: root, vm, routing })
    assert.deepEqual(statusErr.telemetry, {
      state: 'launch_policy',
      enabled: true,
      error: null,
      upload_confirmed: false,
      upload_supported: true,
      last_upload_at: '2026-11-27T09:55:00.000Z',
      last_error: 'proxy_required',
    })

    // Unknown scope still fails closed
    replyState = {
      scope: 'unknown_scope',
      upload_confirmed: true,
      last_upload_at: '2026-11-27T09:55:00.000Z',
      last_error: null,
    }
    const unknownScope = await verifyCragTelemetryPolicy(exec, true, 3000)
    assert.equal(unknownScope.ok, false)
    assert.equal(unknownScope.code, 'telemetry_observation_unavailable')
  },
)
