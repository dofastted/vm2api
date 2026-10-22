import test from 'node:test'
import fs from 'node:fs'
const scenario=process.argv[2]
let ensureCalls=0,podReads=0,marked=0,captures=0,legacy=0
const credential={has_access:true,has_refresh:true,needs_refresh:false,generation:'2',expires_at:'2000000000000'}
const outcome=scenario.endsWith('unknown')?{ok:false,status:503,attemptFinished:false,credentialRefreshUnknown:true}:scenario.endsWith('refused')?{ok:false,status:503,credentialRefreshNotStarted:true}:{ok:true,status:200,refreshed:true,attemptFinished:true,credential}
const ensure=async exec=>{ensureCalls++;if(!exec.slotgate)throw new Error('missing typed node capability');return outcome}
let result,error
if(scenario.startsWith('runner')){
 const worker=await import('../../src/lib/transport/go-worker-client.mjs')
 test.mock.module(new URL('../../src/lib/transport/go-worker-client.mjs',import.meta.url).href,{namedExports:{...worker,ensureWorkerCredential:ensure}})
 const credentials=await import('../../src/lib/oauth/oauth-credentials.mjs')
 test.mock.module(new URL('../../src/lib/oauth/oauth-credentials.mjs',import.meta.url).href,{namedExports:{...credentials,readWorkerCredentialFile:()=>{podReads++;throw new Error('Pod credential read')}}})
 const{FailoverRunner}=await import('../../src/lib/pool/failover-runner.mjs')
 const runner=new FailoverRunner({scheduler:{}})
 const selected={vmId:'ha-vm',accountId:'ha-account',exec:{vmId:'ha-vm',accountId:'ha-account',slotgate:{trusted:true}},bindExecution:async()=>{},markUncertain:async()=>{marked++}}
 try{result=await runner.recoverCredential(selected,{reason:'oauth_refresh_required',action:'switch',retrySameAccount:false},{executionEnded:true})}catch(e){error={code:e.code,executionUncertain:e.executionUncertain}}
}else{
 const source=fs.readFileSync(new URL('../../src/server.mjs',import.meta.url),'utf8')
 const start=source.indexOf('async function refreshWorkerCredentialForVm('),end=source.indexOf('\n}\n',start)+2
 if(start<0||end<start)throw new Error('production refresh function not found')
 const current={id:'ha-vm',node_id:'pg-node',claude:{account_uuid:'ha-account'}}
 const deps={haMode:true,kubernetesMode:true,db:{fixture:true},trustedNodes:{fixture:true},haCatalog:{refresh:async()=>{},get:()=>current},captureNodeExecution:async input=>{captures++;if(input.nodeId!=='pg-node'||input.accountId!=='ha-account')throw new Error('stale VM metadata was trusted');return{vmId:'ha-vm',accountId:'ha-account',slotgate:{trusted:true},workerStatus:{ok:true,credential:{account_uuid:'ha-account'}}}},ensureWorkerCredential:ensure,publicCredentialRefreshResult:(vmId,value)=>({vm_id:vmId,...value}),mirrorWorkerCredentialsToVm:()=>{legacy++},flushVmDbSync:async()=>{legacy++},invalidateLiveCredentialCache:()=>{legacy++},markVmRefreshError:()=>{legacy++},accountQuota:{clearGrantRevokeLeftover:()=>{legacy++}},poolScheduler:{clearAuthCooldownFor:()=>{legacy++},clearGrantRevokeCooldownFor:()=>{legacy++}}}
 const refresh=Function('deps',`with(deps){return (${source.slice(start,end)})}`)(deps)
 try{result=await refresh({vmId:'ha-vm',homeDir:'/must-not-read',vmPath:'/must-not-write',vm:{id:'ha-vm',node_id:'stale-node'},force:true})}catch(e){error={code:e.code,message:e.message}}
}
process.stdout.write(JSON.stringify({ensureCalls,podReads,marked,captures,legacy,result,error}))
