import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { assertSafeBenchPgUrl, parseBootstrapArgs } from '../../scripts/bench-20k/bootstrap-sut.mjs'
import { computeLatencyStats, loadCorpusTemplates, runLoadStep } from '../../scripts/bench-20k/load-runner.mjs'
import {
  createMetricsCollector,
  diffSnapshots,
  parseRedisInfo,
  resetSutProbes,
} from '../../scripts/bench-20k/metrics-collector.mjs'
import { parseMockArgs, startMockUpstream } from '../../scripts/bench-20k/mock-upstream.mjs'
import {
  attributeBottlenecks,
  detectKneeAndAttribution,
  renderPhase0Report,
  runPhase0,
} from '../../scripts/bench-20k/run-phase0.mjs'
import { startSutProbe } from '../../scripts/bench-20k/sut-probe-preload.mjs'
import { reconcileApiKeyBilling, verifyClosedLoop } from '../../scripts/bench-20k/verify-closed-loop.mjs'
import { validateRequestBody } from '../../src/lib/core/errors.mjs'
import { validateOfficialModel } from '../../src/lib/protocol/models.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')
const COMPILER_SCRIPT = path.join(REPO_ROOT, 'scripts/bench-20k/build-corpus.py')
const MOCK_CLI = path.join(REPO_ROOT, 'scripts', 'bench-20k', 'mock-upstream.mjs')
const PROBE_PRELOAD = path.join(REPO_ROOT, 'scripts', 'bench-20k', 'sut-probe-preload.mjs')
const COMPOSE_FILE = path.join(REPO_ROOT, 'scripts', 'bench-20k', 'docker-compose.bench.yml')

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close((err) => (err ? reject(err) : resolve(p)))
    })
  })
}

function httpUdsRequest(socketPath, reqPath, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null
    const req = http.request(
      {
        socketPath,
        path: reqPath,
        method,
        headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function startHttpServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((res) => {
            server.closeAllConnections?.()
            server.close(() => res())
          }),
      })
    })
  })
}

function readStreamBuf(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function buildSyntheticOmpRows() {
  const rows = [
    {
      type: 'session',
      version: 3,
      id: 'omp-sess-secret-uuid-001',
      cwd: '/home/secret-owner/private-omp-workspace',
    },
  ]
  let parentId = null
  const push = (id, payload) => {
    rows.push({ id, parentId, ...payload })
    parentId = id
  }

  // Initial user prompt with multi-byte UTF-8 (Chinese + emoji) and vivid canary.
  const firstUserText = `SECRET_OMP_CANARY_ALPHA_9988 机密代码审计报告🔐 ${'多字节测试片段🚀'.repeat(40)}`
  push('e0', {
    type: 'message',
    message: {
      role: 'user',
      content: [{ type: 'text', text: firstUserText }],
    },
  })

  // 8 multi-turn exchanges with thinking, parallel toolCall -> toolResult, and non-Claude model.
  for (let turn = 1; turn <= 8; turn += 1) {
    const t1 = `omp_raw_call_${turn}_a_SECRET`
    const t2 = `omp_raw_call_${turn}_b_SECRET`
    const orphan = `omp_orphan_call_${turn}_NO_RESULT`
    const blocks = [
      {
        type: 'thinking',
        thinking: `OMP_THINKING_SECRET_${turn} 思考链机密内容 ${'推理步骤'.repeat(35)}`,
        summary: true,
      },
      {
        type: 'text',
        text: `OMP_ASSISTANT_TEXT_${turn} ${'分析摘要'.repeat(25)}`,
      },
      {
        type: 'toolCall',
        id: t1,
        name: 'my_secret_custom_tool',
        arguments: {
          super_secret_arg_key: `SECRET_ARG_VAL_${turn}_${'参数值'.repeat(40)}`,
          nested_secret_list: [{ deep_secret_field: `DEEP_VAL_${turn}` }, 42, true],
        },
      },
      {
        type: 'toolCall',
        id: t2,
        name: 'another_private_tool',
        arguments: {
          target_secret_path: `/etc/secret/config_${turn}.conf`,
        },
      },
    ]
    if (turn === 2) {
      // Plant an unmatched toolCall to verify orphan pruning.
      blocks.push({
        type: 'toolCall',
        id: orphan,
        name: 'orphan_unpaired_tool',
        arguments: { orphan_key: 'ORPHAN_VALUE_SHOULD_BE_DROPPED' },
      })
    }

    push(`a_${turn}`, {
      type: 'message',
      message: {
        role: 'assistant',
        model: 'pro-grok/grok-4.7',
        api: 'openai-responses',
        usage: { input: 2000 * turn, output: 320, cacheRead: 1000 * (turn - 1), cacheWrite: 500 },
        content: blocks,
      },
    })

    push(`tr_${turn}_1`, {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: t1,
        toolName: 'my_secret_custom_tool',
        isError: false,
        content: [{ type: 'text', text: `SECRET_OMP_TOOL_OUT_${turn}_A ${'工具返回内容✨'.repeat(55)}` }],
      },
    })
    push(`tr_${turn}_2`, {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: t2,
        toolName: 'another_private_tool',
        isError: turn === 3,
        content: [{ type: 'text', text: `SECRET_OMP_TOOL_OUT_${turn}_B ${'日志行数据'.repeat(45)}` }],
      },
    })
    if (turn === 4) {
      // Plant an orphan toolResult whose toolCallId never existed.
      push(`tr_${turn}_orphan`, {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'never_issued_call_id_999',
          toolName: 'ghost_tool',
          isError: false,
          content: [{ type: 'text', text: 'GHOST_ORPHAN_TOOL_RESULT_SECRET' }],
        },
      })
    }
  }

  return { rows, firstUserText }
}

function buildSyntheticClaudeShapeRows() {
  const sysText = `SECRET_CLAUDE_SYS_CANARY 系统提示词机密🔒 ${'系统规则说明'.repeat(30)}`
  const toolDesc = `SECRET_CLAUDE_TOOL_DESC 私有工具描述 ${'工具用法说明'.repeat(25)}`
  const firstThinking = `SECRET_CLAUDE_THINKING_CANARY 深度思考🧠 ${'思维链路'.repeat(30)}`
  const firstSig = `SECRET_SIGNATURE_BLOB_${'SigData987654321'.repeat(12)}`

  const rows = [
    {
      type: 'api-request-shape',
      sessionId: 'claude-secret-session-uuid-1',
      shapeHash: 'shape_hash_1',
      shape: {
        system: [{ type: 'text', text: sysText }],
        tools: [
          {
            name: 'PrivateRepoInspector',
            description: toolDesc,
            input_schema: {
              type: 'object',
              properties: {
                secret_schema_prop_key: {
                  type: 'string',
                  description: 'SECRET_SCHEMA_PROP_DESC 私有属性说明',
                },
                secret_enum_prop: {
                  type: 'string',
                  enum: ['SECRET_ENUM_ALPHA', 'SECRET_ENUM_BETA'],
                },
              },
              required: ['secret_schema_prop_key'],
              additionalProperties: false,
            },
          },
        ],
      },
    },
  ]

  let parentUuid = null
  const push = (uuid, row) => {
    rows.push({ uuid, parentUuid, isSidechain: false, cwd: '/home/secret-owner/private-claude-repo', ...row })
    parentUuid = uuid
  }

  push('u_0', {
    type: 'user',
    message: {
      role: 'user',
      content: `SECRET_CLAUDE_USER_PROMPT_0 请检查内部密钥逻辑 ${'详细上下文说明'.repeat(35)}`,
    },
  })

  for (let turn = 1; turn <= 8; turn += 1) {
    const mid = `msg_claude_secret_${turn}`
    const tid = `toolu_raw_claude_secret_${turn}`
    // Split assistant blocks across multiple JSONL rows sharing the same message.id (real Claude Code layout).
    push(`a_${turn}_th`, {
      type: 'assistant',
      message: {
        id: mid,
        role: 'assistant',
        model: 'claude-kin/claude-opus-5',
        content: [
          {
            type: 'thinking',
            thinking: turn === 1 ? firstThinking : `SECRET_CLAUDE_THINK_${turn} ${'思考片段'.repeat(35)}`,
            signature: turn === 1 ? firstSig : `SECRET_SIG_${turn}_${'xyz'.repeat(30)}`,
          },
        ],
        usage: {
          input_tokens: 150,
          output_tokens: 420,
          cache_read_input_tokens: turn === 1 ? 0 : 1200 * turn,
          cache_creation_input_tokens: 1200,
        },
      },
    })
    push(`a_${turn}_txt`, {
      type: 'assistant',
      message: {
        id: mid,
        role: 'assistant',
        model: 'claude-kin/claude-opus-5',
        content: [{ type: 'text', text: `SECRET_CLAUDE_REPLY_${turn} ${'中文回答片段'.repeat(25)}` }],
        usage: {
          input_tokens: 150,
          output_tokens: 420,
          cache_read_input_tokens: turn === 1 ? 0 : 1200 * turn,
          cache_creation_input_tokens: 1200,
        },
      },
    })
    push(`a_${turn}_tu`, {
      type: 'assistant',
      message: {
        id: mid,
        role: 'assistant',
        model: 'claude-kin/claude-opus-5',
        content: [
          {
            type: 'tool_use',
            id: tid,
            name: 'PrivateRepoInspector',
            input: {
              secret_schema_prop_key: `SECRET_CLAUDE_TOOL_INPUT_${turn} ${'敏感路径参数'.repeat(30)}`,
            },
          },
        ],
        usage: {
          input_tokens: 150,
          output_tokens: 420,
          cache_read_input_tokens: turn === 1 ? 0 : 1200 * turn,
          cache_creation_input_tokens: 1200,
        },
      },
    })

    push(`u_${turn}_tr`, {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: tid,
            is_error: false,
            content: `SECRET_CLAUDE_TOOL_RESULT_${turn} ${'工具返回源码片段'.repeat(60)}`,
          },
        ],
      },
    })
  }

  // Add a sidechain row that must be ignored.
  rows.push({
    uuid: 'sidechain_1',
    parentUuid: 'u_0',
    isSidechain: true,
    type: 'user',
    message: { role: 'user', content: 'SIDECHAIN_SECRET_MUST_NEVER_APPEAR' },
  })

  return { rows, sysText, toolDesc, firstThinking, firstSig }
}

function buildOversizedClaudeTranscriptRows() {
  const rows = []
  let parentUuid = null
  const push = (uuid, row) => {
    rows.push({ uuid, parentUuid, isSidechain: false, ...row })
    parentUuid = uuid
  }

  push('ov_u0', {
    type: 'user',
    message: { role: 'user', content: `OVERSIZED_SESSION_START_SECRET ${'长会话起始文本'.repeat(40)}` },
  })
  // 20 turns (~3KB each => ~60KB total, far above test max_bytes=16000) to force turn-boundary truncation.
  for (let turn = 1; turn <= 20; turn += 1) {
    const tid = `toolu_ov_${turn}`
    push(`ov_a_${turn}`, {
      type: 'assistant',
      message: {
        id: `msg_ov_${turn}`,
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [
          { type: 'text', text: `OV_ASST_${turn} ${'超长对话回复'.repeat(35)}` },
          {
            type: 'tool_use',
            id: tid,
            name: 'OversizedReader',
            input: { secret_file: `/private/oversized_${turn}.txt` },
          },
        ],
        usage: { input_tokens: 500, output: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300 },
      },
    })
    push(`ov_u_${turn}`, {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: tid,
            content: `OV_RESULT_${turn} ${'大段文件内容回显'.repeat(70)}`,
          },
        ],
      },
    })
  }
  return rows
}

function assertValidAnthropicRecord(rec, minBytes, maxBytes) {
  for (const field of [
    'id',
    'session_key',
    'turn_index',
    'approx_tokens',
    'body_bytes',
    'model',
    'stream',
    'body',
    'expected_usage',
  ]) {
    assert.ok(Object.hasOwn(rec, field), `missing required field ${field}`)
  }
  assert.equal(rec.stream, true)
  assert.equal(rec.body.stream, true)
  assert.equal(rec.model, rec.body.model)
  assert.equal(typeof rec.turn_index, 'number')
  assert.ok(rec.turn_index >= 1)

  const actualBytes = Buffer.byteLength(JSON.stringify(rec.body), 'utf8')
  assert.equal(rec.body_bytes, actualBytes, 'body_bytes must match exact compact UTF-8 JSON size')
  assert.ok(
    actualBytes >= minBytes && actualBytes <= maxBytes,
    `body_bytes ${actualBytes} outside [${minBytes}, ${maxBytes}]`,
  )

  // Validate against real vm2api protocol validators.
  const bodyCheck = validateRequestBody('anthropic.messages', rec.body)
  assert.equal(bodyCheck.ok, true, `vm2api validateRequestBody failed: ${JSON.stringify(bodyCheck)}`)
  const modelCheck = validateOfficialModel(rec.model)
  assert.equal(
    modelCheck.ok,
    true,
    `vm2api validateOfficialModel failed for ${rec.model}: ${JSON.stringify(modelCheck)}`,
  )

  // Validate expected_usage shape.
  for (const uf of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    assert.ok(Number.isInteger(rec.expected_usage[uf]) && rec.expected_usage[uf] >= 0, `invalid usage.${uf}`)
  }
  assert.ok(rec.expected_usage.output_tokens >= 1)

  // Strict Anthropic alternation + 1:1 tool_use -> tool_result pairing + cache_control rules.
  const msgs = rec.body.messages
  assert.ok(Array.isArray(msgs) && msgs.length >= 1)
  assert.equal(msgs[0].role, 'user')
  assert.equal(msgs[msgs.length - 1].role, 'user')

  let ccCount = 0
  const declaredTools = new Set((rec.body.tools || []).map((t) => t.name))
  for (const sb of rec.body.system || []) {
    if (sb.cache_control) ccCount += 1
  }
  for (const t of rec.body.tools || []) {
    if (t.cache_control) ccCount += 1
  }

  let pendingTools = []
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i]
    assert.equal(m.role, i % 2 === 0 ? 'user' : 'assistant', `role alternation violated at messages[${i}]`)
    assert.ok(Array.isArray(m.content) && m.content.length > 0)

    if (m.role === 'assistant') {
      assert.equal(pendingTools.length, 0)
      for (const blk of m.content) {
        if (blk.cache_control) {
          assert.notEqual(blk.type, 'thinking', 'cache_control must never be placed on thinking blocks')
          ccCount += 1
        }
        if (blk.type === 'thinking') {
          assert.match(blk.thinking, /^[0-9a-f]+$/)
          assert.match(blk.signature, /^[0-9a-f]+$/)
        } else if (blk.type === 'text') {
          assert.match(blk.text, /^[0-9a-f]+$/)
        } else if (blk.type === 'tool_use') {
          assert.ok(declaredTools.has(blk.name), `tool ${blk.name} not declared in tools`)
          pendingTools.push(blk.id)
        }
      }
    } else {
      const seenResults = []
      for (const blk of m.content) {
        if (blk.cache_control) ccCount += 1
        if (blk.type === 'text') {
          assert.match(blk.text, /^[0-9a-f]+$/)
        } else if (blk.type === 'tool_result') {
          seenResults.push(blk.tool_use_id)
        }
      }
      if (i === 0) {
        assert.equal(seenResults.length, 0, 'first user message cannot contain tool_result')
      } else {
        assert.deepEqual(
          [...seenResults].sort(),
          [...pendingTools].sort(),
          `tool_use -> tool_result mismatch at messages[${i}]`,
        )
      }
      pendingTools = []
    }
  }
  assert.equal(pendingTools.length, 0)
  assert.ok(ccCount >= 1 && ccCount <= 4, `cache_control count ${ccCount} out of Anthropic [1, 4] range`)
}

describe('bench-20k corpus compiler', () => {
  it('build-corpus.py redacts dual-source OMP + Claude sessions preserving UTF-8 bytes, zero leakage, and determinism', () => {
    const tmpRoot = makeTempDir('bench-20k-corpus-')
    try {
      const ompDir = path.join(tmpRoot, 'omp')
      const claudeDir = path.join(tmpRoot, 'claude')
      const outA = path.join(tmpRoot, 'out-a')
      const outB = path.join(tmpRoot, 'out-b')

      const ompFixture = buildSyntheticOmpRows()
      const claudeFixture = buildSyntheticClaudeShapeRows()
      const oversizedFixture = buildOversizedClaudeTranscriptRows()

      writeJsonl(path.join(ompDir, 'proj-a/session-1.jsonl'), ompFixture.rows)
      writeJsonl(path.join(claudeDir, 'proj-b/session-shape.jsonl'), claudeFixture.rows)
      writeJsonl(path.join(claudeDir, 'proj-c/session-oversized.jsonl'), oversizedFixture)

      const minBytes = 6000
      const maxBytes = 16000
      const cliBase = [
        COMPILER_SCRIPT,
        '--omp-dir',
        ompDir,
        '--claude-dir',
        claudeDir,
        '--min-bytes',
        String(minBytes),
        '--max-bytes',
        String(maxBytes),
        '--target-count',
        '12',
        '--seed',
        '20261128',
        '--verify-redaction',
      ]

      execFileSync('python3', [...cliBase, '--out-dir', outA], { encoding: 'utf8' })
      execFileSync('python3', [...cliBase, '--out-dir', outB], { encoding: 'utf8' })

      const corpusBufA = fs.readFileSync(path.join(outA, 'corpus-100k.jsonl'))
      const corpusBufB = fs.readFileSync(path.join(outB, 'corpus-100k.jsonl'))
      const manifestA = JSON.parse(fs.readFileSync(path.join(outA, 'manifest.json'), 'utf8'))
      const manifestB = JSON.parse(fs.readFileSync(path.join(outB, 'manifest.json'), 'utf8'))

      // 1. Deterministic output & SHA-256 lock.
      assert.equal(Buffer.compare(corpusBufA, corpusBufB), 0, 'corpus-100k.jsonl must be byte-identical across runs')
      const expectedSha = crypto.createHash('sha256').update(corpusBufA).digest('hex')
      assert.equal(manifestA.corpus_sha256, expectedSha)
      assert.equal(manifestB.corpus_sha256, expectedSha)

      // 2. Manifest contract & dual-source coverage.
      assert.ok(manifestA.count >= 4, `expected multiple records, got ${manifestA.count}`)
      assert.ok(manifestA.source_counts.omp > 0, 'expected OMP records in corpus')
      assert.ok(manifestA.source_counts.claude > 0, 'expected Claude records in corpus')
      assert.ok(manifestA.unique_sessions >= 2, 'expected at least 2 unique sessions')
      assert.equal(manifestA.redaction_audit.verified, true)
      assert.equal(manifestA.redaction_audit.status, 'pass')
      assert.equal(manifestA.redaction_audit.leaks_found, 0)
      assert.equal(manifestA.redaction_audit.byte_length_mismatches, 0)
      assert.equal(manifestA.redaction_audit.tool_pair_violations, 0)
      assert.equal(manifestA.redaction_audit.role_alternation_violations, 0)
      assert.equal(manifestA.redaction_audit.cache_control_violations, 0)
      assert.equal(manifestA.redaction_audit.non_hex_leaf_violations, 0)
      assert.ok(manifestA.redaction_audit.probes_checked >= 20)

      // 3. Zero plaintext leakage across corpus + manifest.
      const corpusText = corpusBufA.toString('utf8')
      const manifestText = fs.readFileSync(path.join(outA, 'manifest.json'), 'utf8')
      const forbiddenCanaries = [
        'SECRET_OMP_CANARY_ALPHA_9988',
        '机密代码审计报告',
        'OMP_THINKING_SECRET',
        'my_secret_custom_tool',
        'super_secret_arg_key',
        'SECRET_OMP_TOOL_OUT',
        'GHOST_ORPHAN_TOOL_RESULT_SECRET',
        'ORPHAN_VALUE_SHOULD_BE_DROPPED',
        'SECRET_CLAUDE_SYS_CANARY',
        'SECRET_CLAUDE_TOOL_DESC',
        'SECRET_CLAUDE_THINKING_CANARY',
        'SECRET_SIGNATURE_BLOB',
        'PrivateRepoInspector',
        'secret_schema_prop_key',
        'SECRET_ENUM_ALPHA',
        'SECRET_CLAUDE_TOOL_RESULT',
        'SIDECHAIN_SECRET_MUST_NEVER_APPEAR',
        'OVERSIZED_SESSION_START_SECRET',
        'private-omp-workspace',
        'private-claude-repo',
      ]
      for (const canary of forbiddenCanaries) {
        assert.equal(corpusText.includes(canary), false, `plaintext canary leaked into corpus: ${canary}`)
        assert.equal(manifestText.includes(canary), false, `plaintext canary leaked into manifest: ${canary}`)
      }

      // 4. Validate every record & exact UTF-8 byte-length preservation on multi-byte inputs.
      const records = corpusText
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      assert.equal(records.length, manifestA.count)

      const bySession = new Map()
      let verifiedOmpUtf8Bytes = false
      let verifiedClaudeShapeBytes = false

      for (const rec of records) {
        assertValidAnthropicRecord(rec, minBytes, maxBytes)
        const list = bySession.get(rec.session_key) || []
        list.push(rec)
        bySession.set(rec.session_key, list)

        // Check exact UTF-8 byte preservation on OMP multi-byte Chinese+emoji prompt.
        const firstText = rec.body.messages[0]?.content?.[0]?.text || ''
        if (firstText.length === Buffer.byteLength(ompFixture.firstUserText, 'utf8') && !rec.body.system) {
          verifiedOmpUtf8Bytes = true
        }

        // Check exact UTF-8 byte preservation on Claude system, tool description, thinking, and signature.
        if (rec.body.system?.length === 1 && rec.body.tools?.[0]?.description) {
          assert.equal(
            Buffer.byteLength(rec.body.system[0].text, 'utf8'),
            Buffer.byteLength(claudeFixture.sysText, 'utf8'),
          )
          assert.equal(
            Buffer.byteLength(rec.body.tools[0].description, 'utf8'),
            Buffer.byteLength(claudeFixture.toolDesc, 'utf8'),
          )
          const firstAsst = rec.body.messages[1]?.content || []
          const thBlk = firstAsst.find((b) => b.type === 'thinking')
          assert.ok(thBlk, 'expected thinking block preserved in Claude assistant turn')
          assert.equal(
            Buffer.byteLength(thBlk.thinking, 'utf8'),
            Buffer.byteLength(claudeFixture.firstThinking, 'utf8'),
          )
          assert.equal(Buffer.byteLength(thBlk.signature, 'utf8'), Buffer.byteLength(claudeFixture.firstSig, 'utf8'))
          verifiedClaudeShapeBytes = true
        }
      }

      assert.equal(verifiedOmpUtf8Bytes, true, 'expected OMP multi-byte UTF-8 byte-length preservation check to run')
      assert.equal(verifiedClaudeShapeBytes, true, 'expected Claude shape byte-length preservation check to run')

      // 5. Verify multi-turn session chains have strictly increasing turn_index & growing message counts.
      let multiTurnChecked = 0
      for (const chain of bySession.values()) {
        if (chain.length >= 2) {
          multiTurnChecked += 1
          for (let i = 1; i < chain.length; i += 1) {
            assert.equal(chain[i].turn_index, chain[i - 1].turn_index + 1)
            assert.ok(
              chain[i].body.messages.length > chain[i - 1].body.messages.length,
              'subsequent turn in session chain should extend conversation history',
            )
          }
        }
      }
      assert.ok(multiTurnChecked >= 1, 'expected at least one multi-turn session chain')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('build-corpus.py truncates oversized sessions cleanly on turn boundaries without breaking tool pairing', () => {
    const tmpRoot = makeTempDir('bench-20k-oversized-')
    try {
      const emptyOmp = path.join(tmpRoot, 'omp-empty')
      const claudeDir = path.join(tmpRoot, 'claude-ov')
      const outDir = path.join(tmpRoot, 'out')
      fs.mkdirSync(emptyOmp, { recursive: true })
      writeJsonl(path.join(claudeDir, 'huge/oversized.jsonl'), buildOversizedClaudeTranscriptRows())

      const minBytes = 8000
      const maxBytes = 14000
      execFileSync(
        'python3',
        [
          COMPILER_SCRIPT,
          '--omp-dir',
          emptyOmp,
          '--claude-dir',
          claudeDir,
          '--out-dir',
          outDir,
          '--min-bytes',
          String(minBytes),
          '--max-bytes',
          String(maxBytes),
          '--target-count',
          '5',
          '--seed',
          '42',
          '--verify-redaction',
        ],
        { encoding: 'utf8' },
      )

      const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'))
      assert.equal(manifest.redaction_audit.status, 'pass')
      assert.equal(manifest.source_counts.omp, 0)
      assert.ok(manifest.source_counts.claude >= 1)

      const records = fs
        .readFileSync(path.join(outDir, 'corpus-100k.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))

      for (const rec of records) {
        assertValidAnthropicRecord(rec, minBytes, maxBytes)
        // Must have truncated well before all 20 turns (41 messages).
        assert.ok(rec.body.messages.length < 41, 'oversized session should be truncated on real turn boundary')
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})

describe('bench-20k mock-upstream, probe & bootstrap', () => {
  it('mock-upstream streams valid Anthropic SSE, rate-limit headers, timing headers, and consumes 400KB body', async () => {
    const tmpDir = makeTempDir('bench-mock-u-')
    const mock = await startMockUpstream({
      port: 0,
      nodes: 200,
      ttftMs: 5,
      streamMs: 10,
      faultRate: 0,
      sockDir: tmpDir,
    })
    try {
      // 1. 400KB streaming request over TCP
      const pad = 'x'.repeat(400_000)
      const bodyText = JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: pad }],
      })
      const res = await fetch(`${mock.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bodyText,
      })
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') || '', /text\/event-stream/)
      assert.ok(Number(res.headers.get('x-mock-upstream-ms')) >= 0)
      assert.ok(Number(res.headers.get('x-mock-ttft-ms')) >= 0)
      assert.ok(res.headers.get('anthropic-ratelimit-unified-5h-utilization'))
      assert.ok(res.headers.get('anthropic-ratelimit-unified-7d-utilization'))
      assert.ok(res.headers.get('anthropic-ratelimit-unified-5h-reset'))

      const sse = await res.text()
      assert.ok(sse.includes('event: message_start'))
      assert.ok(sse.includes('event: content_block_start'))
      assert.ok(sse.includes('event: content_block_delta'))
      assert.ok(sse.includes('event: content_block_stop'))
      assert.ok(sse.includes('event: message_delta'))
      assert.ok(sse.includes('event: message_stop'))
      assert.ok(sse.includes('"stop_reason":"end_turn"'))
      assert.ok(sse.includes('"cache_read_input_tokens":'))

      // 2. Unix domain socket /internal/health and /internal/v1/messages (vm2api kernel path)
      assert.equal(mock.socketPaths.length, 1)
      const health = await httpUdsRequest(mock.socketPaths[0], '/internal/health')
      assert.equal(health.status, 200)
      const healthJson = JSON.parse(health.text)
      assert.equal(healthJson.ok, true)
      assert.equal(healthJson.ready, true)
      assert.equal(healthJson.engine, 'rust')

      const udsRes = await httpUdsRequest(mock.socketPaths[0], '/internal/v1/messages', {
        method: 'POST',
        body: { body: { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] } },
      })
      assert.equal(udsRes.status, 200)
      assert.ok(udsRes.text.includes('event: message_stop'))
      assert.ok(udsRes.text.includes('claude-haiku-4-5-20251001'))

      // 3. Stats accounting
      const statsRes = await fetch(`${mock.url}/__stats`)
      const stats = await statsRes.json()
      assert.equal(stats.requests, 2)
      assert.equal(stats.active, 0)
      assert.equal(stats.completed, 2)
      assert.equal(stats.injected429, 0)
      assert.equal(stats.injected502, 0)
      assert.ok(stats.bytesIn >= 400_000)
      assert.ok(stats.bytesOut > 500)
    } finally {
      await mock.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('mock-upstream injects deterministic 429 & 502 faults and resets stats', async () => {
    const mock = await startMockUpstream({ port: 0, ttftMs: 0, streamMs: 0, faultRate: 0 })
    try {
      const cfgRes = await fetch(`${mock.url}/__config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ forceNextFaults: [429, 502] }),
      })
      assert.equal(cfgRes.status, 200)

      const r429 = await fetch(`${mock.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"claude-sonnet-4-5-20250929","messages":[]}',
      })
      assert.equal(r429.status, 429)
      assert.equal(r429.headers.get('retry-after'), '2')
      assert.equal(r429.headers.get('anthropic-ratelimit-requests-remaining'), '0')
      assert.ok(r429.headers.get('x-mock-upstream-ms') !== null)
      const j429 = await r429.json()
      assert.equal(j429.error.type, 'rate_limit_error')

      const r502 = await fetch(`${mock.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"claude-sonnet-4-5-20250929","messages":[]}',
      })
      assert.equal(r502.status, 502)
      const j502 = await r502.json()
      assert.equal(j502.error.type, 'api_error')

      const r200 = await fetch(`${mock.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"claude-sonnet-4-5-20250929","messages":[]}',
      })
      assert.equal(r200.status, 200)
      await r200.text()

      const stats = await (await fetch(`${mock.url}/__stats`)).json()
      assert.equal(stats.requests, 3)
      assert.equal(stats.completed, 3)
      assert.equal(stats.injected429, 1)
      assert.equal(stats.injected502, 1)

      await fetch(`${mock.url}/__reset`, { method: 'POST' })
      const afterReset = await (await fetch(`${mock.url}/__stats`)).json()
      assert.equal(afterReset.requests, 0)
      assert.equal(afterReset.injected429, 0)
      assert.equal(afterReset.injected502, 0)
    } finally {
      await mock.close()
    }
  })

  it('mock-upstream multi-worker cluster mode aggregates /__stats across workers', async () => {
    const port = await pickFreePort()
    const tmpDir = makeTempDir('bench-mock-c-')
    const sockDir = path.join(tmpDir, 's')
    const readyFile = path.join(tmpDir, 'ready.json')

    const child = spawn(
      process.execPath,
      [
        MOCK_CLI,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--workers',
        '2',
        '--nodes',
        '200',
        '--ttft-ms',
        '0',
        '--stream-ms',
        '0',
        '--fault-rate',
        '0',
        '--sock-dir',
        sockDir,
        '--ready-file',
        readyFile,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    try {
      const deadline = Date.now() + 10_000
      let ready = null
      while (Date.now() < deadline) {
        if (fs.existsSync(readyFile)) {
          try {
            ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'))
            if (ready?.ok) break
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 80))
      }
      assert.ok(ready?.ok, 'cluster mock-upstream should become ready')
      assert.equal(ready.socketPaths.length, 2)

      await Promise.all(
        Array.from({ length: 8 }, (_, idx) =>
          httpUdsRequest(ready.socketPaths[idx % 2], '/internal/v1/messages', {
            method: 'POST',
            body: { body: { model: 'claude-sonnet-4-5-20250929', messages: [{ role: 'user', content: `m${idx}` }] } },
          }).then((r) => assert.equal(r.status, 200)),
        ),
      )

      const stats = await (await fetch(`${ready.url}/__stats`)).json()
      assert.equal(stats.workers, 2)
      assert.equal(stats.requests, 8)
      assert.equal(stats.completed, 8)
      assert.equal(stats.active, 0)
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise((r) => child.once('exit', r))
      }
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('sut-probe-preload captures Atomics.wait stalls, eventLoopDelay, memory, cpuUsage and supports /reset', async () => {
    const probe = startSutProbe({ port: 0 })
    await probe.ready
    try {
      const sab = new SharedArrayBuffer(4)
      const i32 = new Int32Array(sab)
      const res1 = Atomics.wait(i32, 0, 0, 18)
      assert.equal(res1, 'timed-out')
      const res2 = Atomics.wait(i32, 0, 1, 10)
      assert.equal(res2, 'not-equal')

      const m1 = await (await fetch(probe.metricsUrl)).json()
      assert.equal(m1.atomicsWait.count, 2)
      assert.equal(m1.atomicsWait.timedOutCount, 1)
      assert.equal(m1.atomicsWait.notEqualCount, 1)
      assert.ok(m1.atomicsWait.totalMs >= 10, `expected totalMs >= 10, got ${m1.atomicsWait.totalMs}`)
      assert.ok(m1.atomicsWait.maxMs >= 10, `expected maxMs >= 10, got ${m1.atomicsWait.maxMs}`)
      assert.equal(typeof m1.eventLoopDelayMs.p50, 'number')
      assert.equal(typeof m1.eventLoopDelayMs.p95, 'number')
      assert.equal(typeof m1.eventLoopDelayMs.p99, 'number')
      assert.ok(m1.memory.rss > 0)
      assert.ok(m1.uptimeSec > 0)

      const resetRes = await fetch(`${probe.url}/reset`, { method: 'POST' })
      assert.equal(resetRes.status, 200)

      const m2 = await (await fetch(probe.metricsUrl)).json()
      assert.equal(m2.atomicsWait.count, 0)
      assert.equal(m2.atomicsWait.totalMs, 0)
      assert.equal(m2.atomicsWait.cumulative.count, 2)
    } finally {
      await probe.close()
    }
  })

  it('sut-probe-preload works via NODE_OPTIONS=--import and stays inert when VM2API_BENCH_PROBE_PORT is unset', async () => {
    const probePort = await pickFreePort()
    const script = `
      const sab = new SharedArrayBuffer(4);
      const i32 = new Int32Array(sab);
      Atomics.wait(i32, 0, 0, 15);
      setTimeout(() => {}, 5000);
    `
    const child = spawn(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--import ${PROBE_PRELOAD}`,
        VM2API_BENCH_PROBE_PORT: String(probePort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const deadline = Date.now() + 8_000
      let metrics = null
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`http://127.0.0.1:${probePort}/metrics`)
          if (r.ok) {
            metrics = await r.json()
            if (metrics.atomicsWait.count >= 1) break
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 50))
      }
      assert.ok(metrics, 'preloaded probe metrics endpoint should respond')
      assert.equal(metrics.atomicsWait.count, 1)
      assert.ok(metrics.atomicsWait.totalMs >= 10)
    } finally {
      child.kill('SIGKILL')
      await new Promise((r) => child.once('exit', r))
    }

    // Verify inert when env var is unset
    const inert = spawn(process.execPath, ['-e', 'console.log(Atomics.wait.name)'], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--import ${PROBE_PRELOAD}`,
        VM2API_BENCH_PROBE_PORT: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    inert.stdout.on('data', (d) => {
      out += d.toString()
    })
    await new Promise((r) => inert.once('exit', r))
    assert.equal(out.trim(), 'wait')
  })

  it('docker-compose.bench.yml and bootstrap-sut safety rails match Phase 0 baseline contract', () => {
    const yml = fs.readFileSync(COMPOSE_FILE, 'utf8')
    assert.match(yml, /^name:\s*vm2api-bench/m)
    assert.match(yml, /postgres:18-alpine/)
    assert.match(yml, /127\.0\.0\.1:\$\{BENCH_PG_PORT:-55432\}:5432/)
    assert.match(yml, /redis:8-alpine/)
    assert.match(yml, /127\.0\.0\.1:\$\{BENCH_REDIS_PORT:-56379\}:6379/)
    assert.match(yml, /shared_buffers=\$\{BENCH_PG_SHARED_BUFFERS:-256MB\}/)
    assert.match(yml, /max_wal_size=\$\{BENCH_PG_MAX_WAL_SIZE:-1GB\}/)
    assert.match(yml, /max_connections=\$\{BENCH_PG_MAX_CONNECTIONS:-200\}/)
    assert.match(yml, /--appendonly/)
    assert.match(yml, /allkeys-lru/)
    assert.match(yml, /256mb/)

    assert.throws(() => assertSafeBenchPgUrl('postgresql://vm2api:pass@127.0.0.1:5432/db'), /port 5432/)
    assert.throws(() => assertSafeBenchPgUrl('postgresql://vm2api:pass@77.90.3.189:55432/db'), /non-local/)
    assert.doesNotThrow(() => assertSafeBenchPgUrl('postgresql://vm2api:pass@127.0.0.1:55432/vm2api_bench'))

    const parsedBoot = parseBootstrapArgs([
      '--sut-dir',
      '/tmp/sut',
      '--instances',
      '4',
      '--vms',
      '200',
      '--keys',
      '100',
    ])
    assert.equal(parsedBoot.instances, 4)
    assert.equal(parsedBoot.vms, 200)
    assert.equal(parsedBoot.keys, 100)

    const parsedMock = parseMockArgs(['--workers', '4', '--ttft-ms', '15', '--stream-ms', '40', '--fault-rate', '0.02'])
    assert.equal(parsedMock.workers, 4)
    assert.equal(parsedMock.ttftMs, 15)
    assert.equal(parsedMock.streamMs, 40)
    assert.equal(parsedMock.faultRate, 0.02)
  })
})

describe('bench-20k load-runner', () => {
  const cleanups = []
  after(async () => {
    for (const fn of cleanups.reverse()) {
      await fn().catch(() => {})
    }
  })

  it('computes exact latency percentiles and handles empty arrays', () => {
    const empty = computeLatencyStats([])
    assert.equal(empty.count, 0)
    assert.equal(empty.p95, 0)

    const samples = Array.from({ length: 100 }, (_, i) => i + 1)
    const stats = computeLatencyStats(samples)
    assert.equal(stats.count, 100)
    assert.equal(stats.min, 1)
    assert.equal(stats.p50, 50)
    assert.equal(stats.p95, 95)
    assert.equal(stats.p99, 99)
    assert.equal(stats.max, 100)
    assert.equal(stats.mean, 50.5)
  })

  it('pre-encodes corpus JSONL into Buffers, rotates headers, routes sticky across SUTs, and supports multi-worker', async () => {
    const tmpDir = makeTempDir('bench-20k-corpus-')
    cleanups.push(async () => fs.rmSync(tmpDir, { recursive: true, force: true }))

    const corpusFile = path.join(tmpDir, 'corpus-100k.jsonl')
    const rec1Body = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: 'A'.repeat(2048) }],
    }
    const rec2Body = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: 'B'.repeat(2048) }],
    }
    const lines = [
      JSON.stringify({
        id: 'rec-0001',
        session_key: 'sess-alpha',
        turn_index: 0,
        approx_tokens: 600,
        body_bytes: 2150,
        model: rec1Body.model,
        stream: true,
        body: rec1Body,
        expected_usage: { input_tokens: 600, output_tokens: 32 },
      }),
      JSON.stringify({
        id: 'rec-0002',
        session_key: 'sess-alpha',
        turn_index: 1,
        approx_tokens: 610,
        body_bytes: 2150,
        model: rec2Body.model,
        stream: true,
        body: rec2Body,
        expected_usage: { input_tokens: 610, output_tokens: 32 },
      }),
    ]
    fs.writeFileSync(corpusFile, `${lines.join('\n')}\n`, 'utf8')

    const templates = await loadCorpusTemplates(corpusFile)
    assert.equal(templates.length, 2)
    assert.ok(Buffer.isBuffer(templates[0].bodyBuffer))
    assert.equal(templates[0].bodyBuffer.toString('utf8'), JSON.stringify(rec1Body))

    const seen = []
    const makeHandler = (serverIdx) => async (req, res) => {
      const body = await readStreamBuf(req)
      seen.push({
        serverIdx,
        apiKey: req.headers['x-api-key'],
        sessionId: req.headers['x-session-id'],
        requestId: req.headers['x-request-id'],
        corpusId: req.headers['x-bench-corpus-id'],
        bodyLen: body.length,
      })
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-mock-upstream-ms': '1',
        'x-mock-ttft-ms': '0.5',
      })
      res.end('event: message_stop\ndata: {}\n\n')
    }

    const s1 = await startHttpServer(makeHandler(0))
    const s2 = await startHttpServer(makeHandler(1))
    cleanups.push(s1.close, s2.close)

    const result = await runLoadStep({
      corpusPath: corpusFile,
      sutUrls: [s1.url, s2.url],
      apiKeys: [
        { id: 'k1', key: 'sk-key-1', userId: 'u1' },
        { id: 'k2', key: 'sk-key-2', userId: 'u2' },
      ],
      targetRpm: 1200, // 20 req/s
      durationSec: 0.6,
      workers: 2,
      routing: 'sticky',
      panelPollers: 0,
    })

    assert.ok(result.completedCount >= 8, `expected >= 8 completed requests, got ${result.completedCount}`)
    assert.equal(result.ok2xxCount, result.completedCount)
    assert.equal(result.nonInjectedErrors, 0)
    assert.equal(result.saturated, false)
    assert.ok(result.overheadMs && result.overheadMs.count === result.completedCount)
    assert.ok(result.bytesOut > 0 && result.bytesIn > 0)

    // Verify exact pre-encoded body length & unique request IDs & sticky session routing
    const reqIds = new Set(seen.map((r) => r.requestId))
    assert.equal(reqIds.size, seen.length)
    const sessionToServer = new Map()
    for (const r of seen) {
      assert.ok(r.bodyLen === templates[0].bodyBytes || r.bodyLen === templates[1].bodyBytes)
      assert.ok(r.corpusId === 'rec-0001' || r.corpusId === 'rec-0002')
      if (sessionToServer.has(r.sessionId)) {
        assert.equal(sessionToServer.get(r.sessionId), r.serverIdx, 'sticky routing violated for same session')
      } else {
        sessionToServer.set(r.sessionId, r.serverIdx)
      }
    }
  })

  it('maintains open-loop schedule during downstream stall and flags saturated when maxInflight is reached', async () => {
    let peakConcurrent = 0
    let active = 0
    const server = await startHttpServer(async (req, res) => {
      active++
      if (active > peakConcurrent) peakConcurrent = active
      await readStreamBuf(req)
      setTimeout(() => {
        active--
        res.writeHead(200, { 'content-type': 'application/json', 'x-mock-upstream-ms': '180' })
        res.end('{"ok":true}')
      }, 200)
    })
    cleanups.push(server.close)

    const templates = [
      { id: 'rec-stall', sessionKey: 's1', body: { model: 'claude-sonnet-4-5-20250929', messages: [] } },
    ]
    // 1800 RPM = 30 req/s over 0.4s -> ~12 scheduled; maxInflight=3 caps in-flight and marks saturated
    const result = await runLoadStep({
      templates,
      sutUrls: [server.url],
      apiKeys: [{ id: 'k1', key: 'sk-1' }],
      targetRpm: 1800,
      durationSec: 0.4,
      maxInflight: 3,
      workers: 1,
      panelPollers: 0,
    })

    assert.equal(result.saturated, true)
    assert.ok(result.saturatedDrops > 0, `expected saturatedDrops > 0, got ${result.saturatedDrops}`)
    assert.ok(
      result.scheduledCount >= 9,
      `expected open-loop clock to schedule >= 9 ticks, got ${result.scheduledCount}`,
    )
    assert.ok(peakConcurrent <= 3, `expected peak concurrency <= 3, got ${peakConcurrent}`)
  })

  it('strips x-mock-upstream-ms / x-mock-ttft-ms and separates injected faults from non-injected errors', async () => {
    let seq = 0
    const server = await startHttpServer(async (req, res) => {
      await readStreamBuf(req)
      const n = ++seq
      if (n === 2) {
        res.writeHead(502, { 'x-mock-injected-fault': '502', 'x-mock-upstream-ms': '5' })
        res.end('{"error":"injected 502"}')
        return
      }
      if (n === 3) {
        res.writeHead(500, { 'x-mock-upstream-ms': '5' })
        res.end('{"error":"real 500"}')
        return
      }
      setTimeout(() => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'x-mock-upstream-ms': '30',
          'x-mock-ttft-ms': '15',
        })
        res.write('event: message_start\ndata: {}\n\n')
        setTimeout(() => {
          res.end('event: message_stop\ndata: {}\n\n')
        }, 15)
      }, 20)
    })
    cleanups.push(server.close)

    const result = await runLoadStep({
      templates: [{ id: 'rec-ovh', sessionKey: 's1', body: { hello: 'world' } }],
      sutUrls: [server.url],
      apiKeys: [{ id: 'k1', key: 'sk-1' }],
      targetRpm: 900, // 15 req/s
      durationSec: 0.4, // ~6 requests
      panelPollers: 0,
    })

    assert.ok(result.completedCount >= 5)
    assert.equal(result.injectedFaultHeaderCount, 1)
    assert.equal(result.nonInjectedErrors, 1)
    assert.equal(result.statusCounts['502'], 1)
    assert.equal(result.statusCounts['500'], 1)
    assert.ok(result.overheadMs.p50 < result.totalMs.p50, 'overhead p50 should be strictly less than total p50')
    assert.ok(result.ttftOverheadMs && result.ttftOverheadMs.p50 < result.ttftMs.p50)
  })

  it('runs concurrent admin & tenant panel read/write pollers respecting role ACLs', async () => {
    const panelCalls = []
    const server = await startHttpServer(async (req, res) => {
      await readStreamBuf(req)
      const u = new URL(req.url, 'http://127.0.0.1')
      if (u.pathname === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-mock-upstream-ms': '2' })
        res.end('{"ok":true}')
        return
      }
      const cookie = req.headers.cookie || ''
      const isAdmin = cookie.includes('role=admin')
      const isTenant = cookie.includes('role=tenant')
      panelCalls.push({ method: req.method, path: u.pathname + u.search, isAdmin, isTenant })

      // Enforce real panel ACL: /api/panel/dashboard and PUT /api/panel/backups/config are admin-only
      if (!isAdmin && (u.pathname === '/api/panel/dashboard' || req.method === 'PUT')) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end('{"ok":false,"error":"forbidden"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    cleanups.push(server.close)

    const result = await runLoadStep({
      templates: [{ id: 'rec-p', sessionKey: 's1', body: { ok: 1 } }],
      sutUrls: [server.url],
      apiKeys: [{ id: 'k1', key: 'sk-1' }],
      targetRpm: 600,
      durationSec: 0.45,
      panelPollers: 4,
      adminCookie: 'vm2api_panel=admin; role=admin',
      tenantCookies: ['vm2api_panel=t1; role=tenant', 'vm2api_panel=t2; role=tenant'],
      panelMinIntervalMs: 30,
      panelMaxIntervalMs: 50,
      panelWriteEveryN: 3,
      panelStagger: false,
    })

    assert.ok(result.panel.totalRequests >= 10, `expected >= 10 panel requests, got ${result.panel.totalRequests}`)
    assert.equal(result.panel.totalErrors, 0, 'expected 0 panel ACL/HTTP errors')
    assert.ok(result.panel.adminPollers >= 1 && result.panel.tenantPollers >= 1)
    assert.ok(
      Object.keys(result.panel.byEndpoint).some((k) => k.startsWith('admin:')),
      'expected admin endpoints recorded',
    )
    assert.ok(
      Object.keys(result.panel.byEndpoint).some((k) => k.startsWith('tenant:')),
      'expected tenant endpoints recorded',
    )
    assert.ok(
      panelCalls.some((c) => c.path.includes('refresh=1') || c.method === 'PUT'),
      'expected periodic panel write / forced refresh calls',
    )
  })
})

describe('bench-20k metrics-collector', () => {
  const cleanups = []
  after(async () => {
    for (const fn of cleanups.reverse()) {
      await fn().catch(() => {})
    }
  })

  it('parses Redis INFO and ranks commandstats by total usec', () => {
    const raw = [
      '# Memory',
      'used_memory:10485760',
      'used_memory_rss:15728640',
      'maxmemory:268435456',
      '# Stats',
      'total_commands_processed:50000',
      'instantaneous_ops_per_sec:1250',
      'keyspace_hits:40000',
      'keyspace_misses:10000',
      'evicted_keys:2',
      '# Persistence',
      'aof_enabled:1',
      'aof_delayed_fsync:1',
      'aof_current_size:4096',
      '# Commandstats',
      'cmdstat_get:calls=20000,usec=40000,usec_per_call=2.00',
      'cmdstat_evalsha:calls=5000,usec=150000,usec_per_call=30.00',
      'cmdstat_zadd:calls=3000,usec=12000,usec_per_call=4.00',
    ].join('\r\n')

    const parsed = parseRedisInfo(raw)
    assert.equal(parsed.usedMemoryBytes, 10485760)
    assert.equal(parsed.evictedKeys, 2)
    assert.equal(parsed.instantaneousOpsPerSec, 1250)
    assert.equal(parsed.hitRate, 0.8)
    assert.equal(parsed.aofDelayedFsync, 1)
    assert.equal(parsed.topCommandStats[0].cmd, 'evalsha')
    assert.equal(parsed.topCommandStats[1].cmd, 'get')
  })

  it('collects PG 18, Redis 8, SUT probes, PgLogWriter, and mock upstream stats and computes accurate diffs', async () => {
    let phase = 0
    let resetCalled = 0

    const probeServer = await startHttpServer((req, res) => {
      if (req.method === 'POST' && req.url === '/reset') {
        resetCalled++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
        return
      }
      if (req.url === '/metrics') {
        const data =
          phase === 0
            ? {
                eventLoopDelayMs: { p50: 1, p95: 3, p99: 5, max: 8 },
                atomicsWait: { count: 10, totalMs: 5, maxMs: 1 },
                memory: { rss: 100 * 1024 * 1024, heapUsed: 50 * 1024 * 1024, heapTotal: 70 * 1024 * 1024 },
                cpuUsage: {
                  userUs: 100_000,
                  systemUs: 20_000,
                  cumulativeUserUs: 1_000_000,
                  cumulativeSystemUs: 200_000,
                },
              }
            : {
                eventLoopDelayMs: { p50: 4, p95: 18, p99: 32, max: 45 },
                atomicsWait: { count: 110, totalMs: 255, maxMs: 9.5 },
                memory: { rss: 140 * 1024 * 1024, heapUsed: 75 * 1024 * 1024, heapTotal: 90 * 1024 * 1024 },
                cpuUsage: {
                  userUs: 2_000_000,
                  systemUs: 400_000,
                  cumulativeUserUs: 3_000_000,
                  cumulativeSystemUs: 600_000,
                },
              }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
        return
      }
      if (req.url === '/api/panel/request-logs/stats') {
        const w =
          phase === 0
            ? {
                queued: 0,
                enqueued: 10,
                flushed: 10,
                batches: 2,
                fallbacks: 0,
                overflowDirect: 0,
                dropped: 0,
                errors: 0,
                lastFlushMs: 2,
              }
            : {
                queued: 0,
                enqueued: 210,
                flushed: 210,
                batches: 12,
                fallbacks: 0,
                overflowDirect: 1,
                dropped: 0,
                errors: 0,
                lastFlushMs: 8,
              }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            config: { backend: 'postgres', total_rows: w.flushed, inflight_count: 0, pg_log_writer: w },
          }),
        )
        return
      }
      if (req.url === '/__stats') {
        const m =
          phase === 0
            ? { requests: 0, active: 0, completed: 0, injected429: 0, injected502: 0, bytesIn: 0, bytesOut: 0 }
            : {
                requests: 205,
                active: 0,
                completed: 205,
                injected429: 3,
                injected502: 2,
                bytesIn: 800000,
                bytesOut: 50000,
              }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(m))
        return
      }
      res.writeHead(404)
      res.end()
    })
    cleanups.push(probeServer.close)

    const fakePg = {
      async query(sql) {
        if (sql.includes('pg_stat_database')) {
          return {
            rows: [
              phase === 0
                ? {
                    datname: 'vm2api',
                    numbackends: 4,
                    xact_commit: 100,
                    xact_rollback: 0,
                    blks_read: 10,
                    blks_hit: 990,
                    tup_returned: 1000,
                    tup_fetched: 500,
                    tup_inserted: 10,
                    tup_updated: 5,
                    tup_deleted: 0,
                    deadlocks: 0,
                    temp_files: 0,
                    temp_bytes: 0,
                  }
                : {
                    datname: 'vm2api',
                    numbackends: 12,
                    xact_commit: 500,
                    xact_rollback: 1,
                    blks_read: 20,
                    blks_hit: 4980,
                    tup_returned: 5000,
                    tup_fetched: 2500,
                    tup_inserted: 410,
                    tup_updated: 105,
                    tup_deleted: 0,
                    deadlocks: 0,
                    temp_files: 0,
                    temp_bytes: 0,
                  },
            ],
          }
        }
        if (sql.includes('pg_stat_user_tables')) {
          return {
            rows:
              phase === 0
                ? [
                    {
                      relname: 'usage_logs',
                      seq_scan: 0,
                      seq_tup_read: 0,
                      idx_scan: 10,
                      idx_tup_fetch: 50,
                      n_tup_ins: 10,
                      n_tup_upd: 0,
                      n_tup_del: 0,
                      n_tup_hot_upd: 0,
                      n_live_tup: 10,
                      n_dead_tup: 0,
                      vacuum_count: 0,
                      autovacuum_count: 0,
                    },
                    {
                      relname: 'api_keys',
                      seq_scan: 0,
                      seq_tup_read: 0,
                      idx_scan: 20,
                      idx_tup_fetch: 20,
                      n_tup_ins: 10,
                      n_tup_upd: 5,
                      n_tup_del: 0,
                      n_tup_hot_upd: 5,
                      n_live_tup: 10,
                      n_dead_tup: 0,
                      vacuum_count: 0,
                      autovacuum_count: 0,
                    },
                  ]
                : [
                    {
                      relname: 'usage_logs',
                      seq_scan: 1,
                      seq_tup_read: 210,
                      idx_scan: 80,
                      idx_tup_fetch: 400,
                      n_tup_ins: 210,
                      n_tup_upd: 0,
                      n_tup_del: 0,
                      n_tup_hot_upd: 0,
                      n_live_tup: 210,
                      n_dead_tup: 0,
                      vacuum_count: 0,
                      autovacuum_count: 0,
                    },
                    {
                      relname: 'api_keys',
                      seq_scan: 0,
                      seq_tup_read: 0,
                      idx_scan: 220,
                      idx_tup_fetch: 220,
                      n_tup_ins: 10,
                      n_tup_upd: 55,
                      n_tup_del: 0,
                      n_tup_hot_upd: 50,
                      n_live_tup: 10,
                      n_dead_tup: 5,
                      vacuum_count: 0,
                      autovacuum_count: 0,
                    },
                  ],
          }
        }
        if (sql.includes('pg_stat_activity')) {
          return {
            rows:
              phase === 0
                ? [{ state: 'idle', wait_event_type: 'Client', cnt: '4' }]
                : [
                    { state: 'active', wait_event_type: 'Lock', cnt: '2' },
                    { state: 'idle', wait_event_type: 'Client', cnt: '10' },
                  ],
          }
        }
        if (sql.includes('pg_stat_wal')) {
          return {
            rows: [
              phase === 0
                ? { wal_records: '100', wal_fpi: '10', wal_bytes: '1048576', wal_buffers_full: '0' }
                : { wal_records: '900', wal_fpi: '25', wal_bytes: '11534336', wal_buffers_full: '2' },
            ],
          }
        }
        if (sql.includes('pg_total_relation_size')) {
          return {
            rows: [
              phase === 0
                ? { table_bytes: '8192', index_bytes: '16384', total_bytes: '24576', approx_rows: '10' }
                : { table_bytes: '65536', index_bytes: '98304', total_bytes: '163840', approx_rows: '210' },
            ],
          }
        }
        return { rows: [] }
      },
    }

    const fakeRedis = {
      async info() {
        return phase === 0
          ? 'used_memory:1048576\nmaxmemory:268435456\nevicted_keys:0\ninstantaneous_ops_per_sec:10\ntotal_commands_processed:100\nkeyspace_hits:80\nkeyspace_misses:20\naof_enabled:1\naof_delayed_fsync:0\ncmdstat_get:calls=50,usec=100,usec_per_call=2\n'
          : 'used_memory:4194304\nmaxmemory:268435456\nevicted_keys:0\ninstantaneous_ops_per_sec:500\ntotal_commands_processed:5100\nkeyspace_hits:4080\nkeyspace_misses:220\naof_enabled:1\naof_delayed_fsync:0\ncmdstat_get:calls=2050,usec=4100,usec_per_call=2\ncmdstat_evalsha:calls=1000,usec=15000,usec_per_call=15\n'
      },
    }

    const collector = createMetricsCollector({
      pgClient: fakePg,
      redisClient: fakeRedis,
      probeStatsUrls: [`${probeServer.url}/metrics`],
      sutUrls: [probeServer.url],
      mockUpstreamUrl: probeServer.url,
    })

    const resetRes = await resetSutProbes([`${probeServer.url}/metrics`])
    assert.equal(resetRes[0].ok, true)
    assert.equal(resetCalled, 1)

    const before = await collector.snapshot()
    before.tsMs = 10_000
    phase = 1
    const afterSnap = await collector.snapshot()
    afterSnap.tsMs = 20_000 // exact 10s elapsed

    const diff = diffSnapshots(before, afterSnap, { completedRequests: 200 })
    assert.equal(diff.elapsedSec, 10)
    assert.equal(diff.postgres.pgInsertsDelta, 200)
    assert.equal(diff.postgres.pgInsertsPerSec, 20)
    assert.equal(diff.postgres.pgUpdatesDelta, 50)
    assert.equal(diff.postgres.walBytesDelta, 10485760)
    assert.equal(diff.postgres.walMBPerSec, 1)
    assert.equal(diff.postgres.activityEnd.waiting, 2)
    assert.equal(diff.redis.totalCommandsDelta, 5000)
    assert.equal(diff.redis.redisOpsPerSec, 500)
    assert.equal(diff.redis.topCommandStatsDelta[0].cmd, 'evalsha')
    assert.equal(diff.probes.atomicsWaitCountDelta, 100)
    assert.equal(diff.probes.atomicsWaitsPerReq, 0.5)
    assert.equal(diff.probes.atomicsWaitMsPerReq, 1.25)
    assert.equal(diff.probes.cpuUserMsDelta, 2000)
    assert.equal(diff.probes.cpuSystemMsDelta, 400)
    assert.equal(diff.probes.cpuPct, 24)
    assert.equal(diff.pgLogWriter.overflowDirectDelta, 1)
    assert.equal(diff.mockUpstream.injected429Delta, 3)
    assert.equal(diff.mockUpstream.injected502Delta, 2)

    await collector.close()
  })
})

describe('bench-20k verify-closed-loop', () => {
  const cleanups = []
  after(async () => {
    for (const fn of cleanups.reverse()) {
      await fn().catch(() => {})
    }
  })

  it('reconciles api_keys billing counters against usage_logs sums and detects drift', () => {
    const clean = reconcileApiKeyBilling(
      [{ id: 'k1', quota_requests_used: 10, tokens_in: 1000, tokens_out: 200, quota_used: 0.1234 }],
      [{ api_key_id: 'k1', total_logs: 10, ok_logs: 10, sum_tokens_in: 1000, sum_tokens_out: 200, sum_cost: 0.1234 }],
    )
    assert.equal(clean.passed, true)
    assert.equal(clean.driftedKeyCount, 0)

    const drifted = reconcileApiKeyBilling(
      [{ id: 'k1', quota_requests_used: 9, tokens_in: 900, tokens_out: 200, quota_used: 0.1 }],
      [{ api_key_id: 'k1', total_logs: 10, ok_logs: 10, sum_tokens_in: 1000, sum_tokens_out: 200, sum_cost: 0.1234 }],
    )
    assert.equal(drifted.passed, false)
    assert.equal(drifted.driftedKeyCount, 1)
    assert.equal(drifted.diffs[0].diff.quota_requests_used, -1)
    assert.equal(drifted.diffs[0].diff.tokens_in, -100)
  })

  it('waits for drain and passes on clean closed-loop state', async () => {
    let poll = 0
    const sutServer = await startHttpServer((req, res) => {
      if (req.url === '/api/panel/request-logs/stats') {
        const queued = poll < 2 ? 5 : 0
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            config: {
              pg_log_writer: {
                queued,
                enqueued: 100,
                flushed: 100 - queued,
                batches: 4,
                fallbacks: 0,
                overflowDirect: 0,
                dropped: 0,
                errors: 0,
              },
            },
          }),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })
    cleanups.push(sutServer.close)

    const fakePg = {
      async query(sql) {
        if (sql.includes('SELECT COUNT(*)::bigint AS cnt FROM usage_logs')) {
          poll++
          return { rows: [{ cnt: poll < 2 ? '95' : '100' }] }
        }
        if (sql.includes('SUM(quota_requests_used)')) {
          return { rows: [{ cnt: poll < 2 ? '95' : '100' }] }
        }
        if (sql.includes('GROUP BY COALESCE(status, 0)')) {
          return { rows: [{ status: 200, cnt: '100' }] }
        }
        if (sql.includes('FROM api_keys')) {
          return {
            rows: [
              {
                id: 'k1',
                quota_requests_used: '100',
                requests: '100',
                tokens_in: '50000',
                tokens_out: '5000',
                quota_used: 1.25,
              },
            ],
          }
        }
        if (sql.includes('GROUP BY api_key_id')) {
          return {
            rows: [
              {
                api_key_id: 'k1',
                total_logs: '100',
                ok_logs: '100',
                sum_tokens_in: '50000',
                sum_tokens_out: '5000',
                sum_cost: 1.25,
              },
            ],
          }
        }
        return { rows: [] }
      },
    }

    const fakeRedis = {
      async info() {
        return 'evicted_keys:0\n'
      },
      async zcard() {
        return poll < 2 ? 2 : 0
      },
      async zrange() {
        return []
      },
    }

    const res = await verifyClosedLoop({
      pgClient: fakePg,
      redisClient: fakeRedis,
      sutUrls: [sutServer.url],
      expectedCompleted: 100,
      pollIntervalMs: 15,
      drainTimeoutMs: 2_000,
      stableChecks: 2,
    })

    assert.equal(res.passed, true, `unexpected failures: ${res.failures.join('; ')}`)
    assert.equal(res.drain.drained, true)
    assert.equal(res.checks.usageLogs.missingRows, 0)
    assert.equal(res.checks.apiKeyBilling.driftedKeyCount, 0)
    assert.equal(res.checks.pgLogWriter.counters.dropped, 0)
    assert.equal(res.checks.redis.evictedKeys, 0)
    assert.equal(res.checks.redis.liveInflightOrphans, 0)
  })

  it('detects usage_logs loss, api_keys drift, PgLogWriter overflow/drops, and Redis evictions/orphans', async () => {
    const sutServer = await startHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          config: {
            pg_log_writer: {
              queued: 0,
              enqueued: 100,
              flushed: 97,
              batches: 4,
              fallbacks: 1,
              overflowDirect: 2,
              dropped: 3,
              errors: 1,
            },
          },
        }),
      )
    })
    cleanups.push(sutServer.close)

    const fakePg = {
      async query(sql) {
        if (sql.includes('SELECT COUNT(*)::bigint AS cnt FROM usage_logs')) return { rows: [{ cnt: '97' }] }
        if (sql.includes('SUM(quota_requests_used)')) return { rows: [{ cnt: '95' }] }
        if (sql.includes('GROUP BY COALESCE(status, 0)')) return { rows: [{ status: 200, cnt: '97' }] }
        if (sql.includes('FROM api_keys')) {
          return {
            rows: [
              {
                id: 'k1',
                quota_requests_used: '95',
                requests: '95',
                tokens_in: '47500',
                tokens_out: '4750',
                quota_used: 1.0,
              },
            ],
          }
        }
        if (sql.includes('GROUP BY api_key_id')) {
          return {
            rows: [
              {
                api_key_id: 'k1',
                total_logs: '97',
                ok_logs: '97',
                sum_tokens_in: '48500',
                sum_tokens_out: '4850',
                sum_cost: 1.2,
              },
            ],
          }
        }
        return { rows: [] }
      },
    }

    const fakeRedis = {
      async info() {
        return 'evicted_keys:4\n'
      },
      async zcard() {
        return 2
      },
      async zrange() {
        return ['req-orphan-1', 'req-orphan-2']
      },
    }

    const res = await verifyClosedLoop({
      pgClient: fakePg,
      redisClient: fakeRedis,
      sutUrls: [sutServer.url],
      expectedCompleted: 100,
      pollIntervalMs: 10,
      drainTimeoutMs: 80,
      stableChecks: 2,
    })

    assert.equal(res.passed, false)
    assert.equal(res.checks.usageLogs.passed, false)
    assert.equal(res.checks.usageLogs.missingRows, 3)
    assert.equal(res.checks.apiKeyBilling.passed, false)
    assert.equal(res.checks.apiKeyBilling.driftedKeyCount, 1)
    assert.equal(res.checks.pgLogWriter.passed, false)
    assert.equal(res.checks.pgLogWriter.counters.dropped, 3)
    assert.equal(res.checks.pgLogWriter.counters.overflowDirect, 2)
    assert.equal(res.checks.redis.passed, false)
    assert.equal(res.checks.redis.evictedKeys, 4)
    assert.equal(res.checks.redis.liveInflightOrphans, 2)
    assert.deepEqual(res.checks.redis.sampleOrphans, ['req-orphan-1', 'req-orphan-2'])
  })
})

describe('bench-20k run-phase0 orchestrator & reporting', () => {
  const cleanups = []
  after(async () => {
    for (const fn of cleanups.reverse()) {
      await fn().catch(() => {})
    }
  })

  it('attributes CPU/EventLoop, Redis, Panel, and LoadGenerator bottlenecks accurately', () => {
    const redisAttr = attributeBottlenecks({
      targetRpm: 10000,
      load: { totalDurationSec: 20 },
      telemetry: {
        elapsedSec: 20,
        redis: {
          redisOpsPerSec: 15000,
          usedMemoryEndMb: 255,
          evictedKeysDelta: 50,
          aofDelayedFsyncDelta: 2,
          topCommandStatsDelta: [{ cmd: 'evalsha', calls: 1000, usec: 5000000, usecPerCall: 5000 }],
        },
      },
    })
    assert.equal(redisAttr[0].category, 'Redis')

    const panelAttr = attributeBottlenecks({
      targetRpm: 6000,
      load: {
        totalDurationSec: 20,
        panel: { totalRequests: 100, totalErrors: 3, overallLatencyMs: { p95: 900 } },
      },
      telemetry: { elapsedSec: 20 },
    })
    assert.equal(panelAttr[0].category, 'Panel')

    const genAttr = attributeBottlenecks({
      targetRpm: 20000,
      load: { saturated: true, peakInflight: 12000, maxInflight: 12000, maxScheduleLagMs: 120, totalDurationSec: 20 },
      telemetry: { elapsedSec: 20 },
    })
    assert.equal(genAttr[0].category, 'LoadGenerator')
  })

  it('orchestrates stepped sweep, detects knee + Atomics.wait/PG attribution, and renders Markdown + JSON reports', async () => {
    const tmpDir = makeTempDir('bench-20k-phase0-')
    cleanups.push(async () => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const reportPath = path.join(tmpDir, 'phase0-baseline.md')

    let snapIdx = 0
    const mockSnaps = [
      // baseline
      {
        tsMs: 0,
        redis: { evictedKeys: 0 },
        panelStats: {
          pgLogWriter: {
            enqueued: 0,
            flushed: 0,
            batches: 0,
            fallbacks: 0,
            overflowDirect: 0,
            dropped: 0,
            errors: 0,
            queued: 0,
          },
        },
      },
      // step 1 before
      {
        tsMs: 10_000,
        postgres: {
          database: { xactCommit: 0, xactRollback: 0, blksRead: 0, blksHit: 100, deadlocks: 0, tempBytes: 0 },
          tableTotals: { nTupIns: 0, nTupUpd: 0, nTupDel: 0, seqScan: 0, idxScan: 0 },
          tables: {
            usage_logs: { nTupIns: 0, nTupUpd: 0, nTupDel: 0, seqScan: 0, idxScan: 0, nDeadTup: 0, nLiveTup: 0 },
          },
          wal: { walRecords: 0, walFpi: 0, walBytes: 0, walBuffersFull: 0 },
          activity: { total: 4, active: 1, idle: 3, waiting: 0 },
        },
        redis: {
          totalCommandsProcessed: 0,
          usedMemoryBytes: 2 * 1024 * 1024,
          maxmemoryBytes: 256 * 1024 * 1024,
          evictedKeys: 0,
          keyspaceHits: 0,
          keyspaceMisses: 0,
          aofDelayedFsync: 0,
          instantaneousOpsPerSec: 10,
          commandstats: {},
        },
        probes: {
          instanceCount: 1,
          aggregate: {
            eventLoopDelayMs: { p50: 1, p95: 2, p99: 4, max: 6 },
            atomicsWait: { count: 0, totalMs: 0, maxMs: 0 },
            memory: { rssMb: 120, heapUsedMb: 60 },
            cpuUsage: { userUs: 0, systemUs: 0 },
          },
        },
        panelStats: {
          pgLogWriter: {
            queued: 0,
            enqueued: 0,
            flushed: 0,
            batches: 0,
            fallbacks: 0,
            overflowDirect: 0,
            dropped: 0,
            errors: 0,
            lastFlushMsMax: 1,
            queues: { usageLogs: 0, attempts: 0, debugRecords: 0 },
          },
        },
      },
      // step 1 after (healthy)
      {
        tsMs: 20_000,
        postgres: {
          database: { xactCommit: 100, xactRollback: 0, blksRead: 1, blksHit: 999, deadlocks: 0, tempBytes: 0 },
          tableTotals: { nTupIns: 100, nTupUpd: 20, nTupDel: 0, seqScan: 0, idxScan: 100 },
          tables: {
            usage_logs: { nTupIns: 100, nTupUpd: 0, nTupDel: 0, seqScan: 0, idxScan: 100, nDeadTup: 0, nLiveTup: 100 },
          },
          wal: { walRecords: 200, walFpi: 1, walBytes: 2 * 1024 * 1024, walBuffersFull: 0 },
          activity: { total: 4, active: 1, idle: 3, waiting: 0 },
        },
        redis: {
          totalCommandsProcessed: 1000,
          usedMemoryBytes: 4 * 1024 * 1024,
          maxmemoryBytes: 256 * 1024 * 1024,
          evictedKeys: 0,
          keyspaceHits: 900,
          keyspaceMisses: 50,
          aofDelayedFsync: 0,
          instantaneousOpsPerSec: 100,
          commandstats: {},
        },
        probes: {
          instanceCount: 1,
          aggregate: {
            eventLoopDelayMs: { p50: 2, p95: 8, p99: 15, max: 20 },
            atomicsWait: { count: 5, totalMs: 20, maxMs: 5 },
            memory: { rssMb: 130, heapUsedMb: 65 },
            cpuUsage: { userUs: 2_000_000, systemUs: 400_000 },
          },
        },
        panelStats: {
          pgLogWriter: {
            queued: 0,
            enqueued: 100,
            flushed: 100,
            batches: 5,
            fallbacks: 0,
            overflowDirect: 0,
            dropped: 0,
            errors: 0,
            lastFlushMsMax: 3,
            queues: { usageLogs: 0, attempts: 0, debugRecords: 0 },
          },
        },
      },
      // step 2 before
      {
        tsMs: 30_000,
        postgres: {
          database: { xactCommit: 100, xactRollback: 0, blksRead: 1, blksHit: 999, deadlocks: 0, tempBytes: 0 },
          tableTotals: { nTupIns: 100, nTupUpd: 20, nTupDel: 0, seqScan: 0, idxScan: 100 },
          tables: {
            usage_logs: { nTupIns: 100, nTupUpd: 0, nTupDel: 0, seqScan: 0, idxScan: 100, nDeadTup: 0, nLiveTup: 100 },
          },
          wal: { walRecords: 200, walFpi: 1, walBytes: 2 * 1024 * 1024, walBuffersFull: 0 },
          activity: { total: 6, active: 2, idle: 4, waiting: 0 },
        },
        redis: {
          totalCommandsProcessed: 1000,
          usedMemoryBytes: 4 * 1024 * 1024,
          maxmemoryBytes: 256 * 1024 * 1024,
          evictedKeys: 0,
          keyspaceHits: 900,
          keyspaceMisses: 50,
          aofDelayedFsync: 0,
          instantaneousOpsPerSec: 100,
          commandstats: {},
        },
        probes: {
          instanceCount: 1,
          aggregate: {
            eventLoopDelayMs: { p50: 1, p95: 2, p99: 3, max: 5 },
            atomicsWait: { count: 0, totalMs: 0, maxMs: 0 },
            memory: { rssMb: 130, heapUsedMb: 65 },
            cpuUsage: { userUs: 2_000_000, systemUs: 400_000 },
          },
        },
        panelStats: {
          pgLogWriter: {
            queued: 0,
            enqueued: 100,
            flushed: 100,
            batches: 5,
            fallbacks: 0,
            overflowDirect: 0,
            dropped: 0,
            errors: 0,
            lastFlushMsMax: 3,
            queues: { usageLogs: 0, attempts: 0, debugRecords: 0 },
          },
        },
      },
      // step 2 after (knee: heavy Atomics.wait + PG waiting connections)
      {
        tsMs: 40_000,
        postgres: {
          database: { xactCommit: 900, xactRollback: 0, blksRead: 50, blksHit: 4000, deadlocks: 0, tempBytes: 0 },
          tableTotals: { nTupIns: 1000, nTupUpd: 600, nTupDel: 0, seqScan: 3, idxScan: 900 },
          tables: {
            usage_logs: {
              nTupIns: 1000,
              nTupUpd: 0,
              nTupDel: 0,
              seqScan: 3,
              idxScan: 900,
              nDeadTup: 0,
              nLiveTup: 1000,
            },
          },
          wal: { walRecords: 5000, walFpi: 20, walBytes: 22 * 1024 * 1024, walBuffersFull: 5 },
          activity: { total: 20, active: 14, idle: 6, waiting: 6 },
        },
        redis: {
          totalCommandsProcessed: 8000,
          usedMemoryBytes: 12 * 1024 * 1024,
          maxmemoryBytes: 256 * 1024 * 1024,
          evictedKeys: 0,
          keyspaceHits: 6000,
          keyspaceMisses: 100,
          aofDelayedFsync: 0,
          instantaneousOpsPerSec: 700,
          commandstats: {},
        },
        probes: {
          instanceCount: 1,
          aggregate: {
            eventLoopDelayMs: { p50: 45, p95: 220, p99: 400, max: 600 },
            atomicsWait: { count: 4500, totalMs: 8200, maxMs: 35 },
            memory: { rssMb: 210, heapUsedMb: 110 },
            cpuUsage: { userUs: 7_500_000, systemUs: 1_200_000 },
          },
        },
        panelStats: {
          pgLogWriter: {
            queued: 50,
            enqueued: 1000,
            flushed: 950,
            batches: 25,
            fallbacks: 0,
            overflowDirect: 4,
            dropped: 0,
            errors: 0,
            lastFlushMsMax: 85,
            queues: { usageLogs: 50, attempts: 0, debugRecords: 0 },
          },
        },
      },
    ]

    let stoppedEnv = false
    const { report, markdown } = await runPhase0({
      label: 'baseline-test',
      steps: [600, 6000],
      stepSec: 10,
      cooldownSec: 0,
      outReport: reportPath,
      startEnvImpl: async () => ({
        session: {
          sutDir: '/mnt/x/vm2api',
          pgUrl: 'postgresql://mock',
          redisUrl: 'redis://mock',
          mockUpstreamUrl: 'http://127.0.0.1:9999',
          sutUrls: ['http://127.0.0.1:8080'],
          probeStatsUrls: ['http://127.0.0.1:19101/metrics'],
          adminCookie: 'a=1',
          tenantCookies: ['t=1'],
          apiKeys: [{ id: 'k1', key: 'sk-1', userId: 'u1' }],
        },
        async stop() {
          stoppedEnv = true
        },
      }),
      createCollectorImpl: () => ({
        async resetProbes() {
          return []
        },
        async snapshot() {
          return mockSnaps[Math.min(snapIdx++, mockSnaps.length - 1)]
        },
        async close() {},
      }),
      runLoadStepImpl: async ({ targetRpm }) =>
        targetRpm === 600
          ? {
              targetRpm: 600,
              achievedRpm: 600,
              achievedRatio: 1,
              completedCount: 100,
              ok2xxCount: 100,
              transportErrors: 0,
              nonInjectedErrors: 0,
              nonInjectedErrorRate: 0,
              saturated: false,
              saturatedDrops: 0,
              peakInflight: 5,
              totalDurationSec: 10,
              throughputTotalMBps: 4.1,
              totalMs: { p50: 45, p95: 70, p99: 90, max: 110 },
              ttftMs: { p50: 20, p95: 35, p99: 50, max: 60 },
              overheadMs: { p50: 12, p95: 25, p99: 40, max: 55 },
              panel: {
                pollers: 20,
                totalRequests: 50,
                totalErrors: 0,
                overallLatencyMs: { p50: 15, p95: 40, p99: 65 },
                byEndpoint: { 'admin:GET:dashboard': { errors: 0, latencyMs: { p95: 40 } } },
              },
            }
          : {
              targetRpm: 6000,
              achievedRpm: 4200,
              achievedRatio: 0.7,
              completedCount: 700,
              ok2xxCount: 695,
              transportErrors: 5,
              nonInjectedErrors: 5,
              nonInjectedErrorRate: 0.0071,
              saturated: false,
              saturatedDrops: 0,
              peakInflight: 380,
              totalDurationSec: 10,
              throughputTotalMBps: 28.5,
              totalMs: { p50: 350, p95: 920, p99: 1400, max: 2100 },
              ttftMs: { p50: 200, p95: 620, p99: 950, max: 1200 },
              overheadMs: { p50: 310, p95: 880, p99: 1350, max: 2040 },
              panel: {
                pollers: 20,
                totalRequests: 40,
                totalErrors: 1,
                overallLatencyMs: { p50: 180, p95: 720, p99: 1100 },
                byEndpoint: { 'admin:GET:dashboard': { errors: 1, latencyMs: { p95: 720 } } },
              },
            },
      verifyClosedLoopImpl: async ({ expectedCompleted }) => ({
        passed: true,
        failures: [],
        drain: { drained: true, elapsedMs: 600, polls: 2 },
        checks: {
          usageLogs: {
            passed: true,
            expectedCompleted,
            actualUsageLogs: expectedCompleted,
            missingRows: 0,
            lossRate: 0,
          },
          apiKeyBilling: {
            passed: true,
            totalKeysChecked: 1,
            driftedKeyCount: 0,
            totals: { apiKeysQuotaRequestsUsed: expectedCompleted, usageLogsOkCount: expectedCompleted },
          },
          pgLogWriter: {
            passed: true,
            available: true,
            counters: { queued: 0, overflowDirect: 0, fallbacks: 0, dropped: 0, errors: 0 },
          },
          redis: {
            passed: true,
            available: true,
            inflightKey: 'vm2api:live:inflight',
            evictedKeys: 0,
            liveInflightOrphans: 0,
          },
        },
      }),
    })

    assert.equal(stoppedEnv, true)
    assert.equal(report.analysis.peakHealthyRpm, 600)
    assert.equal(report.analysis.kneeDetected, true)
    assert.equal(report.analysis.kneeTargetRpm, 6000)
    assert.equal(report.analysis.primaryBottleneck.category, 'Atomics.wait')
    assert.ok(
      report.analysis.secondaryBottlenecks.some((b) => b.category === 'PostgreSQL' || b.category === 'CPU/EventLoop'),
    )
    assert.equal(report.closedLoop.passed, true)

    // Verify both .md and .json artifacts written cleanly
    const jsonPath = reportPath.replace(/\.md$/, '.json')
    assert.ok(fs.existsSync(reportPath))
    assert.ok(fs.existsSync(jsonPath))
    const parsedJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    assert.equal(parsedJson.meta.label, 'baseline-test')
    assert.ok(markdown.includes('# Phase 0 20K RPM Baseline Report — baseline-test'))
    assert.ok(markdown.includes('Atomics.wait'))
    assert.ok(markdown.includes('Closed-Loop Zero-Loss & Zero-Drift Verification'))

    // Verify pure detectKneeAndAttribution + renderPhase0Report stability
    const reEval = detectKneeAndAttribution(report.steps, report.meta.thresholds)
    assert.equal(reEval.kneeTargetRpm, 6000)
    assert.ok(renderPhase0Report(report).includes('6,000'))
  })
})
