import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCragSubscription } from '../../src/lib/vm/crag-subscription.mjs'
import { checkCragLicense } from '../../src/lib/vm/crag-license.mjs'
import { cragSubscriptionPublicDirectory } from '../../src/lib/vm/crag-subscription-paths.mjs'
import { issueHostEntitlement, issueSlotPermit, seedEncryptedPackage } from '../fixtures/crag-license.mjs'
import { createCragSubscriptionHandler, cragSubscriptionRoute } from '../../src/lib/admin/crag-subscription-routes.mjs'

const voucher = () => `CRAGR1.${crypto.randomBytes(32).toString('base64url')}`

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
      listTargets: () => slots,
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
        const seat = ++seats
        const { code } = issueSlotPermit(root, body.machine_code, body.host_id, { seat })
        return Response.json({ ok: true, data: { entitlement: current.code, slot_permit: code, seat } })
      },
    })
  const service = connect()
  assert.deepEqual(await service.status(), { ready: true, state: 'unredeemed' })
  await service.redeem(voucher())
  assert.deepEqual(await service.bind(slots[0]), { seat: 1 })
  assert.deepEqual(await service.bind(slots[1]), { seat: 2 })
  assert.equal(checkCragLicense(root, slots[1]).ok, true)
  const renewal = voucher()
  lose = true
  await assert.rejects(service.redeem(renewal), { code: 'crag_subscription_authority_unavailable' })
  assert.equal((await service.status()).state, 'sync_pending')
  assert.equal(checkCragLicense(root, slots[0]).ok, false)
  assert.equal(checkCragLicense(root, slots[1]).ok, false)
  const recovered = connect()
  await recovered.recover()
  assert.equal((await recovered.status()).revision, 2)
  assert.equal(issued.size, 2)
  assert.equal(checkCragLicense(root, slots[0]).ok, true)
  assert.equal(checkCragLicense(root, slots[1]).ok, false)
})

test('only an authenticated same-origin admin session can redeem without revealing a failed voucher', async () => {
  const code = voucher()
  const handler = createCragSubscriptionHandler({
    subscription: {
      redeem: () => {
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
  const response = await handler(req, res, route)
  assert.equal(response.status, 404)
  assert.equal(response.body.error.code, 'redeem_unavailable')
  assert.equal(JSON.stringify(response).includes(code), false)
})
