import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TIMEZONE, normalizeTimezone, US_TIMEZONES, validTimezone } from '../../src/lib/core/timezone.mjs'

test('slot timezone preserves valid IANA zones outside America', () => {
  for (const timezone of ['Asia/Tokyo', 'Asia/Shanghai', 'Europe/London', 'UTC']) {
    assert.equal(normalizeTimezone(timezone), timezone)
  }
  assert.equal(normalizeTimezone(' Asia/Tokyo '), 'Asia/Tokyo')
})

test('case-insensitive names resolve to case-sensitive Linux TZ names', () => {
  assert.equal(validTimezone(' asia/tokyo '), 'Asia/Tokyo')
  assert.equal(normalizeTimezone('aSiA/tOKyo'), 'Asia/Tokyo')
  assert.equal(normalizeTimezone('america/los_angeles'), 'America/Los_Angeles')
})

test('timezone aliases resolve to valid named zones', () => {
  // ICU versions may retain a valid alias or resolve it to the primary name.
  for (const [input, names] of [
    ['us/pacific', ['US/Pacific', 'America/Los_Angeles']],
    ['etc/utc', ['Etc/UTC', 'UTC']],
  ]) {
    const timezone = validTimezone(input)
    assert.ok(names.includes(timezone), `${input} resolved to ${timezone}`)
    assert.equal(normalizeTimezone(timezone), timezone)
  }
})

test('slot timezone keeps existing US defaults and valid America zones', () => {
  for (const timezone of [...US_TIMEZONES, 'America/Toronto']) {
    assert.equal(normalizeTimezone(timezone), timezone)
  }
  assert.equal(normalizeTimezone(), 'America/Los_Angeles')
})

test('invalid zones and numeric offsets use the default instead of reaching TZ', () => {
  for (const timezone of [null, '', ' ', 'Asia/Not_A_Zone', 'America/Not_A_Zone', '+09:00', '-0800']) {
    assert.equal(validTimezone(timezone), '')
    assert.equal(normalizeTimezone(timezone), DEFAULT_TIMEZONE)
  }
})
