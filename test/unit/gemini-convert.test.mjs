import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SKIP_THOUGHT_SIGNATURE,
  buildGeminiRequest,
  classifyGeminiCapabilities,
  createGeminiCollector,
  createGeminiEventDecoder,
  createGeminiProtocolStreamEncoder,
  createSseFrameSplitter,
  formatGeminiProtocolError,
  formatGeminiProtocolStreamError,
  geminiCamelCase,
  geminiFuncName,
  geminiToolNameFromCall,
  normalizeGeminiUsage,
  parseGeminiSseFrame,
  parseInboundToGemini,
  renderGeminiProtocolResponse,
  sanitizeGeminiSchema,
  signedToolCallId,
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
