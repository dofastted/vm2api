import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { connectUnixSocket, unixTransportOf } from '../../src/lib/cluster/ssh-link.mjs'

function chan() { const c = new EventEmitter(); c.close = () => c.emit('close'); return c }
function fakeClient({ streamlocal, tools = '', failExec = [] }) {
  const calls = []
  return {
    calls,
    openssh_forwardOutStreamLocal(path, cb) {
      calls.push(['streamlocal', path])
      streamlocal ? cb(null, chan()) : cb(new Error('administratively prohibited'))
    },
    exec(cmd, cb) {
      calls.push(['exec', cmd])
      const c = chan(); c.stderr = new EventEmitter()
      if (cmd.startsWith('command -v')) {
        cb(null, c); setImmediate(() => { c.emit('data', Buffer.from(tools)); c.emit('exit', 0); c.emit('close') }); return
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
  const c = fakeClient({ streamlocal: false, tools: '/usr/bin/docker\n/usr/bin/nc\n' })
  await connectUnixSocket(c, '/var/run/docker.sock', { docker: true })
  assert.equal(unixTransportOf(c), 'docker-dial-stdio')
  const again = await connectUnixSocket(c, '/var/run/docker.sock', { docker: true })
  assert.ok(again)
  assert.equal(c.calls.filter((x) => x[0] === 'streamlocal').length, 1) // remembered, no re-probe
})
test('non-docker sockets use socat before nc, and docker is not used for them', async () => {
  const c = fakeClient({ streamlocal: false, tools: '/usr/bin/docker\n/usr/bin/socat\n' })
  await connectUnixSocket(c, '/run/x.sock')
  assert.equal(unixTransportOf(c), 'socat')
})
test('moves to the next bridge when one exits immediately, rethrows if none work', async () => {
  const c = fakeClient({ streamlocal: false, tools: '/usr/bin/docker\n/usr/bin/nc\n', failExec: ['dial-stdio'] })
  await connectUnixSocket(c, '/var/run/docker.sock', { docker: true })
  assert.equal(unixTransportOf(c), 'nc')
  const d = fakeClient({ streamlocal: false, tools: '' })
  await assert.rejects(connectUnixSocket(d, '/var/run/docker.sock', { docker: true }), { code: 'streamlocal_failed' })
})
