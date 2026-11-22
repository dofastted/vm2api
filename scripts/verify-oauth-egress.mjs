#!/usr/bin/env node
/**
 * Verify that every VM's OAuth exchange would leave through the proxy that VM is
 * bound to, and that the proxy can actually reach the OAuth hosts.
 *
 *   node scripts/verify-oauth-egress.mjs [--vm vm-10] [--timeout 15000] [--json]
 *
 * What it checks per VM:
 *   1. resolveSlotOAuthProxy() returns the bound exit (or refuses when unbound).
 *   2. The exit equals the VM record's proxy and the pool's current binding — a
 *      stale record must not send OAuth through a proxy now bound elsewhere.
 *   3. SOCKS5 handshake (with credentials) + TLS(SNI) + one HTTP HEAD to
 *      claude.ai and platform.claude.com, so reachability is proven end to end.
 *
 * It never exchanges a code or touches credentials; only the exit is exercised.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { resolveSlotOAuthProxy } from '../src/lib/vm/proxy-resolve.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null)
const onlyVm = flag('--vm')
const asJson = argv.includes('--json')
const timeoutMs = Number(flag('--timeout') || 15000)
const TARGETS = [
  { host: 'claude.ai', path: '/', method: 'HEAD' },
  { host: 'platform.claude.com', path: '/v1/oauth/token', method: 'HEAD' },
]

function redact(url) {
  return String(url || '').replace(/:[^:@/]*@/, ':***@')
}

function parseProxy(url) {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: Number(u.port || 1080),
    user: decodeURIComponent(u.username || ''),
    pass: decodeURIComponent(u.password || ''),
  }
}

function socksConnect(proxy, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port })
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error(`socks timeout after ${timeout}ms`)), timeout)
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.write(Buffer.from(proxy.user ? [0x05, 0x01, 0x02] : [0x05, 0x01, 0x00]))
    })
    let stage = 'greeting'
    const request = () => {
      const name = Buffer.from(host)
      socket.write(
        Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
          name,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]),
      )
      stage = 'connect'
    }
    socket.on('data', (chunk) => {
      if (stage === 'greeting') {
        if (chunk[0] !== 0x05) return fail(new Error('not a SOCKS5 server'))
        if (chunk[1] === 0x02) {
          const u = Buffer.from(proxy.user)
          const p = Buffer.from(proxy.pass)
          socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]))
          stage = 'auth'
          return
        }
        if (chunk[1] !== 0x00) return fail(new Error('proxy requires unsupported auth'))
        request()
        return
      }
      if (stage === 'auth') {
        if (chunk[1] !== 0x00) return fail(new Error('proxy_auth_failed：代理拒绝用户名密码'))
        request()
        return
      }
      if (stage === 'connect') {
        if (chunk[1] !== 0x00) return fail(new Error(`SOCKS5 connect rejected (rep=${chunk[1]})`))
        settled = true
        clearTimeout(timer)
        socket.removeAllListeners('data')
        resolve(socket)
      }
    })
  })
}

function tlsHandshake(options, timeout) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(options, () => {
      clearTimeout(timer)
      resolve(socket)
    })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`tls timeout after ${timeout}ms`))
    }, timeout)
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function httpHead(socket, { host, path: target, method }, timeout) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`http timeout after ${timeout}ms`))
    }, timeout)
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      const line = buffer.split('\r\n')[0]
      if (!line) return
      clearTimeout(timer)
      socket.destroy()
      const status = Number(line.split(' ')[1])
      resolve({ status, line })
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    socket.write(
      `${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: vm2api-egress-check/1\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
    )
  })
}

async function probe(exitUrl, target) {
  const started = Date.now()
  const port = 443
  let socket
  if (exitUrl === '') {
    socket = await tlsHandshake({ host: target.host, port, servername: target.host }, timeoutMs)
  } else {
    const proxy = parseProxy(exitUrl)
    socket = await socksConnect(proxy, target.host, port, timeoutMs)
    socket = await tlsHandshake({ socket, servername: target.host }, timeoutMs)
  }
  const protocol = socket.getProtocol?.() || null
  const { status } = await httpHead(socket, target, timeoutMs)
  return { ok: status > 0, status, ms: Date.now() - started, protocol }
}

function readPool() {
  try {
    const dbPath = path.join(ROOT, 'data', 'kin.db')
    if (!fs.existsSync(dbPath)) return null
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db
      .prepare('select id,name,protocol,host,port,username,password,status,enabled,bound_vm_id,last_error from proxies')
      .all()
    db.close()
    return rows
  } catch {
    return null
  }
}

/** Mirrors the runtime's view so a dead/disabled proxy is refused, not attempted. */
function poolFromRows(rows) {
  if (!rows) return null
  const proxies = rows.map((r) => {
    const local = r.id === 'px-local'
    const auth = r.username ? `${encodeURIComponent(r.username)}:${encodeURIComponent(r.password || '')}@` : ''
    return {
      id: r.id,
      enabled: r.enabled === 1 || r.enabled === true,
      status: r.status,
      blocked_reason: r.enabled === 1 || r.enabled === true ? null : 'proxy_disabled',
      kind: local ? 'local' : undefined,
      host: r.host || undefined,
      url: local || !r.host ? null : `socks5h://${auth}${r.host}:${r.port}`,
      bound_vm_id: r.bound_vm_id || undefined,
    }
  })
  return {
    snapshot: () => ({ proxies, config: {} }),
    getProxyForVm: (vmId) => proxies.find((p) => p.bound_vm_id === vmId) || null,
  }
}

function listVms() {
  const dir = path.join(ROOT, 'vms')
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json') && n !== 'active.json')
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))
    .filter((vm) => vm?.id)
    .filter((vm) => !onlyVm || vm.id === onlyVm)
}

const pool = readPool()
const results = []
for (const vm of listVms()) {
  const boundId = vm.proxy?.id || (vm.proxy?.url ? 'inline' : null)
  const entry = { vm: vm.id, bound: boundId, record: vm.proxy?.url ? redact(vm.proxy.url) : null, probes: [] }
  const poolBinding = pool?.find((p) => p.bound_vm_id === vm.id) || null
  if (poolBinding && boundId && poolBinding.id !== boundId) {
    entry.mismatch = `VM 记录绑 ${boundId}，池里绑 ${poolBinding.id}`
  }
  const poolRow = pool?.find((p) => p.id === boundId) || null
  if (poolRow) {
    entry.pool = { status: poolRow.status, enabled: poolRow.enabled, last_error: poolRow.last_error || null }
  }
  try {
    // Raw exit: what the exchange would physically use.
    const exit = resolveSlotOAuthProxy(vm, null)
    entry.exit = exit === '' ? 'local' : redact(exit)
    // Runtime exit: the pool's health gate is applied, exactly like a real import.
    try {
      const runtimeExit = resolveSlotOAuthProxy(vm, poolFromRows(pool))
      entry.runtimeExit = runtimeExit === '' ? 'local' : redact(runtimeExit)
      if (entry.runtimeExit !== entry.exit) {
        entry.mismatch = entry.mismatch || `运行时出口 ${entry.runtimeExit} 与原始 ${entry.exit} 不同`
      }
    } catch (err) {
      entry.runtimeRefused = err?.code || String(err?.message || err)
    }
    for (const target of TARGETS) {
      try {
        entry.probes.push({ host: target.host, ok: true, ...(await probe(exit, target)) })
      } catch (err) {
        entry.probes.push({ host: target.host, ok: false, error: String(err?.message || err) })
      }
    }
  } catch (err) {
    entry.refused = err?.code || String(err?.message || err)
  }
  results.push(entry)
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2))
} else {
  for (const r of results) {
    const verdict = r.refused ? `REFUSED ${r.refused}` : r.probes.every((p) => p.ok) ? 'OK' : 'FAIL'
    console.log(`\n[${verdict}] ${r.vm}`)
    console.log(`  bound   : ${r.bound || '(none)'} ${r.record || ''}`)
    if (r.mismatch) console.log(`  MISMATCH: ${r.mismatch}`)
    if (r.pool)
      console.log(
        `  pool    : status=${r.pool.status} enabled=${r.pool.enabled}${r.pool.last_error ? ` (${r.pool.last_error})` : ''}`,
      )
    console.log(`  oauth   : ${r.exit || `refused (${r.refused})`}`)
    if (r.runtimeRefused) console.log(`  runtime : 拒绝 ${r.runtimeRefused}（池状态不允许使用）`)
    else if (r.runtimeExit) console.log(`  runtime : ${r.runtimeExit}`)
    for (const p of r.probes) {
      console.log(
        `  ${p.host.padEnd(22)} ${p.ok ? `OK   ${p.status} ${p.ms}ms ${p.protocol || ''}` : `FAIL ${p.error}`}`,
      )
    }
  }
}

const bad = results.filter((r) => r.refused || r.runtimeRefused || r.probes.some((p) => !p.ok) || r.mismatch)
process.exit(bad.length ? 1 : 0)
