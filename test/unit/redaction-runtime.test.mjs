import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  ensureRedaction,
  maskJson,
  publishRedactionForTests,
  restoreJsonValue,
} from '../../src/lib/redaction/runtime.mjs'

let root
let bin
let helper = null

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-redact-runtime-'))
  bin = path.join(root, 'kin-redact')
})

afterEach(async () => {
  try {
    if (helper && helper.exitCode === null && helper.signalCode === null) {
      const closed = once(helper, 'close')
      helper.kill()
      await closed
    }
  } finally {
    helper = null
    publishRedactionForTests(null)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('redaction runtime', () => {
  it('stays out of the request path when the switch is off', async () => {
    const policy = { enabled: false, secrets: true, personal: false }
    await ensureRedaction({ redaction: policy }, { projectRoot: root, binPath: bin })
    const body = { messages: [{ role: 'user', content: 'sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg' }] }
    assert.equal(await maskJson(body), body)
    assert.equal(await restoreJsonValue(body), body)
  })

  it('masks and restores through the real helper when enabled', { timeout: 60_000 }, async () => {
    execFileSync('go', ['build', '-o', bin, './cmd/kin-redact'], {
      cwd: path.join(process.cwd(), 'redact'),
      stdio: 'inherit',
    })
    const policy = { enabled: true, secrets: true, personal: false, words: [], rules: [] }
    const state = await ensureRedaction({ redaction: policy }, { projectRoot: root, binPath: bin })
    helper = state.child
    const secret = 'sk-' + 'proj-' + 'Aa1Bb2Cc3Dd4Ee5Ff6Gg'
    const body = { messages: [{ role: 'user', content: `token ${secret}` }] }
    const masked = await maskJson(body, { principal: 'key-a', session: 's1' })
    const text = JSON.stringify(masked)
    assert.ok(!text.includes(secret))
    assert.match(text, /\{\{R_API_KEY_/)
    const restored = await restoreJsonValue(masked, { principal: 'key-a', session: 's1' })
    assert.deepEqual(restored, body)
    const other = await restoreJsonValue(masked, { principal: 'key-b', session: 's1' })
    assert.deepEqual(other, masked)
  })
})
