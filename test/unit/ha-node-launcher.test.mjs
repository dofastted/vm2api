import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { getDb } from '../../src/lib/db/database.mjs'
import { nodeManagementFixture } from '../fixtures/node-management-fixture.mjs'
import { pickFreePort } from '../harness.mjs'

test('the real node fixture honors its exact configured listener instead of replacing it with loopback ephemeral', async (t) => {
  const port = await pickFreePort()
  const fx = await nodeManagementFixture(t, { listen: `127.0.0.1:${port}` })
  try {
    assert.equal(fx.node.link.address, '127.0.0.1')
    assert.equal(fx.node.link.port, port)
  } finally {
    await fx.close()
  }
})

test('standalone synthetic node exports private parameters, controls response completion, and cleans its exact resources', { timeout: 90000 }, async () => {
  const db = getDb()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-launcher-test-'))
  const config = path.join(root, 'config.json')
  fs.writeFileSync(config, JSON.stringify({ connectionString: db.connectionString, schema: db.schema, listen: '127.0.0.1:0' }), { mode: 0o600 })
  const child = spawn(process.execPath, [new URL('../fixtures/ha-node-launcher.mjs', import.meta.url).pathname, config], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  let artifact
  let params
  let output = ''
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  try {
    const file = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('synthetic launcher startup timeout')), 20000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`synthetic launcher exited ${code}: ${stderr}`)) })
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (!output.includes('\n')) return
        clearTimeout(timer)
        resolve(output.trim())
      })
    })
    assert.equal(path.isAbsolute(file), true)
    artifact = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(artifact.state, 'active')
    params = JSON.parse(fs.readFileSync(artifact.parametersFile, 'utf8'))
    assert.equal(fs.statSync(artifact.parametersFile).mode & 0o777, 0o600)
    assert.equal(params.schema, db.schema)
    assert.equal(params.syntheticProvider, true)
    assert.equal(params.launchReceipt.fence.executor.kind, 'container')
    assert.equal(JSON.parse(fs.readFileSync(params.trustFile, 'utf8')).nodes[params.nodeId].address, '127.0.0.1')
    await fetch(params.controlUrl + '/pause', { method: 'POST' })
    const request = (id) => new Promise((resolve, reject) => {
      const req = http.request({ socketPath: params.kernelSocket, method: 'POST', path: '/internal/v1/messages', headers: { 'content-type': 'application/json' } }, (res) => {
        let text = ''
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode, text }))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end(JSON.stringify({ request_id: id, body: {} }))
    })
    const held = [request('synthetic-paused-a'), request('synthetic-paused-b')]
    let observed
    for (let i = 0; i < 80; i++) {
      observed = await (await fetch(params.controlUrl + '/status')).json()
      if (observed.active === 2) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(observed.active, 2)
    assert.ok(observed.peak >= 2)
    assert.equal(observed.responded, 0)
    await fetch(params.controlUrl + '/resume', { method: 'POST' })
    for (const result of await Promise.all(held)) {
      assert.equal(result.status, 200)
      assert.match(result.text, /event: message_stop/)
    }
    await fetch(params.controlUrl + '/mode', { method: 'POST', body: JSON.stringify({ mode: 'json' }) })
    assert.equal(JSON.parse((await request('synthetic-json')).text).stop_reason, 'end_turn')
    await fetch(params.controlUrl + '/mode', { method: 'POST', body: JSON.stringify({ mode: 'error' }) })
    assert.equal((await request('synthetic-upstream-error')).status, 502)
    child.kill('SIGTERM')
    assert.equal((await exited)[0], 0)
    const cleaned = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(cleaned.state, 'cleaned')
    assert.deepEqual(cleaned.remainingDirs, [])
    assert.deepEqual(cleaned.remainingRoles, [])
    assert.deepEqual(cleaned.remainingPrivateSchemas, [])
    assert.equal(output.trim(), file, 'stdout contains only the resource manifest path')
  } finally {
    if (child.exitCode == null) {
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      try { await exited } finally { clearTimeout(timer) }
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})
