import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { DEFAULT_CLAUDE_SETTING } from '../../src/lib/protocol/seed-policy.mjs'

function seed(root, id) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      status: 'stopped',
      seed_policy: { claude_setting: 'FROM_POLICY=1' },
    }),
  )
}

function handler(project, { readBody = async () => ({}), proxyPool = {}, telemetryOps } = {}) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project }, vm: { id: null } },
    ...(telemetryOps ? { telemetryOps } : {}),
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
    readBody,
    proxyPool: {
      unbindVm() {},
      followProxyTimezoneEnabled() {
        return true
      },
      proxyTimezone() {
        return 'Asia/Shanghai'
      },
      timezoneForVm() {
        return 'Asia/Shanghai'
      },
      ...proxyPool,
    },
  })
  return { handlePanel, response }
}

test('GET seed-settings keeps a missing claude.setting null', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-get-'))
  try {
    seed(root, 'vm-01')
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'GET' }, {}, new URL('http://localhost/api/panel/vms/vm-01/seed-settings'))
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400))
    assert.equal(response.body.data.claude_setting, null)
    assert.equal(response.body.data.settings_json, null)
    assert.equal(response.body.data.seed_policy.claude_setting, 'FROM_POLICY=1')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('GET seed-settings returns an empty claude.setting file as empty', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-empty-'))
  try {
    seed(root, 'vm-01')
    const dir = path.join(root, 'vms', 'vm-01', 'cli-home', '.claude')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'claude.setting'), '\n')
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { TZ: 'UTC' } }))
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'GET' }, {}, new URL('http://localhost/api/panel/vms/vm-01/seed-settings'))
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400))
    assert.equal(response.body.data.claude_setting, '')
    assert.equal(response.body.data.seed_policy.claude_setting, 'FROM_POLICY=1')
    assert.equal(response.body.data.seed_files.files.claude_setting, 'present')
    assert.equal(response.body.data.settings_json.env.TZ, 'UTC')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PUT seed-settings can follow proxy timezone and locale before writing files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-put-tz-'))
  try {
    seed(root, 'vm-01')
    const vmPath = path.join(root, 'vms', 'vm-01.json')
    const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    vm.timezone = 'UTC'
    vm.timezone_source = 'manual'
    vm.locale = 'en_US.UTF-8'
    vm.proxy = { id: 'px-1' }
    fs.writeFileSync(vmPath, JSON.stringify(vm))
    const body = {
      telemetry_disabled: true,
      claude_setting: 'X=1',
      extra_env: { CUSTOM: 'yes' },
      theme: 'dark',
      timezone_follow_proxy: true,
      locale: 'zh_CN.UTF-8',
    }
    const { handlePanel, response } = handler(root, {
      readBody: async () => body,
    })
    await handlePanel(
      { method: 'PUT', url: '/api/panel/vms/vm-01/seed-settings' },
      {},
      new URL('http://localhost/api/panel/vms/vm-01/seed-settings'),
    )
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400))
    const saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    assert.equal(saved.locale, 'zh_CN.UTF-8')
    assert.equal(saved.timezone, 'Asia/Shanghai')
    assert.equal(response.body.data.settings_json.env.TZ, 'Asia/Shanghai')
    assert.equal(response.body.data.settings_json.env.LANG, 'zh_CN.UTF-8')
    assert.equal(response.body.data.settings_json.env.CUSTOM, 'yes')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('GET seed-settings returns the upload log only when debug is on', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-log-'))
  try {
    seed(root, 'vm-01')
    const run = path.join(root, 'vms', 'vm-01', 'run')
    fs.mkdirSync(run, { recursive: true })
    fs.writeFileSync(
      path.join(run, 'telemetry-upload.log'),
      'old\n' +
        JSON.stringify({
          at: '2026-10-19T00:00:00Z',
          ok: true,
          events: 2,
          device_id: 'must-not-escape',
          payload: 'private-content',
        }) +
        '\n',
    )
    const hidden = handler(root)
    await hidden.handlePanel(
      { method: 'GET', url: '/api/panel/vms/vm-01/seed-settings' },
      {},
      new URL('http://localhost/api/panel/vms/vm-01/seed-settings'),
    )
    assert.equal(hidden.response.body.data.telemetry_log, undefined)
    const shown = handler(root)
    await shown.handlePanel(
      { method: 'GET', url: '/api/panel/vms/vm-01/seed-settings?debug=1' },
      {},
      new URL('http://localhost/api/panel/vms/vm-01/seed-settings?debug=1'),
    )
    const lines = shown.response.body.data.telemetry_log
    assert.deepEqual(
      lines.map((line) => JSON.parse(line)),
      [{ at: '2026-10-19T00:00:00Z', ok: true, events: 2, error: null }],
    )
    assert.ok(!JSON.stringify(lines).includes('must-not-escape'))
    assert.ok(!JSON.stringify(lines).includes('private-content'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('GET seed-settings reports unavailable node files without using the controller mirror', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-node-offline-'))
  try {
    seed(root, 'vm-01')
    const record = path.join(root, 'vms', 'vm-01.json')
    const vm = JSON.parse(fs.readFileSync(record, 'utf8'))
    vm.node_id = 'offline-node'
    fs.writeFileSync(record, JSON.stringify(vm))
    const dir = path.join(root, 'vms', 'vm-01', 'cli-home', '.claude')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"controller_marker":true}')
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'GET' }, {}, new URL('http://localhost/api/panel/vms/vm-01/seed-settings'))
    assert.equal(response.status, 200)
    assert.equal(response.body.data.settings_json, null)
    assert.equal(response.body.data.cli_home, null)
    assert.deepEqual(response.body.data.seed_files, {
      ok: false,
      source: 'node',
      files: { settings_json: 'error', claude_setting: 'error', kin_seed: 'error' },
      error: 'seed_files_unavailable',
    })
    assert.equal(JSON.stringify(response.body).includes('controller_marker'), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('GET seed-settings reports unsafe local files instead of following a link', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-get-link-'))
  try {
    seed(root, 'vm-01')
    const dir = path.join(root, 'vms', 'vm-01', 'cli-home', '.claude')
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(root, 'outside.json')
    fs.writeFileSync(target, '{"outside_marker":true}')
    fs.symlinkSync(target, path.join(dir, 'settings.json'))
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'GET' }, {}, new URL('http://localhost/api/panel/vms/vm-01/seed-settings'))
    assert.equal(response.status, 200)
    assert.equal(response.body.data.seed_files.ok, false)
    assert.equal(response.body.data.seed_files.error, 'seed_files_unavailable')
    assert.equal(response.body.data.settings_json, null)
    assert.equal(JSON.stringify(response.body).includes('outside_marker'), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PUT seed-settings preserves newer credentials, runtime and omitted policy across geo await', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-put-race-'))
  try {
    seed(root, 'vm-01')
    const file = path.join(root, 'vms', 'vm-01.json')
    const initial = JSON.parse(fs.readFileSync(file, 'utf8'))
    initial.node_id = 'offline-node'
    initial.proxy = { id: 'px-1', host: 'proxy.test', port: 1080 }
    initial.seed_policy.telemetry_disabled = false
    fs.writeFileSync(file, JSON.stringify(initial))
    const { handlePanel, response } = handler(root, {
      readBody: async () => ({ locale: 'zh_CN.UTF-8', timezone_follow_proxy: true, theme: 'light' }),
      proxyPool: {
        proxyTimezone: () => '',
        async detectGeo() {
          await Promise.resolve()
          const latest = JSON.parse(fs.readFileSync(file, 'utf8'))
          latest.claude = { access_token: 'new-access', refresh_token: 'new-refresh' }
          latest.runtime = { type: 'docker', generation: 2 }
          latest.seed_policy = { ...latest.seed_policy, telemetry_disabled: true, reject_client_settings: false }
          fs.writeFileSync(file, JSON.stringify(latest))
          return { ok: true, geo: { timezone: 'Asia/Shanghai' } }
        },
      },
    })
    await handlePanel({ method: 'PUT' }, {}, new URL('http://localhost/api/panel/vms/vm-01/seed-settings'))
    assert.equal(response.status, 502)
    assert.equal(response.body.data.saved, true)
    assert.equal(response.body.data.published, false)
    assert.equal(response.body.data.applied, false)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(saved.claude, { access_token: 'new-access', refresh_token: 'new-refresh' })
    assert.deepEqual(saved.runtime, { type: 'docker', generation: 2 })
    assert.deepEqual(saved.proxy, initial.proxy)
    assert.equal(saved.seed_policy.telemetry_disabled, true)
    assert.equal(saved.seed_policy.reject_client_settings, false)
    assert.equal(saved.seed_policy.claude_setting, 'FROM_POLICY=1')
    assert.equal(saved.seed_policy.theme, 'light')
    assert.equal(saved.locale, 'zh_CN.UTF-8')
    assert.equal(saved.timezone, 'Asia/Shanghai')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01', 'cli-home', '.claude', 'kin-seed.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PUT seed-settings surfaces upstream CRAG 409 message and reason without breaking claude_setting override', async () => {
  const http = await import('node:http')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seed-crag-409-'))
  const id = 'vm-01'
  const runDir = path.join(root, 'vms', id, 'run')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'internal.token'), 'panel-seed-token')
  fs.writeFileSync(
    path.join(runDir, 'kernel.json'),
    JSON.stringify({ vm_id: id, dataplane: 'crag', runtime_variant: 'crag-v2' }),
  )
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      status: 'running',
      dataplane: 'crag',
      crag_kernel_version: 'v2',
      runtime: {
        type: 'docker',
        container: 'kin-01',
        worker_run_dir: runDir,
        kernel_socket: path.join(runDir, 'kernel.sock'),
        worker_token_file: path.join(runDir, 'internal.token'),
      },
      seed_policy: { telemetry_disabled: true, claude_setting: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1' },
    }),
  )
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/internal/health') {
      res.end(JSON.stringify({ ok: true, runtime_variant: 'crag-v2', crag_telemetry_apply_v1: true }))
      return
    }
    if (req.url === '/internal/v1/telemetry/apply') {
      res.writeHead(409).end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'telemetry_native_settings_blocked',
            reason: 'guest_source_invalid',
            message: 'Native guest settings, telemetry allowlist or guest source prevent enabling telemetry',
          },
        }),
      )
      return
    }
    res.writeHead(404).end('{}')
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(path.join(runDir, 'kernel.sock'), resolve))
  try {
    const { handlePanel, response } = handler(root, {
      readBody: async () => ({ telemetry_disabled: false, claude_setting: 'CUSTOM_OVERRIDE=kept' }),
      telemetryOps: { retire: async () => ({ ok: true, running: true }) },
    })
    await handlePanel(
      { method: 'PUT', url: `/api/panel/vms/${id}/seed-settings` },
      {},
      new URL(`http://localhost/api/panel/vms/${id}/seed-settings`),
    )
    assert.equal(response.status, 502)
    assert.equal(response.body.error.code, 'telemetry_native_settings_blocked')
    assert.equal(response.body.error.reason, 'guest_source_invalid')
    assert.equal(
      response.body.error.upstream_message,
      'Native guest settings, telemetry allowlist or guest source prevent enabling telemetry',
    )
    assert.match(response.body.error.message, /Claude Code 槽内设置或 OS 特征阻止开启遥测/)
    assert.match(response.body.error.message, /guest_source_invalid/)
    assert.equal(response.body.data.claude_setting, 'CUSTOM_OVERRIDE=kept')
    assert.equal(response.body.data.settings_json.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
