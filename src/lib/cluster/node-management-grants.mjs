import crypto from 'node:crypto'
import { withTransaction, quoteIdentifier } from '../db/database.mjs'
import { coordinationSchemaFor } from '../db/global-maintenance.mjs'
import { currentVmOperationIds } from '../vm/shared-vm-operations.mjs'
import { physicalContainerName } from '../vm/vm-physical-target.mjs'
import { ClusterNodesRepo } from '../db/repos/cluster-nodes-repo.mjs'
import { allocateNodeSlot, normalizeAllocationReceipt } from '../transport/slotgate-management-client.mjs'
import { isDeepStrictEqual } from 'node:util'
import {
  initializeNodeAuthority,
  nodeAuthorityState,
  nodeAuthorityError,
  nodeAuthoritySchemaFor,
  lockNodeGrant,
} from '../db/node-management-authority.mjs'

export { nodeAuthoritySchemaFor }

function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw nodeAuthorityError('node_grant_invalid')
  return value
}

function literal(value) {
  return "'" + value.replaceAll("'", "''") + "'"
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
