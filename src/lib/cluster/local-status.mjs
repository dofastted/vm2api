/**
 * The control plane's own link status for the cluster page's local board.
 *
 * NAT is judged from the outside: a directly connected node reports the source
 * address it sees for our SSH session (`$SSH_CLIENT`); if that address is not
 * on any local interface, the control plane sits behind NAT. The same node then
 * dials back to that address on the panel port to tell whether the panel is
 * reachable from the internet. No third-party IP service is involved.
 */

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { dockerInfo, dockerJson, localDocker } from './docker-remote.mjs'
import { execCollect } from './ssh-link.mjs'
import { readRoutingConfigFile } from '../core/config.mjs'
import { probeLocalKvm } from '../vm/kvm-host.mjs'

/** `$SSH_CLIENT` = "<client ip> <client port> <server port>". */
export function parseSshClient(raw) {
  const ip =
    String(raw || '')
      .trim()
      .split(/\s+/)[0] || ''
  return net.isIP(ip) ? ip : null
}

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) compares as the embedded IPv4. */
function canonicalIp(ip) {
  const s = String(ip || '').toLowerCase()
  return s.startsWith('::ffff:') && net.isIPv4(s.slice(7)) ? s.slice(7) : s
}

export function localAddresses(interfaces = os.networkInterfaces()) {
  const out = []
  for (const list of Object.values(interfaces)) {
    for (const addr of list || []) {
      if (!addr.internal) out.push(canonicalIp(addr.address))
    }
  }
  return [...new Set(out)]
}

/** true = behind NAT, false = public address is local, null = not observed. */
export function behindNat(publicIp, addresses) {
  if (!publicIp) return null
  return !addresses.includes(canonicalIp(publicIp))
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

async function controlPlane({ listen, containerName, docker }) {
  const inContainer = fs.existsSync('/.dockerenv')
  const out = {
    mode: inContainer ? 'container' : 'process',
    container: inContainer ? containerName || os.hostname() : null,
    network_mode: inContainer ? null : 'host',
    listen_host: listen.host,
    listen_port: listen.port,
    loopback_only: LOOPBACK.has(String(listen.host)),
  }
  if (!inContainer) return out
  try {
    const inspect = await dockerJson(docker, { path: `/containers/${encodeURIComponent(out.container)}/json` })
    out.network_mode = inspect?.HostConfig?.NetworkMode || null
  } catch {
    out.network_mode = null
  }
  return out
}

async function localDockerStatus(docker) {
  try {
    const info = await dockerInfo(docker)
    return {
      ok: true,
      version: info.version,
      running: info.running,
      containers: info.containers,
      slots: (
        await dockerJson(docker, {
          path: `/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: ['kin.vm=1'] }))}`,
        })
      ).length,
      error: null,
    }
  } catch (err) {
    return { ok: false, version: null, running: null, containers: null, slots: null, error: err.message }
  }
}

/**
 * @param {{ node: { id: string, label: string }, client: import('ssh2').Client } | null} observer
 */
async function natStatus({ observer, control, addresses }) {
  const base = { public_ip: null, observed_via: null, local_ips: addresses, behind_nat: null, inbound: null }
  if (!observer) return { ...base, note: '需要一个直连且已连接的节点来观测公网地址' }
  const seen = await execCollect(observer.client, 'printf %s "$SSH_CLIENT"', { timeoutMs: 10_000 }).catch(() => null)
  const publicIp = parseSshClient(seen?.stdout)
  const via = { id: observer.node.id, label: observer.node.label }
  if (!publicIp) return { ...base, observed_via: via, note: '远端没有返回 SSH_CLIENT' }
  const out = { ...base, public_ip: publicIp, observed_via: via, behind_nat: behindNat(publicIp, addresses) }
  if (control.loopback_only) return { ...out, inbound: 'loopback', note: `面板只监听 ${control.listen_host}` }
  const port = Number(control.listen_port)
  const target = net.isIPv6(publicIp) ? `[${publicIp}]` : publicIp
  // bash /dev/tcp avoids depending on nc/curl on the VPS; exit 124 = timeout.
  const probe = await execCollect(
    observer.client,
    `timeout 4 bash -c 'exec 3<>/dev/tcp/${publicIp}/${port}' 2>/dev/null && echo open || echo closed`,
    { timeoutMs: 10_000 },
  ).catch(() => null)
  const verdict = probe?.stdout.trim()
  return {
    ...out,
    inbound: verdict === 'open' || verdict === 'closed' ? verdict : null,
    note: verdict ? `${via.label} 回连 ${target}:${port}` : '回连探测失败',
  }
}

export async function collectLocalStatus({ listen, containerName, observer, docker = localDocker(), routing } = {}) {
  const addresses = localAddresses()
  let probeRouting = routing
  if (!probeRouting) {
    try {
      probeRouting = readRoutingConfigFile()
    } catch {
      probeRouting = null
    }
  }
  const [control, dockerStatus, kvm] = await Promise.all([
    controlPlane({ listen, containerName, docker }),
    localDockerStatus(docker),
    probeLocalKvm({ routing: probeRouting }),
  ])
  const nat = await natStatus({ observer, control, addresses })
  return { checked_at: new Date().toISOString(), control, nat, docker: dockerStatus, kvm }
}
