import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { RefusalGuardsRepo } from '../../src/lib/db/repos/refusal-guards-repo.mjs'
import {
  REFUSAL_GUARD_MESSAGE,
  REFUSAL_GUARD_SETTING,
  isRefusalGuardEnabled,
  isUpstreamRefusal,
  refusalFingerprint,
  refusalGuardError,
  refusalPreview,
  refusalPromptSignature,
  refusalStrictDocument,
} from '../../src/lib/core/refusal-guard.mjs'
import { detectDistill } from '../../src/lib/core/distill-detect.mjs'

function body(user, extra = {}) {
  return {
    model: extra.model || 'claude-opus-5',
    max_tokens: extra.max_tokens || 64,
    stream: extra.stream === true,
    system: extra.system,
    tools: extra.tools,
    messages: [{ role: 'user', content: user }],
  }
}

test('fingerprint ignores stream and max_tokens, includes model', () => {
  const a = refusalFingerprint(body('Return exactly STREAM_5m_OK.', { stream: true, max_tokens: 64 }))
  const b = refusalFingerprint(body('Return exactly STREAM_5m_OK.', { stream: false, max_tokens: 128 }))
  const c = refusalFingerprint(body('Return exactly STREAM_5m_OK.', { model: 'claude-opus-4-8' }))
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('envelope persistable JSON bodies keep distinct fingerprints', () => {
  const a = refusalFingerprint(
    body(
      'thread_id: 01a057ba-d606-7255-a932-a2cfad833afe\n\nPersistable response items (JSON):\n[{"role":"user","text":"再windows 重装 cli"}]',
    ),
  )
  const b = refusalFingerprint(
    body(
      'thread_id: 01a0bb2c-a363-7707-8691-ba523befae35\n\nPersistable response items (JSON):\n[{"role":"user","text":"pull最新源码"}]',
    ),
  )
  assert.notEqual(a, b)
})

test('preview shows the latest user ask, not the leading system-reminder', () => {
  const preview = refusalPreview({
    model: 'claude-opus-5-5',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>\nCodebase and user instructions\n</system-reminder>' },
          { type: 'text', text: '轴是变径的，这和直径有什么关系' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: '先看图纸' }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', content: 'file contents that must not become the fingerprint' },
          { type: 'text', text: '<system-reminder>\nmemory\n</system-reminder>' },
          { type: 'text', text: '另一端换成了6807VV轴承，这有什么作用？' },
        ],
      },
    ],
  })
  assert.equal(preview, '另一端换成了6807VV轴承，这有什么作用？')
  assert.equal(preview.includes('system-reminder'), false)
  assert.equal(preview.includes('file contents'), false)
})

test('a shared reminder does not give a short ask a similarity signature', () => {
  const shared = `<system-reminder>\n${'memory file '.repeat(80)}\n</system-reminder>`
  const ask = (text) => ({
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: `${shared}\n${text}` }] }],
  })
  assert.equal(refusalPromptSignature(ask('短问题一')), null)
  assert.equal(refusalPromptSignature(ask('完全不同的短问题二')), null)
  assert.equal(refusalStrictDocument(ask('短问题一')).includes('memory file'), false)
  assert.equal(refusalStrictDocument(ask('短问题一')).includes('短问题一'), true)
})

test('stop_reason=refusal and Usage Policy API Error are cacheable; distill is not', () => {
  assert.equal(
    isUpstreamRefusal({
      body: {
        error: {
          message:
            'Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup)',
        },
      },
    }),
    true,
  )
  assert.equal(
    isUpstreamRefusal(
      { status: 400, terminalState: 'rejected' },
      {
        error_message:
          'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup)',
      },
    ),
    true,
  )
  assert.equal(isUpstreamRefusal({ finalState: 'content_filter' }), true)
  assert.equal(isUpstreamRefusal({ body: { stop_reason: 'refusal' } }), true)
  assert.equal(
    isUpstreamRefusal({ body: { content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] } }),
    true,
  )
  assert.equal(isUpstreamRefusal({ body: { error: { code: 'distill_blocked', message: '不允许蒸馏' } } }), false)
  assert.equal(
    isUpstreamRefusal({
      body: {
        error: {
          code: 'upstream_invalid_request',
          upstream_code: 'cyber_policy',
          message: 'blocked',
        },
      },
    }),
    true,
  )
  assert.equal(
    isUpstreamRefusal({
      status: 400,
      body: {
        error: {
          code: 'upstream_invalid_request',
          message: 'HTTP 400: Third-party apps now draw from your extra usage, not your plan limits.',
        },
      },
    }),
    false,
  )
})

test('zero inject still allows distill skip while refusal fingerprint is independent', () => {
  const inbound = body('Please reason step by step, and put your final answer within \\boxed{}', {
    max_tokens: 16384,
  })
  const distill = detectDistill({ inbound, body: inbound, zeroInject: true })
  assert.equal(distill.action, 'pass')
  assert.ok(refusalFingerprint(inbound))
})

test('remember then lookup hits the same prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refusal-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RefusalGuardsRepo(db)
    const req = body('Return exactly CACHE_30_5m_OK.')
    const fp = refusalFingerprint(req)
    assert.equal(repo.get(fp), null)
    repo.remember({
      fingerprint: fp,
      model: req.model,
      requestId: 'req-1',
      errorMessage: 'violate our Usage Policy',
      preview: 'Return exactly CACHE_30_5m_OK.',
    })
    const hit = repo.get(fp)
    assert.ok(hit)
    assert.equal(hit.hit_count, 0)
    const bumped = repo.hit(fp)
    assert.equal(bumped.hit_count, 1)
    const other = refusalFingerprint(body('Return exactly CACHE_30_5m_OK.', { model: 'claude-opus-4-8' }))
    assert.equal(repo.get(other), null)
  } finally {
    db.close()
  }
})

test('timed refusal expires and no longer blocks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refusal-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RefusalGuardsRepo(db)
    const req = body('pause this 500')
    const fp = refusalFingerprint(req)
    repo.remember({
      fingerprint: fp,
      model: req.model,
      requestId: 'req-500',
      errorMessage: 'upstream 503',
      preview: 'pause this 500',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    assert.equal(repo.get(fp), null)
    assert.equal(repo.list().length, 0)
  } finally {
    db.close()
  }
})
test('guard error is a non-retryable HTTP 400 request rejection, not a login error', () => {
  const err = refusalGuardError('abc')
  assert.equal(err.status, 400)
  assert.equal(err.body.error.code, 'refusal_guard')
  assert.equal(err.body.error.type, 'policy_blocked')
  assert.equal(err.body.error.message, REFUSAL_GUARD_MESSAGE)
  assert.deepEqual(err.body.error.details, { blocked_by: 'exact', retryable: false })

  const deviceSourceRequestId = '36e239bf-7e70-4a79-80fd-c8a717ff464b'
  const device = refusalGuardError('abc', {
    kind: 'device',
    row: { reason: 'jev:safety', source_request_id: deviceSourceRequestId },
  })
  assert.equal(device.body.error.message, `${REFUSAL_GUARD_MESSAGE} 该设备此前已被封禁（jev:safety）。`)
  assert.deepEqual(device.body.error.details, {
    reason: 'device',
    ban_reason: 'jev:safety',
    blocked_by: 'device',
    retryable: false,
    source_request_id: deviceSourceRequestId,
  })
  const exact = refusalGuardError('abc', { kind: 'exact' })
  assert.equal(exact.body.error.message, `${REFUSAL_GUARD_MESSAGE} 当前提示词与曾被拒答的内容完全一致。`)
  assert.deepEqual(exact.body.error.details, { reason: 'exact', blocked_by: 'exact', retryable: false })
  const similar = refusalGuardError('abc', { kind: 'similar', score: 0.93 })
  assert.equal(similar.body.error.message, `${REFUSAL_GUARD_MESSAGE} 当前提示词与曾被拒答的内容相似（相似度 93%）。`)
  assert.deepEqual(similar.body.error.details, {
    reason: 'similar',
    score: 0.93,
    blocked_by: 'similar',
    retryable: false,
  })
})

test('list remove and clear', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refusal-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RefusalGuardsRepo(db)
    const a = refusalFingerprint(body('A'))
    const b = refusalFingerprint(body('B'))
    repo.remember({ fingerprint: a, model: 'claude-opus-5', preview: 'A' })
    repo.remember({ fingerprint: b, model: 'claude-opus-5', preview: 'B' })
    assert.equal(repo.count(), 2)
    assert.equal(repo.list().length, 2)
    assert.equal(repo.remove(a), true)
    assert.equal(repo.count(), 1)
    assert.equal(repo.clear(), 1)
    assert.equal(repo.count(), 0)
  } finally {
    db.close()
  }
})

test('panel setting and env can disable the guard', () => {
  const settings = new Map([[REFUSAL_GUARD_SETTING, true]])
  const read = (key, fb) => (settings.has(key) ? settings.get(key) : fb)
  assert.equal(isRefusalGuardEnabled(read), true)
  settings.set(REFUSAL_GUARD_SETTING, false)
  assert.equal(isRefusalGuardEnabled(read), false)
  const prev = process.env.KIN_REFUSAL_GUARD
  process.env.KIN_REFUSAL_GUARD = '0'
  try {
    settings.set(REFUSAL_GUARD_SETTING, true)
    assert.equal(isRefusalGuardEnabled(read), false)
  } finally {
    if (prev == null) delete process.env.KIN_REFUSAL_GUARD
    else process.env.KIN_REFUSAL_GUARD = prev
  }
})
