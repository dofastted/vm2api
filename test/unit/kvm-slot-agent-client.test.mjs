import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  AGENT_MAX_CONTENT_BYTES,
  callAgentRpc,
  createKvmSlotAgentClient,
  ensureSlotAgentToken,
  readSlotAgentToken,
  resolveSlotAgentConnection,
  syncCustomKvmSlotFiles,
} from '../../src/lib/vm/kvm-slot-agent-client.mjs'

function startMockAgentServer(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ag-'))
  const socketPath = path.join(dir, 'agent.sock')
  const server = net.createServer((conn) => {
    let buf = ''
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      const req = JSON.parse(line)
      handler(req, conn)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      t.after(() => {
        server.close()
        fs.rmSync(dir, { recursive: true, force: true })
      })
      resolve({ dir, socketPath, server })
    })
  })
}

test('ensureSlotAgentToken creates and persists a 0600 64-hex token', (t) => {
  const kvmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ag-tok-'))
  t.after(() => fs.rmSync(kvmDir, { recursive: true, force: true }))

  const tok1 = ensureSlotAgentToken(kvmDir)
  assert.match(tok1, /^[a-f0-9]{64}$/)
  const tokenPath = path.join(kvmDir, '.agent-token')
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600)
  }

  const tok2 = ensureSlotAgentToken(kvmDir)
  assert.equal(tok2, tok1)

  // Corrupt token file is regenerated atomically.
  fs.writeFileSync(tokenPath, 'corrupt\n')
  const tok3 = ensureSlotAgentToken(kvmDir)
  assert.match(tok3, /^[a-f0-9]{64}$/)
  assert.notEqual(tok3, tok1)
})

test('createKvmSlotAgentClient executes all 7 RPC ops matching the newline-JSON wire protocol', async (t) => {
  const token = 'a'.repeat(64)
  const received = []
  const { socketPath } = await startMockAgentServer(t, (req, conn) => {
    received.push(req)
    assert.equal(req.token, token)
    const reply = { id: req.id, ok: true, result: { echoed_op: req.op, params: req.params } }
    conn.end(`${JSON.stringify(reply)}\n`)
  })

  const client = createKvmSlotAgentClient({ socketPath, token })

  const credBody = JSON.stringify({ claudeAiOauth: { accessToken: 'tok-123' } })
  const credSha = crypto.createHash('sha256').update(credBody).digest('hex')
  const r1 = await client.syncFile({ target: 'credentials', content: credBody })
  assert.equal(r1.ok, true)
  assert.equal(r1.result.echoed_op, 'sync_file')
  assert.equal(r1.result.params.target, 'credentials')
  assert.equal(r1.result.params.sha256, credSha)
  assert.equal(Buffer.from(r1.result.params.content_b64, 'base64').toString('utf8'), credBody)

  const r2 = await client.syncFile({ target: 'kernel_config', content: '{"vm_id":"vm-01"}' })
  assert.equal(r2.ok, true)
  assert.equal(r2.result.params.target, 'kernel_config')

  const r2b = await client.syncFile({
    target: 'worker_config',
    content: '{"vm_id":"vm-01","egress_mode":"transparent"}',
  })
  assert.equal(r2b.ok, true)
  assert.equal(r2b.result.params.target, 'worker_config')

  const r3 = await client.syncFile({
    target: 'managed_preset',
    name: '10-kin-workstation.json',
    content: '{"env":{"CLAUDE_CODE_DISABLE_AUTO_MEMORY":"1"}}',
  })
  assert.equal(r3.ok, true)
  assert.equal(r3.result.params.target, 'managed_preset')
  assert.equal(r3.result.params.name, '10-kin-workstation.json')

  const r4 = await client.publishSubscription({
    scope: 'license',
    files: [{ rel: 'license.json', content: '{"plan":"max"}' }],
  })
  assert.equal(r4.ok, true)
  assert.equal(r4.result.echoed_op, 'publish')
  assert.equal(r4.result.params.scope, 'license')
  assert.equal(r4.result.params.files[0].rel, 'license.json')

  const r5 = await client.publishUniversal({
    files: [{ rel: 'registration.code', content: Buffer.from('CRAGU1.test-permit') }],
  })
  assert.equal(r5.ok, true)
  assert.equal(r5.result.echoed_op, 'publish_universal')
  assert.equal(r5.result.params.scope, 'license')
  assert.equal(r5.result.params.files[0].rel, 'registration.code')

  const r6 = await client.blockSubscription({ scope: 'all', reason: 'revoked' })
  assert.equal(r6.ok, true)
  assert.equal(r6.result.echoed_op, 'block')
  assert.deepEqual(r6.result.params, { scope: 'all', reason: 'revoked' })

  const r7 = await client.clearSubscription({ scope: 'license' })
  assert.equal(r7.ok, true)
  assert.equal(r7.result.echoed_op, 'clear')
  assert.deepEqual(r7.result.params, { scope: 'license' })

  const r8 = await client.status()
  assert.equal(r8.ok, true)
  assert.equal(r8.result.echoed_op, 'status')

  const r8b = await client.restartCrag()
  assert.equal(r8b.ok, true)
  assert.equal(r8b.result.echoed_op, 'restart_crag')
  assert.deepEqual(r8b.result.params, {})

  const expectedCoreSha = 'b'.repeat(64)
  const r9 = await client.coreCheck({ expectedSha256: expectedCoreSha })
  assert.equal(r9.ok, true)
  assert.equal(r9.result.echoed_op, 'core_check')
  assert.deepEqual(r9.result.params, { expected_sha256: expectedCoreSha })

  assert.equal(received.length, 11)
})

test('createKvmSlotAgentClient rejects unsafe inputs locally before touching socket', async () => {
  const client = createKvmSlotAgentClient({ socketPath: '/nonexistent/agent.sock', token: 'c'.repeat(64) })

  assert.equal((await client.syncFile({ target: 'etc_passwd', content: 'x' })).error, 'invalid_target')
  assert.equal(
    (await client.syncFile({ target: 'managed_preset', name: '../escape.json', content: '{}' })).error,
    'invalid_preset_name',
  )
  assert.equal(
    (await client.syncFile({ target: 'managed_preset', name: 'bad.sh', content: '{}' })).error,
    'invalid_preset_name',
  )
  assert.equal(
    (await client.syncFile({ target: 'credentials', content: 'abc', sha256: '0'.repeat(64) })).error,
    'invalid_payload',
  )
  assert.equal(
    (
      await client.syncFile({
        target: 'credentials',
        content: Buffer.alloc(AGENT_MAX_CONTENT_BYTES + 1, 0x41),
      })
    ).error,
    'invalid_payload',
  )
  assert.equal(
    (await client.publishSubscription({ scope: 'license', files: [{ rel: '../evil', content: 'x' }] })).error,
    'invalid_payload',
  )
  assert.equal(
    (await client.publishUniversal({ files: [{ rel: 'universal/permit.sig', content: 'x' }] })).error,
    'invalid_payload',
  )
  for (const reserved of ['sync-pending', 'managed', 'lock']) {
    assert.equal(
      (await client.publishSubscription({ scope: 'license', files: [{ rel: reserved, content: 'x' }] })).error,
      'invalid_payload',
    )
  }
  assert.equal((await client.coreCheck({ expectedSha256: 'not-hex' })).error, 'invalid_sha256')
})

test('callAgentRpc handles auth errors, id mismatch, timeout, EOF, and unreachable socket', async (t) => {
  const token = 'd'.repeat(64)

  const errSrv = await startMockAgentServer(t, (req, conn) => {
    conn.end(`${JSON.stringify({ id: req.id, ok: false, error: 'unauthorized', message: 'bad token' })}\n`)
  })
  const authErr = await callAgentRpc({ socketPath: errSrv.socketPath, token, op: 'status' })
  assert.equal(authErr.ok, false)
  assert.equal(authErr.error, 'unauthorized')
  assert.equal(authErr.message, 'bad token')

  const mismatchSrv = await startMockAgentServer(t, (_req, conn) => {
    conn.end(`${JSON.stringify({ id: 'wrong-id', ok: true, result: {} })}\n`)
  })
  const idErr = await callAgentRpc({ socketPath: mismatchSrv.socketPath, token, op: 'status', id: 'req-1' })
  assert.equal(idErr.ok, false)
  assert.equal(idErr.error, 'agent_id_mismatch')

  const hangSrv = await startMockAgentServer(t, () => {
    // intentionally leave open
  })
  const timeoutErr = await callAgentRpc({ socketPath: hangSrv.socketPath, token, op: 'status', timeoutMs: 80 })
  assert.equal(timeoutErr.ok, false)
  assert.equal(timeoutErr.error, 'agent_timeout')

  const eofSrv = await startMockAgentServer(t, (_req, conn) => {
    conn.end()
  })
  const eofErr = await callAgentRpc({ socketPath: eofSrv.socketPath, token, op: 'status' })
  assert.equal(eofErr.ok, false)
  assert.equal(eofErr.error, 'agent_eof')

  const unreachable = await callAgentRpc({
    socketPath: path.join(os.tmpdir(), `kin-no-agent-${Date.now()}.sock`),
    token,
    op: 'status',
  })
  assert.equal(unreachable.ok, false)
  assert.equal(unreachable.error, 'agent_unreachable')
})

test('readSlotAgentToken, resolveSlotAgentConnection, and syncCustomKvmSlotFiles handle all targets and fail closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ag-sync-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = { id: 'vm-sync-1' }
  const kvmDir = path.join(root, 'vms', vm.id, 'kvm')
  const runDir = path.join(root, 'vms', vm.id, 'run')
  const claudeDir = path.join(root, 'vms', vm.id, 'cli-home', '.claude')
  const presetDir = path.join(kvmDir, 'fingerprint', 'system', 'etc', 'claude-code', 'managed-settings.d')
  for (const dir of [kvmDir, runDir, claudeDir, presetDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  assert.equal(readSlotAgentToken(kvmDir), '')
  const missingTokRes = await syncCustomKvmSlotFiles(root, vm)
  assert.equal(missingTokRes.ok, false)
  assert.equal(missingTokRes.error, 'agent_token_missing')

  const token = ensureSlotAgentToken(kvmDir)
  assert.equal(readSlotAgentToken(kvmDir), token)
  const conn = resolveSlotAgentConnection(root, vm)
  assert.equal(conn.token, token)
  assert.equal(conn.socketPath, path.join(kvmDir, 'agent.sock'))

  fs.writeFileSync(path.join(runDir, 'kernel.json'), '{"vm_id":"vm-sync-1"}\n')
  fs.writeFileSync(path.join(runDir, 'worker.json'), '{"vm_id":"vm-sync-1","egress_mode":"transparent"}\n')
  fs.writeFileSync(path.join(claudeDir, 'credentials.json'), '{"claudeAiOauth":{"accessToken":"tok"}}\n')
  fs.writeFileSync(path.join(presetDir, '10-workstation.json'), '{"env":{"CLAUDE_CODE_DISABLE_AUTO_MEMORY":"1"}}\n')
  fs.writeFileSync(path.join(presetDir, 'ignored.txt'), 'skip me\n')

  const pushed = []
  const { socketPath } = await startMockAgentServer(t, (req, connSock) => {
    pushed.push(req)
    assert.equal(req.token, token)
    connSock.end(`${JSON.stringify({ id: req.id, ok: true, result: { target: req.params.target } })}\n`)
  })

  const synced = await syncCustomKvmSlotFiles(root, vm, { socketPath })
  assert.equal(synced.ok, true)
  assert.deepEqual(synced.synced, [
    'kernel_config',
    'worker_config',
    'credentials',
    'managed_preset:10-workstation.json',
  ])
  assert.equal(pushed.length, 4)

  // Subset target sync only sends worker_config.
  const subsetPushed = []
  const subset = await syncCustomKvmSlotFiles(root, vm, {
    targets: ['worker_config'],
    client: {
      syncFile: async (params) => {
        subsetPushed.push(params)
        return { ok: true, result: { target: params.target } }
      },
    },
  })
  assert.equal(subset.ok, true)
  assert.deepEqual(subset.synced, ['worker_config'])
  assert.equal(subsetPushed.length, 1)
  assert.equal(subsetPushed[0].target, 'worker_config')

  // RPC failure fails closed immediately.
  const failed = await syncCustomKvmSlotFiles(root, vm, {
    targets: ['worker_config', 'credentials'],
    client: {
      syncFile: async () => ({ ok: false, error: 'invalid_params', message: 'rejected' }),
    },
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.target, 'worker_config')
  assert.equal(failed.error, 'invalid_params')

  // requiredTargets fails closed when required host files are missing or empty.
  fs.rmSync(path.join(runDir, 'worker.json'), { force: true })
  const missingWorker = await syncCustomKvmSlotFiles(root, vm, {
    targets: ['worker_config'],
    requiredTargets: ['worker_config'],
    client: { syncFile: async () => assert.fail('must not call syncFile when required file is missing') },
  })
  assert.equal(missingWorker.ok, false)
  assert.equal(missingWorker.target, 'worker_config')
  assert.equal(missingWorker.error, 'worker_config_missing')

  fs.writeFileSync(path.join(runDir, 'kernel.json'), '')
  const emptyKernel = await syncCustomKvmSlotFiles(root, vm, {
    targets: ['kernel_config'],
    requiredTargets: ['kernel_config'],
    client: { syncFile: async () => assert.fail('must not call syncFile when required file is empty') },
  })
  assert.equal(emptyKernel.ok, false)
  assert.equal(emptyKernel.target, 'kernel_config')
  assert.equal(emptyKernel.error, 'kernel_config_missing')
})
