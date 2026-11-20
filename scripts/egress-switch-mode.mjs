/**
 * Move one VM between per-VM and shared egress, one at a time.
 *
 *   node scripts/egress-switch-mode.mjs status
 *   node scripts/egress-switch-mode.mjs plan --vm=vm-01
 *   node scripts/egress-switch-mode.mjs to-shared --vm=vm-01            # dry
 *   node scripts/egress-switch-mode.mjs to-shared --vm=vm-01 --apply
 *   node scripts/egress-switch-mode.mjs to-per-vm --vm=vm-01 --apply    # rollback
 *
 *   --root=PATH   install directory (default /opt/kin-gateway)
 *   --json        machine-readable output
 *
 * This writes the mode onto the VM record and nothing else. The container is
 * rebuilt by the ordinary start path, which already recreates a slot whose
 * NetworkMode no longer matches `slotNetworkForVm` — there is deliberately no
 * second rebuild implementation here, since one that drifted from the real one
 * would move a VM onto a network the control plane does not expect.
 *
 * `shared_ip` is left for the boot path to allocate under the node lock: it
 * reserves the address against the slots starting beside it, which a script
 * writing the record from outside cannot do.
 *
 * Exit code is non-zero when the switch refused or failed, so a deploy or
 * rollout script can branch on it.
 */
import path from 'node:path'
import { ProxyPool } from '../src/lib/vm/proxy-pool.mjs'
import { getVm, listVms, patchVmRecord } from '../src/lib/vm/vm-registry.mjs'
import { boundProxyUrl, inspectSharedEgressNetwork, sharedEndpointIps } from '../src/lib/vm/egress.mjs'
import {
  isSharedModeVm,
  networkModeOf,
  sharedCapacity,
  sharedNetworkName,
  sharedNodeIdForVm,
} from '../src/lib/vm/shared-egress.mjs'

const argv = process.argv.slice(2)
const action = argv.find((a) => !a.startsWith('-')) || 'status'
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

const projectRoot = value('root') || '/opt/kin-gateway'
const dataDir = path.join(projectRoot, 'data')
const vmId = value('vm') || ''
const apply = flag('apply')
const asJson = flag('json')

function out(result) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    const { lines, ...rest } = result
    console.log(JSON.stringify(rest, null, 2))
    for (const line of lines || []) console.log(line)
  }
  process.exit(result.ok === false ? 1 : 0)
}

function openPool() {
  try {
    return new ProxyPool({ dataDir })
  } catch {
    return null
  }
}

/** Every VM on this install, with the mode it currently carries. */
function fleet() {
  const pool = openPool()
  return listVms(projectRoot).map((summary) => {
    const vm = getVm(projectRoot, summary.id) || summary
    const proxy = pool?.getProxyForVm(vm.id) || vm.proxy || null
    return {
      id: vm.id,
      node_id: sharedNodeIdForVm(vm),
      mode: networkModeOf(vm),
      proxy_id: proxy?.id || null,
      proxy_url: proxy ? boundProxyUrl(proxy) : '',
      shared_ip: vm.runtime?.shared_ip || null,
      container: vm.runtime?.container || null,
      network: vm.runtime?.network_mode || null,
    }
  })
}

if (action === 'status') {
  const vms = fleet()
  const byNode = {}
  for (const vm of vms) {
    const node = byNode[vm.node_id] || (byNode[vm.node_id] = { shared: 0, perVm: 0, vms: [] })
    node[vm.mode === 'shared' ? 'shared' : 'perVm'] += 1
    node.vms.push(`${vm.id}:${vm.mode}`)
  }
  const nodes = {}
  for (const nodeId of Object.keys(byNode)) {
    const net = inspectSharedEgressNetwork(nodeId)
    const live = net?.subnet ? sharedEndpointIps(nodeId) : { ok: false, items: [] }
    nodes[nodeId || '(control plane)'] = {
      ...byNode[nodeId],
      shared_network: net?.subnet ? { name: net.name, subnet: net.subnet, bridge: net.bridge } : null,
      // Unreadable is reported as such: an empty list would read as "room for
      // everyone" on a network that may be full.
      capacity: net?.subnet && live.ok ? sharedCapacity(net.subnet, live.items) : null,
    }
  }
  out({ ok: true, total: vms.length, nodes })
}

if (!vmId) out({ ok: false, error: 'a --vm=ID is required', action })

const vm = getVm(projectRoot, vmId)
if (!vm) out({ ok: false, error: `no VM record for ${vmId}`, action })

const nodeId = sharedNodeIdForVm(vm)
const pool = openPool()
const proxy = pool?.getProxyForVm(vm.id) || vm.proxy || null
const proxyUrl = proxy ? boundProxyUrl(proxy) : ''
const current = networkModeOf(vm)

/** What the switch would do, and what would stop it. */
function assess(target) {
  const blockers = []
  const notes = []
  if (current === target) notes.push(`already ${target}; nothing to change`)

  if (target === 'shared') {
    // The helper refuses a source it has no route for, so a VM with no usable
    // upstream would come up on the shared bridge with no way out.
    if (!proxyUrl) blockers.push('no bound SOCKS5 upstream; the helper would refuse this VM')
    const net = inspectSharedEgressNetwork(nodeId)
    if (net?.subnet) {
      const live = sharedEndpointIps(nodeId)
      if (!live.ok) {
        blockers.push(`shared network ${net.name} is unreadable; cannot tell whether it has room`)
      } else {
        const cap = sharedCapacity(net.subnet, live.items)
        notes.push(`shared network ${net.subnet} holds ${cap.used} of ${cap.total}`)
        if (cap.free <= 0) blockers.push(`shared network ${net.subnet} is full`)
      }
    } else {
      notes.push(`shared network ${sharedNetworkName(nodeId)} will be created on first start`)
    }
  }

  if (target === 'per-vm' && isSharedModeVm(vm)) {
    notes.push('the shared address is dropped; this VM gets its own bridge again on restart')
  }

  // Either direction changes slotNetworkForVm, so the start path recreates the
  // container: the session on this slot is interrupted.
  notes.push('the slot container is recreated on next start, interrupting this VM')
  return { blockers, notes }
}

if (action === 'plan') {
  const target = current === 'shared' ? 'per-vm' : 'shared'
  const { blockers, notes } = assess(target)
  out({
    ok: blockers.length === 0,
    action: 'plan',
    vm: vm.id,
    node_id: nodeId,
    from: current,
    to: target,
    proxy_id: proxy?.id || null,
    blockers,
    lines: notes,
  })
}

if (action !== 'to-shared' && action !== 'to-per-vm') {
  out({ ok: false, error: `unknown action ${action}`, usage: 'status | plan | to-shared | to-per-vm' })
}

const target = action === 'to-shared' ? 'shared' : 'per-vm'
const { blockers, notes } = assess(target)
if (blockers.length) out({ ok: false, action, vm: vm.id, from: current, to: target, blockers })

if (!apply) {
  out({
    ok: true,
    action,
    vm: vm.id,
    from: current,
    to: target,
    applied: false,
    lines: [...notes, 'dry run; pass --apply to write it'],
  })
}

// Only these two fields. runtimePatch carries them across refreshes, and the
// boot path allocates shared_ip under the node lock.
const patched = patchVmRecord(projectRoot, vm.id, (record) => {
  const runtime = { ...(record.runtime || {}) }
  if (target === 'shared') {
    runtime.egress_mode = 'shared'
  } else {
    runtime.egress_mode = 'per-vm'
    // Dropped so a VM switched back does not keep an address on a bridge it
    // has left, which would make it look like a member to the next prune.
    delete runtime.shared_ip
  }
  return { runtime }
})

if (!patched) out({ ok: false, action, vm: vm.id, error: 'vm record disappeared while patching' })

out({
  ok: true,
  action,
  vm: vm.id,
  node_id: nodeId,
  from: current,
  to: networkModeOf(patched),
  shared_ip: patched.runtime?.shared_ip || null,
  applied: true,
  lines: [
    ...notes,
    `recorded egress_mode=${target}`,
    'restart this VM to move it: the start path recreates the slot and routes it',
  ],
})
