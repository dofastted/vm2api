import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { SchedulerPoolsRepo } from '../../src/lib/db/repos/scheduler-pools-repo.mjs'
import { CRS_OFFICIAL_CLI_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { restoreToolNames, restoreToolNamesInSSELine } from '../../src/lib/protocol/anthropic-policy.mjs'
import { prepareCragPrintBody } from '../../src/lib/protocol/crag-print-prompt.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { resolvePoolSystemPromptPolicy } from '../../src/lib/protocol/pool-prompt-policy.mjs'
import { prepareWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'
import { clearRustHealthCache, rememberRustHealth } from '../../src/lib/transport/kernel-router.mjs'
import { createFailoverMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'

const HEADLESS_V4_CAPS = [
  'generation_controls_v3',
  'headless_claude_bridge_v1',
  'count_tokens_v1',
  'native_handoff_v1',
  'provider_result_v2',
  'provider_managed_tools_v1',
  'request_safeguards',
  'request_speed',
]

const LEGACY_V3_CAPS = [
  'generation_controls_v3',
  'linux_tui_native_queue',
  'prompt_append',
  'prompt_replace',
  'prompt_replace_empty',
]

function makeCragHealth(capabilities = HEADLESS_V4_CAPS, extra = {}) {
  return {
    ok: true,
    ready: true,
    status: 'ready',
    cli_pid: 22222,
    ready_slots: 10,
    runtime_variant: 'crag-v2',
    transport: capabilities.includes('headless_claude_bridge_v1') ? 'headless_bridge' : 'print',
    capabilities,
    ...extra,
  }
}

function makePoolsRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-v4-pools-db-'))
  const store = new ApiKeyStore({ dataDir: dir })
  t.after(() => {
    try {
      store.close?.()
    } catch {}
    try {
      store.db?.close?.()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return new SchedulerPoolsRepo(store.db)
}

function makeCherryStudio19Tools() {
  const unprefixed = [
    {
      name: 'automation_repl',
      description: 'Execute automation in cherry-browser and cherry-computer.',
      input_schema: { type: 'object', properties: { code: { type: 'string' } } },
      eager_input_streaming: true,
    },
    {
      name: 'automation_repl_reset',
      description: 'Reset automation REPL state.',
      input_schema: { type: 'object', properties: {} },
      eager_input_streaming: true,
    },
    {
      name: 'fs_read',
      description: 'Read file content.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      eager_input_streaming: true,
    },
    {
      name: 'mcp_resource_list',
      description: 'List MCP resources.',
      input_schema: { type: 'object', properties: {} },
      eager_input_streaming: true,
    },
    {
      name: 'mcp_resource_read',
      description: 'Read MCP resource.',
      input_schema: { type: 'object', properties: { uri: { type: 'string' } } },
      eager_input_streaming: true,
    },
  ]
  const prefixed = [
    {
      name: 'mcp__CherryPython__pythonExecute_1',
      description: 'Run python snippet.',
      input_schema: { type: 'object', properties: { code: { type: 'string' } } },
      eager_input_streaming: true,
    },
    ...Array.from({ length: 13 }, (_, i) => ({
      name: `mcp__grokSearch__tool_${i + 1}`,
      description: `Grok search tool ${i + 1}.`,
      input_schema: { type: 'object', properties: { q: { type: 'string' } } },
      eager_input_streaming: true,
    })),
  ]
  return [...unprefixed, ...prefixed]
}

function makeResponse() {
  const res = {
    headersSent: false,
    statusCode: 0,
    status: 0,
    headers: {},
    body: null,
    chunks: [],
    writableEnded: false,
    destroyed: false,
    setHeader(k, v) {
      res.headers[String(k).toLowerCase()] = v
    },
    writeHead(status, headers = {}) {
      res.statusCode = status
      res.status = status
      res.headersSent = true
      for (const [k, v] of Object.entries(headers)) res.headers[String(k).toLowerCase()] = v
    },
    write(chunk) {
      res.headersSent = true
      res.chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk) res.write(chunk)
      res.headersSent = true
      res.writableEnded = true
    },
    on() {},
    once() {},
    off() {},
  }
  return res
}

function createProtocolHarness(
  t,
  { routing, vm, health, rustPromptPolicy = null, resolvedPoolId = null, poolsRepo = null, onCallAttempt },
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-v4-3p-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  clearRustHealthCache()
  t.after(() => clearRustHealthCache())

  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))

  const exec = { vmId: vm.id, vm, homeDir: root, workerStatus: health }
  if (health) rememberRustHealth(exec, { ok: true, health })

  const scheduler = {
    async selectAndReserve() {
      return {
        ok: true,
        vmId: vm.id,
        accountId: vm.id,
        vm,
        exec,
        ...(resolvedPoolId ? { resolvedPoolId } : {}),
        ...(rustPromptPolicy ? { promptPolicy: rustPromptPolicy } : {}),
        release() {},
      }
    },
    markSuccess() {},
    markCooldown() {},
    releaseAccountSessions() {},
  }
  const baseRt = createFailoverMockSchedulerRuntime({ scheduler })
  const schedulerRuntime = {
    ...baseRt,
    async acquireNode(params, opts) {
      const lease = await baseRt.acquireNode(params, opts)
      return {
        ...lease,
        ...(resolvedPoolId ? { resolved_pool_id: resolvedPoolId } : {}),
        ...(rustPromptPolicy ? { prompt_policy: rustPromptPolicy } : {}),
      }
    },
  }
  const runner = new FailoverRunner({
    scheduler,
    schedulerRuntime,
    config: { max_same_account_retries: 0 },
  })

  return async function invoke({ body, headers, apiKeyRecord = { id: 'key_test' }, protocol = 'anthropic.messages' }) {
    const res = makeResponse()
    const captured = []
    const handler = createHandleProtocol({
      json(_res, status, payload) {
        res.status = status
        res.statusCode = status
        res.body = payload
        return payload
      },
      writeSSEHeaders(_res, extraHeaders = {}) {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...(extraHeaders || {}) })
      },
      readBody: async () => structuredClone(body),
      requireAuth: () => true,
      cfg: {
        rewrite: { enabled: false },
        intercept: { rules: [] },
        distill: { enabled: false },
        limits: { max_body_bytes: 2 * 1024 * 1024, upstream_timeout_ms: 2000 },
        paths: { data: root, project: root },
      },
      ...(poolsRepo ? { poolsRepo } : {}),
      vms: [vm],
      requestLog: { start: () => ({ request_id: 'crag-v4-test-req' }), finish() {} },
      stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
      accountQuota: { ingestHeaders() {} },
      apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage() {} },
      apiScheduler: {},
      apiEndpointStore: {},
      stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
      routingConfigPath: routingFile,
      routingConfig: routing,
      groupsRepo: { rateMultiplier: () => 1 },
      failoverRunner: {
        run(opts) {
          return runner.run({
            ...opts,
            async callAttempt(callCtx) {
              captured.push({
                hopBody: structuredClone(callCtx.body),
                attemptMeta: callCtx.attemptMeta,
              })
              if (onCallAttempt) return onCallAttempt(callCtx, { exec, routing, headers })
              return {
                ok: true,
                status: 200,
                terminalState: 'verified',
                body: {
                  id: 'msg_ok',
                  type: 'message',
                  role: 'assistant',
                  model: body.model,
                  content: [{ type: 'text', text: 'ok' }],
                  stop_reason: 'end_turn',
                  usage: { input_tokens: 10, output_tokens: 2 },
                },
              }
            },
          })
        },
      },
    })

    await handler.handleProtocol(
      {
        method: 'POST',
        url: '/v1/messages',
        headers,
        apiKeyKind: 'managed',
        apiKeyRecord,
        once() {},
        off() {},
      },
      res,
      protocol,
      '/v1/messages',
    )
    return { res, captured }
  }
}

test('RC-3 + RC-2 live 74d26aa4 reproduction: Cherry Studio / magpie/dev 19 tools rewrite to mcp__ on CRAG V4 (with & without system) and restore on JSON & SSE', async (t) => {
  const vm = {
    id: 'vm-34',
    node_id: 'node-ph24',
    dataplane: 'wrap',
    official_cc_inference: 'cli-hop',
    timezone: 'Asia/Shanghai',
    locale: 'en_US.UTF-8',
  }
  const health = makeCragHealth(HEADLESS_V4_CAPS)
  const routing = {
    sticky: { outbound_session: 'passthrough' },
    compatibility: {
      persona_preset: 'official',
      crag_persona_preset: 'official_full',
      official_cc_passthrough: false,
      claude_code_only: false,
      crag_strict_passthrough: false,
      cache_ttl: '1h',
    },
  }
  const tools19 = makeCherryStudio19Tools()
  assert.equal(tools19.length, 19)

  const invoke = createProtocolHarness(t, {
    routing,
    vm,
    health,
    onCallAttempt({ body, attemptMeta }) {
      const wireResponse = {
        id: 'msg_74d26aa4_fixed',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'mcp__automation_repl', input: { code: '1+1' } },
          { type: 'tool_use', id: 'toolu_2', name: 'mcp__resource_list', input: {} },
          {
            type: 'tool_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            tool_references: [{ type: 'tool_reference', tool_name: 'mcp__fs_read' }],
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
      }
      return {
        ok: true,
        status: 200,
        terminalState: 'verified',
        body: restoreToolNames(wireResponse, attemptMeta?.toolNames || {}),
      }
    },
  })

  // 1. Exact 74d26aa4 payload: no system, adaptive thinking, 19 Cherry Studio tools, magpie/dev + structured-outputs beta
  const baseBody = {
    model: 'claude-opus-5-5',
    max_tokens: 128000,
    stream: false,
    thinking: { type: 'adaptive', display: 'summarized' },
    tools: tools19,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_prev', name: 'fs_read', input: { path: '/etc/hosts' } },
          {
            type: 'tool_search_tool_result',
            tool_use_id: 'srv_prev',
            tool_references: [{ type: 'tool_reference', tool_name: 'mcp_resource_list' }],
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_prev', content: '127.0.0.1 localhost' }],
      },
    ],
  }
  const magpieHeaders = {
    authorization: 'Bearer sk-vm-test',
    'user-agent': 'magpie/dev',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'structured-outputs-2025-11-13',
  }

  const runNoSys = await invoke({ body: baseBody, headers: magpieHeaders })
  assert.equal(runNoSys.res.status, 200, JSON.stringify(runNoSys.res.body))
  const sentNoSys = runNoSys.captured[0].hopBody
  const sentNames = sentNoSys.tools.map((tool) => tool.name)
  assert.deepEqual(sentNames.slice(0, 5), [
    'mcp__automation_repl',
    'mcp__automation_repl_reset',
    'mcp__fs_read',
    'mcp__resource_list',
    'mcp__resource_read',
  ])
  assert.equal(sentNames[5], 'mcp__CherryPython__pythonExecute_1')
  assert.ok(sentNames.every((name) => name.startsWith('mcp__')))
  assert.equal(sentNoSys.messages[1].content[0].name, 'mcp__fs_read')
  assert.equal(sentNoSys.messages[1].content[1].tool_references[0].tool_name, 'mcp__resource_list')
  assert.equal(sentNoSys.crag_persona_preset, 'official_full')
  assert.equal('system' in sentNoSys, false)
  assert.equal(runNoSys.captured[0].attemptMeta.stripClientBeta, true)

  // Non-stream JSON response restored to client tool names
  assert.equal(runNoSys.res.body.content[0].name, 'automation_repl')
  assert.equal(runNoSys.res.body.content[1].name, 'mcp_resource_list')
  assert.equal(runNoSys.res.body.content[2].tool_references[0].tool_name, 'fs_read')

  // Forced tool_choice also rewrites to mcp__<name> (model supporting disabled thinking)
  const runForcedChoice = await invoke({
    body: {
      ...baseBody,
      model: 'claude-sonnet-4-6',
      thinking: { type: 'disabled' },
      tool_choice: { type: 'tool', name: 'automation_repl' },
    },
    headers: magpieHeaders,
  })
  assert.equal(runForcedChoice.res.status, 200, JSON.stringify(runForcedChoice.res.body))
  assert.equal(runForcedChoice.captured[0].hopBody.tool_choice.name, 'mcp__automation_repl')

  // SSE restoration restores both tool_use and tool_search_tool_result.tool_references
  const toolNamesMap = runNoSys.captured[0].attemptMeta.toolNames
  const sseToolUse = restoreToolNamesInSSELine(
    `data: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_sse_1', name: 'mcp__automation_repl', input: {} },
    })}`,
    toolNamesMap,
  )
  assert.equal(JSON.parse(sseToolUse.slice(5)).content_block.name, 'automation_repl')

  const sseSearchRef = restoreToolNamesInSSELine(
    `data: ${JSON.stringify({
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_search_tool_result',
        tool_use_id: 'srv_sse_1',
        tool_references: [
          { type: 'tool_reference', tool_name: 'mcp__resource_list' },
          { type: 'tool_reference', tool_name: 'mcp__fs_read' },
        ],
      },
    })}`,
    toolNamesMap,
  )
  assert.deepEqual(
    JSON.parse(sseSearchRef.slice(5)).content_block.tool_references.map((r) => r.tool_name),
    ['mcp_resource_list', 'fs_read'],
  )

  // 2. With third-party system prompt: system is relocated into messages[0] AND 1-line placeholder is stripped (RC-2)
  const runWithSys = await invoke({
    body: {
      ...baseBody,
      system: [{ type: 'text', text: 'You are Cherry Studio, an AI desktop assistant.' }],
    },
    headers: magpieHeaders,
  })
  assert.equal(runWithSys.res.status, 200, JSON.stringify(runWithSys.res.body))
  const sentWithSys = runWithSys.captured[0].hopBody
  assert.equal(
    'system' in sentWithSys,
    false,
    '1-line official CLI placeholder must be stripped so CRAG V4 injects tui_system_template',
  )
  assert.equal(sentWithSys.crag_persona_preset, 'official_full')
  assert.equal(sentWithSys.messages[0].content[0].text, 'You are Cherry Studio, an AI desktop assistant.')
  assert.ok(sentWithSys.tools.every((tool) => tool.name.startsWith('mcp__')))
})

test('RC-3: Official CC tools stay untouched on CRAG V4 (only stray mcp_* normalized), and legacy CRAG V3 keeps preserveToolNames=true', async (t) => {
  const routing = {
    sticky: { outbound_session: 'passthrough' },
    compatibility: {
      persona_preset: 'official',
      crag_persona_preset: 'official_full',
      official_cc_passthrough: false,
      crag_strict_passthrough: false,
    },
  }
  const vm = { id: 'vm-cc', node_id: 'node-1', dataplane: 'wrap', official_cc_inference: 'cli-hop' }

  const invokeV4 = createProtocolHarness(t, {
    routing,
    vm,
    health: makeCragHealth(HEADLESS_V4_CAPS),
  })
  const officialRes = await invokeV4({
    body: {
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      stream: false,
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.321.abc; cc_entrypoint=cli; cch=00000;' },
        { type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM },
      ],
      tools: [
        { name: 'Bash', input_schema: { type: 'object' } },
        { name: 'Read', input_schema: { type: 'object' } },
        { name: 'mcp_stray_tool', input_schema: { type: 'object' } },
      ],
      messages: [{ role: 'user', content: 'hi' }],
      metadata: {
        user_id:
          'user_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_account_a_session_11111111-1111-4111-8111-111111111111',
      },
    },
    headers: {
      authorization: 'Bearer sk-cc',
      'user-agent': 'claude-cli/2.1.321 (external, cli)',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'x-app': 'cli',
      'x-claude-code-session-id': '11111111-1111-4111-8111-111111111111',
    },
  })
  assert.equal(officialRes.res.status, 200, JSON.stringify(officialRes.res.body))
  assert.deepEqual(
    officialRes.captured[0].hopBody.tools.map((tool) => tool.name),
    ['Bash', 'Read', 'mcp__stray_tool'],
  )
  assert.equal(officialRes.captured[0].attemptMeta.toolNames.mcp__stray_tool, 'mcp_stray_tool')

  // Legacy CRAG V3 (without headless_claude_bridge_v1) still preserves raw tool names for its CLI MCP wrapper
  const invokeV3 = createProtocolHarness(t, {
    routing,
    vm: { ...vm, id: 'vm-v3' },
    health: makeCragHealth(LEGACY_V3_CAPS),
  })
  const v3Res = await invokeV3({
    body: {
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      stream: false,
      tools: [{ name: 'automation_repl', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'hi' }],
    },
    headers: { authorization: 'Bearer sk-3p', 'user-agent': 'magpie/dev' },
  })
  assert.equal(v3Res.res.status, 200, JSON.stringify(v3Res.res.body))
  assert.equal(v3Res.captured[0].attemptMeta.cragPrint, true)
  assert.deepEqual(
    v3Res.captured[0].hopBody.tools.map((tool) => tool.name),
    ['automation_repl'],
  )
})

test('RC-2: prepareCragPrintBody strips relocated 1-line official CLI identity placeholder on V4 (official/append/inherit_global + providerCompat) and V3 (official/append)', () => {
  const placeholderBody = {
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'You are Cherry Studio.' },
          { type: 'text', text: 'hi' },
        ],
      },
    ],
  }
  const officialPool = resolvePoolSystemPromptPolicy({
    id: 'pool_off',
    provider_scope: 'anthropic',
    system_prompt_mode: 'official',
    system_prompt_preset: 'official_full',
  })
  const appendPool = resolvePoolSystemPromptPolicy({
    id: 'pool_app',
    provider_scope: 'anthropic',
    system_prompt_mode: 'append',
    system_prompt_text: 'POOL_APPEND_RULE',
  })
  const emptyAppendPool = resolvePoolSystemPromptPolicy({
    id: 'pool_app_empty',
    provider_scope: 'anthropic',
    system_prompt_mode: 'append',
    system_prompt_text: '',
  })

  // 1. V4 official_full / inherit_global / pool official -> strips placeholder & sets official_full
  for (const promptPolicy of [null, officialPool]) {
    const out = prepareCragPrintBody(placeholderBody, {
      preset: 'official_full',
      officialPassthrough: false,
      capabilities: HEADLESS_V4_CAPS,
      promptPolicy,
    })
    assert.equal('system' in out, false)
    assert.equal(out.crag_persona_preset, 'official_full')
  }

  // 2. V4 append with text -> strips placeholder (keeps only pool text) & sets official_full even with providerCompat=true
  const providerCompatBody = {
    ...placeholderBody,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
  }
  for (const [label, inputBody, caps] of [
    ['normal', placeholderBody, HEADLESS_V4_CAPS],
    ['providerCompat', providerCompatBody, [...HEADLESS_V4_CAPS, 'provider_managed_tools_v1']],
  ]) {
    const out = prepareCragPrintBody(inputBody, {
      preset: 'official_full',
      officialPassthrough: false,
      capabilities: caps,
      promptPolicy: appendPool,
    })
    assert.deepEqual(out.system, [{ type: 'text', text: 'POOL_APPEND_RULE' }], label)
    assert.equal(out.crag_persona_preset, 'official_full', label)
  }

  // 3. V4 append with empty pool text -> strips placeholder & sets official_full
  const emptyAppendOut = prepareCragPrintBody(placeholderBody, {
    preset: 'official_full',
    officialPassthrough: false,
    capabilities: HEADLESS_V4_CAPS,
    promptPolicy: emptyAppendPool,
  })
  assert.equal('system' in emptyAppendOut, false)
  assert.equal(emptyAppendOut.crag_persona_preset, 'official_full')

  // 4. Legacy V3 explicit pool mode=official -> strips placeholder, no crag_prompt emitted
  const v3Official = prepareCragPrintBody(placeholderBody, {
    preset: 'official_full',
    officialPassthrough: false,
    capabilities: LEGACY_V3_CAPS,
    promptPolicy: officialPool,
  })
  assert.equal('system' in v3Official, false)
  assert.equal(v3Official.crag_prompt, undefined)

  // 5. Legacy V3 explicit pool mode=append -> strips placeholder before appending pool text
  const v3Append = prepareCragPrintBody(placeholderBody, {
    preset: 'official_full',
    officialPassthrough: false,
    capabilities: LEGACY_V3_CAPS,
    promptPolicy: appendPool,
  })
  assert.equal('system' in v3Append, false)
  assert.deepEqual(v3Append.crag_prompt, { mode: 'append', text: 'POOL_APPEND_RULE' })
})

test('RC-4.1: Cross-pool fallback/downgrade from passthrough origin pool to official target pool relocates third-party system on CRAG V4, cli-hop, and http OAuth', async (t) => {
  const poolsRepo = makePoolsRepo(t)
  poolsRepo.insert({
    id: 'pool_origin_pass',
    name: 'Origin Passthrough',
    provider_scope: 'anthropic',
    system_prompt_mode: 'passthrough',
  })
  poolsRepo.setMembers('pool_origin_pass', [{ node_type: 'claude_vm', node_id: 'vm-fb' }])

  poolsRepo.insert({
    id: 'pool_origin_off',
    name: 'Origin Official',
    provider_scope: 'anthropic',
    system_prompt_mode: 'official',
    system_prompt_preset: 'official_full',
  })
  poolsRepo.setMembers('pool_origin_off', [{ node_type: 'claude_vm', node_id: 'vm-fb' }])

  const targetOfficialRustPolicy = {
    pool_id: 'pool_target_official',
    mode: 'official',
    preset: 'official_full',
    source: 'pool',
  }
  const routing = {
    sticky: { outbound_session: 'passthrough' },
    compatibility: {
      persona_preset: 'official_full',
      crag_persona_preset: 'official_full',
      official_cc_passthrough: false,
      claude_code_only: false,
    },
  }
  const apiKeyRecord = {
    id: 'key_fb',
    group_type: 'anthropic',
    pool_binding_mode: 'strict_pool',
    default_pool_id: 'pool_origin_pass',
    allowed_pool_ids: ['pool_origin_pass'],
  }
  const thirdPartyPrompt = 'You are OpenCode, a third-party coding harness.'
  const reqBody = {
    model: 'claude-sonnet-5-5',
    max_tokens: 1024,
    stream: false,
    system: [{ type: 'text', text: thirdPartyPrompt }],
    messages: [{ role: 'user', content: 'Fix the bug' }],
  }
  const reqHeaders = { authorization: 'Bearer sk-fb', 'user-agent': 'OpenCode/2.0' }

  // 1. CRAG V4 fallback from passthrough -> official relocates third-party system & strips placeholder
  const invokeCrag = createProtocolHarness(t, {
    routing,
    vm: {
      id: 'vm-fb',
      node_id: 'node-1',
      platform: 'anthropic',
      dataplane: 'wrap',
      status: 'running',
      schedulable: true,
      official_cc_inference: 'cli-hop',
    },
    health: makeCragHealth(HEADLESS_V4_CAPS),
    rustPromptPolicy: targetOfficialRustPolicy,
    resolvedPoolId: 'pool_target_official',
    poolsRepo,
  })
  const cragRes = await invokeCrag({ body: reqBody, headers: reqHeaders, apiKeyRecord })
  assert.equal(cragRes.res.status, 200, JSON.stringify(cragRes.res.body))
  assert.equal(cragRes.captured[0].attemptMeta.cragPrint, true)
  assert.equal('system' in cragRes.captured[0].hopBody, false)
  assert.equal(cragRes.captured[0].hopBody.crag_persona_preset, 'official_full')
  assert.equal(cragRes.captured[0].hopBody.messages[0].content[0].text, thirdPartyPrompt)

  // 2. cli-hop fallback from passthrough -> official relocates third-party system out of top-level system[]
  const invokeCliHop = createProtocolHarness(t, {
    routing,
    vm: {
      id: 'vm-fb',
      node_id: 'node-1',
      platform: 'anthropic',
      dataplane: 'wrap',
      status: 'running',
      schedulable: true,
      official_cc_inference: 'cli-hop',
    },
    health: {
      ok: true,
      ready: true,
      status: 'ready',
      cli_pid: 22222,
      ready_slots: 10,
      runtime_variant: 'cli-node',
      capabilities: [],
    },
    rustPromptPolicy: targetOfficialRustPolicy,
    resolvedPoolId: 'pool_target_official',
    poolsRepo,
  })
  const cliHopRes = await invokeCliHop({ body: reqBody, headers: reqHeaders, apiKeyRecord })
  assert.equal(cliHopRes.res.status, 200, JSON.stringify(cliHopRes.res.body))
  assert.equal(cliHopRes.captured[0].attemptMeta.cragPrint, false)
  const cliSystemText = JSON.stringify(cliHopRes.captured[0].hopBody.system || '')
  assert.equal(cliSystemText.includes(thirdPartyPrompt), false, 'third-party prompt must not stay in cli-hop system[]')
  assert.equal(JSON.stringify(cliHopRes.captured[0].hopBody.messages[0]).includes(thirdPartyPrompt), true)

  // 3. HTTP OAuth fallback from passthrough -> official relocates third-party system out of top-level system[]
  const invokeHttp = createProtocolHarness(t, {
    routing,
    vm: {
      id: 'vm-fb',
      node_id: 'node-1',
      platform: 'anthropic',
      dataplane: 'wrap',
      status: 'running',
      schedulable: true,
      official_cc_inference: 'http',
    },
    health: null,
    rustPromptPolicy: targetOfficialRustPolicy,
    resolvedPoolId: 'pool_target_official',
    poolsRepo,
  })
  const httpRes = await invokeHttp({ body: reqBody, headers: reqHeaders, apiKeyRecord })
  assert.equal(httpRes.res.status, 200, JSON.stringify(httpRes.res.body))
  const httpSystemText = JSON.stringify(httpRes.captured[0].hopBody.system || '')
  assert.equal(httpSystemText.includes(thirdPartyPrompt), false, 'third-party prompt must not stay in http system[]')
  assert.equal(JSON.stringify(httpRes.captured[0].hopBody.messages[0]).includes(thirdPartyPrompt), true)

  // 4. Reverse: official origin pool -> passthrough target pool keeps caller system intact (un-relocated)
  const invokeReverse = createProtocolHarness(t, {
    routing,
    vm: {
      id: 'vm-fb',
      node_id: 'node-1',
      platform: 'anthropic',
      dataplane: 'wrap',
      status: 'running',
      schedulable: true,
      official_cc_inference: 'cli-hop',
    },
    health: makeCragHealth(HEADLESS_V4_CAPS),
    rustPromptPolicy: { pool_id: 'pool_pass_target', mode: 'passthrough', source: 'pool' },
    resolvedPoolId: 'pool_pass_target',
    poolsRepo,
  })
  const reverseRes = await invokeReverse({
    body: reqBody,
    headers: reqHeaders,
    apiKeyRecord: { ...apiKeyRecord, default_pool_id: 'pool_origin_off', allowed_pool_ids: ['pool_origin_off'] },
  })
  assert.equal(reverseRes.res.status, 200, JSON.stringify(reverseRes.res.body))
  assert.deepEqual(reverseRes.captured[0].hopBody.system, [{ type: 'text', text: thirdPartyPrompt }])
  assert.deepEqual(reverseRes.captured[0].hopBody.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Fix the bug' }] },
  ])
})

test('RC-4.2: Custom persona_templates on CRAG V4 relocates id="caller_system" into messages[0] and never leaks third-party prompt into crag_prompt.blocks', async (t) => {
  const templateWithCallerSystem = {
    compatibility: {
      persona_preset: 'official_full',
      crag_persona_preset: 'official_full',
      persona_templates: {
        official_full: [
          { id: 'billing', type: 'text', text: '{{billing}}' },
          { id: 'identity', type: 'text', text: '{{identity_cli}}' },
          {
            id: 'harness',
            type: 'text',
            text: 'Custom official harness instructions.',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
          {
            id: 'caller_system',
            drop_if_empty: true,
            type: 'text',
            text: '<system-reminder>\n{{caller_system}}\n</system-reminder>\n',
          },
        ],
      },
    },
  }

  // Unit level: prepareCragPrintBody relocates caller_system block to messages[0]
  const printed = prepareCragPrintBody(
    {
      model: 'claude-sonnet-5-5',
      system: [{ type: 'text', text: 'You are OpenCode, a third-party coding agent.' }],
      messages: [{ role: 'user', content: 'Fix bug' }],
    },
    {
      preset: 'official_full',
      officialPassthrough: false,
      capabilities: HEADLESS_V4_CAPS,
      routing: templateWithCallerSystem,
      cacheTtl: '1h',
    },
  )
  assert.equal('system' in printed, false)
  assert.equal(printed.crag_prompt.mode, 'replace')
  assert.equal(
    printed.crag_prompt.blocks.some((b) => b.text.includes('OpenCode')),
    false,
    'id=caller_system must never leak third-party prompt into crag_prompt.blocks',
  )
  assert.deepEqual(
    printed.crag_prompt.blocks.map((b) => b.text),
    [CRS_OFFICIAL_CLI_SYSTEM, 'Custom official harness instructions.'],
  )
  assert.match(JSON.stringify(printed.messages[0]), /<system-reminder>[\s\S]*OpenCode[\s\S]*<\/system-reminder>/)

  // End-to-end handleProtocol with custom template WITHOUT caller_system block still relocates third-party prompt to messages[0]
  const templateWithoutCaller = {
    sticky: { outbound_session: 'passthrough' },
    compatibility: {
      persona_preset: 'official_full',
      crag_persona_preset: 'official_full',
      official_cc_passthrough: false,
      persona_templates: {
        official_full: [
          { id: 'billing', type: 'text', text: '{{billing}}' },
          { id: 'identity', type: 'text', text: '{{identity_cli}}' },
          { id: 'custom_body', type: 'text', text: 'Fixed custom system block.' },
        ],
      },
    },
  }
  const invoke = createProtocolHarness(t, {
    routing: templateWithoutCaller,
    vm: { id: 'vm-tpl', node_id: 'node-1', dataplane: 'wrap', official_cc_inference: 'cli-hop' },
    health: makeCragHealth(HEADLESS_V4_CAPS),
  })
  const res = await invoke({
    body: {
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      stream: false,
      system: [{ type: 'text', text: 'You are Cline, an autonomous agent.' }],
      messages: [{ role: 'user', content: 'Explain this file' }],
    },
    headers: { authorization: 'Bearer sk-tpl', 'user-agent': 'Cline/3.0' },
  })
  assert.equal(res.res.status, 200, JSON.stringify(res.res.body))
  assert.equal(res.captured[0].attemptMeta.cragPrint, true)
  const sent = res.captured[0].hopBody
  assert.equal('system' in sent, false)
  assert.equal(
    sent.crag_prompt.blocks.some((b) => b.text.includes('Cline')),
    false,
  )
  assert.equal(sent.messages[0].content[0].text, 'You are Cline, an autonomous agent.')
})

test('RC-4.3: crag_env respects attemptPoolPrompt and effectiveCliPersona (omitted on zero_inject and passthrough pools)', async (t) => {
  const routing = {
    sticky: { outbound_session: 'passthrough' },
    compatibility: {
      persona_preset: 'official_full',
      crag_persona_preset: 'official_full',
      official_cc_passthrough: false,
      persona_env_presets: { official_full: true, zero: true },
      persona_timezone_presets: { official_full: true, zero: true },
      persona_locale_presets: { official_full: true, zero: true },
    },
  }
  const vm = {
    id: 'vm-env-pool',
    node_id: 'node-1',
    dataplane: 'wrap',
    official_cc_inference: 'cli-hop',
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
  }
  const health = makeCragHealth(HEADLESS_V4_CAPS)
  const body = {
    model: 'claude-sonnet-5-5',
    max_tokens: 512,
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
  }
  const headers = { authorization: 'Bearer sk-env', 'user-agent': 'OpenCode/2.0' }

  for (const mode of ['zero_inject', 'passthrough']) {
    const invoke = createProtocolHarness(t, {
      routing,
      vm,
      health,
      rustPromptPolicy: { pool_id: `pool_${mode}`, mode, source: 'pool' },
      resolvedPoolId: `pool_${mode}`,
    })
    const { res, captured } = await invoke({ body, headers })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(captured[0].attemptMeta.cragPrint, true)
    assert.equal('crag_env' in captured[0].hopBody, false, `pool mode=${mode} must not inject crag_env`)
  }

  // Official pool still injects crag_env when enabled for its effective preset
  const invokeOfficial = createProtocolHarness(t, {
    routing,
    vm,
    health,
    rustPromptPolicy: {
      pool_id: 'pool_official',
      mode: 'official',
      preset: 'official_full',
      source: 'pool',
    },
    resolvedPoolId: 'pool_official',
  })
  const { res, captured } = await invokeOfficial({ body, headers })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(captured[0].attemptMeta.cragPrint, true)
  assert.deepEqual(captured[0].hopBody.crag_env, {
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    inject_if_missing: true,
  })
})

test('RC-4.4: repaired retry on CRAG V4 does not leak raw non-CC client anthropic-beta (even with spoofed claude-cli UA)', () => {
  const exec = {
    vmId: 'vm-34',
    homeDir: '/tmp/vm-34-nonexistent',
    vm: { id: 'vm-34', dataplane: 'crag', crag_kernel_version: 'v2', claude: {} },
    workerStatus: makeCragHealth(HEADLESS_V4_CAPS),
  }
  const baseBody = {
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    crag_persona_preset: 'official_full',
    messages: [{ role: 'user', content: 'hi' }],
  }

  // 1. Third-party UA (magpie/dev) + structured-outputs-2025-11-13 on repaired retry
  const magpieRepaired = prepareWorkerPayload({
    body: baseBody,
    reqHeaders: {
      'user-agent': 'magpie/dev',
      'anthropic-beta': 'structured-outputs-2025-11-13',
    },
    exec,
    routing: {},
    cliHop: true,
    cragPrint: true,
    repaired: true,
  })
  assert.doesNotMatch(String(magpieRepaired.headers?.['anthropic-beta'] || ''), /structured-outputs-2025-11-13/)

  // 2. Spoofed claude-cli UA + structured-outputs-2025-11-13 on non-passthrough CRAG V4 repaired retry
  const spoofedRepaired = prepareWorkerPayload({
    body: baseBody,
    reqHeaders: {
      'user-agent': 'claude-cli/2.1.321 (external, cli)',
      'anthropic-beta': 'structured-outputs-2025-11-13,claude-code-20250219',
    },
    exec,
    routing: {},
    cliHop: true,
    cragPrint: true,
    repaired: true,
  })
  assert.doesNotMatch(String(spoofedRepaired.headers?.['anthropic-beta'] || ''), /structured-outputs-2025-11-13/)

  // 3. Explicit officialPassthrough=false even without crag_persona_preset also blocks raw client beta leak
  const explicitNonPassthrough = prepareWorkerPayload({
    body: { model: 'claude-opus-5-5', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] },
    reqHeaders: {
      'user-agent': 'claude-cli/2.1.321 (external, cli)',
      'anthropic-beta': 'structured-outputs-2025-11-13',
    },
    exec,
    routing: {},
    cliHop: true,
    cragPrint: true,
    repaired: true,
    officialPassthrough: false,
  })
  assert.doesNotMatch(String(explicitNonPassthrough.headers?.['anthropic-beta'] || ''), /structured-outputs-2025-11-13/)
})
