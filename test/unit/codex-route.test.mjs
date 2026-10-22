import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computedUpstreamTransport,
  inferenceWebsocketEnabled,
  isCodexProtocolAllowed,
  isCodexVm,
  listCodexVms,
  normalizeCodexRouting,
  validateInferenceWebsocketPatch,
} from '../../src/lib/protocol/codex-route.mjs'

test('default routing allows responses and chat, rejects anthropic', () => {
  const routing = { codex: normalizeCodexRouting() }
  assert.equal(isCodexProtocolAllowed('openai.responses', routing).ok, true)
  assert.equal(isCodexProtocolAllowed('openai.chat', routing).mode, 'convert')
  assert.equal(isCodexProtocolAllowed('anthropic.messages', routing).ok, false)
  assert.equal(isCodexProtocolAllowed('anthropic.messages', routing).code, 'protocol_not_allowed')
})

test('official Codex passthrough defaults off and round-trips', () => {
  assert.equal(normalizeCodexRouting().official_passthrough, false)
  assert.equal(normalizeCodexRouting({ official_passthrough: true }).official_passthrough, true)
  assert.throws(
    () => validateInferenceWebsocketPatch({ codex: { official_passthrough: 'yes' } }),
    (err) => err.code === 'invalid_codex_official_passthrough',
  )
})

test('disabled hop rejects every protocol', () => {
  const routing = { codex: normalizeCodexRouting({ enabled: false }) }
  assert.equal(isCodexProtocolAllowed('openai.responses', routing).code, 'codex_disabled')
})

test('retired rotate plugin is not revived from saved routing', () => {
  const routing = normalizeCodexRouting({
    plugin: { rotate: { enabled: true, inject_state: true, auto_collect: true } },
  })
  assert.equal(routing.plugin, undefined)
})

test('codex vm filter ignores Claude slots', () => {
  const vms = [
    { id: 'vm-claude', inference_engine: 'rust' },
    { id: 'vm-codex', platform: 'openai', family: 'codex' },
    { id: 'vm-codex-legacy', codex_kernel: true },
    { id: 'vm-codex-engine', inference_engine: 'codex' },
  ]
  assert.equal(isCodexVm(vms[0]), false)
  assert.deepEqual(
    listCodexVms(vms).map((v) => v.id),
    ['vm-codex', 'vm-codex-legacy', 'vm-codex-engine'],
  )
})

test('either websocket gate forces HTTP and disables inbound WS', () => {
  assert.equal(inferenceWebsocketEnabled({}), true)
  assert.equal(computedUpstreamTransport({}), 'prefer_websocket')
  assert.equal(inferenceWebsocketEnabled({ websocket: { enabled: false } }), false)
  assert.equal(computedUpstreamTransport({ websocket: { enabled: false } }), 'http')
  assert.equal(
    inferenceWebsocketEnabled({ websocket: { enabled: true }, codex: { websocket: { enabled: false } } }),
    false,
  )
  assert.equal(
    computedUpstreamTransport({
      websocket: { enabled: true },
      codex: { websocket: { enabled: true }, upstream_transport: 'prefer_websocket' },
    }),
    'prefer_websocket',
  )
  assert.equal(
    computedUpstreamTransport({
      websocket: { enabled: true },
      codex: { websocket: { enabled: true }, upstream_transport: 'http' },
    }),
    'http',
  )
})

test('PUT websocket patch rejects non-booleans and illegal transport', () => {
  assert.throws(
    () => validateInferenceWebsocketPatch({ websocket: { enabled: 'yes' } }),
    (err) => {
      assert.equal(err.code, 'invalid_websocket')
      return true
    },
  )
  assert.throws(
    () => validateInferenceWebsocketPatch({ codex: { websocket: true } }),
    (err) => {
      assert.equal(err.code, 'invalid_codex_websocket')
      return true
    },
  )
  assert.throws(
    () => validateInferenceWebsocketPatch({ codex: { upstream_transport: 'ws' } }),
    (err) => {
      assert.equal(err.code, 'invalid_upstream_transport')
      return true
    },
  )
  assert.throws(
    () => validateInferenceWebsocketPatch({ codex: { user_agent: '  ' } }),
    (err) => {
      assert.equal(err.code, 'invalid_user_agent')
      return true
    },
  )
  assert.throws(
    () => validateInferenceWebsocketPatch({ codex: { client_features: { enabled: 1 } } }),
    (err) => {
      assert.equal(err.code, 'invalid_client_features')
      return true
    },
  )
  assert.throws(
    () => validateInferenceWebsocketPatch({ codex: { analytics: { enabled: 'no' } } }),
    (err) => {
      assert.equal(err.code, 'invalid_codex_analytics')
      return true
    },
  )
  validateInferenceWebsocketPatch({
    websocket: { enabled: false },
    codex: {
      websocket: { enabled: true },
      upstream_transport: 'http',
      user_agent: 'codex_cli_rs/0.160.0 (linux x86_64)',
      client_features: { enabled: false },
      analytics: { enabled: false },
    },
  })
})
