import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { haBillingFixture, syntheticUsageReceipt } from './ha-billing.mjs'
import { syntheticFence } from './fake-slotgate.mjs'
import { withHaRequestContext, withHaRequestAttempt } from '../../src/lib/core/ha-request-context.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'

const kind = process.env.VM2API_HA_BILLING_CASE
const router = await import('../../src/lib/transport/kernel-router.mjs')
const identity = await import('../../src/lib/identity/vm-identity.mjs')
let dispatch
mock.module(new URL('../../src/lib/transport/kernel-router.mjs', import.meta.url), { namedExports: { ...router, dispatchStreamInference: (...args) => dispatch(...args) } })
mock.module(new URL('../../src/lib/identity/vm-identity.mjs', import.meta.url), { namedExports: { ...identity, loadVmIdentity: () => ({ accountUuid: 'fixture-account', fingerprint: { device_id: 'synthetic-device' } }) } })
const { createHandleProtocol } = await import('../../src/lib/protocol/handle-protocol.mjs')

test(`HA protocol captures and settles original billable command: ${kind}`, async (t) => {
  const f = await haBillingFixture(t)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-648-ha-billing-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routing = { compatibility: { claude_code_only: false, cache_ttl: '1h' } }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const keys = new ApiKeyStore({ db: f.db })
  const key = await f.originalGate.run(() => keys.create({ name: 'synthetic-protocol-key' }))
  const nodeBinding = { protocol: 'KSG2', nodeId: 'original-node', vmId: 'vm-fixture', kind: 'kernel', fence: syntheticFence() }
  const commandId = 'protocol-original-command'
  const execution = { requestId: commandId, nodeBinding, started: true, ended: true, reason: 'node_completed', nodeCompletion: { id: commandId, fence: nodeBinding.fence, status: 'completed', dispatched: true } }
  const assistant = { id: 'synthetic-message', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'synthetic' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } }
  let rateReads = 0, receiptReads = 0
  dispatch = async (opts) => {
    await opts.onExecutionStart({ requestId: commandId, nodeBinding })
    const job = (await f.peer.pool.query('SELECT * FROM execution_jobs WHERE request_id=$1', [commandId])).rows[0]
    assert.equal(job.billing_snapshot?.rate_multiplier, 2, 'dispatch permission requires the original PG-priced group snapshot')
    assert.equal(job.billing_snapshot.cache_ttl, '1h')
    assert.equal(job.billing_snapshot.model, opts.body.model)
    if (kind === 'deleted-key') await keys.remove(key.id)
    await opts.onExecutionEnd(execution)
    return { ok: true, status: 200, body: structuredClone(assistant), usage: assistant.usage, model: assistant.model, execution }
  }
  const handler = createHandleProtocol({
    cfg: { limits: { max_body_bytes: 1 << 20, upstream_timeout_ms: 1000 }, rewrite: { enabled: false }, intercept: { rules: [] }, distill: { enabled: false }, paths: { project: root, data: root } },
    json(res, status, body) { res.statusCode = status; res.body = body }, readBody,
    requireAuth(req) { req.apiKeyKind = 'managed'; req.apiKeyRecord = key; return true },
    requestLog: { start: () => ({ request_id: 'ignored-client-id', t0: Date.now() }) },
    stats: { errors: 0, requests: 0, by_route: {} },
    groupsRepo: { async rateMultiplier() { return ++rateReads === 1 ? 2 : 99 } },
    apiKeyStore: keys, stickyRouter: { resolve: () => null }, accountQuota: { ingestHeaders() {} }, routingConfig: routing, routingConfigPath: routingFile,
    async readNodeRecoveryStatus(input) {
      receiptReads++
      assert.equal(input.requestId, commandId)
      assert.deepEqual(input.nodeBinding, nodeBinding)
      const receipt = syntheticUsageReceipt()
      if (kind === 'no-usage') { receipt.usage_complete = false; delete receipt.usage.output_tokens }
      return { found: true, command: execution.nodeCompletion, receipt }
    },
    failoverRunner: { async run(args) {
      const admission = await new ExecutionAdmissionsRepo(f.db).tryReserve({ accountId: 'fixture-account', vmId: 'vm-fixture', accountLimit: 5, vmLimit: 5, fableLimit: 0, rpmLimit: 0 })
      const candidate = { ...admission, vm: { id: 'vm-fixture', claude: { has_access: true } }, exec: { vmId: 'vm-fixture', vm: {} } }
      await new RequestAttemptsRepo(f.db).begin({ requestId: 'billing-parent', attemptNo: 1, vmId: 'vm-fixture', accountId: 'fixture-account', model: args.canonicalBody.model })
      try {
        const prepared = await args.applyAttempt(structuredClone(args.canonicalBody), candidate, { attemptNo: 1, attemptStartedAt: Date.now() })
        const result = await withHaRequestAttempt(1, () => args.callAttempt({ candidate, body: prepared.body, attemptMeta: prepared.meta, onCommit() {} }))
        return { ...result, vmId: 'vm-fixture', accountId: 'fixture-account', finalState: 'verified', attemptCount: 1 }
      } finally { await admission.release() }
    } },
  })
  const req = Readable.from([Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 20, messages: [{ role: 'user', content: 'synthetic static prompt' }] }))])
  req.headers = { 'user-agent': 'synthetic-ha-client' }
  const res = new EventEmitter(); res.setHeader = () => {}
  await f.originalGate.run(() => withHaRequestContext({ db: f.db, requestId: 'billing-parent', activity: f.originalGate, recoveryKind: 'claude_messages' }, () => handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages')))
  assert.equal(res.statusCode, 200, JSON.stringify(res.body))
  assert.equal(rateReads, 1, 'group rates must not be reloaded after dispatch for billing')
  assert.equal(receiptReads, 1)
  await f.originalGate.run(async () => {
    const rows = await f.db.prepare('SELECT * FROM ha_request_settlements').all()
    const admission = await f.db.prepare('SELECT * FROM api_key_admissions WHERE ha_request_id=$1').get('billing-parent')
    if (kind === 'no-usage') {
      assert.equal(rows.length, 0)
      assert.equal(admission.released_at, null)
      assert.equal((await keys.getById(key.id)).requests, 0)
    } else {
      assert.equal(rows.length, 1)
      assert.equal(rows[0].outcome, kind === 'deleted-key' ? 'key_deleted' : 'charged')
      assert.ok(admission.released_at)
      assert.equal(rows[0].billing_snapshot.rate_multiplier, 2)
      assert.ok(Math.abs(rows[0].actual_cost - .001272) < 1e-12)
    }
  })
})
