import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

function makePool() {
  const pool = new ProxyPool({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kin-px-upd-')) })
  pool.stopScheduler()
  return pool
}
function seed(pool, line = 'socks5://alice:s3cret@1.2.3.4:1080') {
  pool.importLines(line)
  return pool.state.proxies[0]
}

test('update: 只改 port，账密保留；raw 明文密码被清除', () => {
  const pool = makePool()
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

test('update: username 传空串清除账密（password 一并清）', () => {
  const pool = makePool()
  const p = seed(pool)
  assert.equal(pool.update(p.id, { username: '' }).ok, true)
  assert.equal(p.username, null)
  assert.equal(p.password, null)
})

test('update: 不传的字段保持不动', () => {
  const pool = makePool()
  const p = seed(pool)
  pool.update(p.id, { password: 'newpw' })
  assert.equal(p.host, '1.2.3.4')
  assert.equal(p.port, 1080)
  assert.equal(p.username, 'alice')
  assert.equal(p.password, 'newpw')
})

test('update: 只给密码不给用户名被拒，不静默存成「仍无账密」', () => {
  const pool = makePool()
  pool.importLines('9.9.9.9:1080')
  const p = pool.state.proxies[0]
  assert.equal(p.username, null, '前提：这条本来没有账密')
  assert.equal(pool.update(p.id, { password: 'onlypw' }).error, 'password_without_username')
  assert.equal(p.password, null, '被拒后不留半套账密')
  // 清了账密还想在同一次请求里设密码，同样是无效组合
  assert.equal(pool.update(p.id, { username: '', password: 'x' }).error, 'password_without_username')
})

test('update: 只换用户名时沿用原密码（不传的键就是不动）', () => {
  const pool = makePool()
  const p = seed(pool)
  assert.equal(pool.update(p.id, { username: 'bob' }).ok, true)
  assert.equal(p.username, 'bob')
  assert.equal(p.password, 's3cret', 'password 没传，按语义保持原值')
})

test('update: 非法值与空 patch 被拒，且不改动原记录', () => {
  const pool = makePool()
  const p = seed(pool)
  assert.equal(pool.update(p.id, { port: 99999 }).error, 'invalid_proxy')
  assert.equal(pool.update(p.id, { host: '' }).error, 'invalid_proxy')
  assert.equal(pool.update(p.id, {}).error, 'no_editable_fields')
  assert.equal(pool.update('nope', { port: 1080 }).error, 'proxy_not_found')
  assert.equal(p.port, 1080, '被拒后原值不变')
})

test('update: 响应里的 publicProxy 不含账密', () => {
  const pool = makePool()
  const p = seed(pool)
  const r = pool.update(p.id, { port: 1081 })
  const s = JSON.stringify(r.proxy)
  assert.doesNotMatch(s, /alice|s3cret|password|username/, 'update 响应不得泄漏账密')
  assert.equal(r.proxy.has_auth, true, '但要能看出有账密')
})

test('getProxyByIdWithAuth: 拼出完整 URI，特殊字符转义', () => {
  const pool = makePool()
  const p = seed(pool)
  assert.equal(pool.getProxyByIdWithAuth(p.id).url, 'socks5://alice:s3cret@1.2.3.4:1080')
  pool.update(p.id, { username: 'u@x', password: 'p:w/d' })
  assert.equal(pool.getProxyByIdWithAuth(p.id).url, 'socks5://u%40x:p%3Aw%2Fd@1.2.3.4:1080')
  pool.update(p.id, { username: '' })
  assert.equal(pool.getProxyByIdWithAuth(p.id).url, 'socks5://1.2.3.4:1080', '无账密时不带 @')
})

test('getProxyByIdWithAuth: 禁用/失效的代理仍可读回（getProxyForVm 做不到）', () => {
  const pool = makePool()
  const p = seed(pool)
  pool.bind(p.id, 'vm-01')
  assert.ok(pool.getProxyForVm('vm-01'), '前提：启用时 getProxyForVm 能取到')
  pool.setEnabled(p.id, false)
  assert.equal(pool.getProxyForVm('vm-01'), null, 'getProxyForVm 对禁用代理返回 null')
  assert.equal(pool.getProxyByIdWithAuth(p.id).url, 'socks5://alice:s3cret@1.2.3.4:1080', '新方法不受影响')
})

test('domain_forward: 开关要带到 kin-egress 用的代理对象上（两条取法都要）', () => {
  const pool = makePool()
  const p = seed(pool)
  pool.bind(p.id, 'vm-01')
  assert.equal(pool.getProxyByIdWithAuth(p.id).domain_forward, false, '默认关闭')
  assert.equal(pool.getProxyForVm('vm-01').domain_forward, false)

  const r = pool.update(p.id, { domain_forward: true })
  assert.equal(r.ok, true)
  assert.equal(r.domain_forward_changed, true)
  assert.equal(pool.getProxyByIdWithAuth(p.id).domain_forward, true, '面板改开关后重启出口用的就是它')
  assert.equal(pool.getProxyForVm('vm-01').domain_forward, true, '槽位启动/修复出口用的是它')

  pool.update(p.id, { domain_forward: false })
  assert.equal(pool.getProxyByIdWithAuth(p.id).domain_forward, false)
})

test('snapshot 回归：列表接口永不返回账密', () => {
  const pool = makePool()
  seed(pool)
  const s = JSON.stringify(pool.snapshot())
  assert.doesNotMatch(s, /alice|s3cret|socks5:\/\//, 'GET /proxies 的载荷不得含账密')
})

test('update: 只改代理名称不动连接字段，也不要求重载槽位；重开后名称仍在', () => {
  const pool = makePool()
  const p = seed(pool)
  const r = pool.update(p.id, { label: '  东京-2 号机  ' })
  assert.equal(r.ok, true)
  assert.equal(r.connection_changed, false)
  assert.equal(r.proxy.label, '东京-2 号机')
  assert.equal(p.raw, 'socks5://alice:s3cret@1.2.3.4:1080', '只改名称不应改写 raw')
  pool.load()
  assert.equal(pool.state.proxies[0].label, '东京-2 号机')
  assert.equal(pool.snapshot().proxies[0].label, '东京-2 号机')
})

test('update: 代理名称传空串清除；超长或非字符串被拒', () => {
  const pool = makePool()
  const p = seed(pool)
  pool.update(p.id, { label: 'a' })
  assert.equal(pool.update(p.id, { label: '' }).proxy.label, null)
  assert.equal(pool.update(p.id, { label: 'x'.repeat(65) }).error, 'label_too_long')
  assert.equal(pool.update(p.id, { label: 123 }).error, 'invalid_label')
})

test('update: 连接字段与名称同改时报告 connection_changed', () => {
  const pool = makePool()
  const p = seed(pool)
  const r = pool.update(p.id, { port: 1082, label: 'box' })
  assert.equal(r.connection_changed, true)
  assert.equal(p.port, 1082)
  assert.equal(p.label, 'box')
})

test('labelOf 只给名称，不带账密；未知代理返回 null', () => {
  const pool = makePool()
  const p = seed(pool)
  assert.equal(pool.labelOf(p.id), null)
  pool.update(p.id, { label: 'tw-box' })
  assert.equal(pool.labelOf(p.id), 'tw-box')
  assert.equal(pool.labelOf('px-missing'), null)
})

test('update: scheme 可在 socks5 / http 间切换，算连接变更，账密保留', () => {
  const pool = makePool()
  const p = seed(pool)
  const r = pool.update(p.id, { scheme: 'http' })
  assert.equal(r.ok, true)
  assert.equal(r.connection_changed, true)
  assert.equal(p.scheme, 'http')
  assert.equal(r.proxy.scheme, 'http')
  assert.equal(p.username, 'alice')
  assert.equal(p.password, 's3cret')
  assert.equal(pool.update(p.id, { scheme: 'socks5h' }).ok, true)
  assert.equal(p.scheme, 'socks5', 'socks5h 归一为 socks5')
})

test('update: 非法 scheme 被拒，本地代理不能改协议', () => {
  const pool = makePool()
  const p = seed(pool)
  assert.equal(pool.update(p.id, { scheme: 'https' }).error, 'invalid_scheme')
  assert.equal(pool.update(p.id, { scheme: 'local' }).error, 'invalid_scheme')
  assert.equal(p.scheme, 'socks5', '被拒后原值不变')
  pool.ensureLocal()
  const lp = pool.state.proxies.find((x) => x.scheme === 'local')
  assert.ok(lp, '前提：已有本地代理')
  assert.equal(pool.update(lp.id, { scheme: 'http' }).error, 'scheme_unsupported')
})

test('importLines: defaultScheme 只作用于未写协议的行', () => {
  const pool = makePool()
  const r = pool.importLines('1.1.1.1:8080\nu:p@2.2.2.2:3128\nsocks5://3.3.3.3:1080', { defaultScheme: 'http' })
  assert.equal(r.added, 3)
  const by = Object.fromEntries(pool.state.proxies.map((x) => [x.host, x.scheme]))
  assert.deepEqual(by, { '1.1.1.1': 'http', '2.2.2.2': 'http', '3.3.3.3': 'socks5' })
  // 同端点不同协议不算重复
  assert.equal(pool.importLines('1.1.1.1:8080').added, 1)
})

test('update: 从库加载后改 scheme，重开仍是新协议（protocol 列不被旧值覆盖）', () => {
  const pool = makePool()
  seed(pool)
  pool.load()
  const p = pool.state.proxies[0]
  assert.equal(p.protocol, 'socks5', '前提：库里加载的行带 protocol 列')
  assert.equal(pool.update(p.id, { scheme: 'http' }).ok, true)
  pool.load()
  assert.equal(pool.state.proxies[0].scheme, 'http')
})
