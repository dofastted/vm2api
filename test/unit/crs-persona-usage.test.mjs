import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyCrsUnofficialPersona,
  CRS_AGENT_EXPANSION,
  CRS_OFFICIAL_SYSTEM,
  CRS_STANDING_CONSTRAINT,
  isOfficialClaudeCodeTraffic,
  personaHidesUsageFromRoutingFile,
  standingUsageFromRoutingFile,
} from '../../src/lib/identity/crs-persona.mjs'
import { DEFAULT_AGENT_STANDING } from '../../src/lib/identity/persona-template.mjs'
import {
  callerUsageBaseline,
  estimateClaudeInputTokens,
  hidePersonaUsage,
  hidePersonaUsageInSseLine,
  hidePersonaUsageOnMessage,
  injectedOverlayText,
  injectedToolsHideTokens,
  injectedToolsPayload,
  personaHideBreakdown,
  personaHideForCliZero,
  SERVER_TOOL_INPUT_TOKENS,
  personaHideForUnofficial,
  personaHideInputTokens,
  zeroCliLayoutHideTokens,
} from '../../src/lib/identity/crs-persona-usage.mjs'
const helloBody = { messages: [{ role: 'user', content: 'hello' }] }
const helloWithTools = {
  messages: helloBody.messages,
  tools: [{ name: 'web_search', type: 'web_search_20250305' }],
}

test('rewrite 4-block hide matches no-system remainder and keeps cache billing', () => {
  const after = applyCrsUnofficialPersona(helloWithTools, { mode: 'rewrite' })
  const hide = personaHideInputTokens(helloWithTools, after)
  assert.ok(!after.system[3].text.includes('# auto memory'))
  assert.ok(hide.official > 80, `hide=${hide}`)
  assert.ok(hide.official < 500, `hide=${hide}`)
  assert.equal(hide.wipeCache, false)
  assert.ok(hide.uncached > 0)
  assert.equal(hide.tools, 0)
  const userKeep = 8
  const hidden = hidePersonaUsage(
    {
      input_tokens: hide.uncached + (hide.overlay || 0) + userKeep,
      cache_creation_input_tokens: 9078,
      cache_creation: { ephemeral_1h_input_tokens: 9078 },
      output_tokens: 8,
      total_tokens: hide.uncached + (hide.overlay || 0) + userKeep + 9078 + 8,
    },
    hide,
  )
  assert.equal(hidden.input_tokens, userKeep)
  assert.equal(hidden.cache_creation_input_tokens, 9078)
  assert.equal(hidden.cache_creation.ephemeral_1h_input_tokens, 9078)
  assert.equal(hidden.output_tokens, 8)
  assert.equal(hidden.total_tokens, userKeep + 8)
})

function hideFor(compat, inbound) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-standing-hide-'))
  const routingFile = path.join(dir, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { overlay_preset: 'off', ...compat } }))
  try {
    const after = applyCrsUnofficialPersona(structuredClone(inbound), { routingFile })
    return personaHideForUnofficial(inbound, after, {
      hides: personaHidesUsageFromRoutingFile(routingFile),
      standing: standingUsageFromRoutingFile(routingFile),
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('standing mask is its own switch, independent of template hide flags', () => {
  const standingTokens = estimateClaudeInputTokens(DEFAULT_AGENT_STANDING)
  const official = hideFor({ persona_preset: 'official', agent_standing_presets: { official: true } }, helloBody)
  assert.equal(Number(official), standingTokens)
  assert.equal(official.overlay, standingTokens)

  const missing = hideFor({ persona_preset: 'official' }, helloBody)
  assert.equal(Number(missing), 0)

  const shown = hideFor(
    {
      persona_preset: 'official',
      agent_standing_presets: { official: true },
      agent_standing_hide_presets: { official: false },
    },
    helloBody,
  )
  assert.equal(Number(shown), 0)

  const full = hideFor({ persona_preset: 'official_full', agent_standing_presets: { official_full: true } }, helloBody)
  assert.equal(full.overlay, standingTokens)
  assert.equal(full.official, 0)

  const zeroMasked = hideFor({ persona_preset: 'zero', agent_standing_presets: { zero: true } }, helloBody)
  const zeroShown = hideFor(
    { persona_preset: 'zero', agent_standing_presets: { zero: true }, agent_standing_hide_presets: { zero: false } },
    helloBody,
  )
  assert.equal(zeroMasked.overlay, standingTokens)
  assert.equal(zeroShown.overlay, 0)
  assert.equal(zeroShown.official, zeroMasked.official)
})

test('official client same-object skip hides nothing', () => {
  const body = {
    system: [{ type: 'text', text: CRS_OFFICIAL_SYSTEM }],
    messages: [{ role: 'user', content: 'hello' }],
  }
  const after = applyCrsUnofficialPersona(body, { officialClient: true })
  assert.equal(after, body)
  assert.equal(personaHideInputTokens(body, after), 0)
})

test('official Claude Code traffic hides nothing and keeps inbound system', () => {
  const body = {
    system: CRS_OFFICIAL_SYSTEM,
    messages: [{ role: 'user', content: 'hello' }],
    metadata: { user_id: JSON.stringify({ device_id: 'dev-1', account_uuid: 'acc-1', session_id: 'sess-1' }) },
  }
  const headers = { 'user-agent': 'claude-cli/2.1.241 (external, cli)' }
  assert.equal(isOfficialClaudeCodeTraffic(headers, body), true)
  const after = applyCrsUnofficialPersona(body, { headers, mode: 'rewrite', park: true })
  assert.equal(after.system, body.system)
  assert.equal(personaHideForUnofficial(body, after, { officialClient: true }), 0)
})

test('none mode hides nothing', () => {
  const before = { system: 'keep me', messages: helloBody.messages }
  const after = applyCrsUnofficialPersona(before, { mode: 'none' })
  assert.equal(personaHideInputTokens(before, after), 0)
})

test('official_prompt does not start usage hide, even with standing and env', () => {
  const before = { messages: helloBody.messages }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-official-standing-'))
  const routingFile = path.join(dir, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { agent_standing_presets: { official: true } } }))
  try {
    const after = applyCrsUnofficialPersona(before, { mode: 'official_prompt', routingFile })
    assert.equal(personaHideForUnofficial(before, after, { mode: 'official_prompt' }), 0)
    assert.ok(after.system.some((b) => String(b?.text || '').startsWith(`${DEFAULT_AGENT_STANDING}\n`)))
    assert.ok(after.system.some((b) => String(b?.text || '').startsWith('# Environment')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('zero inject hides billing and env, not leftover', () => {
  const before = { system: '你是一个高速收费员。', messages: helloBody.messages }
  const after = applyCrsUnofficialPersona(before, { mode: 'zero', identity: { timezone: 'Asia/Tokyo' } })
  const hide = personaHideInputTokens(before, after)
  const billing = String(after.system[0].text || '')
  assert.ok(billing.startsWith('x-anthropic-billing-header:'))
  assert.match(billing, /prompt_version=<You are Claude Code, Anthropic's official CLI for Claude\.>/)
  assert.equal(after.system.length, 5)
  assert.equal(after.system[1].text, '\u200b')
  assert.equal(after.system[2].text, '\u200b')
  assert.equal(after.system[3].text, '# Environment\n - Timezone: Asia/Tokyo')
  assert.equal(after.system[4].text, '你是一个高速收费员。')
  const noEnv = structuredClone(after)
  noEnv.system.splice(3, 1)
  assert.ok(hide.official > personaHideInputTokens(before, noEnv).official)
  assert.equal(Number(hide), hide.official + hide.overlay)
  assert.equal(injectedOverlayText(before, after), '')
  assert.ok(!injectedOverlayText(before, after).includes('高速收费员'))
})

test('cli-hop zero hides billing+env so 04 usage matches Portunex remainder', () => {
  const inbound = {
    messages: [{ role: 'user', content: '你好！你是什么身份、什么模型？具体运行环境及版本？' }],
  }
  const hide = personaHideForCliZero(inbound, inbound, { timezone: 'America/New_York' })
  assert.equal(Number(hide), zeroCliLayoutHideTokens({ timezone: 'America/New_York' }))
  assert.equal(Number(hide), 18)
  assert.equal(hide.overlay || 0, 0)
  assert.equal(hide.tools, 0)
  const hidden = hidePersonaUsage({ input_tokens: 49, output_tokens: 8, total_tokens: 57 }, hide)
  assert.equal(hidden.input_tokens, 31)
  assert.equal(personaHideForCliZero(inbound, inbound, { officialClient: true }), 0)
  // Panel mask off for zero: CLI billing + env count as client usage.
  assert.equal(Number(personaHideForCliZero(inbound, inbound, { timezone: 'America/New_York', hides: false })), 0)
})

test('cli-hop zero also hides the standing Node put in the leftover', () => {
  const before = { system: '你是一个高速收费员。', messages: helloBody.messages }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cli-zero-standing-'))
  const routingFile = path.join(dir, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { agent_standing_presets: { zero: true } } }))
  try {
    const after = applyCrsUnofficialPersona(before, { mode: 'zero', routingFile })
    const node = personaHideInputTokens(before, after)
    assert.equal(node.overlay, estimateClaudeInputTokens(DEFAULT_AGENT_STANDING))
    const hide = personaHideForCliZero(before, after, { timezone: 'America/New_York', overlay: node.overlay })
    assert.equal(hide.overlay, node.overlay)
    assert.equal(Number(hide), zeroCliLayoutHideTokens({ timezone: 'America/New_York' }) + node.overlay)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('append only hides the official one-liner', () => {
  const before = { system: 'You are in Xcode.', messages: helloBody.messages }
  const after = applyCrsUnofficialPersona(before, { mode: 'append' })
  const hide = personaHideInputTokens(before, after)
  assert.equal(Number(hide), estimateClaudeInputTokens(CRS_OFFICIAL_SYSTEM))
  assert.equal(hide.overlay || 0, 0)
  assert.ok(Number(hide) < 80)
})

test('official cache_read stays on the client usage', () => {
  const hidden = hidePersonaUsage(
    {
      input_tokens: 20,
      cache_read_input_tokens: 534,
      cache_creation_input_tokens: 0,
      output_tokens: 11,
      total_tokens: 31,
    },
    556,
  )
  assert.equal(hidden.cache_read_input_tokens, 534)
  assert.equal(hidden.input_tokens, 0)
  assert.equal(hidden.output_tokens, 11)
  assert.equal(hidden.total_tokens, 11)
})

test('official cache_creation 5m/1h stays on the client usage', () => {
  const hidden = hidePersonaUsage(
    {
      input_tokens: 54,
      cache_creation_input_tokens: 500,
      cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 },
      output_tokens: 7,
      total_tokens: 61,
    },
    556,
  )
  assert.equal(hidden.cache_creation_input_tokens, 500)
  assert.equal(hidden.cache_creation.ephemeral_5m_input_tokens, 200)
  assert.equal(hidden.cache_creation.ephemeral_1h_input_tokens, 300)
  assert.equal(hidden.input_tokens, 0)
  assert.equal(hidden.cache_read_input_tokens, undefined)
})

test('long caller input keeps remainder after official vanish', () => {
  const hidden = hidePersonaUsage(
    {
      input_tokens: 2000,
      cache_read_input_tokens: 534,
      output_tokens: 40,
      total_tokens: 2040,
    },
    556,
  )
  assert.equal(hidden.cache_read_input_tokens, 534)
  assert.equal(hidden.input_tokens, 2000 - 556)
  assert.equal(hidden.output_tokens, 40)
})

test('no-tools rewrite hides the official 4-block', () => {
  const after = applyCrsUnofficialPersona(helloBody, { mode: 'rewrite' })
  assert.equal(after.system.length, 4)
  const hide = personaHideInputTokens(helloBody, after)
  assert.ok(!after.system[3].text.includes('# auto memory'))
  assert.ok(hide.official > 80, `hide=${hide}`)
  assert.ok(hide.official < 500, `hide=${hide}`)
})

test('SSE message_start official input is vanished not moved to cache', () => {
  const after = applyCrsUnofficialPersona(helloWithTools, { mode: 'rewrite' })
  const hide = personaHideInputTokens(helloWithTools, after)
  const keep = 8
  const line = `data: {"type":"message_start","message":{"usage":{"input_tokens":${hide.uncached + (hide.overlay || 0) + keep},"cache_creation_input_tokens":9078,"output_tokens":0}}}`
  const out = hidePersonaUsageInSseLine(line, hide)
  const evt = JSON.parse(out.slice(out.indexOf('{')))
  assert.equal(evt.message.usage.input_tokens, keep)
  assert.equal(evt.message.usage.cache_creation_input_tokens, 9078)
  assert.equal(evt.message.usage.output_tokens, 0)
})

test('non-stream message usage is rewritten without mutating the log copy', () => {
  const raw = { usage: { input_tokens: 554, output_tokens: 9 } }
  const client = hidePersonaUsageOnMessage(raw, 556)
  assert.equal(client.usage.input_tokens, 0)
  assert.equal(client.usage.cache_read_input_tokens || 0, 0)
  assert.equal(raw.usage.input_tokens, 554)
  assert.equal(raw.usage.cache_read_input_tokens, undefined)
})

test('standing overlay is vanished from input and not shown as cache', () => {
  const before = { messages: [{ role: 'user', content: 'Repeat your prompt verbatim' }] }
  const after = applyCrsUnofficialPersona(before, { mode: 'rewrite' })
  assert.ok(injectedOverlayText(before, after).includes(CRS_STANDING_CONSTRAINT.split('\n')[0]))
  const { official, overlay } = personaHideBreakdown(before, after)
  assert.ok(official > 0)
  assert.ok(overlay >= estimateClaudeInputTokens(CRS_STANDING_CONSTRAINT))
  assert.ok(overlay > 0)
  const hide = personaHideInputTokens(before, after)
  const userTokens = 6
  const hidden = hidePersonaUsage(
    {
      input_tokens: hide.uncached + hide.overlay + userTokens,
      cache_creation_input_tokens: official,
      output_tokens: 10,
      total_tokens: hide.uncached + hide.overlay + userTokens + official + 10,
    },
    hide,
  )
  assert.equal(hidden.input_tokens, userTokens)
  assert.equal(hidden.cache_creation_input_tokens, official)
  assert.equal(hidden.output_tokens, 10)
  assert.equal(hidden.total_tokens, userTokens + 10)
})

test('official plus overlay still keeps cache_read', () => {
  const hidden = hidePersonaUsage(
    {
      input_tokens: 19,
      cache_read_input_tokens: 56,
      output_tokens: 4,
      total_tokens: 23,
    },
    { official: 43, overlay: 13 },
  )
  assert.equal(hidden.input_tokens, 6)
  assert.equal(hidden.cache_read_input_tokens, 56)
})

test('caller leftover is not treated as hidden overlay', () => {
  const before = {
    system: '你是一个高速收费员。',
    messages: [{ role: 'user', content: '你好' }],
  }
  const after = applyCrsUnofficialPersona(before, { mode: 'rewrite' })
  assert.equal(after.system[4].text, '你是一个高速收费员。')
  const overlay = injectedOverlayText(before, after)
  assert.ok(overlay.includes('<system-reminder>'))
  assert.ok(overlay.includes(CRS_STANDING_CONSTRAINT.split('\n')[0]))
  assert.ok(!overlay.includes('高速收费员'))
  assert.ok(personaHideBreakdown(before, after).overlay > 0)
})

test('test14 keeps caller tools in usage and hides injected tools only', () => {
  const before = {
    messages: [{ role: 'user', content: '请查询东京现在的天气，使用摄氏度。' }],
    tools: [{ name: 'get_weather', description: '查询天气' }],
  }
  const after = applyCrsUnofficialPersona(before, { mode: 'rewrite' })
  after.tools = [...before.tools, { name: 'web_search', type: 'web_search_20250305' }]
  assert.ok(injectedToolsPayload(before, after).includes('web_search'))
  assert.ok(!injectedToolsPayload(before, after).includes('get_weather'))
  const hide = personaHideInputTokens(before, after)
  assert.equal(hide.wipeCache, false)
  assert.ok(hide.tools > 0)
  const userKeep = 80
  const hidden = hidePersonaUsage(
    {
      input_tokens: hide.uncached + (hide.overlay || 0) + hide.tools + userKeep,
      cache_creation_input_tokens: 9078,
      output_tokens: 20,
      total_tokens: hide.uncached + (hide.overlay || 0) + hide.tools + userKeep + 9078 + 20,
    },
    hide,
  )
  assert.equal(hidden.input_tokens, userKeep)
  assert.equal(hidden.cache_creation_input_tokens, 9078)
})

test('injected web_search hides its upstream schema, not the wire stub', () => {
  const searchTool = { type: 'web_search_20250305', name: 'web_search' }
  const before = { messages: [{ role: 'user', content: '搜索2026年发布的iPhone有什么新功能' }] }
  const after = { ...before, tools: [searchTool] }
  const stub = estimateClaudeInputTokens(JSON.stringify([searchTool]))
  const billed = SERVER_TOOL_INPUT_TOKENS.web_search_20250305
  assert.ok(billed > stub * 100)
  assert.equal(injectedToolsHideTokens(before, after), billed)
  // vm-05 zero baseline: 2837 with the tool armed, 43 for the same shape without.
  const hidden = hidePersonaUsage({ input_tokens: 2837, output_tokens: 5 }, { tools: billed })
  assert.ok(hidden.input_tokens <= 43)
})

test('caller-declared web_search stays visible in client usage', () => {
  const searchTool = { type: 'web_search_20250305', name: 'web_search' }
  const before = { messages: [{ role: 'user', content: '搜索一下' }], tools: [searchTool] }
  const after = { ...before, tools: [searchTool] }
  assert.equal(injectedToolsHideTokens(before, after), 0)
  assert.equal(injectedToolsPayload(before, after), '')
})

test('injected web_search is hidden even when persona usage hiding is off', () => {
  const before = { messages: [{ role: 'user', content: '搜索一下勾股定理' }] }
  const after = {
    ...before,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  }
  const billed = SERVER_TOOL_INPUT_TOKENS.web_search_20250305
  for (const opts of [{ hides: false }, { mode: 'official_prompt' }]) {
    const hide = personaHideForUnofficial(before, after, opts)
    assert.equal(hide.official, 0)
    assert.equal(hide.overlay, 0)
    assert.equal(hide.tools, billed)
    assert.equal(hidePersonaUsage({ input_tokens: 2839, output_tokens: 9 }, hide).input_tokens, 45)
  }
  // No injected tool means nothing to hide in those modes.
  assert.equal(personaHideForUnofficial(before, { ...before }, { hides: false }), 0)
  assert.equal(personaHideForUnofficial(before, { ...before }, { mode: 'official_prompt' }), 0)
})

test('injected non-server tools still fall back to the length estimate', () => {
  const before = { messages: [{ role: 'user', content: 'hi' }] }
  const extra = { name: 'kin_helper', description: 'x'.repeat(60) }
  const after = { ...before, tools: [extra] }
  assert.equal(injectedToolsHideTokens(before, after), estimateClaudeInputTokens(JSON.stringify([extra])))
})

test('unofficial hide covers official 4-block and keeps caller --system leftover', () => {
  const inbound = {
    system: 'you are a linter',
    messages: [{ role: 'user', content: '请查询东京现在的天气，使用摄氏度。' }],
    tools: [{ name: 'get_weather' }],
    tool_choice: { type: 'tool', name: 'get_weather' },
  }
  const after = applyCrsUnofficialPersona(inbound, { mode: 'rewrite' })
  assert.equal(after.system.length, 5)
  assert.equal(after.system[4].text, 'you are a linter')
  const baseline = callerUsageBaseline(inbound)
  assert.equal(baseline.system, inbound.system)
  assert.deepEqual(baseline.tools, inbound.tools)
  const hide = personaHideForUnofficial(inbound, after)
  assert.equal(hide.wipeCache, false)
  assert.ok(!after.system[3].text.includes('# auto memory'))
  assert.ok(hide.official > 80)
  assert.ok(hide.official < 500)
  assert.ok(hide.overlay > 0)
  assert.equal(hide.tools, 0)
  assert.equal(personaHideForUnofficial(inbound, after, { officialClient: true }), 0)
  const leftoverKeep = 8
  const userKeep = 80
  const hidden = hidePersonaUsage(
    {
      input_tokens: hide.uncached + hide.overlay + leftoverKeep + userKeep,
      cache_creation_input_tokens: 9078,
      output_tokens: 20,
      total_tokens: hide.uncached + hide.overlay + leftoverKeep + userKeep + 9078 + 20,
    },
    hide,
  )
  assert.equal(hidden.input_tokens, leftoverKeep + userKeep)
  assert.equal(hidden.cache_creation_input_tokens, 9078)
})

test('no-tools no-system hide leaves only the caller prompt', () => {
  const after = applyCrsUnofficialPersona(helloBody, { mode: 'rewrite' })
  const hide = personaHideInputTokens(helloBody, after)
  assert.equal(hide.tools, 0)
  assert.ok(hide.overlay > 0)
  const hidden = hidePersonaUsage(
    {
      input_tokens: hide.uncached + hide.overlay + 3,
      cache_creation_input_tokens: 9078,
      output_tokens: 5,
      total_tokens: hide.uncached + hide.overlay + 3 + 9078 + 5,
    },
    hide,
  )
  assert.equal(hidden.input_tokens, 3)
  assert.equal(hidden.cache_creation_input_tokens, 9078)
})

test('unofficial hide keeps cache_read and 5m/1h cache_creation', () => {
  const after = applyCrsUnofficialPersona(helloBody, { mode: 'rewrite' })
  const hide = personaHideForUnofficial(helloBody, after)
  assert.equal(hide.wipeCache, false)
  const hidden = hidePersonaUsage(
    {
      input_tokens: hide.uncached + hide.overlay + 4,
      cache_read_input_tokens: 120,
      cache_creation_input_tokens: 80,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 50 },
      output_tokens: 6,
    },
    hide,
  )
  assert.equal(hidden.input_tokens, 4)
  assert.equal(hidden.cache_read_input_tokens, 120)
  assert.equal(hidden.cache_creation_input_tokens, 80)
  assert.equal(hidden.cache_creation.ephemeral_5m_input_tokens, 30)
  assert.equal(hidden.cache_creation.ephemeral_1h_input_tokens, 50)
})
