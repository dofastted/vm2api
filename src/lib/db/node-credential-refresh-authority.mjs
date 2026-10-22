import { quoteIdentifier, withTransaction } from './database.mjs'
import { coordinationSchemaFor } from './global-maintenance.mjs'
import { nodeCommandAuthorityState, nodeAuthorityError } from './node-management-authority.mjs'
export async function nodeRefreshAuthorityState(db) {
  const base = await nodeCommandAuthorityState(db)
  if (!base.enabled) return { enabled: false, schema: base.schema }
  const coord = quoteIdentifier(coordinationSchemaFor(db.schema))
  try {
    const r = (
      await db.query(
        `SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass($1) AND attname='refresh_protocol_version' AND NOT attisdropped) AS meta,EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass($2) AND attname='refresh_protocol_version' AND NOT attisdropped) AS marker,to_regclass($3) IS NOT NULL AS grants,to_regclass($4) IS NOT NULL AS view,to_regprocedure($5) IS NOT NULL AS current_function`,
        [
          `${base.q}.meta`,
          `${coord}.node_authority_features`,
          `${base.q}.refresh_grants`,
          `${base.q}.authorized_refreshes`,
          `${base.q}.refresh_current(text)`,
        ],
      )
    ).rows[0]
    if (Object.values(r).every((v) => v === false)) return { enabled: false, schema: base.schema }
    if (!Object.values(r).every((v) => v === true)) throw new Error()
    const v = (
      await db.query(
        `SELECT m.refresh_protocol_version AS local,f.refresh_protocol_version AS marker FROM ${base.q}.meta m JOIN ${coord}.node_authority_features f ON f.application_schema=m.application_schema WHERE m.id=1 AND f.authority_schema=$1`,
        [base.schema],
      )
    ).rows[0]
    if (v?.local !== 1 || v.marker !== 1) throw new Error()
    return base
  } catch {
    throw nodeAuthorityError('node_refresh_authority_unavailable')
  }
}
export async function initializeNodeRefreshAuthority(db) {
  return withTransaction(db, async () => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext(current_database()),hashtext($1))', [
      `vm2api:node-authority-bootstrap:${db.schema}`,
    ])
    const base = await nodeCommandAuthorityState(db)
    if (!base.enabled) throw nodeAuthorityError('node_refresh_authority_unavailable')
    const existing = await nodeRefreshAuthorityState(db)
    if (existing.enabled) return existing
    const { q, schema } = base,
      coord = quoteIdentifier(coordinationSchemaFor(db.schema))
    const phase = (await db.query(`SELECT phase FROM ${coord}.control WHERE id=1 FOR SHARE`)).rows[0]
    if (phase?.phase !== 'open') throw nodeAuthorityError('node_refresh_authority_unavailable')
    await db.query(`ALTER TABLE ${q}.meta ADD COLUMN refresh_protocol_version integer DEFAULT 1 CHECK(refresh_protocol_version=1);
   ALTER TABLE ${coord}.node_authority_features ADD COLUMN refresh_protocol_version integer DEFAULT 1 CHECK(refresh_protocol_version=1);
   CREATE TABLE ${q}.refresh_grants(command_id text PRIMARY KEY,node_id text NOT NULL,vm_id text NOT NULL,allocation_id text NOT NULL REFERENCES ${q}.allocations(allocation_id),operation_id text NOT NULL,owner_id text NOT NULL,account_id text NOT NULL,bg_task_key text NOT NULL,bg_execution_id text NOT NULL,bg_owner_id text NOT NULL,epoch bigint NOT NULL CHECK(epoch>0),expected_generation text NOT NULL,intent_digest text NOT NULL,intent jsonb NOT NULL,receipt jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),revoked_at timestamptz);
   CREATE UNIQUE INDEX refresh_pending_generation ON ${q}.refresh_grants(node_id,vm_id,epoch,expected_generation) WHERE receipt IS NULL;
   CREATE INDEX refresh_operation ON ${q}.refresh_grants(operation_id,owner_id) WHERE revoked_at IS NULL;
   REVOKE ALL ON ${q}.refresh_grants FROM PUBLIC;
   CREATE FUNCTION ${q}.refresh_current(p_command text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
   DECLARE g record;allowed boolean;
   BEGIN
    IF NOT EXISTS(SELECT 1 FROM ${q}.reader_identity()) OR has_table_privilege(session_user,'${schema}.refresh_grants','INSERT,UPDATE,DELETE,TRUNCATE') THEN RETURN false;END IF;
    SELECT a.*,m.application_schema INTO g FROM ${q}.refresh_grants a CROSS JOIN ${q}.meta m
     JOIN ${q}.reader_roles r ON r.role_name=session_user
     JOIN ${coord}.control c ON c.id=1
     JOIN ${coord}.node_authority_features f ON f.application_schema=m.application_schema
     WHERE a.command_id=p_command AND a.node_id=r.node_id AND a.revoked_at IS NULL AND a.receipt IS NULL
     AND m.id=1 AND m.protocol_version=1 AND m.command_protocol_version=1 AND f.protocol_version=1 AND f.command_protocol_version=1 AND m.refresh_protocol_version=1 AND f.refresh_protocol_version=1 AND f.authority_schema='${schema}'
     AND c.application_schema=m.application_schema AND c.phase='open' AND c.epoch=a.epoch
     AND a.intent->>'action'='credential-refresh' AND a.intent->>'epoch'=a.epoch::text
     AND a.intent->>'node_id'=a.node_id AND a.intent->>'vm_id'=a.vm_id AND a.intent->>'account_id'=a.account_id
     AND a.intent->>'operation_id'=a.operation_id AND a.intent->>'owner_id'=a.owner_id
     AND a.intent->>'command_id'=a.command_id AND a.intent->>'allocation_id'=a.allocation_id
     AND a.intent->>'bg_task_key'=a.bg_task_key AND a.intent->>'bg_execution_id'=a.bg_execution_id AND a.intent->>'bg_owner_id'=a.bg_owner_id
     AND a.intent->>'expected_credential_generation'=a.expected_generation
     AND EXISTS(SELECT 1 FROM ${q}.command_grants l WHERE l.allocation_id=a.allocation_id AND l.action='launch' AND l.epoch=a.epoch AND l.node_id=a.node_id AND l.vm_id=a.vm_id
       AND l.receipt->>'intent_digest'=l.intent_digest AND l.receipt->'fence'=a.intent->'fence'
       AND l.receipt->>'manifest_digest'=a.intent->>'manifest_digest'
       AND l.intent->>'policy_digest'=a.intent->>'policy_digest');
    IF NOT FOUND THEN RETURN false;END IF;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.vm_operations WHERE id=$1 AND owner_id=$2 AND vm_id=$3 AND account_id=$4 AND kind=''credential_refresh'' AND released_at IS NULL AND uncertain_at IS NULL) AND EXISTS(SELECT 1 FROM %I.background_task_runs WHERE task_key=$5 AND execution_id=$6 AND owner_id=$7 AND finished_at IS NULL AND unknown_at IS NULL)',g.application_schema,g.application_schema)
     INTO allowed USING g.operation_id,g.owner_id,g.vm_id,g.account_id,g.bg_task_key,g.bg_execution_id,g.bg_owner_id;
    RETURN allowed;
   EXCEPTION WHEN undefined_table OR invalid_schema_name THEN RETURN false;
   END $body$;
   REVOKE ALL ON FUNCTION ${q}.refresh_current(text) FROM PUBLIC;
   CREATE VIEW ${q}.authorized_refreshes WITH(security_barrier=true) AS SELECT command_id,node_id,vm_id,allocation_id,operation_id,owner_id,account_id,bg_task_key,bg_execution_id,bg_owner_id,epoch,expected_generation,intent_digest FROM ${q}.refresh_grants WHERE ${q}.refresh_current(command_id);
   REVOKE ALL ON ${q}.authorized_refreshes FROM PUBLIC`)
    return nodeRefreshAuthorityState(db)
  })
}
