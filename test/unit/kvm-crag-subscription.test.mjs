import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test, { after, before } from 'node:test'
import {
  activateCragSubscriptionBinding,
  cragLicenseDirectory,
  prepareCragSubscriptionBinding,
  readCragSubscriptionFiles,
} from '../../src/lib/vm/crag-license.mjs'
import { cragSubscriptionPublicDirectory } from '../../src/lib/vm/crag-subscription-paths.mjs'
import { publishKvmCragLicense } from '../../src/lib/vm/kvm-crag-license.mjs'
import {
  blockKvmCragSubscription,
  holdKvmCragSubscriptionPublications,
  publishKvmCragSubscription,
} from '../../src/lib/vm/kvm-crag-subscription.mjs'
import { KVM_GUEST_EXEC, slotExecContainer } from '../../src/lib/vm/slot-exec.mjs'
import {
  issueHostEntitlement,
  issueSlotPermit,
  issueUniversalCode,
  seedEncryptedPackage,
  signSubscriptionBytes,
} from '../fixtures/crag-license.mjs'

const linuxTest = process.platform === 'linux' ? test : test.skip
const envNames = ['KIN_SLOT_RUN_ROOT', 'KIN_CRAG_V2_ROOT', 'KIN_DATA_DIR']
const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
before(() => {
  for (const name of envNames) delete process.env[name]
})
after(() => {
  for (const name of envNames) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
})

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kvm-crag-subscription-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedEncryptedPackage(root)
  const hostId = crypto.randomBytes(32).toString('hex')
  const publicDir = cragSubscriptionPublicDirectory(root)
  fs.mkdirSync(publicDir, { recursive: true, mode: 0o755 })
  fs.writeFileSync(path.join(publicDir, 'host_id'), `${hostId}\n`, { mode: 0o644 })
  const entitlementFile = path.join(publicDir, 'entitlement.code')
  function rights(overrides = {}) {
    const issued = issueHostEntitlement(root, hostId, overrides)
    fs.writeFileSync(entitlementFile, `${issued.code}\n`, { mode: 0o644 })
    return issued
  }
  const host = rights()
  function addVm(id, seat) {
    const vm = {
      id,
      status: 'running',
      dataplane: 'crag',
      crag_kernel_version: 'v2',
      runtime: { type: 'kvm' },
      fingerprint: { guest_machine_id: crypto.randomBytes(16).toString('hex') },
    }
    fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
    fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
    fs.writeFileSync(path.join(root, 'vms', vm.id, 'machine-id'), `${vm.fingerprint.guest_machine_id}\n`)
    const challenge = prepareCragSubscriptionBinding(root, vm)
    const permit = issueSlotPermit(root, challenge, hostId, { seat })
    activateCragSubscriptionBinding(root, vm, permit.code)
    return vm
  }
  const vm = addVm('vm-13', 1)
  const registration = path.join(cragLicenseDirectory(root, vm), 'registration.code')
  return {
    root,
    vm,
    publicDir,
    entitlementFile,
    registration,
    rights,
    addVm,
    revoke() {
      const code = signSubscriptionBytes(
        root,
        'CRAGH2',
        JSON.stringify({ ...host.claims, version: 2, revision: 2, roster: [] }),
      )
      fs.writeFileSync(entitlementFile, `${code}\n`, { mode: 0o644 })
    },
  }
}

function runner({ inspection = { ok: true, code: 0, stdout: 'true\n' }, onInspect, onAction } = {}) {
  const calls = []
  const requests = []
  const state = { pending: false, files: null }
  const run = async (args, options = {}) => {
    calls.push({ args, options })
    if (args[0] === 'container') return onInspect ? onInspect(args, options) : inspection
    assert.equal(args[0], 'exec')
    assert.ok(args.includes(KVM_GUEST_EXEC))
    assert.equal(typeof options.input, 'string')
    const request = JSON.parse(options.input)
    requests.push(request)
    const result = await onAction?.(request, state)
    if (result && !result.ok) return result
    if (['publish', 'publish-universal'].includes(request.action)) {
      state.pending = false
      state.files = request.files
    } else if (request.action === 'block') state.pending = true
    else assert.fail(`Unexpected guest operation: ${request.action}`)
    return result || { ok: true, code: 0, stdout: '{"ok":true}\n' }
  }
  return { runDockerExec: run, calls, requests, state, actions: () => requests.map(({ action }) => action) }
}

linuxTest('KVM publication sends verified per-slot secrets only through stdin to the guest', async (t) => {
  const { root, vm } = fixture(t)
  const fake = runner()
  const files = readCragSubscriptionFiles(root, vm)
  assert.equal(await publishKvmCragSubscription(root, vm, fake), true)
  assert.deepEqual(fake.actions(), ['publish'])
  assert.deepEqual(fake.requests[0].files, files)
  assert.equal(fake.requests[0].vm_id, vm.id)
  assert.equal(fake.requests[0].machine_id, vm.fingerprint.guest_machine_id)
  assert.ok(Number.isInteger(fake.requests[0].uid) && fake.requests[0].uid > 0)
  const exec = fake.calls.find(({ args }) => args[0] === 'exec')
  assert.deepEqual(exec.args.slice(0, 8), ['exec', '-i', slotExecContainer(vm), KVM_GUEST_EXEC, '-u', '0', '-i', '--'])
  assert.equal(exec.options.timeoutMs, 30_000)
  const privateKey = JSON.parse(files.device).private_key
  for (const { args, options } of fake.calls) {
    for (const value of args) {
      assert.equal(value.includes(privateKey), false)
      assert.equal(value.includes(files.permit), false)
      assert.equal(value.includes(files.entitlement), false)
    }
    assert.equal(Object.hasOwn(options, 'env'), false)
  }
  assert.deepEqual(Object.keys(fake.requests[0].files).sort(), ['device', 'entitlement', 'hostId', 'permit'])
  assert.equal(fake.state.pending, false)
})

linuxTest('a revocation block waits for an older publish and remains the final guest state', async (t) => {
  const { root, vm } = fixture(t)
  const entered = deferred()
  const resume = deferred()
  t.after(resume.resolve)
  const fake = runner({
    onAction: async ({ action }) => {
      if (action === 'publish') {
        entered.resolve()
        await resume.promise
      }
    },
  })
  const publication = publishKvmCragSubscription(root, vm, fake)
  await entered.promise
  const blocking = blockKvmCragSubscription(root, vm, fake)
  await nextTurn()
  assert.deepEqual(fake.actions(), ['publish'])
  assert.equal(fake.calls.length, 2)
  resume.resolve()
  assert.equal(await publication, true)
  assert.equal(await blocking, true)
  assert.deepEqual(fake.actions(), ['publish', 'block'])
  assert.equal(fake.state.pending, true)
})

linuxTest('a queued publisher reads the latest rights only after the preceding block finishes', async (t) => {
  const { root, vm, rights } = fixture(t)
  const entered = deferred()
  const resume = deferred()
  t.after(resume.resolve)
  const fake = runner({
    onAction: async ({ action }) => {
      if (action === 'block') {
        entered.resolve()
        await resume.promise
      }
    },
  })
  const blocking = blockKvmCragSubscription(root, vm, fake)
  await entered.promise
  const publication = publishKvmCragSubscription(root, vm, fake)
  const renewed = rights({ revision: 2 })
  await nextTurn()
  assert.deepEqual(fake.actions(), ['block'])
  resume.resolve()
  assert.equal(await blocking, true)
  assert.equal(await publication, true)
  assert.deepEqual(fake.actions(), ['block', 'publish'])
  assert.equal(fake.requests[1].files.entitlement, renewed.code)
  assert.equal(fake.state.pending, false)
})

linuxTest('one VM publication queue does not block a different VM on the same host', async (t) => {
  const { root, vm, addVm } = fixture(t)
  const other = addVm('vm-14', 2)
  const entered = deferred()
  const resume = deferred()
  t.after(resume.resolve)
  const slow = runner({
    onAction: async () => {
      entered.resolve()
      await resume.promise
    },
  })
  const first = publishKvmCragSubscription(root, vm, slow)
  await entered.promise
  const fast = runner()
  assert.equal(await publishKvmCragSubscription(root, other, fast), true)
  assert.deepEqual(fast.actions(), ['publish'])
  resume.resolve()
  assert.equal(await first, true)
})

linuxTest('a slow guest rejects excess queued publications and accepts new work after draining', async (t) => {
  const { root, vm } = fixture(t)
  const entered = deferred()
  const resume = deferred()
  t.after(resume.resolve)
  const fake = runner({
    onAction: async () => {
      entered.resolve()
      await resume.promise
    },
  })
  const pending = Array.from({ length: 16 }, () => publishKvmCragSubscription(root, vm, fake))
  await entered.promise
  await assert.rejects(publishKvmCragSubscription(root, vm, fake), { code: 'crag_subscription_projection_busy' })
  assert.deepEqual(fake.actions(), ['publish'])
  resume.resolve()
  assert.equal((await Promise.all(pending)).every(Boolean), true)
  assert.equal(await publishKvmCragSubscription(root, vm, fake), true)
})

linuxTest('publication holds are normalized, nested and released once before any private reads', async (t) => {
  const { root, vm, registration } = fixture(t)
  fs.writeFileSync(registration, 'CRAGS1.invalid')
  const first = holdKvmCragSubscriptionPublications(root)
  const second = holdKvmCragSubscriptionPublications(path.join(root, '.'))
  t.after(first)
  t.after(second)
  const fake = runner()
  await assert.rejects(publishKvmCragSubscription(root, vm, fake), { code: 'crag_subscription_sync_pending' })
  first()
  first()
  await assert.rejects(publishKvmCragSubscription(root, vm, fake), { code: 'crag_subscription_sync_pending' })
  assert.equal(fake.calls.length, 0)
  second()
  await assert.rejects(publishKvmCragSubscription(root, vm, fake), { code: 'license_invalid' })
  assert.deepEqual(fake.actions(), ['block'])
})

linuxTest('a gate closed while physical inspection awaits prevents publication and blocks the guest', async (t) => {
  const { root, vm } = fixture(t)
  const entered = deferred()
  const resume = deferred()
  t.after(resume.resolve)
  const fake = runner({
    onInspect: async () => {
      entered.resolve()
      await resume.promise
      return { ok: true, code: 0, stdout: 'true' }
    },
  })
  const publication = publishKvmCragSubscription(root, vm, fake)
  const rejected = assert.rejects(publication, { code: 'crag_subscription_sync_pending' })
  await entered.promise
  const release = holdKvmCragSubscriptionPublications(root)
  t.after(release)
  resume.resolve()
  await rejected
  assert.deepEqual(fake.actions(), ['block'])
  assert.equal(fake.state.pending, true)
})

linuxTest('closing the mutation gate during guest publication restores pending before completion', async (t) => {
  const { root, vm } = fixture(t)
  let release
  t.after(() => release?.())
  const fake = runner({
    onAction: ({ action }) => {
      if (action === 'publish') release = holdKvmCragSubscriptionPublications(root)
    },
  })
  await assert.rejects(publishKvmCragSubscription(root, vm, fake), { code: 'crag_subscription_sync_pending' })
  assert.deepEqual(fake.actions(), ['publish', 'block'])
  assert.equal(fake.state.pending, true)
})

for (const [change, expected] of [
  ['renewed', 'crag_subscription_projection_failed'],
  ['revoked', 'license_binding_mismatch'],
  ['missing', 'crag_subscription_projection_failed'],
]) {
  linuxTest(`a ${change} host snapshot during publication is blocked by the second verification`, async (t) => {
    const f = fixture(t)
    const fake = runner({
      onAction: ({ action }) => {
        if (action !== 'publish') return
        if (change === 'renewed') f.rights({ revision: 2 })
        if (change === 'revoked') f.revoke()
        if (change === 'missing') fs.unlinkSync(f.registration)
      },
    })
    await assert.rejects(publishKvmCragSubscription(f.root, f.vm, fake), { code: expected })
    assert.deepEqual(fake.actions(), ['publish', 'block'])
    assert.equal(fake.state.pending, true)
  })
}

linuxTest('a sync-pending marker without an active mutation hold does not block running KVM publication', async (t) => {
  const f = fixture(t)
  const fake = runner({
    onAction: ({ action }) => {
      if (action === 'publish') fs.writeFileSync(path.join(f.publicDir, 'sync-pending'), 'pending\n', { mode: 0o644 })
    },
  })
  assert.equal(await publishKvmCragSubscription(f.root, f.vm, fake), true)
  assert.deepEqual(fake.actions(), ['publish'])
  assert.equal(fake.state.pending, false)
})

for (const [state, inspection, skips] of [
  ['stopped', { ok: true, code: 0, stdout: 'false\n' }, true],
  ['missing', { ok: false, code: 1, error: 'Error response from daemon: No such container: kin-13' }, true],
  ['unknown', { ok: false, code: 1, error: 'permission denied' }, false],
  ['invalid', { ok: true, code: 0, stdout: 'not a boolean' }, false],
  ['missing-text-with-wrong-code', { ok: false, code: 125, error: 'No such container' }, false],
]) {
  linuxTest(`physical ${state} state is ${skips ? 'skipped' : 'rejected'} without guest commands`, async (t) => {
    const { root, vm, registration } = fixture(t)
    fs.writeFileSync(registration, 'CRAGS1.invalid')
    const fake = runner({ inspection })
    for (const operation of [publishKvmCragSubscription, blockKvmCragSubscription]) {
      if (skips) assert.equal(await operation(root, vm, fake), false)
      else await assert.rejects(operation(root, vm, fake), { code: 'crag_subscription_projection_failed' })
    }
    assert.equal(fake.calls.length, 2)
    assert.deepEqual(fake.actions(), [])
  })
}

for (const [state, expected] of [
  ['expired', 'license_expired'],
  ['revoked', 'license_binding_mismatch'],
  ['invalid', 'license_invalid'],
]) {
  linuxTest(`${state} authorization cannot republish or clear an older guest projection`, async (t) => {
    const f = fixture(t)
    const fake = runner()
    assert.equal(await publishKvmCragSubscription(f.root, f.vm, fake), true)
    const before = fake.state.files
    if (state === 'expired') f.rights({ expires_at: Math.floor(Date.now() / 1000) })
    if (state === 'revoked') f.revoke()
    if (state === 'invalid') fs.writeFileSync(f.registration, 'CRAGS1.invalid')
    await assert.rejects(publishKvmCragSubscription(f.root, f.vm, fake), { code: expected })
    assert.deepEqual(fake.actions(), ['publish', 'block'])
    assert.equal(fake.state.pending, true)
    assert.deepEqual(fake.state.files, before)
  })
}

linuxTest('an absent host grant preserves an existing revocation marker and projection', async (t) => {
  const { root, vm, registration } = fixture(t)
  const fake = runner()
  await publishKvmCragSubscription(root, vm, fake)
  await blockKvmCragSubscription(root, vm, fake)
  const before = fake.state.files
  fs.unlinkSync(registration)
  assert.equal(await publishKvmCragSubscription(root, vm, fake), false)
  assert.deepEqual(fake.actions(), ['publish', 'block'])
  assert.equal(fake.state.pending, true)
  assert.deepEqual(fake.state.files, before)
})

linuxTest('a failed authorization does not poison the per-VM queue for a subsequent valid renewal', async (t) => {
  const { root, vm, rights } = fixture(t)
  const fake = runner()
  rights({ expires_at: Math.floor(Date.now() / 1000) })
  await assert.rejects(publishKvmCragSubscription(root, vm, fake), { code: 'license_expired' })
  rights({ revision: 2 })
  assert.equal(await publishKvmCragSubscription(root, vm, fake), true)
  assert.deepEqual(fake.actions(), ['block', 'publish'])
  assert.equal(fake.state.pending, false)
})

linuxTest('guest publication failures attempt a block without leaking guest diagnostics', async (t) => {
  const { root, vm } = fixture(t)
  const files = readCragSubscriptionFiles(root, vm)
  const fake = runner({
    onAction: ({ action }) =>
      action === 'publish' ? { ok: false, code: 1, error: files.device + files.permit } : undefined,
  })
  const error = await publishKvmCragSubscription(root, vm, fake).then(
    () => assert.fail('unexpected success'),
    (error) => error,
  )
  assert.equal(error.code, 'crag_subscription_projection_failed')
  assert.equal(error.retryable, false)
  assert.equal(error.message.includes(JSON.parse(files.device).private_key), false)
  assert.equal(error.message.includes(files.permit), false)
  assert.deepEqual(fake.actions(), ['publish', 'block'])
  assert.equal(fake.state.pending, true)
})

linuxTest('unavailable guest SSH is marked retryable without starting a second inaccessible command', async (t) => {
  const { root, vm } = fixture(t)
  const fake = runner({ onAction: () => ({ ok: false, code: 1, error: 'guest ssh unavailable' }) })
  await assert.rejects(publishKvmCragSubscription(root, vm, fake), {
    code: 'crag_subscription_projection_failed',
    retryable: true,
  })
  assert.deepEqual(fake.actions(), ['publish'])
})

for (const [code, stderr, retryable] of [
  [75, 'CRAG guest setup is not ready', true],
  [1, 'CRAG guest setup is not ready', false],
  [75, 'CRAG guest subscription projection failed', false],
]) {
  linuxTest(`only the explicit guest setup barrier is retried: ${code}/${retryable}`, async (t) => {
    const { root, vm } = fixture(t)
    const fake = runner({
      onAction: ({ action }) =>
        action === 'publish' ? { ok: false, code, error: 'guest command failed', stderr } : undefined,
    })
    await assert.rejects(publishKvmCragSubscription(root, vm, fake), {
      code: 'crag_subscription_projection_failed',
      retryable,
    })
    assert.deepEqual(fake.actions(), retryable ? ['publish'] : ['publish', 'block'])
  })
}

linuxTest('Docker and remote KVM placements never enter the local guest publication path', async (t) => {
  const { root, vm } = fixture(t)
  const fake = runner()
  for (const target of [
    { ...vm, runtime: { type: 'docker' } },
    { ...vm, node_id: 'remote' },
  ]) {
    assert.equal(await publishKvmCragSubscription(root, target, fake), false)
    assert.equal(await blockKvmCragSubscription(root, target, fake), false)
  }
  assert.equal(fake.calls.length, 0)
})

linuxTest('the official dispatcher preserves offline U1 during an unrelated host subscription hold', async (t) => {
  const { root, vm, registration, publicDir } = fixture(t)
  const universal = issueUniversalCode(root)
  fs.writeFileSync(registration, universal.code)
  fs.unlinkSync(path.join(cragLicenseDirectory(root, vm), 'device.json'))
  fs.unlinkSync(path.join(root, 'vms', vm.id, 'machine-id'))
  fs.writeFileSync(path.join(publicDir, 'sync-pending'), 'pending\n')
  delete vm.fingerprint
  const release = holdKvmCragSubscriptionPublications(root)
  t.after(release)
  const fake = runner()
  assert.equal(await publishKvmCragLicense(root, vm, fake), true)
  assert.deepEqual(fake.actions(), ['publish-universal'])
  assert.deepEqual(fake.requests[0].files, { permit: universal.code })
  assert.equal(Object.hasOwn(fake.requests[0], 'machine_id'), false)
  assert.equal(fake.requests[0].wait_for_setup, true)
  assert.equal(
    fake.calls.some(({ args }) => args.some((arg) => arg.includes(universal.code))),
    false,
  )
})

linuxTest('the official local dispatcher retains subscription gates and shares the revocation queue', async (t) => {
  const { root, vm } = fixture(t)
  const entered = deferred()
  const resume = deferred()
  t.after(resume.resolve)
  const fake = runner({
    onAction: async ({ action }) => {
      if (action === 'publish') {
        entered.resolve()
        await resume.promise
      }
    },
  })
  const publication = publishKvmCragLicense(root, vm, fake)
  await entered.promise
  const release = holdKvmCragSubscriptionPublications(root)
  t.after(release)
  const blocking = blockKvmCragSubscription(root, vm, fake)
  resume.resolve()
  await assert.rejects(publication, { code: 'crag_subscription_sync_pending' })
  assert.equal(await blocking, true)
  assert.deepEqual(fake.actions(), ['publish', 'block', 'block'])
  assert.equal(fake.state.pending, true)
})

linuxTest(
  'the local dispatcher preserves the upstream callback runner injection without a real Docker process',
  async (t) => {
    const { root, vm, registration } = fixture(t)
    const universal = issueUniversalCode(root)
    fs.writeFileSync(registration, universal.code)
    const calls = []
    const run = (binary, args, options, callback) => ({
      stdin: {
        on() {},
        end(input) {
          calls.push({ binary, args, options, input })
          queueMicrotask(() => callback(null, args[0] === 'container' ? 'true' : '{"ok":true}', ''))
        },
      },
    })
    assert.equal(await publishKvmCragLicense(root, vm, { run }), true)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].args[0], 'container')
    assert.equal(calls[1].options.timeout, 30_000)
    assert.deepEqual(JSON.parse(calls[1].input).files, { permit: universal.code })
  },
)

linuxTest('remote KVM retains the upstream stdin bundle, coalescing, renewal and forced publication', async (t) => {
  const { root, vm, rights } = fixture(t)
  const remote = { ...vm, node_id: 'remote-kvm' }
  const entered = deferred()
  const resume = deferred()
  t.after(resume.resolve)
  const sent = []
  const runDockerExec = async (argv, { input, timeoutMs }) => {
    assert.equal(argv[0], 'exec')
    assert.ok(argv.includes(KVM_GUEST_EXEC))
    assert.equal(timeoutMs, 4000)
    const files = JSON.parse(input)
    assert.equal(Object.hasOwn(files, 'action'), false)
    assert.deepEqual(Object.keys(files).sort(), ['device', 'entitlement', 'hostId', 'permit'])
    assert.equal(
      argv.some((arg) => arg.includes(files.permit)),
      false,
    )
    sent.push(files)
    if (sent.length === 1) {
      entered.resolve()
      await resume.promise
    }
    return { ok: true }
  }
  const first = publishKvmCragLicense(root, remote, { runDockerExec })
  await entered.promise
  const second = publishKvmCragLicense(root, remote, { runDockerExec })
  resume.resolve()
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.equal(sent.length, 1)
  assert.equal(await publishKvmCragLicense(root, remote, { runDockerExec }), true)
  assert.equal(sent.length, 1)
  const renewal = rights({ revision: 2 })
  assert.equal(await publishKvmCragLicense(root, remote, { runDockerExec }), true)
  assert.equal(sent.length, 2)
  assert.equal(sent[1].entitlement, renewal.code)
  assert.equal(await publishKvmCragLicense(root, remote, { runDockerExec, force: true }), true)
  assert.equal(sent.length, 3)
})

linuxTest('remote KVM continues to publish U1 without local projection envelopes', async (t) => {
  const { root, vm, registration } = fixture(t)
  const universal = issueUniversalCode(root)
  fs.writeFileSync(registration, universal.code)
  assert.equal(
    await publishKvmCragLicense(
      root,
      { ...vm, node_id: 'remote-kvm' },
      {
        runDockerExec: async (_argv, { input }) => {
          assert.deepEqual(JSON.parse(input), { permit: universal.code })
          return { ok: true }
        },
      },
    ),
    true,
  )
})
