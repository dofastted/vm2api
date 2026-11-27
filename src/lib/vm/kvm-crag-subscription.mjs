import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { slotRuntimeOwner } from '../oauth/oauth-credentials.mjs'
import { readCragSubscriptionFiles, readKvmCragLicense } from './crag-license.mjs'
import { isCustomKvmMode } from './custom-os-runtime.mjs'
import { isDockerInspectNotFound } from './docker-container.mjs'
import { createKvmSlotAgentClient } from './kvm-slot-agent-client.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { slotExecArgv, slotExecContainer } from './slot-exec.mjs'

let script
const MAX_PENDING_PROJECTIONS = 16
const TOKEN_RE = /^[a-f0-9]{64}$/
const MACHINE_ID_RE = /^[a-f0-9]{32}$/
const RETRYABLE_AGENT_ERRORS = new Set(['agent_unreachable', 'agent_timeout', 'agent_eof'])
const queues = new Map()
const holds = new Map()
const localKvm = (vm) => process.platform === 'linux' && !vm?.node_id && isKvmRuntime(vm)
const failure = () =>
  Object.assign(new Error('CRAG guest subscription projection failed'), {
    status: 503,
    code: 'crag_subscription_projection_failed',
  })

const CUSTOM_STATUS_SCRIPT = [
  'import ctypes, hashlib, json, os, re, sys',
  'ROOT, RUN = "/run/vm2api-crag", "/run/kin"',
  'class StatFs(ctypes.Structure):',
  '    _fields_ = [("f_type", ctypes.c_long), ("_pad", ctypes.c_byte * 256)]',
  'def fs_magic(p):',
  '    s = StatFs()',
  '    if ctypes.CDLL(None).statfs(p.encode(), ctypes.byref(s)) != 0: raise OSError()',
  '    return int(s.f_type) & 0xffffffff',
  'def mount_opts(target):',
  '    found = None',
  '    for line in open("/proc/self/mountinfo", encoding="utf8"):',
  '        f = line.split()',
  '        if len(f) < 6: continue',
  '        m = re.sub(r"\\\\([0-7]{3})", lambda g: chr(int(g.group(1), 8)), f[4])',
  '        if m == target: found = set(f[5].split(","))',
  '    return found',
  'def same_dir(a, b):',
  '    sa, sb = os.stat(a, follow_symlinks=False), os.stat(b, follow_symlinks=False)',
  '    return (sa.st_dev, sa.st_ino) == (sb.st_dev, sb.st_ino)',
  'try:',
  '    if os.geteuid() != 0 or fs_magic(ROOT) != 0x01021994: raise ValueError()',
  '    lic, host = ROOT + "/license", ROOT + "/host"',
  '    for src, dst in ((lic, RUN + "/crag-license"), (host, RUN + "/crag-host")):',
  '        if "ro" not in (mount_opts(dst) or set()) or not same_dir(src, dst): raise ValueError()',
  '    if os.path.lexists(host + "/sync-pending") or os.path.lexists(lic + "/sync-pending"): raise ValueError()',
  '    fd = os.open(lic + "/device.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)',
  '    try: dev = json.loads(os.read(fd, 65537))',
  '    finally: os.close(fd)',
  '    mid = open("/etc/machine-id", encoding="ascii").read(64).strip()',
  '    exp_mid = sys.argv[1] if len(sys.argv) > 1 else None',
  '    exp_vm = sys.argv[2] if len(sys.argv) > 2 else None',
  '    if not re.fullmatch(r"[a-f0-9]{32}", mid): raise ValueError()',
  '    if dev.get("machine_id_hash") != hashlib.sha256(mid.encode()).hexdigest(): raise ValueError()',
  '    if exp_mid is not None and exp_mid != mid: raise ValueError()',
  '    if exp_vm is not None and exp_vm != dev.get("vm_id"): raise ValueError()',
  '    print(\'{"ok":true}\')',
  'except Exception:',
  '    sys.stderr.write("CRAG guest subscription projection failed\\n")',
  '    sys.exit(1)',
].join('\n')

function isCustomErofsSlot(vm, options = null) {
  const modeOpts = { vm, kernel: options?.kernel ?? vm?.kernel }
  if (options != null && Object.hasOwn(options, 'env')) modeOpts.env = options.env
  if (options?.mode !== undefined) modeOpts.mode = options.mode
  if (options?.kvmMode !== undefined) modeOpts.kvmMode = options.kvmMode
  if (options?.runtimeMode !== undefined) modeOpts.runtimeMode = options.runtimeMode
  if (options?.customOsRuntimeMode !== undefined) modeOpts.customOsRuntimeMode = options.customOsRuntimeMode
  return isCustomKvmMode(modeOpts)
}

export function holdKvmCragSubscriptionPublications(projectRoot) {
  const root = path.resolve(projectRoot)
  holds.set(root, (holds.get(root) || 0) + 1)
  let held = true
  return () => {
    if (!held) return
    held = false
    const remaining = holds.get(root) - 1
    if (remaining) holds.set(root, remaining)
    else holds.delete(root)
  }
}

function assertPublicationAllowed(projectRoot) {
  if (holds.has(path.resolve(projectRoot))) {
    throw Object.assign(failure(), { code: 'crag_subscription_sync_pending' })
  }
}

function guestScript() {
  script ??= fs.readFileSync(new URL('../../../docker/kin-kvm/guest/kin-crag-subscription', import.meta.url), 'utf8')
  return script
}

export function kvmCragSubscriptionStatusCommand(vm, machineId, options = null) {
  if (isCustomErofsSlot(vm, options)) {
    return ['python3', '-c', CUSTOM_STATUS_SCRIPT, machineId, vm.id]
  }
  return ['python3', '-c', guestScript(), '--status', machineId, vm.id]
}

function runDockerExec(args, { input, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.env.KIN_DOCKER_BIN || 'docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let error = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    const finish = (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout: output, error })
    }
    child.stdout.on('data', (value) => {
      output = (output + value).slice(-4096)
    })
    child.stderr.on('data', (value) => {
      error = (error + value).slice(-4096)
    })
    child.once('error', () => finish(null))
    child.once('close', finish)
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

async function running(vm, run) {
  const result = await run(['container', 'inspect', '--format', '{{json .State.Running}}', slotExecContainer(vm)], {
    timeoutMs: 3000,
  })
  if (result?.ok) {
    const state = String(result.stdout || '').trim()
    if (state === 'true') return true
    if (state === 'false') return false
  } else if (result?.code === 1 && isDockerInspectNotFound({ ...result, stderr: result.stderr || result.error }))
    return false
  throw failure()
}

function exclusive(projectRoot, vm, work) {
  const key = `${path.resolve(projectRoot)}:${vm.id}`
  const queue = queues.get(key) || { pending: 0, tail: Promise.resolve() }
  if (queue.pending >= MAX_PENDING_PROJECTIONS) {
    return Promise.reject(
      Object.assign(new Error('CRAG guest license projection is busy'), {
        status: 503,
        code: 'crag_subscription_projection_busy',
      }),
    )
  }
  queue.pending++
  const next = queue.tail.catch(() => {}).then(work)
  queue.tail = next
  queues.set(key, queue)
  return next.finally(() => {
    queue.pending--
    if (queue.pending === 0) queues.delete(key)
  })
}

function agentFailure(res) {
  const error = failure()
  error.retryable = RETRYABLE_AGENT_ERRORS.has(String(res?.error || ''))
  return error
}

function readSlotAgentToken(kvmDir, explicitToken) {
  if (typeof explicitToken === 'string') {
    const clean = explicitToken.trim().toLowerCase()
    return TOKEN_RE.test(clean) ? clean : ''
  }
  for (const name of ['.agent-token', 'agent.token']) {
    try {
      const raw = fs.readFileSync(path.join(kvmDir, name), 'utf8').trim().toLowerCase()
      if (TOKEN_RE.test(raw)) return raw
    } catch {}
  }
  return ''
}

function resolveAgentClient(projectRoot, vm, options = {}) {
  if (options.agentClient) return options.agentClient
  const kvmDir = path.join(projectRoot, 'vms', vm.id, 'kvm')
  const socketPath = String(options.agentSocketPath || path.join(kvmDir, 'agent.sock')).trim()
  const token = readSlotAgentToken(kvmDir, options.agentToken)
  if (!socketPath || !token) {
    const err = failure()
    err.retryable = false
    throw err
  }
  const createClient = options.createAgentClient || createKvmSlotAgentClient
  return createClient({
    socketPath,
    token,
    timeoutMs: options.timeoutMs ?? 10_000,
  })
}

function assertAgentOk(res) {
  if (!res?.ok) throw agentFailure(res)
  return res.result ?? {}
}

async function projectViaAgent(projectRoot, vm, action, files, options = {}) {
  const client = resolveAgentClient(projectRoot, vm, options)
  const rpcOpts = options.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}

  if (action === 'block') {
    assertAgentOk(await client.blockSubscription({ scope: 'all', reason: 'subscription_blocked' }, rpcOpts))
    return true
  }

  if (action === 'clear') {
    assertAgentOk(await client.clearSubscription({ scope: 'all' }, rpcOpts))
    return true
  }

  if (action === 'publish-universal') {
    if (!files || typeof files.permit !== 'string' || !files.permit.startsWith('CRAGU1.')) {
      const err = failure()
      err.retryable = false
      throw err
    }
    const status = assertAgentOk(await client.status(rpcOpts))
    if (status.tmpfs_ok !== true) {
      const err = failure()
      err.retryable = false
      throw err
    }
    assertAgentOk(await client.clearSubscription({ scope: 'host' }, rpcOpts))
    assertAgentOk(
      await client.publishUniversal(
        {
          scope: 'license',
          files: [{ rel: 'registration.code', content: files.permit }],
        },
        rpcOpts,
      ),
    )
    return true
  }

  if (action === 'publish') {
    const machineId = String(vm.fingerprint?.guest_machine_id || '')
      .trim()
      .toLowerCase()
    if (!MACHINE_ID_RE.test(machineId) || /^0{32}$/.test(machineId)) {
      const err = failure()
      err.retryable = false
      throw err
    }
    if (
      !files ||
      typeof files.device !== 'string' ||
      !files.device ||
      typeof files.permit !== 'string' ||
      !files.permit ||
      typeof files.hostId !== 'string' ||
      !files.hostId ||
      typeof files.entitlement !== 'string' ||
      !files.entitlement
    ) {
      const err = failure()
      err.retryable = false
      throw err
    }
    let parsedDevice
    try {
      parsedDevice = JSON.parse(files.device)
    } catch {
      const err = failure()
      err.retryable = false
      throw err
    }
    const expectedHash = crypto.createHash('sha256').update(machineId).digest('hex')
    if (parsedDevice?.vm_id !== vm.id || parsedDevice?.machine_id_hash !== expectedHash) {
      const err = failure()
      err.retryable = false
      throw err
    }

    const status = assertAgentOk(await client.status(rpcOpts))
    const guestMid = String(status.machine_id || '')
      .trim()
      .toLowerCase()
    if (status.tmpfs_ok !== true || guestMid !== machineId) {
      const err = failure()
      err.retryable = false
      throw err
    }

    // Fence host scope with sync-pending while updating license + host files atomically on tmpfs.
    assertAgentOk(await client.blockSubscription({ scope: 'host', reason: 'updating' }, rpcOpts))
    assertAgentOk(
      await client.publishSubscription(
        {
          scope: 'license',
          files: [
            { rel: 'device.json', content: files.device },
            { rel: 'registration.code', content: files.permit },
          ],
        },
        rpcOpts,
      ),
    )
    assertAgentOk(
      await client.publishSubscription(
        {
          scope: 'host',
          files: [
            { rel: 'host_id', content: files.hostId },
            { rel: 'entitlement.code', content: files.entitlement },
          ],
        },
        rpcOpts,
      ),
    )
    return true
  }

  const err = failure()
  err.retryable = false
  throw err
}

async function projectLegacy(vm, action, files, run) {
  const { uid, gid } = slotRuntimeOwner(vm)
  const request = {
    action,
    vm_id: vm.id,
    machine_id: vm.fingerprint?.guest_machine_id,
    uid,
    gid,
    ...(['publish', 'publish-universal'].includes(action) && { wait_for_setup: true }),
    ...(files && { files }),
  }
  const result = await run(slotExecArgv(vm, ['python3', '-c', guestScript()], { user: '0', interactive: true }), {
    timeoutMs: 30_000,
    input: JSON.stringify(request),
  })
  if (!result?.ok) {
    const error = failure()
    const details = `${result?.error || ''}\n${result?.stderr || ''}`
    error.retryable =
      details.includes('guest ssh unavailable') ||
      (['publish', 'publish-universal'].includes(action) &&
        result?.code === 75 &&
        details.split('\n').some((line) => line.trim() === 'CRAG guest setup is not ready'))
    throw error
  }
  return true
}

async function project(projectRoot, vm, action, files, options = {}) {
  if (isCustomErofsSlot(vm, options)) {
    return projectViaAgent(projectRoot, vm, action, files, options)
  }
  const run = options.runDockerExec || runDockerExec
  return projectLegacy(vm, action, files, run)
}

function publishLocal(projectRoot, vm, options, subscriptionOnly) {
  if (!localKvm(vm)) return Promise.resolve(false)
  const run = options.runDockerExec || runDockerExec
  return exclusive(projectRoot, vm, async () => {
    if (subscriptionOnly) assertPublicationAllowed(projectRoot)
    if (!(await running(vm, run))) return false
    const readFiles = subscriptionOnly ? readCragSubscriptionFiles : readKvmCragLicense
    let files
    try {
      files = readFiles(projectRoot, vm)
      if (!files) return false
      const universal = Object.keys(files).length === 1 && files.permit?.startsWith('CRAGU1.')
      if (!universal) assertPublicationAllowed(projectRoot)
      await project(projectRoot, vm, universal ? 'publish-universal' : 'publish', files, options)
      if (!universal) assertPublicationAllowed(projectRoot)
      const current = readFiles(projectRoot, vm)
      if (JSON.stringify(current) !== JSON.stringify(files)) throw failure()
      return true
    } catch (error) {
      if (!error.retryable) {
        try {
          await project(projectRoot, vm, 'block', null, options)
        } catch {}
      }
      throw error
    }
  })
}

/** Guest grants live on tmpfs: the official native bootstrap rejects 9p license directories. */
export function publishKvmCragSubscription(projectRoot, vm, options = {}) {
  return publishLocal(projectRoot, vm, options, true)
}

/** Offline U1 and host S1 share managed mounts; only S1 depends on host mutation gates. */
export function publishLocalKvmCragLicense(projectRoot, vm, options = {}) {
  return publishLocal(projectRoot, vm, options, false)
}

/** Shares the publisher queue, so an older publish cannot clear a later revocation marker. */
export function blockKvmCragSubscription(projectRoot, vm, options = {}) {
  if (!localKvm(vm)) return Promise.resolve(false)
  const run = options.runDockerExec || runDockerExec
  return exclusive(
    projectRoot,
    vm,
    async () => (await running(vm, run)) && project(projectRoot, vm, 'block', null, options),
  )
}

/** Only an authorized kernel switch calls this; an absent permit never clears a revocation marker. */
export function clearKvmCragSubscription(projectRoot, vm, options = {}) {
  if (!localKvm(vm)) return Promise.resolve(false)
  const run = options.runDockerExec || runDockerExec
  return exclusive(
    projectRoot,
    vm,
    async () => (await running(vm, run)) && project(projectRoot, vm, 'clear', null, options),
  )
}

/** Inspect guest projection status via kin-slot-agent RPC (custom-erofs) or legacy status command. */
export async function getKvmCragSubscriptionStatus(projectRoot, vm, options = {}) {
  if (!localKvm(vm)) return null
  const run = options.runDockerExec || runDockerExec
  if (!(await running(vm, run))) return null
  if (isCustomErofsSlot(vm, options)) {
    const client = resolveAgentClient(projectRoot, vm, options)
    const rpcOpts = options.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}
    return assertAgentOk(await client.status(rpcOpts))
  }
  const machineId = vm.fingerprint?.guest_machine_id
  const result = await run(slotExecArgv(vm, kvmCragSubscriptionStatusCommand(vm, machineId, options), { user: '0' }), {
    timeoutMs: options.timeoutMs ?? 5000,
  })
  if (!result?.ok) throw failure()
  return { ok: true }
}
