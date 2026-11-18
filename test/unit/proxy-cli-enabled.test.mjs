import '../fixtures/kin-computer-test-env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createImportCommit } from '../../src/lib/oauth/import-commit.mjs'
import { slotHasBoundProxy, evaluateSlotGate } from '../../src/lib/pool/schedule-eligibility.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { buildVmPackage, parseVmPackage, commitVmPackage } from '../../src/lib/vm/vm-package.mjs'
import {
  adoptVmProxyBinding,
  bindVmProxy,
  getVm,
  patchVmRecord,
  repairVmProxyCliEnabled,
} from '../../src/lib/vm/vm-registry.mjs'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-332-'))
}

function writeVm(root, rec) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${rec.id}.json`)
  fs.writeFileSync(file, JSON.stringify(rec, null, 2))
  return file
}

const SOCKS = {
  id: 'px-1',
  host: '10.0.0.9',
  port: 1080,
  scheme: 'socks5',
  url: 'socks5://10.0.0.9:1080',
}

function boundSlot(extra = {}) {
  return {
    id: 'vm-01',
    name: 'slot',
    status: 'running',
    schedulable: true,
    schedule_disabled_reason: null,
    proxy_cli_enabled: false,
    proxy: { ...SOCKS },
    claude: {},
    policy: { maxConcurrency: 2, weight: 1 },
    ...extra,
  }
}

test('bindVmProxy turns proxy_cli_enabled on, unbind turns it off', () => {
  const root = tmpRoot()
  try {
    writeVm(root, boundSlot({ proxy: null, proxy_cli_enabled: false }))
    bindVmProxy(root, 'vm-01', SOCKS)
    const bound = getVm(root, 'vm-01')
    assert.equal(bound.proxy_cli_enabled, true)
    assert.equal(bound.proxy.id, 'px-1')
    assert.equal(slotHasBoundProxy(bound), true)
    bindVmProxy(root, 'vm-01', null)
    const unbound = getVm(root, 'vm-01')
    assert.equal(unbound.proxy_cli_enabled, false)
    assert.equal(unbound.proxy, null)
    assert.equal(slotHasBoundProxy(unbound), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rebind of the same exit heals a stale false flag', () => {
  const root = tmpRoot()
  try {
    writeVm(root, boundSlot())
    bindVmProxy(root, 'vm-01', SOCKS)
    const vm = getVm(root, 'vm-01')
    assert.equal(vm.proxy_cli_enabled, true)
    assert.equal(slotHasBoundProxy(vm), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('patchVmRecord after bind keeps proxy_cli_enabled', () => {
  const root = tmpRoot()
  try {
    writeVm(root, boundSlot({ proxy: null }))
    const snapshot = getVm(root, 'vm-01')
    bindVmProxy(root, 'vm-01', SOCKS)
    snapshot.status = 'running'
    const written = patchVmRecord(root, 'vm-01', { status: 'running' })
    assert.equal(written.proxy_cli_enabled, true)
    assert.equal(written.proxy.id, 'px-1')
    assert.equal(getVm(root, 'vm-01').proxy_cli_enabled, true)
    adoptVmProxyBinding(snapshot, written)
    assert.equal(snapshot.proxy_cli_enabled, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('repair heals bound-but-false and unbound-but-true slots', () => {
  const root = tmpRoot()
  try {
    writeVm(root, boundSlot({ id: 'vm-01' }))
    writeVm(root, boundSlot({ id: 'vm-02', proxy: null, proxy_cli_enabled: true }))
    writeVm(root, boundSlot({ id: 'vm-03', proxy_cli_enabled: true }))
    const repaired = repairVmProxyCliEnabled(root)
    assert.deepEqual(repaired.sort(), ['vm-01', 'vm-02'])
    assert.equal(getVm(root, 'vm-01').proxy_cli_enabled, true)
    assert.equal(slotHasBoundProxy(getVm(root, 'vm-01')), true)
    assert.equal(getVm(root, 'vm-02').proxy_cli_enabled, false)
    assert.equal(slotHasBoundProxy(getVm(root, 'vm-02')), false)
    assert.equal(getVm(root, 'vm-03').proxy_cli_enabled, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('OAuth commit reuses native readiness without legacy worker.sock or changing saved opt-out', async () => {
  const root = tmpRoot()
  const prevMock = process.env.KIN_CRS_MOCK
  delete process.env.KIN_CRS_MOCK
  let server = null
  try {
    const runDir = path.join(root, 'vms', 'vm-01', 'run')
    fs.mkdirSync(runDir, { recursive: true })
    const kernelSocket = path.join(runDir, 'kernel.sock')
    const tokenFile = path.join(runDir, 'internal.token')
    fs.writeFileSync(tokenFile, 'import-fixture-token\n')
    let healthReads = 0
    server = http.createServer((req, res) => {
      assert.equal(req.url, '/internal/health')
      assert.equal(req.headers['x-internal-token'], 'import-fixture-token')
      healthReads += 1
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: false, vm_id: 'vm-01', engine: 'rust', cli_pid: 4242, ready_slots: 1 }))
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(kernelSocket, resolve)
    })
    const vmPath = writeVm(
      root,
      boundSlot({
        seed_policy: { telemetry_disabled: true },
        runtime: { type: 'docker', kernel_socket: kernelSocket, worker_run_dir: runDir, worker_token_file: tokenFile },
      }),
    )
    const existing = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    const { commitImportedOauth } = createImportCommit({
      cfg: { paths: { project: root } },
      proxyPool: { getProxyForVm: () => SOCKS },
      accountQuota: {
        rebindToVm() {},
        clearGrantRevokeLeftover() {},
      },
    })
    const result = await commitImportedOauth({
      vmId: 'vm-01',
      vmPath,
      existing,
      oauth: {
        access_token: 'sk-ant-oat01-332',
        refresh_token: 'sk-ant-ort01-332',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        email: 'slot@example.com',
        account_uuid: 'acct-332',
      },
      source: 'test',
      skipOfficialCc: true,
    })
    assert.equal(result.ok, true, result.error?.message)
    const saved = getVm(root, 'vm-01')
    assert.equal(saved.proxy_cli_enabled, true)
    assert.equal(saved.proxy.id, 'px-1')
    assert.equal(slotHasBoundProxy(saved), true)
    assert.equal(evaluateSlotGate(saved).ok, true)
    assert.equal(healthReads, 1)
    assert.equal(fs.existsSync(path.join(runDir, 'worker.sock')), false)
    assert.equal(saved.runtime.kernel_socket, kernelSocket)
    assert.equal(saved.seed_policy.telemetry_disabled, true)
    const credential = JSON.parse(
      fs.readFileSync(path.join(root, 'vms', 'vm-01', 'cli-home', '.claude', 'credentials.json'), 'utf8'),
    )
    assert.equal(credential.claudeAiOauth.accessToken, 'sk-ant-oat01-332')
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (prevMock === undefined) delete process.env.KIN_CRS_MOCK
    else process.env.KIN_CRS_MOCK = prevMock
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('package import with a proxy keeps proxy_cli_enabled even if the spec says false', async (t) => {
  const root = tmpRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const db = createDatabase({ dbPath: ':memory:' })
  const pool = new ProxyPool({ db })
  t.after(() => {
    pool.stopScheduler()
    db.close()
  })
  const doc = buildVmPackage({
    vm: {
      id: 'vm-pkg',
      name: 'pkg',
      platform: 'anthropic',
      family: 'claude',
      kernel: 'ubuntu-24.04',
      proxy_cli_enabled: false,
    },
    proxy: { host: '10.2.2.2', port: 1080, username: 'alice', password: 's3cret' },
    claudeCred: {
      type: 'oauth',
      access_token: 'sk-ant-oat01-332',
      refresh_token: 'sk-ant-ort01-332',
      expires_at: 1_900_000_000,
    },
  })
  doc.vm.proxy_cli_enabled = false
  const parsed = parseVmPackage(doc)
  assert.equal(parsed.ok, true, parsed.error?.message)
  assert.equal(parsed.value.vm.proxy_cli_enabled, false)
  const result = await commitVmPackage({
    projectRoot: root,
    parsed,
    mode: 'create',
    proxyPool: pool,
    owner: { role: 'admin', userId: null },
  })
  assert.equal(result.ok, true, result.error?.message)
  const saved = getVm(root, 'vm-pkg')
  assert.equal(saved.proxy.host, '10.2.2.2')
  assert.equal(saved.proxy_cli_enabled, true)
  assert.equal(slotHasBoundProxy(saved), true)
})

test('package import with default telemetry on ignores a packaged opt-out', async (t) => {
  const root = tmpRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const db = createDatabase({ dbPath: ':memory:' })
  const pool = new ProxyPool({ db })
  t.after(() => {
    pool.stopScheduler()
    db.close()
  })
  const doc = buildVmPackage({
    vm: {
      id: 'vm-pkg',
      name: 'pkg',
      platform: 'anthropic',
      family: 'claude',
      kernel: 'ubuntu-24.04',
      seed_policy: { telemetry_disabled: true },
    },
  })
  const parsed = parseVmPackage(doc)
  assert.equal(parsed.ok, true, parsed.error?.message)
  assert.equal(parsed.value.vm.seed_policy.telemetry_disabled, true)
  const result = await commitVmPackage({
    projectRoot: root,
    parsed,
    mode: 'create',
    proxyPool: pool,
    telemetryDefaultEnabled: true,
    owner: { role: 'admin', userId: null },
  })
  assert.equal(result.ok, true, result.error?.message)
  assert.equal(getVm(root, 'vm-pkg').seed_policy.telemetry_disabled, false)
})
