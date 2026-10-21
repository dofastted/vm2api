import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

async function makePool() {
  const pool = await new ProxyPool({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kin-px-upd-')) }).init()
  pool.stopScheduler()
  return pool
}
function seed(pool, line = 'socks5://alice:s3cret@1.2.3.4:1080') {
  pool.importLines(line)
  return pool.state.proxies[0]
}

test('update: 只改 port，账密保留；raw 明文密码被清除', async () => {
  const pool = await makePool()
  const p = seed(pool)
  assert.match(p.raw, /s3cret/, '前提：导入后 raw 含明文密码')
  const r = pool.update(p.id, { port: 1081 })
  assert.equal(r.ok, true)
  assert.equal(p.port, 1081)
  assert.equal(p.username, 'alice')
  assert.equal(p.password, 's3cret')
  assert.equal(p.raw, '1.2.3.4:1081')
  assert.doesNotMatch(p.raw, /s3cret/, 'raw 不应再含明文密码')
})

test('update: username 传空串清除账密（password 一并清）', async () => {
  const pool = await makePool()
  const p = seed(pool)
  assert.equal(pool.update(p.id, { username: '' }).ok, true)
  assert.equal(p.username, null)
  assert.equal(p.password, null)
})

test('update: 不传的字段保持不动', async () => {
  const pool = await makePool()
  const p = seed(pool)
  pool.update(p.id, { password: 'newpw' })
  assert.equal(p.host, '1.2.3.4')
  assert.equal(p.port, 1080)
  assert.equal(p.username, 'alice')
  assert.equal(p.password, 'newpw')
})

test('update: 只给密码不给用户名被拒，不静默存成「仍无账密」', async () => {
  const pool = await makePool()
  pool.importLines('9.9.9.9:1080')
  const p = pool.state.proxies[0]
  assert.equal(p.username, null, '前提：这条本来没有账密')
  assert.equal(pool.update(p.id, { password: 'onlypw' }).error, 'password_without_username')
  assert.equal(p.password, null, '被拒后不留半套账密')
  // 清了账密还想在同一次请求里设密码，同样是无效组合
  assert.equal(pool.update(p.id, { username: '', password: 'x' }).error, 'password_without_username')
})

test('update: 只换用户名时沿用原密码（不传的键就是不动）', async () => {
  const pool = await makePool()
  const p = seed(pool)
  assert.equal(pool.update(p.id, { username: 'bob' }).ok, true)
  assert.equal(p.username, 'bob')
  assert.equal(p.password, 's3cret', 'password 没传，按语义保持原值')
})

test('update: 非法值与空 patch 被拒，且不改动原记录', async () => {
  const pool = await makePool()
  const p = seed(pool)
  assert.equal(pool.update(p.id, { port: 99999 }).error, 'invalid_proxy')
  assert.equal(pool.update(p.id, { host: '' }).error, 'invalid_proxy')
  assert.equal(pool.update(p.id, {}).error, 'no_editable_fields')
  assert.equal(pool.update('nope', { port: 1080 }).error, 'proxy_not_found')
  assert.equal(p.port, 1080, '被拒后原值不变')
})

test('update: 响应里的 publicProxy 不含账密', async () => {
  const pool = await makePool()
  const p = seed(pool)
  const r = pool.update(p.id, { port: 1081 })
  const s = JSON.stringify(r.proxy)
  assert.doesNotMatch(s, /alice|s3cret|password|username/, 'update 响应不得泄漏账密')
  assert.equal(r.proxy.has_auth, true, '但要能看出有账密')
})

test('getProxyByIdWithAuth: 拼出完整 URI，特殊字符转义', async () => {
  const pool = await makePool()
  const p = seed(pool)
  assert.equal(pool.getProxyByIdWithAuth(p.id).url, 'socks5://alice:s3cret@1.2.3.4:1080')
  pool.update(p.id, { username: 'u@x', password: 'p:w/d' })
  assert.equal(pool.getProxyByIdWithAuth(p.id).url, 'socks5://u%40x:p%3Aw%2Fd@1.2.3.4:1080')
  pool.update(p.id, { username: '' })
  assert.equal(pool.getProxyByIdWithAuth(p.id).url, 'socks5://1.2.3.4:1080', '无账密时不带 @')
})

test('getProxyByIdWithAuth: 禁用/失效的代理仍可读回（getProxyForVm 做不到）', async () => {
  const pool = await makePool()
  const p = seed(pool)
  pool.bind(p.id, 'vm-01')
  assert.ok(pool.getProxyForVm('vm-01'), '前提：启用时 getProxyForVm 能取到')
  pool.setEnabled(p.id, false)
  assert.equal(pool.getProxyForVm('vm-01'), null, 'getProxyForVm 对禁用代理返回 null')
  assert.equal(pool.getProxyByIdWithAuth(p.id).url, 'socks5://alice:s3cret@1.2.3.4:1080', '新方法不受影响')
})

test('snapshot 回归：列表接口永不返回账密', async () => {
  const pool = await makePool()
  seed(pool)
  const s = JSON.stringify(pool.snapshot())
  assert.doesNotMatch(s, /alice|s3cret|socks5:\/\//, 'GET /proxies 的载荷不得含账密')
})

test('update: 只改代理名称不动连接字段，也不要求重载槽位；重开后名称仍在', async () => {
  const pool = await makePool()
  const p = seed(pool)
  const r = pool.update(p.id, { label: '  东京-2 号机  ' })
  assert.equal(r.ok, true)
  assert.equal(r.connection_changed, false)
  assert.equal(r.proxy.label, '东京-2 号机')
  assert.equal(p.raw, 'socks5://alice:s3cret@1.2.3.4:1080', '只改名称不应改写 raw')
  await pool.load()
  assert.equal(pool.state.proxies[0].label, '东京-2 号机')
  assert.equal(pool.snapshot().proxies[0].label, '东京-2 号机')
})

test('update: 代理名称传空串清除；超长或非字符串被拒', async () => {
  const pool = await makePool()
  const p = seed(pool)
  pool.update(p.id, { label: 'a' })
  assert.equal(pool.update(p.id, { label: '' }).proxy.label, null)
  assert.equal(pool.update(p.id, { label: 'x'.repeat(65) }).error, 'label_too_long')
  assert.equal(pool.update(p.id, { label: 123 }).error, 'invalid_label')
})

test('update: 连接字段与名称同改时报告 connection_changed', async () => {
  const pool = await makePool()
  const p = seed(pool)
  const r = pool.update(p.id, { port: 1082, label: 'box' })
  assert.equal(r.connection_changed, true)
  assert.equal(p.port, 1082)
  assert.equal(p.label, 'box')
})

test('labelOf 只给名称，不带账密；未知代理返回 null', async () => {
  const pool = await makePool()
  const p = seed(pool)
  assert.equal(pool.labelOf(p.id), null)
  pool.update(p.id, { label: 'tw-box' })
  assert.equal(pool.labelOf(p.id), 'tw-box')
  assert.equal(pool.labelOf('px-missing'), null)
})
