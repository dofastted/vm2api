# Trusted node execution capability contract

This change supplies a production reader and transport boundary for the explicit
`kubernetes-ha` mode. It does not enable that mode, start nodes, or provide the
Go health RPC or node credential refresh. Native, KVM and Codex HA are unsupported.
The existing standalone and singleton Kubernetes paths retain their behavior.

## Capture

`captureNodeExecution({db, vmId, accountId, nodeId?, trustedNodes,
readLaunchReceipt?, timeoutMs?, signal?})` returns a deeply frozen internal object:

```js
{
  vmId, accountId,
  slotgate: {
    trusted: true, pgBindingReady: true, nodeId, vmId, fence,
    manifest: {revision, digest},
    link: {address, port, token, certSha256},
  },
  nodeManifest: {revision, digest, presetId, policyDigest, epoch},
  workerStatus,
}
```

The link token is an internal transport credential. This object is not a public
panel response or a serializable request-log payload.

`trustedNodes` is a bootstrap-installed, fixed Map or object keyed by node ID.
Each entry contains `{address, port, token, certSha256,
presetId: 'claude-docker-v1', policyDigest}`. The reader snapshots this configuration
before its first asynchronous lookup. No endpoint, pin, token or fence comes from
VM JSON. `nodeId`, when supplied, only constrains the independently read receipt.

By default the reader calls `NodeManagementGrants.readLaunchReceipt({vmId,nodeId?})`.
That method must verify the private allocation/publish/launch chain against the
current maintenance epoch and return the original Go launch receipt. A completed
management grant need not remain authorized. The caller already owns a database
request/bootstrap/background activity. Synthetic tests inject only this reader;
they do not stand in for real PG grant-chain verification.

Only the ordinary Claude Docker preset and the configured policy digest are
accepted. The ACTIVE fence is copied from `launchReceipt.fence`, including the
immutable container, Docker daemon, node boot and StartedAt identity. The original
VACANT `intent.fence` is never used for inference. The reader does not obtain a
fresh fence from node `state` or retry an old operation with a newer generation.

Capture awaits authenticated node health for the original fence and manifest.
Only `health.credential.account_uuid` authorizes `accountId`; email or a separate
identity field cannot replace it. If `health.identity.account_uuid` is present it
must agree. After health, the reader reads the PG receipt again and rejects any
epoch/receipt change. No PG transaction or grant lock spans the TLS operation.
The returned historical receipt alone does not prove that an executor is running.

The server and scheduler must use this capture before candidate admission, reuse
the returned `workerStatus`, and durably verify/bind the same receipt and node
identity before submitting inference. Those integrations are outside this change.

## Typed health RPC

The existing pinned TLS link carries one `KSG2 <token>` preface and JSON request:

```js
{op: 'health', vm_id, fence, manifest_revision, manifest_digest}
```

The reply is:

```js
{ok: true, fence, manifest_revision, manifest_digest, health: {
  ok, healthy, recovering, ready_slots, closed_slots, cli_restarts, cli_pid,
  engine, provider, worker_version, version, unhealthy_reason,
  classifier_request_context,
  credential: {has_access, has_refresh, needs_refresh, expires_at, generation,
               account_uuid, org_uuid, email},
  identity: {account_uuid, org_uuid, email},
}}
```

Optional public fields retain their validated types; unknown fields and nested
provider extensions are omitted. The client requires the exact captured fence
and manifest acknowledgement. Abort, timeout, invalid JSON, missing proof or an
unknown RPC never fall back to KSG1, UDS, SSH, Docker or an injected legacy ensure.

The Go implementation must verify the captured ACTIVE fence and manifest, read
only the fixed kernel health route and node credential summary, and perform no
implicit refresh or external provider request. Health does not create an inference
command and must not use `prepare`/`forward` for a GET. The existing normal Claude
terminal observer only finishes the supported Messages protocol.

## Transport boundary and remaining work

HA transport requires a capability before mocks or legacy execution. Fenced
preparation skips host kernel binary checks, Pod credential links and local
recycling. Health caches separate fences and manifests. For published manifests,
the node owns kernel-token injection; the Pod does not read an internal-token file.

Until separately implemented, fenced credential ensure/import, auxiliary worker
GET and count-tokens return an explicit unsupported result before local IO or a
legacy call. Credential ensure identifies this as not started. A future typed
node refresh must preserve the node-owned generation and terminal receipt; it
must not reintroduce Pod credential publication or SFTP mirroring.

The HA startup path, PG-only VM catalog, management capability matrix, background
producer gates, real Go health RPC and two active Pod verification are separate
required integrations. This change's TLS tests prove only the capability/client
contract and transport isolation. No production node or provider is used.
