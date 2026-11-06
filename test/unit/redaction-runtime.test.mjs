import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureRedaction,
  maskJson,
  publishRedactionForTests,
  restoreJsonValue,
} from '../../src/lib/redaction/runtime.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-redact-runtime-'))
const bin = path.join(root, 'kin-redact')

let helper = null

afterEach(() => {
  helper?.kill()
  helper = null
  publishRedactionForTests(null)
})

describe('redaction runtime', () => {
  it('stays out of the request path when the switch is off', async () => {
    const state = await ensureRedaction({}, { projectRoot: root, binPath: bin })
    expect(state.enabled).toBe(false)
    expect(state.ready).toBe(true)
    await expect(
      maskJson({ messages: [{ role: 'user', content: 'sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg' }] }, { principal: 'key-a' }),
    ).resolves.toEqual({
      messages: [{ role: 'user', content: 'sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg' }],
    })
  })

  it('masks and restores through the real helper when enabled', async () => {
    execFileSync('go', ['build', '-o', bin, './cmd/kin-redact'], {
      cwd: path.join(process.cwd(), 'redact'),
      stdio: 'inherit',
    })
    const policy = { enabled: true, secrets: true, personal: false, words: [], rules: [] }
    const state = await ensureRedaction({ redaction: policy }, { projectRoot: root, binPath: bin })
    expect(state.ready).toBe(true)
    helper = state.child
    const secret = 'sk-' + 'proj-' + 'Aa1Bb2Cc3Dd4Ee5Ff6Gg'
    const masked = await maskJson(
      { messages: [{ role: 'user', content: `token ${secret}` }] },
      { principal: 'key-a', session: 's1' },
    )
    const text = JSON.stringify(masked)
    expect(text).not.toContain(secret)
    expect(text).toContain('{{R_API_KEY_')
    const restored = await restoreJsonValue(masked, { principal: 'key-a', session: 's1' })
    expect(JSON.stringify(restored)).toContain(secret)
    const other = await restoreJsonValue(masked, { principal: 'key-b', session: 's1' })
    expect(JSON.stringify(other)).not.toContain(secret)
    state.child?.kill()
  }, 60_000)
})
