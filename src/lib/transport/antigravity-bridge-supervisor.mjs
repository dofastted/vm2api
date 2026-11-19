import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { isAntigravityVm } from '../vm/vm-kind.mjs'
import { isKvmRuntime } from '../vm/runtime-kind.mjs'
import { vmNodeId } from '../cluster/placement.mjs'
import { slotNetworkForVm } from '../vm/egress.mjs'
import { replaceSlotOwnedFile, chownSlotRuntimeFile, slotRuntimeOwner } from '../oauth/oauth-credentials.mjs'
import { publishAntigravitySlotAssets } from '../oauth/antigravity-auth-login.mjs'
import { normalizeAntigravityRouting, antigravityUpstreamIds } from '../protocol/antigravity-route.mjs'
import { antigravityBridgePaths, callAntigravityBridge } from './antigravity-bridge-client.mjs'

const execFileAsync = promisify(execFile)
const starts = new Map()
const tracked = new Map()
const scriptSource = fileURLToPath(new URL('../../../scripts/antigravity-bridge.mjs', import.meta.url))
const upstreamSource = fileURLToPath(new URL('../../../scripts/antigravity-upstream.mjs', import.meta.url))
const BRIDGE_SCRIPT = '/home/kincli/.kin/antigravity-bridge.mjs'
const BRIDGE_NODE = '/home/kincli/.kin/antigravity-node'
const AGENT =
  '---\nname: vm2api-text\ndescription: Text conversation without tools\ntools: []\nmainAgent: true\nsubagent: false\ncommandExecutionPolicy: "off"\nmcpServers: []\nskills: []\nplugins: []\n---\nRespond to the user using text.\n'

function fail(code, message, status = 503) {
  return { ok: false, status, code, message, error: message }
}
function keyOf(projectRoot, vm) {
  return `${path.resolve(projectRoot)}:${vm.id}`
}

export function antigravityRuntimeSupport(vm) {
  if (!isAntigravityVm(vm)) return fail('platform_mismatch', 'An Antigravity slot is required', 400)
  if (vmNodeId(vm) || isKvmRuntime(vm))
    return fail('antigravity_runtime_unsupported', 'Antigravity currently requires a local Docker slot', 400)
  const network = slotNetworkForVm(vm)
  if (!network || network === 'host' || network === 'bridge')
    return fail('proxy_required', 'Antigravity requires a bound slot egress network', 400)
  return { ok: true, network }
}

/** Writes only bridge config and a tool-free custom agent; no provider credentials. */
export function writeAntigravityBridgeConfig(projectRoot, vm, { routing = {} } = {}) {
  const options = normalizeAntigravityRouting(routing.antigravity || {})
  const paths = antigravityBridgePaths(projectRoot, vm)
  const home = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  const kin = path.join(home, '.kin')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-assets-'))
  try {
    const agentSource = path.join(temporary, 'vm2api-text.md')
    fs.writeFileSync(agentSource, AGENT, { mode: 0o600 })
    publishAntigravitySlotAssets(projectRoot, vm, {
      directories: ['.kin/antigravity-workspace/.agents/agents'],
      files: [
        { source: scriptSource, path: '.kin/antigravity-bridge.mjs' },
        { source: upstreamSource, path: '.kin/antigravity-upstream.mjs' },
        { source: agentSource, path: '.kin/antigravity-workspace/.agents/agents/vm2api-text.md' },
      ],
    })
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
  fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })
  if (!fs.lstatSync(paths.runDir).isDirectory() || fs.lstatSync(paths.runDir).isSymbolicLink())
    throw new Error('Unsafe bridge run directory')
  chownSlotRuntimeFile(paths.runDir, vm)
  let token = ''
  try {
    const fd = fs.openSync(paths.tokenPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      if (fs.fstatSync(fd).isFile() && fs.fstatSync(fd).size < 256) token = fs.readFileSync(fd, 'utf8').trim()
    } finally {
      fs.closeSync(fd)
    }
  } catch {}
  if (!token) token = crypto.randomBytes(32).toString('hex')
  replaceSlotOwnedFile(paths.tokenPath, token + '\n', vm)
  const config = {
    socket_path: '/run/kin/antigravity.sock',
    internal_token: token,
    cli_bin: options.cli_bin,
    workdir: '/home/kincli/.kin/antigravity-workspace',
    models: antigravityUpstreamIds(options.models.filter((model) => model.enabled)),
    max_sessions: options.max_sessions,
    idle_ttl_seconds: options.idle_ttl_seconds,
    timeout_ms: options.timeout_ms,
  }
  config.config_hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ ...config, internal_token: undefined }))
    .update(fs.readFileSync(scriptSource))
    .update(fs.readFileSync(upstreamSource))
    .digest('hex')
  replaceSlotOwnedFile(paths.configPath, JSON.stringify(config) + '\n', vm)
  return { ...paths, home, kin, config, options }
}

async function inspectSlot(vm, run = execFileAsync) {
  const container = vm.runtime?.container || `kin-${vm.id.replace(/^vm-/, '')}`
  const { stdout } = await run(
    'docker',
    ['inspect', '--format', '{{json .State.Running}}|{{.HostConfig.NetworkMode}}', container],
    { timeout: 5000, maxBuffer: 4096 },
  )
  const [running, network] = stdout.trim().split('|')
  return { container, running: running === 'true', network }
}

export async function antigravityBridgeStatus({ projectRoot, vm, routing = {} } = {}) {
  const support = antigravityRuntimeSupport(vm)
  if (!support.ok) return support
  if (!normalizeAntigravityRouting(routing.antigravity || {}).enabled)
    return fail('antigravity_disabled', 'Antigravity is disabled')
  const result = await callAntigravityBridge({ projectRoot, vm, timeoutMs: 1500 })
  return { ...result, ready: result.ok === true, authenticated: result.authenticated ?? null }
}

export async function ensureAntigravityBridge({ projectRoot, vm, routing = {}, ops = {} } = {}) {
  const support = antigravityRuntimeSupport(vm)
  if (!support.ok) return support
  const options = normalizeAntigravityRouting(routing.antigravity || {})
  if (!options.enabled) return fail('antigravity_disabled', 'Antigravity is disabled')
  const key = keyOf(projectRoot, vm)
  if (starts.has(key)) return starts.get(key)
  const work = (async () => {
    let info
    try {
      info = await inspectSlot(vm, ops.execFile || execFileAsync)
    } catch {
      return fail('antigravity_slot_unavailable', 'Antigravity slot container is not available')
    }
    if (!info.running || info.network !== support.network)
      return fail('antigravity_slot_unavailable', 'Antigravity slot is stopped or its egress network does not match')
    const paths = writeAntigravityBridgeConfig(projectRoot, vm, { routing })
    const old = await callAntigravityBridge({ projectRoot, vm, timeoutMs: 1000 })
    if (old.ok) {
      tracked.set(key, { projectRoot, vm })
      if (old.config_hash !== paths.config.config_hash)
        return fail(
          'antigravity_runtime_reload_required',
          'Antigravity configuration changed; restart the slot to apply it',
          409,
        )
      return { ...old, ready: true }
    }
    const nodeSource =
      ops.nodeSource || process.env.KIN_ANTIGRAVITY_NODE_BIN || (process.platform === 'linux' ? process.execPath : '')
    if (!nodeSource || !fs.existsSync(nodeSource))
      return fail('antigravity_node_unavailable', 'A Linux Node executable is required for the Antigravity slot')
    const header = Buffer.alloc(4)
    const nodeFd = fs.openSync(nodeSource, 'r')
    try {
      fs.readSync(nodeFd, header, 0, 4, 0)
    } finally {
      fs.closeSync(nodeFd)
    }
    if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
      return fail('antigravity_node_unavailable', 'The Antigravity slot requires a Linux ELF Node executable')
    publishAntigravitySlotAssets(projectRoot, vm, { files: [{ source: nodeSource, path: '.kin/antigravity-node' }] })
    // ECONNREFUSED means the previous container left a stale socket. An auth
    // response is a live process and must never be unlinked or replaced.
    if (old.code === 'unauthorized')
      return fail('antigravity_bridge_auth_failed', 'Antigravity bridge token does not match')
    if (!['ENOENT', 'ECONNREFUSED'].includes(old.transport_code))
      return fail('antigravity_bridge_unavailable', 'Antigravity socket could not be verified as stopped')
    try {
      fs.unlinkSync(paths.socketPath)
    } catch (error) {
      if (error.code !== 'ENOENT')
        return fail('antigravity_socket_unavailable', 'Antigravity socket could not be prepared')
    }
    const child = (ops.spawn || spawn)(
      'docker',
      [
        'exec',
        '--user',
        `${slotRuntimeOwner(vm).uid}:${slotRuntimeOwner(vm).gid}`,
        '--env',
        'HOME=/home/kincli',
        '--env',
        'PATH=/home/kincli/.local/bin:/usr/local/bin:/usr/bin:/bin',
        '--workdir',
        '/home/kincli',
        info.container,
        BRIDGE_NODE,
        BRIDGE_SCRIPT,
        '--config',
        '/run/kin/antigravity.json',
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], shell: false },
    )
    let exited = false
    child.once('error', () => {
      exited = true
    })
    child.once('exit', () => {
      exited = true
    })
    tracked.set(key, { projectRoot, vm, child })
    const until = Date.now() + 5000
    while (!exited && Date.now() < until) {
      const health = await callAntigravityBridge({ projectRoot, vm, timeoutMs: 500 })
      if (health.ok) return { ...health, ready: true }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // Keep a slow-starting exec tracked so shutdown can still close its bridge.
    return fail('antigravity_bridge_start_failed', 'Antigravity bridge failed to start in the slot')
  })()
  starts.set(key, work)
  try {
    return await work
  } catch {
    return fail('antigravity_bridge_setup_failed', 'Antigravity bridge files or runtime could not be prepared')
  } finally {
    starts.delete(key)
  }
}

export async function runAntigravityText({
  projectRoot,
  vm,
  routing = {},
  model,
  prompt,
  sessionId,
  signal,
  onText,
  ops = {},
} = {}) {
  const options = normalizeAntigravityRouting(routing.antigravity || {})
  const started = await (ops.ensureBridge || ensureAntigravityBridge)({ projectRoot, vm, routing, ops })
  if (!started.ok) return started
  return await (ops.callBridge || callAntigravityBridge)({
    projectRoot,
    vm,
    requestPath: '/text',
    body: { model, prompt, session_id: sessionId },
    signal,
    onText,
    timeoutMs: options.timeout_ms + 5000,
  })
}

/** Structured API requests are forwarded to the slot-local official service adapter. */
export async function runAntigravityInference({
  projectRoot,
  vm,
  routing = {},
  request,
  signal,
  onEvent,
  ops = {},
} = {}) {
  const options = normalizeAntigravityRouting(routing.antigravity || {})
  const started = await (ops.ensureBridge || ensureAntigravityBridge)({ projectRoot, vm, routing, ops })
  if (!started.ok) return started
  return await (ops.callBridge || callAntigravityBridge)({
    projectRoot,
    vm,
    requestPath: '/inference',
    body: request,
    signal,
    onEvent,
    timeoutMs: options.timeout_ms + 5000,
  })
}

export async function fetchAntigravityQuota({ projectRoot, vm, routing = {}, ops = {} } = {}) {
  const started = await (ops.ensureBridge || ensureAntigravityBridge)({ projectRoot, vm, routing, ops })
  if (!started.ok) return started
  return await (ops.callBridge || callAntigravityBridge)({ projectRoot, vm, requestPath: '/quota', timeoutMs: 25_000 })
}

export async function stopAntigravityBridge(projectRoot, vm) {
  const key = keyOf(projectRoot, vm)
  if (!tracked.has(key)) return { ok: true, skipped: true }
  const result = await callAntigravityBridge({ projectRoot, vm, requestPath: '/shutdown', body: {}, timeoutMs: 1000 })
  tracked.delete(key)
  return result
}

export async function stopAllAntigravityBridges() {
  return await Promise.allSettled(
    [...tracked.values()].map(({ projectRoot, vm }) => stopAntigravityBridge(projectRoot, vm)),
  )
}
