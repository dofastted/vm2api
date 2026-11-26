import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { createCragSubscription } from '../../src/lib/vm/crag-subscription.mjs'
import { CRAG_HOST_MOUNT, cragSubscriptionPublicDirectory } from '../../src/lib/vm/crag-subscription-paths.mjs'
import { toHostPath } from '../../src/lib/vm/host-path.mjs'
import { assertCragSubscriptionTargetAsync } from '../../src/lib/vm/vm-runtime.mjs'
import { materializeCragV2 } from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { issueHostEntitlement, seedEncryptedPackage } from '../fixtures/crag-license.mjs'

const voucher = () => `CRAGR1.${crypto.randomBytes(32).toString('base64url')}`
const SLOTS = 30
const PROBE_MS = 200

function redeemedHost(t, isSlotEnabled) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-status-latency-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const machineIdFile = path.join(root, 'machine-id')
  fs.writeFileSync(machineIdFile, crypto.randomBytes(16).toString('hex'), {
    mode: 0o600,
  })
  fs.mkdirSync(path.dirname(path.dirname(cragSubscriptionPublicDirectory(root))), { recursive: true })
  seedEncryptedPackage(root)
  const targets = Array.from({ length: SLOTS }, (_, i) => ({
    id: `vm-${i + 1}`,
    dataplane: 'crag',
    status: 'running',
  }))
  let issued
  const service = createCragSubscription({
    projectRoot: root,
    machineIdFile,
    listTargets: () => targets,
    isSubscriptionSlot: () => true,
    assertReady: () => true,
    isSlotEnabled,
    fetchImpl: async (url, { body }) => {
      issued ??= issueHostEntitlement(root, JSON.parse(body).host_id, {
        slot_limit: 50,
      })
      return Response.json({
        ok: true,
        data: { entitlement: issued.code, ...issued.claims },
      })
    },
  })
  return { root, service }
}

test('status counts enabled slots with bounded concurrency instead of one slot at a time', async (t) => {
  let active = 0
  let peak = 0
  const { service } = redeemedHost(t, async (vm) => {
    active++
    peak = Math.max(peak, active)
    await sleep(PROBE_MS)
    active--
    return Number(vm.id.slice(3)) % 3 !== 0
  })
  await service.redeem(voucher())
  const started = performance.now()
  const status = await service.status()
  const elapsed = performance.now() - started
  const serial = SLOTS * PROBE_MS
  console.log(`[latency] ${SLOTS} slots x ${PROBE_MS}ms probe: ${Math.round(elapsed)}ms (serial bound ${serial}ms)`)
  assert.equal(status.state, 'active')
  assert.equal(status.enabled_slots, 20)
  assert.equal(peak, 8)
  // 30 probes at 8 at a time is 4 rounds; the serial loop needed 30.
  assert.ok(elapsed < serial / 3, `status took ${elapsed}ms`)
})

test('a failing slot probe still fails the whole enabled count', async (t) => {
  let probes = 0
  const { service } = redeemedHost(t, async (vm) => {
    probes++
    await sleep(5)
    if (vm.id === 'vm-7') throw new Error('docker unavailable')
    return true
  })
  await service.redeem(voucher())
  const status = await service.status()
  assert.equal(status.target_probe_failed, true)
  assert.equal(Object.hasOwn(status, 'enabled_slots'), false)
  // A void count stops probing; only the workers already in flight finish.
  assert.ok(probes < SLOTS, `probed ${probes} of ${SLOTS} slots after a failure`)
})

test('the async target probe keeps the event loop free and matches the sync checks', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-target-async-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedEncryptedPackage(root)
  const vm = {
    id: 'vm-async',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    status: 'running',
  }
  fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', vm.id, 'machine-id'), crypto.randomBytes(16).toString('hex'))
  assert.equal(materializeCragV2(root, vm, { select: false }).ok, true)
  const source = toHostPath(cragSubscriptionPublicDirectory(root), {
    projectRoot: root,
  })
  const reply = (argv, flags) => {
    if (argv[1] === 'inspect' && argv[3].includes('.Mounts')) {
      return {
        ok: true,
        stdout: JSON.stringify([
          {
            Destination: CRAG_HOST_MOUNT,
            Type: 'bind',
            RW: false,
            Source: source,
          },
        ]),
      }
    }
    if (argv[1] === 'inspect') return { ok: true, stdout: 'true|1|bridge|||||||no|[]|false' }
    return { ok: true, stdout: JSON.stringify(flags) }
  }
  const calls = []
  let ticks = 0
  const timer = setInterval(() => ticks++, 10)
  t.after(() => clearInterval(timer))
  const run = (flags) => async (argv, opts) => {
    calls.push([argv.slice(0, 3).join(' '), opts.timeout])
    await sleep(60)
    return reply(argv, flags)
  }
  assert.equal(
    await assertCragSubscriptionTargetAsync(
      root,
      vm,
      {},
      { reclaim: true },
      { run: run({ host_subscription: 1, host_subscription_reclaim: 1 }) },
    ),
    true,
  )
  assert.equal(calls.length, 3)
  assert.ok(ticks >= 10, `event loop ticked ${ticks} times during three 60ms probes`)
  await assert.rejects(
    assertCragSubscriptionTargetAsync(root, vm, {}, { reclaim: true }, { run: run({ host_subscription: 1 }) }),
    { code: 'crag_subscription_target_unready' },
  )
  await assert.rejects(
    assertCragSubscriptionTargetAsync(
      root,
      vm,
      {},
      {},
      {
        run: async (argv) =>
          argv[1] === 'inspect' && !argv[3].includes('.Mounts')
            ? { ok: true, stdout: 'false|0' }
            : reply(argv, { host_subscription: 1 }),
      },
    ),
    { code: 'crag_subscription_target_unready' },
  )
})
