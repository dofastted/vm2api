import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { getDb } from '../../src/lib/db/database.mjs'
import ssh2 from 'ssh2'
import { ClusterManager } from '../../src/lib/cluster/cluster-manager.mjs'
import { ClusterError, connectSsh, hostKeyDigest, SshLink } from '../../src/lib/cluster/ssh-link.mjs'
import { dockerPing, sshDocker } from '../../src/lib/cluster/docker-remote.mjs'
import { ClusterNodesRepo } from '../../src/lib/db/repos/cluster-nodes-repo.mjs'

const { Server, utils } = ssh2
const key = () => utils.generateKeyPairSync('ecdsa', { bits: 256 })
const defer = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Loopback SSH/Docker doubles; no real host, filesystem or container operation is performed. */
async function sshHost(t, options = {}) {
  const hostKey = options.hostKey || key()
  const state = {
    passwords: new Set(['old-password', 'new-password']),
    publicKey: null,
    username: 'u',
    uid: 1000,
    gid: 1000,
    home: '/home/u',
    docker: true,
    directories: true,
    containers: new Map(),
    auth: [],
    commands: [],
    requests: [],
    connections: new Set(),
    onPing: null,
  }
  const docker = http.createServer(async (req, res) => {
    state.requests.push([req.method, req.url])
    if (req.url === '/_ping') {
      await state.onPing?.()
      res.writeHead(state.docker ? 200 : 503)
      return res.end(state.docker ? 'OK' : 'unavailable')
    }
    const match = /^\/containers\/([^/]+)\/json$/.exec(req.url)
    const info = match && state.containers.get(decodeURIComponent(match[1]))
    res.writeHead(info ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(info || { message: 'not found' }))
  })
  await new Promise((resolve) => docker.listen(0, '127.0.0.1', resolve))
  const server = new Server({ hostKeys: [hostKey.private] }, (conn) => {
    state.connections.add(conn)
    conn.once('close', () => state.connections.delete(conn))
    conn.on('error', () => {})
    conn.on('authentication', (ctx) => {
      state.auth.push({ username: ctx.username, method: ctx.method })
      if (
        ctx.username === state.username &&
        ((ctx.method === 'password' && state.passwords.has(ctx.password)) ||
          (ctx.method === 'publickey' && state.publicKey && ctx.key.data.equals(state.publicKey)))
      )
        return ctx.accept()
      ctx.reject(['publickey', 'password'])
    })
    conn.on('openssh.streamlocal', (accept, reject, info) => {
      if (info.socketPath !== '/var/run/docker.sock') return reject()
      const channel = accept()
      const socket = net.connect(docker.address().port, '127.0.0.1')
      channel.on('error', () => socket.destroy())
      socket.on('error', () => channel.destroy())
      channel.once('close', () => socket.destroy())
      socket.once('close', () => channel.destroy())
      socket.pipe(channel).pipe(socket)
    })
    conn.on('session', (accept) => {
      accept().on('exec', (acceptExec, _reject, info) => {
        state.commands.push(info.command)
        const stream = acceptExec()
        if (info.command.startsWith('sh -c ')) {
          stream.write(`${state.uid}\n${state.gid}\n${state.home}\nnosudo\n`)
          stream.exit(0)
        } else if (info.command.startsWith('test -d ')) stream.exit(state.directories ? 0 : 1)
        else stream.exit(1)
        stream.end()
      })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    for (const conn of state.connections) conn.end()
    server.close()
    docker.closeAllConnections()
    docker.close()
  })
  return {
    state,
    hostKey,
    port: server.address().port,
    sha256: hostKeyDigest(Buffer.from(hostKey.public.split(' ')[1], 'base64')),
  }
}

async function fixture(t, opts = {}) {
  const remote = await sshHost(t)
  const db = getDb()
  const repo = new ClusterNodesRepo(db)
  await repo.insert(
    {
      id: 'node-a',
      label: 'A',
      host: '127.0.0.1',
      port: remote.port,
      username: 'u',
      auth_type: 'password',
      password: 'old-password',
      host_key_alg: 'ecdsa-sha2-nistp256',
      host_key_sha256: remote.sha256,
    },
    '2026-10-18T00:00:00.000Z',
  )
  const vms = opts.vms || []
  const manager = new ClusterManager({
    repo,
    dataDir: '/unused',
    vmsOnNode: () => vms,
    assertNodeEditable: opts.assertNodeEditable,
    logger: { log() {}, warn() {} },
  })
  await manager.reload()
  const link = new SshLink({ id: 'node-a', resolveTarget: async () => await manager._targetFor('node-a') })
  manager.links.set('node-a', link)
  if (opts.ready !== false) link.adopt(await connectSsh(await manager._targetFor('node-a')))
  t.after(async () => {
    await manager.stop()
    await db.close()
  })
  return {
    ...remote,
    db,
    repo,
    manager,
    link,
    vms,
    patch: async (change) => ({ expected_updated_at: (await repo.get('node-a')).updated_at, ...change }),
  }
}

function slot(remote, runtime = 'docker') {
  const id = 'vm-a'
  const cid = 'container-a'
  const dir = '/home/u/.vm2api/vms/vm-a'
  const vm = {
    id,
    node_id: 'node-a',
    runtime: { type: runtime, container_id: cid, container: 'kin-vm-a', user: '1000:1000' },
  }
  remote.state.containers.set(cid, {
    Id: cid,
    Config: { Labels: { 'kin.vm.id': id, 'vm2api.cluster': '1' } },
    Mounts: [
      { Type: 'bind', Source: `${dir}/run`, Destination: runtime === 'kvm' ? '/slot/run' : '/run/kin' },
      { Type: 'bind', Source: `${dir}/cli-home`, Destination: runtime === 'kvm' ? '/slot/home' : '/home/kincli' },
    ],
  })
  remote.vms.push(vm)
  return vm
}

test('existing get/list and join probe keep their public read contract without an edit body', async (t) => {
  const f = await fixture(t)
  assert.equal(f.manager.get('node-a').label, 'A')
  assert.deepEqual(f.manager.list(), [f.manager.get('node-a')])
  assert.equal(JSON.stringify(f.manager.get('node-a')).includes('old-password'), false)
  assert.throws(() => f.manager.get('absent'), { code: 'node_not_found' })
  const result = await f.manager.probe({
    host: '127.0.0.1',
    port: f.port,
    username: 'u',
    auth_type: 'password',
    password: 'old-password',
  })
  assert.equal(result.existing_id, 'node-a')
  assert.equal(result.host_key.sha256, f.sha256)
  assert.equal(result.docker.ok, true)
})

test('rename changes only metadata, even when the node has VMs or jump dependents', async (t) => {
  const f = await fixture(t, {
    assertNodeEditable: () => {
      throw new Error('must not run')
    },
  })
  slot(f)
  await f.repo.insert({
    ...(await f.repo.get('node-a')),
    id: 'node-b',
    port: f.port + 1,
    jump_node_id: 'node-a',
    password: 'pw',
  })
  const client = f.link.client
  const authCount = f.state.auth.length
  const before = await f.repo.get('node-a')
  const getSecrets = f.repo.getSecrets.bind(f.repo)
  f.repo.getSecrets = () => {
    throw new Error('stored credentials cannot be decrypted')
  }
  const probe = await f.manager.probeUpdate('node-a', await f.patch({ label: 'Renamed' }))
  assert.equal(probe.vm_count, 1)
  assert.equal(probe.dependent_count, 1)
  const result = await f.manager.update('node-a', await f.patch({ label: 'Renamed' }))
  assert.equal(result.label, 'Renamed')
  assert.equal(result.id, before.id)
  assert.equal(result.created_at, before.created_at)
  assert.equal(f.link.client, client)
  assert.equal(f.state.auth.length, authCount)
  assert.deepEqual(f.state.requests, [])
  assert.equal(JSON.stringify(result).includes('old-password'), false)
  assert.equal((await getSecrets('node-a')).password, 'old-password')
})

test('successful credential rotation revalidates on save, reuses the link and clears old shell tickets', async (t) => {
  const f = await fixture(t)
  const client = f.link.client
  const relayClient = () => (f.link.state === 'ready' ? f.link.client : null)
  const ticket = f.manager.issueShellTicket('node-a').ticket
  const patch = await f.patch({ password: 'new-password' })
  const preview = await f.manager.probeUpdate('node-a', patch)
  assert.deepEqual(preview.docker, { ok: true, error: null })
  assert.equal(preview.host_key.sha256, f.sha256)
  assert.equal(JSON.stringify(preview).includes('password'), false)
  assert.equal(f.link.client, client)
  const authCount = f.state.auth.length
  const result = await f.manager.update('node-a', patch)
  assert.ok(f.state.auth.length > authCount, 'save opens its own verified candidate')
  assert.equal(f.manager.links.get('node-a'), f.link)
  assert.notEqual(relayClient(), client)
  assert.equal((await f.repo.getSecrets('node-a')).password, 'new-password')
  assert.equal(result.link.state, 'ready')
  assert.equal(f.manager.consumeShellTicket(ticket, 'node-a'), false)
  assert.equal(await dockerPing(sshDocker(relayClient())), true)
  assert.equal(f.link.state, 'ready', 'the old client closing cannot put the adopted link in backoff')
})

test('a successful preview is not a credential authorization for a later save', async (t) => {
  const f = await fixture(t)
  const patch = await f.patch({ password: 'new-password' })
  await f.manager.probeUpdate('node-a', patch)
  f.state.passwords.delete('new-password')
  const client = f.link.client
  await assert.rejects(f.manager.update('node-a', patch), { code: 'auth_failed' })
  assert.equal(f.link.client, client)
  assert.equal((await f.repo.getSecrets('node-a')).password, 'old-password')
})

test('resubmitted saved credentials or equivalent endpoints are authenticated instead of trusting cached health', async (t) => {
  for (const ready of [true, false]) {
    await t.test(ready ? 'existing client remains ready' : 'old link is in error', async (t) => {
      const f = await fixture(t, { ready })
      if (!ready) f.link.state = 'error'
      f.state.passwords.delete('old-password')
      // A previously successful observation must not authorize a new request.
      f.manager.health.set('node-a', { docker: { ok: true, error: null } })
      const before = await f.repo.get('node-a')
      const client = f.link.client
      for (const change of [{ password: 'old-password' }, { host: ' 127.0.0.1 ' }, { port: String(f.port) }]) {
        const count = f.state.auth.length
        await assert.rejects(f.manager.probeUpdate('node-a', await f.patch(change)), { code: 'auth_failed' })
        await assert.rejects(f.manager.update('node-a', await f.patch(change)), { code: 'auth_failed' })
        assert.ok(f.state.auth.length > count)
        assert.deepEqual(await f.repo.get('node-a'), before)
        assert.equal(f.link.client, client)
      }
    })
  }
})

test('password to key rotation clears the saved password and remains usable', async (t) => {
  const f = await fixture(t)
  const userKey = key()
  f.state.publicKey = Buffer.from(userKey.public.split(' ')[1], 'base64')
  await f.manager.update('node-a', await f.patch({ auth_type: 'key', private_key: userKey.private }))
  assert.equal((await f.repo.get('node-a')).auth_type, 'key')
  assert.equal((await f.repo.getSecrets('node-a')).password, null)
  assert.equal((await f.repo.getSecrets('node-a')).privateKey, userKey.private.trim())
  assert.equal(f.link.state, 'ready')
})

test('candidate authentication failure leaves saved credentials and old connection intact', async (t) => {
  const f = await fixture(t)
  const before = await f.repo.get('node-a')
  const client = f.link.client
  await assert.rejects(f.manager.update('node-a', await f.patch({ password: 'wrong' })), { code: 'auth_failed' })
  assert.deepEqual(await f.repo.get('node-a'), before)
  assert.equal((await f.repo.getSecrets('node-a')).password, 'old-password')
  assert.equal(f.link.client, client)
  await dockerPing(sshDocker(client))
})

test('changed endpoints must have the saved host key before credentials are offered', async (t) => {
  const f = await fixture(t)
  const impostor = await sshHost(t)
  const client = f.link.client
  await assert.rejects(f.manager.update('node-a', await f.patch({ port: impostor.port })), {
    code: 'host_key_mismatch',
  })
  assert.deepEqual(impostor.state.auth, [])
  assert.equal((await f.repo.get('node-a')).port, f.port)
  assert.equal(f.link.client, client)
  const sameHost = await sshHost(t, { hostKey: f.hostKey })
  await f.manager.update('node-a', await f.patch({ port: sameHost.port }))
  assert.equal((await f.repo.get('node-a')).port, sameHost.port)
})

test('empty nodes can change username and save without Docker, but existing slots require Docker', async (t) => {
  const f = await fixture(t)
  f.state.username = 'nextuser'
  f.state.docker = false
  const patch = await f.patch({ username: 'nextuser' })
  const probe = await f.manager.probeUpdate('node-a', patch)
  assert.equal(probe.docker.ok, false)
  await f.manager.update('node-a', patch)
  assert.equal((await f.repo.get('node-a')).username, 'nextuser')
  slot(f)
  const client = f.link.client
  await assert.rejects(f.manager.update('node-a', await f.patch({ password: 'new-password' })), {
    code: 'node_runtime_mismatch',
  })
  await assert.rejects(f.manager.update('node-a', await f.patch({ username: 'third' })), {
    code: 'node_username_in_use',
  })
  assert.equal(f.link.client, client)
})

test('VM identity and Docker/KVM mount roots are verified without changing containers or files', async (t) => {
  for (const runtime of ['docker', 'kvm']) {
    await t.test(runtime, async (t) => {
      const f = await fixture(t)
      const vm = slot(f, runtime)
      const snapshot = JSON.stringify(vm)
      await f.manager.update('node-a', await f.patch({ password: 'new-password' }))
      assert.equal(JSON.stringify(vm), snapshot)
      assert.ok(f.state.requests.every(([method]) => method === 'GET'))
      assert.ok(f.state.commands.every((command) => command.startsWith('sh -c ') || command.startsWith('test -d ')))
      f.state.containers.get('container-a').Mounts[0].Source = '/elsewhere/run'
      const client = f.link.client
      await assert.rejects(f.manager.update('node-a', await f.patch({ password: 'old-password' })), {
        code: 'node_runtime_mismatch',
      })
      assert.equal(f.link.client, client)
    })
  }
})

test('changed HOME, UID/GID, missing container or directories reject an attached-node edit', async (t) => {
  for (const change of ['home', 'uid', 'gid', 'container', 'directories']) {
    await t.test(change, async (t) => {
      const f = await fixture(t)
      slot(f)
      await f.manager.remoteHost('node-a')
      if (change === 'home') f.state.home = '/other'
      if (change === 'uid') f.state.uid = 999
      if (change === 'gid') f.state.gid = 999
      if (change === 'container') f.state.containers.clear()
      if (change === 'directories') f.state.directories = false
      const before = await f.repo.get('node-a')
      const client = f.link.client
      await assert.rejects(f.manager.update('node-a', await f.patch({ password: 'new-password' })), {
        code: 'node_runtime_mismatch',
      })
      assert.deepEqual(await f.repo.get('node-a'), before)
      assert.equal(f.link.client, client)
    })
  }
})

test('a disconnected node can recover using its pinned identity and recorded runtime', async (t) => {
  const f = await fixture(t, { ready: false })
  slot(f)
  await f.manager.update('node-a', await f.patch({ password: 'new-password' }))
  assert.equal(f.link.state, 'ready')
  assert.equal((await f.repo.getSecrets('node-a')).password, 'new-password')
})

test('connection updates reject jump dependents, duplicate endpoints and busy installs before connecting', async (t) => {
  const f = await fixture(t)
  const next = { ...(await f.repo.get('node-a')), id: 'node-b', port: f.port + 1, password: 'pw' }
  await f.repo.insert({ ...next, jump_node_id: 'node-a' })
  const count = f.state.auth.length
  await assert.rejects(f.manager.update('node-a', await f.patch({ password: 'new-password' })), { code: 'node_in_use' })
  await f.repo.remove('node-b')
  await f.repo.insert(next)
  await assert.rejects(f.manager.update('node-a', await f.patch({ port: next.port })), { code: 'node_exists' })
  f.manager.installs.set('node-a', { status: 'running' })
  await assert.rejects(f.manager.update('node-a', await f.patch({ password: 'new-password' })), { code: 'node_busy' })
  assert.equal(f.state.auth.length, count)
})

test('stale edits and database failures do not replace a working link', async (t) => {
  const f = await fixture(t)
  const stale = await f.patch({ password: 'new-password' })
  await f.manager.update('node-a', await f.patch({ label: 'new label' }))
  await assert.rejects(f.manager.probeUpdate('node-a', stale), { code: 'node_edit_conflict' })
  await assert.rejects(f.manager.update('node-a', stale), { code: 'node_edit_conflict' })
  const client = f.link.client
  const before = await f.repo.get('node-a')
  f.repo.update = () => {
    throw new Error('write failed')
  }
  await assert.rejects(f.manager.update('node-a', await f.patch({ password: 'new-password' })), /write failed/)
  assert.deepEqual(await f.repo.get('node-a'), before)
  assert.equal(f.link.client, client)
  await dockerPing(sshDocker(client))
})

test('the final guard rejects a node that becomes busy while its candidate is checked', async (t) => {
  let busy = false
  const f = await fixture(t, {
    assertNodeEditable: () => {
      if (busy) throw new ClusterError(409, 'node_busy', 'busy')
    },
  })
  const entered = defer(),
    release = defer()
  f.state.onPing = async () => {
    entered.resolve()
    await release.promise
  }
  const client = f.link.client
  const pending = f.manager.update('node-a', await f.patch({ password: 'new-password' }))
  const rejected = assert.rejects(pending, { code: 'node_busy' })
  await entered.promise
  busy = true
  release.resolve()
  await rejected
  assert.equal(f.link.client, client)
  assert.equal((await f.repo.getSecrets('node-a')).password, 'old-password')
})

test('reconnect, removal and another save during verification cannot resurrect stale configuration', async (t) => {
  for (const action of ['reconnect', 'remove', 'rename', 'placement']) {
    await t.test(action, async (t) => {
      const f = await fixture(t)
      const entered = defer(),
        release = defer()
      f.state.onPing = async () => {
        entered.resolve()
        await release.promise
      }
      const pending = f.manager.update('node-a', await f.patch({ password: 'new-password' }))
      const rejected = assert.rejects(pending, { code: action === 'remove' ? 'node_not_found' : 'node_edit_conflict' })
      await entered.promise
      if (action === 'reconnect') f.manager.reconnect('node-a')
      if (action === 'remove') await f.manager.remove('node-a')
      if (action === 'rename') await f.manager.update('node-a', await f.patch({ label: 'concurrent' }))
      if (action === 'placement') f.vms.push({ id: 'new-vm' })
      release.resolve()
      await rejected
      if (action !== 'remove') assert.equal((await f.repo.getSecrets('node-a')).password, 'old-password')
      else assert.equal(await f.repo.get('node-a'), null)
    })
  }
})

test('reconnect during the database compare-and-swap rolls back credentials and closes the candidate', async (t) => {
  const f = await fixture(t)
  const before = await f.repo.get('node-a')
  const entered = defer(),
    release = defer(),
    closed = defer()
  const update = f.repo.update.bind(f.repo)
  f.repo.update = async (...args) => {
    const saved = await update(...args)
    entered.resolve()
    await release.promise
    return saved
  }
  const probe = f.manager._probeEdit.bind(f.manager)
  f.manager._probeEdit = async (...args) => {
    const candidate = await probe(...args)
    candidate.client.once('close', closed.resolve)
    return candidate
  }
  const pending = f.manager.update('node-a', await f.patch({ password: 'new-password' }))
  const rejected = assert.rejects(pending, { code: 'node_edit_conflict' })
  await entered.promise
  f.manager.reconnect('node-a')
  release.resolve()
  await rejected
  await Promise.race([
    closed.promise,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('candidate was not closed')), 1500)
      timer.unref?.()
    }),
  ])
  assert.deepEqual(await f.repo.get('node-a'), before)
  assert.equal((await f.repo.getSecrets('node-a')).password, 'old-password')
})
