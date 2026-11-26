import test from 'node:test'
import assert from 'node:assert/strict'
import { ProxyPool, isRemoteSocksProbeRow } from '../../src/lib/vm/proxy-pool.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'

function makePool(t) {
  const pool = new ProxyPool({ db: openDatabase({ dbPath: ':memory:' }) })
  pool.updateConfig({ enabled: false })
  t.after(() => {
    pool.stopScheduler()
    closeDatabase()
  })
  return pool
}

test('isRemoteSocksProbeRow flags public SOCKS rows but not loopback forwarders', () => {
  assert.equal(isRemoteSocksProbeRow({ scheme: 'socks5', host: '203.0.113.10', port: 1080, enabled: true }), true)
  assert.equal(isRemoteSocksProbeRow({ scheme: 'socks5', host: '127.0.0.1', port: 1080, enabled: true }), false)
  assert.equal(isRemoteSocksProbeRow({ scheme: 'http', host: '203.0.113.10', port: 8080, enabled: true }), false)
})

test('probeAll serializes remote SOCKS rows with a stagger gap', async (t) => {
  const pool = makePool(t)
  const {
    items: [remoteA, remoteB, remoteC],
  } = pool.importLines(
    ['socks5h://203.0.113.11:1080', 'socks5h://203.0.113.12:1080', 'socks5h://203.0.113.13:1080'].join('\n'),
  )
  const local = pool.importLines('socks5h://127.0.0.1:1080').items[0]
  assert.ok([remoteA, remoteB, remoteC, local].every((row) => pool.state.proxies.find((p) => p.id === row.id)))

  const marks = []
  pool._probeAndApply = async (p) => {
    marks.push({ id: p.id, at: Date.now(), remote: isRemoteSocksProbeRow(p) })
    p.status = 'ok'
    p.last_error = null
    return { ok: true, scope: 'socks', latency_ms: 1 }
  }

  await pool.probeAll({ onlyEnabled: true })

  const remoteMarks = marks.filter((m) => m.remote)
  assert.equal(remoteMarks.length, 3)
  for (let i = 1; i < remoteMarks.length; i++) {
    assert.ok(
      remoteMarks[i].at - remoteMarks[i - 1].at >= 350,
      `expected stagger between ${remoteMarks[i - 1].id} and ${remoteMarks[i].id}`,
    )
  }
  const localMark = marks.find((m) => !m.remote)
  assert.ok(localMark)
  assert.ok(localMark.at <= remoteMarks[0].at, 'local batch should finish before remote wave begins')
})
