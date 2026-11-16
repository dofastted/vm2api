/**
 * Fetch amd64 runtime assets from vm2api application or CRAG component releases.
 * Callers verify and install the assets, then sync slots.
 * Redirects stay on GitHub hosts so a release payload cannot point the
 * control plane at an internal URL.
 */
import { inspectLinuxAmd64Elf } from '../vm/wrap-cli-runtime.mjs'
import { GITHUB_REPO, githubApiHeaders, isReleaseTag, normalizeTag, normalizeVersion } from './release.mjs'

export const KERNEL_RELEASE_ASSET = 'kin-kernel'
export const CLI_NODE_RELEASE_ASSET = 'cli-node'
export const CC_NODE_RELEASE_ASSET = 'cc-node'
export const KERNEL_CRAG_RELEASE_ASSET = 'kin-kernel-crag'
export const CRAG_V2_RELEASE_ASSET = 'crag-v2-licensed-amd64.tar.gz'
export const MAX_CRAG_V2_DOWNLOAD_BYTES = 512 * 1024 * 1024
const CRAG_PAYLOAD_TAG_PATTERN = 'payload-\\d{4}\\.\\d{2}\\.\\d{2}-crag-(\\d+\\.\\d+\\.\\d+)(-legacy)?'
const CRAG_PAYLOAD_TAG = new RegExp(`^${CRAG_PAYLOAD_TAG_PATTERN}$`)
export const isCragPayloadTag = (tag) => typeof tag === 'string' && CRAG_PAYLOAD_TAG.test(tag)
const CRAG_RELEASES_PAGE_SIZE = 30
const CRAG_RELEASES_MAX_PAGES = 10
const KERNEL_VERSION_LIST_MAX_PAGES = 3
export const MAX_KERNEL_DOWNLOAD_BYTES = 32 * 1024 * 1024
export const MAX_CLI_NODE_DOWNLOAD_BYTES = 64 * 1024 * 1024
export const MAX_CC_NODE_DOWNLOAD_BYTES = MAX_CLI_NODE_DOWNLOAD_BYTES
export const MAX_CRAG_DOWNLOAD_BYTES = MAX_KERNEL_DOWNLOAD_BYTES

const META_TIMEOUT_MS = 8000
const DOWNLOAD_TIMEOUT_MS = 60_000
const CRAG_DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const MAX_REDIRECTS = 3
function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function kernelReleaseHttpStatus(code) {
  if (code === 'github_http_404') return 404
  if (
    code === 'kernel_tag_invalid' ||
    code === 'kernel_asset_missing' ||
    code === 'cli_node_asset_missing' ||
    code === 'cc_node_asset_missing' ||
    code === 'kernel_asset_url' ||
    code === 'cli_node_asset_url' ||
    code === 'cc_node_asset_url' ||
    code === 'kernel_too_large' ||
    code === 'cli_node_too_large' ||
    code === 'cc_node_too_large' ||
    code === 'kernel_redirect_blocked' ||
    code === 'kernel_too_small' ||
    code === 'kernel_empty' ||
    String(code || '').startsWith('kernel_not_') ||
    String(code || '').startsWith('cli_node_') ||
    String(code || '').startsWith('cc_node_') ||
    String(code || '').startsWith('crag_')
  ) {
    return 400
  }
  return 502
}

export function isAllowedKernelUrl(raw, { redirect = false, crag = false } = {}) {
  let url
  try {
    url = new URL(String(raw || ''))
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  if (url.hostname === 'api.github.com') {
    return new RegExp(`^/repos/${GITHUB_REPO}/releases/(?:latest|tags/v\\d+\\.\\d+\\.\\d+|assets/\\d+)$`).test(
      url.pathname,
    )
  }
  if (url.hostname === 'github.com') {
    if (
      crag &&
      new RegExp(
        `^/${GITHUB_REPO}/releases/download/${CRAG_PAYLOAD_TAG_PATTERN}/crag-v2-licensed-amd64\\.tar\\.gz$`,
      ).test(url.pathname)
    )
      return true
    return new RegExp(
      `^/${GITHUB_REPO}/releases/download/v\\d+\\.\\d+\\.\\d+/(?:${KERNEL_RELEASE_ASSET}|${CLI_NODE_RELEASE_ASSET}|${CC_NODE_RELEASE_ASSET}|${KERNEL_CRAG_RELEASE_ASSET}|crag-v2-licensed-amd64\\.tar\\.gz)$`,
    ).test(url.pathname)
  }
  return (
    redirect &&
    (url.hostname === 'release-assets.githubusercontent.com' || url.hostname === 'objects.githubusercontent.com')
  )
}

export function selectReleaseAsset(payload, { name, maxBytes, missingCode, tooLargeCode }) {
  const tag = normalizeTag(payload?.tag_name || payload?.tag || '')
  if (!tag) return { ok: false, code: 'github_empty', error: 'GitHub Release 没有可用版本号' }
  const assets = Array.isArray(payload?.assets) ? payload.assets : []
  const asset = assets.find((item) => item && item.name === name)
  if (!asset) return { ok: false, code: missingCode, error: `GitHub Release 里没有 ${name}` }
  const size = Number(asset.size)
  if (Number.isFinite(size) && size > maxBytes) {
    return { ok: false, code: tooLargeCode, error: `${name} 超过 ${Math.round(maxBytes / (1024 * 1024))}MB` }
  }
  const apiUrl = typeof asset.url === 'string' ? asset.url : ''
  const browserUrl = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
  const scope = { crag: name === CRAG_V2_RELEASE_ASSET }
  // A component download must belong to the exact published tag, not just the same version.
  const expected =
    scope.crag && isCragPayloadTag(payload.payload_tag)
      ? `https://github.com/${GITHUB_REPO}/releases/download/${payload.payload_tag}/${name}`
      : ''
  const candidates = scope.crag ? [browserUrl, apiUrl] : [apiUrl, browserUrl]
  const url =
    expected && browserUrl !== ''
      ? browserUrl === expected
        ? browserUrl
        : undefined
      : candidates.find((candidate) => isAllowedKernelUrl(candidate, scope))
  if (!url)
    return {
      ok: false,
      code:
        name === CLI_NODE_RELEASE_ASSET
          ? 'cli_node_asset_url'
          : name === CC_NODE_RELEASE_ASSET
            ? 'cc_node_asset_url'
            : 'kernel_asset_url',
      error: `${name} 下载地址不是 GitHub Release`,
    }
  return {
    ok: true,
    tag,
    version: normalizeVersion(tag),
    asset: name,
    size: Number.isFinite(size) && size > 0 ? size : 0,
    url,
  }
}

export function selectKernelAsset(payload) {
  return selectReleaseAsset(payload, {
    name: KERNEL_RELEASE_ASSET,
    maxBytes: MAX_KERNEL_DOWNLOAD_BYTES,
    missingCode: 'kernel_asset_missing',
    tooLargeCode: 'kernel_too_large',
  })
}

export function selectCliNodeAsset(payload) {
  return selectReleaseAsset(payload, {
    name: CLI_NODE_RELEASE_ASSET,
    maxBytes: MAX_CLI_NODE_DOWNLOAD_BYTES,
    missingCode: 'cli_node_asset_missing',
    tooLargeCode: 'cli_node_too_large',
  })
}

export function selectCcNodeAsset(payload) {
  return selectReleaseAsset(payload, {
    name: CC_NODE_RELEASE_ASSET,
    maxBytes: MAX_CC_NODE_DOWNLOAD_BYTES,
    missingCode: 'cc_node_asset_missing',
    tooLargeCode: 'cc_node_too_large',
  })
}

export function selectCragAsset(payload) {
  return selectReleaseAsset(payload, {
    name: KERNEL_CRAG_RELEASE_ASSET,
    maxBytes: MAX_CRAG_DOWNLOAD_BYTES,
    missingCode: 'crag_asset_missing',
    tooLargeCode: 'crag_too_large',
  })
}

async function readCappedBody(res, maxBytes, label) {
  const tooLarge =
    label === CLI_NODE_RELEASE_ASSET
      ? 'cli_node_too_large'
      : label === CC_NODE_RELEASE_ASSET
        ? 'cc_node_too_large'
        : label === KERNEL_CRAG_RELEASE_ASSET
          ? 'crag_too_large'
          : 'kernel_too_large'
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw coded(tooLarge, `${label} 超过 ${Math.round(maxBytes / (1024 * 1024))}MB`)
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw coded(tooLarge, `${label} 超过 ${Math.round(maxBytes / (1024 * 1024))}MB`)
    return buf
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      total += chunk.length
      if (total > maxBytes) throw coded(tooLarge, `${label} 超过 ${Math.round(maxBytes / (1024 * 1024))}MB`)
      chunks.push(chunk)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  return Buffer.concat(chunks, total)
}

export async function openKernelReleaseAsset(startUrl, fetchImpl = globalThis.fetch, label = KERNEL_RELEASE_ASSET) {
  let current = startUrl
  const publicHeaders = { Accept: 'application/octet-stream', 'User-Agent': 'vm2api-release-check' }
  let headers = { ...publicHeaders }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedKernelUrl(current, { redirect: hop > 0, crag: label === CRAG_V2_RELEASE_ASSET })) {
      throw coded('kernel_redirect_blocked', 'GitHub 跳转到了不允许的地址')
    }
    if (hop === 0 && new URL(current).hostname === 'api.github.com')
      headers = githubApiHeaders('application/octet-stream')
    const res = await fetchImpl(current, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(label === CRAG_V2_RELEASE_ASSET ? CRAG_DOWNLOAD_TIMEOUT_MS : DOWNLOAD_TIMEOUT_MS),
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw coded('kernel_download_failed', 'GitHub 下载缺少跳转地址')
      current = new URL(loc, current).href
      headers = publicHeaders
      continue
    }
    if (!res.ok) {
      const code =
        label === CLI_NODE_RELEASE_ASSET
          ? 'cli_node_download_failed'
          : label === CC_NODE_RELEASE_ASSET
            ? 'cc_node_download_failed'
            : label === KERNEL_CRAG_RELEASE_ASSET
              ? 'crag_download_failed'
              : 'kernel_download_failed'
      throw coded(code, `GitHub ${label} 下载失败 (${res.status})`)
    }
    return res
  }
  throw coded('kernel_redirect_blocked', 'GitHub 下载跳转过多')
}

async function fetchReleaseBytes(startUrl, fetchImpl, maxBytes, label) {
  return readCappedBody(await openKernelReleaseAsset(startUrl, fetchImpl, label), maxBytes, label)
}

async function fetchReleaseJson(url, fetchImpl, maxBytes = 1024 * 1024) {
  const res = await fetchImpl(url, {
    headers: githubApiHeaders(),
    redirect: 'manual',
    signal: AbortSignal.timeout(META_TIMEOUT_MS),
  })
  if (res.status !== 200) throw coded(`github_http_${res.status}`, `GitHub Release 查询失败 (${res.status})`)
  try {
    return JSON.parse((await readCappedBody(res, maxBytes, 'metadata')).toString('utf8'))
  } catch (error) {
    if (error.code) throw error
    throw coded('github_bad_json', 'GitHub Release 响应不是 JSON')
  }
}

async function* kernelReleasePages(fetchImpl, maxPages) {
  const releasesUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases`
  for (let page = 1; page <= maxPages; page++) {
    const rows = await fetchReleaseJson(
      `${releasesUrl}?per_page=${CRAG_RELEASES_PAGE_SIZE}&page=${page}`,
      fetchImpl,
      4 * 1024 * 1024,
    )
    if (!Array.isArray(rows)) throw coded('github_bad_json', 'GitHub Release 列表格式无效')
    yield rows
    if (rows.length < CRAG_RELEASES_PAGE_SIZE) return
  }
}

export function selectCragV2Asset(payload) {
  return selectReleaseAsset(payload, {
    name: CRAG_V2_RELEASE_ASSET,
    maxBytes: MAX_CRAG_V2_DOWNLOAD_BYTES,
    missingCode: 'crag_v2_asset_missing',
    tooLargeCode: 'crag_v2_too_large',
  })
}

function hasUniqueAssets(row, specs) {
  return specs.every((spec) => spec.ok && row.assets.filter((asset) => asset?.name === spec.asset).length === 1)
}

export async function listKernelReleaseVersions({ fetchImpl = globalThis.fetch } = {}) {
  const versions = { 'cli-node': new Set(), crag: new Set() }
  for await (const rows of kernelReleasePages(fetchImpl, KERNEL_VERSION_LIST_MAX_PAGES)) {
    for (const row of rows) {
      if (row?.draft !== false || !Array.isArray(row.assets)) continue
      const component = CRAG_PAYLOAD_TAG.exec(row.tag_name || '')
      if (component) {
        if (component[2]) continue
        const tag = `v${component[1]}`
        const release = { ...row, tag_name: tag, payload_tag: row.tag_name }
        if (hasUniqueAssets(release, [selectCragV2Asset(release)])) versions.crag.add(row.tag_name)
      } else if (
        row.prerelease === false &&
        isReleaseTag(row.tag_name) &&
        hasUniqueAssets(row, [selectKernelAsset(row), selectCliNodeAsset(row)])
      ) {
        versions['cli-node'].add(row.tag_name)
      }
    }
  }
  return { 'cli-node': [...versions['cli-node']], crag: [...versions.crag] }
}

async function fetchCragPayloadRelease(version, fetchImpl) {
  // CRAG source is private. Only published component payloads are the public distribution channel.
  let incomplete
  for await (const rows of kernelReleasePages(fetchImpl, CRAG_RELEASES_MAX_PAGES)) {
    for (const row of rows) {
      const match = CRAG_PAYLOAD_TAG.exec(row?.tag_name || '')
      if (!match || match[2] || row.draft !== false) continue
      const tag = `v${match[1]}`
      if (version && version !== tag) continue
      const release = { ...row, tag_name: tag, payload_tag: row.tag_name }
      if (hasUniqueAssets(release, [selectCragV2Asset(release)])) return release
      incomplete ||= release
    }
  }
  if (incomplete) return incomplete
  throw coded('github_http_404', `vm2api 没有发布对应的 CRAG 载荷${version ? ` (${version})` : ''}`)
}

export async function fetchKernelReleaseMetadata({
  tag = '',
  kernel = 'cli-node',
  cragReleaseTag = '',
  fetchImpl = globalThis.fetch,
} = {}) {
  const requested = String(tag || '').trim()
  const configured = kernel === 'crag' ? String(cragReleaseTag || '').trim() : ''
  const trimmed = requested || configured
  if (!fetchImpl) throw coded('fetch_unavailable', 'fetch unavailable')
  const releasesUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases`
  if (kernel === 'crag' && isCragPayloadTag(trimmed)) {
    const row = await fetchReleaseJson(`${releasesUrl}/tags/${trimmed}`, fetchImpl, 4 * 1024 * 1024)
    if (row?.tag_name !== trimmed || row.draft !== false)
      throw coded('github_http_404', `vm2api 没有发布对应的 CRAG 载荷 (${trimmed})`)
    return { ...row, tag_name: `v${CRAG_PAYLOAD_TAG.exec(trimmed)[1]}`, payload_tag: trimmed }
  }
  const normalized = trimmed ? normalizeTag(trimmed) : ''
  if (trimmed && (!normalized || !isReleaseTag(normalized)))
    throw coded(
      'kernel_tag_invalid',
      kernel === 'crag' ? '请选择有效的 CRAG 版本或完整载荷标签' : 'Release tag 必须是 vX.Y.Z',
    )
  if (kernel === 'crag') return fetchCragPayloadRelease(normalized, fetchImpl)
  const payload = await fetchReleaseJson(`${releasesUrl}/${normalized ? `tags/${normalized}` : 'latest'}`, fetchImpl)
  if (!isReleaseTag(payload?.tag_name) || (normalized && payload.tag_name !== normalized))
    throw coded('kernel_tag_invalid', 'GitHub Release 版本号不匹配')
  return payload
}

export async function downloadReleaseKernel({ tag = '', fetchImpl = globalThis.fetch } = {}) {
  if (!fetchImpl) return { ok: false, code: 'fetch_unavailable', error: 'fetch unavailable' }
  const trimmed = String(tag || '').trim()
  let metaUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
  if (trimmed) {
    const normalized = normalizeTag(trimmed)
    if (!normalized || !isReleaseTag(normalized)) {
      return { ok: false, code: 'kernel_tag_invalid', error: 'Release tag 必须是 vX.Y.Z' }
    }
    metaUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${normalized}`
  }
  let payload
  try {
    const res = await fetchImpl(metaUrl, {
      headers: githubApiHeaders(),
      redirect: 'manual',
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
    })
    if (res.status !== 200) {
      return {
        ok: false,
        code: `github_http_${res.status}`,
        error: `GitHub Release 查询失败 (${res.status})`,
      }
    }
    try {
      payload = await res.json()
    } catch {
      return { ok: false, code: 'github_bad_json', error: 'GitHub Release 响应不是 JSON' }
    }
  } catch (error) {
    return {
      ok: false,
      code: error?.code && error.code !== 'ABORT_ERR' ? error.code : 'github_unreachable',
      error: String(error?.message || error || 'GitHub 不可达').slice(0, 200),
    }
  }
  const kernel = selectKernelAsset(payload)
  if (!kernel.ok) return kernel
  const cliNode = selectCliNodeAsset(payload)
  if (!cliNode.ok) return cliNode
  const ccNode = selectCcNodeAsset(payload)
  if (!ccNode.ok) return ccNode
  const crag = selectCragAsset(payload)
  if (!crag.ok) return crag
  let kernelBytes
  let cliBytes
  let ccBytes
  let cragBytes
  try {
    kernelBytes = await fetchReleaseBytes(kernel.url, fetchImpl, MAX_KERNEL_DOWNLOAD_BYTES, KERNEL_RELEASE_ASSET)
    cliBytes = await fetchReleaseBytes(cliNode.url, fetchImpl, MAX_CLI_NODE_DOWNLOAD_BYTES, CLI_NODE_RELEASE_ASSET)
    ccBytes = await fetchReleaseBytes(ccNode.url, fetchImpl, MAX_CC_NODE_DOWNLOAD_BYTES, CC_NODE_RELEASE_ASSET)
    cragBytes = await fetchReleaseBytes(crag.url, fetchImpl, MAX_CRAG_DOWNLOAD_BYTES, KERNEL_CRAG_RELEASE_ASSET)
  } catch (error) {
    return {
      ok: false,
      code: error?.code || 'kernel_download_failed',
      error: String(error?.message || error || 'release download failed').slice(0, 200),
    }
  }
  const kernelCheck = inspectLinuxAmd64Elf(kernelBytes)
  if (!kernelCheck.ok) return kernelCheck
  const cliCheck = inspectLinuxAmd64Elf(cliBytes)
  if (!cliCheck.ok) {
    return { ok: false, code: 'cli_node_not_elf', error: cliCheck.error || 'cli-node binary is not a linux amd64 ELF' }
  }
  if (cragBytes) {
    const cragCheck = inspectLinuxAmd64Elf(cragBytes)
    if (!cragCheck.ok) {
      return {
        ok: false,
        code: cragCheck.code || 'crag_not_elf',
        error: cragCheck.error || 'kin-kernel-crag is not ELF',
      }
    }
  }
  const ccCheck = inspectLinuxAmd64Elf(ccBytes)
  if (!ccCheck.ok) {
    return { ok: false, code: 'cc_node_not_elf', error: ccCheck.error || 'cc-node binary is not a linux amd64 ELF' }
  }
  return {
    ok: true,
    tag: kernel.tag,
    version: kernel.version,
    asset: kernel.asset,
    size: kernelBytes.length,
    bytes: kernelBytes,
    cliNode: {
      asset: cliNode.asset,
      size: cliBytes.length,
      bytes: cliBytes,
    },
    ccNode: {
      asset: ccNode.asset,
      size: ccBytes.length,
      bytes: ccBytes,
    },
    crag: { asset: crag.asset, size: cragBytes.length, bytes: cragBytes },
  }
}
