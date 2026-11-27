/** Node edits preserve placement identity and verify candidates without mutating either host. */
import { inspectContainerOrNull, sshDocker } from './docker-remote.mjs'
import { shellQuote } from './remote-fs.mjs'
import { ClusterError, execCollect } from './ssh-link.mjs'
import { slotHome } from '../vm/slot-identity.mjs'

const EDIT_FIELDS = new Set([
  'label',
  'host',
  'port',
  'username',
  'auth_type',
  'password',
  'private_key',
  'passphrase',
  'expected_updated_at',
])
const has = (value, key) => Object.hasOwn(value, key)

export function nodeEditConflict() {
  return new ClusterError(409, 'node_edit_conflict', '节点配置或连接已变化，请刷新后重试')
}

/** Missing secrets retain their saved value. A new key does not inherit the old key's passphrase. */
export function validateNodeEditPatch(node, patch) {
  if (
    !patch ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    Object.keys(patch).some((key) => !EDIT_FIELDS.has(key))
  ) {
    throw new ClusterError(400, 'invalid_node_patch', '节点更新包含不支持的字段')
  }
  if (typeof patch.expected_updated_at !== 'string' || !patch.expected_updated_at) {
    throw new ClusterError(400, 'invalid_node_patch', '缺少节点配置版本，请刷新后重试')
  }
  if (patch.expected_updated_at !== node.updated_at) throw nodeEditConflict()
  for (const key of EDIT_FIELDS) {
    if (has(patch, key) && key !== 'port' && typeof patch[key] !== 'string') {
      throw new ClusterError(400, 'invalid_node_patch', '节点更新字段类型不合法')
    }
  }
  if (has(patch, 'port') && typeof patch.port !== 'number' && typeof patch.port !== 'string') {
    throw new ClusterError(400, 'invalid_port', '端口不合法')
  }
}

export function mergeNodeEdit(node, secrets, patch) {
  validateNodeEditPatch(node, patch)
  const before = {
    ...node,
    password: secrets.password,
    private_key: secrets.privateKey,
    passphrase: secrets.passphrase,
  }
  const next = { ...before, ...patch }
  if (!['password', 'key'].includes(next.auth_type)) {
    throw new ClusterError(400, 'invalid_auth_type', '认证方式不合法')
  }
  if (next.auth_type === 'password') {
    if (has(patch, 'private_key') || has(patch, 'passphrase')) {
      throw new ClusterError(400, 'invalid_node_patch', '密码认证不能提交私钥字段')
    }
    if (node.auth_type !== 'password' && !patch.password) {
      throw new ClusterError(400, 'missing_password', '切换认证方式时请填写新密码')
    }
    next.private_key = null
    next.passphrase = null
  } else {
    if (has(patch, 'password')) throw new ClusterError(400, 'invalid_node_patch', '私钥认证不能提交密码字段')
    if (node.auth_type !== 'key' && !patch.private_key?.trim()) {
      throw new ClusterError(400, 'missing_private_key', '切换认证方式时请粘贴新私钥')
    }
    if (has(patch, 'private_key') && patch.private_key.trim() !== before.private_key && !has(patch, 'passphrase')) {
      next.passphrase = null
    }
    next.password = null
  }
  return next
}

/** `uname -s` → stored platform. Anything that is not macOS keeps the Linux (Docker) runtime. */
export function nodePlatformOf(kernel) {
  return String(kernel || '').trim() === 'Darwin' ? 'darwin' : 'linux'
}

/** Read only: unlike health/placement initialization this never creates directories or changes network policy. */
export async function readNodeHost(client) {
  const script =
    'id -u; id -g; printf "%s\\n" "$HOME"; if sudo -n true 2>/dev/null; then echo sudo; else echo nosudo; fi; uname -s'
  const r = await execCollect(client, `sh -c ${shellQuote(script)}`, { timeoutMs: 15_000 })
  const [uid, gid, home, sudo, kernel] = r.stdout.split('\n').map((s) => s.trim())
  if (r.code !== 0 || !/^\d+$/.test(uid) || !/^\d+$/.test(gid) || !home.startsWith('/')) {
    throw new ClusterError(502, 'remote_host_unknown', '读取节点用户信息失败')
  }
  return {
    uid: Number(uid),
    gid: Number(gid),
    home,
    root: `${home.replace(/\/+$/, '')}/.vm2api`,
    sudo: sudo === 'sudo',
    platform: nodePlatformOf(kernel),
  }
}

function runtimeMismatch() {
  return new ClusterError(409, 'node_runtime_mismatch', '新连接无法确认现有虚拟机的用户、目录和容器，请保留原配置')
}

function mountMatches(info, source, destination) {
  if (Array.isArray(info.Mounts))
    return info.Mounts.some((m) => m.Type === 'bind' && m.Source === source && m.Destination === destination)
  return (info.HostConfig?.Binds || []).some(
    (bind) => bind === `${source}:${destination}` || bind.startsWith(`${source}:${destination}:`),
  )
}

/** Existing containers and their bind roots must still belong to this node, including stopped slots. */
export async function verifyNodeRuntimes(client, host, vms, previousHost) {
  if (previousHost && ['root', 'uid', 'gid', 'platform'].some((key) => host[key] !== previousHost[key]))
    throw runtimeMismatch()
  for (const vm of vms) {
    const runtime = vm.runtime || {}
    const container = runtime.container_id || runtime.container
    if (host.platform === 'darwin') {
      // launchd services carry no labels or mounts; the slot tree under the same root is the runtime.
      if (!runtime.remote_dir) continue
      if (runtime.remote_dir !== `${host.root}/vms/${vm.id}`) throw runtimeMismatch()
      const check = await execCollect(
        client,
        `test -d ${shellQuote(`${runtime.remote_dir}/run`)} && test -d ${shellQuote(`${runtime.remote_dir}/cli-home`)}`,
        { timeoutMs: 10_000 },
      )
      if (check.code !== 0) throw runtimeMismatch()
      continue
    }
    // A never-started empty slot has no node-side runtime to move or verify.
    if (!container) continue
    const info = await inspectContainerOrNull(sshDocker(client), container)
    if (
      !info ||
      (runtime.container_id && info.Id !== runtime.container_id) ||
      info.Config?.Labels?.['kin.vm.id'] !== vm.id ||
      info.Config?.Labels?.['vm2api.cluster'] !== '1'
    )
      throw runtimeMismatch()
    if (host.uid !== 0 && runtime.user !== `${host.uid}:${host.gid}`) throw runtimeMismatch()
    const kvm = (runtime.type || vm.runtime_type) === 'kvm'
    const dir = `${host.root}/vms/${vm.id}`
    if (
      !mountMatches(info, `${dir}/run`, kvm ? '/slot/run' : '/run/kin') ||
      !mountMatches(info, `${dir}/cli-home`, kvm ? '/slot/home' : slotHome(vm))
    )
      throw runtimeMismatch()
    const check = await execCollect(
      client,
      `test -d ${shellQuote(`${dir}/run`)} && test -d ${shellQuote(`${dir}/cli-home`)}`,
      { timeoutMs: 10_000 },
    )
    if (check.code !== 0) throw runtimeMismatch()
  }
}

/** Detect placement changes while a candidate connection is being checked. */
export function nodePlacementVersion(vms) {
  return JSON.stringify(
    vms
      .map((vm) => ({ id: vm.id, runtime: vm.runtime || null, runtime_type: vm.runtime_type || null }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  )
}
