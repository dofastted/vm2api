import { describe, expect, it } from 'vitest'
import {
  claudeResetCount,
  claudeResetWarnings,
  clearsText,
  liveState,
  shownCredits,
  type ResetCredit,
  type ResetSnapshot,
} from './claude-reset-cards'

const fable: ResetCredit = {
  ref: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  kind: 'fable',
  state: 'ready',
  gives_back_weekly: true,
  resets_left: 1,
  expires_at: '2026-11-17T07:59:00Z',
  clears: ['five_hour', 'seven_day_overage_included'],
}
const full: ResetCredit = {
  ref: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  kind: 'full',
  state: 'ready',
  resets_left: 1,
  expires_at: '2026-12-10T22:00:00Z',
  clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
}

describe('claude reset cards', () => {
  it('counts held cards and ignores ones upstream withholds', () => {
    const withheld = { ...full, state: 'unavailable' as const }
    const snapshot: ResetSnapshot = { credits: [fable, withheld] }
    expect(shownCredits(snapshot)).toEqual([fable])
    expect(claudeResetCount(snapshot)).toBe(1)
    expect(claudeResetCount({ ...snapshot, held_count: 3 })).toBe(3)
    expect(claudeResetCount(null)).toBe(0)
  })

  it('keeps the old count for snapshots saved before card refs', () => {
    const legacy: ResetSnapshot = {
      available_count: 1,
      credits: [
        { resets_left: 1, redeemable: true },
        { resets_left: 1, redeemable: false },
      ],
    }
    expect(claudeResetCount(legacy)).toBe(1)
    expect(shownCredits(legacy)).toEqual([])
  })

  it('offers a cooling card again once the cooldown has passed', () => {
    const cooling = { ...full, state: 'cooldown' as const }
    const snapshot = { cooldown_until: '2026-11-13T07:28:00Z' }
    expect(
      liveState(cooling, snapshot, Date.parse('2026-11-13T07:27:00Z'))
    ).toBe('cooldown')
    expect(
      liveState(cooling, snapshot, Date.parse('2026-11-13T07:29:00Z'))
    ).toBe('ready')
  })

  it('describes what each card refills', () => {
    expect(clearsText(fable)).toBe('清 5 小时、Fable 周额度（7 天不清）')
    expect(clearsText(full)).toBe('清 5 小时、7 天、Fable 周额度')
  })

  it('warns when a Fable reset cannot help', () => {
    const pro = { fiveHour: 0, sevenDay: 99, fable: null, sevenDayGate: 95 }
    expect(claudeResetWarnings(fable, pro, [fable, full])).toEqual([
      '7 天已用 99%，到了闸线，这张清不掉；要清 7 天请用全量卡。',
      '这个槽本周没有 Fable 用量，用这张等于只清 5 小时。',
    ])
    expect(claudeResetWarnings(fable, pro, [fable])[0]).toBe(
      '7 天已用 99%，到了闸线，这张清不掉。'
    )
    expect(claudeResetWarnings(full, pro, [fable, full])).toEqual([])
    const max = { fiveHour: 2, sevenDay: 44, fable: 2, sevenDayGate: 95 }
    expect(claudeResetWarnings(fable, max, [fable, full])).toEqual([])
  })
})
