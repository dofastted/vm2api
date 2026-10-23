import test from 'node:test'
import assert from 'node:assert/strict'
import { slotRestartPolicy, syncLocalSlotRestartPolicies } from '../../src/lib/vm/vm-runtime.mjs'

const proxy = { id: 'px-test', host: '192.0.2.1', port: 1080 }

test('proxy slots leave all restarts to the egress-aware control plane', () => {
  assert.equal(slotRestartPolicy({ proxy }), 'no')
  assert.equal(slotRestartPolicy({}), 'no')
  assert.equal(slotRestartPolicy({ proxy: { id: 'px-local' } }), 'unless-stopped')
})

test('upgrade migrates running and paused local proxy containers without starting or replacing them', () => {
  const calls = []
  const vms = [
    { id: 'vm-01', status: 'running', proxy },
    { id: 'vm-02', status: 'paused', proxy },
    { id: 'vm-03', proxy: { id: 'px-local' } },
    { id: 'vm-04', proxy, node_id: 'remote' },
    { id: 'vm-05', proxy },
    { id: 'vm-06', proxy },
  ]
  const changed = syncLocalSlotRestartPolicies(vms, {
    run: (args) => {
      calls.push(args)
      if (args[1] === 'inspect') {
        if (args.at(-1) === 'kin-05') return { ok: false, stderr: 'Error: No such object: kin-05' }
        const policy = args.at(-1) === 'kin-06' ? 'no' : 'unless-stopped'
        return { ok: true, stdout: `true|1|kin-eg-px-test|now|image|host|||false|${policy}` }
      }
      return { ok: true }
    },
  })
  assert.deepEqual(changed, ['vm-01', 'vm-02'])
  assert.deepEqual(
    calls.filter((args) => args[1] !== 'inspect'),
    [
      ['docker', 'update', '--restart', 'no', 'kin-01'],
      ['docker', 'update', '--restart', 'no', 'kin-02'],
    ],
  )
  assert.equal(
    calls.some((args) => ['kin-03', 'kin-04'].includes(args.at(-1))),
    false,
  )
})

for (const failingCommand of ['inspect', 'update']) {
  test(`restart policy migration reports ${failingCommand} failure instead of claiming protection`, () => {
    assert.throws(
      () =>
        syncLocalSlotRestartPolicies([{ id: 'vm-01', proxy }], {
          run: (args) =>
            args[1] === failingCommand
              ? { ok: false, stderr: 'daemon unavailable' }
              : { ok: true, stdout: 'true|1|kin-eg-px-test|now|image|host|||false|unless-stopped' },
        }),
      /daemon unavailable/,
    )
  })
}
