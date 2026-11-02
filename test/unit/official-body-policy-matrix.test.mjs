/**
 * REQ-CLEANUP-01 C-02/C-03: matrix locks official traffic × passthrough × backend
 * persona/cache/billing behavior before consolidating handle-protocol predicates.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  applyCrsUnofficialPersona,
  CRS_OFFICIAL_SYSTEM,
  officialCcPassthroughFromRouting,
} from '../../src/lib/identity/crs-persona.mjs'
import { personaHideForUnofficial } from '../../src/lib/identity/crs-persona-usage.mjs'
import { OFFICIAL_303_HARNESS } from '../../src/lib/identity/official-profiles.mjs'
import { OFFICIAL_CLI_VERSION } from '../../src/lib/identity/vm-identity.mjs'
import { officialMessagesBody } from '../../src/lib/protocol/anthropic-messages.mjs'
import { listCacheMarkers, validateCacheBreakpoints } from '../../src/lib/protocol/cache-ttl.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import {
  personaHidesUsageFromRoutingFile,
  personaModeFromRoutingFile,
  standingUsageFromRoutingFile,
} from '../../src/lib/identity/crs-persona.mjs'

const OFFICIAL_HEADERS = { 'user-agent': 'claude-cli/2.1.293 (external, cli)' }
const CACHE_1H = { type: 'ephemeral', ttl: '1h' }

function withRouting(compatibility, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'official-body-policy-'))
  const routingFile = path.join(dir, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility }))
  try {
    fn(routingFile)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function officialInbound({ cacheOnSystem = true } = {}) {
  const systemBlock = {
    type: 'text',
    text: `x-anthropic-billing-header: cc_version=2.1.280.096; cc_entrypoint=cli; cch=matrix;\n${CRS_OFFICIAL_SYSTEM}`,
  }
  if (cacheOnSystem) systemBlock.cache_control = structuredClone(CACHE_1H)
  return {
    model: 'claude-opus-5-5',
    max_tokens: 64,
    system: [systemBlock],
    messages: [{ role: 'user', content: 'matrix-user-turn' }],
    metadata: {
      user_id: JSON.stringify({ device_id: 'dev-m', account_uuid: 'acc-m', session_id: 'sess-m' }),
    },
  }
}

function unofficialInbound() {
  return {
    model: 'claude-opus-5-5',
    max_tokens: 64,
    system: 'caller-only-system',
    messages: [{ role: 'user', content: 'matrix-unofficial' }],
  }
}

function systemSignature(body) {
  return JSON.stringify(body?.system ?? null)
}

function personaTemplateApplied(body) {
  const texts = (Array.isArray(body.system) ? body.system : []).map((b) => String(b?.text || ''))
  return texts.some((t) => t === OFFICIAL_303_HARNESS || t.includes('prompt_version='))
}

/** Mirrors handle-protocol.mjs L955 + L1094–1136 + slot branches (pre-refactor). */
function legacyOfficialBodyPipeline({
  backend,
  officialTraffic,
  passthrough,
  requestContext = null,
  personaIn,
  routingFile,
  headers = {},
  modeOverride = false,
  cacheTtl = '1h',
}) {
  const routing = JSON.parse(fs.readFileSync(routingFile, 'utf8'))
  const personaMode = personaModeFromRoutingFile(routingFile)
  const officialPassthrough = officialTraffic && officialCcPassthroughFromRouting(routing)
  const shouldValidateCacheBreakpoints =
    !requestContext && officialTraffic && officialCcPassthroughFromRouting(routing)

  let body = structuredClone(personaIn)
  const inboundSnapshot = structuredClone(personaIn)

  if (!requestContext) {
    body = applyCrsUnofficialPersona(body, {
      officialClient: officialTraffic,
      routingFile,
      cacheTtl,
      headers,
      sessionId: 'matrix-session',
      model: body?.model,
      cliVersion: OFFICIAL_CLI_VERSION,
    })
  }
  let personaHideTokens = requestContext
    ? 0
    : personaHideForUnofficial(inboundSnapshot, body, {
        officialClient: officialTraffic,
        mode: personaMode,
        hides: personaHidesUsageFromRoutingFile(routingFile),
        standing: standingUsageFromRoutingFile(routingFile),
      })

  const prePersonaBody = structuredClone(body)
  let apiSecondPass = false

  if (
    backend === 'api' &&
    !requestContext &&
    officialTraffic &&
    !officialCcPassthroughFromRouting(routing)
  ) {
    apiSecondPass = true
    body = applyCrsUnofficialPersona(body, {
      officialClient: false,
      forceConfigured: true,
      routingFile,
      cacheTtl,
      headers,
      sessionId: 'matrix-session',
      model: body?.model,
      cliVersion: OFFICIAL_CLI_VERSION,
    })
    personaHideTokens = personaHideForUnofficial(inboundSnapshot, body, {
      officialClient: false,
      mode: personaMode,
      hides: personaHidesUsageFromRoutingFile(routingFile),
      standing: standingUsageFromRoutingFile(routingFile),
    })
  }

  let slotPersonaPass = false
  let cliHopPersonaPass = false
  let hopBody = body

  if (backend === 'cli-hop') {
    hopBody = body
    if (!requestContext && !officialTraffic) {
      cliHopPersonaPass = true
      hopBody = applyCrsUnofficialPersona(structuredClone(personaIn), {
        forceConfigured: true,
        routingFile,
        cacheTtl,
        mode: 'official',
        sessionId: 'matrix-session',
        model: hopBody?.model,
        cliVersion: OFFICIAL_CLI_VERSION,
      })
    }
    hopBody = prepareCliHopBody(hopBody, {
      cacheTtl,
      stream: true,
      requestContext,
      personaPreset: !requestContext && !officialTraffic ? 'official' : null,
    })
    if (officialTraffic) personaHideTokens = 0
  } else if (backend === 'slot-http') {
    hopBody = body
    if (!requestContext && !officialPassthrough && (modeOverride || officialTraffic)) {
      slotPersonaPass = true
      const configuredMode = modeOverride || 'official'
      const rewritten = applyCrsUnofficialPersona(structuredClone(personaIn), {
        officialClient: false,
        forceConfigured: true,
        routingFile,
        cacheTtl,
        mode: configuredMode,
        sessionId: 'matrix-session',
        model: personaIn?.model,
        cliVersion: OFFICIAL_CLI_VERSION,
      })
      hopBody = officialMessagesBody(rewritten)
      personaHideTokens = personaHideForUnofficial(inboundSnapshot, rewritten, {
        officialClient: false,
        mode: configuredMode,
        hides: personaHidesUsageFromRoutingFile(routingFile, configuredMode),
        standing: standingUsageFromRoutingFile(routingFile, configuredMode),
      })
    }
  }

  const outbound = backend === 'api' ? body : hopBody

  return {
    shouldValidateCacheBreakpoints,
    officialPassthrough,
    prePersonaChanged: systemSignature(prePersonaBody) !== systemSignature(personaIn),
    apiSecondPass,
    slotPersonaPass,
    cliHopPersonaPass,
    personaHideTokens,
    outbound,
    personaTemplateApplied: personaTemplateApplied(outbound),
    inboundSnapshot,
  }
}

const MATRIX = []
for (const backend of ['api', 'slot-http', 'cli-hop']) {
  for (const passthrough of [true, false]) {
    for (const officialTraffic of [true, false]) {
      MATRIX.push({ backend, passthrough, officialTraffic, modeOverride: false })
    }
  }
}
MATRIX.push({ backend: 'slot-http', passthrough: true, officialTraffic: false, modeOverride: true })

for (const row of MATRIX) {
  const label = `${row.backend} official=${row.officialTraffic} passthrough=${row.passthrough}${
    row.modeOverride ? ' modeOverride' : ''
  }`
  test(`official body policy matrix: ${label}`, () => {
    withRouting(
      {
        persona_preset: 'official',
        overlay_preset: 'off',
        cache_ttl: '1h',
        official_cc_passthrough: row.passthrough,
      },
      (routingFile) => {
        const inbound = row.officialTraffic ? officialInbound() : unofficialInbound()
        const headers = row.officialTraffic ? OFFICIAL_HEADERS : {}
        const result = legacyOfficialBodyPipeline({
          backend: row.backend,
          officialTraffic: row.officialTraffic,
          passthrough: row.passthrough,
          personaIn: inbound,
          routingFile,
          headers,
          modeOverride: row.modeOverride,
          cacheTtl: '1h',
        })

        assert.equal(
          result.shouldValidateCacheBreakpoints,
          !row.officialTraffic ? false : row.passthrough,
          'cache breakpoint gate',
        )
        if (result.shouldValidateCacheBreakpoints) validateCacheBreakpoints(structuredClone(inbound))

        if (row.officialTraffic && row.passthrough) {
          assert.equal(result.prePersonaChanged, false, 'pre-persona keeps official inbound')
          assert.equal(result.apiSecondPass, false)
          assert.equal(result.personaHideTokens, 0, 'billing hide off for passthrough official')
        }

        if (row.officialTraffic && !row.passthrough) {
          assert.equal(result.prePersonaChanged, false, 'first pass still short-circuits on officialClient')
          if (row.backend === 'api') {
            assert.equal(result.apiSecondPass, true)
            assert.equal(result.personaTemplateApplied, true)
            assert.equal(result.personaHideTokens, 0, 'current api force rewrite leaves personaHideTokens at 0')
          }
          if (row.backend === 'cli-hop') {
            assert.equal(result.cliHopPersonaPass, false, 'cli-hop ignores passthrough switch')
            assert.equal(result.personaTemplateApplied, false, 'official cli-hop keeps inbound shape')
            const markers = listCacheMarkers(result.outbound)
            assert.ok(
              markers.some((m) => m.ttl === '1h'),
              '1h caller cache marker survives cli-hop without persona rewrite',
            )
          }
          if (row.backend === 'slot-http') {
            assert.equal(result.slotPersonaPass, true)
            assert.equal(result.personaTemplateApplied, true)
          }
        }

        if (!row.officialTraffic) {
          assert.equal(result.prePersonaChanged, true, 'unofficial always gets pre-persona')
          assert.equal(result.apiSecondPass, false)
          if (row.backend === 'cli-hop') {
            assert.equal(result.cliHopPersonaPass, true)
            assert.equal(result.personaTemplateApplied, true)
            assert.ok(listCacheMarkers(result.outbound).every((m) => m.ttl === '1h'))
          }
          if (row.backend === 'slot-http') {
            const expectSlot = row.modeOverride || row.officialTraffic
            assert.equal(result.slotPersonaPass, expectSlot)
          }
        }
      },
    )
  })
}

test('legacy pipeline: api official passthrough off applies persona once at backend (C-03)', () => {
  withRouting(
    { persona_preset: 'official', overlay_preset: 'off', cache_ttl: '1h', official_cc_passthrough: false },
    (routingFile) => {
      const inbound = officialInbound()
      const result = legacyOfficialBodyPipeline({
        backend: 'api',
        officialTraffic: true,
        passthrough: false,
        personaIn: inbound,
        routingFile,
        headers: OFFICIAL_HEADERS,
      })
      assert.equal(result.apiSecondPass, true)
      assert.equal(result.prePersonaChanged, false)
      assert.notEqual(systemSignature(inbound), systemSignature(result.outbound))
    },
  )
})
