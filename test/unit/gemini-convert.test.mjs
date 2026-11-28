import { buildDirectEnvelope } from '../../src/lib/gemini/direct-client.mjs'
import { normalizeGeminiOutboundPrompt } from '../../src/lib/gemini/prompt-normalizer.mjs'
import { resolveUpstreamModel } from '../../src/lib/gemini/model-catalog.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SKIP_THOUGHT_SIGNATURE,
  buildGeminiRequest,
  classifyGeminiCapabilities,
  createGeminiCollector,
  createGeminiEventDecoder,
  createGeminiProtocolStreamEncoder,
  createGeminiRestoreTransform,
  createSseFrameSplitter,
  escapeNativeTuiSlashes,
  formatGeminiProtocolError,
  formatGeminiProtocolStreamError,
  geminiCamelCase,
  geminiFuncName,
  geminiToolNameFromCall,
  normalizeGeminiUsage,
  parseGeminiSseFrame,
  parseInboundToGemini,
  renderGeminiProtocolResponse,
  avoidAgyBridgeParamCollisions,
  clientDeclaredAgyBridgeParam,
  forwardAgyBridgeToolArgs,
  restoreAgyBridgeToolArgs,
  isRe2CompatibleRegex,
  sanitizeGeminiSchema,
  sanitizeNativeTuiText,
  signedToolCallId,
  stripIllegalControlChars,
  toAnthropicUsage,
  toGoogleUsageMetadata,
  toOpenAIChatUsage,
  toOpenAIResponsesUsage,
  unsignedToolCallId,
} from '../../src/lib/protocol/gemini-convert.mjs'

test('geminiCamelCase converts proto keys while preserving caller-owned payloads', () => {
  const input = {
    system_instruction: { parts: [{ text: 'be helpful' }] },
    generation_config: {
      max_output_tokens: 512,
      thinking_config: { thinking_budget: 2048, include_thoughts: true },
      response_schema: { type: 'OBJECT', properties: { user_name: { type: 'STRING' } } },
    },
    contents: [
      {
        role: 'model',
        parts: [
          {
            function_call: {
              id: 'fc_1',
              name: 'read_file',
              args: { file_path: '/tmp/a.txt', keep_snake: true },
            },
            thought_signature: 'sig-abc',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            function_response: {
              id: 'fc_1',
              name: 'read_file',
              response: { raw_result: 'ok' },
            },
          },
        ],
      },
    ],
    labels: { env_name: 'prod' },
  }
  const camel = geminiCamelCase(input)
  assert.equal(camel.systemInstruction.parts[0].text, 'be helpful')
  assert.equal(camel.generationConfig.maxOutputTokens, 512)
  assert.equal(camel.generationConfig.thinkingConfig.thinkingBudget, 2048)
  assert.deepEqual(camel.generationConfig.responseSchema, input.generation_config.response_schema)
  assert.deepEqual(camel.contents[0].parts[0].functionCall.args, { file_path: '/tmp/a.txt', keep_snake: true })
  assert.equal(camel.contents[0].parts[0].thoughtSignature, 'sig-abc')
  assert.deepEqual(camel.contents[1].parts[0].functionResponse.response, { raw_result: 'ok' })
  assert.deepEqual(camel.labels, { env_name: 'prod' })
})

test('tool name prefixes and signedToolCallId round-trip safely', () => {
  assert.equal(geminiFuncName('read_file'), 'read_file')
  assert.equal(geminiFuncName('123run'), '_x_123run')
  assert.equal(geminiFuncName('-dash'), '_x_-dash')
  assert.equal(geminiToolNameFromCall('default_api:read_file'), 'read_file')
  assert.equal(geminiToolNameFromCall('default_api._x_123run'), '123run')
  assert.equal(geminiToolNameFromCall('mcp_crag_Bash'), 'Bash')
  assert.equal(geminiToolNameFromCall('mcp_crag_Read'), 'Read')
  assert.equal(geminiToolNameFromCall('mcp__crag__Bash'), 'Bash')
  assert.equal(geminiToolNameFromCall('mcp_craggemini_Bash'), 'Bash')
  assert.equal(geminiToolNameFromCall('mcp__craggemini__Bash'), 'Bash')

  // Canonical base64 signature round-trips cleanly.
  const b64Sig = Buffer.from('gemini-thought-sig-bytes').toString('base64')
  const signed = signedToolCallId('call_42', b64Sig)
  assert.ok(signed.startsWith('call_42__ts'))
  assert.deepEqual(unsignedToolCallId(signed), { id: 'call_42', signature: b64Sig })

  // Non-base64 UTF-8 signature also round-trips via raw marker.
  const rawSig = 'non-b64:signature!'
  const signedRaw = signedToolCallId('call_raw', rawSig)
  assert.deepEqual(unsignedToolCallId(signedRaw), { id: 'call_raw', signature: rawSig })

  // Truncated signed ID fails closed (returns whole ID with empty signature).
  const truncated = signed.slice(0, -3)
  assert.deepEqual(unsignedToolCallId(truncated), { id: truncated, signature: '' })

  // Plain ID passes through unchanged.
  assert.deepEqual(unsignedToolCallId('call_plain'), { id: 'call_plain', signature: '' })
})

test('sanitizeGeminiSchema handles JSON Schema and plain OpenAPI modes', () => {
  const richSchema = {
    type: 'object',
    'x-internal': 'drop-me',
    $defs: {
      Node: {
        type: 'object',
        properties: {
          name: { type: 'string', 'x-ui': 'text' },
          child: { $ref: '#/$defs/Node' },
        },
        required: ['name', 'missing_field'],
      },
      Extra: {
        type: 'object',
        properties: { tag: { type: 'string', enum: ['a', ' ', 'b'] } },
        required: ['tag'],
      },
    },
    allOf: [{ $ref: '#/$defs/Node' }, { $ref: '#/$defs/Extra' }],
    properties: {
      allowAny: true,
      forbid: false,
      tags: { type: 'array', enum: ['x', 'y'], items: { type: 'string' } },
      nullableInt: { anyOf: [{ type: 'integer', exclusiveMinimum: 1 }, { type: 'null' }] },
      bareArray: { type: 'array' },
    },
  }

  const jsonMode = sanitizeGeminiSchema(richSchema, { plain: false })
  assert.equal(jsonMode['x-internal'], undefined)
  assert.deepEqual(jsonMode.properties.allowAny, {})
  assert.equal(Object.hasOwn(jsonMode.properties, 'forbid'), false)
  assert.ok(jsonMode.$defs.Node)

  const plainMode = sanitizeGeminiSchema(richSchema, { plain: true })
  assert.equal(plainMode.type, 'object')
  assert.equal(plainMode.$defs, undefined)
  assert.equal(plainMode.allOf, undefined)
  assert.equal(plainMode.properties.name.type, 'string')
  // Cyclic $ref resolves safely without throwing or infinite recursion.
  assert.deepEqual(plainMode.properties.child, { type: 'object' })
  assert.deepEqual(plainMode.properties.tag.enum, ['a', 'b'])
  assert.deepEqual(plainMode.properties.tags.items, { type: 'string', enum: ['x', 'y'] })
  assert.equal(plainMode.properties.tags.enum, undefined)
  assert.equal(plainMode.properties.nullableInt.type, 'integer')
  assert.equal(plainMode.properties.nullableInt.nullable, true)
  assert.equal(plainMode.properties.nullableInt.minimum, 1)
  assert.deepEqual(plainMode.properties.bareArray, { type: 'array', items: {} })
  // Required prunes fields missing from properties.
  assert.deepEqual(plainMode.required.sort(), ['name', 'tag'])
})

test('sanitizeGeminiSchema dedupes duplicate required entries without changing property order', () => {
  const raw = {
    type: 'object',
    properties: {
      CommandLine: { type: 'string' },
      toolSummary: { type: 'string' },
      WaitMsBeforeAsync: { type: 'integer' },
    },
    required: ['CommandLine', 'toolSummary', 'WaitMsBeforeAsync', 'toolSummary'],
  }
  const plain = sanitizeGeminiSchema(raw, { plain: true })
  assert.deepEqual(plain.required, ['CommandLine', 'toolSummary', 'WaitMsBeforeAsync'])
  const json = sanitizeGeminiSchema(raw, { plain: false })
  assert.deepEqual(json.required, ['CommandLine', 'toolSummary', 'WaitMsBeforeAsync'])
})

test('avoidAgyBridgeParamCollisions renames bridge-colliding parameters for antigravity', () => {
  const runCommand = {
    type: 'object',
    properties: {
      CommandLine: { type: 'string' },
      toolSummary: { type: 'string', description: 'What this command does' },
      WaitMsBeforeAsync: { type: 'integer' },
    },
    required: ['CommandLine', 'toolSummary', 'WaitMsBeforeAsync'],
  }
  const adjusted = avoidAgyBridgeParamCollisions(runCommand)
  assert.equal(adjusted.properties.toolSummary, undefined)
  assert.ok(adjusted.properties._client_toolSummary)
  assert.deepEqual(adjusted.required, ['CommandLine', '_client_toolSummary', 'WaitMsBeforeAsync'])

  const ir = parseInboundToGemini(
    'gemini',
    {
      contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
      tools: [{ functionDeclarations: [{ name: 'run_command', parameters: runCommand }] }],
    },
    { routeModel: 'gemini-4-argon-high', routeStream: false },
  )
  const agReq = buildGeminiRequest(ir, { target: 'antigravity' })
  const params = agReq.tools[0].functionDeclarations[0].parameters
  assert.equal(params.properties.toolSummary, undefined)
  assert.ok(params.properties._client_toolSummary)
  assert.deepEqual(params.required, ['CommandLine', '_client_toolSummary', 'WaitMsBeforeAsync'])
})

const RUN_COMMAND_SCHEMA = {
  type: 'object',
  properties: {
    CommandLine: { type: 'string' },
    toolSummary: { type: 'string' },
    WaitMsBeforeAsync: { type: 'integer' },
  },
  required: ['CommandLine', 'toolSummary'],
}

test('restoreAgyBridgeToolArgs maps _client_toolSummary back and drops bridge-only duplicates', () => {
  assert.deepEqual(restoreAgyBridgeToolArgs({ _client_toolSummary: 'deploy', CommandLine: 'ls' }, RUN_COMMAND_SCHEMA), {
    toolSummary: 'deploy',
    CommandLine: 'ls',
  })
  assert.deepEqual(
    restoreAgyBridgeToolArgs(
      { _client_toolSummary: 'from model', toolSummary: 'from bridge', CommandLine: 'ls' },
      RUN_COMMAND_SCHEMA,
    ),
    { toolSummary: 'from model', CommandLine: 'ls' },
  )
  assert.deepEqual(
    restoreAgyBridgeToolArgs({ CommandLine: 'ls', toolSummary: 'model used bare name' }, RUN_COMMAND_SCHEMA),
    { CommandLine: 'ls', toolSummary: 'model used bare name' },
  )
  assert.deepEqual(restoreAgyBridgeToolArgs({ CommandLine: 'ls', path: '/tmp' }), { CommandLine: 'ls', path: '/tmp' })
  assert.deepEqual(restoreAgyBridgeToolArgs({ toolSummary: 'bridge only', CommandLine: 'ls' }), { CommandLine: 'ls' })
  assert.equal(clientDeclaredAgyBridgeParam(RUN_COMMAND_SCHEMA, 'toolSummary'), true)
  assert.equal(
    clientDeclaredAgyBridgeParam({ type: 'object', properties: { path: { type: 'string' } } }, 'toolSummary'),
    false,
  )
})

test('forwardAgyBridgeToolArgs renames history functionCall args for antigravity only at root', () => {
  const schema = {
    type: 'object',
    properties: {
      CommandLine: { type: 'string' },
      toolSummary: { type: 'string' },
      nested: {
        type: 'object',
        properties: { toolSummary: { type: 'string' } },
      },
    },
  }
  const adjusted = avoidAgyBridgeParamCollisions(schema)
  assert.ok(adjusted.properties._client_toolSummary)
  assert.equal(adjusted.properties.nested.properties.toolSummary.type, 'string')

  const historyArgs = { CommandLine: 'pwd', toolSummary: 'print cwd', nested: { toolSummary: 'inner kept' } }
  const forwarded = forwardAgyBridgeToolArgs(historyArgs, schema)
  assert.deepEqual(forwarded, {
    CommandLine: 'pwd',
    _client_toolSummary: 'print cwd',
    nested: { toolSummary: 'inner kept' },
  })

  const ir = parseInboundToGemini(
    'openai-chat',
    {
      model: 'gemini-4-argon-high',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: {
                name: 'run_command',
                arguments: JSON.stringify(historyArgs),
              },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        { role: 'user', content: 'again' },
      ],
      tools: [{ type: 'function', function: { name: 'run_command', parameters: schema } }],
    },
    { routeModel: 'gemini-4-argon-high', routeStream: false },
  )
  const agReq = buildGeminiRequest(ir, { target: 'antigravity' })
  const modelTurn = agReq.contents.find((c) => c.role === 'model')
  const histCall = modelTurn.parts.find((p) => p.functionCall?.name)
  assert.deepEqual(histCall.functionCall.args, forwarded)
  assert.deepEqual(agReq.tools[0].functionDeclarations[0].parameters.properties._client_toolSummary, {
    type: 'string',
  })
})

test('createGeminiRestoreTransform restores agy bridge arg aliases for streaming and JSON responses', () => {
  const runCommandSchema = {
    type: 'object',
    properties: {
      CommandLine: { type: 'string' },
      toolSummary: { type: 'string' },
    },
    required: ['CommandLine', 'toolSummary'],
  }
  const ir = parseInboundToGemini(
    'openai-chat',
    {
      model: 'gemini-4-argon-high',
      messages: [{ role: 'user', content: 'run ls' }],
      tools: [{ type: 'function', function: { name: 'run_command', parameters: runCommandSchema } }],
    },
    { routeModel: 'gemini-4-argon-high', routeStream: false },
  )
  const restore = createGeminiRestoreTransform(ir.restoreContext, {
    target: 'antigravity',
    model: 'gemini-4-argon-high',
  })
  const collector = createGeminiCollector({ fallbackModel: 'gemini-4-argon-high' })
  const inboundArgs = {
    CommandLine: 'ls -la',
    _client_toolSummary: 'list dir',
    toolSummary: 'injected',
    WaitMsBeforeAsync: 0,
  }
  for (const ev of [
    { kind: 'start', responseId: 'rc1', model: 'gemini-4-argon-high' },
    { kind: 'tool_call', id: 'call_rc1', name: 'run_command', args: inboundArgs, signature: '' },
    { kind: 'stop', finishReason: 'STOP', stopReason: 'tool' },
  ]) {
    restore.push(ev, (out) => collector.push(out))
  }
  const turn = collector.result()
  assert.deepEqual(turn.toolCalls[0].args, {
    CommandLine: 'ls -la',
    toolSummary: 'list dir',
    WaitMsBeforeAsync: 0,
  })

  const chatJson = renderGeminiProtocolResponse('openai-chat', turn, {
    model: 'gemini-4-argon-high',
    restoreContext: ir.restoreContext,
  })
  const chatArgs = JSON.parse(chatJson.choices[0].message.tool_calls[0].function.arguments)
  assert.deepEqual(chatArgs, turn.toolCalls[0].args)
  assert.equal(chatArgs._client_toolSummary, undefined)

  const anthropicJson = renderGeminiProtocolResponse('anthropic', turn, {
    model: 'claude-sonnet-4-6',
    restoreContext: ir.restoreContext,
  })
  const anthropicInput = anthropicJson.content.find((b) => b.type === 'tool_use').input
  assert.deepEqual(anthropicInput, turn.toolCalls[0].args)

  const encoder = createGeminiProtocolStreamEncoder('openai-chat', {
    model: 'gemini-4-argon-high',
    restoreContext: ir.restoreContext,
  })
  const frames = []
  for (const ev of [
    { kind: 'start', responseId: 'rc1', model: 'gemini-4-argon-high' },
    { kind: 'tool_call', id: 'call_rc1', name: 'run_command', args: inboundArgs, signature: '' },
    { kind: 'stop', finishReason: 'STOP', stopReason: 'tool' },
  ]) {
    restore.push(ev, (out) => {
      const chunk = encoder.push(out)
      if (chunk) frames.push(chunk)
    })
  }
  frames.push(encoder.finish())
  const streamArgs = frames
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      try {
        return JSON.parse(line.slice(6))
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .flatMap((obj) => obj.choices?.[0]?.delta?.tool_calls || [])
    .map((tc) => (tc.function?.arguments ? JSON.parse(tc.function.arguments) : null))
    .filter(Boolean)
  assert.ok(streamArgs.length >= 1)
  assert.deepEqual(streamArgs.at(-1), turn.toolCalls[0].args)
})

test('avoidAgyBridgeParamCollisions leaves schemas without collisions unchanged', () => {
  const readFile = {
    type: 'object',
    properties: { path: { type: 'string' }, offset: { type: 'integer' } },
    required: ['path'],
  }
  const before = structuredClone(readFile)
  const afterSanitize = sanitizeGeminiSchema(readFile, { plain: true })
  const afterCollision = avoidAgyBridgeParamCollisions(afterSanitize)
  assert.deepEqual(afterCollision, afterSanitize)
  assert.deepEqual(before.properties, readFile.properties)

  const ir = parseInboundToGemini(
    'gemini',
    {
      contents: [{ role: 'user', parts: [{ text: 'read' }] }],
      tools: [{ functionDeclarations: [{ name: 'read_file', parameters: readFile }] }],
    },
    { routeModel: 'gemini-4-argon-high', routeStream: false },
  )
  const agReq = buildGeminiRequest(ir, { target: 'antigravity' })
  assert.deepEqual(agReq.tools[0].functionDeclarations[0].parameters.required, ['path'])
  assert.deepEqual(Object.keys(agReq.tools[0].functionDeclarations[0].parameters.properties), ['path', 'offset'])
})

test('parseInboundToGemini + buildGeminiRequest convert all 4 protocols with history hardening', () => {
  // 1. OpenAI Chat: developer system, signed tool call via extra_content, tool result, reasoning_effort, json_schema
  const chatSig = Buffer.from('chat-sig').toString('base64')
  const chatIr = parseInboundToGemini('openai-chat', {
    model: 'gemini-3-pro',
    stream: true,
    reasoning_effort: 'high',
    temperature: 0.2,
    max_completion_tokens: 1024,
    response_format: {
      type: 'json_schema',
      json_schema: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
    tools: [
      {
        type: 'function',
        function: {
          name: '1get_weather',
          description: 'Weather lookup',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: '1get_weather' } },
    messages: [
      { role: 'developer', content: 'Be terse.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Weather in Tokyo?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_w1',
            type: 'function',
            function: { name: '1get_weather', arguments: '{"city":"Tokyo"}' },
            extra_content: { google: { thought_signature: chatSig } },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_w1', name: '1get_weather', content: '22C sunny' },
      // Duplicate tool result should be dropped.
      { role: 'tool', tool_call_id: 'call_w1', name: '1get_weather', content: 'duplicate' },
      { role: 'user', content: 'Summarize it.' },
    ],
  })
  assert.equal(chatIr.stream, true)
  assert.equal(chatIr.nativeTuiCompatible, false)
  assert.ok(chatIr.requiredCapabilities.includes('system_instruction'))
  assert.ok(chatIr.requiredCapabilities.includes('tools'))
  assert.ok(chatIr.requiredCapabilities.includes('generation_config'))
  assert.ok(chatIr.requiredCapabilities.includes('multi_turn'))

  const geminiReq = buildGeminiRequest(chatIr, { target: 'gemini' })
  assert.equal(geminiReq.systemInstruction.parts[0].text, 'Be terse.')
  assert.equal(geminiReq.tools[0].functionDeclarations[0].name, '_x_1get_weather')
  assert.ok(geminiReq.tools[0].functionDeclarations[0].parametersJsonSchema)
  assert.deepEqual(geminiReq.toolConfig, {
    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['_x_1get_weather'] },
  })
  assert.equal(geminiReq.generationConfig.thinkingConfig.thinkingLevel, 'high')
  assert.equal(geminiReq.generationConfig.responseMimeType, 'application/json')
  // FunctionResponse and follow-up user text must be in separate user contents.
  assert.equal(geminiReq.contents.length, 4)
  assert.equal(geminiReq.contents[0].parts[1].inlineData.mimeType, 'image/png')
  assert.equal(geminiReq.contents[1].parts[0].thoughtSignature, chatSig)
  assert.equal(geminiReq.contents[2].parts.length, 1)
  assert.deepEqual(geminiReq.contents[2].parts[0].functionResponse.response, { output: '22C sunny' })
  assert.equal(geminiReq.contents[3].parts[0].text, 'Summarize it.')

  // Antigravity target uses plain OpenAPI parameters and `result` key.
  const agReq = buildGeminiRequest(chatIr, { target: 'antigravity' })
  assert.ok(agReq.tools[0].functionDeclarations[0].parameters)
  assert.equal(agReq.tools[0].functionDeclarations[0].parametersJsonSchema, undefined)
  assert.deepEqual(agReq.contents[2].parts[0].functionResponse.response, { result: '22C sunny' })

  // 2. OpenAI Responses: instructions, function_call + missing output -> synthetic interrupted tool note
  const respIr = parseInboundToGemini('openai-responses', {
    model: 'gemini-2.5-flash',
    stream: false,
    instructions: 'Act as coder.',
    max_output_tokens: 200,
    reasoning: { effort: 'low' },
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run check' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'ignored foreign thought' }] },
      { type: 'function_call', call_id: 'fc_unanswered', name: 'run_check', arguments: '{"fast":true}' },
    ],
  })
  const respGemini = buildGeminiRequest(respIr, { target: 'gemini' })
  assert.equal(respGemini.generationConfig.thinkingConfig.thinkingBudget, 4096)
  // Unanswered function_call gets paired with synthetic functionResponse.
  assert.equal(respGemini.contents[1].parts[0].thoughtSignature, SKIP_THOUGHT_SIGNATURE)
  assert.equal(respGemini.contents[2].role, 'user')
  assert.equal(respGemini.contents[2].parts[0].functionResponse.id, 'fc_unanswered')
  assert.match(respGemini.contents[2].parts[0].functionResponse.response.output, /interrupted/i)

  // 3. Anthropic Messages: billing header stripped, signed tool_use ID unpacked, error tool_result
  const anthSig = Buffer.from('anth-sig').toString('base64')
  const signedAnthId = signedToolCallId('toolu_9', anthSig)
  const anthIr = parseInboundToGemini('anthropic', {
    model: 'gemini-2.5-pro',
    max_tokens: 300,
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc=123\nReal system prompt' }],
    thinking: { type: 'enabled', budget_tokens: 6000 },
    tools: [
      {
        name: 'bash',
        description: 'Run shell',
        input_schema: { type: 'object', properties: { cmd: { type: 'string' } } },
      },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'List files' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'ignored' },
          { type: 'tool_use', id: signedAnthId, name: 'bash', input: { cmd: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: signedAnthId, content: 'permission denied', is_error: true },
          { type: 'text', text: 'Try again' },
        ],
      },
    ],
  })
  const anthGemini = buildGeminiRequest(anthIr, { target: 'gemini' })
  assert.equal(anthGemini.systemInstruction.parts[0].text, 'Real system prompt')
  assert.equal(anthGemini.generationConfig.thinkingConfig.thinkingBudget, 6000)
  assert.equal(anthGemini.contents[1].parts[0].functionCall.id, 'toolu_9')
  assert.equal(anthGemini.contents[1].parts[0].thoughtSignature, anthSig)
  // Tool result and user text split into consecutive user contents.
  assert.deepEqual(anthGemini.contents[2].parts[0].functionResponse.response, { error: 'permission denied' })
  assert.equal(anthGemini.contents[3].parts[0].text, 'Try again')

  // 4. Google Gemini native snake_case + model-first boundary hardening
  const nativeIr = parseInboundToGemini(
    'gemini',
    {
      contents: [{ role: 'model', parts: [{ text: 'orphan model turn' }] }],
      tools: [{ google_search: {} }],
    },
    { routeModel: 'gemini-2.5-pro', routeStream: true },
  )
  const nativeReq = buildGeminiRequest(nativeIr, { target: 'gemini' })
  assert.equal(nativeReq.contents[0].role, 'user')
  assert.equal(nativeReq.contents[1].role, 'model')
  assert.equal(nativeReq.contents[2].role, 'user')
  assert.deepEqual(nativeReq.tools, [{ googleSearch: {} }])
})

test('classifyGeminiCapabilities enforces strict CRAG native_tui admission', () => {
  const plain = parseInboundToGemini('openai-chat', {
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'Hello Gemini!' }],
  })
  assert.equal(plain.nativeTuiCompatible, true)
  assert.deepEqual(plain.requiredCapabilities, [])
  assert.equal(plain.plainText, 'Hello Gemini!')

  // Slash command must not be admitted to native TUI.
  const slash = parseInboundToGemini('openai-chat', {
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'please run /quit' }],
  })
  assert.equal(slash.nativeTuiCompatible, false)
  assert.deepEqual(slash.requiredCapabilities, ['full_gemini_api'])
  assert.equal(slash.plainText, null)

  // Any extra parameter requires non-TUI capability.
  const withTemp = parseInboundToGemini('openai-chat', {
    model: 'gemini-2.5-flash',
    temperature: 0.7,
    messages: [{ role: 'user', content: 'Hello' }],
  })
  assert.equal(withTemp.nativeTuiCompatible, false)
  assert.ok(withTemp.requiredCapabilities.includes('generation_config'))

  // Gemini session validates strict shape.
  const session = parseInboundToGemini('gemini-session', { model: 'gemini-2.5-flash', input: 'hi' })
  assert.equal(session.nativeTuiCompatible, true)
  assert.throws(
    () => parseInboundToGemini('gemini-session', { model: 'gemini-2.5-flash', input: 'hi', temperature: 0.5 }),
    (err) => err.code === 'gemini_unsupported_turn' && err.status === 400,
  )
  assert.equal(classifyGeminiCapabilities(session).plainText, 'hi')
})

test('an empty safetySettings or cachedContent requests nothing and stays on the plain-text path (#1703)', () => {
  const ROUTE = { routeModel: 'gemini-2.5-flash' }
  const base = { contents: [{ role: 'user', parts: [{ text: 'Reply exactly: CONTROL_OK' }] }] }

  // Control: the same turn without the field is admitted.
  const control = parseInboundToGemini('gemini', { ...base }, ROUTE)
  assert.equal(control.nativeTuiCompatible, true)
  assert.equal(control.plainText, 'Reply exactly: CONTROL_OK')

  // An empty array carries no safety configuration at all, so it must not pull in
  // `generation_config`: doing so nulls `plainText`, and scheduler.mjs then answers
  // 400 gemini_unsupported_turn for a turn the native transport could have served.
  const emptySafety = parseInboundToGemini('gemini', { ...base, safetySettings: [] }, ROUTE)
  assert.equal(emptySafety.nativeTuiCompatible, true)
  assert.deepEqual(emptySafety.requiredCapabilities, [])
  assert.deepEqual(emptySafety.unsupportedFields, [])
  assert.equal(emptySafety.plainText, 'Reply exactly: CONTROL_OK')

  // Same reasoning for an empty cached-content name.
  const emptyCache = parseInboundToGemini('gemini', { ...base, cachedContent: '' }, ROUTE)
  assert.equal(emptyCache.nativeTuiCompatible, true)
  assert.deepEqual(emptyCache.requiredCapabilities, [])
  assert.equal(emptyCache.plainText, 'Reply exactly: CONTROL_OK')

  // A non-empty threshold is real configuration: it still requires the capability,
  // but the field is now named so the caller knows what to drop.
  const threshold = { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
  const realSafety = parseInboundToGemini('gemini', { ...base, safetySettings: [threshold] }, ROUTE)
  assert.equal(realSafety.nativeTuiCompatible, false)
  assert.ok(realSafety.requiredCapabilities.includes('generation_config'))
  assert.ok(realSafety.unsupportedFields.includes('safetySettings'))
  assert.equal(realSafety.plainText, null)

  const realCache = parseInboundToGemini('gemini', { ...base, cachedContent: 'cachedContents/abc123' }, ROUTE)
  assert.ok(realCache.requiredCapabilities.includes('generation_config'))
  assert.ok(realCache.unsupportedFields.includes('cachedContent'))

  // Other capabilities name their own caller-visible field too.
  const sysInstruction = { parts: [{ text: 'be terse' }] }
  const withSystem = parseInboundToGemini('gemini', { ...base, systemInstruction: sysInstruction }, ROUTE)
  assert.ok(withSystem.unsupportedFields.includes('systemInstruction'))
  const withTools = parseInboundToGemini('gemini', { ...base, tools: [{ googleSearch: {} }] }, ROUTE)
  assert.ok(withTools.unsupportedFields.includes('tools'))
})

test('SSE decoder, collector, non-streaming renderers, and streaming encoders work across all 4 protocols', () => {
  const thoughtSig = Buffer.from('thought-sig-1').toString('base64')
  const toolSig = Buffer.from('tool-sig-1').toString('base64')
  const rawSse = [
    ': keepalive\r\n\r\n',
    `data: ${JSON.stringify({
      response: {
        responseId: 'resp_001',
        modelVersion: 'gemini-2.5-pro',
        candidates: [
          { content: { role: 'model', parts: [{ text: 'Thinking...', thought: true, thoughtSignature: thoughtSig }] } },
        ],
        usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40 },
      },
    })}\n\n`,
    `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { text: 'Answer part 1. ' },
                {
                  functionCall: { id: 'fc_9', name: 'default_api:search_docs', args: { q: 'crag' } },
                  thoughtSignature: toolSig,
                },
              ],
            },
            groundingMetadata: {
              webSearchQueries: ['crag protocol'],
              groundingChunks: [{ web: { uri: 'https://example.test/crag', title: 'CRAG Docs' } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 40,
          candidatesTokenCount: 25,
          thoughtsTokenCount: 15,
          totalTokenCount: 140,
        },
      },
    })}\n\n`,
  ].join('')

  const decoder = createGeminiEventDecoder({ fallbackModel: 'gemini-2.5-pro' })
  const collector = createGeminiCollector({ fallbackModel: 'gemini-2.5-pro' })
  const encoders = {
    gemini: createGeminiProtocolStreamEncoder('gemini', { model: 'gemini-2.5-pro' }),
    'openai-chat': createGeminiProtocolStreamEncoder('openai-chat', { model: 'gemini-2.5-pro' }),
    'openai-responses': createGeminiProtocolStreamEncoder('openai-responses', { model: 'gemini-2.5-pro' }),
    anthropic: createGeminiProtocolStreamEncoder('anthropic', { model: 'gemini-2.5-pro' }),
  }
  const outputs = { gemini: '', 'openai-chat': '', 'openai-responses': '', anthropic: '' }

  const splitter = createSseFrameSplitter((frame) => {
    decoder.decodeSseFrame(frame, (event) => {
      collector.push(event)
      for (const proto of Object.keys(encoders)) {
        outputs[proto] += encoders[proto].push(event)
      }
    })
  })
  // Push in irregular chunks to verify incremental framing.
  for (let i = 0; i < rawSse.length; i += 23) {
    splitter.push(rawSse.slice(i, i + 23))
  }
  splitter.flush()
  for (const proto of Object.keys(encoders)) {
    outputs[proto] += encoders[proto].finish()
  }

  const collected = collector.result()
  assert.equal(collected.sawFinish, true)
  assert.equal(collected.thinking, 'Thinking...')
  assert.equal(collected.text, 'Answer part 1. ')
  assert.equal(collected.toolCalls.length, 1)
  assert.equal(collected.toolCalls[0].name, 'search_docs')
  assert.equal(collected.stopReason, 'tool')
  assert.deepEqual(collected.usage, {
    input_tokens: 60,
    output_tokens: 40,
    cache_read_tokens: 40,
    reasoning_tokens: 15,
    total_tokens: 140,
  })

  // Verify usage helpers
  assert.deepEqual(
    normalizeGeminiUsage({
      promptTokenCount: 100,
      cachedContentTokenCount: 40,
      candidatesTokenCount: 25,
      thoughtsTokenCount: 15,
      totalTokenCount: 140,
    }),
    collected.usage,
  )
  assert.equal(toGoogleUsageMetadata(collected.usage).cachedContentTokenCount, 40)
  assert.equal(toOpenAIChatUsage(collected.usage).completion_tokens_details.reasoning_tokens, 15)
  assert.equal(toOpenAIResponsesUsage(collected.usage).input_tokens_details.cached_tokens, 40)
  assert.equal(toAnthropicUsage(collected.usage).cache_read_input_tokens, 40)

  // Non-streaming renderers across all 5 protocols
  const gemJson = renderGeminiProtocolResponse('gemini', collected, { model: 'gemini-2.5-pro' })
  assert.equal(gemJson.candidates[0].groundingMetadata.webSearchQueries[0], 'crag protocol')
  assert.equal(gemJson.candidates[0].content.parts[0].thoughtSignature, thoughtSig)

  const chatJson = renderGeminiProtocolResponse('openai-chat', collected, { model: 'gemini-2.5-pro' })
  assert.equal(chatJson.choices[0].finish_reason, 'tool_calls')
  assert.equal(chatJson.choices[0].message.reasoning_content, 'Thinking...')
  assert.equal(chatJson.choices[0].message.tool_calls[0].extra_content.google.thought_signature, toolSig)
  assert.deepEqual(unsignedToolCallId(chatJson.choices[0].message.tool_calls[0].id), { id: 'fc_9', signature: toolSig })

  const respJson = renderGeminiProtocolResponse('openai-responses', collected, { model: 'gemini-2.5-pro' })
  assert.equal(
    respJson.output.some((item) => item.type === 'reasoning'),
    true,
  )
  assert.equal(
    respJson.output.some((item) => item.type === 'function_call' && item.name === 'search_docs'),
    true,
  )

  const anthJson = renderGeminiProtocolResponse('anthropic', collected, { model: 'gemini-2.5-pro' })
  assert.equal(anthJson.stop_reason, 'tool_use')
  assert.equal(anthJson.content[0].type, 'thinking')
  assert.equal(anthJson.content[0].signature, thoughtSig)
  assert.equal(anthJson.content[2].type, 'tool_use')
  assert.deepEqual(unsignedToolCallId(anthJson.content[2].id), { id: 'fc_9', signature: toolSig })

  const sessJson = renderGeminiProtocolResponse('gemini-session', collected, {
    model: 'gemini-2.5-pro',
    sessionId: 's1',
    accountId: 'acc1',
  })
  assert.equal(sessJson.id, 's1')
  assert.equal(sessJson.account_id, 'acc1')
  assert.equal(sessJson.tool_calls[0].name, 'search_docs')

  // Streaming wire outputs across all 4 protocols
  assert.match(outputs.gemini, /"thoughtSignature":/)
  assert.match(outputs.gemini, /"groundingMetadata":/)
  assert.match(outputs['openai-chat'], /"reasoning_content":"Thinking\.\.\."/)
  assert.match(outputs['openai-chat'], /"finish_reason":"tool_calls"/)
  assert.match(outputs['openai-chat'], /data: \[DONE\]\n\n$/)
  assert.match(outputs['openai-responses'], /event: response\.reasoning_summary_text\.delta/)
  assert.match(outputs['openai-responses'], /event: response\.function_call_arguments\.done/)
  assert.match(outputs['openai-responses'], /event: response\.completed/)
  assert.match(outputs.anthropic, /event: message_start/)
  assert.match(outputs.anthropic, /"type":"signature_delta"/)
  assert.match(outputs.anthropic, /"type":"input_json_delta"/)
  assert.match(outputs.anthropic, /"stop_reason":"tool_use"/)
  assert.match(outputs.anthropic, /event: message_stop/)
})

test('error formatting produces protocol-native JSON and SSE errors', () => {
  const gemErr = formatGeminiProtocolError('gemini', 429, 'gemini_quota_exhausted', 'quota exhausted')
  assert.equal(gemErr.error.status, 'RESOURCE_EXHAUSTED')
  assert.equal(gemErr.error.details[0].reason, 'gemini_quota_exhausted')

  const anthErr = formatGeminiProtocolError('anthropic', 400, 'gemini_unsupported_turn', 'bad turn')
  assert.equal(anthErr.type, 'error')
  assert.equal(anthErr.error.type, 'invalid_request_error')

  assert.match(
    formatGeminiProtocolStreamError('anthropic', 502, 'gemini_inference_failed', 'boom'),
    /^event: error\ndata: /,
  )
  assert.match(
    formatGeminiProtocolStreamError('openai-responses', 502, 'gemini_inference_failed', 'boom'),
    /^event: error\ndata: /,
  )
  assert.match(
    formatGeminiProtocolStreamError('openai-chat', 502, 'gemini_inference_failed', 'boom'),
    /data: \[DONE\]\n\n$/,
  )
  assert.equal(
    parseGeminiSseFrame('data: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"slow down"}}\n\n').status,
    429,
  )
})

test('hardened tool-call ID signing, data URLs, native thinking round-trip, and SSE error status', () => {
  // Tool call ID containing an earlier false `__ts1__` marker still unpacks real signature suffix.
  const sig = Buffer.from('sig-with-false-prefix').toString('base64')
  const embedded = signedToolCallId('call__ts1__x', sig)
  assert.deepEqual(unsignedToolCallId(embedded), { id: 'call__ts1__x', signature: sig })

  // Zero-digit marker and non-canonical base64url must fail closed.
  assert.deepEqual(unsignedToolCallId('call__ts__YWJj'), { id: 'call__ts__YWJj', signature: '' })
  assert.deepEqual(unsignedToolCallId('call__ts4__YWJ='), { id: 'call__ts4__YWJ=', signature: '' })

  // Malformed percent-encoding in non-base64 data URL does not throw uncaught URIError.
  assert.throws(
    () =>
      parseInboundToGemini('openai-chat', {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:text/plain,%ZZ' } }] }],
      }),
    (err) => err.code === 'gemini_invalid_request' && err.status === 400,
  )

  // Native Gemini signed thinking parts round-trip on Gemini target, while unsigned/Claude drop them.
  const nativeSig = Buffer.from('native-thought-sig').toString('base64')
  const nativeIr = parseInboundToGemini(
    'gemini',
    {
      contents: [
        { role: 'user', parts: [{ text: 'Solve 2+2' }] },
        {
          role: 'model',
          parts: [
            { text: 'Signed thought', thought: true, thoughtSignature: nativeSig },
            { text: 'Unsigned thought', thought: true },
            { text: '4' },
          ],
        },
        { role: 'user', parts: [{ text: 'Now +3' }] },
      ],
    },
    { routeModel: 'gemini-2.5-pro' },
  )
  const gemOut = buildGeminiRequest(nativeIr, { target: 'gemini' })
  assert.deepEqual(gemOut.contents[1].parts, [
    { text: 'Signed thought', thought: true, thoughtSignature: nativeSig },
    { text: '4' },
  ])
  const claudeOut = buildGeminiRequest(nativeIr, { target: 'antigravity', model: 'claude-sonnet-4-5' })
  assert.deepEqual(claudeOut.contents[1].parts, [{ text: '4' }])

  // `event: error` frames keep integer HTTP status even when `error.code` is a string.
  const strCodeErr = parseGeminiSseFrame(
    'event: error\ndata: {"error":{"code":"gemini_quota_exhausted","message":"limit"}}\n\n',
  )
  assert.equal(strCodeErr.kind, 'error')
  assert.equal(strCodeErr.status, 502)
  assert.equal(strCodeErr.code, 'gemini_quota_exhausted')

  const explicitStatusErr = parseGeminiSseFrame(
    'event: error\ndata: {"status":429,"error":{"code":"gemini_quota_exhausted","message":"limit"}}\n\n',
  )
  assert.equal(explicitStatusErr.status, 429)
  assert.equal(explicitStatusErr.code, 'gemini_quota_exhausted')
})

test('SSE splitter preserves split multi-byte UTF-8 and Anthropic stream separates signed thinking + final usage', () => {
  // Split raw UTF-8 bytes mid-character (3-byte CJK + 4-byte emoji).
  const payload = Buffer.from('data: {"text":"你好世界🚀"}\n\n', 'utf8')
  const frames = []
  const splitter = createSseFrameSplitter((frame) => frames.push(frame))
  for (let i = 0; i < payload.length; i += 2) {
    splitter.push(payload.subarray(i, i + 2))
  }
  splitter.flush()
  assert.equal(frames.length, 1)
  assert.equal(JSON.parse(frames[0].slice(6).trim()).text, '你好世界🚀')

  // Multiple signed thinking parts do not overwrite signatures in collector or merge blocks in Anthropic SSE.
  const sig1 = Buffer.from('thought-sig-one').toString('base64')
  const sig2 = Buffer.from('thought-sig-two').toString('base64')
  const events = [
    { kind: 'start', responseId: 'r_multi', model: 'gemini-2.5-pro' },
    { kind: 'thinking', text: 'Part A' },
    { kind: 'thinking_signature', signature: sig1 },
    { kind: 'thinking', text: 'Part B' },
    { kind: 'thinking_signature', signature: sig2 },
    { kind: 'text', text: 'Final answer' },
    {
      kind: 'usage',
      usage: { input_tokens: 120, output_tokens: 30, cache_read_tokens: 45, reasoning_tokens: 10, total_tokens: 195 },
    },
    { kind: 'stop', stopReason: 'stop', finishReason: 'STOP' },
  ]
  const collector = createGeminiCollector({ fallbackModel: 'gemini-2.5-pro' })
  const encoder = createGeminiProtocolStreamEncoder('anthropic', { model: 'gemini-2.5-pro' })
  let sseOut = ''
  for (const ev of events) {
    collector.push(ev)
    sseOut += encoder.push(ev)
  }
  sseOut += encoder.finish()

  const collected = collector.result()
  const thinkingParts = collected.parts.filter((p) => p.kind === 'thinking')
  assert.deepEqual(thinkingParts, [
    { kind: 'thinking', text: 'Part A', signature: sig1 },
    { kind: 'thinking', text: 'Part B', signature: sig2 },
  ])

  // Parse emitted Anthropic SSE frames to verify block boundaries and final message_delta usage.
  const parsedSse = sseOut
    .trim()
    .split('\n\n')
    .map((block) => {
      const lines = block.split('\n')
      return {
        event: lines[0].replace(/^event:\s*/, ''),
        data: JSON.parse(lines[1].replace(/^data:\s*/, '')),
      }
    })
  const thinkingStarts = parsedSse.filter(
    (e) => e.event === 'content_block_start' && e.data.content_block.type === 'thinking',
  )
  assert.equal(thinkingStarts.length, 2)
  assert.equal(thinkingStarts[0].data.index, 0)
  assert.equal(thinkingStarts[1].data.index, 1)

  const sig1Idx = parsedSse.findIndex(
    (e) => e.data?.delta?.type === 'signature_delta' && e.data.delta.signature === sig1,
  )
  const stop0Idx = parsedSse.findIndex((e) => e.event === 'content_block_stop' && e.data.index === 0)
  const start1Idx = parsedSse.findIndex((e) => e.event === 'content_block_start' && e.data.index === 1)
  assert.ok(sig1Idx > 0 && stop0Idx > sig1Idx && start1Idx > stop0Idx)

  const msgDelta = parsedSse.find((e) => e.event === 'message_delta')
  assert.deepEqual(msgDelta.data.usage, {
    input_tokens: 120,
    output_tokens: 30,
    cache_read_input_tokens: 45,
  })
})

function passesCragValidText(text) {
  if (typeof text !== 'string' || !text.trim() || !text.isWellFormed()) return false
  if (/[^\P{Cc}\n\r\t]/u.test(text)) return false
  return !text.split(/\p{White_Space}+/u).some((word) => word.startsWith('/'))
}

test('antigravity target sanitizes CLI slash tokens, control chars, billing headers, and empty turns', () => {
  assert.equal(stripIllegalControlChars('\x1b[31mFAIL\x1b[0m\x00\x08\x7f\u0085\nok\t!'), 'FAIL\nok\t!')
  assert.equal(escapeNativeTuiSlashes('https://example.test/a foo/bar'), 'https://example.test/a foo/bar')
  assert.ok(
    passesCragValidText(sanitizeNativeTuiText('/quit\n/clear a / b // comment /mnt/x/vm2api \x1b[32mOK\x1b[0m')),
  )

  // Claude Code multi-turn payload with slash paths, ANSI logs, billing headers,
  // server_tool_use/web_search_tool_result, mid-conversation system, empty tool_result, and trailing empty assistant.
  const anthIr = parseInboundToGemini('anthropic', {
    model: 'gemini-3.8-flash-high',
    max_tokens: 1024,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1; cch=abc' },
      {
        type: 'text',
        text: 'Inspect /etc/hosts\x1b[33m carefully\x1b[0m.\n```\nx-anthropic-billing-header: keep-in-code\n```',
      },
    ],
    messages: [
      { role: 'system', content: 'Leading system rule.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '(no content)' },
          {
            type: 'text',
            text: 'x-anthropic-billing-header: cc_version=2.1; cch=abc\nRead /mnt/x/vm2api/src/server.mjs and check a / b\x00',
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'test' } },
          { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'read_file',
            input: { path: '/mnt/x/vm2api/src/server.mjs', stale: '[undefined]' },
          },
          { type: 'tool_use', id: 'toolu_2', name: 'run_cmd', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '\x1b[32mOK\x1b[0m at /mnt/x/vm2api/src/server.mjs' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: '', is_error: true },
        ],
      },
      { role: 'system', content: 'Mid-turn reminder for /tmp/work' },
      { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
    ],
  })

  const agReq = buildGeminiRequest(anthIr, { target: 'antigravity' })

  // System instruction strips billing header & ANSI/control chars, keeps fenced code & legitimate `/` paths.
  assert.ok(agReq.systemInstruction.parts[0].text.includes('Inspect /etc/hosts carefully.'))
  assert.ok(agReq.systemInstruction.parts[0].text.includes('Leading system rule.'))
  assert.ok(agReq.systemInstruction.parts[0].text.includes('x-anthropic-billing-header: keep-in-code'))
  assert.ok(!agReq.systemInstruction.parts[0].text.includes('cc_version=2.1'))
  assert.equal(/[^\P{Cc}\n\r\t]/u.test(agReq.systemInstruction.parts[0].text), false)

  // Trailing empty assistant turn popped; final turn is user with valid CRAGGemini text.
  assert.equal(agReq.contents[agReq.contents.length - 1].role, 'user')

  // Tool call args preserve literal absolute path and strip `[undefined]` keys.
  const fcTurn = agReq.contents.find((c) => c.parts.some((p) => p.functionCall))
  assert.deepEqual(fcTurn.parts[0].functionCall.args, { path: '/mnt/x/vm2api/src/server.mjs' })

  // Every text part and functionResponse string passes CRAGGemini's valid_text check.
  for (const turn of agReq.contents) {
    for (const part of turn.parts) {
      if (typeof part.text === 'string') {
        assert.ok(passesCragValidText(part.text), `Expected CRAGGemini-safe text, got: ${JSON.stringify(part.text)}`)
      }
      if (part.functionResponse) {
        const serialized = JSON.stringify(part.functionResponse.response)
        assert.ok(
          passesCragValidText(`[Tool Result \`${part.functionResponse.name}\`]: ${serialized}`),
          `Expected CRAGGemini-safe tool response, got: ${serialized}`,
        )
      }
    }
  }
  const frTurn = agReq.contents.find((c) => c.parts.some((p) => p.functionResponse))
  assert.equal(frTurn.parts[1].functionResponse.response.result, 'Tool execution failed with no output.')

  // Billing-only or whitespace/placeholder-only user turn normalizes to fallback '.' instead of empty text.
  const emptyIr = parseInboundToGemini('anthropic', {
    model: 'gemini-3.8-flash-high',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2; cch=1' }] }],
  })
  const emptyAg = buildGeminiRequest(emptyIr, { target: 'antigravity' })
  assert.deepEqual(emptyAg.contents, [{ role: 'user', parts: [{ text: '.' }] }])
  assert.ok(passesCragValidText(emptyAg.contents[0].parts[0].text))
})

test('antigravity target strips CRAGGemini-disallowed fields (safetySettings, cachedContent, fileData, unsupported googleTools, non-standard schema types, invalid imageConfig)', () => {
  const CRAGGEMINI_ALLOWED_KEYS = new Set([
    'model',
    'stream',
    'contents',
    'messages',
    'input',
    'system',
    'systemInstruction',
    'system_instruction',
    'instructions',
    'system_prompt_mode',
    'crag_prompt',
    'tools',
    'toolConfig',
    'tool_config',
    'tool_choice',
    'generationConfig',
    'generation_config',
    'web_search_options',
    'thinking',
    'max_tokens',
    'temperature',
    'top_p',
    'top_k',
    'stop',
    'stop_sequences',
    'conversation_id',
    'previous_response_id',
    'metadata',
    'parallel_tool_calls',
    'reasoning',
    'response_format',
    'subagents',
  ])
  const CRAGGEMINI_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])

  // 1. Minimal @ai-sdk/google request with safetySettings + cachedContent + invalid imageConfig.
  const aiSdkPayload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Check this file' },
          { fileData: { mimeType: 'application/pdf', fileUri: 'https://example.test/docs/spec.pdf' } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024,
      imageConfig: { aspectRatio: '99:99', imageSize: '8K' },
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    ],
    cachedContent: 'cachedContents/abc123',
    tools: [
      {
        functionDeclarations: [
          {
            name: 'inspect_data',
            description: 'Inspect structured data',
            parameters: {
              type: 'OBJECT',
              properties: {
                score: { type: 'float' },
                count: { type: ['int64', 'null'] },
                flag: { type: 'bool' },
                anything: { type: 'any' },
                meta: { type: 'dict' },
                tags: { type: 'list', items: { type: 'string' } },
              },
              required: ['score', 'count'],
            },
          },
        ],
      },
    ],
  }

  const ir = parseInboundToGemini('gemini', aiSdkPayload, { routeModel: 'gemini-4-neon-high', routeStream: true })
  const agReq = buildGeminiRequest(ir, { target: 'antigravity' })

  for (const key of Object.keys(agReq)) {
    assert.ok(CRAGGEMINI_ALLOWED_KEYS.has(key), `Unexpected top-level key for CRAGGemini: ${key}`)
  }
  assert.equal('safetySettings' in agReq, false)
  assert.equal('cachedContent' in agReq, false)
  assert.equal('imageConfig' in (agReq.generationConfig || {}), false)

  // fileData downgraded to sanitized text reference instead of unsupported fileData part.
  assert.equal(
    agReq.contents.some((turn) => turn.parts.some((p) => 'fileData' in p)),
    false,
  )
  assert.ok(
    agReq.contents[0].parts.some(
      (p) => typeof p.text === 'string' && p.text.includes('https://example.test/docs/spec.pdf'),
    ),
  )

  // Non-standard schema types normalized or omitted so craggemini::project_tool_schema accepts them.
  const props = agReq.tools[0].functionDeclarations[0].parameters.properties
  assert.equal(props.score.type, 'number')
  assert.equal(props.count.type, 'integer')
  assert.equal(props.count.nullable, true)
  assert.equal(props.flag.type, 'boolean')
  assert.equal(props.anything.type, undefined)
  assert.equal(props.meta.type, 'object')
  assert.equal(props.tags.type, 'array')
  for (const prop of Object.values(props)) {
    if (prop.type !== undefined) {
      assert.ok(CRAGGEMINI_SCHEMA_TYPES.has(prop.type), `Invalid schema type for CRAGGemini: ${prop.type}`)
    }
  }

  // Direct Gemini API target still preserves real safetySettings, cachedContent, and fileData.
  const directReq = buildGeminiRequest(ir, { target: 'gemini' })
  assert.equal(directReq.safetySettings.length, 4)
  assert.equal(directReq.cachedContent, 'cachedContents/abc123')
  assert.equal(directReq.contents[0].parts[1].fileData.fileUri, 'https://example.test/docs/spec.pdf')

  // Empty safetySettings/cachedContent are omitted on both targets.
  const emptyCfgIr = parseInboundToGemini(
    'gemini',
    { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], safetySettings: [], cachedContent: '' },
    { routeModel: 'gemini-4-neon-high', routeStream: false },
  )
  assert.equal('safetySettings' in buildGeminiRequest(emptyCfgIr, { target: 'gemini' }), false)
  assert.equal('cachedContent' in buildGeminiRequest(emptyCfgIr, { target: 'gemini' }), false)
  assert.equal('safetySettings' in buildGeminiRequest(emptyCfgIr, { target: 'antigravity' }), false)

  // Unsupported googleTools (codeExecution, googleMaps) filtered for antigravity; urlContext & googleSearch preserved.
  const googleToolsIr = parseInboundToGemini(
    'gemini',
    {
      contents: [{ role: 'user', parts: [{ text: 'search news' }] }],
      tools: [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }, { googleMaps: {} }],
    },
    { routeModel: 'gemini-4-neon-high', routeStream: false },
  )
  const agToolsReq = buildGeminiRequest(googleToolsIr, { target: 'antigravity' })
  assert.deepEqual(agToolsReq.tools, [{ googleSearch: {} }, { urlContext: {} }])

  const unsupportedOnlyIr = parseInboundToGemini(
    'gemini',
    {
      contents: [{ role: 'user', parts: [{ text: 'run python' }] }],
      tools: [{ codeExecution: {} }],
    },
    { routeModel: 'gemini-4-neon-high', routeStream: false },
  )
  assert.equal('tools' in buildGeminiRequest(unsupportedOnlyIr, { target: 'antigravity' }), false)
  assert.deepEqual(buildGeminiRequest(unsupportedOnlyIr, { target: 'gemini' }).tools, [{ codeExecution: {} }])
})

test('minimal CRAGGemini ingress strips non-image generationConfig & thoughts uniformly across all 4 protocols', () => {
  const MINIMAL_KEYS = new Set([
    'model',
    'contents',
    'systemInstruction',
    'tools',
    'toolConfig',
    'generationConfig',
    'conversation_id',
  ])
  const weatherSchema = {
    type: 'object',
    properties: {
      city: { type: 'string' },
      unit: { type: 'string', enum: ['c', 'f'] },
    },
    required: ['city'],
  }

  const samples = [
    [
      'gemini',
      {
        systemInstruction: { parts: [{ text: 'Be concise.' }] },
        contents: [
          { role: 'user', parts: [{ text: 'Check weather' }] },
          {
            role: 'model',
            parts: [
              { thought: true, text: 'internal thoughts' },
              { text: 'Sure', thoughtSignature: SKIP_THOUGHT_SIGNATURE },
            ],
          },
          { role: 'user', parts: [{ text: 'For Tokyo' }] },
        ],
        tools: [
          { functionDeclarations: [{ name: 'get_weather', description: 'Get weather', parameters: weatherSchema }] },
          { googleSearch: {} },
        ],
        generationConfig: {
          temperature: 0.7,
          topP: 0.9,
          topK: 40,
          maxOutputTokens: 256,
          stopSequences: ['STOP_HERE'],
          thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
          responseMimeType: 'application/json',
        },
        conversationId: 'conv_shared_01',
      },
      { routeModel: 'gemini-3-pro', routeStream: true },
    ],
    [
      'openai-chat',
      {
        model: 'gemini-3-pro',
        stream: true,
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 256,
        stop: ['STOP_HERE'],
        reasoning_effort: 'high',
        response_format: { type: 'json_object' },
        conversation_id: 'conv_shared_01',
        web_search_options: { search_context_size: 'low' },
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Check weather' },
          { role: 'assistant', content: 'Sure' },
          { role: 'user', content: 'For Tokyo' },
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', description: 'Get weather', parameters: weatherSchema },
          },
        ],
      },
      {},
    ],
    [
      'openai-responses',
      {
        model: 'gemini-3-pro',
        stream: true,
        instructions: 'Be concise.',
        temperature: 0.7,
        top_p: 0.9,
        max_output_tokens: 256,
        reasoning: { effort: 'high' },
        text: { format: { type: 'json_object' } },
        conversation_id: 'conv_shared_01',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check weather' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Sure' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'For Tokyo' }] },
        ],
        tools: [
          { type: 'function', name: 'get_weather', description: 'Get weather', parameters: weatherSchema },
          { type: 'web_search' },
        ],
      },
      {},
    ],
    [
      'anthropic',
      {
        model: 'gemini-3-pro',
        stream: true,
        system: 'Be concise.',
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
        max_tokens: 256,
        stop_sequences: ['STOP_HERE'],
        thinking: { type: 'enabled', budget_tokens: 4096 },
        output_format: { type: 'json_object' },
        conversation_id: 'conv_shared_01',
        messages: [
          { role: 'user', content: 'Check weather' },
          { role: 'assistant', content: 'Sure' },
          { role: 'user', content: 'For Tokyo' },
        ],
        tools: [
          { name: 'get_weather', description: 'Get weather', input_schema: weatherSchema },
          { type: 'web_search_20250305', name: 'web_search' },
        ],
      },
      {},
    ],
  ]

  const declSnapshots = []
  for (const [protocol, payload, opts] of samples) {
    const ir = parseInboundToGemini(protocol, payload, opts)
    const agReq = buildGeminiRequest(ir, { target: 'antigravity' })

    for (const key of Object.keys(agReq)) {
      assert.ok(MINIMAL_KEYS.has(key), `[${protocol}] unexpected key in minimal CRAGGemini body: ${key}`)
    }
    assert.equal('generationConfig' in agReq, false, `[${protocol}] non-image generationConfig must be stripped`)
    assert.equal('toolConfig' in agReq, false, `[${protocol}] redundant AUTO toolConfig should be omitted`)
    assert.equal(agReq.conversation_id, 'conv_shared_01')
    assert.equal(agReq.contents.length, 3, `[${protocol}] should preserve 3-turn history`)
    for (const turn of agReq.contents) {
      for (const part of turn.parts) {
        assert.notEqual(part.thought, true, `[${protocol}] thought history must be stripped`)
        assert.notEqual(part.thoughtSignature, SKIP_THOUGHT_SIGNATURE, `[${protocol}] dummy signature must be stripped`)
      }
    }
    assert.ok(agReq.systemInstruction.parts[0].text.includes('Be concise.'))
    assert.ok(agReq.systemInstruction.parts[0].text.includes('JSON'), `[${protocol}] json response format directive`)
    assert.equal(agReq.tools.length, 2, `[${protocol}] must combine functionDeclarations + googleSearch`)
    assert.deepEqual(agReq.tools[1], { googleSearch: {} })
    declSnapshots.push(agReq.tools[0].functionDeclarations[0])
  }

  for (let i = 1; i < declSnapshots.length; i += 1) {
    assert.deepEqual(
      declSnapshots[i],
      declSnapshots[0],
      'all 4 protocols must produce identical wire functionDeclaration',
    )
  }

  // tool_choice: none omits BOTH tools and toolConfig on antigravity
  const noneIr = parseInboundToGemini('openai-chat', {
    model: 'gemini-3-pro',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: weatherSchema } }],
    tool_choice: 'none',
  })
  const noneAg = buildGeminiRequest(noneIr, { target: 'antigravity' })
  assert.equal('tools' in noneAg, false)
  assert.equal('toolConfig' in noneAg, false)

  // Image generation preserves ONLY image-specific generationConfig on antigravity
  const imgIr = parseInboundToGemini(
    'gemini',
    {
      contents: [{ role: 'user', parts: [{ text: 'Draw a cat' }] }],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: 2048,
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
        candidateCount: 2,
      },
    },
    { routeModel: 'gemini-3-pro', routeStream: false },
  )
  const imgAg = buildGeminiRequest(imgIr, { target: 'antigravity' })
  assert.deepEqual(imgAg.generationConfig, {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
    candidateCount: 2,
  })

  // Audio output requests fail closed with 400
  assert.throws(
    () =>
      parseInboundToGemini(
        'gemini',
        {
          contents: [{ role: 'user', parts: [{ text: 'speak' }] }],
          generationConfig: { responseModalities: ['AUDIO'] },
        },
        { routeModel: 'gemini-3-pro' },
      ),
    { status: 400 },
  )
  assert.throws(
    () =>
      parseInboundToGemini('openai-chat', {
        model: 'gemini-3-pro',
        modalities: ['text', 'audio'],
        messages: [{ role: 'user', content: 'speak' }],
      }),
    { status: 400 },
  )

  // Malformed non-object json_schema.schema fails closed with 400 across Chat, Responses, and Anthropic
  assert.throws(
    () =>
      parseInboundToGemini('openai-chat', {
        model: 'gemini-3-pro',
        messages: [{ role: 'user', content: 'count' }],
        response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: 'object' } },
      }),
    { status: 400 },
  )
  assert.throws(
    () =>
      parseInboundToGemini('openai-responses', {
        model: 'gemini-3-pro',
        input: 'count',
        text: { format: { type: 'json_schema', schema: 'object' } },
      }),
    { status: 400 },
  )
  assert.throws(
    () =>
      parseInboundToGemini('anthropic', {
        model: 'gemini-3-pro',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'count' }],
        output_format: { type: 'json_schema', schema: 'object' },
      }),
    { status: 400 },
  )
})

test('multi-protocol tool shapes align to wire declarations and restore natively in JSON and SSE', () => {
  // 1. OpenAI Chat custom tool + allowed_tools + legacy functions
  const chatCustomIr = parseInboundToGemini('openai-chat', {
    model: 'gemini-3-pro',
    messages: [{ role: 'user', content: 'Run SQL' }],
    tools: [
      { type: 'custom', custom: { name: 'sql.runner', description: 'Run SQL', format: { type: 'text' } } },
      { type: 'function', function: { name: 'ping', parameters: { type: 'object', properties: {} } } },
    ],
    tool_choice: {
      type: 'allowed_tools',
      allowed_tools: { mode: 'required', tools: [{ type: 'custom', custom: { name: 'sql.runner' } }] },
    },
  })
  const chatCustomAg = buildGeminiRequest(chatCustomIr, { target: 'antigravity' })
  const sqlWireName = chatCustomIr.tools[0].wireName
  assert.match(sqlWireName, /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/)
  assert.equal(chatCustomAg.toolConfig.functionCallingConfig.mode, 'ANY')
  assert.deepEqual(chatCustomAg.toolConfig.functionCallingConfig.allowedFunctionNames, [sqlWireName])

  const customEvents = []
  const customRestore = createGeminiRestoreTransform(chatCustomIr.restoreContext, {
    target: 'antigravity',
    model: 'gemini-3-pro',
  })
  const customCollector = createGeminiCollector({ fallbackModel: 'gemini-3-pro' })
  const customEnc = createGeminiProtocolStreamEncoder('openai-chat', {
    model: 'gemini-3-pro',
    restoreContext: chatCustomIr.restoreContext,
  })
  const customSse = []
  for (const ev of [
    { kind: 'start', responseId: 'r1', model: 'gemini-3-pro' },
    {
      kind: 'tool_call',
      id: 'c1',
      signedId: 'c1',
      name: `mcp__craggemini__${sqlWireName}`,
      args: { input: 'SELECT 1' },
      signature: '',
    },
    { kind: 'stop', finishReason: 'STOP', stopReason: 'tool' },
  ]) {
    customRestore.push(ev, (out) => {
      customEvents.push(out)
      customCollector.push(out)
      const chunk = customEnc.push(out)
      if (chunk) customSse.push(chunk)
    })
  }
  customSse.push(customEnc.finish())
  const chatCustomJson = renderGeminiProtocolResponse('openai-chat', customCollector.result(), {
    model: 'gemini-3-pro',
    restoreContext: chatCustomIr.restoreContext,
  })
  assert.equal(chatCustomJson.choices[0].message.tool_calls[0].type, 'custom')
  assert.deepEqual(chatCustomJson.choices[0].message.tool_calls[0].custom, { name: 'sql.runner', input: 'SELECT 1' })
  assert.match(customSse.join(''), /"type":"custom".*"name":"sql\.runner".*"input":"SELECT 1"/)

  // Legacy functions -> message.function_call + finish_reason: 'function_call'
  const legacyIr = parseInboundToGemini('openai-chat', {
    model: 'gemini-3-pro',
    messages: [
      { role: 'user', content: 'lookup' },
      { role: 'assistant', function_call: { name: 'lookup_item', arguments: '{"id":1}' } },
      { role: 'function', name: 'lookup_item', content: '{"ok":true}' },
    ],
    functions: [{ name: 'lookup_item', parameters: { type: 'object', properties: { id: { type: 'integer' } } } }],
  })
  assert.equal(legacyIr.restoreContext.legacyFunctions, true)
  assert.equal(legacyIr.restoreContext.disableParallelTools, true)
  const legacyCollector = createGeminiCollector({ fallbackModel: 'gemini-3-pro' })
  const legacyRestore = createGeminiRestoreTransform(legacyIr.restoreContext, { target: 'antigravity' })
  for (const ev of [
    { kind: 'start', responseId: 'r2', model: 'gemini-3-pro' },
    { kind: 'tool_call', id: 'c2', signedId: 'c2', name: 'lookup_item', args: { id: 2 }, signature: '' },
    { kind: 'tool_call', id: 'c3', signedId: 'c3', name: 'lookup_item', args: { id: 3 }, signature: '' },
    { kind: 'stop', finishReason: 'STOP', stopReason: 'tool' },
  ]) {
    legacyRestore.push(ev, (out) => legacyCollector.push(out))
  }
  const legacyJson = renderGeminiProtocolResponse('openai-chat', legacyCollector.result(), {
    model: 'gemini-3-pro',
    restoreContext: legacyIr.restoreContext,
  })
  assert.equal(legacyJson.choices[0].finish_reason, 'function_call')
  assert.deepEqual(legacyJson.choices[0].message.function_call, { name: 'lookup_item', arguments: '{"id":2}' })
  assert.equal(legacyCollector.result().toolCalls.length, 1, 'legacyFunctions disables parallel tool calls')

  // 2. OpenAI Responses namespace + custom + local_shell + apply_patch + computer + tool_search + image_generation
  const respIr = parseInboundToGemini('openai-responses', {
    model: 'gemini-3-pro',
    input: [
      { type: 'agent_message', content: 'Coordinate edits' },
      {
        type: 'additional_tools',
        tools: [{ type: 'apply_patch' }],
      },
    ],
    tools: [
      {
        type: 'namespace',
        name: 'collaboration',
        tools: [
          {
            type: 'function',
            name: 'send_msg',
            parameters: { type: 'object', properties: { body: { type: 'string' } } },
          },
        ],
      },
      { type: 'custom', name: 'dsl_exec' },
      { type: 'local_shell' },
      { type: 'computer_use_preview' },
      { type: 'tool_search' },
      { type: 'image_generation', size: '1792x1024', quality: 'high' },
    ],
  })
  const respAg = buildGeminiRequest(respIr, { target: 'antigravity' })
  assert.deepEqual(respAg.generationConfig, {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: '16:9', imageSize: '4K' },
  })
  const byOrig = new Map(respIr.tools.map((t) => [t.name, t.wireName]))
  const respCollector = createGeminiCollector({ fallbackModel: 'gemini-3-pro' })
  const respRestore = createGeminiRestoreTransform(respIr.restoreContext, { target: 'antigravity' })
  const respEnc = createGeminiProtocolStreamEncoder('openai-responses', {
    model: 'gemini-3-pro',
    restoreContext: respIr.restoreContext,
  })
  const respSse = []
  for (const ev of [
    { kind: 'start', responseId: 'r3', model: 'gemini-3-pro' },
    {
      kind: 'tool_call',
      id: 'rc1',
      signedId: 'rc1',
      name: byOrig.get('collaboration.send_msg'),
      args: { body: 'hi' },
      signature: '',
    },
    {
      kind: 'tool_call',
      id: 'rc2',
      signedId: 'rc2',
      name: byOrig.get('dsl_exec'),
      args: { input: 'x := 1' },
      signature: '',
    },
    {
      kind: 'tool_call',
      id: 'rc3',
      signedId: 'rc3',
      name: byOrig.get('local_shell'),
      args: { command: ['ls', '-la'] },
      signature: '',
    },
    {
      kind: 'tool_call',
      id: 'rc4',
      signedId: 'rc4',
      name: byOrig.get('apply_patch'),
      args: { type: 'update_file', path: 'a.txt', diff: '+1' },
      signature: '',
    },
    {
      kind: 'tool_call',
      id: 'rc5',
      signedId: 'rc5',
      name: byOrig.get('computer'),
      args: { type: 'click', x: 10, y: 20 },
      signature: '',
    },
    {
      kind: 'tool_call',
      id: 'rc6',
      signedId: 'rc6',
      name: byOrig.get('tool_search'),
      args: { query: 'git' },
      signature: '',
    },
    { kind: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
    { kind: 'stop', finishReason: 'STOP', stopReason: 'tool' },
  ]) {
    respRestore.push(ev, (out) => {
      respCollector.push(out)
      const chunk = respEnc.push(out)
      if (chunk) respSse.push(chunk)
    })
  }
  respSse.push(respEnc.finish())
  const respJson = renderGeminiProtocolResponse('openai-responses', respCollector.result(), {
    model: 'gemini-3-pro',
    restoreContext: respIr.restoreContext,
  })
  const outputTypes = respJson.output.map((o) => o.type)
  assert.deepEqual(outputTypes, [
    'image_generation_call',
    'function_call',
    'custom_tool_call',
    'local_shell_call',
    'apply_patch_call',
    'computer_call',
    'tool_search_call',
  ])
  assert.equal(respJson.output[0].result, 'iVBORw0KGgo=')
  assert.equal(respJson.output[1].namespace, 'collaboration')
  assert.equal(respJson.output[1].name, 'send_msg')
  assert.deepEqual(respJson.output[1].encrypted_function_args, [])
  assert.deepEqual(respJson.output[2].input, 'x := 1')
  assert.equal(respJson.output[3].action.type, 'exec')
  assert.deepEqual(respJson.output[3].action.command, ['ls', '-la'])
  assert.equal(respJson.output[4].operation.path, 'a.txt')
  assert.equal(respJson.output[5].action.type, 'click')
  const respSseText = respSse.join('')
  assert.match(respSseText, /"type":"custom_tool_call"/)
  assert.match(respSseText, /"type":"local_shell_call"/)
  assert.match(respSseText, /"type":"apply_patch_call"/)
  assert.match(respSseText, /"type":"image_generation_call"/)

  // 3. Anthropic built-in client tools + web_search + web_fetch + tool_addition/removal
  const anthIr = parseInboundToGemini('anthropic', {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    thinking: { type: 'enabled', budget_tokens: 2048, display: 'omitted' },
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect files' },
          { type: 'tool_addition', tools: [{ type: 'memory_20250818', name: 'memory' }] },
          { type: 'tool_removal', tool_names: ['obsolete_tool'] },
        ],
      },
    ],
    tools: [
      { type: 'bash_20250124', name: 'bash' },
      { type: 'text_editor_20250429', name: 'str_replace_based_edit_tool' },
      { name: 'obsolete_tool', input_schema: { type: 'object', properties: {} } },
      { type: 'web_search_20250305', name: 'web_search', allowed_domains: ['docs.python.org'] },
      { type: 'web_fetch_20250910', name: 'web_fetch' },
    ],
  })
  const anthAg = buildGeminiRequest(anthIr, { target: 'antigravity' })
  const declNames = anthAg.tools[0].functionDeclarations.map((d) => d.name)
  assert.deepEqual(declNames, ['bash', 'str_replace_based_edit_tool', 'memory'])
  assert.deepEqual(anthAg.tools.slice(1), [{ googleSearch: {} }, { urlContext: {} }])
  assert.equal(anthIr.restoreContext.hideThinking, true)
  assert.equal(anthIr.restoreContext.thinkingDisplay, 'omitted')
  assert.equal(anthIr.restoreContext.disableParallelTools, true)
})

test('createGeminiRestoreTransform enforces stopSequences, maxOutputTokens, responseFormat, hideThinking, search filter, and Claude enum unquoting', () => {
  // 1. Cross-chunk stopSequences + Anthropic stop_sequence field
  let stopEarlyFired = false
  const stopIr = parseInboundToGemini('anthropic', {
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    stop_sequences: ['</DONE>'],
    messages: [{ role: 'user', content: 'Say hi' }],
  })
  const stopRestore = createGeminiRestoreTransform(stopIr.restoreContext, {
    target: 'antigravity',
    model: 'claude-sonnet-4-6',
    onEarlyStop: () => {
      stopEarlyFired = true
    },
  })
  const stopCollector = createGeminiCollector({ fallbackModel: 'claude-sonnet-4-6' })
  for (const ev of [
    { kind: 'start', responseId: 's1', model: 'claude-sonnet-4-6' },
    { kind: 'text', text: 'hello </DO' },
    { kind: 'text', text: 'NE> ignored tail' },
    { kind: 'text', text: 'more ignored' },
  ]) {
    stopRestore.push(ev, (out) => stopCollector.push(out))
  }
  assert.equal(stopEarlyFired, true)
  const stopTurn = stopCollector.result()
  assert.equal(stopTurn.text, 'hello ')
  assert.equal(stopTurn.stopReason, 'stop_sequence')
  assert.equal(stopTurn.stopSequence, '</DONE>')
  const anthStopJson = renderGeminiProtocolResponse('anthropic', stopTurn, {
    model: 'claude-sonnet-4-6',
    restoreContext: stopIr.restoreContext,
  })
  assert.equal(anthStopJson.stop_reason, 'stop_sequence')
  assert.equal(anthStopJson.stop_sequence, '</DONE>')

  // 2. Local maxOutputTokens cap on antigravity
  let capEarlyFired = false
  const capIr = parseInboundToGemini('openai-chat', {
    model: 'gemini-3-pro',
    max_tokens: 4,
    messages: [{ role: 'user', content: 'count' }],
  })
  const capRestore = createGeminiRestoreTransform(capIr.restoreContext, {
    target: 'antigravity',
    model: 'gemini-3-pro',
    onEarlyStop: () => {
      capEarlyFired = true
    },
  })
  const capCollector = createGeminiCollector({ fallbackModel: 'gemini-3-pro' })
  capRestore.push({ kind: 'start', responseId: 'm1', model: 'gemini-3-pro' }, (out) => capCollector.push(out))
  capRestore.push({ kind: 'text', text: '0123456789abcdef_overflow_tail' }, (out) => capCollector.push(out))
  assert.equal(capEarlyFired, true)
  assert.equal(capCollector.result().text, '0123456789abcdef')
  assert.equal(capCollector.result().stopReason, 'length')

  // 3. responseFormat markdown fence unwrapping + Claude double-quoted enum fix + search domain filter + hideThinking
  const fmtIr = parseInboundToGemini('anthropic', {
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    thinking: { type: 'enabled', budget_tokens: 2048, display: 'omitted' },
    output_format: { type: 'json_object' },
    tools: [
      {
        name: 'set_status',
        input_schema: { type: 'object', properties: { state: { type: 'string', enum: ['open', 'closed'] } } },
      },
      {
        type: 'web_search_20250305',
        name: 'web_search',
        allowed_domains: ['allowed.example.com'],
        blocked_domains: ['bad.allowed.example.com'],
      },
    ],
    messages: [{ role: 'user', content: 'run' }],
  })
  const fmtRestore = createGeminiRestoreTransform(fmtIr.restoreContext, {
    target: 'antigravity',
    model: 'claude-sonnet-4-6',
  })
  const fmtCollector = createGeminiCollector({ fallbackModel: 'claude-sonnet-4-6' })
  for (const ev of [
    { kind: 'start', responseId: 'f1', model: 'claude-sonnet-4-6' },
    { kind: 'thinking', text: 'secret chain of thought' },
    { kind: 'thinking_signature', signature: 'sig_opaque_1' },
    {
      kind: 'search',
      queries: ['q'],
      hits: [
        { title: 'good', url: 'https://allowed.example.com/a' },
        { title: 'blocked', url: 'https://bad.allowed.example.com/b' },
        { title: 'other', url: 'https://other.example.org/c' },
      ],
    },
    { kind: 'tool_call', id: 't1', signedId: 't1', name: 'set_status', args: { state: '"closed"' }, signature: '' },
    { kind: 'text', text: '```json\n{"ok":true}\n```' },
    { kind: 'stop', finishReason: 'STOP', stopReason: 'stop' },
  ]) {
    fmtRestore.push(ev, (out) => fmtCollector.push(out))
  }
  const fmtTurn = fmtCollector.result()
  assert.equal(fmtTurn.thinking, '', 'omitted thinking hides thinking text')
  assert.ok(fmtTurn.parts.some((p) => p.kind === 'thinking' && p.signature === 'sig_opaque_1'))
  assert.equal(fmtTurn.text, '{"ok":true}')
  assert.deepEqual(fmtTurn.toolCalls[0].args, { state: 'closed' })
  assert.deepEqual(fmtTurn.searches[0].hits, [{ title: 'good', url: 'https://allowed.example.com/a' }])

  // 4. Image rendering across Gemini, Chat, Anthropic
  const imgTurn = {
    id: 'img_1',
    model: 'gemini-3-pro',
    parts: [
      { kind: 'text', text: 'Here it is:' },
      { kind: 'image', mediaType: 'image/png', data: 'QUJD' },
    ],
    text: 'Here it is:',
    thinking: '',
    toolCalls: [],
    images: [{ kind: 'image', mediaType: 'image/png', data: 'QUJD' }],
    searches: [],
    stopReason: 'stop',
    finishReason: 'STOP',
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  }
  assert.equal(renderGeminiProtocolResponse('gemini', imgTurn).candidates[0].content.parts[1].inlineData.data, 'QUJD')
  assert.match(
    renderGeminiProtocolResponse('openai-chat', imgTurn).choices[0].message.content,
    /data:image\/png;base64,QUJD/,
  )
  assert.match(
    renderGeminiProtocolResponse('anthropic', imgTurn)
      .content.map((b) => b.text)
      .join('\n'),
    /data:image\/png;base64,QUJD/,
  )
})

test('gemini-4-carbon-high effort propagation, default CRAGGemini thinkingConfig, and Antigravity2API multi-protocol parity', () => {
  // 1. gemini-4-carbon-high preserves high thinkingLevel on both Gemini and CRAGGemini (includeThinkingConfig: true)
  const carbonIr = parseInboundToGemini('openai-chat', {
    model: 'gemini-4-carbon-high',
    messages: [{ role: 'user', content: 'Solve this step by step.' }],
  })
  assert.equal(carbonIr.model, 'gemini-4-carbon-high')
  assert.equal(carbonIr.hideThinking, false)
  const carbonAgDefault = buildGeminiRequest(carbonIr, { target: 'antigravity' })
  assert.equal('generationConfig' in carbonAgDefault, false, 'default minimal antigravity build stays unchanged')
  const carbonAgThinking = buildGeminiRequest(carbonIr, {
    target: 'antigravity',
    includeThinkingConfig: true,
    defaultEffort: 'medium',
  })
  assert.deepEqual(carbonAgThinking.generationConfig, {
    thinkingConfig: {
      includeThoughts: true,
      thinkingLevel: 'high',
    },
  })

  // Even when scheduler falls back upstreamModel to untiered `gemini-4-carbon`, requestedModel keeps `high`
  const carbonFallbackAg = buildGeminiRequest(
    { ...carbonIr, model: 'gemini-4-carbon', requestedModel: 'gemini-4-carbon-high' },
    { target: 'antigravity', includeThinkingConfig: true, defaultEffort: 'medium' },
  )
  assert.deepEqual(carbonFallbackAg.generationConfig, {
    thinkingConfig: {
      includeThoughts: true,
      thinkingLevel: 'high',
    },
  })

  // Bare `gemini-4-carbon` defaults to `includeThoughts: true, thinkingLevel: 'medium'` on CRAGGemini
  const bareCarbonIr = parseInboundToGemini('gemini', {
    model: 'models/gemini-4-carbon[1m]',
    contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
  })
  assert.equal(bareCarbonIr.model, 'gemini-4-carbon')
  const bareCarbonAg = buildGeminiRequest(bareCarbonIr, {
    target: 'antigravity',
    includeThinkingConfig: true,
    defaultEffort: 'medium',
  })
  assert.deepEqual(bareCarbonAg.generationConfig, {
    thinkingConfig: {
      includeThoughts: true,
      thinkingLevel: 'medium',
    },
  })

  // `model(effort)` syntax + hydrogen `xhigh` support
  const parenCarbonIr = parseInboundToGemini('anthropic', {
    model: 'gemini-4-carbon(high)',
    max_tokens: 4096,
    messages: [{ role: 'user', content: 'Analyze' }],
  })
  assert.equal(parenCarbonIr.model, 'gemini-4-carbon')
  assert.equal(parenCarbonIr.thinking?.effort, 'high')
  const hydroIr = parseInboundToGemini('openai-chat', {
    model: 'gemini-4-hydrogen',
    reasoning_effort: 'xhigh',
    messages: [{ role: 'user', content: 'Deep analysis' }],
  })
  const hydroOut = buildGeminiRequest(hydroIr, {
    target: 'antigravity',
    includeThinkingConfig: true,
  })
  assert.deepEqual(hydroOut.generationConfig.thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: 'xhigh',
  })

  // 2. OpenAI Chat inbound assistant `reasoning_content` + camelCase `extra_body.google.thinkingConfig`
  const chatHistoryIr = parseInboundToGemini('openai-chat', {
    model: 'gemini-4-carbon',
    extra_body: {
      google: {
        thinkingConfig: {
          thinkingLevel: 'HIGH',
          includeThoughts: true,
        },
      },
    },
    messages: [
      { role: 'user', content: 'First turn' },
      { role: 'assistant', reasoning_content: 'Prior thought', content: 'Prior answer' },
      { role: 'user', content: 'Second turn' },
    ],
  })
  assert.equal(chatHistoryIr.thinking?.effort, 'high')
  assert.equal(chatHistoryIr.messages[1].parts[0].kind, 'thinking')
  assert.equal(chatHistoryIr.messages[1].parts[0].text, 'Prior thought')

  // 3. OpenAI Responses `configuration_update`, `encrypted_content` replay, and outbound `reasoning.encrypted_content`
  const respIr = parseInboundToGemini('openai-responses', {
    model: 'gemini-4-carbon',
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: 'low' },
    input: [
      { type: 'message', role: 'user', content: 'Turn 1' },
      { type: 'reasoning', encrypted_content: 'sig_enc_123', summary: [{ type: 'summary_text', text: 'thought' }] },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      { type: 'configuration_update', reasoning: { effort: 'high' } },
      { type: 'message', role: 'user', content: 'Turn 2' },
    ],
  })
  assert.equal(respIr.thinking?.effort, 'high', 'configuration_update overrides initial reasoning.effort')
  assert.equal(respIr.restoreContext?.includeEncryptedReasoning, true)
  const tcPart = respIr.messages.flatMap((m) => m.parts).find((p) => p.kind === 'tool_call')
  assert.equal(tcPart?.signature, 'sig_enc_123', 'encrypted_content attaches to subsequent function_call')

  const encEncoder = createGeminiProtocolStreamEncoder('openai-responses', {
    model: 'gemini-4-carbon-high',
    restoreContext: respIr.restoreContext,
  })
  let encSse = ''
  encSse += encEncoder.push({ kind: 'start', model: 'gemini-4-carbon-high', responseId: 'r1' })
  encSse += encEncoder.push({ kind: 'thinking', text: 'Detailed agy reasoning.' })
  encSse += encEncoder.push({ kind: 'thinking_signature', signature: 'sig_out_999' })
  encSse += encEncoder.push({ kind: 'text', text: 'Done.' })
  encSse += encEncoder.push({ kind: 'stop', finishReason: 'STOP', stopReason: 'stop' })
  encSse += encEncoder.finish()
  assert.match(encSse, /"encrypted_content":"sig_out_999"/)

  const encJson = renderGeminiProtocolResponse('openai-responses', encEncoder.result(), {
    model: 'gemini-4-carbon-high',
    restoreContext: respIr.restoreContext,
  })
  assert.equal(encJson.output[0].type, 'reasoning')
  assert.equal(encJson.output[0].encrypted_content, 'sig_out_999')

  // 4. Anthropic mid-conversation `output_config.effort` and `redacted_thinking` signature preservation
  const anthMidIr = parseInboundToGemini('anthropic', {
    model: 'gemini-4-carbon',
    max_tokens: 4096,
    output_config: { effort: 'low' },
    messages: [
      { role: 'user', content: 'Start' },
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'sig_redacted_77' },
          { type: 'tool_use', id: 'toolu_1', name: 'ping', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'pong' }],
      },
      { role: 'system', output_config: { effort: 'high' }, content: 'Switch effort' },
      { role: 'user', content: 'Continue' },
    ],
  })
  assert.equal(anthMidIr.thinking?.effort, 'high')
  const anthTc = anthMidIr.messages.flatMap((m) => m.parts).find((p) => p.kind === 'tool_call')
  assert.equal(anthTc?.signature, 'sig_redacted_77')
})

test('makeWireToolName caps wire names at 55 chars so mcp_crag_<wireName> stays <= 64 and restores MCP/Claude tools', () => {
  const toolNames = [
    'Bash',
    'Read',
    'NotebookEdit',
    'LSP',
    'EnterWorktree',
    'ExitWorktree',
    'Agent',
    'Skill',
    'AskUserQuestion',
    'SendMessage',
    'Workflow',
    'EnterPlanMode',
    'ExitPlanMode',
    'mcp__context7__resolve-library-id',
    'mcp__context7__query-docs',
    'mcp__sequential-thinking__sequentialthinking',
    'mcp__grok-search__web_search',
    'mcp__grok-search__web_map',
    'mcp__chrome-devtools__take_screenshot',
    'mcp__chrome-devtools__evaluate_script',
    'mcp__chrome-devtools__very_long_tool_name_that_exceeds_fifty_five_characters_easily_v1',
    'mcp__chrome-devtools__very_long_tool_name_that_exceeds_fifty_five_characters_easily_v2',
    'my.dotted.namespace.tool',
    'my_dotted_namespace_tool',
  ]
  const ir = parseInboundToGemini('anthropic', {
    model: 'gemini-4-carbon-high',
    max_tokens: 4096,
    tools: toolNames.map((name) => ({
      name,
      description: `Tool ${name}`,
      input_schema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        additionalProperties: false,
      },
    })),
    messages: [{ role: 'user', content: 'List worktrees' }],
  })

  const agReq = buildGeminiRequest(ir, { target: 'antigravity' })
  const decls = agReq.tools[0].functionDeclarations
  assert.equal(decls.length, toolNames.length)

  const seenWire = new Set()
  for (const decl of decls) {
    assert.ok(decl.name.length <= 55, `wire name exceeds 55 chars: ${decl.name} (${decl.name.length})`)
    assert.ok(`mcp_crag_${decl.name}`.length <= 64, `prefixed MCP name exceeds 64 chars: mcp_crag_${decl.name}`)
    assert.match(decl.name, /^[A-Za-z_][A-Za-z0-9_-]*$/, `invalid wire tool name: ${decl.name}`)
    assert.equal(seenWire.has(decl.name), false, `duplicate wire name: ${decl.name}`)
    seenWire.add(decl.name)
  }

  // Round-trip restore through createGeminiRestoreTransform for prefixed and unprefixed callbacks.
  const restore = createGeminiRestoreTransform(ir.restoreContext, {
    target: 'antigravity',
    model: 'gemini-4-carbon-high',
  })
  const collector = createGeminiCollector({ fallbackModel: 'gemini-4-carbon-high' })
  restore.push({ kind: 'start', responseId: 'r_tools', model: 'gemini-4-carbon-high' }, (out) => collector.push(out))
  for (let i = 0; i < decls.length; i += 1) {
    const wire = decls[i].name
    const emittedName = i % 2 === 0 ? `mcp_crag_${wire}` : wire
    restore.push(
      {
        kind: 'tool_call',
        id: `tc_${i}`,
        signedId: `tc_${i}`,
        name: emittedName,
        args: { q: 'ok' },
        signature: '',
      },
      (out) => collector.push(out),
    )
  }
  restore.push({ kind: 'stop', finishReason: 'STOP', stopReason: 'tool' }, (out) => collector.push(out))

  const restoredNames = collector.result().toolCalls.map((c) => c.name)
  assert.deepEqual(restoredNames, toolNames)
})

test('gemini-4-neon preserves xhigh thinkingLevel alongside gemini-4-neon-xhigh variant (#1975)', () => {
  const available = ['gemini-4-neon-low', 'gemini-4-neon-medium', 'gemini-4-neon-high', 'gemini-4-neon-xhigh']
  const cases = [
    { effort: 'low', model: 'gemini-4-neon-low', thinkingLevel: 'low' },
    { effort: 'medium', model: 'gemini-4-neon-medium', thinkingLevel: 'medium' },
    { effort: 'high', model: 'gemini-4-neon-high', thinkingLevel: 'high' },
    { effort: 'xhigh', model: 'gemini-4-neon-xhigh', thinkingLevel: 'xhigh' },
    { effort: 'max', model: 'gemini-4-neon-xhigh', thinkingLevel: 'xhigh' },
  ]
  for (const c of cases) {
    const inbound = {
      model: 'gemini-4-neon',
      max_tokens: 64,
      stream: false,
      output_config: { effort: c.effort },
      messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
    }
    const parsed = parseInboundToGemini('anthropic', inbound)
    const selected = resolveUpstreamModel(parsed.model, available, { requestedEffort: parsed.thinking.effort })
    const nativeRequest = buildGeminiRequest(
      { ...parsed, model: selected.upstreamModel, requestedModel: inbound.model },
      { target: 'antigravity', defaultEffort: 'medium', includeThinkingConfig: true },
    )
    const { body } = normalizeGeminiOutboundPrompt(nativeRequest, { target: 'antigravity' })
    const envelope = buildDirectEnvelope({ model: selected.upstreamModel, requestId: 'req-neon-xhigh', bodyObj: body })
    assert.equal(envelope.body.model, c.model)
    assert.equal(envelope.body.generationConfig.thinkingConfig.thinkingLevel, c.thinkingLevel)
  }

  // Untiered catalog preserves gemini-4-neon-xhigh while still clamping non-xhigh families (e.g. carbon).
  const untieredNeon = resolveUpstreamModel('gemini-4-neon-xhigh[1m]', ['gemini-4-neon'])
  assert.equal(untieredNeon.upstreamModel, 'gemini-4-neon')
  assert.equal(untieredNeon.publicId, 'gemini-4-neon-xhigh')

  const untieredNeonBare = resolveUpstreamModel('gemini-4-neon', ['gemini-4-neon'], { requestedEffort: 'xhigh' })
  assert.equal(untieredNeonBare.upstreamModel, 'gemini-4-neon')
  const untieredNeonReq = buildGeminiRequest(
    {
      ...parseInboundToGemini('anthropic', {
        model: 'gemini-4-neon',
        max_tokens: 64,
        stream: false,
        output_config: { effort: 'xhigh' },
        messages: [{ role: 'user', content: 'hi' }],
      }),
      model: untieredNeonBare.upstreamModel,
      requestedModel: 'gemini-4-neon',
    },
    { target: 'antigravity', defaultEffort: 'medium', includeThinkingConfig: true },
  )
  assert.equal(untieredNeonReq.generationConfig.thinkingConfig.thinkingLevel, 'xhigh')

  const untieredCarbon = resolveUpstreamModel('gemini-4-carbon-xhigh[1m]', ['gemini-4-carbon'])
  assert.equal(untieredCarbon.upstreamModel, 'gemini-4-carbon')
  assert.equal(untieredCarbon.publicId, 'gemini-4-carbon-high')

  const carbonIr = parseInboundToGemini('anthropic', {
    model: 'gemini-4-carbon',
    max_tokens: 64,
    stream: false,
    output_config: { effort: 'xhigh' },
    messages: [{ role: 'user', content: 'hi' }],
  })
  const carbonReq = buildGeminiRequest(carbonIr, {
    target: 'antigravity',
    defaultEffort: 'medium',
    includeThinkingConfig: true,
  })
  assert.equal(carbonReq.generationConfig.thinkingConfig.thinkingLevel, 'high')
})

test('sanitizeGeminiSchema strips non-RE2 pattern lookarounds/backrefs while keeping valid RE2 patterns (#1985)', () => {
  // Unit checks on isRe2CompatibleRegex
  assert.equal(isRe2CompatibleRegex('^[a-z]+$'), true)
  assert.equal(isRe2CompatibleRegex('^[a-zA-Z0-9_-]{1,64}$'), true)
  assert.equal(isRe2CompatibleRegex('^(?:foo|bar)+?$'), true)
  assert.equal(isRe2CompatibleRegex('^\\(\\?!literal\\)$'), true)
  assert.equal(isRe2CompatibleRegex('^[a-z(?!)]+$'), true)
  assert.equal(isRe2CompatibleRegex('^(?!x)[a-z]+$'), false)
  assert.equal(isRe2CompatibleRegex('^(?=.*[A-Z])[a-zA-Z0-9]+$'), false)
  assert.equal(isRe2CompatibleRegex('(?<=foo)bar'), false)
  assert.equal(isRe2CompatibleRegex('(?<!foo)bar'), false)
  assert.equal(isRe2CompatibleRegex('^([a-z]+)-\\1$'), false)
  assert.equal(isRe2CompatibleRegex('^(?<id>[a-z]+)-\\k<id>$'), false)
  assert.equal(isRe2CompatibleRegex('^[a-z]++$'), false)
  assert.equal(isRe2CompatibleRegex('^(?>foo|bar)$'), false)

  const originalSchema = {
    type: 'object',
    properties: {
      collection: { type: 'string', description: 'Collection name', minLength: 1, pattern: '^(?!x)[a-z]+$' },
      safe: { type: 'string', pattern: '^[a-z]+$' },
      writes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            doc_id: { type: 'string', pattern: '^(?!_)[a-zA-Z0-9_-]+$' },
            tag: { type: 'string', pattern: '^[a-z0-9-]+$' },
          },
          required: ['doc_id'],
        },
      },
    },
    required: ['collection'],
  }

  for (const plain of [true, false]) {
    const cleaned = sanitizeGeminiSchema(originalSchema, { plain })
    assert.equal(cleaned.properties.collection.pattern, undefined)
    assert.equal(cleaned.properties.collection.type, 'string')
    assert.equal(cleaned.properties.collection.description, 'Collection name')
    assert.equal(cleaned.properties.collection.minLength, 1)
    assert.equal(cleaned.properties.safe.pattern, '^[a-z]+$')
    assert.equal(cleaned.properties.writes.items.properties.doc_id.pattern, undefined)
    assert.equal(cleaned.properties.writes.items.properties.tag.pattern, '^[a-z0-9-]+$')
    assert.deepEqual(cleaned.properties.writes.items.required, ['doc_id'])
  }
  // Caller's original schema object is never mutated.
  assert.equal(originalSchema.properties.collection.pattern, '^(?!x)[a-z]+$')
  assert.equal(originalSchema.properties.writes.items.properties.doc_id.pattern, '^(?!_)[a-zA-Z0-9_-]+$')

  // End-to-end Google native inbound -> Antigravity outbound strips incompatible lookahead pattern.
  const ir = parseInboundToGemini(
    'gemini',
    {
      contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'ArtifactData',
              description: 'Read/write artifacts',
              parameters: originalSchema,
            },
          ],
        },
      ],
    },
    { routeModel: 'gemini-4-carbon-high', routeStream: true },
  )
  const req = buildGeminiRequest(ir, { target: 'antigravity' })
  const outParams = req.tools[0].functionDeclarations[0].parameters
  assert.equal(outParams.properties.collection.pattern, undefined)
  assert.equal(outParams.properties.safe.pattern, '^[a-z]+$')
  assert.equal(outParams.properties.writes.items.properties.doc_id.pattern, undefined)
})
