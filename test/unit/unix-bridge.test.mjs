import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { connectUnixSocket, unixTransportOf } from '../../src/lib/cluster/ssh-link.mjs'

function chan() {
  const c = new EventEmitter()
  c.close = () => c.emit('close')
  return c
}
function fakeClient({ streamlocal, tools = '', failExec = [], refuseReason = 'ADMINISTRATIVELY_PROHIBITED' }) {
  const calls = []
  return {
    calls,
    failExec,
    openssh_forwardOutStreamLocal(path, cb) {
      calls.push(['streamlocal', path])
      streamlocal
        ? cb(null, chan())
        : cb(Object.assign(new Error('administratively prohibited'), { reason: refuseReason }))
    },
    exec(cmd, cb) {
      calls.push(['exec', cmd])
      const c = chan()
      c.stderr = new EventEmitter()
      if (cmd.startsWith('command -v')) {
        cb(null, c)
        setImmediate(() => {
          c.emit('data', Buffer.from(tools))
          c.emit('exit', 0)
          c.emit('close')
        })
        return
      }
      cb(null, c)
      if (failExec.some((f) => cmd.includes(f))) setImmediate(() => c.emit('exit', 127))
    },
  }
}

test('uses streamlocal when sshd allows it', async () => {
  const c = fakeClient({ streamlocal: true })
  await connectUnixSocket(c, '/var/run/docker.sock', { docker: true })
  assert.equal(unixTransportOf(c), 'streamlocal')
  assert.equal(c.calls.filter((x) => x[0] === 'exec').length, 0)
})
test('falls back to docker dial-stdio when streamlocal is refused', async () => {
  const c = fakeClient({ streamlocal: false, tools: '/usr/bin/docker\n/usr/bin/nc\nnc-N\n' })
  await connectUnixSocket(c, '/var/run/docker.sock', { docker: true })
  assert.equal(unixTransportOf(c), 'docker-dial-stdio')
  const again = await connectUnixSocket(c, '/var/run/docker.sock', { docker: true })
  assert.ok(again)
  assert.equal(c.calls.filter((x) => x[0] === 'streamlocal').length, 1) // remembered, no re-probe
})
test('non-docker sockets use socat before nc, and docker is not used for them', async () => {
  const c = fakeClient({ streamlocal: false, tools: '/usr/bin/docker\n/usr/bin/socat\n' })
  await connectUnixSocket(c, '/run/x.sock')
  const execs = c.calls.filter((x) => x[0] === 'exec').map((x) => x[1])
  assert.ok(execs.some((x) => x.startsWith('exec socat -')))
  assert.ok(!execs.includes('exec docker system dial-stdio'))
})
test('moves to the next bridge when one exits immediately, rethrows if none work', async () => {
  const c = fakeClient({ streamlocal: false, tools: '/usr/bin/docker\n/usr/bin/nc\nnc-N\n', failExec: ['dial-stdio'] })
  await connectUnixSocket(c, '/var/run/docker.sock', { docker: true })
  assert.equal(unixTransportOf(c), 'nc')
  const d = fakeClient({ streamlocal: false, tools: '' })
  await assert.rejects(connectUnixSocket(d, '/var/run/docker.sock', { docker: true }), { code: 'streamlocal_failed' })
})

test('a Docker bridge is never reused for another socket (relay after Docker op)', async () => {
  const c = fakeClient({ streamlocal: false, tools: '/usr/bin/docker\n' })
  await connectUnixSocket(c, '/var/run/docker.sock', { docker: true })
  assert.equal(unixTransportOf(c), 'docker-dial-stdio')
  // docker-only node: relay to another socket has no usable bridge and must fail, not hit Docker
  await assert.rejects(connectUnixSocket(c, '/run/kin/kernel.sock'), { code: 'streamlocal_failed' })
  assert.equal(c.calls.filter((x) => x[0] === 'exec' && x[1] === 'exec docker system dial-stdio').length, 1)
})
test('relay and Docker keep separate transports; paths are remembered independently', async () => {
  const c = fakeClient({ streamlocal: false, tools: '/usr/bin/docker\n/usr/bin/socat\n' })
  await connectUnixSocket(c, '/var/run/docker.sock', { docker: true })
  await connectUnixSocket(c, '/run/a.sock')
  await connectUnixSocket(c, '/run/b.sock')
  const execs = c.calls.filter((x) => x[0] === 'exec').map((x) => x[1])
  assert.ok(execs.includes('exec docker system dial-stdio'))
  assert.ok(execs.some((x) => x.includes("UNIX-CONNECT:'/run/a.sock'")))
  assert.ok(execs.some((x) => x.includes("UNIX-CONNECT:'/run/b.sock'")))
  assert.equal(unixTransportOf(c), 'docker-dial-stdio')
})
test('a remembered bridge that stops working is dropped and re-probed', async () => {
  const c = fakeClient({ streamlocal: false, tools: '/usr/bin/socat\n/usr/bin/nc\nnc-N\n' })
  await connectUnixSocket(c, '/run/a.sock')
  c.failExec.push('socat')
  await connectUnixSocket(c, '/run/a.sock')
  assert.ok(c.calls.some((x) => x[0] === 'exec' && x[1].startsWith('exec nc -N -U')))
})

test('a missing socket (CONNECT_FAILED) is reported as is, without burning a bridge session', async () => {
  const c = fakeClient({
    streamlocal: false,
    tools: '/usr/bin/docker\n/usr/bin/socat\n',
    refuseReason: 'CONNECT_FAILED',
  })
  await assert.rejects(connectUnixSocket(c, '/run/kin/kernel.sock'), { code: 'streamlocal_failed' })
  assert.equal(c.calls.filter((x) => x[0] === 'exec').length, 0)
})
test('nc without -N is never used (it would outlive the stream and leak a session)', async () => {
  const c = fakeClient({ streamlocal: false, tools: '/usr/bin/nc\n' })
  await assert.rejects(connectUnixSocket(c, '/run/a.sock'), { code: 'streamlocal_failed' })
  assert.ok(!c.calls.some((x) => x[0] === 'exec' && x[1].startsWith('exec nc')))
})
test('bridge sessions are capped per link and freed when a stream closes', async () => {
  const c = fakeClient({ streamlocal: false, tools: '/usr/bin/socat\n' })
  const open = []
  for (let i = 0; i < 6; i++) open.push(await connectUnixSocket(c, `/run/s${i}.sock`))
  let seventh = false
  const p = connectUnixSocket(c, '/run/s6.sock').then((st) => ((seventh = true), st))
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(seventh, false) // waits instead of opening a 7th session
  open[0].close()
  await p
  assert.equal(seventh, true)
})
