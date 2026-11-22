import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CragDeviceIdentity } from './crag-device-identity'
import type { CragHostStatus } from './queries'

const UUID = '12345678-90ab-cdef-1234-567890abcdef'

const render = (status?: Partial<CragHostStatus>) =>
  renderToStaticMarkup(
    <CragDeviceIdentity
      status={status as CragHostStatus}
      busy={false}
      onUnbind={() => {}}
      onClaim={() => {}}
    />
  )

describe('CragDeviceIdentity', () => {
  it('says nothing when there is no identity to quote', () => {
    // An install whose original source is gone reports no UUID rather than a
    // fabricated one, so there is nothing to show -- and nothing to copy.
    expect(render(undefined)).toBe('')
    expect(render({ ready: true, state: 'active' })).toBe('')
  })

  it('shows the identity in full so it can be quoted in a support request', () => {
    const html = render({ ready: true, state: 'active', device_uuid: UUID })
    // Not truncated: unlike a voucher id, this is the thing the operator has to
    // hand over verbatim.
    expect(html).toContain(UUID)
    expect(html).toContain('设备标识')
  })

  it('offers retirement only while there is a subscription to retire', () => {
    for (const state of ['active', 'expired'] as const) {
      expect(render({ ready: true, state, device_uuid: UUID })).toContain(
        '注销本机订阅'
      )
    }
    for (const state of [
      'unredeemed',
      'unavailable',
      'sync_pending',
    ] as const) {
      expect(render({ ready: true, state, device_uuid: UUID })).not.toContain(
        '注销本机订阅'
      )
    }
  })

  it('keeps the migration entry out of sight until the Authority route exists', () => {
    // `claim-by-order` ships with crag#14, which is neither merged nor deployed, so
    // production has no such route and every attempt would fail without reaching a
    // voucher. Asserted across every state on purpose: the entry is withheld by the
    // `CLAIM_BY_ORDER_AVAILABLE` gate, not by anything about this host's subscription.
    //
    // When that route is deployed and the gate flips, this becomes the assertion it
    // replaced — `toContain` in all four states, because replacing hardware means
    // arriving at an empty machine and gating the entry on already having a
    // subscription would hide it from exactly the host that needs it.
    for (const state of [
      'unredeemed',
      'unavailable',
      'active',
      'expired',
    ] as const) {
      expect(render({ ready: true, state, device_uuid: UUID })).not.toContain(
        '从其他设备迁移'
      )
    }
  })
})
