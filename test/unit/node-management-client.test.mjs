import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import * as management from '../../src/lib/transport/slotgate-management-client.mjs'
import { NodeManagementGrants } from '../../src/lib/cluster/node-management-grants.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'

import { nodeManagementFixture as fixture, vmId, payload } from '../fixtures/node-management-fixture.mjs'

function nodeCase(name, callback) {
  test(name, async (t) => {
    const fx = await fixture(t)
    try {
      await callback(fx, t)
    } finally {
      await fx.close()
    }
  })
}

test('management transport validates the bounded payload before opening any connection', async (t) => {
  let connections = 0
  t.mock.method(tls, 'connect', () => {
    connections++
    throw new Error('unexpected network')
  })
  for (const value of [Buffer.alloc(0), Buffer.alloc(65537)]) {
    await assert.rejects(management.publishNodeSlotInitial({ link: {}, grant: {}, payload: value }), {
      code: 'node_command_invalid',
      vmOperationNotStarted: true,
    })
  }
  assert.equal(connections, 0)
})

nodeCase(
  'real PostgreSQL grants drive pinned TLS initial publication and launch without holding a transaction over node I/O',
  async (fx, t) => {
    const connect = tls.connect
    let sends = 0
    t.mock.method(tls, 'connect', (...args) => {
      assert.equal(fx.db.isTransaction, false)
      sends++
      return connect.apply(tls, args)
    })
    const published = await fx.run('node_publish_initial', (operation) =>
      fx.service.publishInitial(fx.input(operation)),
    )
    assert.equal(published.manifest_revision, '1')
    assert.equal(fx.calls.length, 0, 'publishing never calls Docker')
    const launched = await fx.run('node_launch', (operation) =>
      fx.service.launch(
        fx.input(operation, {
          commandId: 'wire-launch',
          manifestDigest: published.manifest_digest,
        }),
      ),
    )
    assert.equal(sends, 2, 'one management connection per issued action')
    assert.equal(launched.fence.executor.kind, 'container')
    assert.equal(launched.fence.executor.container_id, 'b'.repeat(64))
    assert.equal(launched.fence.incarnation, fx.allocated.fence.incarnation)
    assert.deepEqual(await new NodeManagementGrants(fx.peer).readLaunchReceipt({ vmId }), launched)
    const rows = (await fx.peer.query(`SELECT receipt,revoked_at FROM ${fx.q}.command_grants`)).rows
    assert.ok(rows.every((row) => row.revoked_at && row.receipt))
    assert.equal(JSON.stringify(rows).includes('synthetic-command-access'), false)
    assert.equal(JSON.stringify(rows).includes('synthetic-command-refresh'), false)
    assert.equal(fx.calls.filter((call) => call.startsWith('POST /containers/create')).length, 1)
  },
)

nodeCase(
  'a lost publication acknowledgement retains the original VM operation and does not issue another command',
  async (fx, t) => {
    const connect = tls.connect
    let sends = 0
    t.mock.method(tls, 'connect', (...args) => {
      sends++
      const socket = connect.apply(tls, args)
      const emit = socket.emit
      socket.emit = function (event, ...values) {
        if (event === 'data') {
          socket.destroy()
          return true
        }
        return emit.call(this, event, ...values)
      }
      return socket
    })
    await assert.rejects(
      fx.run('node_publish_initial', (operation) => fx.service.publishInitial(fx.input(operation))),
      { code: 'node_publication_unconfirmed', vmOperationUncertain: true },
    )
    assert.equal(sends, 1)
    assert.equal(fx.calls.length, 0)
    const row = (await fx.peer.query(`SELECT receipt,revoked_at FROM ${fx.q}.command_grants`)).rows[0]
    assert.equal(row.receipt, null)
    assert.ok(row.revoked_at)
    const operation = (
      await fx.peer.query("SELECT released_at,uncertain_at FROM vm_operations WHERE kind='node_publish_initial'")
    ).rows[0]
    assert.equal(operation.released_at, null)
    assert.ok(operation.uncertain_at)
    assert.equal((await new SharedVmOperations(fx.peer).tryAcquire({ vmId })).ok, false)
    const remoteConfig = path.join(
      fx.node.root,
      'runtime',
      'vms',
      vmId,
      'incarnations',
      fx.allocated.fence.incarnation,
      'config',
      'kernel.json',
    )
    assert.equal(fs.existsSync(remoteConfig), true, 'the real node committed files before its acknowledgement was lost')
  },
)

nodeCase(
  'failure to commit the received node receipt retains ownership and never repeats the mutation',
  async (fx, t) => {
    await fx.db.query(`CREATE FUNCTION reject_command_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic receipt failure' USING ERRCODE='P648C'; END$$;
    CREATE TRIGGER reject_command_receipt BEFORE UPDATE OF receipt ON ${fx.q}.command_grants FOR EACH ROW EXECUTE FUNCTION reject_command_receipt()`)
    const connect = tls.connect
    let sends = 0
    t.mock.method(tls, 'connect', (...args) => {
      sends++
      return connect.apply(tls, args)
    })
    await assert.rejects(
      fx.run('node_publish_initial', (operation) => fx.service.publishInitial(fx.input(operation))),
      { code: 'P648C' },
    )
    assert.equal(sends, 1)
    const row = (await fx.peer.query(`SELECT receipt,revoked_at FROM ${fx.q}.command_grants`)).rows[0]
    assert.equal(row.receipt, null)
    assert.ok(row.revoked_at)
    const operation = (
      await fx.peer.query("SELECT released_at,uncertain_at FROM vm_operations WHERE kind='node_publish_initial'")
    ).rows[0]
    assert.equal(operation.released_at, null)
    assert.ok(operation.uncertain_at)
  },
)

nodeCase('a payload digest mismatch is rejected before TLS or any publication bytes', async (fx, t) => {
  let connections = 0
  t.mock.method(tls, 'connect', () => {
    connections++
    throw new Error('unexpected network')
  })
  await fx.run('node_publish_initial', async (operation) => {
    const grant = await fx.service.issueInitialPublish(
      fx.input(operation, {
        expectedManifestRevision: '0',
        revision: '1',
        payloadDigest: crypto.createHash('sha256').update(payload).digest('hex'),
      }),
    )
    await assert.rejects(
      management.publishNodeSlotInitial({ link: fx.node.link, grant, payload: Buffer.from('tampered input') }),
      {
        code: 'node_command_invalid',
        vmOperationNotStarted: true,
      },
    )
  })
  assert.equal(connections, 0)
  assert.equal(fx.calls.length, 0)
})

nodeCase(
  'DRAINING refusal before issuing a publication sends no bytes and releases only that unstarted operation',
  async (fx, t) => {
    const maintenance = await fx.coordinator.beginMaintenance({ kind: 'backup' })
    let connections = 0
    t.mock.method(tls, 'connect', () => {
      connections++
      throw new Error('unexpected network')
    })
    try {
      await assert.rejects(
        fx.run('node_publish_initial', (operation) => fx.service.publishInitial(fx.input(operation))),
        {
          code: 'node_command_epoch_stale',
          vmOperationNotStarted: true,
        },
      )
      assert.equal(connections, 0)
      assert.equal((await fx.peer.query(`SELECT count(*) AS n FROM ${fx.q}.command_grants`)).rows[0].n, 0)
      const operation = (
        await fx.peer.query("SELECT released_at,uncertain_at FROM vm_operations WHERE kind='node_publish_initial'")
      ).rows[0]
      assert.ok(operation.released_at)
      assert.equal(operation.uncertain_at, null)
    } finally {
      try {
        const pending = (await fx.peer.query('SELECT count(*) AS n FROM vm_operations WHERE released_at IS NULL'))
          .rows[0].n
        if (!pending) await maintenance.resume()
      } finally {
        await maintenance.close()
      }
    }
  },
)

nodeCase('a certificate pin mismatch sends no application bytes and retains no active VM operation', async (fx, t) => {
  const connect = tls.connect
  let writes = 0
  t.mock.method(tls, 'connect', (...args) => {
    const socket = connect.apply(tls, args)
    const write = socket.write
    socket.write = function (...values) {
      writes++
      return write.apply(this, values)
    }
    return socket
  })
  fx.service.resolveNodeLink = async () => ({ ...fx.node.link, certSha256: 'f'.repeat(64) })
  await assert.rejects(
    fx.run('node_publish_initial', (operation) => fx.service.publishInitial(fx.input(operation))),
    {
      code: 'node_publication_unconfirmed',
      vmOperationNotStarted: true,
    },
  )
  assert.equal(writes, 0)
  const operation = (
    await fx.peer.query("SELECT released_at,uncertain_at FROM vm_operations WHERE kind='node_publish_initial'")
  ).rows[0]
  assert.ok(operation.released_at)
  assert.equal(operation.uncertain_at, null)
})

nodeCase(
  'an extra secret field in a completed node acknowledgement is rejected and never persisted or exposed',
  async (fx, t) => {
    const connect = tls.connect
    t.mock.method(tls, 'connect', (...args) => {
      const socket = connect.apply(tls, args)
      const emit = socket.emit
      let bytes = Buffer.alloc(0)
      socket.emit = function (event, ...values) {
        if (event !== 'data') return emit.call(this, event, ...values)
        bytes = Buffer.concat([bytes, values[0]])
        const newline = bytes.indexOf(10)
        if (newline < 0) return true
        const reply = JSON.parse(bytes.subarray(0, newline))
        reply.publication.access_token = 'synthetic-response-secret'
        return emit.call(this, 'data', Buffer.from(JSON.stringify(reply) + '\n'))
      }
      return socket
    })
    await assert.rejects(
      fx.run('node_publish_initial', (operation) => fx.service.publishInitial(fx.input(operation))),
      (error) => {
        assert.equal(error.code, 'node_publication_unconfirmed')
        assert.equal(error.vmOperationUncertain, true)
        assert.equal(error.message.includes('synthetic-response-secret'), false)
        return true
      },
    )
    assert.equal((await fx.peer.query(`SELECT receipt FROM ${fx.q}.command_grants`)).rows[0].receipt, null)
  },
)

nodeCase('a lost launch acknowledgement preserves the exact launch operation after Docker start', async (fx, t) => {
  const published = await fx.run('node_publish_initial', (operation) => fx.service.publishInitial(fx.input(operation)))
  const connect = tls.connect
  let sends = 0
  t.mock.method(tls, 'connect', (...args) => {
    sends++
    const socket = connect.apply(tls, args)
    const emit = socket.emit
    socket.emit = function (event, ...values) {
      if (event === 'data') {
        socket.destroy()
        return true
      }
      return emit.call(this, event, ...values)
    }
    return socket
  })
  await assert.rejects(
    fx.run('node_launch', (operation) =>
      fx.service.launch(
        fx.input(operation, {
          commandId: 'wire-launch',
          manifestDigest: published.manifest_digest,
        }),
      ),
    ),
    { code: 'node_launch_unconfirmed', vmOperationUncertain: true },
  )
  assert.equal(sends, 1)
  assert.equal(fx.calls.filter((call) => call.endsWith('/start')).length, 1)
  const operation = (await fx.peer.query("SELECT released_at,uncertain_at FROM vm_operations WHERE kind='node_launch'"))
    .rows[0]
  assert.equal(operation.released_at, null)
  assert.ok(operation.uncertain_at)
  assert.equal(await new NodeManagementGrants(fx.peer).readLaunchReceipt({ vmId }), null)
})
