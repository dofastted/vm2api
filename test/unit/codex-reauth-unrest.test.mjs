import assert from 'node:assert/strict'
import test from 'node:test'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'

function makePool() {
  const unrested = []
  const pool = new PoolScheduler({
    runtimeRepo: { clearAuthCooldown: () => false, clearGrantRevokeCooldown: () => false },
    schedulerRuntime: {
      unrestNode: async (nodeKey) => {
        unrested.push(nodeKey)
        return { sink_cleared: true }
      },
    },
  })
  return { pool, unrested }
}

test('unrestCodexNode clears the codex_vm node, not the claude_vm one (#2086)', () => {
  const { pool, unrested } = makePool()
  assert.equal(pool.unrestCodexNode('laborrushes-3l9m0ix9icloudcom'), true)
  assert.deepEqual(unrested, ['codex_vm:laborrushes-3l9m0ix9icloudcom'])
})

test('unrestVmNode keeps targeting claude_vm only (contract unchanged)', () => {
  const { pool, unrested } = makePool()
  assert.equal(pool.unrestVmNode('vm-35'), true)
  assert.deepEqual(unrested, ['claude_vm:vm-35'])
})

test('unrestCodexNode is a no-op without an id or without a scheduler runtime', () => {
  const { pool, unrested } = makePool()
  assert.equal(pool.unrestCodexNode(''), false)
  assert.equal(pool.unrestCodexNode(null), false)
  assert.deepEqual(unrested, [])
  const bare = new PoolScheduler({})
  assert.equal(bare.unrestCodexNode('x'), false)
})

test('a rejected Rust unrest never throws into the caller', async () => {
  const pool = new PoolScheduler({
    schedulerRuntime: {
      unrestNode: async () => {
        throw new Error('scheduler down')
      },
    },
  })
  assert.doesNotThrow(() => pool.unrestCodexNode('vm-1'))
  await new Promise((r) => setTimeout(r, 5))
})

// The bug behind #2086 was a half-fix: every place that reopens a Codex slot after a
// credential change cleared the JS-side hold (`clearOpenAIAccountHold`) but not the Rust
// scheduler's own penalty, so the revoked node stayed "busy" until the scheduler restarted.
// Guard the wiring: each reopen site must also unrest the Rust node.
test('every clearOpenAIAccountHold reopen site in panel-routes also unrests the Rust node', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../../src/lib/admin/panel-routes.mjs', import.meta.url), 'utf8')
  const lines = src.split('\n')
  const sites = []
  lines.forEach((line, i) => {
    if (/\bclearOpenAIAccountHold\(/.test(line) && !/^\s*import\b/.test(line)) sites.push(i)
  })
  assert.ok(sites.length >= 2, `expected at least 2 reopen sites, found ${sites.length}`)
  for (const i of sites) {
    const window = lines.slice(i, i + 6).join('\n')
    assert.match(
      window,
      /unrestCodexNode\?\.\(/,
      `clearOpenAIAccountHold at panel-routes.mjs:${i + 1} is not followed by unrestCodexNode`,
    )
  }
})

test('commitImportedCodexVm callers hand the pool scheduler through', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../../src/lib/admin/panel-routes.mjs', import.meta.url), 'utf8')
  const calls = [...src.matchAll(/await commitImportedCodexVm\(\{([\s\S]*?)\n\s*\}\)/g)]
  assert.ok(calls.length >= 2, `expected 2+ callers, found ${calls.length}`)
  for (const [, body] of calls) assert.match(body, /poolScheduler:\s*ctx\.poolScheduler/)
})
