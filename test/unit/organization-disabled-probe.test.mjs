import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  classifyUpstreamResult,
  isOrganizationDisabledText,
  isOrganizationDisabledUsageResult,
} from '../../src/lib/pool/upstream-error-policy.mjs'
import { isUsageProbeTarget } from '../../src/lib/oauth/usage-probe-monitor.mjs'
import { isVmScheduleReady, markUnschedulable } from '../../src/lib/vm/vm-registry.mjs'
import { applyUnschedulable, migrateScheduleRecord } from '../../src/lib/pool/schedule-state.mjs'
import { restoreScheduleAfterLiveCredential } from '../../src/lib/oauth/oauth-credentials.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'

/**
 * The official /usage probe is the first place an org refusal surfaces — the
 * runtime classifier only parks the slot after real traffic trips the 403.
 * Before this change the probe pipeline read that 403 as a transient usage
 * backoff (rate_limited), so an org-disabled slot kept a fresh credential,
 * passed every eligibility gate and re-entered the pool until a request hit
 * the same 403 again.
 */
const ORG_REFUSAL = 'OAuth authentication is currently not allowed for this organization.'
const ORG_DISABLED_400 = 'This organization has been disabled.'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-org-refusal-'))
}

test('isOrganizationDisabledText recognizes both org refusal wordings, object or string', () => {
  assert.equal(isOrganizationDisabledText(ORG_REFUSAL), true)
  assert.equal(isOrganizationDisabledText(ORG_DISABLED_400), true)
  // crs-usage-probe falls back to the whole error body when message is absent.
  assert.equal(isOrganizationDisabledText({ error: ORG_REFUSAL }), true)
  assert.equal(isOrganizationDisabledText({ message: ORG_DISABLED_400 }), true)
  assert.equal(isOrganizationDisabledText('rate limited, please try again later'), false)
  assert.equal(isOrganizationDisabledText(''), false)
  assert.equal(isOrganizationDisabledText(null), false)
})

test('usage result: org refusal is detected on 400/401/403, object or string payload', () => {
  assert.equal(isOrganizationDisabledUsageResult({ ok: false, usage_status: 403, usage_error: ORG_REFUSAL }), true)
  assert.equal(
    isOrganizationDisabledUsageResult({ ok: false, usage_status: 403, usage_error: { message: ORG_REFUSAL } }),
    true,
  )
  // The 400 wording the runtime classifier parks on must park here too.
  assert.equal(
    isOrganizationDisabledUsageResult({ ok: false, usage_status: 400, usage_error: ORG_DISABLED_400 }),
    true,
  )
  // A 401 carrying the org wording is an org refusal, not a bare revoked grant.
  assert.equal(
    isOrganizationDisabledUsageResult({ ok: false, usage_status: 401, usage_error: ORG_REFUSAL }),
    true,
  )
  // Not org-disabled:
  assert.equal(
    isOrganizationDisabledUsageResult({ ok: false, usage_status: 401, usage_error: 'invalid_grant' }),
    false,
  )
  assert.equal(isOrganizationDisabledUsageResult({ ok: true, usage_status: 403, usage_error: ORG_REFUSAL }), false)
  assert.equal(
    isOrganizationDisabledUsageResult({ ok: false, usage_status: 429, usage_error: 'rate limited' }),
    false,
  )
  assert.equal(
    isOrganizationDisabledUsageResult({ ok: false, usage_scope_missing: true, usage_status: 403 }),
    false,
  )
})

test('runtime 403 org refusal still pauses (shared wording, no regression)', () => {
  const policy = classifyUpstreamResult(
    { status: 403, terminalState: 'rejected', body: { error: { type: 'permission_error', message: ORG_REFUSAL } } },
    { model: 'claude-opus-test' },
  )
  assert.equal(policy.reason, 'organization_disabled')
  assert.equal(policy.pauseSchedule, true)
})

test('an org-disabled park is not lifted by a fresh credential (operator-only)', () => {
  // Four-state model: unschedulable.organization_disabled stays until an
  // operator re-enables scheduling. A background credential refresh must not
  // re-enter the pool on its own.
  const vm = {
    id: 'vm-org',
    status: 'running',
    schedulable: true,
    claude: { has_refresh: true, has_access: true, expires_at: new Date(Date.now() + 3600_000).toISOString() },
  }
  migrateScheduleRecord(vm)
  applyUnschedulable(vm, 'organization_disabled', { status: 403, message: ORG_REFUSAL })
  assert.ok(vm.unschedulable)
  assert.equal(vm.schedulable, false)

  // The background refresh path restores a bare no-ticket park only.
  const restored = restoreScheduleAfterLiveCredential(vm, { operatorImport: false })
  assert.equal(restored.unschedulable?.reason, 'organization_disabled')
  assert.equal(restored.schedulable, false)

  // The scheduler gate still refuses the parked slot.
  assert.equal(isVmScheduleReady(vm), false)
})

test('markUnschedulable parks a live slot with the org refusal detail', () => {
  const dir = tmpDir()
  const vmsDir = path.join(dir, 'vms')
  fs.mkdirSync(vmsDir, { recursive: true })
  const vmId = 'vm-org-park'
  fs.writeFileSync(
    path.join(vmsDir, `${vmId}.json`),
    JSON.stringify({
      id: vmId,
      status: 'running',
      schedulable: true,
      claude: { has_refresh: true, has_access: true },
    }),
    'utf8',
  )
  try {
    const before = isVmScheduleReady(JSON.parse(fs.readFileSync(path.join(vmsDir, `${vmId}.json`), 'utf8')))
    assert.equal(before, true)
    const summary = markUnschedulable(dir, vmId, 'organization_disabled', { status: 403, message: ORG_REFUSAL })
    assert.ok(summary)
    const parked = JSON.parse(fs.readFileSync(path.join(vmsDir, `${vmId}.json`), 'utf8'))
    assert.equal(parked.unschedulable?.reason, 'organization_disabled')
    assert.equal(parked.schedulable, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('usage probe monitor skips a parked org-disabled slot', () => {
  const base = {
    id: 'vm-org',
    status: 'running',
    claude: { has_refresh: true, refresh_error: null },
    proxy: { host: '127.0.0.1', port: 1080 },
  }
  assert.equal(isUsageProbeTarget(base), true)
  const parked = { ...base, unschedulable: { reason: 'organization_disabled', at: new Date().toISOString() } }
  assert.equal(isUsageProbeTarget(parked), false)
})

test('ingestOAuthUsage records the org refusal without painting rate_limited', () => {
  // The pre-fix pipeline marked the 403 as an official-usage backoff
  // (rate_limited: true), which the eligibility gates deliberately ignore.
  const quota = new AccountQuota({ dataDir: tmpDir(), config: {} })
  const probe = {
    ok: false,
    usage_status: 403,
    usage_error: { message: ORG_REFUSAL },
    source: 'official-cc-usage',
    probed_at: new Date().toISOString(),
    error: ORG_REFUSAL,
    rate_limited: true,
  }
  quota.ingestOAuthUsage('acc-org', probe)
  const acc = quota.repo.get('acc-org')
  const lp = acc.last_probe || acc.unified?.last_probe || {}
  assert.equal(lp.ok, false)
  assert.match(String(lp.error || ''), /not allowed for this organization/i)
  assert.notEqual(lp.rate_limited, true, 'org refusal must not be recorded as an official-usage backoff')
  assert.equal(acc.unified?.usage_rate_limited_until, undefined)
})

test('a genuine usage 429 still takes the backoff path', () => {
  const quota = new AccountQuota({ dataDir: tmpDir(), config: {} })
  quota.ingestOAuthUsage('acc-429', {
    ok: false,
    usage_status: 429,
    source: 'official-cc-usage',
    probed_at: new Date().toISOString(),
    usage_error: { message: 'rate limited, please try again later' },
    rate_limited: true,
    retry_after_ms: 60_000,
  })
  const acc = quota.repo.get('acc-429')
  const lp = acc.last_probe || acc.unified?.last_probe || {}
  assert.equal(lp.rate_limited, true)
  assert.ok(acc.unified?.usage_rate_limited_until)
})
