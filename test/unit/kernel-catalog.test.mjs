import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { describeKernelCatalog, pullKernelRelease } from '../../src/lib/admin/kernel-catalog.mjs'
import { CRAG_V2_RELEASE_ASSET } from '../../src/lib/admin/release-kernel.mjs'
import {
  cragV2Arch,
  cragV2PackageRoot,
  describeCcNodePayload,
  describeKernelPayload,
  describeWrapSample,
  materializeCragV2,
  materializeWrapCli,
  wrapCliTemplateDir,
} from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { seedEncryptedPackage } from '../fixtures/crag-license.mjs'

const envNames = ['KIN_CRAG_V2_ROOT', 'KIN_WRAP_CLI_ROOT', 'KIN_KERNEL_BIN']
const env = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
before(() => {
  for (const name of envNames) delete process.env[name]
})
after(() => {
  for (const name of envNames) {
    if (env[name] == null) delete process.env[name]
    else process.env[name] = env[name]
  }
})
function writable(root) {
  if (!fs.existsSync(root)) return
  fs.chmodSync(root, 0o755)
  for (const entry of fs.readdirSync(root, { withFileTypes: true }))
    if (entry.isDirectory()) writable(path.join(root, entry.name))
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-catalog-'))
  t.after(() => {
    writable(root)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}
function elf(revision = '') {
  const data = Buffer.alloc(96 + revision.length)
  data.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  data.writeUInt16LE(3, 16)
  data.writeUInt16LE(62, 18)
  data.write(revision, 96)
  return data
}
function transport(files, { tag = 'v1.2.3', size, redirect } = {}) {
  const seen = []
  const entries = Object.entries(files)
  const fetchImpl = async (url, options) => {
    seen.push(String(url))
    assert.equal(options.redirect, 'manual')
    if (String(url).includes('/releases/latest') || String(url).includes('/releases/tags/'))
      return new Response(
        JSON.stringify({
          tag_name: tag,
          assets: entries.map(([name, body], index) => ({
            name,
            size: size ?? body.length,
            url: `https://api.github.com/repos/dofastted/vm2api/releases/assets/${index + 1}`,
          })),
        }),
      )
    const index = Number(String(url).split('/').at(-1)) - 1
    assert.ok(entries[index], `unexpected asset request ${url}`)
    if (redirect) return new Response(null, { status: 302, headers: { location: redirect } })
    return new Response(entries[index][1])
  }
  return { fetchImpl, seen }
}
function tarRecord(name, body = Buffer.alloc(0), { type = '0', link = '', size = body.length, mode = 0o644 } = {}) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  const octal = (offset, count, value) => header.write(value.toString(8).padStart(count - 1, '0') + '\0', offset, count)
  octal(100, 8, mode)
  octal(108, 8, 0)
  octal(116, 8, 0)
  octal(124, 12, size)
  octal(136, 12, 0)
  header.fill(32, 148, 156)
  header.write(type, 156, 1)
  header.write(link, 157, 100)
  header.write('ustar\0', 257, 6)
  header.write('00', 263, 2)
  const sum = header.reduce((total, value) => total + value, 0)
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)])
}
function archive(root, mutate = (rows) => rows) {
  const rows = []
  function visit(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (fs.statSync(abs).isDirectory()) visit(abs, rel)
      else rows.push({ name: rel, body: fs.readFileSync(abs), mode: fs.statSync(abs).mode & 0o777 })
    }
  }
  visit(root)
  return gzipSync(
    Buffer.concat([
      ...mutate(rows).map(({ name, body, ...options }) => tarRecord(name, body, options)),
      Buffer.alloc(1024),
    ]),
  )
}
function snapshot(root) {
  const rows = {}
  function visit(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name)
      const rel = `${prefix}/${name}`
      const st = fs.statSync(abs)
      rows[rel] = st.isDirectory()
        ? { mode: st.mode }
        : { mode: st.mode, data: fs.readFileSync(abs).toString('base64') }
      if (st.isDirectory()) visit(abs, rel)
    }
  }
  visit(root)
  return rows
}

test('catalog exposes exactly two products with honest versions and no paths or license initialization', (t) => {
  const root = fixture(t)
  const pkg = seedEncryptedPackage(root)
  const template = path.join(root, 'share/wrap-cli')
  fs.mkdirSync(template, { recursive: true })
  fs.writeFileSync(path.join(template, 'kin-kernel.bin'), elf(), { mode: 0o755 })
  fs.writeFileSync(path.join(template, 'cli-node'), elf(), { mode: 0o755 })
  const rows = describeKernelCatalog(root)
  assert.deepEqual(
    rows.map((row) => [row.id, row.paid, row.ready, row.version]),
    [
      ['cli-node', false, true, null],
      ['crag', true, true, 'v2'],
    ],
  )
  assert.equal(rows[0].updated_at, null)
  assert.equal(JSON.stringify(rows).includes(root), false)
  assert.equal(JSON.stringify(rows).includes('public_key'), false)
  assert.equal(fs.existsSync(path.join(root, 'vms')), false)
  fs.appendFileSync(path.join(pkg, 'crag-v2.payload.enc'), 'tampered')
  assert.equal(describeKernelCatalog(root)[1].ready, false)
})

test('CLI pull downloads only the free pair, installs both, and preserves legacy factory assets', async (t) => {
  const root = fixture(t)
  const factory = path.join(root, 'share/wrap-cli')
  fs.mkdirSync(factory, { recursive: true })
  fs.writeFileSync(path.join(factory, 'cc-node'), 'legacy-cc', { mode: 0o755 })
  fs.mkdirSync(path.join(factory, 'glibc239'))
  fs.writeFileSync(path.join(factory, 'glibc239/libc.so.6'), 'existing-runtime')
  const kernel = elf('new-kernel'),
    cli = elf('new-cli')
  const http = transport({ 'kin-kernel': kernel, 'cli-node': cli })
  const result = await pullKernelRelease(root, { kernel: 'cli-node' }, http)
  assert.equal(result.ok, true, result.error)
  assert.equal(http.seen.length, 3)
  assert.equal(result.kernel.version, '1.2.3')
  assert.equal(describeKernelCatalog(root)[0].version, '1.2.3')
  assert.notEqual(wrapCliTemplateDir(root), factory)
  assert.equal(fs.readFileSync(describeCcNodePayload(root).path, 'utf8'), 'legacy-cc')
  const materialized = materializeWrapCli(root, { id: 'vm-fixture', dataplane: 'wrap' })
  assert.equal(materialized.ok, true, materialized.error)
  assert.deepEqual(fs.readFileSync(path.join(materialized.dest, 'kin-kernel.bin')), kernel)
  assert.deepEqual(fs.readFileSync(path.join(materialized.dest, 'cli-node')), cli)
  assert.equal(fs.readFileSync(path.join(materialized.dest, 'glibc239/libc.so.6'), 'utf8'), 'existing-runtime')
  assert.equal(fs.readFileSync(path.join(factory, 'cc-node'), 'utf8'), 'legacy-cc')
})

test('CLI installation needs no unrelated cc-node even in an empty project', async (t) => {
  const root = fixture(t)
  const pulled = await pullKernelRelease(
    root,
    { kernel: 'cli-node' },
    transport({ 'kin-kernel': elf(), 'cli-node': elf() }),
  )
  assert.equal(pulled.ok, true)
  const installed = materializeWrapCli(root, { id: 'vm-free' })
  assert.equal(installed.ok, true, installed.error)
  assert.equal(fs.existsSync(path.join(installed.dest, 'cc-node')), false)
})

for (const [label, files, options, code] of [
  ['invalid second executable', { 'kin-kernel': elf(), 'cli-node': Buffer.from('not ELF') }, {}, 'kernel_not_elf'],
  ['oversized asset', { 'kin-kernel': elf(), 'cli-node': elf() }, { size: 600 * 1024 * 1024 }, 'kernel_too_large'],
  [
    'unsafe redirect',
    { 'kin-kernel': elf(), 'cli-node': elf() },
    { redirect: 'http://127.0.0.1/private' },
    'kernel_redirect_blocked',
  ],
  ['incomplete pair', { 'kin-kernel': elf() }, {}, 'cli_node_asset_missing'],
])
  test(`CLI ${label} preserves the complete prior selected pair`, async (t) => {
    const root = fixture(t)
    assert.equal(
      (
        await pullKernelRelease(
          root,
          { kernel: 'cli-node' },
          transport({ 'kin-kernel': elf('old'), 'cli-node': elf('old') }),
        )
      ).ok,
      true,
    )
    const previous = wrapCliTemplateDir(root)
    const bytes = snapshot(previous)
    const result = await pullKernelRelease(root, { kernel: 'cli-node' }, transport(files, options))
    assert.equal(result.ok, false)
    assert.equal(result.code, code)
    assert.equal(wrapCliTemplateDir(root), previous)
    assert.deepEqual(snapshot(previous), bytes)
    assert.equal(describeKernelCatalog(root)[0].ready, true)
  })

test('native pull atomically selects an immutable sibling without touching the read-only factory', {
  skip: cragV2Arch() !== 'amd64',
}, async (t) => {
  const root = fixture(t)
  const factory = seedEncryptedPackage(root, { revision: 'new' })
  const bytes = archive(factory)
  seedEncryptedPackage(root, { revision: 'factory' })
  writable(factory)
  for (const name of fs.readdirSync(factory)) {
    const file = path.join(factory, name)
    if (fs.statSync(file).isFile()) fs.chmodSync(file, fs.statSync(file).mode & 0o111 ? 0o555 : 0o444)
  }
  fs.chmodSync(factory, 0o555)
  const before = snapshot(factory)
  const result = await pullKernelRelease(root, { kernel: 'crag' }, transport({ [CRAG_V2_RELEASE_ASSET]: bytes }))
  assert.equal(result.ok, true, result.error)
  const selected = cragV2PackageRoot(root)
  assert.notEqual(selected, factory)
  assert.equal(path.dirname(selected), path.join(path.dirname(factory), 'packages'))
  assert.deepEqual(snapshot(factory), before)
  assert.equal(fs.statSync(selected).mode & 0o222, 0)
  assert.equal(describeKernelCatalog(root)[1].version, '1.2.3')
  assert.equal(describeKernelCatalog(root)[1].ready, true)
})

const nativeMutations = [
  [
    'path traversal',
    (rows) => [...rows, { name: '../escape', body: Buffer.from('escape') }],
    'crag_v2_archive_invalid',
  ],
  ['absolute path', (rows) => [...rows, { name: '/tmp/escape', body: Buffer.alloc(0) }], 'crag_v2_archive_invalid'],
  [
    'symbolic link',
    (rows) => [...rows, { name: 'link', body: Buffer.alloc(0), type: '2', link: '/tmp' }],
    'crag_v2_archive_invalid',
  ],
  [
    'hard link',
    (rows) => [...rows, { name: 'link', body: Buffer.alloc(0), type: '1', link: 'crag-v2' }],
    'crag_v2_archive_invalid',
  ],
  ['duplicate member', (rows) => [...rows, rows[0]], 'crag_v2_archive_invalid'],
  ['unbounded declared member', (rows) => [{ ...rows[0], size: 600 * 1024 * 1024 }], 'crag_v2_archive_invalid'],
  [
    'ciphertext tamper',
    (rows) =>
      rows.map((row) =>
        row.name === 'crag-v2.payload.enc' ? { ...row, body: Buffer.concat([row.body, Buffer.from('tamper')]) } : row,
      ),
    'crag_v2_hash_mismatch',
  ],
  [
    'signature tamper',
    (rows) =>
      rows.map((row) =>
        row.name === 'manifest.json'
          ? {
              ...row,
              body: Buffer.from(
                JSON.stringify({
                  ...JSON.parse(row.body),
                  payload: { ...JSON.parse(row.body).payload, signature: Buffer.alloc(64).toString('base64url') },
                }),
              ),
            }
          : row,
      ),
    'crag_v2_manifest_invalid',
  ],
]
for (const [label, mutate, code] of nativeMutations)
  test(`native ${label} never replaces the prior package`, { skip: cragV2Arch() !== 'amd64' }, async (t) => {
    const root = fixture(t)
    const factory = seedEncryptedPackage(root)
    const good = archive(factory)
    assert.equal(
      (await pullKernelRelease(root, { kernel: 'crag' }, transport({ [CRAG_V2_RELEASE_ASSET]: good }))).ok,
      true,
    )
    const previous = cragV2PackageRoot(root)
    const before = snapshot(previous)
    const bad = archive(factory, mutate)
    const result = await pullKernelRelease(root, { kernel: 'crag' }, transport({ [CRAG_V2_RELEASE_ASSET]: bad }))
    assert.equal(result.code, code)
    assert.equal(result.ok, false)
    assert.equal(cragV2PackageRoot(root), previous)
    assert.deepEqual(snapshot(previous), before)
    assert.equal(fs.existsSync(path.join(root, 'share/crag/kernels/v2/packages/escape')), false)
    assert.equal(describeKernelCatalog(root)[1].ready, true)
  })

test('a self-signed replacement authority cannot replace the pinned native issuer', {
  skip: cragV2Arch() !== 'amd64',
}, async (t) => {
  const root = fixture(t),
    attacker = fixture(t)
  const factory = seedEncryptedPackage(root)
  const previous = snapshot(factory)
  const bad = archive(seedEncryptedPackage(attacker))
  const result = await pullKernelRelease(root, { kernel: 'crag' }, transport({ [CRAG_V2_RELEASE_ASSET]: bad }))
  assert.equal(result.code, 'crag_v2_authority_mismatch')
  assert.equal(cragV2PackageRoot(root), factory)
  assert.deepEqual(snapshot(factory), previous)
})

test('missing native release is explicit and never fetches the legacy ELF', async (t) => {
  const root = fixture(t)
  const factory = seedEncryptedPackage(root)
  const http = transport({ 'kin-kernel-crag': elf() })
  const result = await pullKernelRelease(root, { kernel: 'crag' }, http)
  assert.equal(result.code, 'crag_v2_asset_missing')
  assert.equal(http.seen.length, 1)
  assert.equal(cragV2PackageRoot(root), factory)
  assert.equal(describeKernelCatalog(root)[1].ready, true)
})

test('resolver rejects unsafe relative pointers and preserves explicit override precedence', (t) => {
  const root = fixture(t),
    override = fixture(t)
  const factory = seedEncryptedPackage(root)
  const other = seedEncryptedPackage(override)
  const pointer = path.join(path.dirname(factory), `current-${cragV2Arch()}.json`)
  for (const value of ['../outside', '/tmp/outside', 'packages/../../outside', 'packages/amd64-not-a-uuid']) {
    fs.writeFileSync(pointer, JSON.stringify({ package: value }))
    assert.throws(() => cragV2PackageRoot(root), { code: 'kernel_cache_invalid' })
    assert.equal(describeKernelCatalog(root)[1].code, 'kernel_cache_invalid')
    assert.equal(
      materializeCragV2(root, { id: 'vm-invalid', dataplane: 'crag', crag_kernel_version: 'v2' }).code,
      'kernel_cache_invalid',
    )
  }
  process.env.KIN_CRAG_V2_ROOT = other
  try {
    assert.equal(cragV2PackageRoot(root), other)
  } finally {
    delete process.env.KIN_CRAG_V2_ROOT
  }
})

test('publication failure preserves the pointer and prior package byte-for-byte', async (t) => {
  const root = fixture(t)
  const files = { 'kin-kernel': elf('old'), 'cli-node': elf('old') }
  assert.equal((await pullKernelRelease(root, { kernel: 'cli-node' }, transport(files))).ok, true)
  const selected = wrapCliTemplateDir(root)
  const before = snapshot(selected)
  const pointer = path.join(root, 'share/wrap-cli-releases/current-amd64.json')
  const pointerBytes = fs.readFileSync(pointer)
  const rename = fs.renameSync
  fs.renameSync = (source, destination) => {
    if (destination === pointer) throw Object.assign(new Error('fixture I/O failure'), { code: 'EACCES' })
    return rename(source, destination)
  }
  let result
  try {
    result = await pullKernelRelease(
      root,
      { kernel: 'cli-node' },
      transport({ 'kin-kernel': elf('new'), 'cli-node': elf('new') }),
    )
  } finally {
    fs.renameSync = rename
  }
  assert.equal(result.ok, false)
  assert.equal(wrapCliTemplateDir(root), selected)
  assert.deepEqual(fs.readFileSync(pointer), pointerBytes)
  assert.deepEqual(snapshot(selected), before)
  assert.equal(fs.readdirSync(path.join(root, 'share/wrap-cli-releases/packages')).length, 1)
})

test('cache retains only current and previous immutable snapshots', async (t) => {
  const root = fixture(t)
  const selected = []
  for (const revision of ['one', 'two', 'three']) {
    const result = await pullKernelRelease(
      root,
      { kernel: 'cli-node' },
      transport({ 'kin-kernel': elf(revision), 'cli-node': elf(revision) }),
    )
    assert.equal(result.ok, true)
    selected.push(wrapCliTemplateDir(root))
  }
  assert.equal(fs.existsSync(selected[0]), false)
  assert.equal(fs.existsSync(selected[1]), true)
  assert.equal(fs.existsSync(selected[2]), true)
})

test('native rejects truncated gzip and incorrect architecture without changing factory', {
  skip: cragV2Arch() !== 'amd64',
}, async (t) => {
  const root = fixture(t)
  const factory = seedEncryptedPackage(root)
  const before = snapshot(factory)
  const good = archive(factory)
  const truncated = await pullKernelRelease(
    root,
    { kernel: 'crag' },
    transport({ [CRAG_V2_RELEASE_ASSET]: good.subarray(0, good.length - 8) }),
  )
  assert.equal(truncated.ok, false)
  assert.equal(cragV2PackageRoot(root), factory)
  const wrongArch = archive(factory, (rows) =>
    rows.map((row) =>
      row.name === 'manifest.json'
        ? { ...row, body: Buffer.from(JSON.stringify({ ...JSON.parse(row.body), arch: 'arm64' })) }
        : row,
    ),
  )
  const result = await pullKernelRelease(root, { kernel: 'crag' }, transport({ [CRAG_V2_RELEASE_ASSET]: wrongArch }))
  assert.equal(result.code, 'crag_v2_arch_mismatch')
  assert.deepEqual(snapshot(factory), before)
})

test('archive download honors declared bounds before reading a body', { skip: cragV2Arch() !== 'amd64' }, async (t) => {
  const root = fixture(t)
  const factory = seedEncryptedPackage(root)
  const http = transport({ [CRAG_V2_RELEASE_ASSET]: archive(factory) })
  let consumed = false
  const result = await pullKernelRelease(
    root,
    { kernel: 'crag' },
    {
      fetchImpl: async (url, options) => {
        if (String(url).includes('/releases/latest')) return http.fetchImpl(url, options)
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-length': String(513 * 1024 * 1024) }),
          get body() {
            consumed = true
            throw new Error('must not consume')
          },
        }
      },
    },
  )
  assert.equal(result.code, 'crag_v2_too_large')
  assert.equal(consumed, false)
  assert.equal(cragV2PackageRoot(root), factory)
})

test('explicit overrides block misleading pulls and preserve selected packages', async (t) => {
  const root = fixture(t)
  const factory = seedEncryptedPackage(root)
  process.env.KIN_CRAG_V2_ROOT = factory
  try {
    const result = await pullKernelRelease(
      root,
      { kernel: 'crag' },
      transport({ [CRAG_V2_RELEASE_ASSET]: archive(factory) }),
    )
    assert.equal(result.code, 'kernel_override_active')
    assert.equal(cragV2PackageRoot(root), factory)
  } finally {
    delete process.env.KIN_CRAG_V2_ROOT
  }
})

test('standard project KIN_KERNEL_BIN permits pulling and resolves the published pair', async (t) => {
  const root = fixture(t)
  const bundled = path.join(root, 'bin/kin-kernel')
  fs.mkdirSync(path.dirname(bundled), { recursive: true })
  fs.writeFileSync(bundled, elf('factory'), { mode: 0o755 })
  process.env.KIN_KERNEL_BIN = bundled
  try {
    const kernel = elf('pulled')
    const result = await pullKernelRelease(
      root,
      { kernel: 'cli-node' },
      transport({ 'kin-kernel': kernel, 'cli-node': elf('cli') }),
    )
    assert.equal(result.ok, true, result.error)
    assert.equal(describeKernelPayload(root).path, path.join(wrapCliTemplateDir(root), 'kin-kernel.bin'))
    const installed = materializeWrapCli(root, { id: 'vm-default-env' })
    assert.equal(installed.ok, true, installed.error)
    assert.deepEqual(fs.readFileSync(path.join(installed.dest, 'kin-kernel.bin')), kernel)
    assert.deepEqual(fs.readFileSync(bundled), elf('factory'))
  } finally {
    delete process.env.KIN_KERNEL_BIN
  }
})

test('external kernel overrides remain pinned and cannot be replaced by a pull', async (t) => {
  const root = fixture(t),
    external = fixture(t)
  assert.equal(
    (await pullKernelRelease(root, { kernel: 'cli-node' }, transport({ 'kin-kernel': elf(), 'cli-node': elf() }))).ok,
    true,
  )
  const selected = wrapCliTemplateDir(root)
  const binary = path.join(external, 'custom-kernel')
  fs.writeFileSync(binary, elf('custom'), { mode: 0o755 })
  process.env.KIN_KERNEL_BIN = binary
  try {
    const result = await pullKernelRelease(
      root,
      { kernel: 'cli-node' },
      transport({ 'kin-kernel': elf('new'), 'cli-node': elf('new') }),
    )
    assert.equal(result.code, 'kernel_override_active')
    assert.equal(describeKernelPayload(root).path, binary)
    assert.equal(wrapCliTemplateDir(root), selected)
    assert.deepEqual(fs.readFileSync(binary), elf('custom'))
  } finally {
    delete process.env.KIN_KERNEL_BIN
  }
})

test('only missing pointers permit factory fallback; malformed, missing-target and unreadable selections fail closed', async (t) => {
  const root = fixture(t)
  await pullKernelRelease(root, { kernel: 'cli-node' }, transport({ 'kin-kernel': elf(), 'cli-node': elf() }))
  const pointer = path.join(root, 'share/wrap-cli-releases/current-amd64.json')
  const validPointer = fs.readFileSync(pointer)
  const factory = path.join(root, 'share/wrap-cli')
  fs.mkdirSync(factory, { recursive: true })
  fs.writeFileSync(path.join(factory, 'kin-kernel.bin'), elf('factory'), { mode: 0o755 })
  fs.writeFileSync(path.join(factory, 'cli-node'), elf('factory'), { mode: 0o755 })
  for (const value of [
    '{not-json',
    JSON.stringify({ package: 'packages/amd64-00000000-0000-0000-0000-000000000000' }),
  ]) {
    fs.writeFileSync(pointer, value)
    assert.throws(() => wrapCliTemplateDir(root), { code: 'kernel_cache_invalid' })
    assert.equal(describeKernelCatalog(root)[0].code, 'kernel_cache_invalid')
    assert.equal(describeKernelCatalog(root)[0].ready, false)
    assert.equal(describeWrapSample(root).code, 'kernel_cache_invalid')
    assert.equal(materializeWrapCli(root, { id: 'vm-fail-closed' }).code, 'kernel_cache_invalid')
    assert.equal(fs.existsSync(path.join(root, 'vms/vm-fail-closed')), false)
  }
  fs.writeFileSync(pointer, validPointer)
  const read = fs.readFileSync
  fs.readFileSync = (file, ...args) => {
    if (file === pointer) throw Object.assign(new Error('fixture unreadable'), { code: 'EACCES' })
    return read(file, ...args)
  }
  try {
    assert.throws(() => wrapCliTemplateDir(root), { code: 'kernel_cache_invalid' })
    assert.equal(describeKernelCatalog(root)[0].code, 'kernel_cache_invalid')
  } finally {
    fs.readFileSync = read
  }
  fs.unlinkSync(pointer)
  assert.equal(wrapCliTemplateDir(root), factory)
  assert.equal(describeKernelCatalog(root)[0].ready, true)
})

test('native accepts the exact shipped customer wrapper directory', { skip: cragV2Arch() !== 'amd64' }, async (t) => {
  const root = fixture(t)
  const factory = seedEncryptedPackage(root)
  const wrapped = archive(factory, (rows) => [
    { name: 'crag-v2-licensed-amd64/', body: Buffer.alloc(0), type: '5', mode: 0o755 },
    { name: 'crag-v2-licensed-amd64/claude-code-2.1.317/', body: Buffer.alloc(0), type: '5', mode: 0o755 },
    ...rows.map((row) => ({ ...row, name: `crag-v2-licensed-amd64/${row.name}` })),
  ])
  const result = await pullKernelRelease(root, { kernel: 'crag' }, transport({ [CRAG_V2_RELEASE_ASSET]: wrapped }))
  assert.equal(result.ok, true, result.error)
  assert.notEqual(cragV2PackageRoot(root), factory)
  assert.equal(fs.existsSync(path.join(cragV2PackageRoot(root), 'manifest.json')), true)
  assert.equal(fs.existsSync(path.join(cragV2PackageRoot(root), 'crag-v2-licensed-amd64')), false)
  assert.equal(describeKernelCatalog(root)[1].ready, true)
})

for (const layout of ['mixed', 'arbitrary-root', 'wrapper-traversal'])
  test(`native rejects ${layout} archive layout without replacing factory`, {
    skip: cragV2Arch() !== 'amd64',
  }, async (t) => {
    const root = fixture(t)
    const factory = seedEncryptedPackage(root)
    const before = snapshot(factory)
    const bytes = archive(factory, (rows) =>
      layout === 'mixed'
        ? rows.map((row, index) => ({ ...row, name: index ? `crag-v2-licensed-amd64/${row.name}` : row.name }))
        : rows.map((row) => ({
            ...row,
            name: `${layout === 'arbitrary-root' ? 'arbitrary-root' : 'crag-v2-licensed-amd64/..'}/${row.name}`,
          })),
    )
    const result = await pullKernelRelease(root, { kernel: 'crag' }, transport({ [CRAG_V2_RELEASE_ASSET]: bytes }))
    assert.equal(result.code, 'crag_v2_archive_invalid')
    assert.equal(cragV2PackageRoot(root), factory)
    assert.deepEqual(snapshot(factory), before)
  })

test('incomplete selected CLI cache cannot silently reuse the factory kernel', async (t) => {
  const root = fixture(t)
  assert.equal(
    (await pullKernelRelease(root, { kernel: 'cli-node' }, transport({ 'kin-kernel': elf(), 'cli-node': elf() }))).ok,
    true,
  )
  const selected = wrapCliTemplateDir(root)
  const bundled = path.join(root, 'bin/kin-kernel')
  fs.mkdirSync(path.dirname(bundled), { recursive: true })
  fs.writeFileSync(bundled, elf('factory'), { mode: 0o755 })
  writable(selected)
  fs.unlinkSync(path.join(selected, 'kin-kernel.bin'))
  process.env.KIN_KERNEL_BIN = bundled
  try {
    assert.throws(() => wrapCliTemplateDir(root), { code: 'kernel_cache_invalid' })
    assert.equal(describeKernelCatalog(root)[0].code, 'kernel_cache_invalid')
    assert.equal(materializeWrapCli(root, { id: 'vm-no-fallback' }).code, 'kernel_cache_invalid')
    assert.equal(fs.existsSync(path.join(root, 'vms/vm-no-fallback')), false)
  } finally {
    delete process.env.KIN_KERNEL_BIN
  }
})
