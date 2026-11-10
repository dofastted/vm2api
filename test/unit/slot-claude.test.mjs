import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSlotClaude } from '../../src/lib/vm/slot-engine.mjs'

test('slot CLI follows VM kernel pins, inherited routing and placement without fallback', () => {
  const local = { bins: { cli: '/home/kincli/.kin/cli-node', cc: '/home/kincli/.kin/cc-node' } }
  const remote = { bakedKernel: true, bins: { cli: '/opt/kin/cli-node', cc: '/opt/kin/cc-node' } }
  const routing = { inference: { dataplane: 'crag', crag_kernel_version: 'v2' } }
  assert.deepEqual(resolveSlotClaude({}, routing, local), {
    bin: '/home/kincli/.kin/crag-v2/claude-code-2.1.321/claude',
    native: true,
  })
  assert.equal(resolveSlotClaude({}, routing, remote).bin, '/opt/kin-live/crag-v2/claude-code-2.1.321/claude')
  assert.deepEqual(resolveSlotClaude({ dataplane: 'wrap' }, routing, remote), {
    bin: '/opt/kin/cli-node',
    native: false,
  })
  assert.equal(resolveSlotClaude({ dataplane: 'cc' }, routing, local).bin, local.bins.cc)
  assert.equal(
    resolveSlotClaude({ crag_kernel_version: 'legacy' }, routing, local).bin,
    '/home/kincli/.kin/crag-v2/claude-code-2.1.321/claude',
  )
})
