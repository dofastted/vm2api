/**
 * official_303 on the real chain: Node handler → kin-kernel ELF → cli-node ELF → local upstream.
 * Needs the binaries, so it is opt-in:
 *   KIN_303_KERNEL=<kin-kernel> KIN_303_CLI=<cli-node with profile mode>
 *   KIN_303_BASE_CLI=<cli-node before this change> (296 byte regression)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  OFFICIAL_303_ENV_UNTRUSTED,
  OFFICIAL_303_IDENTITY,
  OFFICIAL_303_MAIN_PROMPT,
} from '../../src/lib/identity/official-profiles.mjs'
import {
  checkOfficial303Rules,
  diffShapes,
  isAllowedSkeletonDiff,
  outboundShape,
} from '../../src/lib/protocol/outbound-shape.mjs'
import { computeClaudeCodeCch, projectClaudeCodeCchText } from '../../src/lib/identity/cch.mjs'
import { startRealChain } from './helpers/real-chain.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const kernelBin = process.env.KIN_303_KERNEL || ''
const cliBin = process.env.KIN_303_CLI || ''
const baseCli = process.env.KIN_303_BASE_CLI || ''
const skip = !kernelBin || !cliBin || !fs.existsSync(kernelBin) || !fs.existsSync(cliBin)
const SKELETON = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/official-2.1.303-skeleton.json'), 'utf8'))

async function harness(t, { preset = 'official_303', cacheTtl = '5m', cli = cliBin } = {}) {
  const chain = await startRealChain({ kernelBin, cliBin: cli, preset, cacheTtl })
  t.after(chain.close)
  const send = async (body, userAgent) => {
    const wire = await chain.send({ request: { path: '/v1/messages', headers: { 'user-agent': userAgent }, body } })
    assert.equal(wire.status, 200, wire.response)
    return { raw: wire.raw, body: wire.body, headers: wire.headers }
  }
  return { send, switchPreset: chain.switchPreset, logs: chain.logs, health: chain.health }
}

const ENV = [
  '# Environment',
  'You have been invoked in the following environment: ',
  ' - Primary working directory: /srv/app',
  ' - Is a git repository: true',
  ' - Platform: linux',
  ' - Shell: bash',
  ' - OS Version: Linux 6.6.1-test',
  OFFICIAL_303_ENV_UNTRUSTED,
  '',
  'You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5. Assistant knowledge cutoff is June 2026.',
].join('\n')
const AFTER_ENV =
  "\n\n# Language\nAlways respond in Chinese.\n\n<total_tokens>15000000 tokens left</total_tokens>\n\nToday's date is 2026-10-22."
const OFFICIAL_UA = 'claude-cli/2.1.303 (external, cli)'

function officialRequest(model = 'claude-opus-5-5', history = []) {
  return {
    model,
    max_tokens: 32000,
    stream: true,
    metadata: {
      user_id: JSON.stringify({
        device_id: 'ab'.repeat(32),
        account_uuid: '',
        session_id: '11111111-2222-4333-8444-555555555555',
      }),
    },
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.303.abc; cc_entrypoint=cli; cch=00000;' },
      { type: 'text', text: OFFICIAL_303_IDENTITY, cache_control: { type: 'ephemeral' } },
      {
        type: 'text',
        text: OFFICIAL_303_MAIN_PROMPT.replace('{{memory_dir}}', '/home/caller/.claude/projects/-srv-app/memory/'),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>\nCLAUDE.md: be brief.\n</system-reminder>\n' },
          { type: 'text', text: 'hello', ...(history.length ? {} : { cache_control: { type: 'ephemeral' } }) },
        ],
      },
      { role: 'system', content: `${ENV}${AFTER_ENV}` },
      ...history,
    ],
    tools: [{ name: 'Bash', description: 'run a command', input_schema: { type: 'object', properties: {} } }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
  }
}

function billingOf(wire) {
  return wire.body.system.find((block) => block.text.startsWith('x-anthropic-billing-header:'))?.text || ''
}

function assertCch(wire) {
  const cch = /\bcch=([0-9a-f]{5});/.exec(billingOf(wire))?.[1]
  assert.ok(cch && cch !== '00000', 'CCH sealed')
  assert.equal(computeClaudeCodeCch(Buffer.from(projectClaudeCodeCchText(wire.raw), 'utf8')), cch)
  assert.equal(Buffer.byteLength(wire.raw), Number(wire.headers['content-length']))
}

test('official_303 lean on the real chain: skeleton, rules, version, CCH', { skip, timeout: 60000 }, async (t) => {
  const h = await harness(t)
  const wire = await h.send(officialRequest(), OFFICIAL_UA)
  assert.deepEqual(checkOfficial303Rules(wire.body), [])
  const blocking = diffShapes(SKELETON, outboundShape(wire.body)).filter((diff) => !isAllowedSkeletonDiff(diff))
  assert.deepEqual(blocking, [])
  assert.deepEqual(Object.keys(wire.body), [
    'model',
    'messages',
    'system',
    'tools',
    'metadata',
    'max_tokens',
    'thinking',
    'output_config',
    'stream',
  ])
  assert.equal(wire.body.kin_outbound_shape, undefined)
  assert.equal(wire.headers['user-agent'], 'claude-cli/2.1.303 (external, cli)')
  assert.equal(wire.headers.accept, 'application/json')
  assert.equal(wire.headers['accept-encoding'], 'gzip, deflate, br, zstd')
  assert.equal(wire.headers['x-stainless-timeout'], '600')
  const logged = h.logs.at(-1)
  assert.equal(logged.outbound_headers_source, 'cli_final')
  assert.doesNotMatch(JSON.stringify(logged.outbound_headers), /local-fixture-key/)
  assert.ok(logged.worker_envelope_headers)
  for (const [key, value] of Object.entries(logged.outbound_headers)) {
    if (value === '***REDACTED***') continue
    assert.equal(value, wire.headers[key], key)
  }
  for (const key of ['accept', 'accept-encoding', 'content-length', 'user-agent', 'anthropic-beta']) {
    assert.equal(logged.outbound_headers[key], wire.headers[key], key)
  }
  assert.match(
    billingOf(wire),
    /^x-anthropic-billing-header: cc_version=2\.1\.303\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5}; cc_prompt_id=/,
  )
  assert.equal(wire.raw.includes('/home/caller/'), false)
  assert.equal(wire.body.messages[1].content.endsWith(AFTER_ENV), true)
  assert.deepEqual(
    wire.body.system.map((block) => block.cache_control),
    [undefined, { type: 'ephemeral' }, { type: 'ephemeral' }],
  )
  assertCch(wire)
  assert.deepEqual(h.logs.at(-1).outbound_profile, { cli_version: '2.1.303', shape: 'lean' })
})

test('official_303 lean: non-official caller and a second turn keep the cached prefix bytes', {
  skip,
  timeout: 60000,
}, async (t) => {
  const h = await harness(t, { cacheTtl: '1h' })
  const bot = {
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    stream: true,
    system: [{ type: 'text', text: 'You are a helpful bot.' }],
    messages: [{ role: 'user', content: 'q1' }],
  }
  const first = await h.send(bot, 'my-bot/1.0')
  assert.deepEqual(checkOfficial303Rules(first.body), [])
  assert.equal(
    first.body.messages[0].content[0].text,
    '<system-reminder>\nYou are a helpful bot.\n</system-reminder>\n',
  )
  assert.deepEqual(first.body.system[1].cache_control, { type: 'ephemeral', ttl: '1h' })
  const second = await h.send(
    {
      ...bot,
      messages: [
        ...bot.messages,
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: 'q2' },
      ],
    },
    'my-bot/1.0',
  )
  assert.deepEqual(checkOfficial303Rules(second.body), [])
  const strip = (value) => JSON.stringify(value, (key, inner) => (key === 'cache_control' ? undefined : inner))
  // cache_read covers system + the first turn only if these bytes match on the wire.
  assert.equal(
    strip(second.body.system.map((b) => (b.text.startsWith('x-anthropic') ? null : b))),
    strip(first.body.system.map((b) => (b.text.startsWith('x-anthropic') ? null : b))),
  )
  // This harness has no sticky binding, so each attempt mints a new outbound session (cc_prompt_id).
  // Production reuses it on the same VM; the real-account two-turn check covers that.
  const stable = (wire) =>
    billingOf(wire)
      .replace(/cch=[0-9a-f]{5}/, '')
      .replace(/cc_prompt_id=[0-9a-f-]{36}/, '')
  assert.equal(stable(second), stable(first))
  assert.equal(strip(second.body.messages[0]), strip(first.body.messages[0]))
  assert.equal(strip(second.body.tools), strip(first.body.tools))
})

test('official_303 full-prompt model keeps the existing body at 2.1.303; hot switch back to 296', {
  skip,
  timeout: 60000,
}, async (t) => {
  const h = await harness(t)
  const sonnet = await h.send(officialRequest('claude-sonnet-5-5'), OFFICIAL_UA)
  assert.match(sonnet.headers['user-agent'], /^claude-cli\/2\.1\.303 /)
  assert.match(billingOf(sonnet), /cc_version=2\.1\.303\./)
  assert.equal(sonnet.body.system.length, 3)
  assert.equal(sonnet.body.kin_outbound_shape, undefined)
  const pidBefore = JSON.parse(await h.health()).pid ?? null
  h.switchPreset('official_full')
  const back = await h.send(officialRequest(), OFFICIAL_UA)
  assert.match(back.headers['user-agent'], /^claude-cli\/2\.1\.296 /)
  assert.match(billingOf(back), /cc_version=2\.1\.296\./)
  assert.equal(back.body.messages.at(-1).role, 'system')
  assert.equal(back.body.system[1].text, OFFICIAL_303_IDENTITY)
  assert.equal(JSON.parse(await h.health()).pid ?? null, pidBefore)
})

for (const caller of ['official', 'bot'])
  test(`296 presets: profile cli-node sends the same bytes as the baseline (${caller})`, {
    skip: skip || !baseCli || !fs.existsSync(baseCli),
    timeout: 90000,
  }, async (t) => {
    const request =
      caller === 'official'
        ? [officialRequest(), OFFICIAL_UA]
        : [
            {
              model: 'claude-opus-5-5',
              max_tokens: 1024,
              stream: true,
              system: [{ type: 'text', text: 'You are a helpful bot.' }],
              messages: [{ role: 'user', content: 'q1' }],
            },
            'my-bot/1.0',
          ]
    for (const preset of ['official', 'official_full', 'zero']) {
      const base = await (await harness(t, { preset, cli: baseCli })).send(...request)
      const next = await (await harness(t, { preset })).send(...request)
      const neutral = (wire) =>
        JSON.stringify({
          ...wire.body,
          metadata: null,
          // cc_prompt_id follows each attempt's outbound session; CCH follows the body.
          system: wire.body.system.map((block) => ({
            ...block,
            text: block.text
              .replace(/cch=[0-9a-f]{5}/, 'cch=X')
              .replace(/cc_prompt_id=[0-9a-f-]{36}/, 'cc_prompt_id=X'),
          })),
        })
      assert.equal(neutral(next), neutral(base), preset)
      assert.equal(
        next.headers['user-agent'],
        base.headers['user-agent'].replace('(external, sdk-cli)', '(external, cli)'),
      )
    }
  })
