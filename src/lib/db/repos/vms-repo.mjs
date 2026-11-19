/**
 * vms repository — VM records + OAuth credential mirror.
 *
 * The `vms/*.json` files remain the runtime metadata surface.
 * Live OAuth secrets stay in the slot worker credentials.json.
 * This table mirrors identity / expiry / presence flags only.
 */

import { getDb } from '../database.mjs'
import { SettingsRepo } from './settings-repo.mjs'
import { maybeEncrypt, maybeDecrypt, encryptionEnabled } from '../secure.mjs'
import { hasAccessPresence, hasRefreshPresence, stripCredentialSecrets } from '../../oauth/oauth-credentials.mjs'
import { normalizeOwnerId, vmOriginOf } from '../../admin/resource-owner.mjs'
import { isAntigravityVm } from '../../vm/vm-kind.mjs'

const ACTIVE_VM_KEY = 'active_vm'

export class VmsRepo {
  constructor(db = getDb()) {
    this.db = db
    this.settings = new SettingsRepo(db)
    this._get = db.prepare('SELECT * FROM vms WHERE id = ?')
    this._list = db.prepare('SELECT * FROM vms ORDER BY id')
    this._remove = db.prepare('DELETE FROM vms WHERE id = ?')
    this._upsert = db.prepare(`
      INSERT INTO vms (
        id, name, status, schedulable, email, account_uuid, org_uuid,
        access_token, refresh_token, session_key, oauth_expires_at, oauth_source,
        proxy_id, claude_code_version, timezone, locale,
        owner_user_id, origin,
        vm_json, encrypted, file_mtime_ms, synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, status = excluded.status, schedulable = excluded.schedulable,
        email = excluded.email, account_uuid = excluded.account_uuid, org_uuid = excluded.org_uuid,
        access_token = excluded.access_token, refresh_token = excluded.refresh_token,
        session_key = excluded.session_key, oauth_expires_at = excluded.oauth_expires_at,
        oauth_source = excluded.oauth_source, proxy_id = excluded.proxy_id,
        claude_code_version = excluded.claude_code_version, timezone = excluded.timezone,
        locale = excluded.locale, owner_user_id = excluded.owner_user_id, origin = excluded.origin,
        vm_json = excluded.vm_json, encrypted = excluded.encrypted,
        file_mtime_ms = excluded.file_mtime_ms, synced_at = excluded.synced_at,
        updated_at = excluded.updated_at
    `)
  }

  /** Mirror a parsed vm.json object into the table. */
  upsertFromVmJson(vm, { mtimeMs = null } = {}) {
    if (!vm?.id) return null
    const now = new Date().toISOString()
    const antigravity = isAntigravityVm(vm)
    const c = antigravity ? {} : vm.claude || {}
    const safeClaude = stripCredentialSecrets({
      ...c,
      has_access: hasAccessPresence(c),
      has_refresh: hasRefreshPresence(c),
    })
    const safeVm = { ...vm, claude: safeClaude }
    if (vm.antigravity) {
      // CLI authentication belongs to the slot keyring; mirror display metadata only.
      safeVm.antigravity = { email: typeof vm.antigravity.email === 'string' ? vm.antigravity.email : null }
    }
    if (antigravity) {
      delete safeVm.claude
      delete safeVm.codex
    }
    const enc = encryptionEnabled()
    this._upsert.run(
      vm.id,
      vm.name ?? null,
      vm.status ?? null,
      vm.schedulable === false ? 0 : 1,
      antigravity ? (safeVm.antigravity?.email ?? null) : (safeClaude.email ?? null),
      safeClaude.account_uuid ?? null,
      safeClaude.org_uuid ?? null,
      null,
      null,
      null,
      c.expires_at != null ? String(c.expires_at) : null,
      safeClaude.source ?? null,
      vm.proxy?.id ?? null,
      vm.claude_code_version ?? null,
      vm.timezone ?? null,
      vm.locale ?? null,
      normalizeOwnerId(vm.owner_user_id),
      vmOriginOf(vm),
      enc ? maybeEncrypt(JSON.stringify(safeVm)) : JSON.stringify(safeVm),
      enc ? 1 : 0,
      mtimeMs != null ? Math.floor(mtimeMs) : null,
      now,
      vm.created_at ?? now,
      now,
    )
    return this.get(vm.id)
  }

  /** Returns {row, vm} — row has decrypted credential columns, vm is the parsed vm.json. */
  get(id) {
    return this._decode(this._get.get(id))
  }

  list() {
    return this._list.all().map((r) => this._decode(r))
  }

  ids() {
    return this.db
      .prepare('SELECT id FROM vms ORDER BY id')
      .all()
      .map((r) => r.id)
  }

  remove(id) {
    return this._remove.run(id).changes > 0
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) c FROM vms').get().c
  }

  getActiveVmId() {
    return this.settings.get(ACTIVE_VM_KEY, null)
  }

  setActiveVmId(id) {
    this.settings.set(ACTIVE_VM_KEY, id)
  }

  clearActiveVmId() {
    this.settings.remove(ACTIVE_VM_KEY)
  }

  _decode(row) {
    if (!row) return null
    let vm = null
    try {
      vm = JSON.parse(maybeDecrypt(row.vm_json))
    } catch {
      vm = null
    }
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      schedulable: !!row.schedulable,
      email: row.email,
      account_uuid: row.account_uuid,
      org_uuid: row.org_uuid,
      access_token: maybeDecrypt(row.access_token),
      refresh_token: maybeDecrypt(row.refresh_token),
      session_key: maybeDecrypt(row.session_key),
      oauth_expires_at: row.oauth_expires_at,
      oauth_source: row.oauth_source,
      proxy_id: row.proxy_id,
      claude_code_version: row.claude_code_version,
      timezone: row.timezone,
      locale: row.locale,
      encrypted: !!row.encrypted,
      file_mtime_ms: row.file_mtime_ms,
      synced_at: row.synced_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      vm,
    }
  }
}
