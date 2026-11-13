/**
 * Keep a node slot's `claudeAiOauth.subscriptionType` on the plan the official
 * profile reports.
 *
 * On a cluster node the slot's own credentials.json is authoritative: the
 * control plane only mirrors it back after each refresh. A credential imported
 * before the profile was known keeps the import default `pro`, `kin-worker`
 * preserves the field on every rotation, and every pull overwrites the local
 * correction with it again. The fix has to land in the slot's file.
 *
 * The edit runs where `kin-worker oauth refresh` runs (inside the KVM guest, or
 * the container), as the same user, under the same flock(2) on
 * credentials.json.lock. A host-side lock would not exclude a guest writer:
 * QEMU's 9p server does not forward locks. Only `subscriptionType` changes; the
 * generation advances like a worker save so the next pull mirrors the file.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ensureSlotSubscriptionType, slotWorkerCredentialPath } from './oauth-credentials.mjs'
import { slotExecArgv } from '../vm/slot-exec.mjs'

export const SLOT_CREDENTIALS = '/home/kincli/.claude/credentials.json'

/** argv: credentials path, wanted plan. Prints one JSON line. */
export const PLAN_SYNC_SCRIPT = `
import fcntl, json, os, sys, time
path, want = sys.argv[1], sys.argv[2]
def out(**kw):
    print(json.dumps(kw))
lock = os.open(path + '.lock', os.O_RDWR | os.O_CREAT, 0o600)
try:
    deadline = time.monotonic() + 10
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() > deadline:
                out(ok=False, reason='locked')
                sys.exit(0)
            time.sleep(0.05)
    with open(path, 'rb') as f:
        doc = json.loads(f.read())
    oauth = doc.get('claudeAiOauth') if isinstance(doc, dict) else None
    if not isinstance(oauth, dict) or not oauth.get('accessToken'):
        out(ok=False, reason='no_oauth')
        sys.exit(0)
    current = oauth.get('subscriptionType')
    if current == want:
        out(ok=True, changed=False, subscription_type=current)
        sys.exit(0)
    def gen(value):
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            return 0
    generation = max(gen(oauth.get('kinGeneration')), gen(doc.get('kinGeneration'))) + 1
    generation = max(generation, int(time.time() * 1000))
    oauth['subscriptionType'] = want
    oauth['kinGeneration'] = generation
    doc['kinGeneration'] = generation
    st = os.stat(path)
    tmp = os.path.join(os.path.dirname(path), '.kin-plan-%d.tmp' % os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, st.st_mode & 0o777)
    try:
        try:
            os.write(fd, (json.dumps(doc, indent=2) + '\\n').encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rename(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    out(ok=True, changed=True, previous=current, subscription_type=want, generation=generation)
finally:
    os.close(lock)
`

/** The plan the official profile verified for this slot, or null. */
export function authoritativePlan(vm) {
  const source = vm?.claude?.account_tier ? vm.claude : vm
  const tier = String(source?.account_tier || '').toLowerCase()
  return source?.account_tier_source === 'profile' && (tier === 'pro' || tier === 'max') ? tier : null
}

/** `subscriptionType` in the control plane's copy of the slot credential. */
export function mirroredSubscriptionType(slotDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(slotWorkerCredentialPath(path.join(slotDir, 'cli-home')), 'utf8'))
    return doc?.claudeAiOauth?.subscriptionType ?? null
  } catch {
    return null
  }
}

/** The plan to write into the slot, or null when nothing is known or nothing differs. */
export function planToSync(vm, slotDir) {
  const plan = authoritativePlan(vm)
  if (!plan) return null
  const present = mirroredSubscriptionType(slotDir)
  return present && present !== plan ? plan : null
}

function runDockerCli(argv, { env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.env.KIN_DOCKER_BIN || 'docker', argv, { stdio: ['ignore', 'pipe', 'pipe'], env })
    const out = []
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (chunk) => {
      if (out.reduce((n, b) => n + b.length, 0) < 65536) out.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      err = (err + chunk).slice(-300)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout: '', stderr: String(error?.message || error) })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: err })
    })
  })
}

/** Rewrite `subscriptionType` in the slot's own credential. Never touches tokens. */
export async function syncSlotSubscriptionType(vm, host, plan, { runDocker = runDockerCli, timeoutMs = 20_000 } = {}) {
  if (plan !== 'pro' && plan !== 'max') return { ok: false, reason: 'invalid_plan' }
  if (!host || host.native || typeof host.dockerEnv !== 'function') return { ok: false, reason: 'unsupported_host' }
  const argv = slotExecArgv(vm, ['python3', '-I', '-c', PLAN_SYNC_SCRIPT, SLOT_CREDENTIALS, plan], {
    user: host.execUser(vm),
  })
  const result = await runDocker(argv, { env: host.dockerEnv(), timeoutMs })
  const line = String(result?.stdout || '')
    .trim()
    .split('\n')
    .at(-1)
  try {
    const value = JSON.parse(line)
    if (value && typeof value === 'object') return value
  } catch {}
  return {
    ok: false,
    reason: 'exec_failed',
    code: result?.code ?? null,
    error: String(result?.stderr || '').slice(-200),
  }
}

const running = new Map()

/**
 * Fire-and-forget, one at a time per slot. On success the local mirror follows
 * at once instead of waiting for the next pull.
 */
export function queueSlotPlanSync(
  vm,
  slotDir,
  host,
  { plan = planToSync(vm, slotDir), logger = console, sync = syncSlotSubscriptionType } = {},
) {
  if (!plan || !vm?.id || !host || host.native) return null
  if (running.has(vm.id)) return running.get(vm.id)
  const job = (async () => {
    let result
    try {
      result = await sync(vm, host, plan)
    } catch (error) {
      result = { ok: false, reason: 'error', error: String(error?.message || error).slice(0, 200) }
    }
    if (result?.ok) {
      try {
        ensureSlotSubscriptionType(path.join(slotDir, 'cli-home'), plan, { source: 'profile' })
      } catch {}
    }
    logger.warn(
      JSON.stringify({
        event: 'slot_plan_sync',
        vm_id: vm.id,
        plan,
        ok: !!result?.ok,
        changed: !!result?.changed,
        previous: result?.previous ?? null,
        reason: result?.reason || null,
      }),
    )
    return result
  })().finally(() => running.delete(vm.id))
  running.set(vm.id, job)
  return job
}
