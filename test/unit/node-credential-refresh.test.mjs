import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import {getDb,createDatabase,quoteIdentifier} from '../../src/lib/db/database.mjs'
import {GlobalMaintenanceCoordinator} from '../../src/lib/db/global-maintenance.mjs'
import {NodeManagementGrants} from '../../src/lib/cluster/node-management-grants.mjs'
import {SharedVmOperations} from '../../src/lib/vm/shared-vm-operations.mjs'
import {SharedCredentialRefresh} from '../../src/lib/oauth/shared-credential-refresh.mjs'
import * as refreshModule from '../../src/lib/cluster/node-credential-refresh-grants.mjs'

const nodeId='refresh-node',vmId='refresh-vm',accountId='refresh-account',allocationId='refresh-allocation'
const vacant={generation:'1',incarnation:'a'.repeat(32),executor:{kind:'',node_boot_id:''}}
const fence={generation:'1',incarnation:vacant.incarnation,executor:{kind:'container',node_boot_id:'synthetic-boot',container_id:'b'.repeat(64),docker_daemon_id:'synthetic-daemon',started_at:'2026-10-22T00:00:00.000000001Z'}}
const summary=(generation)=>({generation,expires_at:'2000000000000',account_uuid:accountId,has_access:true,has_refresh:true,needs_refresh:false})
async function fixture(t){
 const db=getDb(),peer=await createDatabase({connectionString:db.connectionString,schema:db.schema})
 const maintenance=new GlobalMaintenanceCoordinator(db),base=new NodeManagementGrants(db)
 const grants=new refreshModule.NodeCredentialRefreshGrants(db),q=quoteIdentifier(base.schema)
 const readers=[],roles=[];let closed=false
 const close=async()=>{if(closed)return;closed=true;await maintenance.stop();await peer.close();for(const c of readers)await c.end();const c=new pg.Client({connectionString:db.connectionString});await c.connect();try{for(const role of roles)await c.query(`DROP OWNED BY ${quoteIdentifier(role)};DROP ROLE ${quoteIdentifier(role)}`);await c.query(`DROP SCHEMA IF EXISTS ${q} CASCADE;DROP SCHEMA IF EXISTS ${quoteIdentifier(maintenance.schema)} CASCADE`)}finally{await c.end()}}
 t.after(close);await maintenance.start();await maintenance.acknowledgeEpoch(1);await base.initialize();await base.initializeCommands()
 const run=(kind,fn)=>new SharedVmOperations(db).run(vmId,fn,{kind,accountId})
 await run('node_allocate',async operation=>{const g=await base.issueAllocation({operation,nodeId,vmId,allocationId});await db.query(`UPDATE ${q}.allocations SET receipt=$2::jsonb WHERE allocation_id=$1`,[allocationId,JSON.stringify({node_id:nodeId,vm_id:vmId,allocation_id:allocationId,operation_id:g.operationId,owner_id:g.ownerId,epoch:g.epoch,intent_digest:g.intentDigest,fence:vacant})])})
 await run('node_publish_initial',async operation=>{const g=await base.issueInitialPublish({operation,nodeId,vmId,allocationId,commandId:'initial-publish',capturedFence:vacant,expectedManifestRevision:'0',revision:'1',payloadDigest:'c'.repeat(64),presetId:'claude-docker-v1',policyDigest:'d'.repeat(64)});await base.recordInitialPublishReceipt(g,{intent:g.intent,intent_digest:g.intentDigest,manifest_revision:'1',manifest_digest:'e'.repeat(64)})})
 await run('node_launch',async operation=>{const g=await base.issueLaunch({operation,nodeId,vmId,allocationId,commandId:'initial-launch',capturedFence:vacant,expectedManifestRevision:'1',revision:'1',payloadDigest:'',presetId:'claude-docker-v1',policyDigest:'d'.repeat(64),manifestDigest:'e'.repeat(64)});await base.recordLaunchReceipt(g,{intent:g.intent,intent_digest:g.intentDigest,manifest_revision:'1',manifest_digest:'e'.repeat(64),fence})})
 let current={generation:'1',credential:summary('1')}
 const refresh=new SharedCredentialRefresh(db)
 const input=(operation,patch={})=>({operation,nodeId,vmId,accountId,commandId:crypto.randomUUID(),capturedFence:fence,expectedGeneration:current.generation,force:true,...patch})
 const attempt=(callback)=>refresh.run({platform:'claude',vmId,accountId,expectedGeneration:current.generation},{readCurrent:async()=>current,refresh:callback,publish:async(_old,value)=>{current={generation:value.generation,credential:summary(value.generation)};return current}})
 const receipt=(g,generation='2')=>({intent:g.intent,intent_digest:g.intentDigest,finished:true,ok:true,status:200,refreshed:true,credential:summary(generation)})
 const reader=async()=>{const role='refresh_reader_'+crypto.randomBytes(8).toString('hex'),password=crypto.randomBytes(20).toString('hex');roles.push(role);await db.pool.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);await db.pool.query(base.readerRoleSql({role,nodeId}));await db.pool.query(grants.readerRoleSql({role}));const url=new URL(db.connectionString);url.username=role;url.password=password;const c=new pg.Client({connectionString:url.toString()});await c.connect();readers.push(c);return c}
 return{db,peer,base,grants,q,maintenance,run,input,attempt,receipt,reader,close}
}
function refreshCase(name,fn){test(name,async t=>{const f=await fixture(t);try{await fn(f,t)}finally{await f.close()}})}
refreshCase('refresh authority requires its independent explicit markers and creates no runtime DDL',async f=>{
 await assert.rejects(f.attempt(async(_current,{operation})=>{await f.grants.issue(f.input(operation));return{finished:true,value:{ok:false}}}),{code:'node_refresh_authority_unavailable'})
 assert.equal((await f.peer.query('SELECT to_regclass($1) AS relation',[`${f.base.schema}.refresh_grants`])).rows[0].relation,null)
 await f.grants.initialize()
 assert.equal((await f.peer.query(`SELECT refresh_protocol_version FROM ${f.q}.meta`)).rows[0].refresh_protocol_version,1)
 await f.peer.query(`UPDATE ${quoteIdentifier(f.maintenance.schema)}.node_authority_features SET refresh_protocol_version=NULL`)
 await assert.rejects(f.grants.state(),{code:'node_refresh_authority_unavailable'})
})
refreshCase('refresh grant requires exact live BG/VM/account scope and a canonical launch chain',async f=>{
 await f.grants.initialize()
 await f.run('credential_refresh',async operation=>{await assert.rejects(f.grants.issue(f.input(operation)),{code:'node_refresh_scope_required'})})
 const reader=await f.reader();let command
 const result=await f.attempt(async(_current,{operation})=>{
  await assert.rejects(f.grants.issue(f.input(operation,{accountId:'other-account'})),{code:'node_refresh_scope_required'})
  const g=await f.grants.issue(f.input(operation));command=g.intent.command_id
  assert.equal((await reader.query(`SELECT command_id FROM ${f.q}.authorized_refreshes`)).rows[0].command_id,command)
  await assert.rejects(reader.query(`SELECT * FROM ${f.q}.refresh_grants`),{code:'42501'})
  const stored=await f.grants.recordReceipt(g,f.receipt(g));assert.equal(stored.credential.generation,'2')
  return{finished:true,value:{ok:true,generation:'2'}}
 })
 assert.equal(result.unknown,false)
 assert.equal((await reader.query(`SELECT count(*)::int AS n FROM ${f.q}.authorized_refreshes`)).rows[0].n,0)
 const row=(await f.peer.query(`SELECT receipt FROM ${f.q}.refresh_grants WHERE command_id=$1`,[command])).rows[0]
 assert.equal(row.receipt.credential.generation,'2');assert.equal(JSON.stringify(row).includes('access_token'),false)
})
refreshCase('unknown refresh cannot be reissued by another connection or a different command ID',async f=>{
 await f.grants.initialize();let id
 const result=await f.attempt(async(_current,{operation})=>{const g=await f.grants.issue(f.input(operation));id=g.intent.command_id;return{finished:false,value:{ok:false}}})
 assert.equal(result.unknown,true)
 const row=(await f.peer.query(`SELECT receipt,revoked_at FROM ${f.q}.refresh_grants WHERE command_id=$1`,[id])).rows[0]
 assert.equal(row.receipt,null)
 assert.ok((await f.peer.query('SELECT uncertain_at FROM vm_operations WHERE kind=$1',['credential_refresh'])).rows[0].uncertain_at)
 const gate=await new SharedVmOperations(f.peer).tryAcquire({vmId,accountId,kind:'credential_refresh'})
 assert.equal(gate.ok,false);assert.equal(gate.code,'vm_operation_active')
})
