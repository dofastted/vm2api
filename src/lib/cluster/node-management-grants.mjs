import crypto from 'node:crypto'
import { withTransaction, quoteIdentifier } from '../db/database.mjs'
import { coordinationSchemaFor } from '../db/global-maintenance.mjs'
import { currentVmOperationIds } from '../vm/shared-vm-operations.mjs'
import { physicalContainerName } from '../vm/vm-physical-target.mjs'
import { ClusterNodesRepo } from '../db/repos/cluster-nodes-repo.mjs'
import {
  allocateNodeSlot,
  normalizeAllocationReceipt,
  publishNodeSlotInitial,
  launchNodeSlot,
} from '../transport/slotgate-management-client.mjs'
import { isDeepStrictEqual } from 'node:util'
import {
  normalizeVacantNodeFence as vacantFence,
  normalizeNodeManagementIntent as commandIntent,
  nodeManagementIntentDigest as commandDigest,
  normalizeNodeManagementGrant as commandGrant,
  normalizeNodeManagementReceipt as commandReceipt,
} from '../core/node-management-command.mjs'
import {
  initializeNodeAuthority,
  nodeAuthorityState,
  nodeAuthorityError,
  nodeAuthoritySchemaFor,
  lockNodeGrant,
  nodeGrantNamespace,
  nodeGrantResource,
  nodeCommandAuthorityState,
  initializeNodeCommandAuthority,
} from '../db/node-management-authority.mjs'

export { nodeAuthoritySchemaFor }

function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw nodeAuthorityError('node_grant_invalid')
  return value
}

function literal(value) {
  return "'" + value.replaceAll("'", "''") + "'"
}

function commandFailure(code = 'node_command_invalid') {
  return nodeAuthorityError(code)
}
function storedGrant(row) {
  if (!row) throw commandFailure('node_command_conflict')
  const grant = commandGrant({ intent: row.intent, intentDigest: row.intent_digest })
  const fields = {
    command_id: row.command_id,
    node_id: row.node_id,
    vm_id: row.vm_id,
    allocation_id: row.allocation_id,
    operation_id: row.operation_id,
    owner_id: row.owner_id,
    action: row.action,
    epoch: String(row.epoch),
  }
  if (Object.entries(fields).some(([key, value]) => grant.intent[key] !== value))
    throw commandFailure('node_command_conflict')
  return grant
}
export class NodeManagementGrants {
  constructor(db, { resolveNodeLink } = {}) {
    this.db = db
    this.schema = nodeAuthoritySchemaFor(db.schema)
    this.resolveNodeLink = resolveNodeLink || ((nodeId) => new ClusterNodesRepo(db).getDirectLink(nodeId))
  }
  initialize() {
    return initializeNodeAuthority(this.db)
  }

  initializeCommands() {
    return initializeNodeCommandAuthority(this.db)
  }

  async _commandEpoch() {
    const row = (
      await this.db.query(
        `SELECT epoch::text,phase FROM ${quoteIdentifier(coordinationSchemaFor(this.db.schema))}.control WHERE id=1 FOR SHARE`,
      )
    ).rows[0]
    if (row?.phase !== 'open') throw commandFailure('node_command_epoch_stale')
    return row.epoch
  }

  async _commandContext(intent) {
    if (!currentVmOperationIds(this.db).has(intent.operation_id)) throw commandFailure('node_operation_scope_required')
    const operation = await this.db
      .prepare('SELECT * FROM vm_operations WHERE id=$1 AND owner_id=$2 FOR UPDATE')
      .get(intent.operation_id, intent.owner_id)
    const kind = intent.action === 'publish-initial' ? 'node_publish_initial' : 'node_launch'
    if (
      !operation ||
      operation.vm_id !== intent.vm_id ||
      operation.kind !== kind ||
      operation.released_at ||
      operation.uncertain_at
    )
      throw commandFailure('node_operation_invalid')
    const state = await nodeCommandAuthorityState(this.db)
    if (!state.enabled) throw commandFailure('node_command_authority_unavailable')
    await lockNodeGrant(this.db, this.schema, intent.node_id, intent.vm_id)
    const epoch = await this._commandEpoch()
    return { state, epoch }
  }

  async _commandAllocation(state, intent) {
    const row = (
      await this.db.query(`SELECT * FROM ${state.q}.allocations WHERE allocation_id=$1`, [intent.allocation_id])
    ).rows[0]
    if (!row?.receipt || row.node_id !== intent.node_id || row.vm_id !== intent.vm_id)
      throw commandFailure('node_command_invalid')
    if (String(row.epoch) !== intent.epoch) throw commandFailure('node_command_epoch_stale')
    let receipt
    try {
      receipt = normalizeAllocationReceipt(row.receipt, {
        nodeId: row.node_id,
        vmId: row.vm_id,
        allocationId: row.allocation_id,
        operationId: row.operation_id,
        ownerId: row.owner_id,
        epoch: String(row.epoch),
        intentDigest: row.intent_digest,
      })
    } catch {
      throw commandFailure('node_command_invalid')
    }
    if (!isDeepStrictEqual(vacantFence(receipt.fence), intent.fence)) throw commandFailure()
    return receipt
  }

  async _commandPublication(state, intent) {
    const row = (
      await this.db.query(
        `SELECT * FROM ${state.q}.command_grants WHERE allocation_id=$1 AND action='publish-initial'`,
        [intent.allocation_id],
      )
    ).rows[0]
    if (!row?.receipt) throw commandFailure('node_publication_required')
    const grant = storedGrant(row)
    const receipt = commandReceipt(grant, row.receipt)
    if (
      ['node_id', 'vm_id', 'allocation_id', 'epoch', 'preset_id', 'policy_digest'].some(
        (key) => grant.intent[key] !== intent[key],
      ) ||
      !isDeepStrictEqual(grant.intent.fence, intent.fence) ||
      receipt.manifest_digest !== intent.manifest_digest
    )
      throw commandFailure('node_command_conflict')
    return receipt
  }

  async _issueCommand(action, input) {
    const operation = input?.operation
    if (!operation || !currentVmOperationIds(this.db).has(operation.operationId))
      throw commandFailure('node_operation_scope_required')
    if (this.db.isTransaction) throw nodeAuthorityError('node_grant_transaction_active')
    try {
      for (const value of [
        input.nodeId,
        input.vmId,
        input.allocationId,
        input.commandId,
        operation.operationId,
        operation.ownerId,
      ])
        identifier(value)
    } catch {
      throw commandFailure()
    }
    return withTransaction(this.db, async () => {
      const identity = {
        action,
        node_id: input.nodeId,
        vm_id: input.vmId,
        allocation_id: input.allocationId,
        operation_id: operation.operationId,
        owner_id: operation.ownerId,
        command_id: input.commandId,
      }
      const { state, epoch } = await this._commandContext(identity)
      const intent = commandIntent({
        ...identity,
        epoch,
        fence: vacantFence(input.capturedFence),
        expected_manifest_revision: input.expectedManifestRevision,
        manifest_revision: input.revision,
        payload_digest: input.payloadDigest,
        preset_id: input.presetId,
        policy_digest: input.policyDigest,
        manifest_digest: input.manifestDigest ?? '',
      })
      await this._commandAllocation(state, intent)
      if (action === 'launch') await this._commandPublication(state, intent)
      const intentDigest = commandDigest(intent)
      const result = await this.db.query(
        `INSERT INTO ${state.q}.command_grants
        (command_id,node_id,vm_id,allocation_id,operation_id,owner_id,action,epoch,intent_digest,intent)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING RETURNING command_id`,
        [
          intent.command_id,
          intent.node_id,
          intent.vm_id,
          intent.allocation_id,
          intent.operation_id,
          intent.owner_id,
          intent.action,
          intent.epoch,
          intentDigest,
          JSON.stringify(intent),
        ],
      )
      if (result.rowCount !== 1) throw commandFailure('node_command_conflict')
      return { intent, intentDigest }
    })
  }

  issueInitialPublish(input) {
    return this._issueCommand('publish-initial', input)
  }
  issueLaunch(input) {
    return this._issueCommand('launch', input)
  }

  async _issueCommandBeforeSend(action, input) {
    try {
      return await this._issueCommand(action, input)
    } catch (error) {
      // These authority refusals precede grant insertion and node transmission.
      // Receipt persistence errors occur later and must not inherit this proof.
      if (
        ['node_command_epoch_stale', 'node_command_authority_unavailable'].includes(error.code) &&
        error.vmOperationUncertain !== true &&
        error.executionUncertain !== true
      )
        error.vmOperationNotStarted = true
      throw error
    }
  }

  async publishInitial(input) {
    if (!Buffer.isBuffer(input?.payload) || input.payload.length < 1 || input.payload.length > 65536) {
      throw Object.assign(commandFailure(), { vmOperationNotStarted: true })
    }
    const payload = Buffer.from(input.payload)
    const link = await this.resolveNodeLink(input.nodeId)
    if (!link) throw Object.assign(nodeAuthorityError('node_link_unavailable'), { vmOperationNotStarted: true })
    const grant = await this._issueCommandBeforeSend('publish-initial', {
      ...input,
      expectedManifestRevision: '0',
      revision: '1',
      payloadDigest: crypto.createHash('sha256').update(payload).digest('hex'),
      manifestDigest: '',
    })
    const receipt = await publishNodeSlotInitial({ link, grant, payload })
    return this.recordInitialPublishReceipt(grant, receipt)
  }

  async launch(input) {
    const link = await this.resolveNodeLink(input?.nodeId)
    if (!link) throw Object.assign(nodeAuthorityError('node_link_unavailable'), { vmOperationNotStarted: true })
    const grant = await this._issueCommandBeforeSend('launch', {
      ...input,
      expectedManifestRevision: '1',
      revision: '1',
      payloadDigest: '',
    })
    const receipt = await launchNodeSlot({ link, grant })
    return this.recordLaunchReceipt(grant, receipt)
  }

  async _recordCommand(grantValue, receiptValue, action) {
    const grant = commandGrant(grantValue)
    if (grant.intent.action !== action) throw commandFailure('node_command_receipt_invalid')
    const receipt = commandReceipt(grant, receiptValue)
    return withTransaction(this.db, async () => {
      const { state, epoch } = await this._commandContext(grant.intent)
      if (grant.intent.epoch !== epoch) throw commandFailure('node_command_epoch_stale')
      await this._commandAllocation(state, grant.intent)
      if (action === 'launch') await this._commandPublication(state, grant.intent)
      const row = (
        await this.db.query(`SELECT * FROM ${state.q}.command_grants WHERE command_id=$1 FOR UPDATE`, [
          grant.intent.command_id,
        ])
      ).rows[0]
      if (!row || row.revoked_at || !isDeepStrictEqual(storedGrant(row), grant))
        throw commandFailure('node_command_conflict')
      if (row.receipt && !isDeepStrictEqual(commandReceipt(grant, row.receipt), receipt))
        throw commandFailure('node_command_conflict')
      if (!row.receipt)
        await this.db.query(`UPDATE ${state.q}.command_grants SET receipt=$2::jsonb WHERE command_id=$1`, [
          grant.intent.command_id,
          JSON.stringify(receipt),
        ])
      return receipt
    })
  }

  recordInitialPublishReceipt(grant, receipt) {
    return this._recordCommand(grant, receipt, 'publish-initial')
  }
  recordLaunchReceipt(grant, receipt) {
    return this._recordCommand(grant, receipt, 'launch')
  }

  /** A confirmed historical launch, not a new node state observation or Running proof. */
  async readLaunchReceipt({ nodeId, vmId }) {
    identifier(vmId)
    if (nodeId != null) identifier(nodeId)
    return withTransaction(this.db, async () => {
      const state = await nodeCommandAuthorityState(this.db)
      if (!state.enabled) throw commandFailure('node_command_authority_unavailable')
      const selected = (
        await this.db.query(
          `SELECT * FROM ${state.q}.command_grants WHERE vm_id=$1 AND action='launch' AND ($2::text IS NULL OR node_id=$2)`,
          [vmId, nodeId ?? null],
        )
      ).rows[0]
      if (!selected) return null
      await this.db.query('SELECT pg_advisory_xact_lock_shared(hashtext($1),hashtext($2))', [
        nodeGrantNamespace(this.schema),
        nodeGrantResource(selected.node_id, vmId),
      ])
      const epoch = await this._commandEpoch()
      const row = (
        await this.db.query(`SELECT * FROM ${state.q}.command_grants WHERE command_id=$1`, [selected.command_id])
      ).rows[0]
      const grant = storedGrant(row)
      if (grant.intent.epoch !== epoch) throw commandFailure('node_command_epoch_stale')
      await this._commandAllocation(state, grant.intent)
      await this._commandPublication(state, grant.intent)
      return row.receipt ? commandReceipt(grant, row.receipt) : null
    })
  }

  commandReaderRoleSql({ role }) {
    if (typeof role !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(role))
      throw nodeAuthorityError('node_reader_invalid')
    const q = quoteIdentifier(this.schema)
    const r = quoteIdentifier(role)
    return `GRANT SELECT ON ${q}.authorized_commands TO ${r};
      GRANT EXECUTE ON FUNCTION ${q}.command_current(text) TO ${r};`
  }

  async issueAllocation({ operation, nodeId, vmId, allocationId }) {
    identifier(nodeId)
    identifier(vmId)
    identifier(allocationId)
    if (!operation || !currentVmOperationIds(this.db).has(operation.operationId))
      throw nodeAuthorityError('node_operation_scope_required')
    if (this.db.isTransaction) throw nodeAuthorityError('node_grant_transaction_active')
    return withTransaction(this.db, async () => {
      const row = await this.db
        .prepare('SELECT * FROM vm_operations WHERE id=$1 AND owner_id=$2 FOR UPDATE')
        .get(operation.operationId, operation.ownerId)
      if (!row || row.vm_id !== vmId || row.kind !== 'node_allocate' || row.released_at || row.uncertain_at)
        throw nodeAuthorityError('node_operation_invalid')
      identifier(row.id)
      identifier(row.owner_id)
      const state = await nodeAuthorityState(this.db)
      if (!state.enabled) throw nodeAuthorityError()
      await lockNodeGrant(this.db, this.schema, nodeId, vmId)
      const epoch = (
        await this.db.query(
          `SELECT epoch::text,phase FROM ${quoteIdentifier(coordinationSchemaFor(this.db.schema))}.control WHERE id=1`,
        )
      ).rows[0]
      if (epoch?.phase !== 'open') throw nodeAuthorityError()
      const digest = crypto
        .createHash('sha256')
        .update(['slotgate-allocate-v1', nodeId, vmId, allocationId, row.id, row.owner_id].join('\0'))
        .digest('hex')
      const existing = (
        await this.db.query(
          `SELECT * FROM ${state.q}.allocations WHERE allocation_id=$1 OR vm_id=$2 OR physical_target=$3`,
          [allocationId, vmId, physicalContainerName(vmId)],
        )
      ).rows[0]
      if (existing) {
        if (
          existing.allocation_id !== allocationId ||
          existing.intent_digest !== digest ||
          existing.revoked_at ||
          String(existing.epoch) !== epoch.epoch
        )
          throw nodeAuthorityError('node_allocation_conflict')
      } else {
        await this.db.query(
          `INSERT INTO ${state.q}.allocations
          (allocation_id,node_id,vm_id,physical_target,operation_id,owner_id,action,epoch,intent_digest)
          VALUES ($1,$2,$3,$4,$5,$6,'allocate',$7,$8)`,
          [allocationId, nodeId, vmId, physicalContainerName(vmId), row.id, row.owner_id, epoch.epoch, digest],
        )
      }
      return {
        action: 'allocate',
        nodeId,
        vmId,
        allocationId,
        operationId: row.id,
        ownerId: row.owner_id,
        epoch: epoch.epoch,
        intentDigest: digest,
      }
    })
  }

  async allocate(input) {
    const link = await this.resolveNodeLink(input.nodeId)
    if (!link) throw nodeAuthorityError('node_link_unavailable')
    const grant = await this.issueAllocation(input)
    const receipt = await allocateNodeSlot({ link, grant })
    await withTransaction(this.db, async () => {
      if (!currentVmOperationIds(this.db).has(grant.operationId))
        throw nodeAuthorityError('node_operation_scope_required')
      const operation = await this.db
        .prepare('SELECT * FROM vm_operations WHERE id=$1 AND owner_id=$2 FOR UPDATE')
        .get(grant.operationId, grant.ownerId)
      if (
        !operation ||
        operation.vm_id !== grant.vmId ||
        operation.kind !== 'node_allocate' ||
        operation.released_at ||
        operation.uncertain_at
      )
        throw nodeAuthorityError('node_operation_invalid')
      const state = await nodeAuthorityState(this.db)
      if (!state.enabled) throw nodeAuthorityError()
      await lockNodeGrant(this.db, this.schema, grant.nodeId, grant.vmId)
      const row = (
        await this.db.query(`SELECT * FROM ${state.q}.allocations WHERE allocation_id=$1`, [grant.allocationId])
      ).rows[0]
      const normalized = normalizeAllocationReceipt(receipt, grant)
      if (
        !row ||
        row.revoked_at ||
        row.intent_digest !== grant.intentDigest ||
        String(row.epoch) !== grant.epoch ||
        (row.receipt && !isDeepStrictEqual(row.receipt, normalized))
      )
        throw nodeAuthorityError('node_allocation_conflict')
      await this.db.query(`UPDATE ${state.q}.allocations SET receipt=$2::jsonb WHERE allocation_id=$1`, [
        grant.allocationId,
        JSON.stringify(normalized),
      ])
    })
    return receipt
  }

  // Explicit node-role installation instructions only. Runtime initialization
  // never creates/alters roles and this SQL contains no credentials.
  readerRoleSql({ role, nodeId }) {
    if (typeof role !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(role))
      throw nodeAuthorityError('node_reader_invalid')
    identifier(nodeId)
    const q = quoteIdentifier(this.schema)
    const r = quoteIdentifier(role)
    return `INSERT INTO ${q}.reader_roles(role_name,node_id) VALUES (${literal(role)},${literal(nodeId)});
      GRANT USAGE ON SCHEMA ${q} TO ${r};
      GRANT SELECT ON ${q}.authorized_allocations TO ${r};
      GRANT EXECUTE ON FUNCTION ${q}.reader_identity() TO ${r};
      GRANT EXECUTE ON FUNCTION ${q}.allocation_current(text) TO ${r};`
  }
}
