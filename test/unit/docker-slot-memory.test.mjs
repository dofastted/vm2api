import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { localDocker } from '../../src/lib/cluster/docker-remote.mjs'
import {
  formatDockerMemoryBytes,
  inspectDockerContainerMemory,
  parseCgroupMemoryLimit,
  raiseDockerSlotMemory,
  validateDockerMemoryRaise,
} from '../../src/lib/vm/docker-slot-memory.mjs'

const HALF = 512 * 1024 ** 2
const GIB = 1024 ** 3
const ID = 'a'.repeat(64)
const EXEC = 'b'.repeat(64)

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync('/tmp/kin-memory-')
  fs.mkdirSync(path.join(root, 'vms'))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = {
    id: 'vm-01',
    status: 'running',
    machine: { memory: '512m' },
    runtime: { type: 'docker', memory: '512m', pid: 42 },
    account_marker: 'preserved',
  }
  fs.writeFileSync(file, JSON.stringify(vm))
  const state = { Id: ID, HostConfig: { Memory: HALF, MemorySwap: GIB }, State: { Running: true } }
  Object.assign(state.HostConfig, options.limits)
  if (options.stopped) state.State.Running = false
  const calls = []
  let inspectCount = 0
  let updateCount = 0
  let command
  let exitCode = 0
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const b of req) chunks.push(b)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    const call = { path: req.url, method: req.method, body }
    calls.push(call)
    const json = (status, value) => res.writeHead(status).end(JSON.stringify(value))
    if (req.url.startsWith('/containers/') && req.url.endsWith('/json')) {
      inspectCount++
      if (options.inspect?.({ state, inspectCount, updateCount, res, file }) === false) return
      return json(200, state)
    }
    if (req.url.endsWith('/update')) {
      updateCount++
      if (options.update?.({ state, body, updateCount, res, file }) === false) return
      state.HostConfig.Memory = body.Memory
      state.HostConfig.MemorySwap = body.MemorySwap
      return json(200, { Warnings: options.warnings || null })
    }
    if (req.url.endsWith('/exec')) {
      command = body.Cmd
      return json(201, { Id: EXEC })
    }
    if (req.url.endsWith('/start')) {
      const result = options.cgroup?.({ state, command, file }) || {
        stdout: String(state.HostConfig.Memory),
        exitCode: 0,
      }
      exitCode = result.exitCode
      const output = Buffer.from(result.stdout)
      const frame = Buffer.alloc(8)
      frame[0] = 1
      frame.writeUInt32BE(output.length, 4)
      res.writeHead(200).end(Buffer.concat([frame, output]))
      return
    }
    if (req.url === `/exec/${EXEC}/json`) return json(200, { Running: false, ExitCode: exitCode })
    json(404, { message: 'unexpected request' })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  const socketPath = path.join(root, 'd.sock')
  await new Promise((resolve) => server.listen(socketPath, resolve))
  t.after(async () => {
    for (const s of sockets) s.destroy()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    vm,
    file,
    state,
    calls,
    connect: localDocker(socketPath),
    saved: () => JSON.parse(fs.readFileSync(file)),
  }
}
const raise = (f) => raiseDockerSlotMemory(f.root, f.vm, '1g', { connect: f.connect })

test('byte formatting and cgroup limits retain finite/unlimited distinctions', () => {
  assert.equal(formatDockerMemoryBytes(HALF), '512m')
  assert.equal(formatDockerMemoryBytes(GIB), '1g')
  assert.deepEqual(parseCgroupMemoryLimit('max'), { kind: 'unlimited' })
  assert.deepEqual(parseCgroupMemoryLimit('9223372036854771712'), { kind: 'unlimited' })
  assert.deepEqual(parseCgroupMemoryLimit(String(GIB)), { kind: 'limited', bytes: GIB })
  assert.deepEqual(parseCgroupMemoryLimit(''), { kind: 'unreadable' })
})
test('validation rejects KVM, unsupported values and decreases before connecting', async () => {
  const vm = { id: 'vm', machine: { memory: '1g' } }
  assert.equal(validateDockerMemoryRaise({ ...vm, runtime_type: 'kvm' }, '2g').code, 'kvm_memory_raise_forbidden')
  assert.equal(validateDockerMemoryRaise(vm, '3g').code, 'invalid_memory')
  assert.equal(validateDockerMemoryRaise(vm, '512m').code, 'memory_not_increased')
  assert.equal(
    (
      await raiseDockerSlotMemory('/unused', vm, '1g', {
        connect: () => {
          throw Error('must not connect')
        },
      })
    ).code,
    'memory_not_increased',
  )
})
test('inspect reads structured memory, swap, running state and full ID', async (t) => {
  const f = await fixture(t)
  const r = await inspectDockerContainerMemory(f.vm, { connect: f.connect })
  assert.deepEqual(r, { ok: true, id: ID, memory: '512m', bytes: HALF, swapBytes: GIB, running: true })
})
test('success requires HostConfig and cgroup confirmation and preserves runtime/account fields', async (t) => {
  const f = await fixture(t, { warnings: ['daemon warning'] })
  const r = await raise(f)
  assert.equal(r.ok, true)
  assert.deepEqual(r.warnings, ['daemon warning'])
  assert.equal(f.saved().machine.memory, '1g')
  assert.equal(f.saved().runtime.memory, '1g')
  assert.equal(f.saved().runtime.pid, 42)
  assert.equal(f.saved().account_marker, 'preserved')
  const updates = f.calls.filter((c) => c.path.endsWith('/update'))
  assert.deepEqual(
    updates.map((c) => c.body),
    [{ Memory: GIB, MemorySwap: GIB }],
  )
  assert.ok(updates.every((c) => c.path.startsWith(`/containers/${ID}/`)))
})
test('stopped container and default swap are refused without update', async (t) => {
  for (const opts of [{ stopped: true }, { limits: { MemorySwap: 0 } }]) {
    const f = await fixture(t, opts)
    const r = await raise(f)
    assert.equal(r.code, opts.stopped ? 'container_not_running' : 'memory_swap_unrestorable')
    assert.ok(!f.calls.some((c) => c.path.endsWith('/update')))
    assert.equal(f.saved().machine.memory, '512m')
  }
})
test('actual higher limit is never lowered to satisfy stale panel state', async (t) => {
  const f = await fixture(t, { limits: { Memory: 2 * GIB, MemorySwap: 2 * GIB } })
  assert.equal((await raise(f)).code, 'live_memory_not_increased')
  assert.ok(!f.calls.some((c) => c.path.endsWith('/update')))
})
test('lost update response after application is read back and verified without another update', async (t) => {
  const f = await fixture(t, {
    update: ({ state, body, res }) => {
      Object.assign(state.HostConfig, body)
      res.socket.destroy()
      return false
    },
  })
  assert.equal((await raise(f)).ok, true)
  assert.equal(f.calls.filter((c) => c.path.endsWith('/update')).length, 1)
  assert.equal(f.saved().machine.memory, '1g')
})
test('rejected update with unchanged limits reports unchanged and does not persist', async (t) => {
  const f = await fixture(t, {
    update: ({ res }) => {
      res.writeHead(500).end('{"message":"denied"}')
      return false
    },
  })
  const r = await raise(f)
  assert.equal(r.code, 'docker_update_failed')
  assert.equal(r.application_state, 'unchanged')
  assert.equal(r.config_unchanged, true)
  assert.equal(r.rollback_attempted, false)
  assert.equal(f.saved().machine.memory, '512m')
})
test('unreadable outcome reports unknown instead of retrying or rolling back blindly', async (t) => {
  const f = await fixture(t, {
    inspect: ({ updateCount, res }) => {
      if (!updateCount) return
      res.writeHead(500).end('{}')
      return false
    },
  })
  const r = await raise(f)
  assert.equal(r.application_state, 'unknown')
  assert.equal(r.rollback_attempted, false)
  assert.equal(f.calls.filter((c) => c.path.endsWith('/update')).length, 1)
  assert.equal(f.saved().machine.memory, '512m')
})
test('cgroup mismatch, unlimited and unreadable cannot be saved as a verified raise', async (t) => {
  for (const output of [String(HALF), 'max', '']) {
    const f = await fixture(t, { cgroup: () => ({ stdout: output, exitCode: output ? 0 : 1 }) })
    const r = await raise(f)
    assert.equal(r.ok, false)
    assert.equal(r.application_state, 'applied-unverified')
    assert.equal(r.rollback_attempted, false, 'never shrink after memory may already be in use')
    assert.equal(f.state.HostConfig.Memory, GIB)
    assert.equal(f.saved().machine.memory, '512m')
  }
})
test('missing v2 file falls back to v1 and verifies exec exit code', async (t) => {
  const f = await fixture(t, {
    cgroup: ({ command }) =>
      command[1].endsWith('memory.max') ? { stdout: '', exitCode: 1 } : { stdout: String(GIB), exitCode: 0 },
  })
  assert.equal((await raise(f)).ok, true)
  assert.ok(f.calls.some((c) => c.body?.Cmd?.[1].endsWith('memory.limit_in_bytes')))
})
test('safe restoration preserves finite and unlimited raw swap and confirms by inspect', async (t) => {
  for (const swap of [GIB, -1]) {
    const f = await fixture(t, {
      limits: { MemorySwap: swap },
      update: ({ state, updateCount, res }) => {
        if (updateCount > 1) return
        state.HostConfig.MemorySwap = HALF
        res.writeHead(200).end('{}')
        return false
      },
    })
    const r = await raise(f)
    assert.equal(r.rollback_attempted, true)
    assert.equal(r.rollback_succeeded, true)
    assert.equal(r.application_state, 'unchanged')
    assert.equal(f.state.HostConfig.MemorySwap, swap)
    assert.deepEqual(f.calls.filter((c) => c.path.endsWith('/update')).at(-1).body, { Memory: HALF, MemorySwap: swap })
  }
})
test('a failed rollback is not reported as successful', async (t) => {
  const f = await fixture(t, {
    update: ({ state, res }) => {
      state.HostConfig.MemorySwap = HALF
      res.writeHead(500).end('{}')
      return false
    },
  })
  const r = await raise(f)
  assert.equal(r.rollback_attempted, true)
  assert.equal(r.rollback_succeeded, false)
  assert.equal(r.application_state, 'applied-unverified')
})
test('rename/replacement and stop during verification cannot save the new configuration', async (t) => {
  for (const replace of [true, false]) {
    const f = await fixture(t, {
      inspect: ({ state, inspectCount }) => {
        if (inspectCount < 3) return
        if (replace) state.Id = 'c'.repeat(64)
        else state.State.Running = false
      },
    })
    const r = await raise(f)
    assert.equal(r.code, 'container_changed')
    assert.equal(f.saved().machine.memory, '512m')
    assert.ok(f.calls.filter((c) => c.path.endsWith('/update')).every((c) => c.path.startsWith(`/containers/${ID}/`)))
  }
})
test('deleted vm record after update is surfaced without unsafe memory shrink', async (t) => {
  const f = await fixture(t, {
    cgroup: ({ file }) => {
      fs.rmSync(file)
      return { stdout: String(GIB), exitCode: 0 }
    },
  })
  const r = await raise(f)
  assert.equal(r.code, 'vm_not_found')
  assert.equal(r.application_state, 'applied-unverified')
  assert.equal(r.rollback_attempted, false)
})
test('filesystem commit failure reports unknown config state instead of throwing success', async (t) => {
  const f = await fixture(t)
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('disk failure')
  })
  const r = await raise(f)
  assert.equal(r.code, 'vm_config_write_failed')
  assert.equal(r.config_unchanged, null)
  assert.equal(r.application_state, 'applied-unverified')
  assert.equal(r.rollback_attempted, false)
  assert.equal(f.saved().machine.memory, '512m')
})

test('restoring original swap must not reduce an increased or unlimited allowance', async (t) => {
  for (const observedSwap of [GIB, -1]) {
    const f = await fixture(t, {
      limits: { MemorySwap: HALF },
      update: ({ state, res }) => {
        state.HostConfig.MemorySwap = observedSwap
        res.writeHead(500).end('{}')
        return false
      },
    })
    const r = await raise(f)
    assert.equal(r.rollback_attempted, false)
    assert.equal(r.application_state, 'applied-unverified')
    assert.equal(f.state.HostConfig.MemorySwap, observedSwap)
    assert.equal(f.calls.filter((c) => c.path.endsWith('/update')).length, 1)
  }
})

test('lost response with delayed daemon application stays unknown and never issues rollback', async (t) => {
  let applied
  const pending = new Promise((resolve) => {
    applied = resolve
  })
  const f = await fixture(t, {
    update: ({ state, body, res }) => {
      res.socket.destroy()
      setTimeout(() => {
        Object.assign(state.HostConfig, body)
        applied()
      }, 100)
      return false
    },
  })
  const r = await raise(f)
  assert.equal(r.application_state, 'unknown')
  assert.equal(r.rollback_attempted, false)
  assert.equal(f.saved().machine.memory, '512m')
  await pending
  assert.equal(f.state.HostConfig.Memory, GIB)
  assert.equal(f.calls.filter((c) => c.path.endsWith('/update')).length, 1)
  assert.equal(f.saved().machine.memory, '512m')
})
