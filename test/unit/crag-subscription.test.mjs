import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCragSubscription } from '../../src/lib/vm/crag-subscription.mjs'
import { createCragRuntimeInventory } from '../../src/lib/vm/crag-runtime-inventory.mjs'
import {
  checkCragLicense,
  cragLicenseDirectory,
  cragTargetIds,
  readCragSubscriptionFiles,
} from '../../src/lib/vm/crag-license.mjs'
import { publishKvmCragSubscription } from '../../src/lib/vm/kvm-crag-subscription.mjs'
import { cragSubscriptionPublicDirectory } from '../../src/lib/vm/crag-subscription-paths.mjs'
import { assertCragSubscriptionTarget } from '../../src/lib/vm/vm-runtime.mjs'
import { materializeCragV2 } from '../../src/lib/vm/wrap-cli-runtime.mjs'
import {
  activateFixture,
  issueHostEntitlement,
  issueSlotPermit,
  seedEncryptedPackage,
  signSubscriptionBytes,
} from '../fixtures/crag-license.mjs'
import { createCragSubscriptionHandler, cragSubscriptionRoute } from '../../src/lib/admin/crag-subscription-routes.mjs'

const voucher = () => `CRAGR1.${crypto.randomBytes(32).toString('base64url')}`

function standaloneHost(t, fetchImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-host-standalone-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const machineIdFile = path.join(root, 'machine-id')
  fs.writeFileSync(machineIdFile, crypto.randomBytes(16).toString('hex'), { mode: 0o600 })
  const publicDir = cragSubscriptionPublicDirectory(root)
  const privateDir = path.join(path.dirname(publicDir), 'private')
  fs.mkdirSync(path.dirname(path.dirname(publicDir)), { recursive: true })
  return {
    root,
    machineIdFile,
    publicDir,
    privateDir,
    connect: (options = {}) =>
      createCragSubscription({
        projectRoot: root,
        machineIdFile,
        listTargets: () => [],
        isSubscriptionSlot: () => false,
        isSlotEnabled: () => assert.fail('standalone redemption has no enabled VMs'),
        assertReady: () => assert.fail('standalone redemption must not probe any VM'),
        fetchImpl,
        ...options,
      }),
  }
}

test('host checkout falls back to the D-Bus machine ID without changing an existing binding', (t) => {
  const { root, machineIdFile, publicDir, connect } = standaloneHost(t)
  const alternate = path.join(root, 'dbus-machine-id')
  const service = connect({ machineIdFile: [machineIdFile, alternate] })
  const raw = '1234567890abcdef1234567890abcdef'
  const expected = crypto.createHash('sha256').update(`crag-host-v1:${raw}`).digest('hex')
  fs.writeFileSync(alternate, '12345678-90AB-CDEF-1234-567890ABCDEF\n', { mode: 0o600 })
  fs.writeFileSync(machineIdFile, 'uninitialized\n')
  assert.equal(service.purchaseDeviceId(), expected)

  fs.mkdirSync(publicDir, { recursive: true, mode: 0o755 })
  fs.writeFileSync(path.join(publicDir, 'host_id'), expected, { mode: 0o644 })
  fs.writeFileSync(machineIdFile, 'b'.repeat(32))
  assert.equal(service.purchaseDeviceId(), expected)

  fs.rmSync(alternate)
  assert.throws(() => service.purchaseDeviceId(), { code: 'crag_subscription_host_identity_changed' })
  fs.rmSync(machineIdFile)
  fs.symlinkSync(path.join(publicDir, 'host_id'), machineIdFile)
  assert.throws(() => service.purchaseDeviceId(), { code: 'crag_subscription_host_identity_unavailable' })
})

function postSubscription(subscription) {
  return (action, body) =>
    createCragSubscriptionHandler({
      subscription,
      json: (_, status, payload) => ({ status, ...payload }),
      readRawBody: () => Buffer.from(JSON.stringify(body)),
    })(
      {
        panelUser: 'owner',
        panelRole: 'admin',
        headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' },
      },
      { setHeader() {} },
      cragSubscriptionRoute('POST', `/api/panel/crag-subscription/${action}`),
    )
}

test('a legacy cluster slot can bind while stopped and reissue an old package permit on the same seat', async (t) => {
  const vm = { id: 'legacy_cluster-52', node_id: 'node-a', dataplane: 'wrap', status: 'stopped' }
  const requests = []
  let entitlement
  let inactive = true
  let projected = false
  const { root, connect } = standaloneHost(t, async (url, { body }) => {
    const request = JSON.parse(body)
    if (url.endsWith('/redeem')) entitlement = issueHostEntitlement(root, request.host_id, { slot_limit: 1 })
    const data = { entitlement: entitlement.code, ...entitlement.claims, used_slots: Number(requests.length > 0) }
    if (!url.endsWith('/bind')) return Response.json({ ok: true, data })
    if (inactive) return Response.json({ ok: false, error: { code: 'host_subscription_inactive' } }, { status: 403 })
    requests.push(request)
    if (!request.reissue) {
      return Response.json({ ok: false, error: { code: 'payload_key_conflict' } }, { status: 409 })
    }
    const permit = issueSlotPermit(root, request.machine_code, request.host_id, { seat: 1 })
    return Response.json({ ok: true, data: { ...data, seat: 1, slot_permit: permit.code } })
  })
  seedEncryptedPackage(root)
  fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', vm.id, 'machine-id'), crypto.randomBytes(16).toString('hex'))
  const service = connect({
    listTargets: () => [vm],
    assertReady: (target, options) => assertCragSubscriptionTarget(root, target, {}, options),
    runtimeInventory: { snapshot: async () => ({ host_over_limit: false }) },
    publishClusterBinding: async (projectRoot, target) => {
      assert.equal(projectRoot, root)
      assert.equal(target, vm)
      projected = true
    },
  })
  await service.redeem(voucher())
  for (const id of ['active', '../legacy_cluster-52']) {
    await assert.rejects(service.bind({ ...vm, id }), { code: 'crag_subscription_target_unready', status: 409 })
  }
  assert.deepEqual(await service.listOrderTargets(), [vm.id])
  await assert.rejects(service.bind(vm), { code: 'host_subscription_inactive', status: 403 })
  inactive = false
  assert.deepEqual(await service.bind(vm), { seat: 1 })
  assert.equal(projected, false)
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1], { ...requests[0], reissue: true })
  assert.equal((await service.status()).used_slots, 1)
  assert.equal(vm.dataplane, 'wrap')
  vm.dataplane = 'crag'
  assert.equal(checkCragLicense(root, vm).license.scope, 'host')
  assert.equal(await service.admitInference({ vm }), null)
  assert.equal(projected, false)
  vm.status = 'running'
  assert.equal(await service.admitInference({ vm }), null)
  assert.equal(projected, true)
})

test('Docker and KVM bind against the same redeemed pool without a version-specific redemption', async (t) => {
  const targets = [
    { id: 'docker-seat', dataplane: 'crag' },
    { id: 'kvm-seat', dataplane: 'crag', runtime_type: 'kvm' },
    { id: 'extra-seat', dataplane: 'crag', runtime_type: 'kvm', node_id: 'node-a' },
  ]
  const seats = new Map()
  let entitlement
  const projected = []
  const { root, connect } = standaloneHost(t, async (url, { body }) => {
    const request = JSON.parse(body)
    if (url.endsWith('/redeem')) {
      assert.deepEqual(Object.keys(request).sort(), ['host_id', 'redemption_code'])
      entitlement = issueHostEntitlement(root, request.host_id, { slot_limit: 2 })
    }
    let binding = {}
    if (url.endsWith('/bind')) {
      let seat = seats.get(request.machine_code)
      if (!seat && seats.size === 2) {
        return Response.json({ ok: false, error: { code: 'slot_limit_reached' } }, { status: 409 })
      }
      seat ??= seats.size + 1
      seats.set(request.machine_code, seat)
      binding = { seat, slot_permit: issueSlotPermit(root, request.machine_code, request.host_id, { seat }).code }
    }
    return Response.json({
      ok: true,
      data: { entitlement: entitlement.code, ...entitlement.claims, used_slots: seats.size, ...binding },
    })
  })
  seedEncryptedPackage(root)
  for (const vm of targets) {
    vm.fingerprint = { guest_machine_id: crypto.randomBytes(16).toString('hex') }
  }
  const service = connect({
    listTargets: () => targets,
    assertReady: (vm, options) => assertCragSubscriptionTarget(root, vm, {}, options),
    runtimeInventory: { snapshot: async () => ({ host_over_limit: false }) },
    blockKvmBinding: async () => true,
    publishKvmBinding: async (_, vm) => {
      if (vm.status !== 'running') return false
      projected.push(vm.id)
      return true
    },
  })
  assert.equal((await service.redeem(voucher())).available_seats, 2)
  assert.deepEqual(await service.bind(targets[0]), { seat: 1 })
  assert.deepEqual(await service.bind(targets[1]), { seat: 2 })
  assert.equal(checkCragLicense(root, targets[1]).license.scope, 'host')
  assert.equal((await service.status()).available_seats, 0)
  await assert.rejects(service.bind(targets[2]), { code: 'slot_limit_reached' })
  targets[1].status = 'running'
  assert.equal(await service.admitInference({ vm: targets[1] }), null)
  assert.deepEqual(projected, [targets[1].id])
})

test('KVM entitlement changes block old copies, serialize publishers and recover failed guest delivery', async (t) => {
  const vm = {
    id: 'vm-51',
    dataplane: 'crag',
    status: 'running',
    runtime: { type: 'kvm' },
    fingerprint: { guest_machine_id: crypto.randomBytes(16).toString('hex') },
  }
  let service, rights, copy
  let bound = false
  let blocked = false
  let blockFails = false
  let publishFails = false
  let authorityRejects = false
  let renewDuringPublish = false
  let mutations = 0
  const { root, connect, publicDir } = standaloneHost(t, async (url, { body }) => {
    const request = JSON.parse(body)
    if (url.endsWith('/redeem')) {
      if (bound) {
        assert.equal(blocked, true, 'the running guest is blocked before the Authority changes rights')
        assert.equal((await service.admitInference({ vm })).body.error.code, 'license_crag_host_usage_unverified')
        await assert.rejects(
          publishKvmCragSubscription(root, vm, {
            runDockerExec: async () => assert.fail('background startup must obey the mutation gate'),
          }),
          { code: 'crag_subscription_sync_pending' },
        )
      }
      mutations++
      if (authorityRejects) return Response.json({ ok: false, error: { code: 'redeem_unavailable' } }, { status: 404 })
      rights = issueHostEntitlement(root, request.host_id, { slot_limit: 1, revision: mutations })
    }
    const data = { entitlement: rights.code, ...rights.claims, used_slots: Number(bound) }
    if (url.endsWith('/bind')) {
      const permit = issueSlotPermit(root, request.machine_code, request.host_id, { seat: 1 })
      bound = true
      return Response.json({ ok: true, data: { ...data, seat: 1, slot_permit: permit.code } })
    }
    return Response.json({ ok: true, data })
  })
  seedEncryptedPackage(root)
  fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', vm.id, 'machine-id'), `${vm.fingerprint.guest_machine_id}\n`)
  service = connect({
    listTargets: () => [vm],
    assertReady: () => true,
    blockKvmBinding: async () => {
      if (blockFails) throw Object.assign(new Error('guest transport failed'), { code: 'test_block_failed' })
      blocked = true
      return true
    },
    publishKvmBinding: async () => {
      if (publishFails) throw new Error('guest delivery failed')
      if (renewDuringPublish) {
        renewDuringPublish = false
        await service.redeem(voucher())
      }
      copy = readCragSubscriptionFiles(root, vm)
      assert.ok(copy)
      blocked = false
      return true
    },
  })
  await service.redeem(voucher())
  await service.bind(vm)
  assert.equal(blocked, false)
  assert.equal(copy.entitlement, rights.code)
  const original = copy.entitlement
  await service.redeem(voucher(), true)
  assert.notEqual(copy.entitlement, original)
  assert.equal(copy.entitlement, rights.code)
  assert.equal(blocked, false)

  authorityRejects = true
  await assert.rejects(service.redeem(voucher(), true), { code: 'redeem_unavailable' })
  assert.equal(blocked, false, 'terminal Authority failure restores the still-valid prior grant')
  assert.equal(copy.entitlement, rights.code)
  assert.equal(fs.existsSync(path.join(publicDir, 'sync-pending')), false)
  authorityRejects = false

  const before = mutations
  blockFails = true
  await assert.rejects(service.redeem(voucher(), true), { code: 'test_block_failed' })
  assert.equal(mutations, before, 'an unreachable running guest prevents an Authority mutation')
  blockFails = false

  publishFails = true
  await assert.rejects(service.redeem(voucher(), true), { code: 'license_crag_kvm_sync_failed' })
  assert.equal(blocked, true)
  assert.equal(
    fs.existsSync(path.join(publicDir, 'sync-pending')),
    false,
    'completed rights do not leave an orphan intent',
  )
  assert.equal(checkCragLicense(root, vm).ok, true)
  assert.equal((await service.admitInference({ vm })).body.error.code, 'license_crag_kvm_sync_failed')
  publishFails = false
  assert.equal(await service.admitInference({ vm }), null)
  assert.equal(blocked, false)
  assert.equal(copy.entitlement, rights.code)

  renewDuringPublish = true
  assert.equal((await service.admitInference({ vm })).body.error.code, 'license_crag_host_usage_unverified')
  assert.equal(await service.admitInference({ vm }), null)

  const expired = issueHostEntitlement(root, rights.claims.host_id, {
    slot_limit: 1,
    revision: mutations + 1,
    expires_at: Math.floor(Date.now() / 1000) - 1,
  })
  fs.writeFileSync(path.join(publicDir, 'entitlement.code'), expired.code)
  const denied = checkCragLicense(root, vm)
  assert.equal(denied.code, 'license_expired')
  publishFails = true
  const admission = await service.admitInference({ vm })
  assert.equal(admission.body.error.code, denied.code)
  assert.equal(admission.body.error.message, denied.error)
  assert.equal(blocked, true, 'an expired grant blocks the previous guest copy without republishing it')
  blockFails = true
  assert.equal((await service.admitInference({ vm })).body.error.code, denied.code)
})

test('KVM H1 upgrade checks readiness before blocking and never mutates rights if blocking fails', async (t) => {
  const vm = {
    id: 'vm-53',
    dataplane: 'crag',
    status: 'running',
    runtime: { type: 'kvm' },
    fingerprint: { guest_machine_id: crypto.randomBytes(16).toString('hex') },
  }
  let rights, permit
  let blocked = false
  let blockFails = false
  let upgrading = false
  const events = []
  const { root, connect } = standaloneHost(t, async (url, { body }) => {
    const request = JSON.parse(body)
    if (url.endsWith('/redeem')) rights = issueHostEntitlement(root, request.host_id, { slot_limit: 1 })
    if (url.endsWith('/bind')) permit = issueSlotPermit(root, request.machine_code, request.host_id, { seat: 1 })
    if (url.endsWith('/upgrade')) {
      events.push('authority')
      assert.equal(blocked, true)
      await assert.rejects(
        publishKvmCragSubscription(root, vm, {
          runDockerExec: async () => assert.fail('the gate remains held during the upgrade'),
        }),
        { code: 'crag_subscription_sync_pending' },
      )
      const claims = {
        ...rights.claims,
        version: 2,
        revision: 2,
        roster: [{ seat: 1, permit_sha256: crypto.createHash('sha256').update(permit.code).digest('hex') }],
      }
      rights = { claims, code: signSubscriptionBytes(root, 'CRAGH2', JSON.stringify(claims)) }
    }
    return Response.json({
      ok: true,
      data: {
        entitlement: rights.code,
        ...rights.claims,
        used_slots: Number(!!permit),
        ...(url.endsWith('/bind') && { seat: 1, slot_permit: permit.code }),
      },
    })
  })
  seedEncryptedPackage(root)
  fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', vm.id, 'machine-id'), `${vm.fingerprint.guest_machine_id}\n`)
  const service = connect({
    listTargets: () => [vm],
    isSlotEnabled: () => false,
    assertReady: (_target, options) => {
      if (upgrading && options.reclaim) {
        events.push('ready')
        if (blocked)
          throw Object.assign(new Error('guest projection pending'), { code: 'crag_subscription_target_unready' })
      }
      return true
    },
    blockKvmBinding: async () => {
      if (upgrading) events.push('block')
      if (blockFails) throw Object.assign(new Error('guest transport failed'), { code: 'test_block_failed' })
      blocked = true
      return true
    },
    publishKvmBinding: async () => {
      if (upgrading) events.push('publish')
      assert.ok(readCragSubscriptionFiles(root, vm))
      blocked = false
      return true
    },
  })
  await service.redeem(voucher())
  await service.bind(vm)
  upgrading = true
  blockFails = true
  await assert.rejects(service.upgrade(), { code: 'test_block_failed' })
  assert.deepEqual(events, ['ready', 'block', 'publish'])
  assert.equal(rights.claims.version, 1)
  assert.equal(blocked, false)
  events.length = 0
  blockFails = false
  const result = await service.upgrade()
  assert.equal(result.reclaim_supported, true)
  assert.deepEqual(events, ['ready', 'block', 'authority', 'publish'])
  assert.equal(blocked, false)
  assert.equal(checkCragLicense(root, vm).ok, true)
})

test('an admin can redeem without VMs and use the cumulative capacity signed by Authority', async (t) => {
  const first = voucher()
  const second = voucher()
  const device = voucher()
  const requests = []
  const { root, publicDir, privateDir, connect } = standaloneHost(t, async (url, { body }) => {
    const request = JSON.parse(body)
    requests.push([new URL(url).pathname, request])
    if (request.redemption_code === device) {
      return Response.json({ ok: false, error: { code: 'redeem_unavailable' } }, { status: 404 })
    }
    const { code, claims } = issueHostEntitlement(root, request.host_id, {
      revision: request.redemption_code === first ? 1 : 2,
      slot_limit: request.redemption_code === first ? 5 : 15,
    })
    return Response.json({ ok: true, data: { entitlement: code, ...claims, used_slots: 0 } })
  })
  seedEncryptedPackage(root)
  const post = postSubscription(connect())
  const initial = await post('redeem', { redemption_code: ` ${first}\n` })
  assert.equal(initial.status, 200)
  assert.equal(initial.data.state, 'active')
  assert.equal(initial.data.slot_limit, 5)
  assert.equal(initial.data.ready, false)
  assert.equal(initial.data.total_slots, 0)
  assert.equal(initial.data.enabled_slots, 0)
  assert.equal(initial.data.used_slots, 0)

  const stacked = await post('redeem', { redemption_code: second })
  assert.equal(stacked.status, 200)
  assert.equal(stacked.data.slot_limit, 15)
  assert.equal(stacked.data.available_seats, 15)
  assert.equal(stacked.data.revision, 2)
  const saved = fs.readFileSync(path.join(publicDir, 'entitlement.code'), 'utf8')
  const rejected = await post('redeem', { redemption_code: device })
  assert.equal(rejected.status, 404)
  assert.equal(rejected.error.code, 'redeem_unavailable')
  assert.equal(JSON.stringify(rejected).includes(device), false)
  assert.equal(fs.readFileSync(path.join(publicDir, 'entitlement.code'), 'utf8'), saved)
  assert.equal(fs.existsSync(path.join(privateDir, 'redeem.json')), false)
  assert.equal(fs.existsSync(path.join(publicDir, 'sync-pending')), false)
  const host_id = fs.readFileSync(path.join(publicDir, 'host_id'), 'utf8')
  assert.deepEqual(
    requests,
    [first, second, device].map((redemption_code) => ['/v1/host-subscriptions/redeem', { host_id, redemption_code }]),
  )
  assert.equal(fs.existsSync(path.join(root, 'vms')), false)
})

test('an expired aggregate refreshes once and only a newer signed quota can restore availability', async (t) => {
  for (const result of ['remaining', 'offline', 'older', 'same revision']) {
    await t.test(result, async (subtest) => {
      let issued
      let next
      let statusCalls = 0
      const { root, publicDir, connect } = standaloneHost(subtest, async (url, { body }) => {
        const { host_id } = JSON.parse(body)
        if (url.endsWith('/redeem')) {
          const now = Math.floor(Date.now() / 1000)
          issued = issueHostEntitlement(root, host_id, {
            revision: 2,
            slot_limit: 15,
            issued_at: now - 300,
            expires_at: now - 120,
          })
        } else {
          statusCalls++
          await new Promise((resolve) => setImmediate(resolve))
          if (result === 'offline') return new Response(null, { status: 503 })
          next = issueHostEntitlement(root, host_id, {
            revision: result === 'older' ? 1 : result === 'same revision' ? 2 : 3,
            slot_limit: 10,
          })
        }
        const { code, claims } = next ?? issued
        return Response.json({ ok: true, data: { entitlement: code, ...claims, used_slots: 6 } })
      })
      seedEncryptedPackage(root)
      const service = connect()
      assert.equal((await service.redeem(voucher())).available_seats, 0)
      const [background, panel] = await Promise.allSettled([service.refreshExpiredEntitlement(), service.status()])
      assert.equal(background.status, result === 'remaining' ? 'fulfilled' : 'rejected')
      assert.equal(panel.status, 'fulfilled')
      const status = panel.value
      const file = path.join(publicDir, 'entitlement.code')
      const updated = result === 'remaining'
      assert.equal(statusCalls, 1)
      assert.equal(status.state, updated ? 'active' : 'expired')
      assert.equal(status.available_seats, updated ? 4 : 0)
      assert.equal(fs.readFileSync(file, 'utf8'), updated ? next.code : issued.code)
    })
  }
})

test('standalone redeem with a missing or corrupt host package does not start a transaction', async (t) => {
  let calls = 0
  const { root, publicDir, privateDir, connect } = standaloneHost(t, async () => {
    calls++
    return new Response(null, { status: 503 })
  })
  const post = postSubscription(connect())
  const redemption_code = voucher()
  const missing = await post('redeem', { redemption_code })
  assert.equal(missing.status, 409)
  assert.equal(missing.error.code, 'crag_subscription_host_package_unready')
  const packageDir = seedEncryptedPackage(root)
  fs.appendFileSync(path.join(packageDir, 'crag-v2.payload.enc'), 'corrupt')
  const corrupt = await post('redeem', { redemption_code })
  assert.equal(corrupt.status, 409)
  assert.equal(corrupt.error.code, 'crag_subscription_host_package_unready')
  assert.equal(calls, 0)
  for (const file of [
    path.join(privateDir, 'credential'),
    path.join(privateDir, 'redeem.json'),
    path.join(publicDir, 'host_id'),
    path.join(publicDir, 'sync-pending'),
  ]) {
    assert.equal(fs.existsSync(file), false)
  }
})

test('a device purchase applies signed rights only to its verified host and replays the same voucher after loss', async (t) => {
  const redemptionCode = voucher()
  const requests = []
  let issued
  const { root, publicDir, connect } = standaloneHost(t, async (url, { body, headers }) => {
    const request = JSON.parse(body)
    if (url.endsWith('/redeem')) {
      requests.push({ request, authorization: headers.authorization })
      if (!issued) {
        issued = issueHostEntitlement(root, request.host_id, { slot_limit: 10 })
        throw new Error('committed response interrupted')
      }
    }
    return Response.json({ ok: true, data: { entitlement: issued.code, ...issued.claims, used_slots: 0 } })
  })
  const service = connect()
  const hostId = service.purchaseDeviceId()
  assert.match(hostId, /^[a-f0-9]{64}$/)
  assert.equal(fs.existsSync(path.join(publicDir, 'host_id')), false, 'checkout does not create a subscription')
  seedEncryptedPackage(root)
  const wrongHost = `${hostId[0] === 'a' ? 'b' : 'a'}${hostId.slice(1)}`
  await assert.rejects(service.redeemDeviceOrder(wrongHost, redemptionCode))
  assert.equal(requests.length, 0)
  await assert.rejects(service.redeemDeviceOrder(hostId, redemptionCode), {
    code: 'crag_subscription_authority_unavailable',
  })
  await assert.rejects(connect().redeemDeviceOrder(hostId, voucher()), { code: 'crag_subscription_sync_pending' })
  await connect().redeemDeviceOrder(hostId, redemptionCode)
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1], requests[0])
  assert.deepEqual(requests[0].request, { host_id: hostId, redemption_code: redemptionCode })
  assert.equal((await service.status()).available_seats, 10)
})

test('standalone recovery waits for the original verified host package before replaying a lost response', async (t) => {
  const redemption_code = voucher()
  const requests = []
  let issued
  let commits = 0
  const { root, publicDir, privateDir, connect } = standaloneHost(t, async (url, { body, headers }) => {
    const request = JSON.parse(body)
    if (url.endsWith('/redeem')) {
      requests.push({ request, authorization: headers.authorization })
      if (!issued) {
        commits++
        issued = issueHostEntitlement(root, request.host_id, { slot_limit: 2 })
        throw new Error('committed response interrupted')
      }
    }
    return Response.json({ ok: true, data: { entitlement: issued.code, ...issued.claims, used_slots: 0 } })
  })
  const packageDir = seedEncryptedPackage(root)
  const initial = await postSubscription(connect())('redeem', { redemption_code })
  assert.equal(initial.status, 502)
  assert.equal(initial.error.code, 'crag_subscription_authority_unavailable')
  assert.equal((await connect().status()).state, 'sync_pending')
  const intent = path.join(privateDir, 'redeem.json')
  const marker = path.join(publicDir, 'sync-pending')
  const entitlement = path.join(publicDir, 'entitlement.code')
  const originalIntent = fs.readFileSync(intent, 'utf8')
  assert.equal(fs.statSync(intent).mode & 0o777, 0o600)
  const pending = fs.readFileSync(marker, 'utf8')
  const recover = postSubscription(connect())
  const blocked = await recover('redeem', { redemption_code: voucher() })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.error.code, 'crag_subscription_sync_pending')
  assert.equal(fs.readFileSync(intent, 'utf8'), originalIntent)
  assert.equal(requests.length, 1)
  const backup = path.join(root, 'original-package')
  fs.renameSync(packageDir, backup)
  seedEncryptedPackage(root, { revision: 'other revision, same issuer and payload key' })
  async function assertRecoveryBlocked(kind) {
    const rejected = await recover('recover', {})
    assert.equal(rejected.status, 409, kind)
    assert.equal(rejected.error.code, 'crag_subscription_host_package_unready', kind)
    assert.equal(requests.length, 1, kind)
    assert.equal(fs.readFileSync(intent, 'utf8'), originalIntent, kind)
    assert.equal(fs.readFileSync(marker, 'utf8'), pending, kind)
    assert.equal(fs.existsSync(entitlement), false, kind)
  }

  await assertRecoveryBlocked('changed package with the same authority and key')
  fs.rmSync(packageDir, { recursive: true })
  await assertRecoveryBlocked('missing package')
  fs.renameSync(backup, packageDir)

  const payloadFile = path.join(packageDir, 'crag-v2.payload.enc')
  const payload = fs.readFileSync(payloadFile)
  fs.appendFileSync(payloadFile, 'corrupt')
  await assertRecoveryBlocked('corrupt payload with the original manifest')
  fs.writeFileSync(payloadFile, payload)
  const recovered = await recover('recover', {})
  assert.equal(recovered.status, 200)
  assert.equal(recovered.data.state, 'active')
  assert.equal(recovered.data.slot_limit, 2)
  assert.equal(recovered.data.enabled_slots, 0)
  assert.equal(commits, 1)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].request.redemption_code, redemption_code)
  assert.deepEqual(requests[1], requests[0], 'recovery sends the same voucher, host identity, and credential')
  assert.equal(fs.existsSync(intent), false)
  assert.equal(fs.existsSync(marker), false)
  assert.equal(fs.readFileSync(entitlement, 'utf8'), issued.code)
})

test('the exact pending voucher can resume after a lost response, even when an intermediate attempt is denied', async (t) => {
  const redemption_code = voucher()
  let issued
  let attempts = 0
  const { root, publicDir, privateDir, connect } = standaloneHost(t, async (url, { body }) => {
    assert.ok(url.endsWith('/redeem'))
    const request = JSON.parse(body)
    assert.equal(request.redemption_code, redemption_code)
    attempts++
    if (attempts === 1) {
      issued = issueHostEntitlement(root, request.host_id, { slot_limit: 2 })
      throw new Error('fixture lost the committed response')
    }
    if (attempts === 2) {
      return Response.json({ ok: false, error: { code: 'auth_forbidden' } }, { status: 403 })
    }
    return Response.json({ ok: true, data: { entitlement: issued.code, ...issued.claims } })
  })
  seedEncryptedPackage(root)
  const initial = await postSubscription(connect())('redeem', { redemption_code })
  assert.equal(initial.status, 502)
  const denied = await postSubscription(connect())('recover', {})
  assert.equal(denied.status, 403)
  assert.equal((await connect().status()).state, 'sync_pending')
  const blocked = await postSubscription(connect())('redeem', { redemption_code: voucher() })
  assert.equal(blocked.status, 409)
  assert.equal(attempts, 2)
  const replayed = await postSubscription(connect())('redeem', { redemption_code })
  assert.equal(replayed.status, 200)
  assert.equal(replayed.data.revision, issued.claims.revision)
  assert.equal(replayed.data.slot_limit, 2)
  assert.equal(fs.existsSync(path.join(privateDir, 'redeem.json')), false)
  assert.equal(fs.existsSync(path.join(publicDir, 'sync-pending')), false)
})

test('an Authority denial is not retried or installed, and only a valid correlation ID is exposed', async (t) => {
  const redemption_code = voucher()
  const requestId = crypto.randomUUID()
  let replyId = requestId
  let denied = true
  let calls = 0
  const { root, publicDir, privateDir, connect } = standaloneHost(t, async (url, { body, headers }) => {
    assert.ok(url.endsWith('/redeem'))
    calls++
    if (denied) {
      return Response.json(
        { ok: false, error: { code: 'auth_forbidden', message: `${redemption_code} ${headers.authorization}` } },
        { status: 403, headers: { 'x-request-id': replyId } },
      )
    }
    const { code, claims } = issueHostEntitlement(root, JSON.parse(body).host_id, { slot_limit: 2 })
    return Response.json({ ok: true, data: { entitlement: code, ...claims } })
  })
  seedEncryptedPackage(root)
  const submit = postSubscription(connect())
  const blocked = await submit('redeem', { redemption_code })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.error.code, 'auth_forbidden')
  assert.deepEqual(blocked.error.details, { authority_request_id: requestId })
  assert.equal(calls, 1, 'a refused request must not trigger automatic retries')
  assert.equal(fs.existsSync(path.join(publicDir, 'entitlement.code')), false)
  assert.equal(fs.existsSync(path.join(publicDir, 'sync-pending')), false)
  assert.equal(fs.existsSync(path.join(privateDir, 'redeem.json')), false)
  const key = fs.readFileSync(path.join(privateDir, 'credential'), 'utf8')
  assert.equal(JSON.stringify(blocked).includes(redemption_code), false)
  assert.equal(JSON.stringify(blocked).includes(key), false)

  replyId = `${requestId}, ${redemption_code}`
  const untrusted = await submit('redeem', { redemption_code })
  assert.equal(untrusted.status, 403)
  assert.equal(untrusted.error.details, undefined)
  assert.equal(JSON.stringify(untrusted).includes(redemption_code), false)
  assert.equal(calls, 2)

  denied = false
  const applied = await submit('redeem', { redemption_code })
  assert.equal(applied.status, 200)
  assert.equal(applied.data.slot_limit, 2)
  assert.equal(fs.readFileSync(path.join(privateDir, 'credential'), 'utf8'), key)
})

test('a failed slot probe does not hide signed host rights', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-host-probe-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'machine-id')
  fs.writeFileSync(source, crypto.randomBytes(16).toString('hex'), { mode: 0o600 })
  fs.mkdirSync(path.dirname(path.dirname(cragSubscriptionPublicDirectory(root))), { recursive: true })
  seedEncryptedPackage(root)
  let snapshotFails = false
  let authorityAvailable = false
  let entitlement
  const service = createCragSubscription({
    projectRoot: root,
    machineIdFile: source,
    listTargets: () => {
      if (snapshotFails) throw new Error('slot inventory unreadable')
      return [{ id: 'vm-1' }]
    },
    assertReady: () => true,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/status') && !authorityAvailable) return new Response(null, { status: 503 })
      const { host_id } = JSON.parse(init.body)
      const { code, claims } = (entitlement ??= issueHostEntitlement(root, host_id, { revision: 1, slot_limit: 3 }))
      return Response.json({ ok: true, data: { entitlement: code, ...claims, used_slots: 0, available_slots: 3 } })
    },
  })
  const redeemed = await service.redeem(voucher())
  assert.equal(redeemed.available_slots, 3, 'redeem returns confirmed capacity even if a status read would fail')
  assert.equal((await service.status()).available_slots, undefined, 'an offline refresh does not guess capacity')
  authorityAvailable = true
  snapshotFails = true
  const result = await service.status()
  assert.equal(result.state, 'active')
  assert.equal(result.revision, 1)
  assert.equal(result.available_slots, 3, 'Authority capacity does not depend on the local inventory')
  assert.equal(result.ready, false)
  assert.equal(result.target_probe_failed, true)
  assert.equal(result.total_slots, undefined)

  fs.chmodSync(source, 0o666)
  assert.equal((await service.status()).state, 'unavailable', 'unsafe host identity remains unavailable')
})

test('activated slots report valid local licenses independently of host entitlement and running slots', async (testContext) => {
  const { root, connect } = standaloneHost(testContext, async () =>
    assert.fail('status must not contact the Authority'),
  )
  seedEncryptedPackage(root)
  const stopped = { id: 'vm-stopped', status: 'stopped', dataplane: 'crag' }
  const unlicensed = { id: 'vm-unlicensed' }
  const remote = { id: 'vm-remote', node_id: 'remote' }
  activateFixture(root, stopped)
  activateFixture(root, { id: remote.id })
  const { license } = checkCragLicense(root, stopped)
  assert.equal(license.valid, true)
  const service = connect({
    listTargets: () => [stopped, unlicensed, remote],
    isLocalCragSlot: (vm) => !vm.node_id,
    assertReady: () => false,
    runtimeInventory: { snapshot: async () => ({ running_vms: 0 }) },
  })
  const status = await service.status()
  assert.equal(status.state, 'unredeemed')
  assert.equal(status.runtime.running_vms, 0)
  assert.deepEqual(status.activated_slots, [{ vm_id: stopped.id, scope: 'device', expires_at: license.expires_at }])
})

test('a package changed during redemption cannot publish rights and recovery keeps the original pin', async (testContext) => {
  const issued = new Map()
  const requests = []
  let packageDir
  let replacePackage = false
  const { root, publicDir, privateDir, connect } = standaloneHost(testContext, async (url, { body }) => {
    assert.ok(url.endsWith('/redeem'))
    const request = JSON.parse(body)
    requests.push(request)
    if (!issued.has(request.redemption_code)) {
      issued.set(request.redemption_code, issueHostEntitlement(root, request.host_id, { revision: issued.size + 1 }))
    }
    const { code, claims } = issued.get(request.redemption_code)
    if (replacePackage) {
      replacePackage = false
      fs.renameSync(packageDir, path.join(root, 'original-package'))
      seedEncryptedPackage(root, { revision: 'changed during Authority response' })
    }
    return Response.json({ ok: true, data: { entitlement: code, ...claims, used_slots: 0, available_slots: 2 } })
  })
  packageDir = seedEncryptedPackage(root)
  const service = connect()
  await service.redeem(voucher())
  const entitlementFile = path.join(publicDir, 'entitlement.code')
  const previous = fs.readFileSync(entitlementFile, 'utf8')
  const originalDigest = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(packageDir, 'manifest.json')))
    .digest('hex')
  replacePackage = true
  const replacement = voucher()
  await assert.rejects(service.redeem(replacement), { code: 'crag_subscription_host_package_unready', status: 409 })
  assert.equal(fs.readFileSync(entitlementFile, 'utf8'), previous)
  const intentFile = path.join(privateDir, 'redeem.json')
  const intent = fs.readFileSync(intentFile, 'utf8')
  assert.equal(JSON.parse(intent).host_package_sha256, originalDigest)
  assert.equal(JSON.parse(intent).redemption_code, replacement)
  assert.equal(fs.existsSync(path.join(publicDir, 'sync-pending')), true)
  await assert.rejects(connect().recover(), { code: 'crag_subscription_host_package_unready' })
  assert.equal(requests.length, 2)
  assert.equal(fs.readFileSync(intentFile, 'utf8'), intent)
  fs.rmSync(packageDir, { recursive: true })
  fs.renameSync(path.join(root, 'original-package'), packageDir)
  assert.equal(await connect().recover(), undefined)
  assert.deepEqual(requests[2], requests[1])
  assert.equal(fs.readFileSync(entitlementFile, 'utf8'), issued.get(replacement).code)
  assert.equal(fs.existsSync(intentFile), false)
  assert.equal(fs.existsSync(path.join(publicDir, 'sync-pending')), false)
})

test('legacy unpinned initial intents still require a trusted package without inventing a historical pin', async (testContext) => {
  let issued
  let calls = 0
  const { root, publicDir, privateDir, connect } = standaloneHost(testContext, async (url, { body }) => {
    assert.ok(url.endsWith('/redeem'))
    calls++
    const { host_id } = JSON.parse(body)
    if (!issued) {
      issued = issueHostEntitlement(root, host_id)
      throw new Error('lost reply')
    }
    return Response.json({ ok: true, data: { entitlement: issued.code, ...issued.claims } })
  })
  const packageDir = seedEncryptedPackage(root)
  await assert.rejects(connect().redeem(voucher()), { code: 'crag_subscription_authority_unavailable' })
  const intentFile = path.join(privateDir, 'redeem.json')
  const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'))
  delete intent.host_package_sha256
  fs.writeFileSync(intentFile, JSON.stringify(intent))
  fs.renameSync(packageDir, path.join(root, 'original-package'))
  await assert.rejects(connect().recover(), { code: 'crag_subscription_host_package_unready' })
  assert.equal(calls, 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(intentFile, 'utf8')), intent)
  seedEncryptedPackage(root, { revision: 'trusted replacement for an unpinned legacy intent' })
  assert.equal(await connect().recover(), undefined)
  assert.equal(calls, 2)
  assert.equal(fs.readFileSync(path.join(publicDir, 'entitlement.code'), 'utf8'), issued.code)
})

test('status retries changed signed rights or pending state once and omits failed or inconsistent inventory', async (testContext) => {
  for (const scenario of [
    { name: 'signed rights change once', changes: 1 },
    { name: 'pending changes once', changes: 1, pending: true },
    { name: 'signed rights keep changing', changes: 2 },
    { name: 'pending keeps changing', changes: 2, pending: true },
    { name: 'rights change while runtime fails', changes: 1, failed: true },
    { name: 'runtime failure preserves Authority fields', changes: 0, failed: true },
  ]) {
    await testContext.test(scenario.name, async (subtest) => {
      let issued
      const { root, publicDir, connect } = standaloneHost(subtest, async (url, { body }) => {
        const { host_id } = JSON.parse(body)
        issued ??= issueHostEntitlement(root, host_id, { slot_limit: 3 })
        return Response.json({
          ok: true,
          data: {
            entitlement: issued.code,
            ...issued.claims,
            used_slots: 0,
            available_slots: issued.claims.slot_limit,
          },
        })
      })
      seedEncryptedPackage(root)
      await connect().redeem(voucher())
      let samples = 0
      const service = connect({
        runtimeInventory: {
          snapshot: async ({ hostId, claims, pending }) => {
            samples++
            if (samples <= scenario.changes) {
              if (scenario.pending) {
                const marker = path.join(publicDir, 'sync-pending')
                if (pending) fs.rmSync(marker)
                else fs.writeFileSync(marker, 'pending\n', { mode: 0o644 })
              } else {
                issued = issueHostEntitlement(root, hostId, { revision: claims.revision + 1, slot_limit: 1 })
                fs.writeFileSync(path.join(publicDir, 'entitlement.code'), issued.code)
              }
            }
            if (scenario.failed) throw new Error('runtime unavailable')
            return { sampled_revision: claims.revision, sampled_pending: pending, host_runtime_available: 99 }
          },
        },
      })
      const status = await service.status()
      assert.equal(samples, scenario.changes ? 2 : 1)
      if (scenario.failed || scenario.changes === 2) {
        assert.equal(Object.hasOwn(status, 'runtime'), false)
      } else {
        assert.equal(status.runtime.sampled_revision, status.revision)
        assert.equal(status.runtime.sampled_pending, status.state === 'sync_pending')
      }
      if (scenario.pending) {
        assert.equal(status.state, 'sync_pending')
        assert.equal(Object.hasOwn(status, 'available_slots'), false)
        assert.equal(Object.hasOwn(status, 'used_slots'), false)
      } else {
        assert.equal(status.revision, scenario.changes ? 2 : 1)
        assert.equal(status.available_slots, scenario.changes ? 1 : 3)
        assert.equal(status.used_slots, 0)
      }
    })
  }
})

test('remaining capacity requires confirmed usage or a signed roster, never runtime observations', async (testContext) => {
  for (const version of [1, 2]) {
    for (const expired of [false, true]) {
      await testContext.test(`H${version} ${expired ? 'expired' : 'active'}`, async (subtest) => {
        let issued
        let offline = false
        const { root, publicDir, connect } = standaloneHost(subtest, async (url, { body }) => {
          if (offline) return new Response(null, { status: 503 })
          if (!issued) {
            const { host_id } = JSON.parse(body)
            const now = Math.floor(Date.now() / 1000)
            issued = issueHostEntitlement(root, host_id, expired ? { issued_at: now - 300, expires_at: now - 120 } : {})
            if (version === 2) {
              issued.claims = { ...issued.claims, version, roster: [] }
              issued.code = signSubscriptionBytes(root, 'CRAGH2', JSON.stringify(issued.claims))
            }
          }
          return Response.json({ ok: true, data: { entitlement: issued.code, ...issued.claims } })
        })
        seedEncryptedPackage(root)
        const service = connect({ runtimeInventory: { snapshot: async () => ({ host_runtime_available: 12 }) } })
        const redeemed = await service.redeem(voucher())
        assert.equal(redeemed.state, expired ? 'expired' : 'active')
        for (const status of [redeemed, await service.status()]) {
          assert.equal(Object.hasOwn(status, 'used_slots'), false)
          assert.equal(Object.hasOwn(status, 'available_slots'), false)
          assert.equal(status.available_seats, expired ? 0 : version === 2 ? 2 : null)
        }
        offline = true
        const unavailable = await service.status()
        assert.equal(unavailable.state, expired ? 'expired' : 'active')
        assert.equal(unavailable.available_seats, expired ? 0 : version === 2 ? 2 : null)
        assert.equal(Object.hasOwn(unavailable, 'used_slots'), false)
        assert.equal(Object.hasOwn(unavailable, 'available_slots'), false)
        fs.writeFileSync(path.join(publicDir, 'sync-pending'), 'pending\n', { mode: 0o644 })
        const pending = await service.status()
        assert.equal(pending.state, 'sync_pending')
        assert.equal(pending.available_seats, null)
        assert.equal(Object.hasOwn(pending, 'used_slots'), false)
        assert.equal(Object.hasOwn(pending, 'available_slots'), false)
      })
    }
  }
})

test('a lost renewal response suspends real control admission until restart replays the original voucher', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-host-contract-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'host-machine-id')
  fs.writeFileSync(source, crypto.randomBytes(16).toString('hex'), { mode: 0o600 })
  const publicDir = cragSubscriptionPublicDirectory(root)
  fs.mkdirSync(path.dirname(path.dirname(publicDir)), { recursive: true })
  seedEncryptedPackage(root)
  const slots = ['vm-41', 'vm-42'].map((id) => ({ id, dataplane: 'crag', crag_kernel_version: 'v2' }))
  for (const vm of slots) {
    const dir = path.join(root, 'vms', vm.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'machine-id'), crypto.randomBytes(16).toString('hex'))
  }
  const issued = new Map()
  let bearer
  let current
  let seats = 0
  let lose = false
  const connect = () =>
    createCragSubscription({
      projectRoot: root,
      machineIdFile: source,
      listTargets: () => [...slots, { id: 'vm-non-crag' }],
      isSubscriptionSlot: (vm) => vm.dataplane === 'crag',
      isSlotEnabled: (vm) => checkCragLicense(root, vm).license?.scope === 'host' && checkCragLicense(root, vm).ok,
      assertReady: () => true,
      fetchImpl: async (url, opts) => {
        const body = JSON.parse(opts.body)
        if (bearer) assert.equal(opts.headers.authorization, bearer)
        bearer = opts.headers.authorization
        if (url.endsWith('/redeem')) {
          assert.equal(fs.existsSync(path.join(publicDir, 'sync-pending')), true)
          if (!issued.has(body.redemption_code)) {
            const revision = issued.size + 1
            current = issueHostEntitlement(root, body.host_id, { revision, slot_limit: revision === 1 ? 2 : 1 })
            issued.set(body.redemption_code, current)
          }
          if (lose) {
            lose = false
            throw new Error('committed response interrupted')
          }
          const { code, claims } = issued.get(body.redemption_code)
          return Response.json({
            ok: true,
            data: {
              entitlement: code,
              revision: claims.revision,
              expires_at: claims.expires_at,
              slot_limit: claims.slot_limit,
            },
          })
        }
        if (url.endsWith('/status')) {
          const { code, claims } = current
          return Response.json({
            ok: true,
            data: {
              entitlement: code,
              revision: claims.revision,
              expires_at: claims.expires_at,
              slot_limit: claims.slot_limit,
            },
          })
        }
        const seat = ++seats
        const { code } = issueSlotPermit(root, body.machine_code, body.host_id, { seat })
        return Response.json({ ok: true, data: { entitlement: current.code, slot_permit: code, seat } })
      },
    })
  const service = connect()
  assert.deepEqual(await service.status(), {
    ready: true,
    state: 'unredeemed',
    available_seats: 0,
    reclaim_pending_count: 0,
    vm_count: 3,
    total_slots: 2,
    enabled_slots: 0,
  })
  await service.redeem(voucher())
  assert.deepEqual(await service.bind(slots[0]), { seat: 1 })
  assert.deepEqual(await service.bind(slots[1]), { seat: 2 })
  assert.equal(checkCragLicense(root, slots[1]).ok, true)
  assert.equal((await service.status()).enabled_slots, 2)
  const renewal = voucher()
  lose = true
  await assert.rejects(service.redeem(renewal), { code: 'crag_subscription_authority_unavailable' })
  assert.equal((await service.status()).state, 'sync_pending')
  // An in-flight or lost renewal must never suspend already-purchased running slots.
  assert.equal(checkCragLicense(root, slots[0]).ok, true)
  assert.equal(checkCragLicense(root, slots[1]).ok, true)
  const recovered = connect()
  await recovered.recover()
  assert.equal((await recovered.status()).revision, 2)
  assert.equal((await recovered.status()).enabled_slots, 1)
  assert.equal(issued.size, 2)
  assert.equal(checkCragLicense(root, slots[0]).ok, true)
  assert.equal(checkCragLicense(root, slots[1]).ok, false)
})

test('runtime quota follows a signed downgrade, unknown observations, and Authority outages', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-host-contract-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'host-machine-id')
  fs.writeFileSync(source, crypto.randomBytes(16).toString('hex'), { mode: 0o600 })
  const publicDir = cragSubscriptionPublicDirectory(root)
  fs.mkdirSync(path.dirname(path.dirname(publicDir)), { recursive: true })
  seedEncryptedPackage(root)
  const slots = ['vm-41', 'vm-42'].map((id) => ({ id, dataplane: 'crag', crag_kernel_version: 'v2' }))
  const independent = { id: 'vm-43', dataplane: 'crag', crag_kernel_version: 'v2' }
  const dormant = { id: 'vm-44', dataplane: 'wrap', status: 'stopped' }
  activateFixture(root, independent)
  const targets = () => [...slots, independent, dormant]
  const observations = new Map([...slots, independent].map(({ id }) => [id, 'running']))
  let observedAt = Date.now()
  const runtimeInventory = createCragRuntimeInventory({
    projectRoot: root,
    listTargets: targets,
    getRouting: () => ({}),
    now: () => observedAt,
    observe: async ({ id }) => ({ state: observations.get(id) ?? 'missing' }),
    health: async ({ vm }) => ({
      status: vm.id === slots[1].id ? 503 : 200,
      ok: vm.id !== slots[1].id,
      runtime_variant: 'crag-v2',
      internalTokenAuthenticated: true,
      license_valid: vm.id !== slots[1].id,
      ready_slots: vm.id === slots[1].id ? 0 : 1,
    }),
  })
  for (const vm of slots) {
    const dir = path.join(root, 'vms', vm.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'machine-id'), crypto.randomBytes(16).toString('hex'))
  }
  const issued = new Map()
  let bearer
  let current
  let seats = 0
  let lose = false
  let targetReady = true
  let authorityOffline = false
  const connect = () =>
    createCragSubscription({
      projectRoot: root,
      machineIdFile: source,
      listTargets: targets,
      runtimeInventory,
      isSubscriptionSlot: (vm) => vm.dataplane === 'crag',
      isSlotEnabled: (vm) => checkCragLicense(root, vm).license?.scope === 'host' && checkCragLicense(root, vm).ok,
      assertReady: () => targetReady,
      fetchImpl: async (url, opts) => {
        const body = JSON.parse(opts.body)
        if (bearer) assert.equal(opts.headers.authorization, bearer)
        bearer = opts.headers.authorization
        if (url.endsWith('/redeem')) {
          assert.equal(fs.existsSync(path.join(publicDir, 'sync-pending')), true)
          if (!issued.has(body.redemption_code)) {
            const revision = issued.size + 1
            current = issueHostEntitlement(root, body.host_id, { revision, slot_limit: revision === 1 ? 2 : 1 })
            issued.set(body.redemption_code, current)
          }
          if (lose) {
            lose = false
            throw new Error('committed response interrupted')
          }
          const { code, claims } = issued.get(body.redemption_code)
          return Response.json({
            ok: true,
            data: {
              entitlement: code,
              revision: claims.revision,
              expires_at: claims.expires_at,
              slot_limit: claims.slot_limit,
            },
          })
        }
        if (url.endsWith('/status')) {
          if (authorityOffline) return new Response(null, { status: 503 })
          const { code, claims } = current
          return Response.json({
            ok: true,
            data: {
              entitlement: code,
              revision: claims.revision,
              expires_at: claims.expires_at,
              slot_limit: claims.slot_limit,
            },
          })
        }
        const seat = ++seats
        const { code } = issueSlotPermit(root, body.machine_code, body.host_id, { seat })
        return Response.json({ ok: true, data: { entitlement: current.code, slot_permit: code, seat } })
      },
    })
  const service = connect()
  assert.equal((await service.status()).state, 'unredeemed')
  await service.redeem(voucher())
  assert.deepEqual(await service.bind(slots[0]), { seat: 1 })
  assert.deepEqual(await service.bind(slots[1]), { seat: 2 })
  assert.equal(checkCragLicense(root, slots[1]).ok, true)
  assert.equal((await service.status()).enabled_slots, 2)
  assert.equal(await service.admitInference({ vm: slots[0] }), null, 'being full is not over quota')
  const renewal = voucher()
  targetReady = false
  lose = true
  await assert.rejects(service.redeemRenewal(renewal), { code: 'crag_subscription_authority_unavailable' })
  const renewalIntent = JSON.parse(
    fs.readFileSync(path.join(path.dirname(publicDir), 'private', 'redeem.json'), 'utf8'),
  )
  assert.deepEqual(Object.keys(renewalIntent).sort(), ['host_id', 'redemption_code'])
  assert.equal((await service.status()).state, 'sync_pending')
  assert.equal(checkCragLicense(root, slots[0]).ok, true)
  assert.equal(checkCragLicense(root, slots[1]).ok, true)
  assert.equal(await service.admitInference({ vm: slots[0] }), null)
  const recovered = connect()
  await recovered.recover()
  const status = await recovered.status()
  assert.equal(status.revision, 2)
  assert.equal(status.enabled_slots, 1)
  assert.equal(status.ready, false)
  assert.equal(issued.size, 2)
  assert.equal(checkCragLicense(root, slots[0]).ok, true)
  assert.equal(checkCragLicense(root, slots[1]).ok, false)
  assert.equal(status.runtime.host_running_vms, 2)
  assert.equal(status.runtime.running_vms, 3)
  assert.equal(status.runtime.host_runtime_available, 0)
  assert.equal(status.runtime.host_over_limit, true)
  assert.equal(await recovered.admitInference({ vm: slots[0] }), null)
  assert.equal((await recovered.admitInference({ vm: slots[1] })).body.error.code, 'license_crag_host_over_quota')
  assert.equal(await recovered.admitInference({ vm: independent }), null)
  assert.equal(await recovered.admitInference({ vm: dormant }), null)

  authorityOffline = true
  observations.set(slots[1].id, 'unknown')
  observedAt += 2100
  assert.equal(await recovered.admitInference({ vm: slots[0] }), null)
  assert.equal((await recovered.admitInference({ vm: slots[1] })).body.error.code, 'license_crag_host_over_quota')
  observations.set(slots[1].id, 'stopped')
  observedAt += 2100
  const stopped = await recovered.status()
  assert.equal(stopped.runtime.host_running_vms, 1)
  assert.equal(stopped.runtime.host_over_limit, false)
  assert.equal(stopped.available_slots, undefined, 'local probes do not substitute for Authority capacity')
  assert.equal(await recovered.admitInference({ vm: slots[0] }), null)
  assert.equal(checkCragLicense(root, slots[1]).code, 'license_crag_host_over_quota')
  observations.set(slots[1].id, 'running')
  observedAt += 2100
  assert.equal(await recovered.admitInference({ vm: slots[0] }), null)
  assert.equal((await recovered.admitInference({ vm: slots[1] })).body.error.code, 'license_crag_host_over_quota')

  const limited = connect({ runtimeInventory: { snapshot: () => assert.fail('inference must not probe other slots') } })
  assert.equal(await limited.admitInference({ vm: slots[0] }), null)
  assert.equal((await limited.admitInference({ vm: slots[1] })).body.error.code, 'license_crag_host_over_quota')
  assert.equal(
    (await recovered.withRuntimeAdmission(slots[0], {}, () => ({ ok: true }))).ok,
    true,
    'the out-of-range process cannot prevent recovery of the in-quota slot',
  )
  assert.equal(
    (await recovered.withRuntimeAdmission(slots[1], {}, () => assert.fail('over-quota slot must not start'))).code,
    'license_crag_host_over_quota',
  )
})

test('H2 reissues the same KVM seat when changing payload keys and recovers a lost response', async (t) => {
  const payload = crypto.randomBytes(32)
  let confirmed
  let invalidPermit = true
  let loseResponse = false
  let explicitBinds = 0
  let recoveryBinds = 0
  const { root, publicDir, connect } = standaloneHost(t, async (url, { body }) => {
    const { host_id, machine_code, payload_key_id, reissue } = JSON.parse(body)
    const action = url.split('/').at(-1)
    if (action === 'status') return Response.json({ ok: true, data: confirmed })
    if (action === 'bind' && !reissue && loseResponse) {
      assert.equal(reissue, undefined)
      assert.equal(payload_key_id, cragTargetIds(root).payloadKeyId)
      recoveryBinds++
      return Response.json({ ok: true, data: confirmed })
    }
    const revision = (confirmed?.revision ?? 0) + 1
    const { claims } = issueHostEntitlement(root, host_id, { revision, slot_limit: 1 })
    const roster = []
    let slot_permit
    if (action === 'bind') {
      if (reissue === true) {
        explicitBinds++
        assert.equal(payload_key_id, cragTargetIds(root).payloadKeyId)
      }
      const permit = issueSlotPermit(
        root,
        machine_code,
        host_id,
        { seat: 1 },
        reissue && !invalidPermit ? { keyId: payload_key_id, payload } : {},
      )
      slot_permit = permit.code
      roster.push({ seat: 1, permit_sha256: crypto.createHash('sha256').update(slot_permit).digest('hex') })
    }
    const entitlement = signSubscriptionBytes(root, 'CRAGH2', JSON.stringify({ ...claims, version: 2, roster }))
    const data = {
      entitlement,
      revision,
      expires_at: claims.expires_at,
      slot_limit: 1,
      used_slots: roster.length,
      available_slots: 1 - roster.length,
      ...(slot_permit && { seat: 1, slot_permit }),
    }
    if (!reissue || !invalidPermit) confirmed = data
    if (reissue && loseResponse) throw Error('committed response interrupted')
    return Response.json({ ok: true, data })
  })
  seedEncryptedPackage(root)
  const vm = {
    id: 'vm-51',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    runtime: { type: 'kvm' },
    fingerprint: { guest_machine_id: crypto.randomBytes(16).toString('hex') },
  }
  const directory = path.join(root, 'vms', vm.id)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'machine-id'), vm.fingerprint.guest_machine_id)
  assert.equal(materializeCragV2(root, vm, { select: false }).ok, true)
  const service = connect({ listTargets: () => [vm], assertReady: () => true })
  await service.redeem(voucher())
  assert.deepEqual(await service.bind(vm), { seat: 1 })
  const entitlement = path.join(publicDir, 'entitlement.code')
  const registration = path.join(cragLicenseDirectory(root, vm), 'registration.code')
  const oldRights = fs.readFileSync(entitlement)
  const oldPermit = fs.readFileSync(registration)
  seedEncryptedPackage(root, { payloadKey: payload })

  await assert.rejects(service.authorizeInstall(vm), { code: 'crag_subscription_migration_required' })
  assert.equal(explicitBinds, 0)
  await assert.rejects(service.authorizeInstall(vm, { allowLegacyReissue: true }), {
    code: 'license_payload_key_mismatch',
  })
  assert.deepEqual(fs.readFileSync(entitlement), oldRights)
  assert.deepEqual(fs.readFileSync(registration), oldPermit)
  assert.equal((await service.status()).state, 'sync_pending')
  await service.recover()
  assert.equal(explicitBinds, 1, 'refresh does not replay a reissue')
  assert.equal(checkCragLicense(root, vm).ok, true)

  invalidPermit = false
  loseResponse = true
  await assert.rejects(service.authorizeInstall(vm, { allowLegacyReissue: true }), {
    code: 'crag_subscription_authority_unavailable',
  })
  assert.deepEqual(fs.readFileSync(entitlement), oldRights)
  assert.deepEqual(fs.readFileSync(registration), oldPermit)
  await service.recover()
  assert.equal(explicitBinds, 2)
  assert.equal(recoveryBinds, 1)
  const next = checkCragLicense(root, vm, {}, { preferInstalled: false })
  assert.equal(next.ok, true)
  assert.equal(next.license.seat, 1)
  assert.equal((await service.status()).used_slots, 1)
  assert.equal(checkCragLicense(root, vm).code, 'license_payload_key_mismatch')
})

test('an active host subscription can authorize a new download when the old device permit cannot', async (t) => {
  const payload = crypto.randomBytes(32)
  let requests = 0
  let rejectBind = true
  const { root, connect } = standaloneHost(t, async (url, { body }) => {
    const { host_id, machine_code, payload_key_id, reissue } = JSON.parse(body)
    const binding = url.endsWith('/bind')
    const { claims } = issueHostEntitlement(root, host_id, { revision: binding ? 2 : 1, slot_limit: 1 })
    let slot_permit
    if (binding) {
      requests++
      assert.equal(reissue, undefined)
      assert.equal(payload_key_id, cragTargetIds(root).payloadKeyId)
      if (rejectBind) return Response.json({ ok: false, error: { code: 'slot_limit_reached' } }, { status: 409 })
      slot_permit = issueSlotPermit(root, machine_code, host_id, { seat: 1 }, { keyId: payload_key_id, payload }).code
    }
    const roster = slot_permit
      ? [{ seat: 1, permit_sha256: crypto.createHash('sha256').update(slot_permit).digest('hex') }]
      : []
    const entitlement = signSubscriptionBytes(root, 'CRAGH2', JSON.stringify({ ...claims, version: 2, roster }))
    return Response.json({
      ok: true,
      data: { ...claims, entitlement, used_slots: roster.length, ...(slot_permit && { seat: 1, slot_permit }) },
    })
  })
  seedEncryptedPackage(root)
  const vm = { id: '52', dataplane: 'crag', crag_kernel_version: 'v2' }
  const directory = path.join(root, 'vms', vm.id)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'machine-id'), crypto.randomBytes(16).toString('hex'))
  assert.equal(materializeCragV2(root, vm, { select: false }).ok, true)
  assert.equal(activateFixture(root, vm).license.scope, 'device')
  const service = connect()
  await service.redeem(voucher())
  seedEncryptedPackage(root, { payloadKey: payload })
  const registration = path.join(cragLicenseDirectory(root, vm), 'registration.code')
  const oldPermit = fs.readFileSync(registration)
  await assert.rejects(service.authorizeInstall(vm), { code: 'crag_subscription_migration_required' })
  assert.equal(requests, 0)
  await assert.rejects(service.authorizeInstall(vm, { allowLegacyReissue: true }), { code: 'slot_limit_reached' })
  assert.deepEqual(fs.readFileSync(registration), oldPermit)
  assert.equal(checkCragLicense(root, vm).ok, true)

  rejectBind = false
  await service.authorizeInstall(vm, { allowLegacyReissue: true })
  assert.equal(requests, 2)
  const next = checkCragLicense(root, vm, {}, { preferInstalled: false })
  assert.equal(next.ok, true)
  assert.equal(next.license.scope, 'host')
  assert.equal(next.license.seat, 1)
})

for (const runtime of ['docker', 'kvm']) {
  test(`H2 ${runtime} release requires confirmed teardown and recovers an interrupted cloud response`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-roster-contract-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const source = path.join(root, 'machine-id')
    fs.writeFileSync(source, crypto.randomBytes(16).toString('hex'), { mode: 0o600 })
    const publicDir = cragSubscriptionPublicDirectory(root)
    fs.mkdirSync(path.dirname(path.dirname(publicDir)), { recursive: true })
    seedEncryptedPackage(root)
    const slots = ['vm-41', 'vm-42'].map((id) => ({
      id,
      dataplane: 'crag',
      crag_kernel_version: 'v2',
      runtime: { type: runtime },
    }))
    for (const vm of slots) {
      const dir = path.join(root, 'vms', vm.id)
      fs.mkdirSync(dir, { recursive: true })
      const machine = crypto.randomBytes(16).toString('hex')
      vm.fingerprint = { guest_machine_id: machine }
      fs.writeFileSync(path.join(dir, 'machine-id'), machine)
    }
    let rights,
      permitDigest,
      releases = 0,
      revision = 0,
      version = 1
    let roster = []
    let authorityAvailable = true
    let reportedAvailable
    const connect = () =>
      createCragSubscription({
        projectRoot: root,
        machineIdFile: source,
        listTargets: () => slots,
        assertReady: () => true,
        blockKvmBinding: async () => true,
        publishKvmBinding: async () => true,
        fetchImpl: async (url, init) => {
          const action = url.split('/').at(-1)
          if (action === 'status' && !authorityAvailable) return new Response(null, { status: 503 })
          const { host_id, machine_code, permit_sha256, vm_id } = JSON.parse(init.body)
          let extra = {}
          if (action === 'upgrade') version = 2
          if (action === 'bind') {
            const { code } = issueSlotPermit(root, machine_code, host_id, { seat: 1 })
            permitDigest = crypto.createHash('sha256').update(code).digest('hex')
            roster = [{ seat: 1, permit_sha256: permitDigest }]
            extra = { seat: 1, slot_permit: code }
          }
          if (action === 'release') {
            assert.equal(vm_id, slots[0].id)
            assert.equal(permit_sha256, permitDigest)
            if (++releases === 1) roster = []
          }
          if (action !== 'status' && (action !== 'release' || releases === 1)) {
            const base = issueHostEntitlement(root, host_id, { revision: ++revision, slot_limit: 1 })
            const entitlement =
              version === 1
                ? base.code
                : signSubscriptionBytes(root, 'CRAGH2', JSON.stringify({ ...base.claims, version, roster }))
            rights = { entitlement, revision, slot_limit: 1, expires_at: base.claims.expires_at }
          }
          if (action === 'release' && releases === 1) throw Error('reply lost')
          return Response.json({
            ok: true,
            data: {
              ...rights,
              used_slots: roster.length,
              available_slots: reportedAvailable ?? 1 - roster.length,
              ...extra,
            },
          })
        },
      })
    const service = connect()
    await service.redeem(voucher())
    authorityAvailable = false
    const upgraded = await service.upgrade()
    assert.equal(upgraded.used_slots, 0)
    assert.equal(upgraded.available_slots, 1, 'upgrade keeps freshly confirmed slots despite a failing status read')
    authorityAvailable = true
    await service.bind(slots[0])
    assert.equal(checkCragLicense(root, slots[0]).ok, true)
    await assert.rejects(
      service.teardown(slots[0], async () => ({ ok: true })),
      { code: 'crag_subscription_teardown_unconfirmed' },
    )
    assert.equal(releases, 0)
    await assert.rejects(
      service.teardown(slots[0], async () => ({ ok: true, teardownConfirmed: true })),
      { code: 'crag_subscription_authority_unavailable' },
    )
    const recovered = connect()
    const pending = await recovered.status()
    assert.equal(pending.state, 'sync_pending')
    assert.equal(Object.hasOwn(pending, 'used_slots'), false)
    assert.equal(Object.hasOwn(pending, 'available_slots'), false)
    assert.equal(await recovered.recover(), undefined)
    assert.equal(checkCragLicense(root, slots[0]).ok, false)
    assert.equal((await recovered.status()).available_slots, 1)
    reportedAvailable = 0
    assert.equal(
      (await recovered.status()).available_slots,
      0,
      'the Authority can report no capacity despite a free seat',
    )
    authorityAvailable = false
    assert.equal(
      (await recovered.status()).available_slots,
      undefined,
      'the signed roster does not substitute for live quota',
    )
    authorityAvailable = true
    reportedAvailable = undefined
    await recovered.bind(slots[1])
    assert.equal(checkCragLicense(root, slots[0]).ok, false)
    assert.equal(checkCragLicense(root, slots[1]).ok, true)
  })
}

test('one running slot may update at capacity, and only confirmed stopped seats can be reused', async (t) => {
  let roster = []
  let revision = 0
  let signed
  let releases = 0
  let binds = 0
  const { root, connect } = standaloneHost(t, async (url, { body }) => {
    const action = url.split('/').at(-1)
    const { host_id, machine_code, permit_sha256, vm_id } = JSON.parse(body)
    let result = {}
    if (action === 'release') {
      assert.equal(vm_id, 'vm-61')
      assert.equal(permit_sha256, roster[0].permit_sha256)
      releases++
      roster = []
    }
    if (action === 'bind') {
      if (roster.length > 0) return Response.json({ ok: false, error: { code: 'slot_limit_reached' } }, { status: 409 })
      binds++
      const { code } = issueSlotPermit(root, machine_code, host_id, { seat: 1 })
      roster = [{ seat: 1, permit_sha256: crypto.createHash('sha256').update(code).digest('hex') }]
      result = { seat: 1, slot_permit: code }
    }
    if (action !== 'status') {
      const { claims } = issueHostEntitlement(root, host_id, { revision: ++revision, slot_limit: 1 })
      signed = {
        entitlement: signSubscriptionBytes(root, 'CRAGH2', JSON.stringify({ ...claims, version: 2, roster })),
        revision,
        expires_at: claims.expires_at,
        slot_limit: 1,
        used_slots: roster.length,
        available_slots: 1 - roster.length,
      }
    }
    return Response.json({ ok: true, data: { ...signed, ...result } })
  })
  seedEncryptedPackage(root)
  const [first, second] = ['vm-61', 'vm-62'].map((id) => ({ id, dataplane: 'crag', status: 'stopped' }))
  for (const vm of [first, second]) {
    const dir = path.join(root, 'vms', vm.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'machine-id'), crypto.randomBytes(16).toString('hex'))
  }
  let vms = {}
  let restartDisabled = false
  const service = connect({
    listTargets: () => [first, second],
    assertReady: () => true,
    runtimeInventory: { snapshot: async () => ({ vms }), confirmReclaimableStop: async () => restartDisabled },
  })
  await service.redeem(voucher())
  const entered = Promise.withResolvers()
  const ready = Promise.withResolvers()
  const boot = service.withRuntimeAdmission(first, { bindSubscription: true }, async () => {
    entered.resolve()
    return ready.promise
  })
  await entered.promise
  const startSecond = () => service.withRuntimeAdmission(second, { bindSubscription: true }, () => ({ ok: true }))
  assert.equal((await startSecond()).code, 'license_crag_host_over_quota')
  ready.resolve({ ok: true })
  await boot
  first.status = 'running'
  vms = { [first.id]: { state: 'running', scope: 'host' } }
  assert.equal((await service.withRuntimeAdmission(first, { install: true }, () => ({ ok: true }))).ok, true)
  assert.equal(binds, 1)
  first.status = 'stopped'
  vms[first.id] = { state: 'not_running', scope: 'host' }
  assert.equal((await startSecond()).code, 'license_crag_host_usage_unverified')
  assert.equal(releases, 0)
  vms[first.id].stopped_confirmed = true
  assert.equal((await startSecond()).code, 'slot_limit_reached')
  assert.equal(releases, 0)
  restartDisabled = true
  assert.equal((await startSecond()).ok, true)
  assert.equal(releases, 1)
  assert.equal(binds, 2)
  assert.equal(checkCragLicense(root, first).code, 'license_required')
  assert.equal(checkCragLicense(root, second).license.seat, 1)
})

async function seatReleaseFixture(t, { version = 1, count = 2 } = {}) {
  const state = { version, revision: 0, roster: [], calls: [], stopped: new Set(), targets: [], releaseFailure: false }
  const context = standaloneHost(t, async (url, { body }) => {
    const action = url.split('/').at(-1)
    const request = JSON.parse(body)
    state.calls.push({ action, ...request })
    let binding
    let changed = action === 'redeem'
    if (action === 'bind') {
      const seat = Math.max(0, ...state.roster.map((entry) => entry.seat)) + 1
      binding = issueSlotPermit(context.root, request.machine_code, request.host_id, { seat })
      state.roster.push({ seat, permit_sha256: crypto.createHash('sha256').update(binding.code).digest('hex') })
      changed = state.version === 2
    }
    if (action === 'upgrade') {
      state.version = 2
      changed = true
    }
    if (action === 'release') {
      const before = state.roster.length
      state.roster = state.roster.filter((entry) => entry.permit_sha256 !== request.permit_sha256)
      changed = before !== state.roster.length
    }
    if (changed) {
      const rights = issueHostEntitlement(context.root, request.host_id, { slot_limit: 10, revision: ++state.revision })
      state.rights =
        state.version === 1
          ? rights
          : {
              claims: { ...rights.claims, version: 2, roster: state.roster.map((entry) => ({ ...entry })) },
              code: signSubscriptionBytes(
                context.root,
                'CRAGH2',
                JSON.stringify({ ...rights.claims, version: 2, roster: state.roster }),
              ),
            }
    }
    if (action === 'release' && state.releaseFailure) throw new Error('lost release response')
    return Response.json({
      ok: true,
      data: {
        entitlement: state.rights.code,
        ...state.rights.claims,
        used_slots: state.roster.length,
        available_slots: 10 - state.roster.length,
        ...(binding && { seat: binding.claims.seat, slot_permit: binding.code }),
      },
    })
  })
  seedEncryptedPackage(context.root)
  const createVm = (id) => {
    const vm = { id, dataplane: 'crag', status: 'running', runtime: { type: 'docker' } }
    const dir = path.join(context.root, 'vms', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'machine-id'), crypto.randomBytes(16).toString('hex'))
    state.targets.push(vm)
    return vm
  }
  const connect = (options = {}) =>
    context.connect({
      listTargets: () => state.targets,
      getTarget: (id) => state.targets.find((vm) => vm.id === id),
      assertReady: () => true,
      isSlotEnabled: () => false,
      runtimeInventory: { confirmReclaimableStop: async (vm) => state.stopped.has(vm.id) },
      ...options,
    })
  const service = connect()
  await service.redeem(voucher())
  for (let i = 0; i < count; i++) await service.bind(createVm(`vm-release-${i}`))
  const forget = (vm) => {
    state.targets = state.targets.filter((candidate) => candidate !== vm)
    fs.rmSync(path.join(context.root, 'vms', vm.id), { recursive: true, force: true })
  }
  const destroy = async (required) => {
    assert.equal(required, true)
    return { ok: true, teardownConfirmed: true }
  }
  return {
    ...context,
    connect,
    service,
    state,
    createVm,
    forget,
    destroy,
    deferredFile: path.join(context.privateDir, 'deleted-slots.json'),
  }
}

test('H1 deletion preserves exact evidence until H2 upgrade releases the deleted seat', async (t) => {
  const f = await seatReleaseFixture(t)
  const removed = f.state.targets[0]
  const digest = f.state.roster[0].permit_sha256
  const deleted = await f.service.teardown(removed, f.destroy)
  assert.equal(deleted.reclaim_pending, true)
  f.forget(removed)
  assert.equal(fs.statSync(f.deferredFile).mode & 0o777, 0o600)
  assert.equal(fs.statSync(f.privateDir).mode & 0o777, 0o700)
  const saved = JSON.parse(fs.readFileSync(f.deferredFile, 'utf8'))
  assert.deepEqual(saved.entries, [{ vm_id: removed.id, permit_sha256: digest, proven: true }])
  assert.doesNotMatch(JSON.stringify(saved), /CRAGS1|CRAGR1|private_key|credential/)
  assert.equal(fs.existsSync(path.join(f.publicDir, 'sync-pending')), false)
  await f.connect().recover()
  assert.equal(f.state.calls.filter(({ action }) => action === 'release').length, 0)
  assert.equal((await f.service.status()).reclaim_pending_count, 1)
  const upgraded = await f.service.upgrade()
  assert.equal(upgraded.reclaim_supported, true)
  assert.equal(upgraded.reclaim_pending_count, 0)
  assert.equal(upgraded.available_seats, 9)
  assert.equal(f.state.roster.length, 1)
  assert.equal(fs.existsSync(f.deferredFile), false)
  assert.deepEqual(
    f.state.calls
      .filter(({ action }) => action === 'release')
      .map(({ vm_id, permit_sha256 }) => ({ vm_id, permit_sha256 })),
    [{ vm_id: removed.id, permit_sha256: digest }],
  )
})

test('H1 deletion stores unproven intent before destruction and never reclaims an unconfirmed delete', async (t) => {
  const f = await seatReleaseFixture(t)
  const vm = f.state.targets[0]
  await assert.rejects(
    f.service.teardown(vm, async (required) => {
      assert.equal(required, true)
      assert.equal(JSON.parse(fs.readFileSync(f.deferredFile, 'utf8')).entries[0].proven, false)
      return { ok: true }
    }),
    { code: 'crag_subscription_teardown_unconfirmed' },
  )
  assert.equal((await f.service.status()).state, 'active')
  assert.equal((await f.service.status()).reclaim_pending_count, 0)
  await f.service.bind(f.createVm('vm-another-binding'))
  await f.service.upgrade()
  await f.connect().recover()
  assert.equal(f.state.calls.filter(({ action }) => action === 'release').length, 0)
  assert.equal(JSON.parse(fs.readFileSync(f.deferredFile, 'utf8')).entries[0].proven, false)
  assert.equal(f.state.roster.length, 3)
})

test('multiple H1 deletions survive a lost H2 release response and recover without VM records', async (t) => {
  const f = await seatReleaseFixture(t, { count: 3 })
  for (const vm of f.state.targets.slice(0, 2)) {
    await f.service.teardown(vm, f.destroy)
    f.forget(vm)
  }
  f.state.releaseFailure = true
  await assert.rejects(f.service.upgrade(), { code: 'crag_subscription_authority_unavailable' })
  assert.equal(JSON.parse(fs.readFileSync(f.deferredFile, 'utf8')).entries.length, 2)
  assert.equal(fs.existsSync(path.join(f.publicDir, 'sync-pending')), true)
  const intent = JSON.parse(fs.readFileSync(path.join(f.privateDir, 'roster.json'), 'utf8'))
  assert.equal(intent.proven, true)
  assert.equal(intent.deferred, true)
  f.state.releaseFailure = false
  await f.connect().recover()
  assert.equal(fs.existsSync(f.deferredFile), false)
  assert.equal(fs.existsSync(path.join(f.publicDir, 'sync-pending')), false)
  assert.equal(f.state.roster.length, 1)
  await f.connect().recover()
  assert.equal(f.state.roster.length, 1)
})

test('deferred deletion never removes a new permit that reuses the same VM id', async (t) => {
  const f = await seatReleaseFixture(t)
  const old = f.state.targets[0]
  const digest = f.state.roster[0].permit_sha256
  await f.service.teardown(old, f.destroy)
  f.forget(old)
  const replacement = f.createVm(old.id)
  await f.service.bind(replacement)
  const registration = path.join(cragLicenseDirectory(f.root, replacement), 'registration.code')
  const fresh = fs.readFileSync(registration)
  await f.service.upgrade()
  assert.equal(
    f.state.roster.some((entry) => entry.permit_sha256 === digest),
    false,
  )
  assert.deepEqual(fs.readFileSync(registration), fresh)
  assert.equal(checkCragLicense(f.root, replacement).ok, true)
})

test('an H2 host can replay deferred deletion through upgrade without probing a live CRAG target', async (t) => {
  const f = await seatReleaseFixture(t)
  const vm = f.state.targets[0]
  await f.service.teardown(vm, f.destroy)
  f.forget(vm)
  const entries = fs.readFileSync(f.deferredFile)
  fs.unlinkSync(f.deferredFile)
  await f.service.upgrade()
  fs.writeFileSync(f.deferredFile, entries, { mode: 0o600 })
  const upgraded = await f.connect({ assertReady: () => false }).upgrade()
  assert.equal(upgraded.reclaim_pending_count, 0)
  assert.equal(f.state.roster.length, 1)
})

test('deferred release evidence rejects a foreign host and unsafe files before destruction', async (t) => {
  const f = await seatReleaseFixture(t)
  const vm = f.state.targets[0]
  await f.service.teardown(vm, f.destroy)
  const saved = JSON.parse(fs.readFileSync(f.deferredFile, 'utf8'))
  fs.writeFileSync(f.deferredFile, JSON.stringify({ ...saved, host_id: 'f'.repeat(64) }))
  await assert.rejects(f.connect().recover(), { code: 'crag_subscription_host_identity_changed' })
  await assert.rejects(
    f.service.teardown(vm, () => assert.fail('foreign evidence must prevent destruction')),
    { code: 'crag_subscription_host_identity_changed' },
  )
  fs.writeFileSync(f.deferredFile, JSON.stringify(saved))
  fs.chmodSync(f.deferredFile, 0o644)
  await assert.rejects(f.service.teardown(vm, () => assert.fail('unsafe evidence must prevent destruction')))
  fs.chmodSync(f.deferredFile, 0o600)
  const original = path.join(f.root, 'original-deferred')
  fs.renameSync(f.deferredFile, original)
  fs.symlinkSync(original, f.deferredFile)
  await assert.rejects(f.connect().recover())
  assert.equal(f.state.calls.filter(({ action }) => action === 'release').length, 0)
})

test('H2 explicit release stops and rechecks the physical runtime before removing the exact permit', async (t) => {
  const f = await seatReleaseFixture(t, { version: 2 })
  const vm = f.state.targets[0]
  vm.dataplane = 'wrap'
  const registration = path.join(cragLicenseDirectory(f.root, vm), 'registration.code')
  const stopped = []
  await assert.rejects(f.service.releaseStoppedBinding(vm, { stop: async () => ({ ok: true }) }), {
    code: 'crag_subscription_stop_unconfirmed',
  })
  assert.equal(f.state.calls.filter(({ action }) => action === 'release').length, 0)
  assert.equal(fs.existsSync(registration), true)
  const result = await f.service.releaseStoppedBinding(vm, {
    stop: async (target) => {
      stopped.push(target.id)
      f.state.stopped.add(target.id)
      target.status = 'stopped'
      return { ok: true }
    },
  })
  assert.deepEqual(result, { released: true, stopped: true, reclaim_supported: true })
  assert.deepEqual(stopped, [vm.id])
  assert.equal(f.state.roster.length, 1)
  assert.equal(fs.existsSync(registration), false)
  assert.equal(fs.existsSync(path.join(f.publicDir, 'sync-pending')), false)
})

test('H2 stopped release recovers a lost response and H1 release never upgrades or stops a slot', async (t) => {
  const legacy = await seatReleaseFixture(t)
  const vm = legacy.state.targets[0]
  const prior = legacy.state.calls.length
  assert.deepEqual(await legacy.service.releaseStoppedBinding(vm, { stop: () => assert.fail('H1 cannot release') }), {
    released: false,
    stopped: false,
    reclaim_supported: false,
    reclaim_pending: true,
  })
  assert.equal(legacy.state.calls.length, prior)
  const f = await seatReleaseFixture(t, { version: 2 })
  const target = f.state.targets[0]
  f.state.stopped.add(target.id)
  f.state.releaseFailure = true
  await assert.rejects(f.service.releaseStoppedBinding(target), { code: 'crag_subscription_authority_unavailable' })
  f.state.releaseFailure = false
  assert.equal((await f.connect().releaseStoppedBinding(target)).released, true)
  assert.equal(fs.existsSync(path.join(cragLicenseDirectory(f.root, target), 'registration.code')), false)
})

test('slots without host entitlement do not need host identity or invoke a stop callback', async (t) => {
  const f = standaloneHost(t, () => assert.fail('an unconfigured host must not contact Authority'))
  fs.unlinkSync(f.machineIdFile)
  assert.deepEqual(
    await f.connect().releaseStoppedBinding(
      { id: 'vm-default', dataplane: 'wrap' },
      {
        stop: () => assert.fail('an unconfigured host must not stop the slot'),
      },
    ),
    { released: false, stopped: false, reclaim_supported: false },
  )
  const configured = await seatReleaseFixture(t, { version: 2 })
  fs.unlinkSync(configured.machineIdFile)
  await assert.rejects(configured.service.releaseStoppedBinding(configured.state.targets[0]), {
    code: 'crag_subscription_host_identity_unavailable',
  })
})

test('deferred deletion is bounded and refuses duplicate or malformed evidence', async (t) => {
  const f = await seatReleaseFixture(t)
  const vm = f.state.targets[0]
  const hostId = f.service.purchaseDeviceId()
  const entry = (index) => ({
    vm_id: `vm-deferred-${index}`,
    permit_sha256: index.toString(16).padStart(64, '0'),
    proven: false,
  })
  const write = (entries) =>
    fs.writeFileSync(f.deferredFile, JSON.stringify({ version: 1, host_id: hostId, entries }), { mode: 0o600 })
  write(Array.from({ length: 10000 }, (_, index) => entry(index)))
  await assert.rejects(
    f.service.teardown(vm, () => assert.fail('full evidence storage must not destroy the VM')),
    { code: 'crag_subscription_reclaim_limit' },
  )
  for (const entries of [
    Array.from({ length: 10001 }, (_, index) => entry(index)),
    [entry(1), entry(1)],
    [{ ...entry(1), vm_id: '../escape' }],
    [{ ...entry(1), proven: 'true' }],
    [{ ...entry(1), extra: 'unexpected' }],
  ]) {
    write(entries)
    await assert.rejects(f.connect().recover(), { code: 'crag_subscription_invalid_reclaim' })
  }
  assert.equal(f.state.calls.filter(({ action }) => action === 'release').length, 0)
})

test('a deferred deletion of a record that was restarted with the same permit stays pending', async (t) => {
  const f = await seatReleaseFixture(t)
  const vm = f.state.targets[0]
  await f.service.teardown(vm, f.destroy)
  await f.service.upgrade()
  assert.equal(f.state.calls.filter(({ action }) => action === 'release').length, 0)
  assert.equal((await f.service.status()).reclaim_pending_count, 1)
  f.state.stopped.add(vm.id)
  await f.connect().recover()
  assert.equal(fs.existsSync(f.deferredFile), false)
  assert.equal(fs.existsSync(path.join(cragLicenseDirectory(f.root, vm), 'registration.code')), false)
})

test('H2 stopped release detects a replaced permit after stop and preserves the new binding', async (t) => {
  const f = await seatReleaseFixture(t, { version: 2 })
  const [vm, other] = f.state.targets
  const registration = path.join(cragLicenseDirectory(f.root, vm), 'registration.code')
  const replacement = fs.readFileSync(path.join(cragLicenseDirectory(f.root, other), 'registration.code'))
  await assert.rejects(
    f.service.releaseStoppedBinding(vm, {
      stop: async () => {
        fs.writeFileSync(registration, replacement)
        f.state.stopped.add(vm.id)
        return { ok: true }
      },
    }),
  )
  assert.deepEqual(fs.readFileSync(registration), replacement)
  assert.equal(f.state.calls.filter(({ action }) => action === 'release').length, 0)
})

test('only an authenticated same-origin admin session can redeem without revealing a failed voucher', async () => {
  const code = voucher()
  let attempts = 0
  const handler = createCragSubscriptionHandler({
    subscription: {
      redeem: () => {
        attempts++
        throw Object.assign(new Error(`upstream echoed ${code}`), { code: 'redeem_unavailable', status: 404 })
      },
    },
    json: (_, status, body) => ({ status, body }),
    readRawBody: () => Buffer.from(JSON.stringify({ redemption_code: code })),
  })
  const route = cragSubscriptionRoute('POST', '/api/panel/crag-subscription/redeem')
  const req = {
    panelUser: 'owner',
    panelRole: 'admin',
    headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' },
  }
  const res = { setHeader() {} }
  assert.equal((await handler({ ...req, apiKeyKind: 'managed' }, res, route)).status, 403)
  assert.equal((await handler({ ...req, panelRole: 'user' }, res, route)).status, 403)
  assert.equal(
    (await handler({ ...req, headers: { ...req.headers, origin: 'https://example.invalid' } }, res, route)).status,
    403,
  )
  assert.equal(attempts, 0)
  const response = await handler(req, res, route)
  assert.equal(response.status, 404)
  assert.equal(response.body.error.code, 'redeem_unavailable')
  assert.equal(attempts, 1)
  assert.equal(JSON.stringify(response).includes(code), false)
  // The master API key is operator automation without a browser origin.
  const master = await handler(
    { apiKeyKind: 'master', headers: { host: 'localhost', 'content-type': 'application/json' } },
    res,
    route,
  )
  assert.equal(master.status, 404)
  assert.equal(attempts, 2)
})

test('failed authority syncs clear locks, new orders reconcile stale pins, and existing services stay active', async (t) => {
  let failRedeemWith409 = false
  let loseOrderRedeem = false
  let current
  let seats = 0
  const { root, publicDir, privateDir, connect } = standaloneHost(t, async (url, { body }) => {
    const action = url.split('/').at(-1)
    const parsed = JSON.parse(body)
    if (action === 'redeem') {
      if (failRedeemWith409) {
        return Response.json({ ok: false, error: { code: 'host_binding_conflict' } }, { status: 409 })
      }
      if (loseOrderRedeem) {
        loseOrderRedeem = false
        throw new Error('network lost on order 1')
      }
      current = issueHostEntitlement(root, parsed.host_id, {
        revision: (current?.claims?.revision ?? 0) + 1,
        slot_limit: 3,
      })
      return Response.json({
        ok: true,
        data: { entitlement: current.code, ...current.claims, used_slots: seats, available_slots: 3 - seats },
      })
    }
    if (action === 'status') {
      return Response.json({
        ok: true,
        data: { entitlement: current.code, ...current.claims, used_slots: seats, available_slots: 3 - seats },
      })
    }
    const seat = ++seats
    const { code } = issueSlotPermit(root, parsed.machine_code, parsed.host_id, { seat })
    return Response.json({
      ok: true,
      data: { entitlement: current.code, ...current.claims, seat, slot_permit: code },
    })
  })
  seedEncryptedPackage(root)
  const vm1 = { id: 'vm-81', dataplane: 'crag', crag_kernel_version: 'v2', status: 'running' }
  const vm2 = { id: 'vm-82', dataplane: 'crag', crag_kernel_version: 'v2', status: 'stopped' }
  for (const vm of [vm1, vm2]) {
    const dir = path.join(root, 'vms', vm.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'machine-id'), crypto.randomBytes(16).toString('hex'))
  }
  const service = connect({
    listTargets: () => [vm1, vm2],
    getTarget: (id) => [vm1, vm2].find((v) => v.id === id),
    assertReady: () => true,
  })
  await service.redeem(voucher())
  await service.bind(vm1)
  assert.equal(await service.admitInference({ vm: vm1 }), null)

  // Deterministic 4xx authority rejection must clear sync-pending immediately.
  failRedeemWith409 = true
  await assert.rejects(service.redeem(voucher()), { code: 'host_binding_conflict' })
  assert.equal((await service.status()).state, 'active')
  assert.equal(fs.existsSync(path.join(publicDir, 'sync-pending')), false)
  assert.equal(fs.existsSync(path.join(privateDir, 'redeem.json')), false)
  failRedeemWith409 = false

  // An interrupted order-1 leaves sync_pending, must NOT pause vm1, and order-2 reconciles cleanly.
  const fp2 = await service.pinOrderTarget(vm2.id)
  loseOrderRedeem = true
  await assert.rejects(
    service.activateOrder({
      orderId: 'ord-1',
      target: { vm_id: vm2.id, fingerprint: fp2 },
      claim: () => voucher(),
    }),
    { code: 'crag_subscription_authority_unavailable' },
  )
  assert.equal((await service.status()).state, 'sync_pending')
  assert.equal(checkCragLicense(root, vm1).ok, true)
  assert.equal(await service.admitInference({ vm: vm1 }), null)

  const activated = await service.activateOrder({
    orderId: 'ord-2',
    target: { vm_id: vm2.id, fingerprint: fp2 },
    claim: () => voucher(),
  })
  assert.equal(activated.seat, 2)
  assert.equal((await service.status()).state, 'active')

  // A running KVM slot must also be restored (never left blocked) when a 503 leaves sync_pending.
  let kvmBlocked = false
  const kvm = {
    id: 'vm-kvm-83',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    status: 'running',
    runtime: { type: 'kvm' },
    fingerprint: { guest_machine_id: crypto.randomBytes(16).toString('hex') },
  }
  fs.mkdirSync(path.join(root, 'vms', kvm.id), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', kvm.id, 'machine-id'), `${kvm.fingerprint.guest_machine_id}\n`)
  const kvmService = connect({
    listTargets: () => [vm1, vm2, kvm],
    getTarget: (id) => [vm1, vm2, kvm].find((v) => v.id === id),
    assertReady: () => true,
    blockKvmBinding: async () => {
      kvmBlocked = true
      return true
    },
    publishKvmBinding: async () => {
      kvmBlocked = false
      return true
    },
  })
  await kvmService.bind(kvm)
  assert.equal(kvmBlocked, false)

  // A 503 during standalone renewal leaves sync_pending, yet restoreKvmBindings unblocks the running KVM slot.
  loseOrderRedeem = true
  await assert.rejects(kvmService.redeem(voucher(), true), { code: 'crag_subscription_authority_unavailable' })
  assert.equal((await kvmService.status()).state, 'sync_pending')
  assert.equal(kvmBlocked, false, '503 sync_pending must not leave running KVM slot blocked')
  assert.equal(await kvmService.admitInference({ vm: kvm }), null)
  await kvmService.recover()
  assert.equal((await kvmService.status()).state, 'active')

  // Orphaned sync-pending marker without intent files is healed by recover().
  fs.writeFileSync(path.join(publicDir, 'sync-pending'), 'pending\n')
  await service.recover()
  assert.equal(fs.existsSync(path.join(publicDir, 'sync-pending')), false)
})

test('runtime admission reclaims non-crag/orphaned seats and rebinds over-quota slots when running CRAG is below limit', async (t) => {
  let roster = []
  let revision = 0
  let slotLimit = 2
  let signed
  const { root, connect } = standaloneHost(t, async (url, { body }) => {
    const action = url.split('/').at(-1)
    const { host_id, machine_code, permit_sha256 } = JSON.parse(body)
    let result = {}
    if (action === 'release') {
      roster = roster.filter((entry) => entry.permit_sha256 !== permit_sha256)
    }
    if (action === 'bind') {
      const freeSeat = [1, 2].find((s) => s <= slotLimit && !roster.some((e) => e.seat === s))
      if (!freeSeat) return Response.json({ ok: false, error: { code: 'slot_limit_reached' } }, { status: 409 })
      const { code } = issueSlotPermit(root, machine_code, host_id, { seat: freeSeat })
      roster.push({ seat: freeSeat, permit_sha256: crypto.createHash('sha256').update(code).digest('hex') })
      roster.sort((a, b) => a.seat - b.seat)
      result = { seat: freeSeat, slot_permit: code }
    }
    const visibleRoster = roster.filter((entry) => entry.seat <= slotLimit)
    const { claims } = issueHostEntitlement(root, host_id, { revision: ++revision, slot_limit: slotLimit })
    signed = {
      entitlement: signSubscriptionBytes(
        root,
        'CRAGH2',
        JSON.stringify({ ...claims, version: 2, roster: visibleRoster }),
      ),
      revision,
      expires_at: claims.expires_at,
      slot_limit: slotLimit,
      used_slots: visibleRoster.length,
      available_slots: slotLimit - visibleRoster.length,
    }
    return Response.json({ ok: true, data: { ...signed, ...result } })
  })
  seedEncryptedPackage(root)
  const vm1 = { id: 'vm-91', dataplane: 'crag', crag_kernel_version: 'v2', status: 'stopped' }
  const vm2 = { id: 'vm-92', dataplane: 'crag', crag_kernel_version: 'v2', status: 'stopped' }
  const vm3 = { id: 'vm-93', dataplane: 'crag', crag_kernel_version: 'v2', status: 'stopped' }
  for (const vm of [vm1, vm2, vm3]) {
    const dir = path.join(root, 'vms', vm.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'machine-id'), crypto.randomBytes(16).toString('hex'))
  }
  const targets = [vm1, vm2, vm3]
  const vms = {}
  const service = connect({
    listTargets: () => targets,
    assertReady: () => true,
    runtimeInventory: {
      snapshot: async () => ({ vms }),
      confirmReclaimableStop: async (vm) => vm.status === 'stopped',
    },
  })
  await service.redeem(voucher())
  await service.bind(vm1)
  await service.bind(vm2)
  assert.equal(checkCragLicense(root, vm2).license.seat, 2)

  // Downgrade limit to 1, switch vm1 to cli-node (running wrap), leaving vm2 with historical seat 2.
  slotLimit = 1
  await service.redeem(voucher(), true)
  vm1.dataplane = 'wrap'
  vm1.status = 'running'
  vms[vm1.id] = { state: 'not_running', non_crag_confirmed: true, scope: 'host' }
  assert.equal(checkCragLicense(root, vm2).code, 'license_crag_host_over_quota')

  // Starting vm2 automatically reclaims switched-away vm1 (seat 1) and rebinds vm2 to seat 1.
  const startedVm2 = await service.withRuntimeAdmission(vm2, { bindSubscription: true }, () => ({ ok: true }))
  assert.equal(startedVm2.ok, true)
  assert.equal(checkCragLicense(root, vm2).license.seat, 1)
  vm2.status = 'running'
  vms[vm2.id] = { state: 'running', scope: 'host' }

  // Reaching running limit blocks vm3 from starting, while vm2 continues serving inference uninterrupted.
  const blockedVm3 = await service.withRuntimeAdmission(vm3, { bindSubscription: true }, () => ({ ok: true }))
  assert.equal(blockedVm3.code, 'license_crag_host_over_quota')
  assert.equal(await service.admitInference({ vm: vm2 }), null)
})
