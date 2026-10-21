import crypto from 'node:crypto'
import { quoteIdentifier, withTransaction } from './database.mjs'
import { coordinationSchemaFor } from './global-maintenance.mjs'

export function nodeAuthoritySchemaFor(applicationSchema) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(applicationSchema)) throw new Error('invalid database schema')
  return 'vm2api_node_' + crypto.createHash('sha256').update(applicationSchema).digest('hex').slice(0, 32)
}

export function nodeAuthorityError(code = 'node_authority_unavailable') {
  return Object.assign(new Error(code.replaceAll('_', ' ')), { code })
}

export function nodeGrantResource(nodeId, vmId) {
  return `node:${nodeId}:vm:${vmId}`
}
export function nodeGrantNamespace(schema) {
  return `vm2api:node-management:${schema}`
}

export async function lockNodeGrant(db, schema, nodeId, vmId) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [
    nodeGrantNamespace(schema),
    nodeGrantResource(nodeId, vmId),
  ])
}

export async function nodeAuthorityState(db) {
  const schema = nodeAuthoritySchemaFor(db.schema)
  const coord = quoteIdentifier(coordinationSchemaFor(db.schema))
  const q = quoteIdentifier(schema)
  const names = (
    await db.query(
      `SELECT to_regnamespace($1) AS authority,
    COALESCE((SELECT pg_get_userbyid(nspowner)=current_user FROM pg_namespace WHERE nspname=$1),false) AS owned,
    to_regclass($2) AS marker`,
      [schema, `${coord}.node_authority_features`],
    )
  ).rows[0]
  // This combination can only represent a feature that has never been enabled.
  if (!names.authority && !names.marker) return { enabled: false, schema }
  if (!names.authority || !names.marker || !names.owned) throw nodeAuthorityError()
  try {
    const marker = (
      await db.query(`SELECT * FROM ${coord}.node_authority_features WHERE application_schema=$1`, [db.schema])
    ).rows[0]
    const meta = (await db.query(`SELECT * FROM ${q}.meta WHERE id=1`)).rows[0]
    if (
      marker?.authority_schema !== schema ||
      marker.protocol_version !== 1 ||
      meta?.application_schema !== db.schema ||
      meta.protocol_version !== 1
    )
      throw nodeAuthorityError()
    const relations = (
      await db.query(
        `SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL
      AND to_regclass($3) IS NOT NULL AND to_regprocedure($4) IS NOT NULL AND to_regprocedure($5) IS NOT NULL AS ready`,
        [
          `${q}.allocations`,
          `${q}.reader_roles`,
          `${q}.authorized_allocations`,
          `${q}.reader_identity()`,
          `${q}.allocation_current(text)`,
        ],
      )
    ).rows[0]
    if (!relations.ready) throw nodeAuthorityError()
    return { enabled: true, schema, q }
  } catch {
    throw nodeAuthorityError()
  }
}

export async function initializeNodeAuthority(db) {
  return withTransaction(db, async () => {
    const schema = nodeAuthoritySchemaFor(db.schema)
    const q = quoteIdentifier(schema)
    const coord = quoteIdentifier(coordinationSchemaFor(db.schema))
    await db.query('SELECT pg_advisory_xact_lock(hashtext(current_database()),hashtext($1))', [
      `vm2api:node-authority-bootstrap:${db.schema}`,
    ])
    const existing = await nodeAuthorityState(db)
    if (existing.enabled) return existing
    const maintenance = (await db.query(`SELECT application_schema,phase FROM ${coord}.control WHERE id=1`)).rows[0]
    if (maintenance?.application_schema !== db.schema || maintenance.phase !== 'open') throw nodeAuthorityError()
    await db.query(`CREATE SCHEMA ${q} AUTHORIZATION CURRENT_USER;
      REVOKE ALL ON SCHEMA ${q} FROM PUBLIC;
      CREATE TABLE ${q}.meta (
        id integer PRIMARY KEY CHECK(id=1), application_schema text NOT NULL, protocol_version integer NOT NULL CHECK(protocol_version=1));
      CREATE TABLE ${coord}.node_authority_features (
        application_schema text PRIMARY KEY, authority_schema text NOT NULL, protocol_version integer NOT NULL CHECK(protocol_version=1));
      REVOKE ALL ON ${coord}.node_authority_features FROM PUBLIC;
      CREATE TABLE ${q}.reader_roles (role_name name PRIMARY KEY, node_id text NOT NULL);
      CREATE TABLE ${q}.allocations (
        allocation_id text PRIMARY KEY, node_id text NOT NULL, vm_id text NOT NULL UNIQUE,
        physical_target text NOT NULL UNIQUE, operation_id text NOT NULL, owner_id text NOT NULL,
        action text NOT NULL CHECK(action='allocate'), epoch bigint NOT NULL CHECK(epoch>0),
        intent_digest text NOT NULL, receipt jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz);
      CREATE INDEX allocations_operation ON ${q}.allocations(operation_id,owner_id) WHERE revoked_at IS NULL;
      REVOKE ALL ON ALL TABLES IN SCHEMA ${q} FROM PUBLIC`)
    await db.query(`INSERT INTO ${q}.meta VALUES (1,$1,1)`, [db.schema])
    await db.query(`INSERT INTO ${coord}.node_authority_features VALUES ($1,$2,1)`, [db.schema, schema])
    // No business table is a static dependency: a schema restore must not DROP
    // CASCADE these functions/view or resurrect an old allocation authorization.
    await db.query(`CREATE FUNCTION ${q}.reader_identity() RETURNS TABLE(node_id text,application_schema text,protocol_version integer)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
      DECLARE owner_name name;
      BEGIN
        SELECT pg_get_userbyid(nspowner) INTO owner_name FROM pg_namespace WHERE nspname='${schema}';
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls))
          OR pg_has_role(session_user,owner_name,'MEMBER')
          OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=session_user)
          OR has_schema_privilege(session_user,'${schema}','CREATE')
          OR has_table_privilege(session_user,'${schema}.allocations','INSERT,UPDATE,DELETE,TRUNCATE') THEN RETURN; END IF;
        RETURN QUERY SELECT r.node_id,m.application_schema,m.protocol_version FROM ${q}.reader_roles r CROSS JOIN ${q}.meta m
          WHERE r.role_name=session_user AND m.id=1 AND m.protocol_version=1;
      END $body$;
      CREATE FUNCTION ${q}.allocation_current(p_allocation text) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
      DECLARE g record; app text; allowed boolean;
      BEGIN
        SELECT a.*,m.application_schema INTO g FROM ${q}.allocations a CROSS JOIN ${q}.meta m
          JOIN ${q}.reader_roles r ON r.role_name=session_user
          JOIN ${coord}.control c ON c.id=1
          JOIN ${coord}.node_authority_features f ON f.application_schema=m.application_schema
          WHERE a.allocation_id=p_allocation AND a.node_id=r.node_id AND a.revoked_at IS NULL AND a.action='allocate'
            AND m.id=1 AND m.protocol_version=1 AND f.protocol_version=1 AND f.authority_schema='${schema}'
            AND c.application_schema=m.application_schema AND c.phase='open' AND c.epoch=a.epoch;
        IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM ${q}.reader_identity()) THEN RETURN false; END IF;
        app:=g.application_schema;
        EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.vm_operations WHERE id=$1 AND owner_id=$2 AND vm_id=$3
          AND kind=''node_allocate'' AND released_at IS NULL AND uncertain_at IS NULL)',app)
          INTO allowed USING g.operation_id,g.owner_id,g.vm_id;
        RETURN allowed;
      EXCEPTION WHEN undefined_table OR invalid_schema_name THEN RETURN false;
      END $body$;
      REVOKE ALL ON FUNCTION ${q}.reader_identity() FROM PUBLIC;
      REVOKE ALL ON FUNCTION ${q}.allocation_current(text) FROM PUBLIC;
      CREATE VIEW ${q}.authorized_allocations WITH(security_barrier=true) AS
        SELECT allocation_id,node_id,vm_id,operation_id,owner_id,action,epoch,intent_digest
          FROM ${q}.allocations WHERE ${q}.allocation_current(allocation_id);
      REVOKE ALL ON ${q}.authorized_allocations FROM PUBLIC`)
    return nodeAuthorityState(db)
  })
}

/** New command authority is a separately and explicitly installed feature. */
export async function nodeCommandAuthorityState(db) {
  const base = await nodeAuthorityState(db)
  if (!base.enabled) return { enabled: false, schema: base.schema }
  const coord = quoteIdentifier(coordinationSchemaFor(db.schema))
  const unavailable = () => nodeAuthorityError('node_command_authority_unavailable')
  try {
    const objects = (
      await db.query(
        `SELECT
      EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass($1) AND attname='command_protocol_version' AND NOT attisdropped) AS meta_version,
      EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass($2) AND attname='command_protocol_version' AND NOT attisdropped) AS marker_version,
      to_regclass($3) IS NOT NULL AS grants,
      to_regclass($4) IS NOT NULL AS view,
      to_regprocedure($5) IS NOT NULL AS current_function`,
        [
          `${base.q}.meta`,
          `${coord}.node_authority_features`,
          `${base.q}.command_grants`,
          `${base.q}.authorized_commands`,
          `${base.q}.command_current(text)`,
        ],
      )
    ).rows[0]
    if (Object.values(objects).every((value) => value === false)) return { enabled: false, schema: base.schema }
    if (!Object.values(objects).every((value) => value === true)) throw unavailable()
    const versions = (
      await db.query(
        `SELECT m.command_protocol_version AS local_version,
      f.command_protocol_version AS marker_version FROM ${base.q}.meta m
      JOIN ${coord}.node_authority_features f ON f.application_schema=m.application_schema
      WHERE m.id=1 AND f.authority_schema=$1`,
        [base.schema],
      )
    ).rows[0]
    if (versions?.local_version !== 1 || versions.marker_version !== 1) throw unavailable()
    return base
  } catch {
    throw unavailable()
  }
}

/** Trusted provisioning only. Startup/read/issuance paths never call this DDL. */
export async function initializeNodeCommandAuthority(db) {
  return withTransaction(db, async () => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext(current_database()),hashtext($1))', [
      `vm2api:node-authority-bootstrap:${db.schema}`,
    ])
    const base = await nodeAuthorityState(db)
    if (!base.enabled) throw nodeAuthorityError('node_command_authority_unavailable')
    const existing = await nodeCommandAuthorityState(db)
    if (existing.enabled) return existing
    const { q, schema } = base
    const coord = quoteIdentifier(coordinationSchemaFor(db.schema))
    const state = (await db.query(`SELECT phase FROM ${coord}.control WHERE id=1 FOR SHARE`)).rows[0]
    if (state?.phase !== 'open') throw nodeAuthorityError('node_command_authority_unavailable')
    await db.query(`ALTER TABLE ${q}.meta ADD COLUMN command_protocol_version integer NOT NULL DEFAULT 1 CHECK(command_protocol_version=1);
      ALTER TABLE ${coord}.node_authority_features ADD COLUMN command_protocol_version integer NOT NULL DEFAULT 1 CHECK(command_protocol_version=1);
      CREATE TABLE ${q}.command_grants (
        command_id text PRIMARY KEY, node_id text NOT NULL, vm_id text NOT NULL,
        allocation_id text NOT NULL REFERENCES ${q}.allocations(allocation_id),
        operation_id text NOT NULL, owner_id text NOT NULL,
        action text NOT NULL CHECK(action IN ('publish-initial','launch')),
        epoch bigint NOT NULL CHECK(epoch>0), intent_digest text NOT NULL CHECK(intent_digest ~ '^[a-f0-9]{64}$'),
        intent jsonb NOT NULL, receipt jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        revoked_at timestamptz, UNIQUE(allocation_id,action));
      CREATE INDEX command_grants_operation ON ${q}.command_grants(operation_id,owner_id) WHERE revoked_at IS NULL;
      REVOKE ALL ON ${q}.command_grants FROM PUBLIC;
      CREATE FUNCTION ${q}.command_current(p_command text) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
      DECLARE g record; allowed boolean;
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM ${q}.reader_identity())
          OR has_table_privilege(session_user,'${schema}.command_grants','INSERT,UPDATE,DELETE,TRUNCATE') THEN RETURN false; END IF;
        SELECT a.*,m.application_schema INTO g FROM ${q}.command_grants a
          JOIN ${q}.allocations origin ON origin.allocation_id=a.allocation_id
          CROSS JOIN ${q}.meta m
          JOIN ${q}.reader_roles r ON r.role_name=session_user
          JOIN ${coord}.control c ON c.id=1
          JOIN ${coord}.node_authority_features f ON f.application_schema=m.application_schema
          WHERE a.command_id=p_command AND a.node_id=r.node_id AND a.revoked_at IS NULL
            AND m.id=1 AND m.protocol_version=1 AND m.command_protocol_version=1
            AND f.protocol_version=1 AND f.command_protocol_version=1 AND f.authority_schema='${schema}'
            AND c.application_schema=m.application_schema AND c.phase='open' AND c.epoch=a.epoch
            AND origin.node_id=a.node_id AND origin.vm_id=a.vm_id AND origin.epoch=a.epoch
            AND origin.receipt->>'allocation_id'=a.allocation_id AND origin.receipt->>'epoch'=a.epoch::text
            AND origin.receipt->'fence'->>'generation'='1'
            AND a.intent->'fence'->>'generation'='1'
            AND a.intent->'fence'->>'incarnation'=origin.receipt->'fence'->>'incarnation'
            AND a.intent->'fence'->'executor'='{"kind":"","node_boot_id":""}'::jsonb
            AND a.intent->>'action'=a.action AND a.intent->>'epoch'=a.epoch::text
            AND a.intent->>'node_id'=a.node_id AND a.intent->>'vm_id'=a.vm_id
            AND a.intent->>'allocation_id'=a.allocation_id AND a.intent->>'command_id'=a.command_id
            AND a.intent->>'operation_id'=a.operation_id AND a.intent->>'owner_id'=a.owner_id
            AND a.intent->>'preset_id'='claude-docker-v1' AND a.intent->>'manifest_revision'='1'
            AND a.intent->>'policy_digest' ~ '^[a-f0-9]{64}$'
            AND ((a.action='publish-initial' AND a.intent->>'expected_manifest_revision'='0'
                AND a.intent->>'payload_digest' ~ '^[a-f0-9]{64}$' AND a.intent->>'manifest_digest'='')
              OR (a.action='launch' AND a.intent->>'expected_manifest_revision'='1' AND a.intent->>'payload_digest'=''
                AND EXISTS(SELECT 1 FROM ${q}.command_grants p WHERE p.allocation_id=a.allocation_id
                  AND p.action='publish-initial' AND p.epoch=a.epoch AND p.receipt IS NOT NULL
                  AND p.receipt->>'intent_digest'=p.intent_digest
                  AND p.receipt->>'manifest_revision'='1'
                  AND p.receipt->>'manifest_digest'=a.intent->>'manifest_digest'
                  AND p.intent->>'policy_digest'=a.intent->>'policy_digest'
                  AND p.intent->'fence'=a.intent->'fence')));
        IF NOT FOUND THEN RETURN false; END IF;
        EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.vm_operations WHERE id=$1 AND owner_id=$2 AND vm_id=$3
          AND kind=$4 AND released_at IS NULL AND uncertain_at IS NULL)',g.application_schema)
          INTO allowed USING g.operation_id,g.owner_id,g.vm_id,
            CASE g.action WHEN 'publish-initial' THEN 'node_publish_initial' ELSE 'node_launch' END;
        RETURN allowed;
      EXCEPTION WHEN undefined_table OR invalid_schema_name THEN RETURN false;
      END $body$;
      REVOKE ALL ON FUNCTION ${q}.command_current(text) FROM PUBLIC;
      CREATE VIEW ${q}.authorized_commands WITH(security_barrier=true) AS
        SELECT command_id,node_id,vm_id,allocation_id,operation_id,owner_id,action,epoch,intent_digest
          FROM ${q}.command_grants WHERE ${q}.command_current(command_id);
      REVOKE ALL ON ${q}.authorized_commands FROM PUBLIC`)
    return nodeCommandAuthorityState(db)
  })
}

// Caller must already hold the exact VM operation row. This lock order also
// governs issuance; the node's shared-lock path uses MVCC reads only.
export async function revokeNodeOperationGrants(db, { operationId, ownerId }) {
  if (!db.isTransaction) throw nodeAuthorityError()
  const state = await nodeAuthorityState(db)
  if (!state.enabled) return
  const commands = await nodeCommandAuthorityState(db)
  const rows = (
    await db.query(
      `SELECT DISTINCT node_id,vm_id FROM (
        SELECT node_id,vm_id FROM ${state.q}.allocations WHERE operation_id=$1 AND owner_id=$2 AND revoked_at IS NULL
        ${commands.enabled ? `UNION ALL SELECT node_id,vm_id FROM ${state.q}.command_grants WHERE operation_id=$1 AND owner_id=$2 AND revoked_at IS NULL` : ''}
      ) grants ORDER BY node_id,vm_id`,
      [operationId, ownerId],
    )
  ).rows
  for (const row of rows) await lockNodeGrant(db, state.schema, row.node_id, row.vm_id)
  await db.query(
    `UPDATE ${state.q}.allocations SET revoked_at=clock_timestamp()
    WHERE operation_id=$1 AND owner_id=$2 AND revoked_at IS NULL`,
    [operationId, ownerId],
  )
  if (commands.enabled)
    await db.query(
      `UPDATE ${state.q}.command_grants SET revoked_at=clock_timestamp()
      WHERE operation_id=$1 AND owner_id=$2 AND revoked_at IS NULL`,
      [operationId, ownerId],
    )
}
