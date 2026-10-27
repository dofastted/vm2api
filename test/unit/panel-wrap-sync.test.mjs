import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

const prevKernelBin = process.env.KIN_KERNEL_BIN

before(() => {
  delete process.env.KIN_KERNEL_BIN
})

after(() => {
  if (prevKernelBin == null) delete process.env.KIN_KERNEL_BIN
  else process.env.KIN_KERNEL_BIN = prevKernelBin
})

function seedWrapTemplate(project) {
  const template = path.join(project, 'share', 'wrap-cli')
  fs.mkdirSync(template, { recursive: true })
  fs.writeFileSync(path.join(template, 'cli-node'), 'cli-node')
  fs.writeFileSync(path.join(template, 'cc-node'), 'cc-node')
  fs.writeFileSync(path.join(template, 'kin-kernel'), 'kin-kernel')
}

function fakeElf64Amd64(payload = 'uploaded-kernel') {
  const extra = Buffer.from(String(payload))
  const buf = Buffer.alloc(64 + extra.length)
  buf[0] = 0x7f
  buf[1] = 0x45
  buf[2] = 0x4c
  buf[3] = 0x46
  buf[4] = 2
  buf[5] = 1
  buf.writeUInt16LE(3, 16)
  buf.writeUInt16LE(62, 18)
  extra.copy(buf, 64)
  return buf
}

test('wrap sync updates stopped slots without requiring a kernel restart', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-wrap-sync-'))
  const response = {}
  try {
    seedWrapTemplate(project)
    const vmDir = path.join(project, 'vms')
    fs.mkdirSync(vmDir, { recursive: true })
    fs.writeFileSync(
      path.join(vmDir, 'legacy-slot.json'),
      JSON.stringify({ id: 'legacy-slot', name: 'legacy-slot', status: 'stopped' }),
    )
    const handlePanel = createPanelHandler({
      cfg: { paths: { project } },
      routingConfig: {},
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, payload) {
        response.status = status
        response.body = payload
        return true
      },
      readBody: async () => ({ restart: true }),
    })

    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/wrap-cli/sync'))

    assert.equal(response.status, 200)
    assert.equal(response.body.data.ok, true)
    assert.deepEqual(response.body.data.items[0].kernel, { ok: true, skipped: true, reason: 'vm_stopped' })
    assert.equal(
      fs.readFileSync(path.join(project, 'vms', 'legacy-slot', 'cli-home', '.kin', 'kin-kernel.bin'), 'utf8'),
      'kin-kernel',
    )
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('kernel upload replaces host and sample kernel', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-kernel-upload-'))
  const response = {}
  const elf = fakeElf64Amd64()
  try {
    seedWrapTemplate(project)
    const handlePanel = createPanelHandler({
      cfg: { paths: { project } },
      routingConfig: {},
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, payload) {
        response.status = status
        response.body = payload
        return true
      },
      readBody: async () => ({}),
      readRawBody: async () => elf,
    })

    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/wrap-cli/kernel'))

    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.data.ok, true)
    assert.ok(fs.readFileSync(path.join(project, 'share', 'wrap-cli', 'kin-kernel.bin')).equals(elf))
    assert.ok(fs.readFileSync(path.join(project, 'bin', 'kin-kernel')).equals(elf))
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('kernel upload rejects non-ELF payloads', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-kernel-bad-'))
  const response = {}
  try {
    seedWrapTemplate(project)
    const handlePanel = createPanelHandler({
      cfg: { paths: { project } },
      routingConfig: {},
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, payload) {
        response.status = status
        response.body = payload
        return true
      },
      readRawBody: async () => Buffer.alloc(64, 0x41),
    })

    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/wrap-cli/kernel'))

    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'kernel_not_elf')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

function releaseFetch(
  elf,
  {
    assetBytes = elf,
    cliBytes = fakeElf64Amd64('github-cli-node'),
    ccBytes = fakeElf64Amd64('github-cc-node'),
    cragBytes = fakeElf64Amd64('github-crag'),
    status = 200,
  } = {},
) {
  return async (url) => {
    const href = String(url)
    if (href.endsWith('/releases/latest')) {
      return new Response(
        JSON.stringify({
          tag_name: 'v1.2.3',
          assets: [
            {
              name: 'kin-kernel',
              size: assetBytes.length,
              url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/9',
            },
            {
              name: 'cli-node',
              size: cliBytes.length,
              url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/8',
            },
            {
              name: 'cc-node',
              size: ccBytes.length,
              url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/7',
            },
            {
              name: 'kin-kernel-crag',
              size: cragBytes.length,
              url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/6',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (href.endsWith('/releases/assets/9')) {
      return new Response(assetBytes, {
        status,
        headers: { 'content-length': String(assetBytes.length) },
      })
    }
    if (href.endsWith('/releases/assets/8')) {
      return new Response(cliBytes, {
        status: 200,
        headers: { 'content-length': String(cliBytes.length) },
      })
    }
    if (href.endsWith('/releases/assets/7')) {
      return new Response(ccBytes, {
        status: 200,
        headers: { 'content-length': String(ccBytes.length) },
      })
    }
    if (href.endsWith('/releases/assets/6')) {
      return new Response(cragBytes, {
        status: 200,
        headers: { 'content-length': String(cragBytes.length) },
      })
    }
    throw new Error(`unexpected ${href}`)
  }
}

function panelFor(project, { readBody, readRawBody, fetchImpl, refreshClusterSlotPayloads } = {}) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project } },
    routingConfig: {},
    fetchImpl,
    refreshClusterSlotPayloads,
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: readBody || (async () => ({ restart: true })),
    readRawBody,
  })
  return { response, handlePanel }
}

test('github kernel release replaces host kernel and syncs stopped slots', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-kernel-release-'))
  const elf = fakeElf64Amd64('github-kernel')
  try {
    seedWrapTemplate(project)
    const vmDir = path.join(project, 'vms')
    fs.mkdirSync(vmDir, { recursive: true })
    fs.writeFileSync(
      path.join(vmDir, 'legacy-slot.json'),
      JSON.stringify({ id: 'legacy-slot', name: 'legacy-slot', status: 'stopped' }),
    )
    const { response, handlePanel } = panelFor(project, { fetchImpl: releaseFetch(elf) })
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/wrap-cli/kernel/release'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.data.release.tag, 'v1.2.3')
    assert.equal(response.body.data.sync.items[0].kernel.reason, 'vm_stopped')
    assert.ok(fs.readFileSync(path.join(project, 'bin', 'kin-kernel')).equals(elf))
    assert.ok(fs.readFileSync(path.join(project, 'share', 'wrap-cli', 'kin-kernel.bin')).equals(elf))
    assert.ok(
      fs.readFileSync(path.join(project, 'share', 'wrap-cli', 'cli-node')).equals(fakeElf64Amd64('github-cli-node')),
    )
    assert.ok(
      fs.readFileSync(path.join(project, 'share', 'wrap-cli', 'cc-node')).equals(fakeElf64Amd64('github-cc-node')),
    )
    assert.ok(fs.readFileSync(path.join(project, 'share', 'crag', 'kin-kernel')).equals(fakeElf64Amd64('github-crag')))
    assert.equal(response.body.data.release.cli_node, 'cli-node')
    assert.equal(response.body.data.release.cc_node, 'cc-node')
    assert.ok(
      fs.readFileSync(path.join(project, 'vms', 'legacy-slot', 'cli-home', '.kin', 'kin-kernel.bin')).equals(elf),
    )
    const meta = JSON.parse(fs.readFileSync(path.join(project, 'share', 'wrap-cli', 'SAMPLE.json'), 'utf8'))
    assert.equal(meta.source, 'github')
    assert.equal(meta.release_tag, 'v1.2.3')

    const uploaded = fakeElf64Amd64('manual-kernel')
    const upload = panelFor(project, { readRawBody: async () => uploaded })
    await upload.handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/wrap-cli/kernel'))
    assert.equal(upload.response.status, 200, JSON.stringify(upload.response.body))
    const cleared = JSON.parse(fs.readFileSync(path.join(project, 'share', 'wrap-cli', 'SAMPLE.json'), 'utf8'))
    assert.equal(cleared.source, 'upload')
    assert.equal(cleared.release_tag, undefined)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('github kernel release does not write a non-ELF payload', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-kernel-release-bad-'))
  try {
    seedWrapTemplate(project)
    const { response, handlePanel } = panelFor(project, {
      fetchImpl: releaseFetch(Buffer.alloc(0), { assetBytes: Buffer.alloc(64, 0x41) }),
    })
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/wrap-cli/kernel/release'))
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'kernel_not_elf')
    assert.equal(fs.existsSync(path.join(project, 'bin', 'kin-kernel')), false)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('wrap sync refreshes a cluster slot with the same kernel payload', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-cluster-sync-'))
  const seen = []
  try {
    seedWrapTemplate(project)
    fs.mkdirSync(path.join(project, 'vms'), { recursive: true })
    fs.writeFileSync(
      path.join(project, 'vms', 'local-slot.json'),
      JSON.stringify({ id: 'local-slot', name: 'local', status: 'stopped' }),
    )
    fs.writeFileSync(
      path.join(project, 'vms', 'node-slot.json'),
      JSON.stringify({ id: 'node-slot', name: 'node', status: 'stopped', node_id: 'node-a', kernel: 'ubuntu-24.04' }),
    )
    const { response, handlePanel } = panelFor(project, {
      refreshClusterSlotPayloads: async (_root, vms) => {
        seen.push(vms.map((vm) => vm.id))
        return {
          ok: true,
          changed: true,
          total: vms.length,
          ok_count: vms.length,
          failed_count: 0,
          changed_count: vms.length,
          items: vms.map((vm) => ({
            id: vm.id,
            node_id: vm.node_id,
            ok: true,
            kernel_changed: true,
            image: 'vm2api/kin-slot-ubuntu-24.04:abc',
            kernel: { ok: true, skipped: true, reason: 'vm_stopped' },
          })),
        }
      },
    })
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/wrap-cli/sync'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.deepEqual(seen, [['node-slot']])
    assert.equal(response.body.data.total, 2)
    assert.equal(response.body.data.cluster.total, 1)
    assert.equal(
      response.body.data.items.find((item) => item.id === 'node-slot').image,
      'vm2api/kin-slot-ubuntu-24.04:abc',
    )
    assert.equal(
      fs.readFileSync(path.join(project, 'vms', 'local-slot', 'cli-home', '.kin', 'kin-kernel.bin'), 'utf8'),
      'kin-kernel',
    )
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('kernel update keeps slot data unless traits mode is explicit', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-update-mode-'))
  const cred = path.join(project, 'vms', 'local-slot', 'cli-home', '.claude', 'credentials.json')
  try {
    seedWrapTemplate(project)
    fs.mkdirSync(path.dirname(cred), { recursive: true })
    fs.writeFileSync(cred, '{"keep":true}')
    fs.writeFileSync(
      path.join(project, 'vms', 'local-slot.json'),
      JSON.stringify({
        id: 'local-slot',
        name: 'local',
        status: 'stopped',
        claude: { email: 'keep@kin.test', has_access: true },
        fingerprint: { hostname: 'kept-host', device_id: 'a'.repeat(64), guest_machine_id: 'b'.repeat(32) },
      }),
    )
    const kept = panelFor(project, { readBody: async () => ({ restart: true, mode: 'keep' }) })
    await kept.handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/wrap-cli/sync'))
    assert.equal(kept.response.status, 200, JSON.stringify(kept.response.body))
    assert.equal(kept.response.body.data.mode, 'keep')
    assert.equal(fs.readFileSync(cred, 'utf8'), '{"keep":true}')
    const record = JSON.parse(fs.readFileSync(path.join(project, 'vms', 'local-slot.json'), 'utf8'))
    assert.equal(record.claude.email, 'keep@kin.test')
    assert.equal(record.fingerprint.hostname, 'kept-host')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('concurrent wrap syncs run one after another', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-sync-serial-'))
  const events = []
  try {
    seedWrapTemplate(project)
    fs.mkdirSync(path.join(project, 'vms'), { recursive: true })
    fs.writeFileSync(
      path.join(project, 'vms', 'node-slot.json'),
      JSON.stringify({ id: 'node-slot', name: 'node', status: 'running', node_id: 'node-a', kernel: 'ubuntu-24.04' }),
    )
    let calls = 0
    const refreshClusterSlotPayloads = async (_root, vms) => {
      const n = ++calls
      events.push(`start ${n}`)
      await new Promise((resolve) => setTimeout(resolve, 30))
      events.push(`end ${n}`)
      return {
        ok: true,
        total: vms.length,
        ok_count: vms.length,
        failed_count: 0,
        items: vms.map((vm) => ({ id: vm.id, ok: true, kernel_changed: false })),
      }
    }
    // The entrypoint auto-sync and the upgrade helper are separate requests to one server.
    const first = panelFor(project, { refreshClusterSlotPayloads })
    const second = panelFor(project, { refreshClusterSlotPayloads })
    await Promise.all([
      first.handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/wrap-cli/sync')),
      second.handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/wrap-cli/sync')),
    ])
    assert.deepEqual(events, ['start 1', 'end 1', 'start 2', 'end 2'])
    assert.equal(first.response.status, 200)
    assert.equal(second.response.status, 200)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})
