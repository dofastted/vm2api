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
import { isReleaseTag } from './release.mjs'
import {
  CRAG_V2_RELEASE_ASSET,
  fetchKernelReleaseMetadata,
  isCragPayloadTag,
  openKernelReleaseAsset,
  selectCragV2Asset,
  selectKernelAsset,
  selectCliNodeAsset,
  MAX_KERNEL_DOWNLOAD_BYTES,
  MAX_CLI_NODE_DOWNLOAD_BYTES,
  MAX_CRAG_V2_DOWNLOAD_BYTES,
} from './release-kernel.mjs'

const MAX_ARCHIVE = MAX_CRAG_V2_DOWNLOAD_BYTES
const MAX_EXPANDED = 768 * 1024 * 1024
const MAX_MEMBERS = 64
const verificationCache = new Map()
const installingCaches = new Map()
const coded = (code, message) => Object.assign(new Error(message), { code })
const baseFor = (root, kernel) =>
  kernel === 'crag' ? path.join(root, 'share/crag/kernels/v2') : path.join(root, 'share/wrap-cli-releases')
const archFor = (kernel) => (kernel === 'crag' ? cragV2Arch() : 'amd64')
const CRAG_PINNED_RELEASES = [
  {
    tag: 'payload-2026.11.21-crag-3.1.12',
    label: '3.1.12 Datadog 遥测修复',
    size: 171069832,
    manifestSha256: 'f5c00bd6fdafd23a9ef01ba0c449177da630235121b1f96eef2dc3abb74ef670',
    sha256: '222a323858fe60f4092f10ebbef391db86e9cbb14212199578303a33e9ce1eba',
  },
  {
    tag: 'payload-2026.11.21-crag-3.1.11',
    label: '3.1.11 MCP 等待与恢复',
    size: 171061071,
    manifestSha256: '433bf13fe6cd188af60e152d3a60971372cfabb11168e46641c23870269f0279',
    sha256: 'ad1cdc6483f71e5c47eb0fa7abb2d1486e19ee705640d6be5139566d1a1db602',
  },
  {
    tag: 'payload-2026.11.20-crag-3.1.10',
    label: '3.1.10 遥测修复',
    size: 171058868,
    manifestSha256: '1e78af225e07e2b4adf0ba6074f32c313b725f5a15ae7156735622bf5ecbd71b',
    sha256: 'faafd0011dbfd8d4d136eaf3056b57520d5e00777f37bd2d864edc81b4c49026',
  },
  {
    tag: 'payload-2026.11.20-crag-3.1.9',
    label: '3.1.9 子代理槽位调度',
    size: 170999424,
    manifestSha256: 'aa67bb6214d3931a73cfbcfcdb8327d510cacb7ed8a83c006464a41563fa6c2c',
    sha256: '68fe21ab5f1f19cb3482749a63a37d71328eaad967ede3ccff03337a54291614',
  },
  {
    tag: 'payload-2026.11.20-crag-3.1.8',
    label: '3.1.8 账号变更续接恢复',
    size: 170992580,
    manifestSha256: '8efbbf765967631a5c5d1f1c809f34264c1acd945b08db61d0aecbbf9ca93822',
    sha256: '890b7d5bbfbac5ad4d1c01a70df0f549ce2e739d3a5f2d52c2954a8ba95e7c87',
  },
  {
    tag: 'payload-2026.11.19-crag-3.1.7',
    label: '3.1.7 固定 CLI 入口',
    size: 171009876,
    manifestSha256: '2bd7ce44f2dcabc6f0b08a4561966f5c5e17a8ae3b8c3e91c635b509c1573ec7',
    sha256: '9a2866473b0a8be9cd64be6f00dab41aa8e2b8310ab0899613cdfdd99cf34911',
  },
  {
    tag: 'payload-2026.11.18-crag-3.1.6',
    label: '3.1.6 原生遥测控制',
    size: 170991467,
    manifestSha256: 'f1e687b7d256afee53438a4ce35c75b08851c57460065fbf20995cda36fe5aac',
    sha256: '6846f67eb52c12d35514ec7d51a77b4ab9526368a2d4f1c701ca2517374ace92',
  },
  {
    tag: 'payload-2026.11.18-crag-3.1.5',
    label: '3.1.5 标准版',
    size: 170849999,
    manifestSha256: '62a1ba1a006d011e07fc62fa1e1ee4950cd498d6be8ec3cc19358025c08471ec',
    sha256: '931f1eb0e0dc5cce9b0cd80f68fd818772d5db9b710e66c204b75a003daeb1b5',
  },
  {
    tag: 'payload-2026.11.17-crag-3.1.4',
    label: '3.1.4 标准版',
    size: 170833337,
    manifestSha256: '67224bbec4d1db42b7c446b22a674702d41d2ed0aaf61f26ab60764a5085a235',
    sha256: '295e40ba1b1830c0e8b58540d96633b1aa6f2c52f6a437c09e6c976d9f21238c',
  },
  {
    tag: 'payload-2026.11.17-crag-3.1.3',
    label: '3.1.3 Compact 修复版',
    size: 170786978,
    manifestSha256: 'b96330de47eac3e6977f419db9387ffa2346a4c394af09b680025f5d2d2691ad',
    sha256: '49d87f716494d5ef8eeac8e579c88ac2a5d6971cf30341df50e4ae6a4526e6a6',
  },
  {
    tag: 'payload-2026.11.16-crag-3.1.3',
    label: '3.1.3（原发行）',
    size: 170914192,
    manifestSha256: '6c9273c7629d3f017c361df1000766b89e10eabd3e18db41aae66060bd3316d2',
    sha256: '2643dd84b8dd641645aff692983f2825d043264590844d520aefe293150c08b9',
  },
  {
    tag: 'payload-2026.11.16-crag-3.1.2',
    label: '3.1.2',
    size: 170881721,
    manifestSha256: 'e5c65d050b322f907518943ad6340330a51e0b7f2aa97c459fab49a10c120067',
    sha256: '74e9ba52f18a52126fe61a3d95a89fe854972387459aed1def83bf3714cba8c3',
  },
  {
    tag: 'payload-2026.11.16-crag-3.1.2-legacy',
    size: 170897634,
    manifestSha256: 'c38f0dece88c0ada665c544f0c16d4295784e7b230de316ea6297532b4abca61',
    sha256: '29035f48824ff83d1e9fbfb84a9236e245938387c7f39d4ff9c4ffff7d9a770b',
  },
  {
    tag: 'payload-2026.11.16-crag-3.1.1',
    size: 170863146,
    manifestSha256: '3c6ee46a9eea024273f2377bd8fa544230899c690c2bc46ff7dd205bcf12fa1d',
    sha256: '9ed1a4fe2931d44c946aef5288dfc3665f877451b73f0fc55338dc93f135f720',
  },
  {
    tag: 'payload-2026.11.16-crag-3.1.0',
    size: 170903030,
    manifestSha256: '9e406141c6fb796c7f47faefc6b603b6f386fe0cb4eff31e1dc4f69021fd75e5',
    sha256: '009678bf98c1c1d1707105ca19a37a9b05a2859bc4582fd1f16fd0b245f16e25',
  },
  {
    tag: 'payload-2026.11.16-crag-3.0.9',
    size: 169637207,
    manifestSha256: '2fa0fa5ec860563855659a9209bdb686ba04e37b267ba57f4890494fd898ed73',
    sha256: 'dab028d2041dc29ac07a6afc6d1d12e73dd33f1417b22a56dbe19a94ac2cc0cd',
  },
  {
    tag: 'payload-2026.11.16-crag-3.0.9-legacy',
    size: 169718051,
    manifestSha256: '9c608280cfbfb38463f44a5a0125edd84279bd469d18607d9a07bce2e2960ef8',
    sha256: '95b320100f188ac868a9b8d801c1795ddea03b4fcdb7a311cb53c7912739bd18',
  },
  {
    tag: 'payload-2026.11.15-crag-3.0.8',
    size: 169316226,
    manifestSha256: 'ba6582b37790ab2ffca20c366c08318c4c909df6e7470699b8d81aa403b6cea2',
    sha256: 'a5a386056dff5852e2902d809301aa1cdd4003a3067721d97db9abb1bcf0f079',
  },
  {
    tag: 'payload-2026.11.15-crag-3.0.8-legacy',
    size: 169274806,
    manifestSha256: '1893360f958668f1940c86081a0e7a7b72be67704a5c287d94bfc3dd550b91aa',
    sha256: 'c5cb88603a0c5eb73f3b9a9c2de5cdaa204d6a9935fabbaa45aa9805ec8f8b13',
  },
  {
    tag: 'payload-2026.11.15-crag-3.0.7',
    size: 169204324,
    manifestSha256: 'c3e56d9e31e446963501e8ed5a9dde09a93879907c8914e6f6c0a84e4f4967be',
    sha256: '609de350d1f60f53d9b5505766cdea60e6059d8cc2bb0693cde8baac18deccb5',
  },
  {
    tag: 'payload-2026.11.15-crag-3.0.7-legacy',
    size: 169150379,
    manifestSha256: '0c2e6f6e7033386da8896ae0e46c78ff2001b3cc0a24da8001f9de3043b6a18c',
    sha256: '6836caf31d718b838419c126605bbc53e8761cd26922f1278b0eafdd8fb3fb53',
  },
  {
    tag: 'payload-2026.11.15-crag-3.0.6',
    size: 168091665,
    manifestSha256: '6caedda497d59914ca1c341854c94bde8c53991f81a8ad5e12903b891cb59a4e',
    sha256: '9ea3a73c38ad72ef15c702990131ca8aa4907616f8bfbb349c537c0c7e5845c6',
  },
  {
    tag: 'payload-2026.11.15-crag-3.0.6-legacy',
    size: 167962811,
    manifestSha256: 'a88e9315f05fe8315d107a070ffc0494b0fcf9e66adea09e29e35c8be50fb028',
    sha256: 'ca21ae8863ba94c7e99226d369ab7ee92056a5c04a07d16aa0a551828b41a785',
  },
  {
    tag: 'payload-2026.11.15-crag-3.0.5',
    size: 168090914,
    manifestSha256: 'ec9b706591e9e147059e1be5f689f6ae59ee1e630f97fef07169f53133fba917',
    sha256: '428b07b65586480473b3f5ebf1fe0a6c3c1444d1a45c611faad40737d22b818a',
  },
  {
    tag: 'payload-2026.11.15-crag-3.0.5-legacy',
    size: 167961689,
    manifestSha256: '3677550ac1a2f24ee44e52a004b2092a7ed36e22c2d0e41e38c326e304f4dd34',
    sha256: '547347000e8597a05bb3917a966b4f4c5bfcc5a9cc0a408565ffccc6077d35f0',
  },
]

/**
 * One installer per kernel cache. The release only clears its own reservation, so a
 * forced cancel can free the cache early without a late `finally` freeing the next one.
 */
export function reserveKernelInstallCache(projectRoot, kernel) {
  const key = path.resolve(baseFor(projectRoot, kernel))
  if (installingCaches.has(key)) return null
  const token = Symbol(key)
  installingCaches.set(key, token)
  return () => {
    if (installingCaches.get(key) === token) installingCaches.delete(key)
  }
}

function ensureKernelCacheNotInstalling(base) {
  if (installingCaches.has(path.resolve(base))) throw coded('kernel_pull_busy', '正在重装内核，安装包缓存未更改')
}

function acquireKernelCacheLock(projectRoot, kernel) {
  const base = baseFor(projectRoot, kernel)
  ensureKernelCacheNotInstalling(base)
  const lock = path.join(base, '.pull-lock')
  try {
    fs.mkdirSync(base, { recursive: true })
    fs.mkdirSync(lock, { mode: 0o700 })
    return lock
  } catch (error) {
    throw coded(
      error.code === 'EEXIST' ? 'kernel_pull_busy' : 'kernel_cache_unwritable',
      '内核缓存忙或不可写，请稍后重试',
    )
  }
}

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
    ...(isReleaseTag(meta.tag) ? { release_tag: meta.tag } : {}),
    updated_at: updated,
    ...(id === 'crag'
      ? { release_options: CRAG_PINNED_RELEASES.filter(({ label }) => label).map(({ tag, label }) => ({ tag, label })) }
      : {}),
    ...(isCragPayloadTag(meta.payload_tag) ? { payload_tag: meta.payload_tag } : {}),
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
    return {
      tag: pointer.release?.tag,
      version: pointer.release?.version,
      updated_at: pointer.updated_at,
      payload_tag: pointer.release?.payload_tag,
    }
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
    const release = root ? selectedReleaseInfo(projectRoot, 'crag', root) : {}
    if (verified.ok && !release.payload_tag) {
      const manifestSha256 = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(root, 'manifest.json')))
        .digest('hex')
      const known = CRAG_PINNED_RELEASES.find((entry) => entry.manifestSha256 === manifestSha256)
      if (known) Object.assign(release, { version: verified.manifest.software_version, payload_tag: known.tag })
    }
    crag = publicProduct(
      'crag',
      verified.ok,
      {
        ...(verified.ok ? { version: verified.manifest.version } : {}),
        ...release,
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

function limitBytes(max, code, expected = 0, sha256 = '') {
  let size = 0
  const hash = sha256 && crypto.createHash('sha256')
  return new Transform({
    transform(chunk, encoding, done) {
      size += chunk.length
      if (size > max) return done(coded(code, '内核下载或解压大小超限'))
      if (hash) hash.update(chunk)
      done(null, chunk)
    },
    flush(done) {
      if (expected && size !== expected) return done(coded('kernel_size_mismatch', '内核下载大小不匹配'))
      if (hash && hash.digest('hex') !== sha256) return done(coded('crag_v2_digest_mismatch', 'CRAG 发行包摘要不匹配'))
      done()
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
      'unpack-note.md',
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
// The cache keeps one package per release
// (payload_tag for CRAG, tag for cli-node), up to MAX_CACHED_RELEASES, so slots can
// be installed with different versions side by side. `current-<arch>.json` still
// names the one package installs and materialization read; selectKernelRelease
// repoints it to an already cached package without downloading again.
const MAX_CACHED_RELEASES = 6
const releaseKey = (release) => release?.payload_tag || release?.tag || ''
const packageName = (arch) => new RegExp(`^packages/${arch}-[a-f0-9-]{36}$`)
function readPointer(base, arch) {
  try {
    const value = jsonFile(path.join(base, `current-${arch}.json`), 4096)
    return packageName(arch).test(value?.package) ? value : null
  } catch {
    return null
  }
}
// Infer a release for a package directory written before the index existed.
function inferRelease(base, kernel, relative) {
  const root = path.join(base, relative)
  try {
    if (kernel === 'crag') {
      const sha = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(root, 'manifest.json')))
        .digest('hex')
      const known = CRAG_PINNED_RELEASES.find((entry) => entry.manifestSha256 === sha)
      if (!known) return null
      const version = /-crag-(\d+\.\d+\.\d+)$/.exec(known.tag)?.[1]
      return {
        ...(version ? { tag: `v${version}`, version } : {}),
        asset: CRAG_V2_RELEASE_ASSET,
        payload_tag: known.tag,
      }
    }
    const meta = jsonFile(path.join(root, 'RELEASE.json'))
    const { updated_at, ...release } = meta
    return release.tag ? release : null
  } catch {
    return null
  }
}
/** Cached releases, newest first. Entries whose package directory vanished are dropped. */
function cachedReleases(base, kernel) {
  const arch = archFor(kernel)
  const index = path.join(base, `releases-${arch}.json`)
  let rows = null
  try {
    const value = jsonFile(index, 64 * 1024)
    if (Array.isArray(value?.releases)) rows = value.releases
  } catch {}
  if (!rows) {
    rows = []
    const pointer = readPointer(base, arch)
    if (pointer)
      rows.push({
        package: pointer.package,
        release: pointer.release || {},
        updated_at: pointer.updated_at,
      })
    try {
      for (const entry of fs.readdirSync(path.join(base, 'packages'), {
        withFileTypes: true,
      })) {
        const relative = `packages/${entry.name}`
        if (!entry.isDirectory() || !packageName(arch).test(relative) || relative === pointer?.package) continue
        const release = inferRelease(base, kernel, relative)
        if (release) {
          const updated_at = fs.statSync(path.join(base, relative)).mtime.toISOString()
          rows.push({ package: relative, release, updated_at })
        }
      }
    } catch {}
  }
  const seen = new Set()
  return rows
    .filter((row) => packageName(arch).test(row?.package) && fs.existsSync(path.join(base, row.package)))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .filter((row) => {
      const key = releaseKey(row.release) || row.package
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
function writeReleaseIndex(base, kernel, rows) {
  const file = path.join(base, `releases-${archFor(kernel)}.json`)
  const tmp = `${file}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ releases: rows }), {
      flag: 'wx',
      mode: 0o644,
    })
    fs.renameSync(tmp, file)
  } catch {
    fs.rmSync(tmp, { force: true })
  }
}
// Post-commit cleanup: index the new package, keep one package per release up to
// MAX_CACHED_RELEASES (never evicting the current one), remove unindexed packages.
// It can never turn success into an error.
function prunePackages(base, kernel, current, added) {
  try {
    const arch = archFor(kernel)
    const rows = cachedReleases(base, kernel).filter((row) => row.package !== added.package)
    const addedKey = releaseKey(added.release)
    let keep = [added, ...rows.filter((row) => !addedKey || releaseKey(row.release) !== addedKey)]
    while (keep.length > MAX_CACHED_RELEASES) {
      const victim = keep.findLastIndex((row) => row.package !== current)
      if (victim < 0) break
      keep.splice(victim, 1)
    }
    writeReleaseIndex(base, kernel, keep)
    const kept = new Set([current, ...keep.map((row) => row.package)])
    for (const entry of fs.readdirSync(path.join(base, 'packages'), {
      withFileTypes: true,
    })) {
      const relative = `packages/${entry.name}`
      if (!entry.isDirectory() || !packageName(arch).test(relative)) continue
      if (!kept.has(relative)) removeStaged(path.join(base, relative))
    }
  } catch {}
}

/** Releases held in the local cache, newest first, with the one installs currently use marked. */
export function listKernelReleases(projectRoot, kernel) {
  if (!['cli-node', 'crag'].includes(kernel))
    return {
      ok: false,
      code: 'kernel_invalid',
      error: '请选择 cli-node 或 CRAG',
    }
  const base = baseFor(projectRoot, kernel)
  const current = readPointer(base, archFor(kernel))?.package
  return {
    ok: true,
    releases: cachedReleases(base, kernel).map((row) => ({
      ...(isReleaseTag(row.release?.tag) ? { tag: row.release.tag } : {}),
      ...(typeof row.release?.version === 'string' ? { version: row.release.version } : {}),
      ...(row.release?.payload_tag ? { payload_tag: row.release.payload_tag } : {}),
      updated_at: row.updated_at || null,
      current: row.package === current,
    })),
  }
}

/** Repoint the install selection at an already cached release (payload_tag or tag). No download. */
export function selectKernelRelease(projectRoot, { kernel, tag } = {}) {
  if (!['cli-node', 'crag'].includes(kernel))
    return {
      ok: false,
      code: 'kernel_invalid',
      error: '请选择 cli-node 或 CRAG',
    }
  if (typeof tag !== 'string' || !tag || tag.length > 120)
    return {
      ok: false,
      code: 'kernel_tag_invalid',
      error: '请指定要切换的版本',
    }
  let lock, pointerTemp
  try {
    if (String(process.env[kernel === 'crag' ? 'KIN_CRAG_V2_ROOT' : 'KIN_WRAP_CLI_ROOT'] || '').trim())
      throw coded('kernel_override_active', '已配置显式内核路径，请先移除覆盖配置再切换')
    const base = baseFor(projectRoot, kernel)
    const arch = archFor(kernel)
    lock = acquireKernelCacheLock(projectRoot, kernel)
    const rows = cachedReleases(base, kernel)
    const row = rows.find((entry) => entry.release?.payload_tag === tag || entry.release?.tag === tag)
    if (!row) throw coded('kernel_release_not_cached', `本机缓存里没有 ${tag}，请先拉取`)
    if (kernel === 'crag' && !verifiedPackage(path.join(base, row.package)).ok)
      throw coded('crag_v2_package_changed', 'CRAG 缓存包校验失败，请重新拉取')
    ensureKernelCacheNotInstalling(base)
    const pointer = path.join(base, `current-${arch}.json`)
    const updated_at = new Date().toISOString()
    pointerTemp = `${pointer}.${crypto.randomUUID()}.tmp`
    fs.writeFileSync(
      pointerTemp,
      JSON.stringify({
        package: row.package,
        release: row.release,
        updated_at,
      }),
      {
        flag: 'wx',
        mode: 0o644,
      },
    )
    fs.renameSync(pointerTemp, pointer)
    pointerTemp = null
    // Persist the inferred index so later pulls never mistake cached releases for strays.
    writeReleaseIndex(base, kernel, rows)
    return {
      ok: true,
      kernel: publicProduct(kernel, true, { ...row.release, updated_at }),
      release: row.release,
    }
  } catch (error) {
    const code =
      typeof error.code === 'string' && /^[a-z][a-z0-9_]+$/.test(error.code) ? error.code : 'kernel_select_failed'
    return { ok: false, code, error: error.message || '切换内核版本失败' }
  } finally {
    if (pointerTemp) fs.rmSync(pointerTemp, { force: true })
    if (lock) {
      try {
        fs.rmdirSync(lock)
      } catch {}
    }
  }
}

function pinnedAuthority(projectRoot) {
  const override = String(process.env.KIN_CRAG_V2_ROOT || '').trim()
  const factory = override || path.join(baseFor(projectRoot, 'crag'), cragV2Arch())
  if (verifiedPackage(factory).ok) {
    const key = crypto
      .createPublicKey(fs.readFileSync(path.join(factory, 'crag-license-public.pem')))
      .export({ format: 'der', type: 'spki' })
    return (pem) => key.equals(crypto.createPublicKey(pem).export({ format: 'der', type: 'spki' }))
  }
  const issuerPath = `share/crag/kernels/v2/${cragV2Arch()}/crag-license-public.pem`
  const files = releasePayload(projectRoot)?.files
  const pins = Array.isArray(files) ? files.filter((file) => file?.path === issuerPath) : []
  const sha256 = pins[0]?.sha256
  if (pins.length !== 1 || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw coded('crag_v2_authority_missing', '缺少可信 CRAG 发行公钥')
  }
  return (pem) => crypto.createHash('sha256').update(pem).digest('hex') === sha256
}

function releasePayload(projectRoot) {
  try {
    return jsonFile(path.join(projectRoot, 'deploy/payload.json'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// The deployed release pins one CRAG payload. `pullKernelRelease` already
// resolves it when `latest` is false; expose only the tag and its label so the
// panel can offer that exact version instead of whatever GitHub published last.
export function cragReleasePin(projectRoot) {
  let tag
  try {
    tag = releasePayload(projectRoot)?.crag_release
  } catch {
    return null
  }
  if (!isCragPayloadTag(tag)) return null
  const pinned = CRAG_PINNED_RELEASES.find((entry) => entry.tag === tag)
  return { tag, ...(pinned?.label ? { label: pinned.label } : {}) }
}

export async function pullKernelRelease(
  projectRoot,
  { kernel, tag = '', latest = false } = {},
  { fetchImpl = globalThis.fetch } = {},
) {
  if (!['cli-node', 'crag'].includes(kernel))
    return { ok: false, code: 'kernel_invalid', error: '请选择 cli-node 或 CRAG' }
  let stage, published, lock, pointerTemp
  try {
    const payload = await fetchKernelReleaseMetadata({
      tag,
      kernel,
      cragReleaseTag: kernel === 'crag' && !latest ? releasePayload(projectRoot)?.crag_release || '' : '',
      fetchImpl,
    })
    const specs =
      kernel === 'cli-node' ? [selectKernelAsset(payload), selectCliNodeAsset(payload)] : [selectCragV2Asset(payload)]
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
    lock = acquireKernelCacheLock(projectRoot, kernel)
    const packages = path.join(base, 'packages')
    fs.mkdirSync(packages, { recursive: true })
    if (fs.lstatSync(packages).isSymbolicLink()) throw coded('kernel_cache_invalid', '内核缓存不能是链接')
    stage = fs.mkdtempSync(path.join(packages, '.stage-'))
    const release = {
      tag: payload.tag_name,
      version: specs[0].version,
      asset: kernel === 'crag' ? CRAG_V2_RELEASE_ASSET : 'kin-kernel,cli-node',
      ...(payload.payload_tag ? { payload_tag: payload.payload_tag } : {}),
    }
    const metadata = { ...release, updated_at: new Date().toISOString() }
    if (kernel === 'cli-node') {
      await downloadFile(specs[0], path.join(stage, WRAP_KERNEL_BIN), MAX_KERNEL_DOWNLOAD_BYTES, fetchImpl)
      await downloadFile(specs[1], path.join(stage, 'cli-node'), MAX_CLI_NODE_DOWNLOAD_BYTES, fetchImpl)
      fs.writeFileSync(path.join(stage, 'kin-kernel'), wrapKernelWrapperScript(), { mode: 0o755, flag: 'wx' })
      fs.writeFileSync(path.join(stage, 'RELEASE.json'), JSON.stringify(metadata), { flag: 'wx' })
    } else {
      const pin = CRAG_PINNED_RELEASES.find((entry) => entry.tag === release.payload_tag)
      if (pin && specs[0].size !== pin.size) throw coded('kernel_size_mismatch', 'CRAG 发行包大小不匹配')
      const standard = releasePayload(projectRoot)?.crag_authorization
      const remoteDigest = payload.assets.find((asset) => asset?.name === CRAG_V2_RELEASE_ASSET)?.digest
      const sha256 =
        pin?.sha256 ||
        (typeof remoteDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(remoteDigest) ? remoteDigest.slice(7) : '')
      if (standard && !sha256) throw coded('crag_v2_digest_missing', 'CRAG 发行未提供可信归档摘要')
      const response = await openKernelReleaseAsset(specs[0].url, fetchImpl, CRAG_V2_RELEASE_ASSET)
      await pipeline(
        responseBody(response, MAX_ARCHIVE, 'crag_v2_too_large'),
        limitBytes(MAX_ARCHIVE, 'crag_v2_too_large', specs[0].size, sha256),
        createGunzip(),
        limitBytes(MAX_EXPANDED, 'crag_v2_archive_invalid'),
        new PackageTar(stage),
      )
      const verified = verifyCragV2Tree(stage)
      if (!verified.ok) throw coded(verified.code, 'CRAG 签名加密包校验失败')
      const { manifest } = verified
      if (
        pin &&
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(stage, 'manifest.json')))
          .digest('hex') !== pin.manifestSha256
      ) {
        throw coded('crag_v2_digest_mismatch', 'CRAG 签名包的 manifest 与发行记录不一致')
      }
      if (
        standard &&
        !pin &&
        (manifest.family !== standard.family ||
          manifest.authorization.product !== standard.product ||
          manifest.authorization.public_key_id !== standard.issuer_public_key_id ||
          manifest.payload.key_id !== standard.payload_key_id)
      )
        throw coded('crag_v2_identity_mismatch', 'CRAG 载荷不属于当前官方发行身份')
      if (!pinned(fs.readFileSync(path.join(stage, 'crag-license-public.pem')))) {
        throw coded('crag_v2_authority_mismatch', 'CRAG 发行公钥与本机可信公钥不匹配')
      }
    }
    ensureKernelCacheNotInstalling(base)
    makeReadonly(stage)
    const relative = `packages/${archFor(kernel)}-${crypto.randomUUID()}`
    published = path.join(base, relative)
    fs.renameSync(stage, published)
    stage = null
    const pointer = path.join(base, `current-${archFor(kernel)}.json`)
    pointerTemp = `${pointer}.${crypto.randomUUID()}.tmp`
    fs.writeFileSync(pointerTemp, JSON.stringify({ package: relative, release, updated_at: metadata.updated_at }), {
      flag: 'wx',
      mode: 0o644,
    })
    const product = publicProduct(kernel, true, metadata)
    fs.renameSync(pointerTemp, pointer)
    pointerTemp = null
    published = null
    prunePackages(base, kernel, relative, { package: relative, release, updated_at: metadata.updated_at })
    return { ok: true, kernel: product, release }
  } catch (error) {
    const timeout = ['TimeoutError', 'AbortError'].includes(error.name)
    const code = timeout
      ? 'kernel_pull_timeout'
      : typeof error.code === 'string' && /^[a-z][a-z0-9_]+$/.test(error.code)
        ? error.code
        : 'kernel_pull_failed'
    let message = 'CRAG 拉取失败；需官方签名加密发行包'
    if (code === 'crag_v2_authority_missing') message = '缺少可信 CRAG 发行公钥，请先更新到官方镜像或发行版'
    if (code === 'crag_v2_authority_mismatch') message = 'CRAG 发行公钥与本机可信公钥不匹配'
    if (code === 'crag_v2_identity_mismatch') message = 'CRAG 载荷不属于当前官方发行身份'
    if (code === 'github_http_404') message = '所选 CRAG 发行版本未发布或不可用'
    if (code === 'crag_v2_digest_mismatch' || code === 'kernel_size_mismatch')
      message = '下载内容与所选 CRAG 发行包不匹配'
    if (timeout) message = 'CRAG 发行包拉取超时'
    return {
      ok: false,
      code,
      error:
        code === 'kernel_pull_busy'
          ? error.message
          : `${kernel === 'crag' ? message : 'cli-node 拉取失败'}，原包未更改`,
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
