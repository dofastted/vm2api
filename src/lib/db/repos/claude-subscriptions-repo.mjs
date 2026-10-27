import crypto from 'node:crypto'
import { getDb, isDbOpen } from '../database.mjs'
import { decryptString, encryptString, encryptionEnabled } from '../secure.mjs'
import { subscriptionError, subscriptionIdentity } from '../../oauth/claude-subscription.mjs'

function matches(row, identity) {
  return (
    identity &&
    row?.vm_id === identity.vm_id &&
    row.account_uuid === identity.account_uuid &&
    row.org_uuid === identity.org_uuid
  )
}

function publicView(row) {
  return {
    configured: !!row,
    ...row?.snapshot,
    checked_at: row?.checked_at?.toISOString() || null,
    last_error: row?.last_error || null,
  }
}

export class ClaudeSubscriptionsRepo {
  constructor(db = getDb()) {
    this.db = db
  }

  requireEncryption() {
    if (!encryptionEnabled()) throw subscriptionError('subscription_encryption_required', 503)
  }

  async row(identity) {
    const row = await this.db.prepare('SELECT * FROM claude_subscriptions WHERE vm_id=$1').get(identity.vm_id)
    return matches(row, identity) ? row : null
  }

  async view(identity) {
    return { ...publicView(await this.row(identity)), encryption_available: encryptionEnabled() }
  }

  async credential(identity) {
    this.requireEncryption()
    const row = await this.row(identity)
    if (!row) throw subscriptionError('subscription_credential_missing', 400)
    try {
      return { sessionKey: decryptString(row.encrypted_session_key), version: row.version }
    } catch {
      throw subscriptionError('subscription_session_invalid', 422)
    }
  }

  async save(identity, sessionKey, snapshot) {
    this.requireEncryption()
    await this.db
      .prepare(`INSERT INTO claude_subscriptions
      (vm_id,account_uuid,org_uuid,version,encrypted_session_key,snapshot)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (vm_id) DO UPDATE SET
      account_uuid=excluded.account_uuid,org_uuid=excluded.org_uuid,version=excluded.version,
      encrypted_session_key=excluded.encrypted_session_key,snapshot=excluded.snapshot,
      checked_at=clock_timestamp(),last_error=NULL`)
      .run(
        identity.vm_id,
        identity.account_uuid,
        identity.org_uuid,
        crypto.randomUUID(),
        encryptString(sessionKey),
        JSON.stringify(snapshot),
      )
    return this.view(identity)
  }

  async update(identity, version, { snapshot = null, error = null }) {
    const result = await this.db
      .prepare(`UPDATE claude_subscriptions SET
      snapshot=COALESCE($5::jsonb,snapshot),last_error=$6,checked_at=clock_timestamp()
      WHERE vm_id=$1 AND account_uuid=$2 AND org_uuid=$3 AND version=$4`)
      .run(
        identity.vm_id,
        identity.account_uuid,
        identity.org_uuid,
        version,
        snapshot ? JSON.stringify(snapshot) : null,
        error,
      )
    if (result.changes !== 1) throw subscriptionError('subscription_changed', 409)
    return this.view(identity)
  }

  async remove(identity) {
    await this.db
      .prepare('DELETE FROM claude_subscriptions WHERE vm_id=$1 AND account_uuid=$2 AND org_uuid=$3')
      .run(identity.vm_id, identity.account_uuid, identity.org_uuid)
    return this.view(identity)
  }
}

/** Bulk metadata projection; neither decrypts nor publishes cookies. Account changes hide old observations. */
export async function stampClaudeSubscriptions(vms) {
  if (!isDbOpen() || !vms.length) return
  const rows = await getDb()
    .prepare(
      'SELECT vm_id,account_uuid,org_uuid,snapshot,checked_at,last_error FROM claude_subscriptions WHERE vm_id=ANY($1::text[])',
    )
    .all(vms.map((vm) => vm.id))
  const byId = new Map(rows.map((row) => [row.vm_id, row]))
  for (const vm of vms) {
    const row = byId.get(vm.id)
    if (matches(row, subscriptionIdentity(vm))) vm.claude_subscription = publicView(row)
  }
}
