/**
 * Control-plane version, changelog, and GitHub release check.
 * Host one-click upgrade lives in deploy/install.sh; the panel surfaces
 * the same command and (optionally) kicks it via docker.sock.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { toHostPath } from '../vm/host-path.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PROJECT = path.resolve(__dirname, '..', '..', '..')
const execFileAsync = promisify(execFile)
const UPGRADE_SCRIPT = fs.readFileSync(path.join(MODULE_PROJECT, 'scripts', 'panel-upgrade.sh'), 'utf8')

export const GITHUB_REPO = 'dofastted/vm2api'
export const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/deploy/install.sh`
export const DOCKER_SOCK = '/var/run/docker.sock'

const DEFAULT_CACHE_MS = 5 * 60 * 1000
const GITHUB_TIMEOUT_MS = 8000
const releaseCache = { at: 0, value: null, error: null }

export function projectRoot(explicit) {
  return explicit || process.env.KIN_PROJECT_ROOT || process.env.VM2API_HOST_ROOT || MODULE_PROJECT
}

export function readLocalVersion(root = projectRoot()) {
  const candidates = [
    path.join(root, 'VERSION'),
    path.join(MODULE_PROJECT, 'VERSION'),
    path.join(root, 'package.json'),
    path.join(MODULE_PROJECT, 'package.json'),
  ]
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue
      const raw = fs.readFileSync(file, 'utf8')
      if (file.endsWith('package.json')) {
        const ver = JSON.parse(raw).version
        if (ver) return normalizeVersion(ver) || '0.0.0'
        continue
      }
      const ver = normalizeVersion(raw.trim())
      if (ver) return ver
    } catch {
      // try next
    }
  }
  return '0.0.0'
}

const ARCH_ALIASES = Object.freeze({ amd64: 'amd64', x86_64: 'amd64', x64: 'amd64', arm64: 'arm64', aarch64: 'arm64' })
const RELEASE_TAG_RE = /^v?(\d+\.\d+\.\d+)(?:-(amd64|x86_64|arm64|aarch64))?$/i

/** Docker architecture name for uname / Node / Docker spellings; '' when unsupported. */
export function normalizeArch(value) {
  return (
    ARCH_ALIASES[
      String(value || '')
        .trim()
        .toLowerCase()
    ] || ''
  )
}

/** `v1.2.3`, `1.2.3-arm64`, `v1.2.3-aarch64` → { version, tag, arch }; arch is '' without a suffix. */
export function parseReleaseTag(value) {
  const m = String(value || '')
    .trim()
    .match(RELEASE_TAG_RE)
  if (!m) return null
  return { version: m[1], tag: `v${m[1]}`, arch: m[2] ? normalizeArch(m[2]) : '' }
}

export function normalizeVersion(value) {
  return parseReleaseTag(value)?.version || ''
}

export function normalizeTag(value) {
  return parseReleaseTag(value)?.tag || ''
}

export function isReleaseTag(value) {
  return /^v\d+\.\d+\.\d+$/.test(String(value || '').trim())
}

/**
 * Control-plane image tag for a release on this architecture. amd64 keeps the
 * bare tag (a manifest list, so existing installs keep working); arm64 pins
 * its single-arch image so a host-wide DOCKER_DEFAULT_PLATFORM cannot swap it.
 */
export function imageTagFor(tag, arch = process.arch) {
  const parsed = parseReleaseTag(tag)
  const target = normalizeArch(arch)
  if (!parsed || !target) return ''
  return target === 'arm64' ? `${parsed.tag}-arm64` : parsed.tag
}

export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

function parseSemver(value) {
  const n = normalizeVersion(value)
  const parts = n.split('.').map((x) => Number.parseInt(x, 10))
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

function bulletsOf(body) {
  return String(body || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
}

function firstParagraph(body) {
  const block = String(body || '')
    .split(/\n\s*\n/)[0]
    ?.trim()
  if (!block) return ''
  if (block.startsWith('- ')) return ''
  return block
    .split('\n')
    .filter((line) => !line.trim().startsWith('- '))
    .join('\n')
    .trim()
}

export function parseChangelog(markdown) {
  const text = String(markdown || '').replace(/\r\n/g, '\n')
  const parts = text.split(/^## /m).slice(1)
  const entries = []
  for (const part of parts) {
    const nl = part.indexOf('\n')
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim()
    const body = (nl === -1 ? '' : part.slice(nl + 1)).trim()
    if (/^unreleased$/i.test(heading)) {
      entries.push({
        version: 'unreleased',
        tag: null,
        date: null,
        heading,
        title: firstParagraph(body),
        body,
        bullets: bulletsOf(body),
        needs_wrap_cli_sync: /wrap-cli\/sync/i.test(body),
      })
      continue
    }
    const m = heading.match(/^v?(\d+\.\d+\.\d+)\s*[—–-]\s*(\d{4}-\d{2}-\d{2})?/)
    if (!m) continue
    entries.push({
      version: m[1],
      tag: `v${m[1]}`,
      date: m[2] || null,
      heading,
      title: firstParagraph(body),
      body,
      bullets: bulletsOf(body),
      needs_wrap_cli_sync: /wrap-cli\/sync/i.test(body),
    })
  }
  return entries
}

export function loadChangelog(root = projectRoot()) {
  const candidates = [path.join(root, 'CHANGELOG.md'), path.join(MODULE_PROJECT, 'CHANGELOG.md')]
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue
      return parseChangelog(fs.readFileSync(file, 'utf8'))
    } catch {
      // try next
    }
  }
  return []
}

export function changelogSince(entries, currentVersion) {
  const current = normalizeVersion(currentVersion)
  return (entries || []).filter((entry) => {
    if (!entry?.version || entry.version === 'unreleased') return false
    return compareSemver(entry.version, current) > 0
  })
}

export function upgradeCommand(target) {
  const tag = normalizeTag(target)
  const flag = tag ? ` --version ${tag}` : ''
  return `curl -sSL ${INSTALL_SCRIPT_URL} | sudo bash -s -- upgrade${flag}`
}

export function defaultUpgradeCommand() {
  return upgradeCommand()
}

export function githubApiHeaders(accept = 'application/vnd.github+json') {
  const headers = {
    Accept: accept,
    'User-Agent': 'vm2api-release-check',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const token = process.env.GITHUB_TOKEN || process.env.VM2API_GITHUB_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function githubHeaders() {
  return githubApiHeaders()
}

export function publicRelease(payload) {
  if (!payload || typeof payload !== 'object') return null
  const tag = payload.tag_name || payload.tag || ''
  const version = normalizeVersion(tag)
  if (!version) return null
  return {
    version,
    tag: normalizeTag(version),
    name: payload.name || `vm2api ${version}`,
    html_url: payload.html_url || `https://github.com/${GITHUB_REPO}/releases/tag/${normalizeTag(version)}`,
    published_at: payload.published_at || payload.created_at || null,
    notes: String(payload.body || '').trim(),
  }
}

export async function fetchLatestRelease({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheMs = DEFAULT_CACHE_MS,
} = {}) {
  const ts = now()
  if (releaseCache.value && ts - releaseCache.at < cacheMs) {
    return { release: releaseCache.value, error: null, cached: true }
  }
  if (!fetchImpl) {
    return { release: releaseCache.value, error: 'fetch_unavailable', cached: false }
  }
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    })
    if (!res.ok) {
      const error = `github_http_${res.status}`
      releaseCache.at = ts
      releaseCache.error = error
      return { release: releaseCache.value, error, cached: false }
    }
    const release = publicRelease(await res.json())
    if (!release) {
      const error = 'github_empty'
      releaseCache.at = ts
      releaseCache.error = error
      return { release: releaseCache.value, error, cached: false }
    }
    releaseCache.at = ts
    releaseCache.value = release
    releaseCache.error = null
    return { release, error: null, cached: false }
  } catch (err) {
    const error = String(err?.message || err || 'github_unreachable')
    releaseCache.at = ts
    releaseCache.error = error
    return { release: releaseCache.value, error, cached: false }
  }
}

export function clearReleaseCache() {
  releaseCache.at = 0
  releaseCache.value = null
  releaseCache.error = null
}

export async function buildUpdateStatus({ projectRoot: root, currentVersion, upgrade, fetchImpl, now, cacheMs } = {}) {
  const project = projectRoot(root)
  const current = currentVersion || readLocalVersion(project)
  const entries = loadChangelog(project)
  const remote = await fetchLatestRelease({ fetchImpl, now, cacheMs })
  const latest = remote.release?.version || current
  const newer = changelogSince(entries, current)
  const updateAvailable = compareSemver(latest, current) > 0
  const needsWrap = newer.some((entry) => entry.needs_wrap_cli_sync)
  return {
    current,
    current_tag: normalizeTag(current),
    latest,
    latest_tag: normalizeTag(latest),
    update_available: updateAvailable,
    html_url: remote.release?.html_url || `https://github.com/${GITHUB_REPO}/releases`,
    published_at: remote.release?.published_at || null,
    name: remote.release?.name || null,
    notes: remote.release?.notes || newer[0]?.title || '',
    changelog: newer,
    needs_wrap_cli_sync: needsWrap,
    upgrade_command: upgradeCommand(updateAvailable ? latest : ''),
    check_command: `sudo bash ${hostRoot(root)}/deploy/install.sh check`,
    repo: GITHUB_REPO,
    source_error: remote.error,
    ...(upgrade ? { upgrade } : {}),
  }
}

function which(cmd) {
  const dirs = [...(process.env.PATH || '').split(path.delimiter), '/usr/local/bin', '/usr/bin', '/bin']
  const seen = new Set()
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    const candidate = path.join(dir, cmd)
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // skip
    }
  }
  return null
}

/**
 * Host path of the install dir. Explicit env wins, otherwise derived from the
 * control-plane container's own mounts; identity when running natively.
 */
export function hostRoot(root) {
  const explicit = String(process.env.VM2API_HOST_ROOT || process.env.KIN_HOST_ROOT || '').trim()
  if (explicit) return explicit
  return toHostPath(projectRoot(root), { projectRoot: projectRoot(root) })
}

export function canSpawnHostUpgrade({ dockerBin = which('docker'), sock = DOCKER_SOCK } = {}) {
  return Boolean(dockerBin && fs.existsSync(sock))
}

async function inspectContainer(name, { dockerBin, execFileImpl }) {
  const { stdout } = await execFileImpl(dockerBin, ['inspect', '--format', '{{json .}}', name], {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 1024 * 1024,
  })
  return JSON.parse(stdout)
}

/** Only update the Compose deployment that owns this running control plane. */
export async function hostUpgradeDeployment({
  dockerBin = which('docker'),
  sock = DOCKER_SOCK,
  containerized = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv'),
  hostname = os.hostname(),
  env = process.env,
  execFileImpl = execFileAsync,
} = {}) {
  if (!containerized || !canSpawnHostUpgrade({ dockerBin, sock })) return null
  const names = [...new Set([hostname, env.VM2API_CONTAINER_NAME].filter(Boolean))]
  for (const name of names) {
    try {
      const container = await inspectContainer(name, { dockerBin, execFileImpl })
      const labels = container.Config?.Labels || {}
      const project = labels['com.docker.compose.project']
      const root = labels['com.docker.compose.project.working_dir']
      const files = String(labels['com.docker.compose.project.config_files'] || '')
        .split(',')
        .map((file) => file.trim())
        .filter(Boolean)
      if (
        !container.State?.Running ||
        !container.Id ||
        container.Config?.Hostname !== hostname ||
        labels['com.docker.compose.service'] !== 'vm2api' ||
        !/^[a-z0-9][a-z0-9_-]*$/.test(project || '') ||
        !path.isAbsolute(root || '') ||
        !files.length ||
        files.some((file) => !file.startsWith(`${root}/`))
      ) {
        continue
      }
      return {
        root,
        project,
        files,
        container: String(container.Name || name).replace(/^\//, ''),
        id: container.Id,
        helper: `vm2api-upgrade-${project}`,
      }
    } catch {
      // Try the hostname when an explicitly configured name is stale.
    }
  }
  return null
}

export async function readHostUpgradeStatus(options = {}) {
  const deployment = options.deployment || (await hostUpgradeDeployment(options))
  if (!deployment) return null
  try {
    const container = await inspectContainer(deployment.helper, {
      dockerBin: options.dockerBin || which('docker'),
      execFileImpl: options.execFileImpl || execFileAsync,
    })
    const target = container.Config?.Labels?.['vm2api.upgrade.target']
    if (!isReleaseTag(target)) return null
    const state = container.State || {}
    return {
      state: state.Status === 'exited' ? (state.ExitCode === 0 ? 'succeeded' : 'failed') : 'running',
      target,
      exit_code: state.Status === 'exited' ? state.ExitCode : null,
      log_command: `docker logs ${deployment.helper}`,
    }
  } catch {
    return null
  }
}

/**
 * Start a Docker-managed helper which survives replacement of the HTTP server.
 * Retain its exit status and logs so a failed upgrade cannot look successful.
 */
export async function startHostUpgrade({
  projectRoot: root,
  currentVersion,
  confirm = false,
  version,
  arch = process.arch,
  dockerBin = which('docker'),
  sock = DOCKER_SOCK,
  containerized,
  hostname,
  env,
  execFileImpl = execFileAsync,
  fetchImpl,
  now,
} = {}) {
  const requested = version != null && String(version).trim() !== '' ? parseReleaseTag(version) : null
  if (version != null && String(version).trim() !== '' && !requested) {
    return {
      status: 400,
      error: { message: '无效版本', code: 'invalid_version' },
    }
  }
  const hostArch = normalizeArch(arch)
  if (!hostArch) {
    return {
      status: 400,
      error: { message: `不支持的控制面架构 ${arch}`, code: 'unsupported_arch' },
    }
  }
  if (requested?.arch && requested.arch !== hostArch) {
    return {
      status: 400,
      error: { message: `版本后缀 -${requested.arch} 与控制面架构 ${hostArch} 不符`, code: 'arch_mismatch' },
    }
  }
  const status = await buildUpdateStatus({ projectRoot: root, currentVersion, fetchImpl, now })
  const target = requested ? requested.tag : status.latest_tag
  if (!isReleaseTag(target)) {
    return {
      status: 400,
      error: { message: '无效版本', code: 'invalid_version' },
    }
  }
  const command = upgradeCommand(target)
  if (!confirm) {
    return {
      status: 200,
      data: { ...status, started: false, target, command },
    }
  }
  if (!status.update_available && !version) {
    return {
      status: 200,
      data: { ...status, started: false, target, command, message: 'already_latest' },
    }
  }
  const options = { dockerBin, sock, containerized, hostname, env, execFileImpl }
  const deployment = await hostUpgradeDeployment(options)
  if (!deployment) {
    return {
      status: 409,
      error: {
        message: '当前控制面不是可识别的 Docker Compose 服务，请到宿主机更新并重启实际提供接口的后端',
        code: 'host_upgrade_required',
        command,
        target,
      },
      data: { ...status, started: false, target, command },
    }
  }
  const previous = await readHostUpgradeStatus({ ...options, deployment })
  if (previous?.state === 'running') {
    return {
      status: 409,
      error: { message: '控制面更新正在进行', code: 'upgrade_in_progress' },
      data: { ...status, started: false, target, command, upgrade: previous },
    }
  }
  try {
    if (previous) await execFileImpl(dockerBin, ['rm', deployment.helper], { timeout: 8000 })
    await execFileImpl(
      dockerBin,
      [
        'run',
        '--detach',
        '--name',
        deployment.helper,
        '--label',
        `vm2api.upgrade.target=${target}`,
        '-v',
        `${deployment.root}:${deployment.root}`,
        '-v',
        `${DOCKER_SOCK}:${DOCKER_SOCK}`,
        '-w',
        deployment.root,
        'docker:27-cli',
        'sh',
        '-c',
        UPGRADE_SCRIPT,
        'panel-upgrade',
        deployment.root,
        deployment.project,
        deployment.container,
        deployment.id,
        target,
        hostArch,
        ...deployment.files,
      ],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 },
    )
  } catch {
    return {
      status: 502,
      error: { message: '无法启动控制面更新任务，请检查 Docker 和更新日志', code: 'upgrade_start_failed' },
      data: { ...status, started: false, target, command },
    }
  }
  return {
    status: 202,
    data: {
      ...status,
      started: true,
      target,
      command,
      message: 'upgrade_started',
      upgrade: {
        state: 'running',
        target,
        exit_code: null,
        log_command: `docker logs ${deployment.helper}`,
      },
    },
  }
}
