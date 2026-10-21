import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../../src/lib/db/database.mjs'
import { RefusalGuardsRepo } from '../../src/lib/db/repos/refusal-guards-repo.mjs'
import { RefusalDeviceBlocksRepo } from '../../src/lib/db/repos/refusal-device-blocks-repo.mjs'
import {
  applyRefusalGuardPatch,
  inboundRefusalDeviceId,
  matchStoredRefusal,
  normalizeRefusalSimilarity,
  refusalFingerprint,
  refusalGuardPolicy,
  refusalPromptSignature,
} from '../../src/lib/core/refusal-guard.mjs'
import {
  REFUSAL_SIMILARITY,
  refusalSignature,
  refusalUserDocument,
  signatureSimilarity,
} from '../../src/lib/core/refusal-similarity.mjs'

function longUser(seed, extra = '') {
  const chunk = `${seed} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu `
  return chunk.repeat(40) + extra
}

function body(user, extra = {}) {
  return {
    model: 'claude-opus-5.5',
    system: 'You are Claude Code. ' + 'system prefix '.repeat(80),
    messages: [{ role: 'user', content: user }],
    metadata: extra.metadata,
    device_id: extra.device_id,
  }
}

function codexBody(text, extra = {}) {
  return {
    model: 'gpt-6-astra',
    instructions: 'You are Codex.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    ...extra,
  }
}

test('user document ignores a shared system prefix', () => {
  const a = body(longUser('attack-one'))
  const b = body(longUser('attack-two-completely-different-ask'))
  assert.equal(refusalUserDocument(a).includes('claude code'), false)
  assert.notEqual(refusalUserDocument(a), refusalUserDocument(b))
})

test('a 10 percent tail edit stays at or above 90 percent and a 40 percent rewrite does not', () => {
  const base = longUser('payload')
  const near = base.slice(0, Math.floor(base.length * 0.9)) + 'x'.repeat(Math.ceil(base.length * 0.1))
  const far = base.slice(0, Math.floor(base.length * 0.55)) + 'y'.repeat(Math.ceil(base.length * 0.45))
  const baseSig = refusalSignature(base)
  const nearScore = signatureSimilarity(baseSig, refusalSignature(near))
  const farScore = signatureSimilarity(baseSig, refusalSignature(far))
  assert.ok(nearScore >= REFUSAL_SIMILARITY, `near ${nearScore}`)
  assert.ok(farScore < REFUSAL_SIMILARITY, `far ${farScore}`)
})

test('short text has no similarity signature', () => {
  assert.equal(refusalSignature('too short to compare'), null)
})

test('a Responses input array carries the user turns', () => {
  const doc = refusalUserDocument(codexBody(longUser('codex-payload')))
  assert.notEqual(doc, '')
  assert.equal(doc.includes('alpha beta gamma'), true)
  assert.equal(doc.includes('you are codex'), false)
})

test('assistant and tool items never join the Responses user document', () => {
  const doc = refusalUserDocument({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first ask' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'assistant echo' }] },
      { type: 'function_call_output', call_id: 'call-1', output: 'tool output' },
      { type: 'input_text', text: 'second ask' },
    ],
  })
  assert.equal(doc.includes('first ask'), true)
  assert.equal(doc.includes('second ask'), true)
  assert.equal(doc.includes('assistant echo'), false)
  assert.equal(doc.includes('tool output'), false)
})

test('a Responses prompt with a small tail edit stays above the similarity line', () => {
  const base = longUser('codex-payload')
  const near = base.slice(0, Math.floor(base.length * 0.95)) + 'z'.repeat(Math.ceil(base.length * 0.05))
  const baseSig = refusalSignature(refusalUserDocument(codexBody(base)))
  assert.ok(baseSig)
  const nearScore = signatureSimilarity(baseSig, refusalSignature(refusalUserDocument(codexBody(near))))
  assert.ok(nearScore >= REFUSAL_SIMILARITY, `near ${nearScore}`)
})

test('stored near-duplicate blocks and then the device blocks any later prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-near-'))
  const db = await getDb()
  try {
    const guards = new RefusalGuardsRepo(db)
    const devices = new RefusalDeviceBlocksRepo(db)
    const original = body(longUser('payload'), {
      metadata: { user_id: { device_id: 'device-aaaabbbbcccc', session_id: 'sess-1' } },
    })
    const fp = refusalFingerprint(original)
    await guards.remember({
      fingerprint: fp,
      model: original.model,
      signature: refusalPromptSignature(original),
      preview: 'payload',
    })
    const edited = body(longUser('payload').slice(0, Math.floor(longUser('payload').length * 0.92)) + ' edited tail', {
      metadata: { user_id: { device_id: 'device-aaaabbbbcccc', session_id: 'sess-1' } },
    })
    assert.notEqual(refusalFingerprint(edited), fp)
    const similar = await matchStoredRefusal({ inbound: edited, body: edited, repo: guards, devices })
    assert.equal(similar.kind, 'similar')
    assert.ok(similar.score >= REFUSAL_SIMILARITY)
    await devices.block({ deviceId: similar.deviceId, fingerprint: similar.fingerprint, reason: 'refusal_similar' })
    const other = body('completely different short ask', {
      metadata: { user_id: { device_id: 'device-aaaabbbbcccc', session_id: 'sess-2' } },
    })
    const banned = await matchStoredRefusal({ inbound: other, body: other, repo: guards, devices })
    assert.equal(banned.kind, 'device')
    assert.equal(inboundRefusalDeviceId({ inbound: { device_id: 'short' } }), '')
    assert.equal(await devices.block({ deviceId: '' }), null)
  } finally {
    await db.close()
  }
})

test('different user text under the same system is not a near match', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-near-'))
  const db = await getDb()
  try {
    const guards = new RefusalGuardsRepo(db)
    const stored = body(longUser('payload-a'))
    await guards.remember({
      fingerprint: refusalFingerprint(stored),
      model: stored.model,
      signature: refusalPromptSignature(stored),
    })
    const other = body(longUser('unrelated-question-about-refactoring-the-scheduler'))
    assert.equal(await matchStoredRefusal({ inbound: other, body: other, repo: guards, devices: null }), null)
  } finally {
    await db.close()
  }
})

test('panel policy defaults on at 90 and rejects an unknown threshold', async () => {
  assert.deepEqual(refusalGuardPolicy(), {
    enabled: true,
    similarity_enabled: true,
    similarity: 90,
    device_block_enabled: true,
  })
  const settings = new Map()
  const store = {
    get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
    set: (key, value) => settings.set(key, value),
  }
  assert.equal((await applyRefusalGuardPatch(store, { similarity: 70 })).ok, false)
  assert.equal((await applyRefusalGuardPatch(store, { similarity: 85, similarity_enabled: false })).ok, true)
  assert.equal(normalizeRefusalSimilarity(85), 85)
  assert.deepEqual(
    refusalGuardPolicy((key, fallback) => store.get(key, fallback)),
    {
      enabled: true,
      similarity_enabled: false,
      similarity: 85,
      device_block_enabled: true,
    },
  )
})

test('turning similarity or device block off skips that check', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-near-'))
  const db = await getDb()
  try {
    const guards = new RefusalGuardsRepo(db)
    const devices = new RefusalDeviceBlocksRepo(db)
    const stored = body(longUser('payload'), {
      metadata: { user_id: { device_id: 'device-aaaabbbbcccc', session_id: 'sess-1' } },
    })
    await guards.remember({
      fingerprint: refusalFingerprint(stored),
      model: stored.model,
      signature: refusalPromptSignature(stored),
    })
    await devices.block({ deviceId: 'device-aaaabbbbcccc', reason: 'refusal_guard' })
    const edited = body(longUser('payload').slice(0, -20) + 'tail-edit-xx', {
      metadata: { user_id: { device_id: 'device-aaaabbbbcccc', session_id: 'sess-9' } },
    })
    assert.equal(
      await matchStoredRefusal({
        inbound: edited,
        body: edited,
        repo: guards,
        devices,
        deviceBlockEnabled: false,
        similarityEnabled: false,
      }),
      null,
    )
  } finally {
    await db.close()
  }
})
