import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCragSubscription } from '../../src/lib/vm/crag-subscription.mjs'
import { createCragRuntimeInventory } from '../../src/lib/vm/crag-runtime-inventory.mjs'
import { checkCragLicense } from '../../src/lib/vm/crag-license.mjs'
import { cragSubscriptionPublicDirectory } from '../../src/lib/vm/crag-subscription-paths.mjs'
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

test('an admin can redeem without VMs and a second voucher replaces the signed capacity', async (t) => {
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
      slot_limit: request.redemption_code === first ? 2 : 3,
    })
    return Response.json({ ok: true, data: { entitlement: code, ...claims, used_slots: 0 } })
  })
  seedEncryptedPackage(root)
  const post = postSubscription(connect())
  const initial = await post('redeem', { redemption_code: ` ${first}\n` })
  assert.equal(initial.status, 200)
  assert.equal(initial.data.state, 'active')
  assert.equal(initial.data.slot_limit, 2)
  assert.equal(initial.data.ready, false)
  assert.equal(initial.data.total_slots, 0)
  assert.equal(initial.data.enabled_slots, 0)
  assert.equal(initial.data.used_slots, 0)

  const replacement = await post('redeem', { redemption_code: second })
  assert.equal(replacement.status, 200)
  assert.equal(replacement.data.slot_limit, 3)
  assert.equal(replacement.data.revision, 2)
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

test('admission retries local rights once within the original quota deadline', async (testContext) => {
  for (const mode of ['downgrade', 'changing', 'pending']) {
    await testContext.test(mode, async (subtest) => {
      let issued
      const { root, publicDir, connect } = standaloneHost(subtest, async (url, { body }) => {
        const request = JSON.parse(body)
        issued ??= issueHostEntitlement(root, request.host_id)
        if (url.endsWith('/bind')) {
          const permit = issueSlotPermit(root, request.machine_code, request.host_id, { seat: 1 })
          return Response.json({ ok: true, data: { entitlement: issued.code, slot_permit: permit.code, seat: 1 } })
        }
        return Response.json({ ok: true, data: { entitlement: issued.code, ...issued.claims } })
      })
      seedEncryptedPackage(root)
      const vm = { id: 'vm-51', dataplane: 'crag', crag_kernel_version: 'v2' }
      const directory = path.join(root, 'vms', vm.id)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'machine-id'), crypto.randomBytes(16).toString('hex'))
      const options = { listTargets: () => [vm], assertReady: () => true, isSlotEnabled: undefined }
      const initial = connect(options)
      await initial.redeem(voucher())
      await initial.bind(vm)
      const waits = []
      const service = connect({
        ...options,
        runtimeInventory: {
          snapshot: async ({ hostId, claims, hostOnly, timeoutMs }) => {
            assert.equal(hostOnly, true)
            waits.push(timeoutMs)
            if (waits.length === 1) await new Promise((resolve) => setTimeout(resolve, 25))
            if (mode === 'pending') {
              fs.writeFileSync(path.join(publicDir, 'sync-pending'), 'pending\n', { mode: 0o644 })
            } else if (waits.length === 1 || mode === 'changing') {
              issued = issueHostEntitlement(root, hostId, { revision: claims.revision + 1, slot_limit: 1 })
              fs.writeFileSync(path.join(publicDir, 'entitlement.code'), issued.code)
            }
            return { host_over_limit: claims.slot_limit === 1 }
          },
        },
      })
      const result = await service.admitInference({ vm })
      assert.equal(
        result.body.error.code,
        mode === 'downgrade' ? 'license_crag_host_over_quota' : 'license_crag_host_usage_unverified',
      )
      assert.equal(waits.length, mode === 'pending' ? 1 : 2)
      assert.ok(waits[0] > 0 && waits[0] <= 4000)
      if (waits.length === 2) assert.ok(waits[1] > 0 && waits[1] <= waits[0] - 10)
    })
  }
})

test('H1 and H2 status never derive displayed capacity from local rights or runtime observations', async (testContext) => {
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
        }
        offline = true
        const unavailable = await service.status()
        assert.equal(unavailable.state, expired ? 'expired' : 'active')
        assert.equal(Object.hasOwn(unavailable, 'used_slots'), false)
        assert.equal(Object.hasOwn(unavailable, 'available_slots'), false)
        fs.writeFileSync(path.join(publicDir, 'sync-pending'), 'pending\n', { mode: 0o644 })
        const pending = await service.status()
        assert.equal(pending.state, 'sync_pending')
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
  assert.deepEqual(await service.status(), { ready: true, state: 'unredeemed', total_slots: 2, enabled_slots: 0 })
  await service.redeem(voucher())
  assert.deepEqual(await service.bind(slots[0]), { seat: 1 })
  assert.deepEqual(await service.bind(slots[1]), { seat: 2 })
  assert.equal(checkCragLicense(root, slots[1]).ok, true)
  assert.equal((await service.status()).enabled_slots, 2)
  const renewal = voucher()
  lose = true
  await assert.rejects(service.redeem(renewal), { code: 'crag_subscription_authority_unavailable' })
  assert.equal((await service.status()).state, 'sync_pending')
  assert.equal((await service.status()).enabled_slots, 0)
  assert.equal(checkCragLicense(root, slots[0]).ok, false)
  assert.equal(checkCragLicense(root, slots[1]).ok, false)
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
  assert.equal((await service.status()).enabled_slots, 0)
  assert.equal(checkCragLicense(root, slots[0]).ok, false)
  assert.equal(checkCragLicense(root, slots[1]).ok, false)
  assert.equal((await service.admitInference({ vm: slots[0] })).body.error.code, 'license_crag_host_usage_unverified')
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
  assert.equal((await recovered.admitInference({ vm: slots[0] })).body.error.code, 'license_crag_host_over_quota')
  assert.equal(await recovered.admitInference({ vm: independent }), null)
  assert.equal(await recovered.admitInference({ vm: dormant }), null)

  authorityOffline = true
  observations.set(slots[1].id, 'unknown')
  observedAt += 2100
  assert.equal((await recovered.admitInference({ vm: slots[0] })).body.error.code, 'license_crag_host_usage_unverified')
  observations.set(slots[1].id, 'stopped')
  observedAt += 2100
  const stopped = await recovered.status()
  assert.equal(stopped.runtime.host_running_vms, 1)
  assert.equal(stopped.runtime.host_over_limit, false)
  assert.equal(stopped.available_slots, undefined, 'local probes do not substitute for Authority capacity')
  assert.equal(await recovered.admitInference({ vm: slots[0] }), null)
  assert.equal(checkCragLicense(root, slots[1]).ok, false, 'stopping does not legalize the out-of-range seat')
  observations.set(slots[1].id, 'running')
  observedAt += 2100
  assert.equal((await recovered.admitInference({ vm: slots[0] })).body.error.code, 'license_crag_host_over_quota')
})

test('H2 release requires confirmed teardown and recovers an interrupted cloud response', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-roster-contract-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'machine-id')
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
  assert.equal(checkCragLicense(root, slots[0]).ok, false)
  const recovered = connect()
  const pending = await recovered.status()
  assert.equal(pending.state, 'sync_pending')
  assert.equal(Object.hasOwn(pending, 'used_slots'), false)
  assert.equal(Object.hasOwn(pending, 'available_slots'), false)
  assert.equal(await recovered.recover(), undefined)
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
  assert.equal((await handler({ ...req, apiKeyKind: 'master' }, res, route)).status, 403)
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
})
