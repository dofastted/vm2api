import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionLimitRegistry } from '../../src/lib/pool/session-limit.mjs'

test('max_sessions 0 is unlimited', () => {
  const r = new SessionLimitRegistry()
  assert.equal(r.canAccept('a', 's1', { max: 0 }).ok, true)
  r.touch('a', 's1')
  r.touch('a', 's2')
  assert.equal(r.canAccept('a', 's3', { max: 0 }).ok, true)
})

test('new key is refused at cap; existing key renews', () => {
  const r = new SessionLimitRegistry()
  r.touch('a', 'one')
  r.touch('a', 'two')
  assert.equal(r.canAccept('a', 'three', { max: 2 }).ok, false)
  assert.equal(r.canAccept('a', 'one', { max: 2 }).ok, true)
  r.touch('a', 'one')
  assert.equal(r.snapshot('a', { max: 2 }).active, 2)
})

test('idle timeout drops a stale released key', () => {
  const r = new SessionLimitRegistry()
  const now = Date.now()
  r.touch('a', 'old', now - 10 * 60_000)
  r.release('a', 'old', { now: now - 10 * 60_000 })
  r.touch('a', 'fresh', now)
  const snap = r.snapshot('a', { max: 8, idleMin: 5, now })
  assert.equal(snap.active, 1)
  assert.equal(r.canAccept('a', 'new', { max: 1, idleMin: 5, now }).ok, false)
  r.release('a', 'fresh', { now })
  assert.equal(r.canAccept('a', 'new', { max: 1, idleMin: 5, now: now + 6 * 60_000 }).ok, true)
})

test('a window with a live request outlives the idle TTL; idle starts at release', () => {
  const r = new SessionLimitRegistry()
  const start = Date.now()
  r.touch('a', 'stream', start)
  const later = start + 30 * 60_000
  assert.equal(r.snapshot('a', { max: 1, idleMin: 5, now: later }).active, 1)
  assert.equal(r.canAccept('a', 'other', { max: 1, idleMin: 5, now: later }).ok, false)
  r.release('a', 'stream', { now: later })
  assert.equal(r.canAccept('a', 'other', { max: 1, idleMin: 5, now: later + 4 * 60_000 }).ok, false)
  assert.equal(r.canAccept('a', 'other', { max: 1, idleMin: 5, now: later + 6 * 60_000 }).ok, true)
})

test('a release from a dropped placement does not free the new placement', () => {
  const r = new SessionLimitRegistry()
  const now = Date.now()
  const oldGen = r.touch('a', 's1', now)
  r.drop('a', 's1')
  r.touch('a', 's1', now)
  r.release('a', 's1', { gen: oldGen, now })
  assert.equal(r.snapshot('a', { max: 1, idleMin: 5, now: now + 60 * 60_000 }).active, 1)
})

test('release keeps the key until idle prune', () => {
  const r = new SessionLimitRegistry()
  r.touch('a', 's1')
  r.touch('a', 's2')
  assert.equal(r.release('a', 's1'), 2)
  assert.equal(r.snapshot('a', { max: 4 }).active, 2)
  assert.equal(r.release('a', 's1'), 2)
  assert.equal(r.snapshot('a', { max: 4 }).active, 2)
  assert.equal(r.canAccept('a', 's3', { max: 2 }).ok, false)
  assert.equal(r.canAccept('a', 's1', { max: 2 }).ok, true)
})

test('shared key stays occupied after the last reservation releases', () => {
  const r = new SessionLimitRegistry()
  r.touch('a', 'shared')
  r.touch('a', 'shared')
  assert.equal(r.snapshot('a', { max: 4 }).active, 1)
  r.release('a', 'shared')
  assert.equal(r.snapshot('a', { max: 4 }).active, 1)
  assert.equal(r.canAccept('a', 'new', { max: 1 }).ok, false)
  r.release('a', 'shared')
  assert.equal(r.snapshot('a', { max: 4 }).active, 1)
  assert.equal(r.canAccept('a', 'new', { max: 1 }).ok, false)
  assert.equal(r.canAccept('a', 'shared', { max: 1 }).ok, true)
})

test('idle prune frees a released key', () => {
  const r = new SessionLimitRegistry()
  const now = Date.now()
  r.touch('a', 's1', now)
  r.release('a', 's1')
  assert.equal(r.snapshot('a', { max: 1, idleMin: 5, now }).active, 1)
  assert.equal(r.canAccept('a', 's2', { max: 1, idleMin: 5, now }).ok, false)
  assert.equal(r.canAccept('a', 's2', { max: 1, idleMin: 5, now: now + 6 * 60_000 }).ok, true)
})
