import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkCallerPlacement,
  checkOfficial303Rules,
  checkOfficial303Wire,
  diffShapes,
  isAllowedSkeletonDiff,
  outboundShape,
} from '../../src/lib/protocol/outbound-shape.mjs'
import { sealClaudeCodeCch } from '../../src/lib/identity/cch.mjs'
import { OFFICIAL_303_MAIN_PROMPT } from '../../src/lib/identity/official-profiles.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SECRET_BODY = {
  model: 'claude-opus-5-5',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>\ntoken-SECRET /home/alice/project\n</system-reminder>\n' },
        { type: 'text', text: 'my password is hunter2', cache_control: { type: 'ephemeral' } },
      ],
    },
    { role: 'system', content: '# Environment\n - Primary working directory: /home/alice/project' },
  ],
  system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.303.abc; cc_entrypoint=sdk-cli; cch=00000;' },
    {
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    },
    {
      type: 'text',
      text: '\nYou are an agent working with the user toward their goals',
      cache_control: { type: 'ephemeral' },
    },
    { type: 'text', text: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__' },
    {
      type: 'text',
      text: 'Write code that reads like the surrounding code: match its comment density.',
      cache_control: { type: 'ephemeral' },
    },
  ],
  tools: [{ name: 'Bash', input_schema: {} }],
  metadata: { user_id: '{"device_id":"deadbeef","session_id":"cafe"}' },
  max_tokens: 1000,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'high' },
  stream: true,
}

test('shape keeps structure only: no prompt text, ids or secrets', () => {
  const shape = outboundShape(SECRET_BODY)
  const raw = JSON.stringify(shape)
  for (const leak of ['SECRET', 'hunter2', 'alice', 'deadbeef', 'cafe', 'agent working', 'cch=00000']) {
    assert.equal(raw.includes(leak), false, leak)
  }
  assert.deepEqual(
    shape.system.map((block) => block.kind),
    ['billing', 'identity', 'harness', 'boundary', 'guidance'],
  )
  assert.deepEqual(shape.billing_fields, ['cc_version', 'cc_entrypoint', 'cch'])
  assert.equal(shape.messages[0].blocks[0].kind, 'reminder')
  assert.equal(shape.messages[1].kind, 'env')
  assert.equal(shape.markers.total, 3)
})

test('diff ignores lengths and reports structural changes by path', () => {
  const a = outboundShape(SECRET_BODY)
  const longer = structuredClone(SECRET_BODY)
  longer.messages[0].content[1].text += ' and more'
  assert.deepEqual(diffShapes(a, outboundShape(longer)), [])
  const moved = structuredClone(SECRET_BODY)
  delete moved.messages[0].content[1].cache_control
  moved.messages[1] = { role: 'system', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }
  const diffs = diffShapes(a, outboundShape(moved))
  assert.ok(diffs.some((diff) => diff.path === 'messages[0].blocks[1].cache_control'))
  assert.ok(diffs.length > 0)
})

test('303 rules flag a marked role=system, a missing billing slot and extra markers', () => {
  assert.deepEqual(checkOfficial303Rules(SECRET_BODY), [])
  const bad = structuredClone(SECRET_BODY)
  bad.system.shift()
  bad.messages[1] = { role: 'system', content: [{ type: 'text', text: 'env', cache_control: { type: 'ephemeral' } }] }
  bad.tools[0].cache_control = { type: 'ephemeral', ttl: '1h' }
  const problems = checkOfficial303Rules(bad)
  assert.ok(problems.some((p) => p.startsWith('system kinds')))
  assert.ok(problems.includes('tools carry markers'))
  assert.ok(problems.some((p) => p.includes('role=system carries a marker')))
})

test('skeleton diff: billing slot and conditional top-level fields are allowed, other top-level drift is not', () => {
  assert.equal(isAllowedSkeletonDiff({ path: 'system[0].kind' }), true)
  assert.equal(
    isAllowedSkeletonDiff({
      path: 'top_level',
      expected: ['model', 'stream'],
      actual: ['model', 'context_management', 'stream'],
    }),
    true,
  )
  assert.equal(
    isAllowedSkeletonDiff({
      path: 'top_level',
      expected: ['model', 'stream'],
      actual: ['model', 'temperature', 'top_p', 'stream'],
    }),
    false,
  )
  assert.equal(isAllowedSkeletonDiff({ path: 'stream' }), false)
})

test('cli: --shape and --against-profile run on a body file without printing text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-shape-'))
  const file = path.join(dir, 'body.json')
  fs.writeFileSync(file, JSON.stringify({ body: SECRET_BODY }))
  try {
    const shape = execFileSync(process.execPath, [path.join(ROOT, 'scripts/outbound-shape.mjs'), '--shape', file], {
      encoding: 'utf8',
    })
    assert.equal(shape.includes('hunter2'), false)
    assert.equal(JSON.parse(shape).markers.total, 3)
    const report = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'scripts/outbound-shape.mjs'), '--against-profile', '2.1.303', file],
        {
          encoding: 'utf8',
        },
      ),
    )
    assert.deepEqual(report.blocking, [])
    assert.deepEqual(report.rules, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function wireOf(body, ua = 'claude-cli/2.1.303 (external, sdk-cli)') {
  const raw = JSON.stringify(sealClaudeCodeCch(body))
  return { raw, body: JSON.parse(raw), headers: { 'user-agent': ua, 'content-length': String(Buffer.byteLength(raw)) } }
}

const ids = (problems) => problems.filter((p) => p.blocking !== false).map((p) => p.id)

test('wire rules pass on a sealed 303 body and leak no text', () => {
  const problems = checkOfficial303Wire(wireOf(SECRET_BODY))
  assert.deepEqual(problems, [])
  const sealed = wireOf(SECRET_BODY)
  assert.match(sealed.body.system[0].text, /cch=[0-9a-f]{5};/)
  assert.doesNotMatch(sealed.body.system[0].text, /cch=00000/)
})

test('wire rules: internal field, key order, version, UA, tail system, CCH, content-length', () => {
  const leaked = wireOf({ ...SECRET_BODY, kin_outbound_shape: 'lean' })
  assert.deepEqual(ids(checkOfficial303Wire(leaked)), ['wire.kin_outbound_shape'])

  const { system, ...rest } = SECRET_BODY
  const reordered = wireOf({ system, ...rest })
  assert.deepEqual(ids(checkOfficial303Wire(reordered)), ['wire.top_level_order'])

  const extra = checkOfficial303Wire(wireOf({ ...SECRET_BODY, temperature: 1 }))
  assert.deepEqual(ids(extra), [])
  assert.deepEqual(extra, [{ id: 'wire.extra_key', key: 'temperature', index: 9, blocking: false }])

  const old = structuredClone(SECRET_BODY)
  old.system[0].text = old.system[0].text.replace('2.1.303', '2.1.296')
  assert.deepEqual(ids(checkOfficial303Wire(wireOf(old))), ['wire.billing_version'])
  const noBilling = structuredClone(SECRET_BODY)
  noBilling.system.shift()
  assert.deepEqual(ids(checkOfficial303Wire(wireOf(noBilling))), ['wire.billing_missing'])

  const ua = checkOfficial303Wire(wireOf(SECRET_BODY, 'claude-cli/2.1.296 (external, sdk-cli)'))
  assert.deepEqual(ua, [{ id: 'wire.user_agent', ua: 'claude-cli/2.1.296' }])

  const array = structuredClone(SECRET_BODY)
  array.messages[1].content = [{ type: 'text', text: array.messages[1].content }]
  assert.deepEqual(ids(checkOfficial303Wire(wireOf(array))), ['wire.tail_system_not_string'])

  const unsealed = wireOf(SECRET_BODY)
  const raw = unsealed.raw.replace(/cch=[0-9a-f]{5};/, 'cch=00000;')
  const placeholder = { raw, body: JSON.parse(raw), headers: { ...unsealed.headers } }
  assert.deepEqual(ids(checkOfficial303Wire(placeholder)), ['wire.cch'])
  const edited = { ...unsealed, raw: unsealed.raw.replace('hunter2', 'hunter3') }
  assert.deepEqual(ids(checkOfficial303Wire(edited)), ['wire.cch'])

  const length = { ...unsealed, headers: { ...unsealed.headers, 'content-length': '1' } }
  const lengthProblems = checkOfficial303Wire(length)
  assert.deepEqual(ids(lengthProblems), ['wire.content_length'])
  for (const leak of ['SECRET', 'hunter2', 'alice', 'deadbeef'])
    assert.equal(JSON.stringify([...lengthProblems, ...ua, ...extra]).includes(leak), false, leak)
})

const CALLER_PARA = 'You are the SECRET helper bot for alice; always answer in pirate speak please.'

function leanFor(reminder, { extraLeak = false } = {}) {
  const body = structuredClone(SECRET_BODY)
  body.messages[0].content[0].text = `<system-reminder>\n${reminder}\n</system-reminder>\n`
  if (extraLeak) body.system[3].text += `\n\n${CALLER_PARA}`
  return body
}

test('caller placement: non-official system lives only in the first reminder', () => {
  const inbound = { model: 'claude-opus-5-5', system: [{ type: 'text', text: CALLER_PARA }], messages: [] }
  assert.deepEqual(checkCallerPlacement(leanFor(CALLER_PARA), inbound, { officialCaller: false }), [])
  const missing = checkCallerPlacement(leanFor('other text'), inbound, { officialCaller: false })
  assert.deepEqual(ids(missing), ['caller.system_missing'])
  const leak = checkCallerPlacement(leanFor(CALLER_PARA, { extraLeak: true }), inbound, { officialCaller: false })
  assert.deepEqual(ids(leak), ['caller.system_leak'])
  assert.equal(leak[0].at, 'system[3]')
  assert.match(leak[0].para_sha, /^[0-9a-f]{12}$/)
  assert.equal(JSON.stringify([...missing, ...leak]).includes('pirate'), false)
})

test('caller placement: openai chat and responses system text are read from their own fields', () => {
  const chat = { model: 'm', messages: [{ role: 'developer', content: [{ type: 'text', text: CALLER_PARA }] }] }
  assert.deepEqual(
    checkCallerPlacement(leanFor(CALLER_PARA), chat, { officialCaller: false, protocol: 'openai.chat' }),
    [],
  )
  const responses = { model: 'm', instructions: CALLER_PARA, input: [] }
  assert.deepEqual(
    ids(checkCallerPlacement(leanFor('x'), responses, { officialCaller: false, protocol: 'openai.responses' })),
    ['caller.system_missing'],
  )
})

test('caller placement: official caller system never reaches the outbound; profile text is skipped', () => {
  const inbound = {
    model: 'claude-opus-5-5',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.303.abc; cc_entrypoint=cli; cch=e1d8b;' },
      { type: 'text', text: SECRET_BODY.system[1].text },
      { type: 'text', text: SECRET_BODY.system[2].text },
      { type: 'text', text: `${SECRET_BODY.system[3].text} toward their goals and more words here` },
      { type: 'text', text: CALLER_PARA },
    ],
    messages: [],
  }
  assert.deepEqual(ids(checkCallerPlacement(SECRET_BODY, inbound, { officialCaller: true })), [])
  const leaked = checkCallerPlacement(leanFor(CALLER_PARA), inbound, { officialCaller: true })
  assert.deepEqual(ids(leaked), ['caller.official_system_leak'])
  assert.equal(leaked[0].at, 'messages[0].content[0]')
  // The caller's own copy of the 303 main prompt is profile text, not a leak; only its
  // memory directory paragraph is caller-specific, and the slot renders its own.
  const render = (dir) => OFFICIAL_303_MAIN_PROMPT.replace('{{memory_dir}}', dir)
  const out = structuredClone(SECRET_BODY)
  out.system[3].text = render('/root/.claude/projects/-srv-slot/memory/')
  const caller = { system: [{ type: 'text', text: render('/home/alice/.claude/projects/-x/memory/') }] }
  const same = checkCallerPlacement(out, caller, { officialCaller: true })
  assert.deepEqual(ids(same), [])
  assert.ok(same.find((p) => p.id === 'caller.skipped').count > 3)
  out.system[3].text = caller.system[0].text
  assert.deepEqual(ids(checkCallerPlacement(out, caller, { officialCaller: true })), ['caller.official_system_leak'])
})

test('caller placement: temperature and context_management only when the caller sent them', () => {
  const out = { ...SECRET_BODY, temperature: 1, context_management: { edits: [] } }
  assert.deepEqual(ids(checkCallerPlacement(out, { messages: [] }, { officialCaller: false })), [
    'caller.temperature_added',
    'caller.context_management_added',
  ])
  assert.deepEqual(
    ids(
      checkCallerPlacement(out, { temperature: 0.2, context_management: {}, messages: [] }, { officialCaller: false }),
    ),
    [],
  )
})

test('cli: --against-profile --wire adds the final-bytes rules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-shape-'))
  const file = path.join(dir, 'capture.json')
  const script = path.join(ROOT, 'scripts/outbound-shape.mjs')
  try {
    fs.writeFileSync(file, JSON.stringify(wireOf(SECRET_BODY)))
    const ok = execFileSync(process.execPath, [script, '--against-profile', '2.1.303', file, '--wire'], {
      encoding: 'utf8',
    })
    assert.deepEqual(JSON.parse(ok).wire, [])
    assert.equal(ok.includes('hunter2'), false)
    fs.writeFileSync(file, JSON.stringify(wireOf({ ...SECRET_BODY, kin_outbound_shape: 'lean' })))
    assert.throws(
      () => execFileSync(process.execPath, [script, '--against-profile', '2.1.303', file, '--wire'], { stdio: 'pipe' }),
      (error) => error.status === 1 && JSON.parse(error.stdout).wire[0].id === 'wire.kin_outbound_shape',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
