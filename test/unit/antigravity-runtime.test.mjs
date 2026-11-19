import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import {
  antigravityRuntimeSupport,
  antigravityBridgeStatus,
  ensureAntigravityBridge,
  runAntigravityText,
  runAntigravityInference,
  stopAntigravityBridge,
  writeAntigravityBridgeConfig,
} from '../../src/lib/transport/antigravity-bridge-supervisor.mjs'
import { slotRuntimeOwner } from '../../src/lib/oauth/oauth-credentials.mjs'
import { antigravityBridgePaths } from '../../src/lib/transport/antigravity-bridge-client.mjs'
import { startAntigravityBridge } from '../../scripts/antigravity-bridge.mjs'
import {
  resolveInferenceEngine,
  resolveKernelDataplane,
  resolveOfficialCcInference,
} from '../../src/lib/vm/slot-engine.mjs'
import {
  ensureSlotInferenceRuntime,
  startSlotReady,
  switchSlotInferenceEngine,
} from '../../src/lib/vm/slot-runtime.mjs'
import {
  ANTIGRAVITY_SLOT_ROLE,
  slotContainerCommand,
  slotKernelAlive,
  slotWorkerNeedsRecreate,
  startVmRuntime,
  writeWorkerFiles,
} from '../../src/lib/vm/vm-runtime.mjs'
import { diagnoseSlotServices, powerOnSlot } from '../../src/lib/vm/slot-recovery.mjs'
import { panelAntigravityShellLaunch, createSlotShell } from '../../src/lib/vm/slot-shell.mjs'

const vm = {
  id: 'vm-ag',
  platform: 'antigravity',
  proxy: { id: 'px-test', host: '127.0.0.1', port: 1080 },
  runtime: { type: 'docker' },
}
const routing = { antigravity: { enabled: true, models: ['model-a'] } }
function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('Antigravity never resolves Claude engine or starts its kernel PID1', async () => {
  assert.equal(resolveInferenceEngine(vm, { inference: { engine: 'rust' } }), null)
  assert.equal(resolveKernelDataplane(vm), null)
  assert.equal(resolveOfficialCcInference(vm), null)
  assert.deepEqual(slotContainerCommand(vm, { wrapKernel: true }), ['sleep', 'infinity'])
  const paths = { kernelSocket: '/nonexistent/kernel.sock' }
  const healthy = { running: true, role: ANTIGRAVITY_SLOT_ROLE, networkMode: 'kin-eg-px-test' }
  assert.equal(slotKernelAlive(healthy, paths, vm), true)
  assert.equal(slotWorkerNeedsRecreate(healthy, vm, paths), false)
  assert.equal(slotWorkerNeedsRecreate({ ...healthy, role: '' }, vm, paths), true)
  const result = await switchSlotInferenceEngine(vm, '/unused', 'rust')
  assert.equal(result.code, 'antigravity_engine_forbidden')
})

test('Antigravity rejects KVM, remote slots and missing egress before any runtime launch', async (t) => {
  const root = rootFor(t)
  for (const bad of [
    { ...vm, node_id: 'remote' },
    { ...vm, runtime: { type: 'kvm' } },
    { ...vm, proxy: null },
  ]) {
    assert.equal(antigravityRuntimeSupport(bad).ok, false)
    const result = await startVmRuntime(bad, root, { routing })
    assert.equal(result.ok, false)
    assert.equal(fs.existsSync(path.join(root, 'vms')), false)
  }
  assert.equal((await startVmRuntime(vm, root)).code, 'antigravity_disabled')
  for (const bad of [
    { ...vm, node_id: 'remote' },
    { ...vm, runtime: { type: 'kvm' } },
    { ...vm, proxy: null },
  ]) {
    assert.equal((await startVmRuntime(bad, root, { forAuthentication: true })).ok, false)
    assert.throws(() => writeWorkerFiles(bad, root, { forAuthentication: true }))
    assert.equal(fs.existsSync(path.join(root, 'vms')), false)
  }
})

test('authentication may prepare a disabled isolated slot without enabling text runtime', async (t) => {
  const root = rootFor(t)
  assert.throws(() => writeWorkerFiles(vm, root), { code: 'antigravity_disabled' })
  assert.throws(() => writeWorkerFiles(vm, root, { forAuthentication: 'true' }), { code: 'antigravity_disabled' })
  const files = writeWorkerFiles(vm, root, { forAuthentication: true })
  assert.equal(files.worker, 'antigravity')
  assert.equal(fs.existsSync(files.runDir), true)
  assert.equal(fs.existsSync(files.config), false)
  assert.equal(fs.existsSync(files.token), false)
  assert.equal(fs.existsSync(path.join(root, 'vms', vm.id, 'cli-home')), false)
  assert.equal((await ensureAntigravityBridge({ projectRoot: root, vm })).code, 'antigravity_disabled')
  assert.equal(
    (await runAntigravityText({ projectRoot: root, vm, model: 'model-a', prompt: 'hello' })).code,
    'antigravity_disabled',
  )
})

test('authentication rejects a running container on another egress without recreating it', async (t) => {
  const root = rootFor(t)
  const original = childProcess.execFileSync
  const calls = []
  childProcess.execFileSync = (command, args, options) => {
    if (command === 'python3') return original(command, args, options)
    calls.push([command, ...args])
    assert.equal(command, 'docker')
    if (args[0] === 'network' && args[1] === 'inspect') return '172.30.0.0/24|172.30.0.1'
    if (args[0] === 'inspect') return 'true|123|host|2026-01-01|base-image|ag-host|docker|antigravity|false'
    assert.fail(`unexpected Docker mutation: ${args[0]}`)
  }
  syncBuiltinESMExports()
  try {
    const local = { ...vm, proxy: { id: 'px-local', scheme: 'local', host: 'local' } }
    const result = await startVmRuntime(local, root, { forAuthentication: true })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'antigravity_egress_mismatch')
    assert.deepEqual(
      calls.map((entry) => entry[1]),
      ['network', 'inspect'],
    )
    assert.equal(fs.existsSync(path.join(root, 'vms', vm.id, 'run', 'antigravity.json')), false)
  } finally {
    childProcess.execFileSync = original
    syncBuiltinESMExports()
  }
})

test('authentication runtime refuses a replaced home and does not publish bridge assets through symlinks', async (t) => {
  const root = rootFor(t)
  const home = path.join(root, 'vms', vm.id, 'cli-home')
  const outside = path.join(root, 'outside-slot')
  fs.mkdirSync(outside, { mode: 0o750 })
  fs.writeFileSync(path.join(outside, 'private-config'), 'untouched', { mode: 0o640 })
  fs.mkdirSync(path.dirname(home), { recursive: true })
  fs.symlinkSync(outside, home)
  const before = fs.statSync(outside)
  await assert.rejects(startVmRuntime(vm, root, { forAuthentication: true }))
  assert.equal(fs.statSync(outside).mode, before.mode)
  assert.equal(fs.statSync(outside).uid, before.uid)
  assert.equal(fs.statSync(outside).gid, before.gid)
  fs.unlinkSync(home)
  fs.mkdirSync(home)
  fs.symlinkSync(outside, path.join(home, '.kin'))
  const files = writeWorkerFiles(vm, root, { forAuthentication: true })
  assert.equal(fs.existsSync(files.runDir), true)
  assert.equal(fs.existsSync(files.config), false)
  assert.equal(fs.existsSync(path.join(home, '.cache')), false)
  assert.deepEqual(fs.readdirSync(outside), ['private-config'])
  assert.equal(fs.readFileSync(path.join(outside, 'private-config'), 'utf8'), 'untouched')
})

test('worker preparation writes only separate bridge config and a tool-free custom agent', (t) => {
  const root = rootFor(t)
  const paths = writeWorkerFiles(vm, root, { routing })
  assert.equal(paths.worker, 'antigravity')
  assert.match(paths.socket, /antigravity.sock$/)
  const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'))
  assert.equal(config.socket_path, '/run/kin/antigravity.sock')
  assert.equal(config.cli_bin, 'agy')
  assert.equal(config.max_sessions, 1)
  assert.equal(fs.statSync(paths.token).mode & 0o777, 0o600)
  const home = path.join(root, 'vms', vm.id, 'cli-home')
  assert.equal(fs.existsSync(path.join(home, '.claude')), false)
  assert.equal(fs.existsSync(path.join(paths.runDir, 'kernel.json')), false)
  assert.equal(fs.existsSync(path.join(paths.runDir, 'worker.json')), false)
  const agent = fs.readFileSync(
    path.join(home, '.kin', 'antigravity-workspace', '.agents', 'agents', 'vm2api-text.md'),
    'utf8',
  )
  assert.match(agent, /tools: \[\]/)
  assert.match(agent, /commandExecutionPolicy: "off"/)
  assert.match(agent, /subagent: false/)
})

test('AG starts its own bridge while a missing bridge dependency keeps the shell container available', async () => {
  const result = await startSlotReady(vm, '/unused', {
    routing,
    ops: {
      startSlot: async () => ({ ok: true, action: 'started', runtime: { worker: 'antigravity' } }),
      ensureAntigravityBridge: async () => ({ ok: false, code: 'antigravity_node_unavailable' }),
      ensureRustKernel: () => {
        throw new Error('Claude kernel must not start')
      },
      materializeWrapCli: () => {
        throw new Error('Claude sample must not materialize')
      },
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.antigravity_ready, false)
  assert.equal(result.antigravity.code, 'antigravity_node_unavailable')
  assert.equal(
    (
      await ensureSlotInferenceRuntime(vm, '/unused', {
        routing,
        ops: { ensureAntigravityBridge: async () => ({ ok: true }) },
      })
    ).engine,
    'antigravity',
  )
})

test('status is a nonstarting probe and text forwarding preserves session cancellation', async (t) => {
  const root = rootFor(t)
  const status = await antigravityBridgeStatus({ projectRoot: root, vm, routing })
  assert.equal(status.ready, false)
  assert.equal(status.authenticated, null)
  assert.equal(fs.existsSync(path.join(root, 'vms')), false)
  let call
  const controller = new AbortController()
  const onText = () => {}
  const forwarded = await runAntigravityText({
    projectRoot: root,
    vm,
    routing,
    model: 'model-a',
    prompt: 'hello',
    sessionId: 'scoped-session',
    signal: controller.signal,
    onText,
    ops: {
      ensureBridge: async () => ({ ok: true }),
      callBridge: async (options) => {
        call = options
        return { ok: true, response: 'done' }
      },
    },
  })
  assert.equal(forwarded.response, 'done')
  assert.deepEqual(call.body, { model: 'model-a', prompt: 'hello', session_id: 'scoped-session' })
  assert.equal(call.signal, controller.signal)
  assert.equal(call.onText, onText)
})

test('supervisor verifies container network and executes only a Docker-local bridge', async (t) => {
  const root = rootFor(t)
  const source = path.join(root, 'linux-node')
  fs.writeFileSync(source, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  let bridge
  let launch
  t.after(async () => {
    await stopAntigravityBridge(root, vm)
    await bridge?.close()
  })
  const result = await ensureAntigravityBridge({
    projectRoot: root,
    vm,
    routing,
    ops: {
      nodeSource: source,
      execFile: async (command, args) => {
        assert.equal(command, 'docker')
        assert.equal(args[0], 'inspect')
        return { stdout: 'true|kin-eg-px-test' }
      },
      spawn: (command, args, options) => {
        launch = { command, args, options }
        const paths = antigravityBridgePaths(root, vm)
        const config = JSON.parse(fs.readFileSync(paths.configPath, 'utf8'))
        void startAntigravityBridge(
          { ...config, socket_path: paths.socketPath },
          { pool: { size: 0, close() {} } },
        ).then((started) => {
          bridge = started
        })
        return new EventEmitter()
      },
    },
  })
  assert.equal(result.ok, true)
  assert.equal(launch.command, 'docker')
  assert.deepEqual(launch.args, [
    'exec',
    '--user',
    `${slotRuntimeOwner(vm).uid}:${slotRuntimeOwner(vm).gid}`,
    '--env',
    'HOME=/home/kincli',
    '--env',
    'PATH=/home/kincli/.local/bin:/usr/local/bin:/usr/bin:/bin',
    '--workdir',
    '/home/kincli',
    'kin-ag',
    '/home/kincli/.kin/antigravity-node',
    '/home/kincli/.kin/antigravity-bridge.mjs',
    '--config',
    '/run/kin/antigravity.json',
  ])
  assert.equal(launch.options.shell, false)
  const again = await ensureAntigravityBridge({
    projectRoot: root,
    vm,
    routing: { antigravity: { ...routing.antigravity, max_sessions: 2 } },
    ops: { execFile: async () => ({ stdout: 'true|kin-eg-px-test' }) },
  })
  assert.equal(again.code, 'antigravity_runtime_reload_required')
})

test('diagnostics use AG bridge status and power-on without credentials stays unschedulable', async (t) => {
  const root = rootFor(t)
  const record = { ...vm, status: 'running' }
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(record))
  const diagnostics = await diagnoseSlotServices(record, {
    projectRoot: root,
    routing,
    probes: {
      container: async () => ({ running: true }),
      socksEgress: () => ({ ok: true }),
      antigravityHealth: async () => ({ ok: true }),
      rustHealth: () => {
        throw new Error('Claude readiness must not run')
      },
    },
  })
  assert.equal(diagnostics.engine, 'antigravity')
  assert.equal(diagnostics.checks.find((row) => row.id === 'credential').code, 'antigravity_auth_unknown')
  assert.equal(diagnostics.checks.find((row) => row.id === 'kernel').status, 'ok')
  const started = await powerOnSlot({
    projectRoot: root,
    id: vm.id,
    routing,
    proxyPool: { ensureBoundToVm: () => vm.proxy },
    fillTimezone: async () => {},
    ops: { startSlotReady: async () => ({ ok: true, runtime: vm.runtime }) },
  })
  assert.equal(started.ok, true)
  assert.equal(started.vm.schedulable, false)
  assert.equal(started.vm.schedule_disabled_reason, 'no_credential')
  assert.equal(started.vm.unschedulable.reason, 'no_credential')

  const runDir = path.join(root, 'vms', vm.id, 'run')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'antigravity-auth.json'), JSON.stringify({ authenticated: true }))
  const authenticated = await powerOnSlot({
    projectRoot: root,
    id: vm.id,
    routing,
    proxyPool: { ensureBoundToVm: () => vm.proxy },
    fillTimezone: async () => {},
    ops: { startSlotReady: async () => ({ ok: true, runtime: vm.runtime }) },
  })
  assert.equal(authenticated.ok, true)
  assert.equal(authenticated.vm.schedulable, true)
  assert.equal(authenticated.vm.unschedulable, undefined)
})

test('AG shell is plain and rejects Claude credential/login workflows before writes', async (t) => {
  const root = rootFor(t)
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const launch = panelAntigravityShellLaunch()
  assert.match(launch.rc, /系统特征/)
  assert.doesNotMatch(launch.rc, /CLAUDE|\.claude|cli-node|claude\(\)/)
  let authCalls = 0
  const shell = createSlotShell({
    projectRoot: root,
    checkClaude: async () => {
      authCalls++
    },
  })
  assert.equal((await shell.issueTicket(vm.id)).ok, true)
  assert.equal((await shell.issueTicket(vm.id, { login: true })).error.code, 'platform_login_not_supported')
  assert.equal(authCalls, 0)
  assert.equal(fs.existsSync(path.join(root, 'vms', vm.id, 'cli-home', '.claude')), false)
})

test('structured supervisor forwarding preserves events, request and cancellation', async () => {
  const controller = new AbortController()
  const onEvent = () => {}
  const request = { model: 'model-a', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  let forwarded
  const response = await runAntigravityInference({
    projectRoot: '/unused',
    vm,
    routing,
    request,
    signal: controller.signal,
    onEvent,
    ops: {
      ensureBridge: async () => ({ ok: true }),
      callBridge: async (options) => {
        forwarded = options
        return { ok: true, content: [] }
      },
    },
  })
  assert.equal(response.ok, true)
  assert.equal(forwarded.requestPath, '/inference')
  assert.equal(forwarded.body, request)
  assert.equal(forwarded.onEvent, onEvent)
  assert.equal(forwarded.signal, controller.signal)
})

test('bridge preparation refuses guest parent symlinks before publishing trusted assets', (t) => {
  const root = rootFor(t)
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'antigravity-bridge.mjs'), 'untouched')
  const home = path.join(root, 'vms', vm.id, 'cli-home')
  fs.mkdirSync(home, { recursive: true })
  fs.symlinkSync(outside, path.join(home, '.kin'))
  assert.throws(() => writeAntigravityBridgeConfig(root, vm, { routing }))
  assert.deepEqual(fs.readdirSync(outside), ['antigravity-bridge.mjs'])
  assert.equal(fs.readFileSync(path.join(outside, 'antigravity-bridge.mjs'), 'utf8'), 'untouched')
})
