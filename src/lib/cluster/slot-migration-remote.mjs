/** Remote-only KVM migration primitives. No disk/account data is staged on the controller. */
import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { containerName } from '../vm/vm-runtime.mjs'
import { slotMemory } from '../vm/machine-spec.mjs'
import { boundProxyUrl, isLocalEgressProxy } from '../vm/egress.mjs'
import { listVms } from '../vm/vm-registry.mjs'
import {
  clusterManager,
  nodePlatform,
  nodeSession,
  parseMemoryBytes,
  remoteSlotDir,
  preflightNode,
} from './placement.mjs'
import {
  dockerJson,
  inspectContainerOrNull,
  inspectNetworkOrNull,
  renameContainer,
  removeContainer,
  containerAction,
} from './docker-remote.mjs'
import { releaseRemoteEgress, slotEgressNames } from './remote-slot.mjs'
import { runRemote, shellQuote as q } from './remote-fs.mjs'
import { slotImageSpec } from './slot-image.mjs'
import { ClusterError } from './ssh-link.mjs'

const helper = fs.readFileSync(new URL('./slot-transfer.py', import.meta.url), 'utf8')
const RESERVE = 1024 ** 3
const OVERHEAD = 512 * 1024 ** 2
const command = (action, ...args) =>
  `timeout -k 5s ${['send', 'receive'].includes(action) ? 1800 : 15}s nice -n 19 python3 -u -c ${q(helper)} ${[action, ...args].map(q).join(' ')}`

export function migrationError(code, message, status = 409) {
  return new ClusterError(status, code, message)
}

/** Keep node-local/direct/loopback exits explicit: migrating must not silently change the exit. */
export function assertMigrationProxy(vm) {
  if (isLocalEgressProxy(vm.proxy))
    throw migrationError('migration_node_local_proxy', '此槽使用节点直连出口，请先绑定跨节点可用的 SOCKS 出口')
  let url
  try {
    url = new URL(boundProxyUrl(vm.proxy))
  } catch {
    throw migrationError('migration_proxy_required', '请先绑定跨节点可用的 SOCKS 出口')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host)
  )
    throw migrationError('migration_node_local_proxy', '回环 SOCKS 地址属于原节点，不能直接迁移')
}

export function assertMigrationCapacity({ total, available, reserved, current, requested }) {
  if (![total, available, reserved, current, requested].every(Number.isFinite) || total <= 0 || available <= 0)
    throw migrationError('migration_capacity_unknown', '无法确认目标节点内存余量')
  if (reserved + requested + RESERVE > total || requested - current + RESERVE > available)
    throw migrationError('migration_memory_full', '目标节点内存不足（包含 KVM 开销和 1GiB 系统预留）')
}

export async function preflightMigration({ projectRoot, vm, targetNodeId, memory, routing, jobId }) {
  const source = await nodeSession(vm.node_id)
  const target = await nodeSession(targetNodeId)
  if (nodePlatform(vm.node_id) !== 'linux' || nodePlatform(targetNodeId) !== 'linux')
    throw migrationError('migration_unsupported', '仅支持远程 Linux KVM 节点')
  if (source.host.uid !== target.host.uid || source.host.gid !== target.host.gid)
    throw migrationError('migration_owner_mismatch', '两端 SSH 用户 UID/GID 必须一致')
  const sameNode = vm.node_id === targetNodeId
  if (!sameNode) assertMigrationProxy(vm)
  const check = await preflightNode(targetNodeId, { kernel: vm.kernel || 'ubuntu-24.04', runtime: 'kvm' })
  if (!check.ok) throw migrationError('migration_preflight_failed', '目标节点预检未通过，请检查节点镜像和 KVM')
  const egressCheck = await preflightNode(targetNodeId, { kernel: vm.kernel || 'ubuntu-24.04', runtime: 'docker' })
  if (!egressCheck.ok) throw migrationError('migration_preflight_failed', '目标节点的出口镜像尚未就绪，请先构建')
  const name = containerName(vm.id)
  const sourceInfo = await inspectContainerOrNull(source.docker, name)
  if (!sourceInfo) throw migrationError('migration_source_missing', '原节点槽容器不存在')
  if (
    !sourceInfo.State?.Running ||
    sourceInfo.Config?.Labels?.['kin.vm.id'] !== vm.id ||
    sourceInfo.Config?.Labels?.['kin.vm.runtime'] !== 'kvm'
  )
    throw migrationError('migration_source_not_ready', '原节点必须是此槽的运行中 KVM 容器')
  const expected = slotImageSpec(projectRoot, vm.kernel || 'ubuntu-24.04', { runtime: 'kvm' })
  const image = await dockerJson(target.docker, {
    path: `/images/${encodeURIComponent(expected.ref)}/json`,
    timeoutMs: 15_000,
  })
  // Docker image IDs cover config + layer digests. A new KVM base can reset a qcow overlay at boot.
  if (!image.Id || image.Id !== sourceInfo.Image)
    throw migrationError('migration_image_mismatch', '两端槽镜像必须完全一致，禁止用不同基础盘启动原 qcow2')
  const from = remoteSlotDir(source.host, vm.id)
  const to = remoteSlotDir(target.host, vm.id)
  const stage = `${target.host.root}/vms/.migration-${vm.id}-${jobId}`
  const info = JSON.parse(await runRemote(source.client, command('probe', from), { timeoutMs: 20_000 }))
  const facts = await runRemote(
    target.client,
    [
      'command -v python3 >/dev/null && command -v timeout >/dev/null && command -v nice >/dev/null',
      `awk '/^MemTotal:|^MemAvailable:/{print $2 * 1024}' /proc/meminfo`,
      `df -Pk ${q(target.host.root)} | awk 'NR==2{print $4 * 1024}'`,
    ].join(' && '),
    { timeoutMs: 15_000 },
  )
  const [total, available, free] = facts.trim().split(/\s+/).map(Number)
  const requested = parseMemoryBytes(memory) + OVERHEAD
  const reserved = listVms(projectRoot, routing)
    .filter((v) => v.node_id === targetNodeId && v.id !== vm.id)
    .reduce((sum, v) => sum + parseMemoryBytes(slotMemory(v, routing)) + (v.runtime_type === 'kvm' ? OVERHEAD : 0), 0)
  assertMigrationCapacity({
    total,
    available,
    reserved,
    requested,
    current: sameNode ? parseMemoryBytes(slotMemory(vm, routing)) + OVERHEAD : 0,
  })
  if (!sameNode) {
    if (!Number.isFinite(info.allocated_bytes) || free < info.allocated_bytes * 1.1 + RESERVE)
      throw migrationError('migration_disk_full', '目标节点磁盘余量不足（按稀疏盘实际占用计算）')
    const names = slotEgressNames(vm.id)
    if (
      (await inspectNetworkOrNull(target.docker, names.network)) ||
      (await inspectContainerOrNull(target.docker, names.egress))
    )
      throw migrationError('migration_target_exists', '目标节点已存在此槽的出口资源，请先核对')
    if (await inspectContainerOrNull(target.docker, name))
      throw migrationError('migration_target_exists', '目标节点已存在同名容器')
    await runRemote(target.client, `test ! -e ${q(to)} && test ! -L ${q(to)} && test ! -e ${q(stage)}`, {
      timeoutMs: 10_000,
    })
  }
  return {
    vmId: vm.id,
    source,
    target,
    sourceInfo,
    from,
    to,
    stage,
    name,
    sameNode,
    jobId,
    backupName: `${name}-migration-${jobId}`,
    backupDir: `${source.host.root}/migration-backups/${vm.id}-${jobId}`,
    summary: {
      source_node_id: vm.node_id,
      target_node_id: targetNodeId,
      memory,
      allocated_bytes: info.allocated_bytes,
      available_memory: available,
      disk_free: free,
      same_node: sameNode,
    },
  }
}

function execStream(client, cmd) {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let stderr = ''
      stream.stderr.on('data', (data) => {
        stderr = (stderr + data.toString()).slice(-1000)
      })
      // Install completion listeners before any bytes can arrive.
      const done = new Promise((ok, fail) => {
        stream.on('error', fail)
        stream.on('close', (code) =>
          code === 0 ? ok() : fail(migrationError('migration_transfer_failed', stderr || '远程传输中断')),
        )
      })
      done.catch(() => {})
      resolve({ stream, done })
    })
  })
}

export async function copyMigrationTree(plan) {
  let sender, receiver
  try {
    receiver = await execStream(plan.target.client, command('receive', plan.stage, plan.jobId))
    // Receipt is tiny; consume stdout immediately so neither SSH direction blocks.
    let receipt = ''
    receiver.stream.on('data', (data) => {
      receipt = (receipt + data.toString()).slice(-4096)
    })
    sender = await execStream(plan.source.client, command('send', plan.from))
    await Promise.all([pipeline(sender.stream, receiver.stream), sender.done, receiver.done])
    return JSON.parse(receipt)
  } finally {
    for (const process of [sender, receiver]) {
      if (!process || process.stream.closed) continue
      try {
        process.stream.signal('TERM')
      } catch {}
      process.stream.close()
    }
    await Promise.allSettled([sender?.done, receiver?.done])
  }
}

export async function preserveMigrationContainer(plan) {
  const current = await inspectContainerOrNull(plan.source.docker, plan.name)
  if (current?.Id !== plan.sourceInfo.Id || current.State?.Running)
    throw migrationError('migration_source_changed', '原槽容器已变化或未确认停止，保持维护暂停')
  await dockerJson(plan.source.docker, {
    method: 'POST',
    path: `/containers/${plan.sourceInfo.Id}/update`,
    body: { RestartPolicy: { Name: 'no' } },
    timeoutMs: 15_000,
  })
  await renameContainer(plan.source.docker, plan.sourceInfo.Id, plan.backupName)
}

export async function publishMigrationTree(plan) {
  if (!plan.sameNode)
    await runRemote(plan.target.client, command('publish', plan.stage, plan.to, plan.jobId), { timeoutMs: 20_000 })
  await clusterManager().dropSlotRelays(plan.vmId)
}

export async function rollbackMigrationRuntime(plan) {
  // Never start the original until the replacement is conclusively gone.
  const replacement = await inspectContainerOrNull(plan.target.docker, plan.name)
  if (replacement) {
    if (replacement.Id !== plan.sourceInfo.Id) {
      await containerAction(plan.target.docker, replacement.Id, 'stop', { t: 30 })
      await removeContainer(plan.target.docker, replacement.Id)
    }
  }
  if (!plan.sameNode) {
    const network = slotEgressNames(plan.vmId).network
    const info = await inspectNetworkOrNull(plan.target.docker, network)
    if (info && info.Labels?.['kin.egress.vm'] !== plan.vmId)
      throw migrationError('migration_cleanup_owner', '目标出口资源归属不符，保持暂停')
    if (info) {
      const released = await releaseRemoteEgress(plan.target, network)
      if (!released.released) throw migrationError('migration_cleanup_busy', '目标出口仍在使用，保持暂停')
    }
    for (const dir of [plan.stage, plan.to])
      await runRemote(plan.target.client, command('remove', dir, plan.jobId), { timeoutMs: 20_000 })
  }
  await clusterManager().dropSlotRelays(plan.vmId)
  const original = await inspectContainerOrNull(plan.source.docker, plan.sourceInfo.Id)
  if (!original) throw migrationError('migration_rollback_missing', '原容器不可用，已保持调度暂停')
  if (original.State?.Running) await containerAction(plan.source.docker, original.Id, 'stop', { t: 30 })
  if (original.Name?.replace(/^\//, '') !== plan.name) await renameContainer(plan.source.docker, original.Id, plan.name)
  await dockerJson(plan.source.docker, {
    method: 'POST',
    path: `/containers/${original.Id}/update`,
    body: { RestartPolicy: plan.sourceInfo.HostConfig.RestartPolicy },
    timeoutMs: 15_000,
  })
}

export async function finishMigration(plan) {
  await removeContainer(plan.source.docker, plan.sourceInfo.Id)
  if (!plan.sameNode) {
    await releaseRemoteEgress(plan.source, plan.sourceInfo.HostConfig?.NetworkMode)
    await runRemote(
      plan.source.client,
      `umask 077; mkdir -p ${q(`${plan.source.host.root}/migration-backups`)} && test ! -e ${q(plan.backupDir)} && mv -T ${q(plan.from)} ${q(plan.backupDir)}`,
      { timeoutMs: 20_000 },
    )
    await runRemote(plan.target.client, command('unmark', plan.to, plan.jobId), { timeoutMs: 10_000 })
  }
}
