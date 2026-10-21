import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb } from '../../src/lib/db/database.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'

test('operation identity fields cannot be reassigned while closure state can become uncertain',async () => {
  const operations = new SharedVmOperations(getDb(),{ownerId:'immutable-owner'})
  const operation = await operations.tryAcquire({vmId:'immutable-vm',kind:'node_allocate'})
  try {
    assert.equal(operation.ok,true)
    for (const field of ['operationId','ownerId','vmId','kind']) {
      assert.throws(() => {operation[field] = 'different-identity'},TypeError)
    }
    assert.equal(operation.uncertain,false)
    assert.equal((await operation.markUncertain()).uncertain,true)
    assert.equal(operation.uncertain,true)
    assert.equal((await operation.release()).released,false)
  } finally {await operation.release()}
})
