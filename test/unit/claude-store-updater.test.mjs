import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acquireVersionLock,
  INITIAL_CLAUDE_VERSION,
  inspectElfAndGlibc,
  pruneUnusedVersions,
  releaseVersionLock,
  rollbackClaudeStore,
  seedInitialClaudeVersion,
  storePaths,
  upgradeClaudeStore,
  verifyOfficialClaudeLightManifest,
} from '../../src/lib/vm/claude-store-updater.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test

function makeSyntheticElf({ arch = 'amd64', glibcSymbols = ['GLIBC_2.17', 'GLIBC_2.26'], tag = 'claude' } = {}) {
  const payload = Buffer.from(`${tag}\0${glibcSymbols.join('\0')}\0`, 'latin1')
  const buf = Buffer.alloc(128 + payload.length)
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  buf.writeUInt16LE(3, 16) // ET_DYN
  buf.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18)
  buf.writeUInt32LE(1, 20)
  payload.copy(buf, 128)
  return buf
}

function makeSignedLightManifest({ version, bytes, keys, arch = 'amd64', tamperSig = false }) {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const relPath = `claude-code-${version}/claude`
  const signedPayload = {
    product: 'crag-v2',
    arch,
    version,
    path: relPath,
    sha256,
  }
  const sigBuf = crypto.sign(
    null,
    Buffer.concat([Buffer.from('CRAG-OFFICIAL-CLAUDE-V1\0'), Buffer.from(JSON.stringify(signedPayload))]),
    keys.privateKey,
  )
  if (tamperSig) sigBuf[0] ^= 0xff
  const pubPem = keys.publicKey.export({ format: 'pem', type: 'spki' })
  const pubRaw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const issuerPublicKeyId = crypto.createHash('sha256').update(pubRaw).digest('hex')
  return {
    manifest: {
      product: 'crag-v2',
      arch,
      version,
      path: relPath,
      sha256,
      signature: sigBuf.toString('base64url'),
    },
    pubPem,
    issuerPublicKeyId,
    sha256,
  }
}

function makeHealthyShadowProbe(sha256, version = '2.2.0') {
  return async () => ({
    wireProfile: {
      schema_version: 2,
      probe_mode: 'tui',
      elf_sha256: sha256,
      elf_size_bytes: 341910032,
      claude_version: version,
      user_agent: `claude-cli/${version} (external, cli)`,
      user_agent_cli: `claude-cli/${version} (external, cli)`,
      oauth_profile_user_agent: `claude-code/${version}`,
      anthropic_version: '2023-06-01',
      x_app: 'cli',
      anthropic_dangerous_direct_browser_access: 'true',
      header_order: ['host', 'user-agent', 'anthropic-version', 'anthropic-beta', 'x-app'],
      x_stainless: [['x-stainless-os', 'Linux']],
      x_claude_code_static: [],
      anthropic_beta: {
        default: ['claude-code-20250219', 'oauth-2025-04-20'],
        haiku: ['oauth-2025-04-20'],
        auto: ['oauth-2025-04-20'],
      },
      billing_header: {
        prefix: 'x-anthropic-billing-header:',
        labels_order: ['cc_version', 'cc_entrypoint', 'cch'],
        cc_version_base: version,
        cc_entrypoint: 'cli',
        cc_turn_origin: 'human',
      },
      tui_system_template: [{ type: 'text', text: 'You are Claude Code.' }],
      probed_at: '2026-11-27T00:00:00Z',
    },
    workerReady: true,
    workerReadyMs: 140,
    sseOk: true,
    abortOk: true,
    cchReplaced: true,
    cchObserved: 'cch=a1b2c',
    managedSettingsActive: true,
    autoUpdatesDisabled: true,
    selfProbeConflictFree: true,
    idlePssMib: 34,
  })
}

test('inspectElfAndGlibc enforces ELF64 arch and Debian 13 GLIBC <= 2.41 ceiling', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-elf-check-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const okBin = path.join(tmp, 'claude-ok')
  fs.writeFileSync(okBin, makeSyntheticElf({ glibcSymbols: ['GLIBC_2.17', 'GLIBC_2.26', 'GLIBC_2.41'] }))
  const ok = inspectElfAndGlibc(okBin, { arch: 'amd64' })
  assert.equal(ok.ok, true)
  assert.equal(ok.maxGlibcDetected, '2.41')

  const tooNew = path.join(tmp, 'claude-glibc242')
  fs.writeFileSync(tooNew, makeSyntheticElf({ glibcSymbols: ['GLIBC_2.26', 'GLIBC_2.42'] }))
  const badGlibc = inspectElfAndGlibc(tooNew, { arch: 'amd64' })
  assert.equal(badGlibc.ok, false)
  assert.equal(badGlibc.code, 'claude_glibc_incompatible')

  const armBin = path.join(tmp, 'claude-arm64')
  fs.writeFileSync(armBin, makeSyntheticElf({ arch: 'arm64' }))
  const badArch = inspectElfAndGlibc(armBin, { arch: 'amd64' })
  assert.equal(badArch.ok, false)
  assert.equal(badArch.code, 'claude_arch_mismatch')

  const notElf = path.join(tmp, 'not-elf')
  fs.writeFileSync(notElf, 'echo hi\n')
  assert.equal(inspectElfAndGlibc(notElf).code, 'claude_elf_invalid')
})

test('verifyOfficialClaudeLightManifest verifies CRAG-OFFICIAL-CLAUDE-V1 Ed25519 signature and rejects tampering', () => {
  const keys = crypto.generateKeyPairSync('ed25519')
  const bytes = makeSyntheticElf({ tag: '2.1.321' })
  const signed = makeSignedLightManifest({ version: '2.1.321', bytes, keys })

  const ok = verifyOfficialClaudeLightManifest(signed.manifest, {
    issuerPublicKeyPem: signed.pubPem,
    expectedIssuerPublicKeyId: signed.issuerPublicKeyId,
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.version, '2.1.321')

  const tampered = makeSignedLightManifest({ version: '2.1.321', bytes, keys, tamperSig: true })
  assert.equal(
    verifyOfficialClaudeLightManifest(tampered.manifest, { issuerPublicKeyPem: tampered.pubPem }).code,
    'manifest_signature_invalid',
  )

  assert.equal(
    verifyOfficialClaudeLightManifest(signed.manifest, {
      issuerPublicKeyPem: signed.pubPem,
      expectedIssuerPublicKeyId: '0'.repeat(64),
    }).code,
    'issuer_identity_mismatch',
  )

  assert.equal(
    verifyOfficialClaudeLightManifest(
      { ...signed.manifest, signature: `${signed.manifest.signature}=` },
      {
        issuerPublicKeyPem: signed.pubPem,
      },
    ).code,
    'manifest_signature_invalid',
  )
})

unixTest(
  'seedInitialClaudeVersion (2.1.321) + 4-gate fail-closed shadow canary + atomic A/B + lock-protected prune + rollback',
  async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-updater-e2e-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

    const storeRoot = path.join(tmp, 'store')
    const keys = crypto.generateKeyPairSync('ed25519')

    // 1. Seed initial 2.1.321
    const bin321 = path.join(tmp, 'src-2.1.321')
    const bytes321 = makeSyntheticElf({ tag: 'claude-2.1.321', glibcSymbols: ['GLIBC_2.26'] })
    fs.writeFileSync(bin321, bytes321)
    const signed321 = makeSignedLightManifest({ version: INITIAL_CLAUDE_VERSION, bytes: bytes321, keys })
    const seeded = seedInitialClaudeVersion({
      storeRoot,
      sourceBinaryPath: bin321,
      manifest: signed321.manifest,
      issuerPublicKeyPem: signed321.pubPem,
      expectedIssuerPublicKeyId: signed321.issuerPublicKeyId,
      wireProfile: { schema_version: 2, probe_mode: 'tui', elf_sha256: signed321.sha256 },
    })
    assert.equal(seeded.ok, true)
    assert.equal(seeded.version, '2.1.321')
    assert.equal(seeded.currentTarget, 'versions/2.1.321/claude')
    assert.equal(fs.statSync(seeded.binaryPath).mode & 0o777, 0o555)
    assert.equal(fs.readlinkSync(storePaths(storeRoot).currentLink), 'versions/2.1.321/claude')

    // 2. Fail-closed shadow canary checks: each of the 4 gates (including real WireProfile v2 fields)
    //    must block upgrade & keep 2.1.321 active
    const bin220 = path.join(tmp, 'src-2.2.0')
    const bytes220 = makeSyntheticElf({ tag: 'claude-2.2.0', glibcSymbols: ['GLIBC_2.26'] })
    fs.writeFileSync(bin220, bytes220)
    const signed220 = makeSignedLightManifest({ version: '2.2.0', bytes: bytes220, keys })

    const failingCases = [
      [
        'gate1_wire_profile_invalid',
        (r) => ({ ...r, wireProfile: { ...r.wireProfile, probe_mode: 'print_fallback' } }),
      ],
      ['gate1_wire_profile_invalid', (r) => ({ ...r, wireProfile: { ...r.wireProfile, probe_mode: 'tui_pty' } })],
      [
        'gate1_wire_profile_invalid',
        (r) => ({ ...r, wireProfile: { ...r.wireProfile, anthropic_beta: { default: ['claude-code-20250219'] } } }),
      ],
      [
        'gate1_wire_profile_invalid',
        (r) => ({
          ...r,
          wireProfile: { ...r.wireProfile, billing_header: { prefix: '', cc_version_base: '2.2.0' } },
        }),
      ],
      ['gate1_wire_profile_invalid', (r) => ({ ...r, wireProfile: { ...r.wireProfile, header_order: [] } })],
      ['gate2_worker_ready_failed', (r) => ({ ...r, workerReadyMs: 4500 })],
      ['gate3_sse_abort_cch_failed', (r) => ({ ...r, cchObserved: 'cch=00000' })],
      ['gate4_managed_settings_or_pss_failed', (r) => ({ ...r, idlePssMib: 120 })],
    ]
    for (const [expectedGate, mutate] of failingCases) {
      const base = await makeHealthyShadowProbe(signed220.sha256)()
      const failed = await upgradeClaudeStore({
        storeRoot,
        sourceBinaryPath: bin220,
        manifest: signed220.manifest,
        issuerPublicKeyPem: signed220.pubPem,
        expectedIssuerPublicKeyId: signed220.issuerPublicKeyId,
        runShadowProbe: async () => mutate(base),
      })
      assert.equal(failed.ok, false)
      assert.equal(failed.code, 'shadow_canary_failed')
      assert.ok(failed.failedGates.includes(expectedGate), `expected ${expectedGate}, got ${failed.failedGates}`)
      assert.equal(fs.readlinkSync(storePaths(storeRoot).currentLink), 'versions/2.1.321/claude')
      assert.equal(fs.readdirSync(storePaths(storeRoot).stagingDir).length, 0, 'staging must be cleaned on failure')
    }

    // 3. Acquire an active process lock on 2.1.321 so pruning can never delete its in-use inode
    const lock321 = acquireVersionLock(storeRoot, '2.1.321', { pid: 90001 })
    const isAlive = (pid) => pid === 90001

    // 4. Successful A -> B upgrade (2.1.321 -> 2.2.0)
    const up220 = await upgradeClaudeStore({
      storeRoot,
      sourceBinaryPath: bin220,
      manifest: signed220.manifest,
      issuerPublicKeyPem: signed220.pubPem,
      expectedIssuerPublicKeyId: signed220.issuerPublicKeyId,
      runShadowProbe: makeHealthyShadowProbe(signed220.sha256),
      retainVersions: 2,
      isProcessAlive: isAlive,
    })
    assert.equal(up220.ok, true)
    assert.equal(up220.fromVersion, '2.1.321')
    assert.equal(up220.toVersion, '2.2.0')
    assert.equal(fs.readlinkSync(storePaths(storeRoot).currentLink), 'versions/2.2.0/claude')
    assert.equal(fs.readlinkSync(storePaths(storeRoot).previousLink), 'versions/2.1.321/claude')
    assert.equal(fs.statSync(up220.profilePath).mode & 0o777, 0o444)

    // 5. Upgrade again (2.2.0 -> 2.3.0) with retainVersions=2: 2.1.321 is locked so it MUST NOT be deleted
    const bin230 = path.join(tmp, 'src-2.3.0')
    const bytes230 = makeSyntheticElf({ tag: 'claude-2.3.0', glibcSymbols: ['GLIBC_2.26'] })
    fs.writeFileSync(bin230, bytes230)
    const signed230 = makeSignedLightManifest({ version: '2.3.0', bytes: bytes230, keys })
    const up230 = await upgradeClaudeStore({
      storeRoot,
      sourceBinaryPath: bin230,
      manifest: signed230.manifest,
      issuerPublicKeyPem: signed230.pubPem,
      expectedIssuerPublicKeyId: signed230.issuerPublicKeyId,
      runShadowProbe: makeHealthyShadowProbe(signed230.sha256),
      retainVersions: 2,
      isProcessAlive: isAlive,
    })
    assert.equal(up230.ok, true)
    assert.equal(fs.existsSync(path.join(storePaths(storeRoot).versionsDir, '2.1.321', 'claude')), true)
    assert.ok(up230.pruned.locked.includes('2.1.321'))

    // Once the lock is released, pruning retires 2.1.321 while preserving current (2.3.0) and previous (2.2.0)
    releaseVersionLock(lock321)
    const prunedAfterRelease = pruneUnusedVersions(storeRoot, { retainCount: 2, isProcessAlive: () => false })
    assert.deepEqual(prunedAfterRelease.removed, ['2.1.321'])
    assert.equal(fs.existsSync(path.join(storePaths(storeRoot).versionsDir, '2.1.321', 'claude')), false)

    // 6. One-click atomic rollback (2.3.0 -> 2.2.0)
    const rolled = rollbackClaudeStore(storeRoot)
    assert.equal(rolled.ok, true)
    assert.equal(rolled.rolledBackFrom, '2.3.0')
    assert.equal(rolled.activeVersion, '2.2.0')
    assert.equal(rolled.requiresDrainRestart, true)
    assert.equal(fs.readlinkSync(storePaths(storeRoot).currentLink), 'versions/2.2.0/claude')
    assert.equal(fs.readlinkSync(storePaths(storeRoot).previousLink), 'versions/2.3.0/claude')
  },
)
