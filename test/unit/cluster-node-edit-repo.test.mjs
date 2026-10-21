import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb } from '../../src/lib/db/database.mjs'
import { ClusterNodesRepo } from '../../src/lib/db/repos/cluster-nodes-repo.mjs'

const NODE = {
  id: 'node-a',
  label: 'Node A',
  host: 'node-a.example.test',
  port: 22,
  username: 'operator',
  auth_type: 'password',
  password: 'original-password',
  private_key: null,
  passphrase: null,
  host_key_alg: 'ssh-ed25519',
  host_key_sha256: 'SHA256:original-fingerprint',
  jump_node_id: null,
}

async function setup(t, secret) {
  const env = { VM2API_DB_SECRET: process.env.VM2API_DB_SECRET, KIN_DB_SECRET: process.env.KIN_DB_SECRET }
  delete process.env.VM2API_DB_SECRET
  delete process.env.KIN_DB_SECRET
  if (secret) process.env.VM2API_DB_SECRET = secret
  t.after(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const db = getDb()
  t.after(async () => await db.close())
  return { db, repo: new ClusterNodesRepo(db) }
}

function assertPublic(node) {
  for (const key of ['password', 'private_key', 'privateKey', 'passphrase']) {
    assert.equal(Object.hasOwn(node, key), false, `${key} must not appear in a public node`)
  }
}

test('node rename preserves identity, pinned host key, jump node and credentials without exposing secrets', async (t) => {
  const { repo } = await setup(t)
  await repo.insert({ ...NODE, id: 'node-jump', host: 'jump.example.test' })
  const spec = { ...NODE, jump_node_id: 'node-jump' }
  const original = await repo.insert(spec, '2020-01-01T00:00:00.000Z')
  const saved = await repo.update(
    original.id,
    {
      ...spec,
      id: 'unwanted-id',
      label: 'Renamed node',
      created_at: '2030-01-01T00:00:00.000Z',
      host_key_alg: 'unwanted-algorithm',
      host_key_sha256: 'SHA256:unwanted-fingerprint',
      jump_node_id: null,
    },
    original.updated_at,
  )
  assert.equal(saved.label, 'Renamed node')
  for (const key of ['id', 'created_at', 'host_key_alg', 'host_key_sha256', 'jump_node_id']) {
    assert.equal(saved[key], original[key])
  }
  assert.ok(Date.parse(saved.updated_at) > Date.parse(original.updated_at))
  assert.deepEqual(await repo.getSecrets(original.id), {
    password: NODE.password,
    privateKey: null,
    passphrase: null,
  })
  assertPublic(saved)
  assertPublic(await repo.get(original.id))
  for (const node of await repo.list()) assertPublic(node)
})

test('label-only edits preserve encrypted credential bytes even when the current database key cannot decrypt them', async (t) => {
  const { db, repo } = await setup(t, 'original-test-database-key')
  const original = await repo.insert({ ...NODE, private_key: 'saved-private-key', passphrase: 'saved-passphrase' })
  const credentials = db.prepare('SELECT password, private_key, passphrase FROM cluster_nodes WHERE id = $1')
  const stored = await credentials.get(NODE.id)
  for (const value of Object.values(stored)) assert.match(value, /^enc:v1:/)

  process.env.VM2API_DB_SECRET = 'different-test-database-key'
  await assert.rejects(async () => await repo.getSecrets(NODE.id))
  const saved = await repo.updateLabel(NODE.id, 'Renamed without credentials', original.updated_at)
  assert.deepEqual(saved, { ...original, label: 'Renamed without credentials', updated_at: saved.updated_at })
  assert.ok(Date.parse(saved.updated_at) > Date.parse(original.updated_at))
  assertPublic(saved)
  assert.deepEqual(await credentials.get(NODE.id), stored)
  await assert.rejects(async () => await repo.getSecrets(NODE.id))
})

test('label-only updates enforce CAS and advance versions when the clock moves backwards', async (t) => {
  const { repo } = await setup(t)
  const timestamp = '2026-10-18T00:00:00.000Z'
  const initialMs = Date.parse(timestamp)
  const original = await repo.insert(NODE, timestamp)
  const clock = t.mock.method(Date, 'now', () => initialMs)
  const first = await repo.updateLabel(NODE.id, 'First rename', original.updated_at)
  assert.equal(Date.parse(first.updated_at), initialMs + 1)
  assert.equal(await repo.updateLabel(NODE.id, 'Stale rename', original.updated_at), null)
  assert.equal(await repo.updateLabel('node-missing', 'Missing node', first.updated_at), null)
  assert.equal(await repo.updateLabel(NODE.id, 'Missing version', undefined), null)
  assert.deepEqual(await repo.get(NODE.id), first)
  clock.mock.mockImplementation(() => initialMs - 1000)
  const second = await repo.updateLabel(NODE.id, 'Second rename', first.updated_at)
  assert.equal(Date.parse(second.updated_at), initialMs + 2)
  assert.equal((await repo.getSecrets(NODE.id)).password, NODE.password)
})

test('stale and missing node updates return null without overwriting a successful credential change', async (t) => {
  const { repo } = await setup(t)
  const original = await repo.insert(NODE)
  const saved = await repo.update(original.id, { ...NODE, password: 'new-password' }, original.updated_at)
  assert.ok(saved)
  assert.equal(await repo.update(original.id, { ...NODE, label: 'Stale edit' }, original.updated_at), null)
  assert.equal(await repo.update('node-missing', NODE, original.updated_at), null)
  assert.equal(await repo.update(original.id, NODE, undefined), null)
  assert.deepEqual(await repo.get(original.id), saved)
  assert.equal((await repo.getSecrets(original.id)).password, 'new-password')
})

test('each successful update advances its version even when the clock has not advanced or moves backwards', async (t) => {
  const { repo } = await setup(t)
  const timestamp = '2026-10-18T00:00:00.000Z'
  const initialMs = Date.parse(timestamp)
  const original = await repo.insert(NODE, timestamp)
  const clock = t.mock.method(Date, 'now', () => initialMs)
  const first = await repo.update(original.id, { ...NODE, label: 'First' }, original.updated_at)
  assert.equal(Date.parse(first.updated_at), initialMs + 1)
  clock.mock.mockImplementation(() => initialMs - 1000)
  const second = await repo.update(original.id, { ...NODE, label: 'Second' }, first.updated_at)
  assert.equal(Date.parse(second.updated_at), initialMs + 2)
  clock.mock.mockImplementation(() => initialMs + 10_000)
  const third = await repo.update(original.id, { ...NODE, label: 'Third' }, second.updated_at)
  assert.equal(Date.parse(third.updated_at), initialMs + 10_000)
})

test('switching to key authentication encrypts new secrets and removes the old password', async (t) => {
  const { db, repo } = await setup(t, 'test-only-database-secret')
  const original = await repo.insert(NODE)
  const saved = await repo.update(
    original.id,
    { ...NODE, auth_type: 'key', password: null, private_key: 'new-private-key', passphrase: 'new-passphrase' },
    original.updated_at,
  )
  assert.equal(saved.auth_type, 'key')
  assertPublic(saved)
  const stored = await db
    .prepare('SELECT password, private_key, passphrase FROM cluster_nodes WHERE id = $1')
    .get(NODE.id)
  assert.equal(stored.password, null)
  assert.match(stored.private_key, /^enc:v1:/)
  assert.match(stored.passphrase, /^enc:v1:/)
  assert.deepEqual(await repo.getSecrets(NODE.id), {
    password: null,
    privateKey: 'new-private-key',
    passphrase: 'new-passphrase',
  })
})

test('switching to password authentication clears old key secrets without requiring database encryption', async (t) => {
  const { db, repo } = await setup(t)
  const original = await repo.insert({
    ...NODE,
    auth_type: 'key',
    password: null,
    private_key: 'old-private-key',
    passphrase: 'old-passphrase',
  })
  const saved = await repo.update(
    original.id,
    { ...NODE, host: 'new.example.test', port: 2222, username: 'new-operator', password: 'new-password' },
    original.updated_at,
  )
  assert.deepEqual(
    [saved.host, saved.port, saved.username, saved.auth_type],
    ['new.example.test', 2222, 'new-operator', 'password'],
  )
  assertPublic(saved)
  const stored = await db
    .prepare('SELECT password, private_key, passphrase FROM cluster_nodes WHERE id = $1')
    .get(NODE.id)
  assert.deepEqual({ ...stored }, { password: 'new-password', private_key: null, passphrase: null })
})

test('a duplicate endpoint rejects the whole update and preserves the previous version and credentials', async (t) => {
  const { repo } = await setup(t)
  const original = await repo.insert(NODE)
  await repo.insert({ ...NODE, id: 'node-b', host: 'node-b.example.test' })
  await assert.rejects(
    async () =>
      await repo.update(
        NODE.id,
        { ...NODE, host: 'node-b.example.test', label: 'Conflict', password: 'uncommitted-password' },
        original.updated_at,
      ),
    { code: '23505' },
  )
  assert.deepEqual(await repo.get(NODE.id), original)
  assert.equal((await repo.getSecrets(NODE.id)).password, NODE.password)
})
