import { refreshNodeSlotCredential } from '../transport/slotgate-management-client.mjs'
import { withTransaction, quoteIdentifier } from '../db/database.mjs'
import { coordinationSchemaFor } from '../db/global-maintenance.mjs'
import { NodeManagementGrants } from './node-management-grants.mjs'
import { nodeAuthoritySchemaFor, lockNodeGrant } from '../db/node-management-authority.mjs'
import { initializeNodeRefreshAuthority, nodeRefreshAuthorityState } from '../db/node-credential-refresh-authority.mjs'
import { currentCredentialRefreshAttempt } from '../oauth/shared-credential-refresh.mjs'
import { currentVmOperationIds } from '../vm/shared-vm-operations.mjs'
import {
  normalizeRefreshIntent,
  refreshIntentDigest,
  normalizeRefreshGrant,
  normalizeRefreshReceipt,
  refreshFailure,
} from '../core/node-credential-refresh.mjs'
import { isDeepStrictEqual } from 'node:util'
export class NodeCredentialRefreshGrants {
  constructor(db) {
    this.db = db
    this.schema = nodeAuthoritySchemaFor(db.schema)
    this.base = new NodeManagementGrants(db)
  }
  initialize() {
    return initializeNodeRefreshAuthority(this.db)
  }
  state() {
    return nodeRefreshAuthorityState(this.db)
  }
  readerRoleSql({ role }) {
    if (typeof role !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(role)) throw refreshFailure()
    const q = quoteIdentifier(this.schema),
      r = quoteIdentifier(role)
    return `GRANT USAGE ON SCHEMA ${q} TO ${r};GRANT SELECT ON ${q}.authorized_refreshes TO ${r};GRANT EXECUTE ON FUNCTION ${q}.refresh_current(text) TO ${r};`
  }
  async _context(input) {
    const scope = currentCredentialRefreshAttempt(this.db)
    if (
      !scope ||
      scope.operation !== input.operation ||
      scope.vmId !== input.vmId ||
      scope.accountId !== input.accountId ||
      !currentVmOperationIds(this.db).has(input.operation?.operationId)
    )
      throw refreshFailure('node_refresh_scope_required')
    const bg = await this.db
      .prepare('SELECT * FROM background_task_runs WHERE task_key=$1 AND execution_id=$2 AND owner_id=$3 FOR SHARE')
      .get(scope.claim.taskKey, scope.claim.executionId, scope.claim.ownerId)
    if (!bg || bg.finished_at || bg.unknown_at) throw refreshFailure('node_refresh_scope_required')
    const op = await this.db
      .prepare('SELECT * FROM vm_operations WHERE id=$1 AND owner_id=$2 FOR UPDATE')
      .get(scope.operation.operationId, scope.operation.ownerId)
    if (
      !op ||
      op.vm_id !== input.vmId ||
      op.account_id !== input.accountId ||
      op.kind !== 'credential_refresh' ||
      op.released_at ||
      op.uncertain_at
    )
      throw refreshFailure('node_refresh_scope_required')
    return scope
  }
  async _state(input) {
    const scope = await this._context(input),
      state = await this.state()
    if (!state.enabled) throw refreshFailure('node_refresh_authority_unavailable')
    await lockNodeGrant(this.db, this.schema, input.nodeId, input.vmId)
    const control = (
      await this.db.query(
        `SELECT epoch::text,phase FROM ${quoteIdentifier(coordinationSchemaFor(this.db.schema))}.control WHERE id=1 FOR SHARE`,
      )
    ).rows[0]
    if (control?.phase !== 'open') throw refreshFailure('node_refresh_epoch_stale')
    const launched = await this.base.readLaunchReceipt({ nodeId: input.nodeId, vmId: input.vmId })
    if (!launched || !isDeepStrictEqual(launched.fence, input.capturedFence))
      throw refreshFailure('node_refresh_launch_required')
    return { scope, state, epoch: control.epoch, launched }
  }
  async issue(input) {
    if (this.db.isTransaction) throw refreshFailure('node_refresh_transaction_active')
    return withTransaction(this.db, async () => {
      const { scope, state, epoch, launched } = await this._state(input)
      const intent = normalizeRefreshIntent({
        action: 'credential-refresh',
        node_id: input.nodeId,
        vm_id: input.vmId,
        allocation_id: launched.intent.allocation_id,
        operation_id: scope.operation.operationId,
        owner_id: scope.operation.ownerId,
        command_id: input.commandId,
        account_id: input.accountId,
        bg_task_key: scope.claim.taskKey,
        bg_execution_id: scope.claim.executionId,
        bg_owner_id: scope.claim.ownerId,
        epoch,
        fence: input.capturedFence,
        expected_credential_generation: input.expectedGeneration,
        manifest_revision: launched.manifest_revision,
        manifest_digest: launched.manifest_digest,
        preset_id: launched.intent.preset_id,
        policy_digest: launched.intent.policy_digest,
        force: input.force === true,
      })
      const latest = (
        await this.db.query(
          `SELECT receipt FROM ${state.q}.refresh_grants WHERE node_id=$1 AND vm_id=$2 AND epoch=$3 AND receipt IS NOT NULL ORDER BY created_at DESC,command_id DESC LIMIT 1`,
          [intent.node_id, intent.vm_id, intent.epoch],
        )
      ).rows[0]
      if ((latest?.receipt?.credential?.generation ?? '1') !== intent.expected_credential_generation)
        throw refreshFailure('node_refresh_generation_stale')
      const intentDigest = refreshIntentDigest(intent)
      const inserted = await this.db.query(
        `INSERT INTO ${state.q}.refresh_grants(command_id,node_id,vm_id,allocation_id,operation_id,owner_id,account_id,bg_task_key,bg_execution_id,bg_owner_id,epoch,expected_generation,intent_digest,intent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) ON CONFLICT DO NOTHING RETURNING command_id`,
        [
          intent.command_id,
          intent.node_id,
          intent.vm_id,
          intent.allocation_id,
          intent.operation_id,
          intent.owner_id,
          intent.account_id,
          intent.bg_task_key,
          intent.bg_execution_id,
          intent.bg_owner_id,
          intent.epoch,
          intent.expected_credential_generation,
          intentDigest,
          JSON.stringify(intent),
        ],
      )
      if (inserted.rowCount !== 1) throw refreshFailure('node_refresh_conflict')
      return { intent, intentDigest }
    })
  }
  async refresh(input, link) {
    let grant
    try {
      grant = await this.issue(input)
    } catch (error) {
      if (
        [
          'node_refresh_authority_unavailable',
          'node_refresh_scope_required',
          'node_refresh_generation_stale',
          'node_refresh_launch_required',
          'node_refresh_epoch_stale',
        ].includes(error.code)
      ) {
        error.vmOperationNotStarted = true
        error.credentialRefreshNotStarted = true
      }
      throw error
    }
    let receipt
    try {
      receipt = await refreshNodeSlotCredential({ link, grant })
    } catch (error) {
      if (error.vmOperationNotStarted === true) error.credentialRefreshNotStarted = true
      throw error
    }
    try {
      return await this.recordReceipt(grant, receipt)
    } catch (error) {
      error.vmOperationUncertain = true
      error.credentialRefreshUnknown = true
      throw error
    }
  }
  async recordReceipt(grantInput, value) {
    const grant = normalizeRefreshGrant(grantInput),
      receipt = normalizeRefreshReceipt(grant, value),
      i = grant.intent
    const scope = currentCredentialRefreshAttempt(this.db)
    const input = {
      operation: scope?.operation,
      nodeId: i.node_id,
      vmId: i.vm_id,
      accountId: i.account_id,
      capturedFence: i.fence,
    }
    return withTransaction(this.db, async () => {
      const { state, epoch } = await this._state(input)
      if (epoch !== i.epoch) throw refreshFailure('node_refresh_epoch_stale')
      const row = (
        await this.db.query(`SELECT * FROM ${state.q}.refresh_grants WHERE command_id=$1 FOR UPDATE`, [i.command_id])
      ).rows[0]
      if (
        !row ||
        row.revoked_at ||
        row.intent_digest !== grant.intentDigest ||
        !isDeepStrictEqual(normalizeRefreshIntent(row.intent), i)
      )
        throw refreshFailure('node_refresh_conflict')
      if (row.receipt && !isDeepStrictEqual(normalizeRefreshReceipt(grant, row.receipt), receipt))
        throw refreshFailure('node_refresh_conflict')
      await this.db.query(`UPDATE ${state.q}.refresh_grants SET receipt=$2::jsonb WHERE command_id=$1`, [
        i.command_id,
        JSON.stringify(receipt),
      ])
      return receipt
    })
  }
}
