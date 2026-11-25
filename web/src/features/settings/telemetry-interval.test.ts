import { describe, expect, it } from 'vitest'
import {
  amountIn,
  intervalLabel,
  isExactInUnit,
  secondsFrom,
  unitOf,
  uploadIntervalOf,
} from './telemetry-interval'

describe('telemetry upload interval', () => {
  it('falls back to 10 minutes for missing or invalid values, like the gateway', () => {
    expect(uploadIntervalOf(undefined)).toBe(600)
    for (const bad of [0, 30, 90, 86_460, '600', 600.5]) {
      expect(uploadIntervalOf(bad)).toBe(600)
    }
    expect(uploadIntervalOf(7200)).toBe(7200)
  })

  it('opens whole hours in the hour unit, everything else in minutes', () => {
    expect(unitOf(3600)).toBe('hour')
    expect(unitOf(86_400)).toBe('hour')
    expect(unitOf(5400)).toBe('min')
    expect(unitOf(600)).toBe('min')
  })

  it('converts and clamps per unit', () => {
    expect(secondsFrom(90, 'min')).toBe(5400)
    expect(secondsFrom(0, 'min')).toBe(60)
    expect(secondsFrom(2000, 'min')).toBe(86_400)
    expect(secondsFrom(30, 'hour')).toBe(86_400)
    expect(amountIn(5400, 'hour')).toBe(2)
    expect(amountIn(5400, 'min')).toBe(90)
  })

  it('labels mixed hours and minutes', () => {
    expect(intervalLabel(600)).toBe('10 分钟')
    expect(intervalLabel(7200)).toBe('2 小时')
    expect(intervalLabel(5400)).toBe('1 小时 30 分钟')
  })

  it('detects whether seconds can be represented losslessly in a unit', () => {
    expect(isExactInUnit(600, 'min')).toBe(true)
    expect(isExactInUnit(600, 'hour')).toBe(false)
    expect(isExactInUnit(3600, 'hour')).toBe(true)
    expect(isExactInUnit(3600, 'min')).toBe(true)
    expect(isExactInUnit(5400, 'hour')).toBe(false)
    expect(isExactInUnit(5400, 'min')).toBe(true)
  })
})
