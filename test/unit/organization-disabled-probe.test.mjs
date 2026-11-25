import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyUpstreamResult,
  isOrganizationDisabledText,
} from '../../src/lib/pool/upstream-error-policy.mjs'
import { isVmScheduleReady } from '../../src/lib/vm/vm-registry.mjs'
import {
  applyUnschedulable,
  migrateScheduleRecord,
  CLEAR_BY,
} from '../../src/lib/pool/schedule-state.mjs'
import { restoreScheduleAfterLiveCredential } from '../../src/lib/oauth/oauth-credentials.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-org-refusal-'))
}

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

test('isOrganizationDisabledText recognizes both org refusal wordings', () => {
  assert.equal(isOrganizationDisabledText(ORG_REFUSAL), true)
  assert.equal(isOrganizationDisabledText(ORG_DISABLED_400), true)
  assert.equal(isOrganizationDisabledText('rate limited, please try again later'), false)
  assert.equal(isOrganizationDisabledText(''), false)
  assert.equal(isOrganizationDisabledText(null), false)
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
