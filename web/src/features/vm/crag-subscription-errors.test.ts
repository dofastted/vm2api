import { describe, expect, it } from 'vitest'
import {
  cragCredentialRecoveryFaults,
  cragSubscriptionErrors,
} from './crag-subscription-errors'

const faults = Object.values(cragCredentialRecoveryFaults)

describe('cragCredentialRecoveryFaults', () => {
  it('tells the three causes apart', () => {
    expect(new Set(faults).size).toBe(faults.length)
    // The collision case is the one the operator can actually investigate, so
    // it has to name what to look at rather than just reporting a refusal.
    expect(cragCredentialRecoveryFaults.host_id_collision).toContain(
      '/etc/machine-id'
    )
  })

  it('promises no action that does not exist yet', () => {
    // Per the convention in this file: never mention a user action that is not
    // there. Unbinding and migrating to a replacement host are not implemented,
    // so pointing at them would send the operator looking for a missing button.
    for (const text of faults) {
      expect(text).not.toMatch(/迁移|注销|解绑/)
    }
  })

  it('does not restate a code the error table already covers', () => {
    // One message per situation, in one place. `auth_forbidden` states that the
    // credential was refused; these explain why self-recovery did not fix it.
    for (const text of faults) {
      expect(Object.values(cragSubscriptionErrors)).not.toContain(text)
    }
  })

  it('keeps to the two slot names the panel uses', () => {
    // The panel exposes exactly two numbers -- 充值可用槽位 and 使用中的槽位.
    // A third alias for either is how four names for one quantity happened before.
    for (const text of faults) {
      expect(text).not.toMatch(/剩余可用槽位|剩余可绑定槽位|订阅槽位额度/)
    }
  })
})
