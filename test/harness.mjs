/**
 * Spawn src/server.mjs against a temp PROJECT with the in-process
 * Anthropic mock (KIN_CRS_MOCK=1). No CLI, no network.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import { createDatabase } from '../src/lib/db/database.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const GATEWAY_ROOT = path.resolve(__dirname, '../src')
export const REPO_ROOT = path.resolve(__dirname, '..')
export const TEST_API_KEY = 'sk-kin-test-sim-001'

export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

export function seedVm({ project, id = 'vm-sim-01', oauth = true } = {}) {
  const vms = path.join(project, 'vms')
  fs.mkdirSync(path.join(vms, id, 'cli-home', '.claude'), { recursive: true })
  const rec = {
    id,
    name: 'sim-01',
    status: 'running',
    schedulable: true,
    timezone: 'UTC',
    locale: 'en_US.UTF-8',
    claude_code_version: '2.1.233',
    seed_policy: { telemetry_disabled: true },
    fingerprint: { device_id: 'dev-sim-01', session_id: 'sess-sim-01', machineID: 'mid-sim-01' },
    policy: { maxConcurrency: 16, weight: 1 },
    proxy_cli_enabled: true,
    proxy: { id: `proxy-${id}`, url: 'socks5h://127.0.0.1:19080', host: '127.0.0.1', port: 19080 },
    runtime: {
      worker: 'go',
      worker_socket: path.join(vms, id, 'run', 'worker.sock'),
      worker_run_dir: path.join(vms, id, 'run'),
      worker_token_file: path.join(vms, id, 'run', 'internal.token'),
    },
    claude: oauth
      ? {
          access_token: 'sk-ant-oat01-FAKE-SEED',
          refresh_token: 'sk-ant-ort01-FAKE-SEED',
          expires_at: Math.floor(Date.now() / 1000) + 8 * 3600,
          email: 'seed@kin.test',
          account_uuid: 'acct-seed',
          org_uuid: 'org-seed',
          source: 'test-seed',
        }
      : {},
  }
  fs.writeFileSync(path.join(vms, `${id}.json`), JSON.stringify(rec, null, 2))
  fs.writeFileSync(path.join(vms, 'active.json'), JSON.stringify({ active_vm: id }, null, 2))
  return rec
}

export async function startGateway(opts = {}) {
  const project = opts.project || fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sim-'))
  const captures = path.join(project, 'captures')
  const dataDir = path.join(project, 'data')
  fs.mkdirSync(captures, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  if (!fs.existsSync(path.join(project, 'vms', 'active.json'))) {
    seedVm({ project, oauth: opts.oauth !== false })
  }
  const routingFile = path.join(project, 'config', 'routing.json')
  if (!fs.existsSync(routingFile)) {
    fs.mkdirSync(path.dirname(routingFile), { recursive: true })
    fs.copyFileSync(path.join(GATEWAY_ROOT, 'config', 'routing.json'), routingFile)
  }
  const port = opts.port || (await pickFreePort())
  const traceFile = opts.traceFile || path.join(project, 'mock-trace.json')
  const connectionString = process.env.VM2API_TEST_DATABASE_URL
  if (!connectionString || !/_test$/.test(new URL(connectionString).pathname)) {
    throw new Error('gateway tests require VM2API_TEST_DATABASE_URL for a dedicated *_test database')
  }
  const schema =
    (process.env.KIN_DATABASE_SCHEMA || 'gateway_test') +
    '_gw_' +
    crypto.createHash('sha256').update(project).digest('hex').slice(0, 12)
  const env = {
    ...process.env,
    KIN_API_KEY: opts.apiKey || TEST_API_KEY,
    VM2API_DATABASE_URL: connectionString,
    KIN_DATABASE_URL: connectionString,
    KIN_DATABASE_SCHEMA: schema,
    KIN_ADMIN_USER: 'admin',
    KIN_ADMIN_PASSWORD: 'testpass',
    PORT: String(port),
    HOST: '127.0.0.1',
    PUBLIC_HOST: '127.0.0.1',
    PUBLIC_SCHEME: 'http',
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    KIN_PROJECT_ROOT: project,
    KIN_CAPTURES_DIR: captures,
    KIN_DATA_DIR: dataDir,
    KIN_ROUTING_FILE: routingFile,
    KIN_FAKE_SESSION_OAUTH: '1',
    KIN_DIFF_CAPTURE: opts.diffCapture ?? '0',
    KIN_UPSTREAM_TIMEOUT: String(opts.timeoutMs ?? 8000),
    KIN_MOCK_SCENARIO: opts.scenario || 'text',
    KIN_MOCK_TRACE_FILE: traceFile,
    KIN_MOCK_TEXT: opts.mockText || 'pong',
    KIN_CRS_MOCK: '1',
    KIN_KERNEL_BIN: path.join(REPO_ROOT, 'bin', 'kin-kernel'),
  }
  if (opts.env) Object.assign(env, opts.env)

  const child = spawn(process.execPath, [path.join(GATEWAY_ROOT, 'server.mjs')], {
    env,
    cwd: GATEWAY_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => {
    stdout += d.toString()
  })
  child.stderr.on('data', (d) => {
    stderr += d.toString()
  })

  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + (opts.readyMs || 8000)
  let ready = false
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    try {
      const r = await fetch(`${baseUrl}/health`)
      if (r.ok) {
        ready = true
        break
      }
    } catch {}
    if (child.exitCode != null) break
  }
  if (!ready) {
    try {
      child.kill('SIGKILL')
    } catch {}
    throw new Error(`gateway failed to start\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }

  const db = await createDatabase({ connectionString, schema: env.KIN_DATABASE_SCHEMA })
  return {
    db,
    schema: env.KIN_DATABASE_SCHEMA,
    connectionString,
    baseUrl,
    port,
    project,
    traceFile,
    apiKey: env.KIN_API_KEY,
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    async stop() {
      await db.close()
      if (child.exitCode == null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
          }, 5000)
          child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
    },
  }
}

export async function api(gw, method, urlPath, { body, headers, stream } = {}) {
  const h = {
    authorization: `Bearer ${gw.apiKey}`,
    ...(body != null ? { 'content-type': 'application/json' } : {}),
    ...(headers || {}),
  }
  const res = await fetch(gw.baseUrl + urlPath, {
    method,
    headers: h,
    body: body != null ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, headers: res.headers, text, json }
}

export function readTrace(gw) {
  try {
    return JSON.parse(fs.readFileSync(gw.traceFile, 'utf8'))
  } catch {
    return null
  }
}

/** Snapshot then unlink so the next hop writes a fresh trace. */
export function takeTrace(gw) {
  const t = readTrace(gw)
  try {
    fs.unlinkSync(gw.traceFile)
  } catch {}
  return t
}

export function listCaptures(gw) {
  const dir = path.join(gw.project, 'captures')
  if (!fs.existsSync(dir)) return []
  const walk = (d) => {
    const out = []
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name)
      const st = fs.statSync(p)
      if (st.isDirectory()) out.push(...walk(p))
      else if (name.endsWith('.json')) {
        try {
          out.push(JSON.parse(fs.readFileSync(p, 'utf8')))
        } catch {}
      }
    }
    return out
  }
  return walk(dir)
}

export function latestHopMeta(gw) {
  const caps = listCaptures(gw).filter((c) => c.hop_meta)
  return caps.length ? caps[caps.length - 1].hop_meta : null
}

export function requireNoFetch() {
  // unused helper kept for tests that want a local assert hook
  return createRequire(import.meta.url)
}
