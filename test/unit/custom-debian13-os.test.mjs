import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { OS_CATALOG, OS_ORDER } from '../../src/lib/vm/os-catalog.mjs'
import {
  FORBIDDEN_MANAGED_ENV_KEYS,
  scanDirectoryForSecrets,
  scanTarForSecrets,
  verifyManagedSettingsContent,
} from '../../scripts/verify-os-image-secrets.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCANNER_SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-os-image-secrets.mjs')

function makeElf(marker = 'elf') {
  const buf = Buffer.alloc(96 + Buffer.byteLength(marker))
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  buf.writeUInt16LE(3, 16)
  buf.writeUInt16LE(62, 18)
  buf.writeUInt32LE(1, 20)
  buf.write(marker, 96)
  return buf
}

function tarRecord(name, body = Buffer.alloc(0), { type = '0', mode = 0o644 } = {}) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  const octal = (offset, count, value) => header.write(`${value.toString(8).padStart(count - 1, '0')}\0`, offset, count)
  octal(100, 8, mode)
  octal(108, 8, 0)
  octal(116, 8, 0)
  octal(124, 12, body.length)
  octal(136, 12, 0)
  header.fill(32, 148, 156)
  header.write(type, 156, 1)
  header.write('ustar\0', 257, 6)
  header.write('00', 263, 2)
  const sum = header.reduce((total, value) => total + value, 0)
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)])
}

function buildTar(entries) {
  return Buffer.concat([
    ...entries.map(({ name, body = Buffer.alloc(0), ...opts }) => tarRecord(name, body, opts)),
    Buffer.alloc(1024),
  ])
}

test('docker/kin-os/debian-13 baseline is Self-Probe-safe and OS_CATALOG exposes crag-debian13 + debian-13 compat alias', () => {
  assert.deepEqual(OS_ORDER, ['ubuntu-24.04', 'debian-12', 'archlinux', 'fedora-41', 'crag-debian13'])
  assert.equal(OS_CATALOG['crag-debian13']?.dir, 'debian-13')
  assert.equal(OS_CATALOG['debian-13'], OS_CATALOG['crag-debian13'])
  assert.match(OS_CATALOG['crag-debian13']?.image || '', /kin-os-debian:13-baked$/)
  assert.equal(OS_CATALOG['crag-debian13']?.kvm?.erofs_image, 'kin-kvm-debian-13.erofs')

  const settingsPath = path.join(REPO_ROOT, 'docker', 'kin-os', 'debian-13', 'managed-settings.json')
  const raw = fs.readFileSync(settingsPath, 'utf8')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.autoUpdates, false)
  assert.deepEqual(parsed.env, {
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_USE_BEDROCK: '0',
    CLAUDE_CODE_USE_VERTEX: '0',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  })
  for (const forbidden of FORBIDDEN_MANAGED_ENV_KEYS) {
    assert.equal(Object.hasOwn(parsed.env, forbidden), false, `must not define ${forbidden}`)
  }
  assert.deepEqual(verifyManagedSettingsContent(raw), [])

  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'docker', 'kin-os', 'debian-13', 'Dockerfile'), 'utf8')
  assert.match(dockerfile, /^FROM debian:trixie-slim/m)
  assert.match(dockerfile, /\/etc\/claude-code\/managed-settings\.json/)
  assert.match(dockerfile, /rm -f \/etc\/claude-code\/CLAUDE\.md/)
  assert.match(dockerfile, /\/opt\/kin\/store/)
  assert.match(dockerfile, /\/run\/kin\/bridge/)
})

test('verify-os-image-secrets passes clean Debian 13 rootfs dir and tar.gz archive (including CLI)', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-os-scan-ok-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const rootfs = path.join(tmp, 'rootfs')
  fs.mkdirSync(path.join(rootfs, 'etc', 'claude-code', 'managed-settings.d'), { recursive: true })
  fs.mkdirSync(path.join(rootfs, 'opt', 'kin', 'store', 'crag'), { recursive: true })
  fs.mkdirSync(path.join(rootfs, 'opt', 'kin', 'store', 'claude', 'versions', '2.1.321'), { recursive: true })

  const settingsBytes = fs.readFileSync(path.join(REPO_ROOT, 'docker', 'kin-os', 'debian-13', 'managed-settings.json'))
  const loaderElf = makeElf('crag-v2-loader')
  const claudeElf = makeElf('official-claude-2.1.321')
  const plaintextSha = crypto.createHash('sha256').update(makeElf('plaintext-core-never-present')).digest('hex')
  const manifest = JSON.stringify({
    family: 'crag',
    version: 'v2',
    payload: { plaintext_sha256: plaintextSha },
  })
  const pubPem = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAexample\n-----END PUBLIC KEY-----\n'
  const encPayload = Buffer.concat([Buffer.from('CRAGV2E1'), crypto.randomBytes(64)])

  fs.writeFileSync(path.join(rootfs, 'etc', 'claude-code', 'managed-settings.json'), settingsBytes)
  fs.writeFileSync(path.join(rootfs, 'opt', 'kin', 'store', 'crag', 'crag-v2'), loaderElf)
  fs.writeFileSync(path.join(rootfs, 'opt', 'kin', 'store', 'crag', 'crag-v2.payload.enc'), encPayload)
  fs.writeFileSync(path.join(rootfs, 'opt', 'kin', 'store', 'crag', 'manifest.json'), manifest)
  fs.writeFileSync(path.join(rootfs, 'opt', 'kin', 'store', 'crag', 'crag-license-public.pem'), pubPem)
  fs.writeFileSync(path.join(rootfs, 'opt', 'kin', 'store', 'claude', 'versions', '2.1.321', 'claude'), claudeElf)

  const dirRes = scanDirectoryForSecrets(rootfs)
  assert.equal(dirRes.ok, true)
  assert.deepEqual(dirRes.violations, [])

  const tarBytes = buildTar([
    { name: 'etc/claude-code/managed-settings.json', body: settingsBytes },
    { name: 'opt/kin/store/crag/crag-v2', body: loaderElf },
    { name: 'opt/kin/store/crag/crag-v2.payload.enc', body: encPayload },
    { name: 'opt/kin/store/crag/manifest.json', body: Buffer.from(manifest) },
    { name: 'opt/kin/store/crag/crag-license-public.pem', body: Buffer.from(pubPem) },
  ])
  const tarGzPath = path.join(tmp, 'clean.tar.gz')
  fs.writeFileSync(tarGzPath, zlib.gzipSync(tarBytes))

  const tarRes = scanTarForSecrets(tarGzPath)
  assert.equal(tarRes.ok, true)
  assert.deepEqual(tarRes.violations, [])

  const cliDirOut = execFileSync(process.execPath, [SCANNER_SCRIPT, '--dir', rootfs, '--json'], { encoding: 'utf8' })
  assert.equal(JSON.parse(cliDirOut).ok, true)
  const cliTarOut = execFileSync(process.execPath, [SCANNER_SCRIPT, '--tar', tarGzPath, '--json'], { encoding: 'utf8' })
  assert.equal(JSON.parse(cliTarOut).ok, true)
})

test('verify-os-image-secrets fails closed on plaintext core, private keys, credentials, loose CRAG scripts, glibc239, and Self-Probe conflicts', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-os-scan-bad-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const plaintextCore = makeElf('leaked-plaintext-core')
  const plaintextSha = crypto.createHash('sha256').update(plaintextCore).digest('hex')

  const badDir = path.join(tmp, 'bad-rootfs')
  fs.mkdirSync(path.join(badDir, 'etc', 'claude-code'), { recursive: true })
  fs.mkdirSync(path.join(badDir, 'opt', 'kin', 'store', 'crag'), { recursive: true })
  fs.mkdirSync(path.join(badDir, 'opt', 'kin', 'glibc239'), { recursive: true })
  fs.mkdirSync(path.join(badDir, 'home', 'kincli', '.claude'), { recursive: true })

  fs.writeFileSync(
    path.join(badDir, 'opt', 'kin', 'store', 'crag', 'manifest.json'),
    JSON.stringify({
      payload: { plaintext_sha256: plaintextSha },
    }),
  )
  fs.mkdirSync(path.join(badDir, 'usr', 'local', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(badDir, 'usr', 'local', 'bin', 'disguised-core'), plaintextCore)
  fs.writeFileSync(path.join(badDir, 'opt', 'kin', 'store', 'crag', 'crag-v2-core'), plaintextCore)
  fs.writeFileSync(path.join(badDir, 'opt', 'kin', 'store', 'crag', 'helper.mjs'), 'export default 1\n')
  fs.writeFileSync(
    path.join(badDir, 'etc', 'issuer-private.pem'),
    '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
  )
  fs.writeFileSync(path.join(badDir, 'etc', 'master.txt'), 'CRAGK1ABCDEFGHIJKLMNOPQRSTUVWXYZ123456\n')
  fs.writeFileSync(path.join(badDir, 'home', 'kincli', '.claude', '.credentials.json'), '{"accessToken":"secret"}')
  fs.writeFileSync(path.join(badDir, 'opt', 'kin', 'glibc239', 'libc.so.6'), makeElf('glibc239'))
  fs.writeFileSync(path.join(badDir, 'etc', 'claude-code', 'CLAUDE.md'), 'pollutes template\n')
  fs.writeFileSync(
    path.join(badDir, 'etc', 'claude-code', 'managed-settings.json'),
    JSON.stringify({
      autoUpdates: false,
      env: { CLAUDE_CODE_ATTRIBUTION_HEADER: '0', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' },
    }),
  )

  const dirRes = scanDirectoryForSecrets(badDir)
  assert.equal(dirRes.ok, false)
  const codes = new Set(dirRes.violations.map((v) => v.code))
  assert.ok(codes.has('plaintext_crag_core'))
  assert.ok(codes.has('plaintext_crag_core_hash_match'))
  assert.ok(codes.has('crag_loose_source_file'))
  assert.ok(codes.has('private_key_material'))
  assert.ok(codes.has('private_key_content'))
  assert.ok(codes.has('master_key_content'))
  assert.ok(codes.has('slot_credential_material'))
  assert.ok(codes.has('forbidden_glibc239_hack'))
  assert.ok(codes.has('forbidden_managed_claude_md'))
  assert.ok(codes.has('managed_settings_self_probe_conflict'))

  // Same negative validation via real tar archive + CLI non-zero exit
  const badTarPath = path.join(tmp, 'bad.tar')
  fs.writeFileSync(
    badTarPath,
    buildTar([
      { name: 'opt/kin/store/crag/crag-v2-core', body: plaintextCore },
      { name: 'opt/kin/store/crag/leak.rs', body: Buffer.from('fn main() {}\n') },
      { name: 'opt/kin/store/crag/link', type: '2' },
      { name: 'etc/claude-code/CLAUDE.md', body: Buffer.from('') },
      {
        name: 'etc/claude-code/managed-settings.json',
        body: Buffer.from(JSON.stringify({ env: { CLAUDE_CODE_ATTRIBUTION_HEADER: '0' } })),
      },
    ]),
  )
  const tarRes = scanTarForSecrets(badTarPath)
  assert.equal(tarRes.ok, false)
  const tarCodes = new Set(tarRes.violations.map((v) => v.code))
  assert.ok(tarCodes.has('plaintext_crag_core'))
  assert.ok(tarCodes.has('crag_loose_source_file'))
  assert.ok(tarCodes.has('crag_dir_symlink'))
  assert.ok(tarCodes.has('forbidden_managed_claude_md'))
  assert.ok(tarCodes.has('managed_settings_self_probe_conflict'))

  assert.throws(
    () => execFileSync(process.execPath, [SCANNER_SCRIPT, '--tar', badTarPath], { stdio: 'pipe' }),
    (err) => err.status === 1,
  )
})

test('verify-os-image-secrets allows etc/ssh/sshd_config.kin + usr/local/bin/claude symlink and blocks baked SSH host keys', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-os-ssh-gate-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  // Positive: clean rootfs containing read-only etc/ssh/sshd_config.kin and non-CRAG usr/local/bin/claude symlink.
  const okRoot = path.join(tmp, 'ok-rootfs')
  fs.mkdirSync(path.join(okRoot, 'etc', 'ssh'), { recursive: true })
  fs.mkdirSync(path.join(okRoot, 'usr', 'local', 'bin'), { recursive: true })
  const sshdCfg = 'Port 2222\nPasswordAuthentication no\nPubkeyAuthentication yes\nPermitRootLogin prohibit-password\n'
  fs.writeFileSync(path.join(okRoot, 'etc', 'ssh', 'sshd_config.kin'), sshdCfg, { mode: 0o444 })
  if (process.platform !== 'win32') {
    fs.symlinkSync('/opt/kin/store/claude/current', path.join(okRoot, 'usr', 'local', 'bin', 'claude'))
  }

  const okDirRes = scanDirectoryForSecrets(okRoot)
  assert.equal(okDirRes.ok, true)
  assert.deepEqual(okDirRes.violations, [])

  const okTarPath = path.join(tmp, 'ok-ssh.tar')
  fs.writeFileSync(
    okTarPath,
    buildTar([
      { name: 'etc/ssh/sshd_config.kin', body: Buffer.from(sshdCfg) },
      { name: 'usr/local/bin/claude', type: '2' },
    ]),
  )
  const okTarRes = scanTarForSecrets(okTarPath)
  assert.equal(okTarRes.ok, true)
  assert.deepEqual(okTarRes.violations, [])

  // Negative: baked SSH host keys (private key PEM, empty/binary key, and .pub) must all fail closed.
  const badRoot = path.join(tmp, 'bad-ssh-rootfs')
  fs.mkdirSync(path.join(badRoot, 'etc', 'ssh'), { recursive: true })
  fs.writeFileSync(
    path.join(badRoot, 'etc', 'ssh', 'ssh_host_ed25519_key'),
    '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
  )
  fs.writeFileSync(path.join(badRoot, 'etc', 'ssh', 'ssh_host_rsa_key'), Buffer.alloc(0))
  fs.writeFileSync(path.join(badRoot, 'etc', 'ssh', 'ssh_host_ed25519_key.pub'), 'ssh-ed25519 AAAA root@build\n')

  const badDirRes = scanDirectoryForSecrets(badRoot)
  assert.equal(badDirRes.ok, false)
  const dirHostKeyPaths = new Set(
    badDirRes.violations.filter((v) => v.code === 'baked_ssh_host_key').map((v) => v.path),
  )
  assert.ok(dirHostKeyPaths.has('etc/ssh/ssh_host_ed25519_key'))
  assert.ok(dirHostKeyPaths.has('etc/ssh/ssh_host_rsa_key'))
  assert.ok(dirHostKeyPaths.has('etc/ssh/ssh_host_ed25519_key.pub'))
  assert.ok(badDirRes.violations.some((v) => v.code === 'private_key_content'))

  const badTarPath = path.join(tmp, 'bad-ssh.tar')
  fs.writeFileSync(
    badTarPath,
    buildTar([
      { name: 'etc/ssh/sshd_config.kin', body: Buffer.from(sshdCfg) },
      { name: 'usr/local/bin/claude', type: '2' },
      { name: 'etc/ssh/ssh_host_ed25519_key', body: Buffer.from('opaque-host-key-bytes') },
      {
        name: 'etc/ssh/ssh_host_rsa_key',
        body: Buffer.from('-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----\n'),
      },
      { name: 'etc/ssh/ssh_host_ecdsa_key', type: '2' },
    ]),
  )
  const badTarRes = scanTarForSecrets(badTarPath)
  assert.equal(badTarRes.ok, false)
  const tarHostKeyPaths = new Set(
    badTarRes.violations.filter((v) => v.code === 'baked_ssh_host_key').map((v) => v.path),
  )
  assert.ok(tarHostKeyPaths.has('etc/ssh/ssh_host_ed25519_key'))
  assert.ok(tarHostKeyPaths.has('etc/ssh/ssh_host_rsa_key'))
  assert.ok(tarHostKeyPaths.has('etc/ssh/ssh_host_ecdsa_key'))
  assert.equal(
    badTarRes.violations.some((v) => v.path === 'etc/ssh/sshd_config.kin' || v.path === 'usr/local/bin/claude'),
    false,
  )
})
