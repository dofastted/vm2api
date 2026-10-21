#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createDatabase, getActivityCoordinator, withTransaction } from '../src/lib/db/database.mjs'
import { NodeManagementGrants } from '../src/lib/cluster/node-management-grants.mjs'
import { NodeCredentialRefreshGrants } from '../src/lib/cluster/node-credential-refresh-grants.mjs'
import { SharedVmOperations } from '../src/lib/vm/shared-vm-operations.mjs'
import { SharedBackgroundTasks } from '../src/lib/core/shared-background-tasks.mjs'
import { VmsRepo } from '../src/lib/db/repos/vms-repo.mjs'
import { isValidVmId } from '../src/lib/vm/vm-file.mjs'

function failure(code, ended = false) {
  return Object.assign(new Error(code), { code, ...(ended ? { activityEnded: true } : {}) })
}
function shape(value, required, optional = []) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k))
  )
    throw failure('bootstrap_config_invalid', true)
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw failure('bootstrap_config_invalid', true)
  return value
}
function boundedRead(fd, limit) {
  const chunks = []
  let size = 0
  while (size <= limit) {
    const part = Buffer.alloc(Math.min(8192, limit + 1 - size))
    const count = fs.readSync(fd, part, 0, part.length, null)
    if (!count) break
    chunks.push(part.subarray(0, count))
    size += count
  }
  if (!size || size > limit) throw failure('bootstrap_input_invalid', true)
  return Buffer.concat(chunks)
}
function privateRead(file, limit, code) {
  let fd
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error()
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.geteuid() ||
      stat.size > limit
    )
      throw new Error()
    return boundedRead(fd, limit)
  } catch {
    throw failure(code, true)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
function configFrom(file) {
  let c
  try {
    c = JSON.parse(privateRead(file, 65536, 'bootstrap_config_invalid'))
  } catch {
    throw failure('bootstrap_config_invalid', true)
  }
  shape(c, ['database', 'node'], ['reader', 'vm', 'credentialFile'])
  shape(c.database, ['url', 'schema'])
  if (
    typeof c.database.url !== 'string' ||
    !c.database.url ||
    !/^postgres(?:ql)?:\/\//.test(c.database.url) ||
    typeof c.database.schema !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.database.schema) ||
    c.database.schema === 'public' ||
    /^(pg_|vm2api_node_|vm2api_coord_)/.test(c.database.schema)
  )
    throw failure('bootstrap_config_invalid', true)
  shape(c.node, ['id', 'address', 'port', 'token', 'certSha256', 'presetId', 'policyDigest'])
  id(c.node.id)
  if (
    !net.isIP(c.node.address) ||
    !Number.isInteger(c.node.port) ||
    c.node.port < 1 ||
    c.node.port > 65535 ||
    typeof c.node.token !== 'string' ||
    !/^[\x21-\x7e]{32,256}$/.test(c.node.token) ||
    !/^[a-f0-9]{64}$/.test(c.node.certSha256) ||
    !/^[a-f0-9]{64}$/.test(c.node.policyDigest) ||
    c.node.presetId !== 'claude-docker-v1'
  )
    throw failure('bootstrap_config_invalid', true)
  if (c.reader !== undefined) {
    shape(c.reader, ['role', 'sqlOutput'])
    if (
      typeof c.reader.role !== 'string' ||
      !/^[a-z_][a-z0-9_]{0,62}$/.test(c.reader.role) ||
      typeof c.reader.sqlOutput !== 'string' ||
      !path.isAbsolute(c.reader.sqlOutput)
    )
      throw failure('bootstrap_config_invalid', true)
  }
  if (c.vm !== undefined) {
    shape(c.vm, ['id', 'accountId'], ['fingerprint'])
    id(c.vm.id)
    if (!isValidVmId(c.vm.id)) throw failure('bootstrap_config_invalid', true)
    id(c.vm.accountId)
    if (c.vm.fingerprint !== undefined) {
      shape(c.vm.fingerprint, ['device_id', 'session_id'])
      if (
        typeof c.vm.fingerprint.device_id !== 'string' ||
        !/^[a-f0-9]{64}$/.test(c.vm.fingerprint.device_id) ||
        typeof c.vm.fingerprint.session_id !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(c.vm.fingerprint.session_id)
      )
        throw failure('bootstrap_config_invalid', true)
    }
  }
  return c
}
function credentialFrom(config, fd) {
  let bytes, value
  try {
    if (fd !== undefined) {
      if (config.credentialFile !== undefined || !Number.isSafeInteger(fd) || fd < 0) throw new Error()
      bytes = boundedRead(fd, 65536)
    } else bytes = privateRead(config.credentialFile, 65536, 'bootstrap_credential_invalid')
    value = JSON.parse(bytes)
    shape(value, ['credential'])
    const c = value.credential
    shape(
      c,
      ['type', 'account_uuid'],
      ['access_token', 'refresh_token', 'api_key', 'expires_at', 'scopes', 'org_uuid', 'email'],
    )
    id(c.account_uuid)
    if (c.account_uuid !== config.vm?.accountId) throw new Error()
    for (const name of ['access_token', 'refresh_token', 'api_key'])
      if (
        c[name] !== undefined &&
        (typeof c[name] !== 'string' || Buffer.byteLength(c[name]) > 16384 || !c[name].trim())
      )
        throw new Error()
    if (c.org_uuid !== undefined) id(c.org_uuid)
    if (
      c.email !== undefined &&
      (typeof c.email !== 'string' || Buffer.byteLength(c.email) > 512 || /[\x00-\x1f\x7f]/.test(c.email))
    )
      throw new Error()
    if (c.expires_at !== undefined && (!Number.isSafeInteger(c.expires_at) || c.expires_at < 0)) throw new Error()
    if (
      c.scopes !== undefined &&
      (!Array.isArray(c.scopes) ||
        c.scopes.length > 32 ||
        c.scopes.some((s) => typeof s !== 'string' || !s || Buffer.byteLength(s) > 128 || /[\x00\r\n]/.test(s)))
    )
      throw new Error()
    if (c.type === 'apikey') {
      if (!c.api_key || c.access_token || c.refresh_token || c.expires_at || c.scopes?.length) throw new Error()
    } else if (['oauth', 'setup-token', 'official-setup-token'].includes(c.type)) {
      if (!c.access_token || c.api_key || (c.type !== 'oauth' && c.refresh_token)) throw new Error()
    } else throw new Error()
    return { bytes, credential: c }
  } catch {
    throw failure('bootstrap_credential_invalid', true)
  }
}
async function trustedInit(db, c, output) {
  if (!c.reader) throw failure('bootstrap_config_invalid', true)
  const role = (
    await db.query(
      `SELECT oid,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolcanlogin,rolname=current_user AS owner FROM pg_roles WHERE rolname=$1`,
      [c.reader.role],
    )
  ).rows[0]
  if (
    !role ||
    role.owner ||
    role.rolsuper ||
    role.rolinherit ||
    role.rolcreaterole ||
    role.rolcreatedb ||
    role.rolreplication ||
    role.rolbypassrls ||
    !role.rolcanlogin ||
    (await db.query('SELECT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=$1) AS member', [role.oid])).rows[0]
      .member
  )
    throw failure('bootstrap_reader_invalid', true)
  const grants = new NodeManagementGrants(db),
    refresh = new NodeCredentialRefreshGrants(db)
  await grants.initialize()
  await grants.initializeAllocationTerminals()
  await grants.initializeCommands()
  await refresh.initialize()
  const sql =
    grants.readerRoleSql({ role: c.reader.role, nodeId: c.node.id }) +
    '\n' +
    grants.commandReaderRoleSql({ role: c.reader.role }) +
    '\n' +
    refresh.readerRoleSql({ role: c.reader.role }) +
    '\n'
  try {
    fs.writeFileSync(output, sql)
    fs.fsyncSync(output)
  } catch {
    throw failure('bootstrap_output_unavailable', true)
  }
  return {
    ok: true,
    command: 'trusted-init',
    node_id: c.node.id,
    authority_schema: grants.schema,
    reader_sql_file: c.reader.sqlOutput,
  }
}
async function slotCreate(db, c, input) {
  if (!c.vm) throw failure('bootstrap_config_invalid', true)
  const vms = new VmsRepo(db)
  if (await vms.get(c.vm.id)) throw failure('bootstrap_vm_exists', true)
  if (!(await new NodeCredentialRefreshGrants(db).state()).enabled)
    throw failure('bootstrap_authority_unavailable', true)
  const tasks = new SharedBackgroundTasks(db),
    operations = new SharedVmOperations(db),
    grants = new NodeManagementGrants(db, { resolveNodeLink: async () => c.node })
  let nodeCall = false,
    allocationConfirmed = false
  let result
  try {
    result = await tasks.run(
      { taskKey: `ha-node-bootstrap:${c.vm.id}`, executionId: crypto.randomUUID() },
      async () => {
        try {
          const allocationId = crypto.randomUUID(),
            publishId = crypto.randomUUID(),
            launchId = crypto.randomUUID()
          const run = (kind, callback) => operations.run(c.vm.id, callback, { kind, accountId: c.vm.accountId })
          const allocated = await run('node_allocate', (operation) => {
            nodeCall = true
            return grants.allocate({ operation, nodeId: c.node.id, vmId: c.vm.id, allocationId })
          })
          allocationConfirmed = true
          const common = {
            nodeId: c.node.id,
            vmId: c.vm.id,
            allocationId,
            capturedFence: allocated.fence,
            presetId: c.node.presetId,
            policyDigest: c.node.policyDigest,
          }
          const published = await run('node_publish_initial', (operation) =>
            grants.publishInitial({ ...common, operation, commandId: publishId, payload: input.bytes }),
          )
          const launched = await run('node_launch', (operation) =>
            grants.launch({ ...common, operation, commandId: launchId, manifestDigest: published.manifest_digest }),
          )
          const cred = input.credential,
            expiry = cred.expires_at > 0 && cred.expires_at < 10000000000 ? cred.expires_at * 1000 : cred.expires_at
          const vm = {
            id: c.vm.id,
            node_id: c.node.id,
            runtime: 'docker',
            status: 'running',
            schedulable: true,
            timezone: 'UTC',
            locale: 'en-US',
            fingerprint: c.vm.fingerprint || {
              device_id: crypto.randomBytes(32).toString('hex'),
              session_id: crypto.randomUUID(),
            },
            claude: {
              account_uuid: c.vm.accountId,
              has_access: true,
              has_refresh: !!cred.refresh_token,
              ...(expiry ? { expires_at: expiry } : {}),
              ...(cred.org_uuid ? { org_uuid: cred.org_uuid } : {}),
              ...(cred.email ? { email: cred.email } : {}),
            },
          }
          await withTransaction(db, async () => {
            const inserted = await db.query(
              'INSERT INTO vms(id,vm_json) VALUES($1,$2) ON CONFLICT(id) DO NOTHING RETURNING id',
              [vm.id, JSON.stringify(vm)],
            )
            if (inserted.rowCount !== 1) throw failure('bootstrap_vm_exists')
            await vms.upsertFromVmJson(vm)
          })
          return {
            terminal: true,
            value: {
              ok: true,
              command: 'slot-create',
              node_id: c.node.id,
              vm_id: c.vm.id,
              allocation_id: allocationId,
              publish_command_id: publishId,
              launch_command_id: launchId,
              manifest_revision: launched.manifest_revision,
              manifest_digest: launched.manifest_digest,
              fence: launched.fence,
            },
            sharedResult: { ok: true, vmId: c.vm.id, launchCommandId: launchId },
          }
        } catch (error) {
          if (
            (!nodeCall && ['vm_operation_active', 'vm_execution_active'].includes(error.code)) ||
            (!allocationConfirmed && error.vmOperationNotStarted === true && !error.vmOperationUncertain)
          ) {
            error.taskNotStarted = true
            error.activityEnded = true
          }
          throw error
        }
      },
    )
  } catch (error) {
    if (!nodeCall && error.code === 'database_maintenance') error.activityEnded = true
    throw error
  }
  if (!result.ran) throw failure('bootstrap_claim_unavailable', true)
  return result.value
}
export async function main(args = process.argv.slice(2)) {
  let db,
    output,
    config,
    outputWritten = false
  try {
    const command = args.shift()
    if (!['trusted-init', 'slot-create'].includes(command)) throw failure('bootstrap_arguments_invalid', true)
    let configFile, credentialFd
    while (args.length) {
      const key = args.shift(),
        value = args.shift()
      if (key === '--config' && configFile === undefined) configFile = value
      else if (key === '--credential-fd' && credentialFd === undefined && /^(0|[1-9][0-9]*)$/.test(value))
        credentialFd = Number(value)
      else throw failure('bootstrap_arguments_invalid', true)
    }
    config = configFrom(configFile)
    if (command === 'trusted-init') {
      if (!config.reader || credentialFd !== undefined) throw failure('bootstrap_arguments_invalid', true)
      try {
        output = fs.openSync(
          config.reader.sqlOutput,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600,
        )
      } catch {
        throw failure('bootstrap_output_unavailable', true)
      }
    }
    const input = command === 'slot-create' ? credentialFrom(config, credentialFd) : null
    process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes-ha'
    db = await createDatabase({
      connectionString: config.database.url,
      schema: config.database.schema,
      verifyMigrations: true,
    })
    const coordinator = getActivityCoordinator(db),
      state = await coordinator.getState()
    await coordinator.acknowledgeEpoch(state.epoch)
    await db.bootstrapActivity.complete({ ended: true, reason: 'node_bootstrap_initialized' })
    const result = await coordinator.runActivity({ kind: 'node_bootstrap_command', requestId: command }, async () => ({
      ended: true,
      value: command === 'trusted-init' ? await trustedInit(db, config, output) : await slotCreate(db, config, input),
    }))
    outputWritten = command === 'trusted-init'
    process.stdout.write(JSON.stringify(result) + '\n')
    return 0
  } catch (error) {
    const code =
      typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(error.code) ? error.code : 'bootstrap_failed'
    process.stderr.write(JSON.stringify({ ok: false, code }) + '\n')
    return 1
  } finally {
    if (output !== undefined) {
      fs.closeSync(output)
      if (!outputWritten) fs.unlinkSync(config.reader.sqlOutput)
    }
    await db?.close().catch(() => {})
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main()
