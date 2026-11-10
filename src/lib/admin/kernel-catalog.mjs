import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import {
  cragV2Arch,
  cragV2PackageRoot,
  describeKernelPayload,
  hasCustomKernelOverride,
  inspectLinuxAmd64Elf,
  verifyCragV2Tree,
  wrapCliTemplateDir,
  WRAP_KERNEL_BIN,
  wrapKernelWrapperScript,
} from '../vm/wrap-cli-runtime.mjs'
import {
  CRAG_V2_RELEASE_ASSET,
  fetchKernelReleaseMetadata,
  openKernelReleaseAsset,
  selectReleaseAsset,
  selectKernelAsset,
  selectCliNodeAsset,
  MAX_KERNEL_DOWNLOAD_BYTES,
  MAX_CLI_NODE_DOWNLOAD_BYTES,
} from './release-kernel.mjs'

const MAX_ARCHIVE = 512 * 1024 * 1024
const MAX_EXPANDED = 768 * 1024 * 1024
const MAX_MEMBERS = 64
const verificationCache = new Map()
const coded = (code, message) => Object.assign(new Error(message), { code })
const baseFor = (root, kernel) =>
  kernel === 'crag' ? path.join(root, 'share/crag/kernels/v2') : path.join(root, 'share/wrap-cli-releases')
const archFor = (kernel) => (kernel === 'crag' ? cragV2Arch() : 'amd64')

function jsonFile(file, max = 64 * 1024) {
  const st = fs.lstatSync(file)
  if (!st.isFile() || st.size > max) throw coded('kernel_metadata_invalid', '内核元数据无效')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function fingerprint(root) {
  const rows = []
  function visit(file, rel = '') {
    if (rows.length >= MAX_MEMBERS) throw coded('crag_v2_archive_invalid', 'CRAG 包文件过多')
    const st = fs.lstatSync(file, { bigint: true })
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()))
      throw coded('crag_v2_symlink', 'CRAG 包不能包含链接或特殊文件')
    rows.push([rel, st.dev, st.ino, st.mode, st.size, st.mtimeNs, st.ctimeNs].map(String))
    if (st.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), `${rel}/${name}`)
  }
  visit(root)
  return JSON.stringify(rows)
}
function verifiedPackage(root) {
  try {
    const before = fingerprint(root)
    const cached = verificationCache.get(root)
    if (cached?.fingerprint === before) return cached.result
    verificationCache.delete(root)
    const result = verifyCragV2Tree(root)
    if (result.ok && fingerprint(root) === before) {
      verificationCache.set(root, { fingerprint: before, result })
      if (verificationCache.size > 8) verificationCache.delete(verificationCache.keys().next().value)
      return result
    }
    return result.ok ? { ok: false, code: 'crag_v2_package_changed' } : result
  } catch {
    verificationCache.delete(root)
    return { ok: false, code: 'crag_v2_package_missing' }
  }
}
function elfFile(file) {
  const st = fs.lstatSync(file)
  if (!st.isFile() || !(st.mode & 0o111)) return false
  const fd = fs.openSync(file, 'r')
  try {
    const header = Buffer.alloc(64)
    return fs.readSync(fd, header, 0, 64, 0) === 64 && inspectLinuxAmd64Elf(header).ok
  } finally {
    fs.closeSync(fd)
  }
}
function releaseInfo(root) {
  try {
    return jsonFile(path.join(root, 'RELEASE.json'))
  } catch {
    return {}
  }
}
function publicProduct(id, ready, meta = {}, code) {
  const version = typeof meta.version === 'string' && meta.version.length <= 80 ? meta.version : null
  const updated =
    typeof meta.updated_at === 'string' && Number.isFinite(Date.parse(meta.updated_at)) ? meta.updated_at : null
  return {
    id,
    name: id === 'crag' ? 'CRAG' : 'cli-node',
    paid: id === 'crag',
    ready,
    version,
    updated_at: updated,
    ...(!ready
      ? {
          code,
          error:
            code === 'kernel_cache_invalid'
              ? '内核缓存选择无效，请重新拉取'
              : id === 'crag'
                ? 'CRAG 签名加密包未就绪，请拉取正式授权包'
                : 'cli-node 或 kin-kernel 未就绪，请重新拉取',
        }
      : {}),
  }
}

function selectedReleaseInfo(projectRoot, kernel, root) {
  try {
    const base = baseFor(projectRoot, kernel)
    const pointer = jsonFile(path.join(base, `current-${archFor(kernel)}.json`), 4096)
    if (path.join(base, pointer.package) !== root) return {}
    return { version: pointer.release?.version, updated_at: pointer.updated_at }
  } catch {
    return {}
  }
}

export function describeKernelCatalog(projectRoot) {
  let cli
  try {
    const root = wrapCliTemplateDir(projectRoot)
    let meta = releaseInfo(root)
    if (!meta.version) {
      try {
        const sample = jsonFile(path.join(root, 'SAMPLE.json'))
        meta = {
          version: /^v\d+\.\d+\.\d+$/.test(sample.release_tag) ? sample.release_tag.slice(1) : null,
          updated_at: sample.captured_at,
        }
      } catch {}
    }
    const ready = elfFile(describeKernelPayload(projectRoot).path) && elfFile(path.join(root, 'cli-node'))
    cli = publicProduct('cli-node', ready, meta, 'cli_node_package_missing')
  } catch (error) {
    cli = publicProduct(
      'cli-node',
      false,
      {},
      error.code === 'kernel_cache_invalid' ? error.code : 'cli_node_package_missing',
    )
  }
  let crag
  try {
    const root = cragV2PackageRoot(projectRoot)
    const verified = root ? verifiedPackage(root) : { ok: false, code: 'crag_v2_package_missing' }
    crag = publicProduct(
      'crag',
      verified.ok,
      {
        ...(verified.ok ? { version: verified.manifest.version } : {}),
        ...(root ? selectedReleaseInfo(projectRoot, 'crag', root) : {}),
      },
      verified.code,
    )
  } catch (error) {
    crag = publicProduct(
      'crag',
      false,
      {},
      error.code === 'kernel_cache_invalid' ? error.code : 'crag_v2_package_missing',
    )
  }
  return [cli, crag]
}

function limitBytes(max, code, expected = 0) {
  let size = 0
  return new Transform({
    transform(chunk, encoding, done) {
      size += chunk.length
      done(size > max ? coded(code, '内核下载或解压大小超限') : null, chunk)
    },
    flush(done) {
      done(expected && size !== expected ? coded('kernel_size_mismatch', '内核下载大小不匹配') : null)
    },
  })
}
function responseBody(response, max, code) {
  const declared = Number(response.headers.get('content-length'))
  if (declared > max) throw coded(code, '内核下载大小超限')
  if (!response.body) throw coded('kernel_download_failed', '内核下载为空')
  return Readable.fromWeb(response.body)
}
async function downloadFile(asset, dest, max, fetchImpl) {
  const response = await openKernelReleaseAsset(asset.url, fetchImpl, asset.asset)
  await pipeline(
    responseBody(response, max, 'kernel_too_large'),
    limitBytes(max, 'kernel_too_large'),
    fs.createWriteStream(dest, { flags: 'wx', mode: 0o755 }),
  )
  if (asset.size && fs.statSync(dest).size !== asset.size) throw coded('kernel_size_mismatch', '内核下载大小不匹配')
  if (!elfFile(dest)) throw coded('kernel_not_elf', '内核不是 Linux amd64 ELF')
}

// Parse the bounded ustar stream ourselves. No external extractor ever sees an
// unchecked name, link, extension record, device, duplicate, or numeric size.
class PackageTar extends Writable {
  constructor(root) {
    super()
    this.root = root
    this.header = Buffer.alloc(512)
    this.used = 0
    this.remaining = 0
    this.padding = 0
    this.fd = null
    this.names = new Set()
    this.zeros = 0
    this.total = 0
    this.layout = null
  }
  number(header, start, length) {
    const value = header
      .subarray(start, start + length)
      .toString('ascii')
      .replace(/\0.*$/, '')
      .trim()
    if (!/^[0-7]+$/.test(value)) throw coded('crag_v2_archive_invalid', 'CRAG tar 数值无效')
    const parsed = Number.parseInt(value, 8)
    if (!Number.isSafeInteger(parsed)) throw coded('crag_v2_archive_invalid', 'CRAG tar 数值超限')
    return parsed
  }
  begin() {
    const h = this.header
    if (h.every((byte) => byte === 0)) {
      this.zeros++
      return
    }
    if (this.zeros) throw coded('crag_v2_archive_invalid', 'CRAG tar 结束标记无效')
    const checksum = this.number(h, 148, 8)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]
    if (sum !== checksum) throw coded('crag_v2_archive_invalid', 'CRAG tar 校验失败')
    const field = (start, size) =>
      h
        .subarray(start, start + size)
        .toString('utf8')
        .replace(/\0.*$/, '')
    if (!['ustar', 'ustar '].includes(field(257, 6)) && !h.subarray(257, 263).every((byte) => byte === 0))
      throw coded('crag_v2_archive_invalid', 'CRAG tar 格式无效')
    const prefix = field(345, 155)
    let name = `${prefix ? `${prefix}/` : ''}${field(0, 100)}`
    if (name.startsWith('./')) name = name.slice(2)
    const type = h[156]
    const directory = type === 53
    if (directory && name.endsWith('/')) name = name.slice(0, -1)
    if (directory && name === '') name = '.'
    if ((type !== 0 && type !== 48 && !directory) || field(157, 100))
      throw coded('crag_v2_archive_invalid', 'CRAG tar 不允许链接、扩展或特殊文件')
    if (
      name !== '.' &&
      (!/^[A-Za-z0-9_.\/-]+$/.test(name) ||
        name.startsWith('/') ||
        name.split('/').some((part) => !part || part === '.' || part === '..'))
    )
      throw coded('crag_v2_archive_invalid', 'CRAG tar 路径不安全')
    if (name === '.' && !directory) throw coded('crag_v2_archive_invalid', 'CRAG tar 根路径无效')
    const wrapper = 'crag-v2-licensed-amd64'
    if (name !== '.') {
      const wrapped = name === wrapper || name.startsWith(`${wrapper}/`)
      const layout = wrapped ? 'wrapped' : 'bare'
      if (this.layout && this.layout !== layout)
        throw coded('crag_v2_archive_invalid', 'CRAG tar 不能混用不同发行根目录')
      this.layout = layout
      if (name === wrapper) {
        if (!directory) throw coded('crag_v2_archive_invalid', 'CRAG 发行根必须是目录')
        name = '.'
      } else if (wrapped) name = name.slice(wrapper.length + 1)
    }
    const allowedFiles = [
      'manifest.json',
      'crag-v2',
      'crag-v2.payload.enc',
      'crag-license-public.pem',
      'kernel.json.example',
      'LICENSES.txt',
      'LICENSE.txt',
      'claude-code-2.1.321/claude',
      'claude-code-2.1.321/LICENSE.md',
      'claude-code-2.1.321/THIRD_PARTY_NOTICES.txt',
    ]
    if (directory ? !['.', 'claude-code-2.1.321'].includes(name) : !allowedFiles.includes(name))
      throw coded('crag_v2_archive_invalid', 'CRAG tar 包含非官方发行成员')
    if (this.names.has(name) || this.names.size >= MAX_MEMBERS)
      throw coded('crag_v2_archive_invalid', 'CRAG tar 成员重复或过多')
    this.names.add(name)
    const size = this.number(h, 124, 12)
    const mode = this.number(h, 100, 8)
    const memberLimit =
      name === 'claude-code-2.1.321/claude'
        ? MAX_ARCHIVE
        : name === 'crag-v2.payload.enc'
          ? 128 * 1024 * 1024
          : name === 'crag-v2'
            ? 32 * 1024 * 1024
            : 1024 * 1024
    if ((directory && size) || size > memberLimit || mode & 0o7000)
      throw coded('crag_v2_archive_invalid', 'CRAG tar 成员大小或权限无效')
    this.total += size
    if (this.total > MAX_EXPANDED) throw coded('crag_v2_archive_invalid', 'CRAG tar 解压大小超限')
    const target = path.join(this.root, name)
    if (directory) fs.mkdirSync(target, { recursive: true, mode: 0o755 })
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 })
      this.fd = fs.openSync(target, 'wx', mode & 0o111 ? 0o755 : 0o644)
    }
    this.remaining = size
    this.padding = (512 - (size % 512)) % 512
    if (!size && this.fd !== null) {
      fs.closeSync(this.fd)
      this.fd = null
    }
  }
  _write(chunk, encoding, done) {
    try {
      let offset = 0
      while (offset < chunk.length) {
        if (this.remaining) {
          const count = Math.min(this.remaining, chunk.length - offset)
          let written = 0
          while (written < count) written += fs.writeSync(this.fd, chunk, offset + written, count - written)
          offset += count
          this.remaining -= count
          if (!this.remaining) {
            fs.closeSync(this.fd)
            this.fd = null
          }
        } else if (this.padding) {
          const count = Math.min(this.padding, chunk.length - offset)
          offset += count
          this.padding -= count
        } else {
          const count = Math.min(512 - this.used, chunk.length - offset)
          chunk.copy(this.header, this.used, offset, offset + count)
          offset += count
          this.used += count
          if (this.used === 512) {
            this.used = 0
            this.begin()
          }
        }
      }
      done()
    } catch (error) {
      done(error)
    }
  }
  _final(done) {
    done(
      this.remaining || this.padding || this.used || this.zeros < 2
        ? coded('crag_v2_archive_invalid', 'CRAG tar 下载不完整')
        : null,
    )
  }
  _destroy(error, done) {
    if (this.fd !== null) {
      fs.closeSync(this.fd)
      this.fd = null
    }
    done(error)
  }
}
function makeReadonly(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) makeReadonly(file)
    else fs.chmodSync(file, fs.statSync(file).mode & 0o111 ? 0o555 : 0o444)
  }
  fs.chmodSync(root, 0o555)
}
function removeStaged(root) {
  if (!root || !fs.existsSync(root)) return
  fs.chmodSync(root, 0o755)
  for (const entry of fs.readdirSync(root, { withFileTypes: true }))
    if (entry.isDirectory()) removeStaged(path.join(root, entry.name))
  fs.rmSync(root, { recursive: true, force: true })
}
// Keep the current and immediately preceding snapshot, not an ever-growing
// download history. Cleanup is post-commit and can never turn success into an error.
function prunePackages(base, arch, current, previous) {
  try {
    for (const entry of fs.readdirSync(path.join(base, 'packages'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !new RegExp(`^${arch}-[a-f0-9-]{36}$`).test(entry.name)) continue
      const relative = `packages/${entry.name}`
      if (relative !== current && relative !== previous) removeStaged(path.join(base, relative))
    }
  } catch {}
}

function pinnedAuthority(projectRoot) {
  const override = String(process.env.KIN_CRAG_V2_ROOT || '').trim()
  const factory = override || path.join(baseFor(projectRoot, 'crag'), cragV2Arch())
  const verified = verifiedPackage(factory)
  if (!verified.ok) throw coded('crag_v2_authority_missing', '缺少可信 CRAG 发行公钥，请先安装官方授权包')
  return crypto
    .createPublicKey(fs.readFileSync(path.join(factory, 'crag-license-public.pem')))
    .export({ format: 'der', type: 'spki' })
}

export async function pullKernelRelease(projectRoot, { kernel, tag = '' } = {}, { fetchImpl = globalThis.fetch } = {}) {
  if (!['cli-node', 'crag'].includes(kernel))
    return { ok: false, code: 'kernel_invalid', error: '请选择 cli-node 或 CRAG' }
  let stage, published, lock, pointerTemp
  try {
    const payload = await fetchKernelReleaseMetadata({ tag, kernel, fetchImpl })
    const specs =
      kernel === 'cli-node'
        ? [selectKernelAsset(payload), selectCliNodeAsset(payload)]
        : [
            selectReleaseAsset(payload, {
              name: CRAG_V2_RELEASE_ASSET,
              maxBytes: MAX_ARCHIVE,
              missingCode: 'crag_v2_asset_missing',
              tooLargeCode: 'crag_v2_too_large',
            }),
          ]
    for (const spec of specs) {
      if (!spec.ok) return spec
      if (payload.assets.filter((asset) => asset?.name === spec.asset).length !== 1)
        throw coded('kernel_asset_duplicate', 'Release 内核附件重复')
    }
    if (kernel === 'crag' && cragV2Arch() !== 'amd64') throw coded('crag_v2_arch_mismatch', '当前发行包仅支持 amd64')
    if (
      String(process.env[kernel === 'crag' ? 'KIN_CRAG_V2_ROOT' : 'KIN_WRAP_CLI_ROOT'] || '').trim() ||
      (kernel === 'cli-node' && hasCustomKernelOverride(projectRoot))
    )
      throw coded('kernel_override_active', '已配置显式内核路径，请先移除覆盖配置再拉取')
    const pinned = kernel === 'crag' ? pinnedAuthority(projectRoot) : null
    const base = baseFor(projectRoot, kernel)
    fs.mkdirSync(base, { recursive: true })
    lock = path.join(base, '.pull-lock')
    try {
      fs.mkdirSync(lock, { mode: 0o700 })
    } catch (error) {
      lock = null
      throw coded(
        error.code === 'EEXIST' ? 'kernel_pull_busy' : 'kernel_cache_unwritable',
        '内核缓存忙或不可写，请稍后重试',
      )
    }
    const packages = path.join(base, 'packages')
    fs.mkdirSync(packages, { recursive: true })
    if (fs.lstatSync(packages).isSymbolicLink()) throw coded('kernel_cache_invalid', '内核缓存不能是链接')
    stage = fs.mkdtempSync(path.join(packages, '.stage-'))
    const release = {
      tag: payload.tag_name,
      version: specs[0].version,
      asset: kernel === 'crag' ? CRAG_V2_RELEASE_ASSET : 'kin-kernel,cli-node',
    }
    const metadata = { ...release, updated_at: new Date().toISOString() }
    if (kernel === 'cli-node') {
      await downloadFile(specs[0], path.join(stage, WRAP_KERNEL_BIN), MAX_KERNEL_DOWNLOAD_BYTES, fetchImpl)
      await downloadFile(specs[1], path.join(stage, 'cli-node'), MAX_CLI_NODE_DOWNLOAD_BYTES, fetchImpl)
      fs.writeFileSync(path.join(stage, 'kin-kernel'), wrapKernelWrapperScript(), { mode: 0o755, flag: 'wx' })
      fs.writeFileSync(path.join(stage, 'RELEASE.json'), JSON.stringify(metadata), { flag: 'wx' })
    } else {
      const response = await openKernelReleaseAsset(specs[0].url, fetchImpl, CRAG_V2_RELEASE_ASSET)
      await pipeline(
        responseBody(response, MAX_ARCHIVE, 'crag_v2_too_large'),
        limitBytes(MAX_ARCHIVE, 'crag_v2_too_large', specs[0].size),
        createGunzip(),
        limitBytes(MAX_EXPANDED, 'crag_v2_archive_invalid'),
        new PackageTar(stage),
      )
      const verified = verifyCragV2Tree(stage)
      if (!verified.ok) throw coded(verified.code, 'CRAG 签名加密包校验失败')
      const supplied = crypto
        .createPublicKey(fs.readFileSync(path.join(stage, 'crag-license-public.pem')))
        .export({ format: 'der', type: 'spki' })
      if (!pinned.equals(supplied)) throw coded('crag_v2_authority_mismatch', 'CRAG 发行公钥与本机可信公钥不匹配')
    }
    makeReadonly(stage)
    const relative = `packages/${archFor(kernel)}-${crypto.randomUUID()}`
    published = path.join(base, relative)
    fs.renameSync(stage, published)
    stage = null
    const pointer = path.join(base, `current-${archFor(kernel)}.json`)
    let previous
    try {
      previous = jsonFile(pointer, 4096).package
    } catch {}
    pointerTemp = `${pointer}.${crypto.randomUUID()}.tmp`
    fs.writeFileSync(pointerTemp, JSON.stringify({ package: relative, release, updated_at: metadata.updated_at }), {
      flag: 'wx',
      mode: 0o644,
    })
    const product = publicProduct(kernel, true, metadata)
    fs.renameSync(pointerTemp, pointer)
    pointerTemp = null
    published = null
    prunePackages(base, archFor(kernel), relative, previous)
    return { ok: true, kernel: product, release }
  } catch (error) {
    return {
      ok: false,
      code: typeof error.code === 'string' && /^[a-z][a-z0-9_]+$/.test(error.code) ? error.code : 'kernel_pull_failed',
      error: kernel === 'crag' ? 'CRAG 拉取失败；需官方签名加密发行包，原包未更改' : 'cli-node 拉取失败，原包未更改',
    }
  } finally {
    for (const dir of [stage, published]) {
      try {
        removeStaged(dir)
      } catch {}
    }
    if (pointerTemp) {
      try {
        fs.unlinkSync(pointerTemp)
      } catch {}
    }
    if (lock) {
      try {
        fs.rmdirSync(lock)
      } catch {}
    }
  }
}
