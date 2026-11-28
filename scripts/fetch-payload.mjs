#!/usr/bin/env node
/**
 * Slot payloads (closed-source kernels, wrap CLIs, glibc shim) live in a GitHub
 * release, not in git. deploy/payload.json pins every file by size and sha256.
 * Plaintext `crag_debian13_release` OS base assets (`kin-kvm-debian-13.erofs`,
 * `vmlinuz`, `initrd.img`) and optional `custom_kernel` assets (`vmlinuz-custom`,
 * `initrd.img-custom`) are verified strictly by size + sha256 (no extra
 * encryption or signature layer).
 *
 *   node scripts/fetch-payload.mjs [--dest DIR] [--crag-debian13]
 *   node scripts/fetch-payload.mjs --check [--crag-debian13]
 *   node scripts/fetch-payload.mjs --stage DIR [--crag-debian13]
 *   node scripts/fetch-payload.mjs --pin TAG
 *   node scripts/fetch-payload.mjs --pin-crag-debian13 TAG
 *   node scripts/fetch-payload.mjs --pin-crag-debian13-custom-kernel TAG
 *
 * VM2API_PAYLOAD_BASE_URL overrides https://github.com/<repo>/releases/download.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = path.resolve(import.meta.dirname, '..')
export const CRAG_DEBIAN13_ASSETS = Object.freeze(['kin-kvm-debian-13.erofs', 'vmlinuz', 'initrd.img'])
export const CRAG_DEBIAN13_CUSTOM_KERNEL_ASSETS = Object.freeze(['vmlinuz-custom', 'initrd.img-custom'])
export const DEFAULT_CRAG_DEBIAN13_DEST_DIR = 'share/os/crag-debian13'

const SHA256_RE = /^[a-f0-9]{64}$/
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function normalizeSafeRelDir(raw, fallback = DEFAULT_CRAG_DEBIAN13_DEST_DIR) {
  const dir = String(raw || fallback)
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  if (!dir || dir.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new Error(`invalid crag_debian13_release dest_dir: ${raw}`)
  }
  return dir
}

function hasPopulatedAssetEntry(entry) {
  return Boolean(
    entry && typeof entry === 'object' && (Number(entry.size || 0) > 0 || String(entry.sha256 || '').trim()),
  )
}

function parseVerifiedOsAsset(name, entry, { destDir, release, label }) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${label} is missing required asset ${name}`)
  }
  const size = Number(entry.size)
  const digest = String(entry.sha256 || '')
    .trim()
    .toLowerCase()
  if (!Number.isInteger(size) || size <= 0 || !SHA256_RE.test(digest)) {
    throw new Error(`${label} asset ${name} must have positive integer size and 64-hex sha256`)
  }
  return {
    path: `${destDir}/${name}`,
    asset: name,
    size,
    sha256: digest,
    release,
    mode: 0o644,
  }
}

export function isCragDebian13Pinned(manifest) {
  const rel = manifest?.crag_debian13_release
  if (!rel || typeof rel !== 'object' || Array.isArray(rel)) return false
  const tag = String(rel.tag || '').trim()
  const assets = rel.assets && typeof rel.assets === 'object' && !Array.isArray(rel.assets) ? rel.assets : {}
  const anyAssetPopulated = Object.values(assets).some(hasPopulatedAssetEntry)
  return Boolean(tag || anyAssetPopulated)
}

export function isCragDebian13CustomKernelPinned(manifest) {
  const rel = manifest?.crag_debian13_release
  if (!rel || typeof rel !== 'object' || Array.isArray(rel)) return false
  const custom = rel.custom_kernel
  if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
    const customTag = String(custom.tag || '').trim()
    const customAssets =
      custom.assets && typeof custom.assets === 'object' && !Array.isArray(custom.assets) ? custom.assets : custom
    const anyCustom = CRAG_DEBIAN13_CUSTOM_KERNEL_ASSETS.some((name) => hasPopulatedAssetEntry(customAssets[name]))
    if (customTag || anyCustom) return true
  }
  const baseAssets = rel.assets && typeof rel.assets === 'object' && !Array.isArray(rel.assets) ? rel.assets : {}
  return CRAG_DEBIAN13_CUSTOM_KERNEL_ASSETS.some((name) => hasPopulatedAssetEntry(baseAssets[name]))
}

export function cragDebian13CustomKernelFiles(manifest) {
  const rel = manifest?.crag_debian13_release
  if (!rel || typeof rel !== 'object' || Array.isArray(rel)) return []
  const custom = rel.custom_kernel
  if (custom !== undefined && custom !== null && (typeof custom !== 'object' || Array.isArray(custom))) {
    throw new Error('crag_debian13_release.custom_kernel must be an object when declared')
  }
  if (!isCragDebian13CustomKernelPinned(manifest)) return []

  const destDir = normalizeSafeRelDir(custom?.dest_dir || rel.dest_dir)
  const baseTag = String(rel.tag || '').trim()
  const customTag = String(custom?.tag || '').trim() || baseTag
  if (!customTag) {
    throw new Error('crag_debian13_release.custom_kernel has populated assets without a release tag')
  }

  let assetsMap = null
  if (custom && typeof custom === 'object') {
    const nested = custom.assets
    if (nested !== undefined && (typeof nested !== 'object' || nested === null || Array.isArray(nested))) {
      throw new Error('crag_debian13_release.custom_kernel.assets must be an object')
    }
    const candidate = nested || custom
    if (CRAG_DEBIAN13_CUSTOM_KERNEL_ASSETS.some((name) => Object.hasOwn(candidate, name))) {
      assetsMap = candidate
    }
  }
  if (!assetsMap) {
    const baseAssets = rel.assets && typeof rel.assets === 'object' && !Array.isArray(rel.assets) ? rel.assets : {}
    if (CRAG_DEBIAN13_CUSTOM_KERNEL_ASSETS.some((name) => Object.hasOwn(baseAssets, name))) {
      assetsMap = baseAssets
    }
  }
  if (!assetsMap) {
    throw new Error('crag_debian13_release.custom_kernel is missing vmlinuz-custom / initrd.img-custom assets')
  }

  return CRAG_DEBIAN13_CUSTOM_KERNEL_ASSETS.map((name) =>
    parseVerifiedOsAsset(name, assetsMap[name], {
      destDir,
      release: customTag,
      label: 'crag_debian13_release.custom_kernel',
    }),
  )
}

export function cragDebian13Files(manifest) {
  const rel = manifest?.crag_debian13_release
  if (!isCragDebian13Pinned(manifest)) return []
  const tag = String(rel?.tag || '').trim()
  if (!tag) {
    throw new Error('crag_debian13_release has populated assets without a release tag')
  }
  const destDir = normalizeSafeRelDir(rel.dest_dir)
  const assets = rel.assets && typeof rel.assets === 'object' && !Array.isArray(rel.assets) ? rel.assets : null
  if (!assets) {
    throw new Error('crag_debian13_release.assets must be an object')
  }
  const out = CRAG_DEBIAN13_ASSETS.map((name) =>
    parseVerifiedOsAsset(name, assets[name], {
      destDir,
      release: tag,
      label: 'crag_debian13_release',
    }),
  )
  return [...out, ...cragDebian13CustomKernelFiles(manifest)]
}

function readLocal(dest, file) {
  try {
    return fs.readFileSync(path.join(dest, file.path))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function matches(buf, file) {
  return buf !== null && buf.length === file.size && sha256(buf) === file.sha256
}

export async function runFetchPayload(argv = process.argv.slice(2), { fetchImpl = globalThis.fetch } = {}) {
  const { values: opts } = parseArgs({
    args: argv,
    options: {
      dest: { type: 'string', default: root },
      manifest: { type: 'string', default: path.join(root, 'deploy', 'payload.json') },
      check: { type: 'boolean', default: false },
      stage: { type: 'string' },
      pin: { type: 'string' },
      'pin-crag-debian13': { type: 'string' },
      'pin-crag-debian13-custom-kernel': { type: 'string' },
      'crag-debian13': { type: 'boolean', default: false },
    },
  })

  const manifest = JSON.parse(fs.readFileSync(opts.manifest, 'utf8'))
  const pinCragDebian13 = opts['pin-crag-debian13']
  const pinCragCustomKernel = opts['pin-crag-debian13-custom-kernel']
  const onlyCragDebian13 = opts['crag-debian13'] === true

  if (pinCragDebian13) {
    const existing =
      manifest.crag_debian13_release && typeof manifest.crag_debian13_release === 'object'
        ? manifest.crag_debian13_release
        : {}
    const destDir = normalizeSafeRelDir(existing.dest_dir)
    const assets = {}
    for (const name of CRAG_DEBIAN13_ASSETS) {
      const relPath = `${destDir}/${name}`
      const buf = readLocal(opts.dest, { path: relPath })
      if (buf === null) throw new Error(`${relPath} is missing; cannot pin crag_debian13_release`)
      assets[name] = { size: buf.length, sha256: sha256(buf) }
    }
    manifest.crag_debian13_release = {
      tag: pinCragDebian13,
      dest_dir: destDir,
      assets,
      ...(existing.custom_kernel ? { custom_kernel: existing.custom_kernel } : {}),
    }
    fs.writeFileSync(opts.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`pinned ${CRAG_DEBIAN13_ASSETS.length} crag_debian13_release assets to ${pinCragDebian13}`)
    return
  }

  if (pinCragCustomKernel) {
    const existing =
      manifest.crag_debian13_release && typeof manifest.crag_debian13_release === 'object'
        ? manifest.crag_debian13_release
        : null
    if (!existing || !isCragDebian13Pinned(manifest)) {
      throw new Error('crag_debian13_release must be pinned before pinning custom_kernel assets')
    }
    const destDir = normalizeSafeRelDir(existing.dest_dir)
    const customAssets = {}
    for (const name of CRAG_DEBIAN13_CUSTOM_KERNEL_ASSETS) {
      const relPath = `${destDir}/${name}`
      const buf = readLocal(opts.dest, { path: relPath })
      if (buf === null) throw new Error(`${relPath} is missing; cannot pin crag_debian13_release.custom_kernel`)
      customAssets[name] = { size: buf.length, sha256: sha256(buf) }
    }
    manifest.crag_debian13_release = {
      ...existing,
      custom_kernel: {
        tag: pinCragCustomKernel,
        assets: customAssets,
      },
    }
    fs.writeFileSync(opts.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(
      `pinned ${CRAG_DEBIAN13_CUSTOM_KERNEL_ASSETS.length} crag_debian13_release.custom_kernel assets to ${pinCragCustomKernel}`,
    )
    return
  }

  const osFiles = cragDebian13Files(manifest)
  if (onlyCragDebian13 && osFiles.length === 0) {
    throw new Error('crag_debian13_release is not pinned in payload manifest')
  }
  const coreFiles = (manifest.files || []).map((file) => ({
    ...file,
    release:
      file.path.startsWith('share/crag/') || file.path === 'dist/crag-v2-licensed-amd64.tar.gz'
        ? manifest.crag_release || manifest.release
        : manifest.release,
    mode: 0o755,
  }))
  const targetFiles = onlyCragDebian13 ? osFiles : [...coreFiles, ...osFiles]

  if (opts.pin) {
    for (const file of manifest.files) {
      const buf = readLocal(opts.dest, file)
      if (buf === null) throw new Error(`${file.path} is missing; cannot pin`)
      file.size = buf.length
      file.sha256 = sha256(buf)
    }
    manifest.release = opts.pin
    fs.writeFileSync(opts.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`pinned ${manifest.files.length} files to ${opts.pin}`)
  } else if (opts.stage) {
    fs.mkdirSync(opts.stage, { recursive: true })
    const staged = new Map()
    for (const file of targetFiles) {
      const buf = readLocal(opts.dest, file)
      if (!matches(buf, file)) throw new Error(`${file.path} does not match the manifest; run --pin first`)
      // One asset may back several paths (bin/kin-kernel = share/wrap-cli/kin-kernel.bin).
      if (staged.has(file.asset)) {
        if (staged.get(file.asset) !== file.sha256) throw new Error(`asset ${file.asset} maps to different files`)
        continue
      }
      fs.writeFileSync(path.join(opts.stage, file.asset), buf, { mode: file.mode ?? 0o755 })
      staged.set(file.asset, file.sha256)
    }
    console.log(`staged ${staged.size} assets in ${opts.stage}`)
  } else if (opts.check) {
    const bad = targetFiles.filter((file) => !matches(readLocal(opts.dest, file), file)).map((file) => file.path)
    const label = onlyCragDebian13 ? manifest.crag_debian13_release.tag : manifest.release
    if (bad.length) {
      console.error(`payload mismatch (${label}): ${bad.join(', ')}`)
      process.exit(1)
    }
    console.log(`payload ok (${label}, ${targetFiles.length} files)`)
  } else {
    const base = (
      process.env.VM2API_PAYLOAD_BASE_URL || `https://github.com/${manifest.repo}/releases/download`
    ).replace(/\/+$/, '')
    const downloads = new Map()
    for (const file of targetFiles) {
      const target = path.join(opts.dest, file.path)
      if (matches(readLocal(opts.dest, file), file)) continue
      const url = `${base}/${file.release}/${file.asset}`
      if (!downloads.has(url)) {
        let res
        for (let attempt = 1; attempt <= 4; attempt++) {
          res = await fetchImpl(url).catch((err) => ({ ok: false, status: 0, error: err }))
          if (res.ok) break
          if (attempt < 4) {
            await new Promise((r) => setTimeout(r, attempt * 2000))
          }
        }
        if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
        downloads.set(url, Buffer.from(await res.arrayBuffer()))
      }
      const buf = downloads.get(url)
      if (!matches(buf, file)) {
        throw new Error(`${url} does not match ${file.path} (size ${buf.length}, sha256 ${sha256(buf)})`)
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const tmp = `${target}.download`
      fs.writeFileSync(tmp, buf, { mode: file.mode ?? 0o755 })
      fs.renameSync(tmp, target)
      console.log(`fetched ${file.path}`)
    }
    const label = onlyCragDebian13 ? manifest.crag_debian13_release.tag : manifest.release
    console.log(`payload ready (${label}, ${targetFiles.length} files)`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runFetchPayload()
}
