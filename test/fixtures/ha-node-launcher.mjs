import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { loadSettingsState } from '../../src/lib/db/settings-state.mjs'
import { nodeManagementFixture } from './node-management-fixture.mjs'
import { syntheticClaudeNode } from './synthetic-claude-node.mjs'

// Dedicated synthetic test resources only. Never accept a production database,
// arbitrary interface, command, credential, host mount or provider endpoint.
function readConfig(file) {
  try {
    const stat = fs.lstatSync(file)
    if (!path.isAbsolute(file) || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) throw new Error()
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Object.keys(value).sort().join(',') !== 'connectionString,listen,schema' || !/_test$/.test(new URL(value.connectionString).pathname) || !/^[a-z_][a-z0-9_]{0,62}$/.test(value.schema) || (!value.schema.startsWith('test_') && !value.schema.includes('648'))) throw new Error()
    const listen = /^(127\.0\.0\.1|10\.249\.248\.1):([0-9]{1,5})$/.exec(value.listen)
    if (!listen || Number(listen[2]) > 65535) throw new Error()
    return value
  } catch { throw Object.assign(new Error('invalid synthetic node fixture config'), { code: 'fixture_config_invalid' }) }
}

const hooks = []
const config = readConfig(process.argv[2])
const resourcesFile = path.join(os.tmpdir(), `vm2api-648-ha-node-${process.pid}-resources.json`)
fs.writeFileSync(resourcesFile, '', { mode: 0o600, flag: 'wx' })
const resources = { state: 'starting', launcherPid: process.pid, applicationSchema: config.schema, applicationSchemaOwned: false }
const save = () => fs.writeFileSync(resourcesFile, JSON.stringify(resources, null, 2) + '\n', { mode: 0o600 })
let fixture
let kernel
let stopped
const stop = new Promise((resolve) => { stopped = resolve })
process.once('SIGTERM', stopped)
process.once('SIGINT', stopped)
try {
  const db = await openDatabase({ connectionString: config.connectionString, schema: config.schema })
  await loadSettingsState(db)
  fixture = await nodeManagementFixture({ after: (fn) => hooks.push(fn) }, { listen: config.listen })
  Object.assign(resources, { root: fixture.root, nodeRoot: fixture.node.root, nodePid: fixture.node.pid, ...fixture.resources })
  save()
  const credential = { ...JSON.parse(fixture.payload).credential, expires_at: Date.now() + 8 * 3600000 }
  const payload = Buffer.from(JSON.stringify({ credential }))
  const published = await fixture.run('node_publish_initial', (operation) => fixture.service.publishInitial(fixture.input(operation, { payload })))
  const launched = await fixture.run('node_launch', (operation) => fixture.service.launch(fixture.input(operation, { payload, commandId: 'standalone-synthetic-launch', manifestDigest: published.manifest_digest })))
  const kernelSocket = path.join(fixture.node.root, 'runtime', 'vms', fixture.vmId, 'incarnations', launched.fence.incarnation, 'run', 'kernel.sock')
  kernel = await syntheticClaudeNode(kernelSocket)
  const metadata = {
    id: fixture.vmId, name: 'synthetic-node-fixture', node_id: fixture.nodeId, status: 'running', schedulable: true,
    timezone: 'UTC', locale: 'en_US.UTF-8', fingerprint: { device_id: 'ha-fixture-device', session_id: 'ha-fixture-session', machineID: 'ha-fixture-machine' },
    policy: { maxConcurrency: 2, weight: 1 },
    claude: { account_uuid: credential.account_uuid, org_uuid: credential.org_uuid, email: credential.email, has_access: true, has_refresh: true, expires_at: credential.expires_at, source: 'synthetic-node-fixture' },
  }
  await new VmsRepo(db).upsertFromVmJson(metadata)
  const trustFile = path.join(fixture.root, 'trusted-nodes.json')
  const metadataFile = path.join(fixture.root, 'vm-metadata.json')
  const parametersFile = path.join(fixture.root, 'deployment.json')
  const privateFile = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  privateFile(trustFile, { nodes: { [fixture.nodeId]: { ...fixture.node.link, policyDigest: fixture.policyDigest, presetId: 'claude-docker-v1' } } })
  privateFile(metadataFile, metadata)
  privateFile(parametersFile, { syntheticProvider: true, connectionString: config.connectionString, schema: config.schema, nodeId: fixture.nodeId, vmId: fixture.vmId, accountId: credential.account_uuid, controlUrl: kernel.controlUrl, kernelSocket, trustFile, metadataFile, launchReceipt: launched })
  Object.assign(resources, { state: 'active', parametersFile, controlUrl: kernel.controlUrl })
  save()
  process.stdout.write(resourcesFile + '\n')
  await stop
} catch (error) {
  resources.error = error.code || error.name
  process.stderr.write(`synthetic node fixture failed: ${resources.error}\n`)
  process.exitCode = 1
} finally {
  const failures = []
  const attempt = async (fn) => { try { await fn() } catch (error) { failures.push(error.code || error.name) } }
  await attempt(() => kernel?.close())
  for (const cleanup of hooks.reverse()) await attempt(cleanup)
  await attempt(async () => {
    if (!fixture) return
    resources.remainingDirs = [fixture.root, fixture.node.root].filter((file) => fs.existsSync(file))
    resources.remainingRoles = (await fixture.db.pool.query('SELECT rolname FROM pg_roles WHERE rolname=$1', [fixture.resources.readerRole])).rows
    resources.remainingPrivateSchemas = (await fixture.db.pool.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])', [[fixture.resources.authoritySchema, fixture.resources.maintenanceSchema]])).rows
  })
  await attempt(closeDatabase)
  const remaining = ['remainingDirs', 'remainingRoles', 'remainingPrivateSchemas'].some((key) => resources[key]?.length)
  resources.state = !fixture ? 'startup_failed' : failures.length || remaining ? 'cleanup_failed' : 'cleaned'
  resources.cleanupFailures = failures
  if (resources.state !== 'cleaned') process.exitCode = 1
  save()
}
