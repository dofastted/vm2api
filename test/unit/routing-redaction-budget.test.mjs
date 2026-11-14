import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'
import {
  ensureRedaction,
  maskJson,
  publishRedactionForTests,
  redactionStatus,
  restoreJsonValue,
} from '../../src/lib/redaction/runtime.mjs'

test('enabling redaction through a routing patch retains the configured request body budget', {
  timeout: 60_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-redact-budget-'))
  const bin = path.join(root, 'bin', 'kin-redact')
  const routingFile = path.join(root, 'routing.json')
  const previousBin = process.env.KIN_REDACT_BIN
  const secret = 'synthetic-routing-secret'
  const policy = { enabled: true, secrets: false, personal: false, words: [secret] }
  // 8 MiB is the supported minimum; omitting failover would select the 32 MiB default.
  const maxBodyBytes = 8 * 1024 * 1024
  const routingConfig = {
    failover: { max_request_mib: 8 },
    redaction: { ...policy, enabled: false },
    concurrency: {},
    tiers: {},
  }

  t.after(async () => {
    try {
      const status = redactionStatus()
      if (status.enabled && status.ready) {
        // Retrieve the child only after all assertions: ensureRedaction updates the live budget.
        const { child } = await ensureRedaction({ redaction: policy }, { projectRoot: root, binPath: bin })
        if (child && child.exitCode === null && child.signalCode === null) {
          const closed = once(child, 'close')
          child.kill()
          await closed
        }
      }
    } finally {
      publishRedactionForTests(null)
      if (previousBin === undefined) delete process.env.KIN_REDACT_BIN
      else process.env.KIN_REDACT_BIN = previousBin
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  publishRedactionForTests(null)
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(routingFile, JSON.stringify(routingConfig))
  execFileSync('go', ['build', '-o', bin, './cmd/kin-redact'], {
    cwd: path.join(process.cwd(), 'redact'),
    stdio: 'inherit',
  })
  process.env.KIN_REDACT_BIN = bin

  const runtime = createRoutingRuntime({
    cfg: { paths: { project: root } },
    routingConfigPath: routingFile,
    routingConfig,
    stickyRouter: { reloadConfig() {} },
    accountQuota: {
      reloadConfig() {},
      applyTierConcurrency() {},
      applyTierRpm() {},
    },
  })
  // Do not supply maxBodyBytes here: consumers must use the budget published by the patch.
  const identity = { principal: 'synthetic-routing-principal', session: 'budget-regression' }
  const original = { messages: [{ role: 'user', content: `token ${secret}` }] }
  assert.equal(await maskJson(original, identity), original)

  // Enable only redaction. The nondefault failover budget is already configured.
  await runtime.persistRoutingPatch({ redaction: policy })

  const masked = await maskJson(original, identity)
  assert.ok(!JSON.stringify(masked).includes(secret))
  assert.match(JSON.stringify(masked), /\{\{R_/)
  assert.deepEqual(await restoreJsonValue(masked, identity), original)

  const oversized = { data: '', probe: secret }
  oversized.data = 'x'.repeat(maxBodyBytes + 1 - Buffer.byteLength(JSON.stringify(oversized)))
  assert.equal(Buffer.byteLength(JSON.stringify(oversized)), maxBodyBytes + 1)
  for (const transform of [maskJson, restoreJsonValue]) {
    await assert.rejects(transform(oversized, identity), (error) => {
      assert.equal(error.status, 413, transform.name)
      assert.equal(error.code, 'redaction_body_too_large', transform.name)
      assert.equal(error.details.retryable, false, transform.name)
      return true
    })
  }

  // Oversize rejection must not disable redaction or discard the helper's restore mapping.
  assert.deepEqual(await restoreJsonValue(masked, identity), original)
  const again = await maskJson(original, identity)
  assert.ok(!JSON.stringify(again).includes(secret))
  assert.deepEqual(await restoreJsonValue(again, identity), original)
})
