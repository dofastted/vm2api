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

// Caller must already hold the exact VM operation row. This lock order also
// governs issuance; the node's shared-lock path uses MVCC reads only.
export async function revokeNodeOperationGrants(db, { operationId, ownerId }) {
  if (!db.isTransaction) throw nodeAuthorityError()
  const state = await nodeAuthorityState(db)
  if (!state.enabled) return
  const rows = (
    await db.query(
      `SELECT DISTINCT node_id,vm_id FROM ${state.q}.allocations
    WHERE operation_id=$1 AND owner_id=$2 AND revoked_at IS NULL ORDER BY node_id,vm_id`,
      [operationId, ownerId],
    )
  ).rows
  for (const row of rows) await lockNodeGrant(db, state.schema, row.node_id, row.vm_id)
  await db.query(
    `UPDATE ${state.q}.allocations SET revoked_at=clock_timestamp()
    WHERE operation_id=$1 AND owner_id=$2 AND revoked_at IS NULL`,
    [operationId, ownerId],
  )
}
