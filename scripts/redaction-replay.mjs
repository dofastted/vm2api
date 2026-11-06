#!/usr/bin/env node
/**
 * Replay the redaction acceptance rows that the helper and Node seal path can
 * observe without a live vendor. Prints one verdict per row and exits 1 on FAIL.
 *
 *   node scripts/redaction-replay.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeWorkerPayload, prepareWorkerPayload } from '../src/lib/transport/go-worker-client.mjs'
import {
  createSseRestorer,
  ensureRedaction,
  maskJson,
  publishRedactionForTests,
  restoreJsonValue,
} from '../src/lib/redaction/runtime.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-redact-replay-'))
const bin = path.join(work, 'kin-redact')
const secret = 'sk-' + 'proj-' + 'Aa1Bb2Cc3Dd4Ee5Ff6Gg'
const policy = { enabled: true, secrets: true, personal: true, words: ['夜莺计划'], rules: [] }
const vm = { homeDir: '', projectRoot: work, vm: { claude: { mode: 'setup-token', scope: 'user:inference' } } }
const rows = []

function record(id, ok, detail) {
  rows.push({ id, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail}\n`)
}

function bodyOf(content) {
  return { model: 'claude-sonnet-5', max_tokens: 32, messages: [{ role: 'user', content }] }
}

async function main() {
  execFileSync('go', ['build', '-o', bin, './cmd/kin-redact'], { cwd: path.join(ROOT, 'redact'), stdio: 'inherit' })
  publishRedactionForTests(null)

  const off = await ensureRedaction({}, { projectRoot: work, binPath: bin })
  const plain = bodyOf(`token ${secret}`)
  const offMasked = await maskJson(structuredClone(plain), { principal: 'key-a', session: 's' })
  const offSealed = finalizeWorkerPayload({ body: structuredClone(plain), reqHeaders: {}, exec: vm, routing: {} })
  record(
    'V01',
    off.enabled === false &&
      JSON.stringify(offMasked) === JSON.stringify(plain) &&
      JSON.stringify(offSealed.body).includes(secret),
    'off leaves the body unchanged',
  )

  let missing = null
  try {
    await ensureRedaction({ redaction: policy }, { projectRoot: work, binPath: path.join(work, 'missing-kin-redact') })
  } catch (error) {
    missing = error
  }
  record('V05', missing?.code === 'redaction_unavailable', missing?.code || 'no error')

  const on = await ensureRedaction({ redaction: policy }, { projectRoot: work, binPath: bin })
  record('V05b', on.ready === true, 'helper ready')

  const ctx = { principal: 'key-a', session: 's1' }
  const masked = await maskJson(bodyOf(`token ${secret} 夜莺计划`), ctx)
  const maskedText = JSON.stringify(masked)
  const other = await restoreJsonValue(masked, { principal: 'key-b', session: 's1' })
  const same = await restoreJsonValue(masked, ctx)
  record(
    'V06',
    !maskedText.includes(secret) &&
      !JSON.stringify(other).includes(secret) &&
      JSON.stringify(same).includes(secret) &&
      JSON.stringify(same).includes('夜莺计划'),
    'cross-principal restore stays literal',
  )

  const toolMasked = await maskJson(
    {
      model: 'claude-sonnet-5',
      max_tokens: 32,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01',
              content: JSON.stringify({ command: `echo ${secret}`, name: 'leave-this-name' }),
            },
          ],
        },
      ],
      tools: [
        {
          name: 'echo',
          description: `ring ${secret}`,
          input_schema: { type: 'object', properties: { name: { type: 'string' } } },
        },
      ],
    },
    ctx,
  )
  const toolRaw = JSON.stringify(toolMasked)
  record(
    'V07',
    !toolRaw.includes(secret) && toolRaw.includes('"name":"echo"') && toolRaw.includes('"tool_use_id":"toolu_01"'),
    'tool id kept, secret removed',
  )

  const prepared = prepareWorkerPayload({
    body: {
      ...bodyOf(`token ${secret}`),
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.303; cc_entrypoint=sdk-cli' }],
    },
    reqHeaders: {},
    exec: vm,
    routing: { compatibility: { cch_enabled: true } },
  })
  const gated = await maskJson(prepared.gated, ctx)
  const sealed = finalizeWorkerPayload({
    body: gated,
    reqHeaders: {},
    exec: vm,
    routing: { compatibility: { cch_enabled: true } },
  })
  const sealedText = JSON.stringify(sealed.body)
  const cch = /cch=[0-9a-f]{5}/.test(sealedText)
  record(
    'V10',
    !JSON.stringify(gated).includes(secret) && !sealedText.includes(secret) && cch,
    `gatedSecret=${JSON.stringify(gated).includes(secret)} sealedSecret=${sealedText.includes(secret)} cch=${cch}`,
  )

  const tag = maskedText.match(/\{\{R_[A-Z0-9_]+_[a-z2-7]{26}\}\}/)?.[0]
  if (!tag) {
    record('V15', false, 'no tag to split')
  } else {
    const cut = 12
    const restorer = createSseRestorer(ctx)
    const first = await restorer.line(
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `see ${tag.slice(0, cut)}` } })}`,
    )
    const second = await restorer.line(
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'other' } })}`,
    )
    const third = await restorer.line(
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${tag.slice(cut)} end` } })}`,
    )
    const joined = `${first}\n${second}\n${third}`
    record(
      'V15',
      joined.includes(secret) && !joined.includes(tag) && second.includes('other'),
      'split tag restored on the same block only',
    )
  }

  let signed = null
  try {
    await maskJson(
      {
        model: 'claude-sonnet-5',
        max_tokens: 32,
        messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: `key ${secret}`, signature: 'sig' }] }],
      },
      ctx,
    )
  } catch (error) {
    signed = error
  }
  record('V17', signed?.code === 'redaction_signed_history_requires_reset', signed?.code || 'no error')

  on.child?.kill()
  publishRedactionForTests(null)
  let badRule = null
  try {
    await ensureRedaction(
      { redaction: { ...policy, rules: [{ kind: 'SYNTH', regex: '*' }] } },
      { projectRoot: path.join(work, 'bad-rules'), binPath: bin },
    )
  } catch (error) {
    badRule = error
  }
  record(
    'V03',
    badRule?.code === 'invalid_redaction_config',
    `${badRule?.code || 'no error'} ${String(badRule?.message || '').slice(0, 120)}`,
  )

  const failed = rows.filter((row) => !row.ok)
  process.stdout.write(`\n${rows.length - failed.length}/${rows.length} passed\n`)
  return failed.length ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`)
    process.exit(1)
  })
