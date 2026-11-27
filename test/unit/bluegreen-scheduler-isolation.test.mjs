import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ensureSchedulerToken, SchedulerClient, schedulerPaths } from '../../src/lib/transport/scheduler-client.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const COMPOSE_BG = path.join(ROOT, 'deploy/bluegreen/compose.bluegreen.yml')

function parseBluegreenEnvironment(yamlText) {
  const lines = yamlText.split(/\r?\n/)
  const env = {}
  let inEnvironment = false
  let envIndent = -1

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = rawLine.match(/^ */)[0].length

    if (!inEnvironment) {
      if (trimmed === 'environment:') {
        inEnvironment = true
        envIndent = indent
      }
      continue
    }

    if (indent <= envIndent) break
    const sep = trimmed.indexOf(':')
    assert.ok(sep > 0, `unexpected environment line in compose.bluegreen.yml: ${rawLine}`)
    const key = trimmed.slice(0, sep).trim()
    let val = trimmed.slice(sep + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    env[key] = val
  }

  return env
}

function interpolateComposeValue(template, vars) {
  return template.replace(/\$\{([A-Z0-9_]+)(?::([-?])([^}]*))?\}/g, (_match, name, op, arg) => {
    const val = vars[name]
    if (val !== undefined && val !== '') return String(val)
    if (op === '-') return arg ?? ''
    if (op === '?') throw new Error(`missing required compose var ${name}: ${arg}`)
    return ''
  })
}

function renderColorEnv(rawEnv, color, port) {
  const vars = {
    BG_COLOR: color,
    BG_PORT: String(port),
    BG_NAME: 'vm2api',
    BG_DRAIN_MS: '3600000',
  }
  const rendered = {}
  for (const [key, template] of Object.entries(rawEnv)) {
    rendered[key] = interpolateComposeValue(template, vars)
  }
  return rendered
}

function withEnv(overrides, fn) {
  const trackedKeys = [
    'KIN_BG_COLOR',
    'BG_COLOR',
    'KIN_SCHEDULER_BIN',
    'KIN_SCHEDULER_SOCK',
    'KIN_SCHEDULER_LISTEN',
    'KIN_SCHEDULER_TOKEN',
    'KIN_SCHEDULER_TOKEN_FILE',
    'KIN_SCHEDULER_CAP_FILE',
    'KIN_STANDBY',
    'KIN_STANDBY_ACTIVE_FILE',
  ]
  const snapshot = new Map()
  for (const k of trackedKeys) {
    snapshot.set(k, process.env[k])
    delete process.env[k]
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = String(v)
  }
  try {
    return fn()
  } finally {
    for (const [k, prev] of snapshot.entries()) {
      if (prev === undefined) delete process.env[k]
      else process.env[k] = prev
    }
  }
}

test('compose.bluegreen.yml isolates KIN_SCHEDULER_* paths and image-bin per color', () => {
  const rawEnv = parseBluegreenEnvironment(fs.readFileSync(COMPOSE_BG, 'utf8'))

  assert.equal(rawEnv.KIN_BG_COLOR, '${BG_COLOR}')
  assert.equal(rawEnv.KIN_SCHEDULER_BIN, '/opt/vm2api/image-bin/kin-scheduler')
  assert.equal(rawEnv.KIN_SCHEDULER_SOCK, '/opt/vm2api/data/run/scheduler-${BG_COLOR}.sock')
  assert.equal(rawEnv.KIN_SCHEDULER_TOKEN_FILE, '/opt/vm2api/data/run/scheduler-${BG_COLOR}.token')
  assert.equal(rawEnv.KIN_SCHEDULER_CAP_FILE, '/opt/vm2api/data/run/scheduler-${BG_COLOR}.cap.json')
  // KIN_SCHEDULER_TOKEN overrides the literal secret (not a file path); compose must use *_TOKEN_FILE.
  assert.equal(rawEnv.KIN_SCHEDULER_TOKEN, undefined)

  const blueEnv = renderColorEnv(rawEnv, 'blue', 8788)
  const greenEnv = renderColorEnv(rawEnv, 'green', 8789)
  const containerCfg = { paths: { project: '/opt/vm2api', data: '/opt/vm2api/data' } }

  const bluePaths = withEnv(blueEnv, () => schedulerPaths(containerCfg))
  const greenPaths = withEnv(greenEnv, () => schedulerPaths(containerCfg))

  assert.equal(bluePaths.transport, 'uds')
  assert.equal(greenPaths.transport, 'uds')
  assert.equal(bluePaths.binPath, '/opt/vm2api/image-bin/kin-scheduler')
  assert.equal(greenPaths.binPath, '/opt/vm2api/image-bin/kin-scheduler')
  assert.equal(bluePaths.socketPath, '/opt/vm2api/data/run/scheduler-blue.sock')
  assert.equal(greenPaths.socketPath, '/opt/vm2api/data/run/scheduler-green.sock')
  assert.equal(bluePaths.tokenPath, '/opt/vm2api/data/run/scheduler-blue.token')
  assert.equal(greenPaths.tokenPath, '/opt/vm2api/data/run/scheduler-green.token')
  assert.equal(bluePaths.capFile, '/opt/vm2api/data/run/scheduler-blue.cap.json')
  assert.equal(greenPaths.capFile, '/opt/vm2api/data/run/scheduler-green.cap.json')

  assert.notEqual(bluePaths.socketPath, greenPaths.socketPath)
  assert.notEqual(bluePaths.tokenPath, greenPaths.tokenPath)
  assert.notEqual(bluePaths.capFile, greenPaths.capFile)

  // Verify KIN_BG_COLOR alone derives the exact same per-color paths as explicit KIN_SCHEDULER_* vars.
  if (process.platform !== 'win32') {
    const blueDerived = withEnv(
      { KIN_BG_COLOR: blueEnv.KIN_BG_COLOR, KIN_SCHEDULER_BIN: blueEnv.KIN_SCHEDULER_BIN },
      () => schedulerPaths(containerCfg),
    )
    const greenDerived = withEnv(
      { KIN_BG_COLOR: greenEnv.KIN_BG_COLOR, KIN_SCHEDULER_BIN: greenEnv.KIN_SCHEDULER_BIN },
      () => schedulerPaths(containerCfg),
    )
    assert.deepEqual(blueDerived, bluePaths)
    assert.deepEqual(greenDerived, greenPaths)
  }
})

test('standby green SchedulerClient never shares or unlinks active blue leader socket/token/cap files', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-bg-sched-'))
  try {
    const rawEnv = parseBluegreenEnvironment(fs.readFileSync(COMPOSE_BG, 'utf8'))
    const remap = (p) => p.replace(/^\/opt\/vm2api\//, `${tmpRoot}/`)
    const remapEnv = (env) => ({
      ...env,
      KIN_STANDBY_ACTIVE_FILE: remap(env.KIN_STANDBY_ACTIVE_FILE),
      KIN_SCHEDULER_SOCK: remap(env.KIN_SCHEDULER_SOCK),
      KIN_SCHEDULER_TOKEN_FILE: remap(env.KIN_SCHEDULER_TOKEN_FILE),
      KIN_SCHEDULER_CAP_FILE: remap(env.KIN_SCHEDULER_CAP_FILE),
    })

    const blueEnv = remapEnv(renderColorEnv(rawEnv, 'blue', 8788))
    const greenEnv = remapEnv(renderColorEnv(rawEnv, 'green', 8789))

    // Blue is active leader with live socket/token/cap artifacts on shared data/run.
    fs.mkdirSync(path.dirname(blueEnv.KIN_STANDBY_ACTIVE_FILE), { recursive: true })
    fs.writeFileSync(blueEnv.KIN_STANDBY_ACTIVE_FILE, '')
    fs.writeFileSync(blueEnv.KIN_SCHEDULER_SOCK, 'blue-live-socket-sentinel')
    fs.writeFileSync(blueEnv.KIN_SCHEDULER_CAP_FILE, '{"pid":1001}')
    const blueToken = ensureSchedulerToken(blueEnv.KIN_SCHEDULER_TOKEN_FILE)

    const blueClient = withEnv(blueEnv, () => new SchedulerClient({ manageProcess: false }))
    const greenClient = withEnv(greenEnv, () => new SchedulerClient({ manageProcess: false }))

    assert.equal(blueClient.role, 'leader')
    assert.equal(greenClient.role, 'standby')
    assert.notEqual(blueClient.paths.socketPath, greenClient.paths.socketPath)
    assert.notEqual(blueClient.paths.tokenPath, greenClient.paths.tokenPath)
    assert.notEqual(blueClient.paths.capFile, greenClient.paths.capFile)

    // Initializing standby green token and replacing green socket/cap must leave blue untouched.
    const greenToken = ensureSchedulerToken(greenClient.paths.tokenPath)
    fs.rmSync(greenClient.paths.socketPath, { force: true })
    fs.rmSync(greenClient.paths.capFile, { force: true })
    fs.writeFileSync(greenClient.paths.socketPath, 'green-standby-socket')
    fs.writeFileSync(greenClient.paths.capFile, '{"pid":2002}')

    assert.notEqual(greenToken, blueToken)
    assert.equal(fs.readFileSync(blueEnv.KIN_SCHEDULER_SOCK, 'utf8'), 'blue-live-socket-sentinel')
    assert.equal(fs.readFileSync(blueEnv.KIN_SCHEDULER_TOKEN_FILE, 'utf8').trim(), blueToken)
    assert.equal(fs.readFileSync(blueEnv.KIN_SCHEDULER_CAP_FILE, 'utf8'), '{"pid":1001}')
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})
