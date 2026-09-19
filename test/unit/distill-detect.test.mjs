import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAPABILITY_CASES, FORM_QUESTIONS } from '../../src/lib/admin/probe-test.mjs'
import {
  DEFAULT_DISTILL_RULES,
  detectDistill,
  distillBlockError,
  loadDistillRules,
  normalizeDistillRules,
  saveDistillRules,
  validateDistillPatch,
} from '../../src/lib/core/distill-detect.mjs'
import { ErrorCode } from '../../src/lib/core/errors.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const REASON_ASK = '请分步解答。先写推理过程，最后单独一行写：\n最终答案：...'

function inbound(user, extra = {}) {
  return {
    model: 'claude-sonnet-4-5',
    max_tokens: extra.max_tokens ?? 4096,
    messages: [{ role: 'user', content: user }],
    ...extra,
  }
}

test('fingerprint of a known distill question is blocked', () => {
  const hit = detectDistill({
    inbound: inbound(
      "Jia walks from home to Yi's house. At the same time, Yi rides a bicycle from Yi's house to Jia's.",
    ),
  })
  assert.equal(hit.action, 'block')
  assert.equal(hit.hits[0].rule, 'fingerprint')
  assert.equal(hit.error.message, '不允许蒸馏')
})

test('prompt template needles are blocked without waiting for structure', () => {
  const hit = detectDistill({
    inbound: inbound('Respond in the following format: <think>\nhello', { max_tokens: 256 }),
  })
  assert.equal(hit.action, 'block')
  assert.equal(
    hit.hits.some((h) => h.rule === 'needle'),
    true,
  )
})

test('openai chat memory-extractor harvest is blocked without structure gates', () => {
  const hit = detectDistill({
    inbound: {
      model: 'claude-opus-5',
      max_tokens: 4096,
      stream: true,
      messages: [
        {
          role: 'system',
          content:
            "x-anthropic-billing-header: cc_version=2.1.257.039; You are Claude Code, Anthropic's official CLI for Claude.Memory-stage-one extractor.\nMUST distill reusable, durable rollout knowledge.",
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'thread_id: abc\n\nPersistable response items (JSON):\n[{"role":"user","text":"ui显示效果追加"}]\n\nYou MUST extract durable memory now.',
            },
          ],
        },
      ],
    },
  })
  assert.equal(hit.action, 'block')
  assert.equal(
    hit.hits.some((h) => h.rule === 'needle'),
    true,
  )
})

test('plain cluster VM email UI prompt is not distill', () => {
  const hit = detectDistill({
    inbound: inbound('ui显示效果追加.\ncluster 和 vm页面\n槽 命名下面需要显示 账号邮箱信息.'),
  })
  assert.equal(hit.action, 'pass')
})

test('contest harvest with inbound thinking text is blocked', () => {
  const hit = detectDistill({
    inbound: inbound('Prove that if alpha, beta, gamma are the angles of a triangle, then cos a + cos b > 0.', {
      max_tokens: 16384,
      thinking: { type: 'adaptive', display: 'summarized' },
    }),
  })
  assert.equal(hit.action, 'block')
  assert.ok(hit.hits.some((h) => h.rule === 'fingerprint' || h.rule === 'harvest'))
})

test('high max_tokens plus omitted thinking is not enough', () => {
  const hit = detectDistill({
    inbound: inbound('今天天气怎么样', {
      max_tokens: 32000,
      thinking: { type: 'adaptive', display: 'omitted' },
    }),
  })
  assert.equal(hit.action, 'pass')
})

test('official Claude Code traffic is skipped', () => {
  const hit = detectDistill({
    inbound: inbound('Please reason step by step, and put your final answer within \\boxed{}'),
    official: true,
  })
  assert.equal(hit.action, 'pass')
})

test('zero inject skips distill and is not a refusal-guard path', () => {
  const hit = detectDistill(
    {
      inbound: inbound('Please reason step by step, and put your final answer within \\boxed{}'),
      zeroInject: true,
    },
    { skip_zero: true },
  )
  assert.equal(hit.action, 'pass')
})

test('disabled rules pass everything', () => {
  const hit = detectDistill({ inbound: inbound('<think>secret</think>') }, { enabled: false })
  assert.equal(hit.action, 'pass')
})

test('capability probes are not distill', () => {
  for (const c of CAPABILITY_CASES) {
    const hit = detectDistill({
      inbound: inbound(c.user, {
        max_tokens: c.max_tokens,
        system: c.system,
        thinking: { type: 'adaptive', display: 'omitted' },
      }),
    })
    assert.equal(hit.action, 'pass', c.id)
  }
})

test('form questions including 请分步解答 are not distill', () => {
  for (const q of FORM_QUESTIONS) {
    const hit = detectDistill({
      inbound: inbound(`${REASON_ASK}\n\n${q.user}`, {
        max_tokens: 8192,
        thinking: { type: 'adaptive', display: 'omitted' },
      }),
    })
    assert.equal(hit.action, 'pass', q.id)
  }
})

test('default needles do not include 请分步解答', () => {
  assert.equal(
    DEFAULT_DISTILL_RULES.needles.some((n) => String(n).includes('请分步解答')),
    false,
  )
})

test('distillBlockError uses panel-editable message and 403', () => {
  const err = distillBlockError(
    { error: { message: '不允许蒸馏', status: 403, code: ErrorCode.DISTILL_BLOCKED } },
    'req-1',
  )
  assert.equal(err.status, 403)
  assert.equal(err.body.error.message, '不允许蒸馏')
  assert.equal(err.body.error.code, 'distill_blocked')
  assert.equal(err.body.error.type, 'permission_error')
})

test('validateDistillPatch rejects bad status', () => {
  assert.deepEqual(validateDistillPatch({ error: { status: 200 } }), ['error.status 必须是 400–599'])
  assert.deepEqual(validateDistillPatch({ enabled: 'yes' }), ['enabled 必须是布尔'])
})

test('save and load round-trip a patch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-distill-'))
  const file = path.join(dir, 'distill-rules.json')
  const saved = saveDistillRules(file, { enabled: false, error: { message: '停' } })
  assert.equal(saved.enabled, false)
  assert.equal(saved.error.message, '停')
  const loaded = loadDistillRules(file)
  assert.equal(loaded.enabled, false)
  assert.equal(loaded.error.message, '停')
  assert.equal(loaded.skip_official, true)
})

test('normalize keeps default fingerprints when omitted', () => {
  const r = normalizeDistillRules({ enabled: true })
  assert.ok(r.fingerprints.length >= 5)
  assert.equal(r.error.message, '不允许蒸馏')
})

test('handleProtocol intercepts distill before credential hop, refusal guard after distill', () => {
  const src = fs.readFileSync(path.join(root, 'src/lib/protocol/handle-protocol.mjs'), 'utf8')
  const before = src.indexOf("applyIntercept(cfg.intercept.rules, 'before_upstream'")
  const distill = src.indexOf('if (applyDistillGuard({ req, inbound, body: ctx.body')
  const refusal = src.indexOf('if (applyRefusalGuard({ inbound, body: ctx.body')
  const api = src.indexOf("inferenceBackend === 'api'")
  assert.ok(before > 0)
  assert.ok(distill > before)
  assert.ok(refusal > distill)
  assert.ok(api > refusal)
})
