# VM-native telemetry

Telemetry is an explicit per-VM seed-policy opt-in. New VMs are disabled.
`kin-seed.json` → `seed_policy.telemetry_disabled` is the only enable authority.
Linux Docker and KVM use the existing resident cli-node, supervised by the Rust
kernel, as the sole upstream sender. macOS native slots report `unsupported`.
There is no Go telemetry service, watchdog, activity-touch file, or fallback.
Go remains the credential refresh owner and retains its non-telemetry duties.

## Ownership and authentication

The sender reads only its guest HOME, canonical credentials, local settings,
native identity and actual runtime characteristics. It never imports caller or
controller identity. Device identity is preserved across restart, token refresh
and proxy changes. Docker telemetry omits the shared host kernel; KVM may report
its actual guest kernel. Optional unavailable facts are omitted.

Uploads require an unexpired access token, `user:profile`, and a resolved account
from this VM. Missing credentials, API-key-only sessions and insufficient scope
pause upload. There is no anonymous send or authentication removal after 401.
Only necessary native 1P initialization, OAuth start/terminal, observed settings
changes and real request terminal events are retained. No prompt/response body,
credential, proxy secret, arbitrary settings or caller-supplied identity is
accepted. Extra Datadog/GrowthBook upload streams are not initialized.

Request terminal events retain admission-time VM account, route and collection
generation. Late completions across account/egress changes or disable/reopen
are discarded; same-account token rotation does not discard valid activity.

## Guest OAuth and private ingress

Linux `kin-oauth-auth` runs inside the selected guest under its business UID:
Docker uses `/usr/local/bin/kin-oauth-auth`; KVM uses
`/opt/kin-payload/usr/local/bin/kin-oauth-auth`, not the outer runner.
The unchanged helper is distributed through the existing payload mechanism.
Cold login prepares the same Rust/CLI process without making the account
schedulable. Native readiness is separate from credential readiness.

OAuth orchestration posts strict events to
`POST /internal/v1/telemetry/events` over the existing private Unix socket with
`X-Internal-Token`. Native protocol v2 advertises `vm_telemetry` on Linux and uses
`telemetry_event`, `telemetry_ack` and `telemetry_state` frames. ACK follows queue
persistence; generation changes invalidate pending ACKs. The endpoint rejects
unknown fields, identity, tokens, free-text errors and arbitrary settings.

Initial login and reauthorization remain provisional until the returned grant
is actually installed. They cannot borrow an old account's token. Go refresh
notifications surround actual refresh work below cache/lock checks; cache hits
and waiters produce no synthetic attempt. Observer failure is secondary to the
OAuth result and never requests RT replay. Successful import API responses may
include a nonfatal `telemetry_error`.

## Egress, timezone and batching

The VM hot-reads its current bound SOCKS5/socks5h route, including changed
connection credentials. Only an explicitly bound local exit permits direct
traffic; there is no controller-host fallback. The npm Undici connector uses a
real SOCKS connection with TLS verification enabled. Redirects are not followed.

The VM stores `telemetry/egress.json` below its own Claude config directory.
Snapshots bind VM, proxy revision, actual IP, timezone, check time and error.
Startup and route changes trigger a probe. Pending activity requires a fresh
snapshot, rechecked after ten minutes; an idle sender does not poll geo.
Unknown, failed or stale geo pauses upload without blocking OAuth or inference.
Proxy/connection changes and newly observed IP changes invalidate old-bound
backlog. Token rotation for the same account does not.

Timezone comes from that current egress snapshot and is serialized through
native `additional_metadata`; it does not overwrite the guest system timezone
or inference system prompt.

`routing.telemetry.upload_interval_seconds` defaults to **600**. Valid values
are whole minutes from **60–86400** seconds. Changes are published and observed
without restarting the VM or inference process. All events share that cadence:
no key-event, full-queue, shutdown, credential-ready or geo-ready forced flush.
Empty batches are not sent.

## Queue and disable semantics

`telemetry/queue.json` is guest-owned, bounded by one hour, 1000 records and
1 MiB, whichever is reached first; oldest records are evicted. Events retain
IDs across retry/restart. Conversations have distinct scoped session IDs.
Queue writes use file fsync and atomic replacement before private ACK.
The owner lock includes PID, kernel boot ID and process start ticks, so a
reused PID after container/guest restart is not mistaken for a live sender.

Disabling stops collection, aborts in-flight work and purges backlog. Reopening
collects only new activity. Ordinary process/VM restart restores still-valid
backlog and schedule; it is not an opt-out and does not force upload.

## Control plane, publication and rollout

Single-VM, bulk and interval controls publish native policy/configuration.
Remote success requires actual publication of `run/kernel.json` and all three
seed files: `claude/settings.json`, `claude/claude.setting`, and
`claude/kin-seed.json`. Controller-only writes are not success. Responses expose
`saved`, `published`, and `applied` independently; stopped VMs can retain
published policy without claiming a live sender or a runtime acknowledgment.
Policy-only publication deliberately excludes `machine-id`, OAuth `worker.json`,
`internal.token`, and credentials. Seed-only publication also excludes the
kernel config; full provisioning retains its separate, existing file sets.
The legacy retirement step inspects physical runtime state, including logically
paused VMs, and terminates only verified `kin-worker telemetry --config ...`
PIDs. It never broadly kills OAuth workers or restarts egress for telemetry.

Every actual Linux native launch is also fenced by verified legacy retirement;
a failed retirement blocks that launch, while healthy checks do not repeat it.

### Existing seed controls and lifecycle

`GET /api/panel/vms/:id/seed-settings` keeps saved `seed_policy` separate from
observed `settings_json`, `claude_setting`, and `kin_seed`. `seed_files` identifies
the storage placement (`local` or `node`), observation success, and each file's
`present` / `missing` / `error` state. Unavailable nodes never fall back to a
controller mirror. These paths are the configured Docker bind or KVM shared
backing store; a successful file read does not certify that a KVM guest mounted
the share or applied the policy.

PUT changes only supplied fields on the latest VM record. The seed form sends
edits relative to its unlock baseline, so changing a theme cannot resubmit a
stale telemetry opt-in or overwrite a newer opt-out. Polling does not replace an
unlocked draft, and failed publication leaves that draft editable. Non-seed
settings and VM-owned custom environment values survive policy-only writes;
explicit `extra_env` replacement still removes deleted values. Governed privacy,
timezone, locale, and forbidden credential/transport keys remain sanitized by
the single seed-policy builder.

Publication is serialized per VM and rereads the record after asynchronous
preparation. The acknowledged publication path suppresses an independent
fire-and-forget config push. Atomic private seed writes do not implicitly
publish runtime configuration. A failed publication can report `saved: true`,
`published: false`, `applied: false`; a completed publication awaiting a native
response reports `published: true`, `applied: false`. Neither is UI success for
runtime application. An off policy is confirmed only by native disabled state
and an empty queue; absence or an active old state remains unconfirmed. Both
single-VM and bulk controls can republish an unconfirmed, already-saved policy.

Official initialization's `sync_telemetry` remains default-off. When enabled, it
publishes the existing policy; it does not opt the account in. The finalizer's
`publish: false` option stages files only and claims neither publication nor
activation. Reauthorization preserves native IDs, settings, credentials, and
backlog. A healthy native import does not require the retired `worker.sock`, and
telemetry publication does not restart the VM, CLI, or egress. Keep-mode rebuilds
retain the native identity/settings/queue/egress files and their ownership;
explicit factory-reset/traits behavior remains a separate action.

Bootstrap status uses `telemetry_published`, `telemetry_applied`, and
`telemetry_error` instead of old sidecar-reload/activity-touch indicators. The
obsolete Go-only inventory command is removed; alignment uses the native
publication action rather than broad process kills or automatic enablement.

A rollout requires matching Node, Go OAuth worker, Rust and cli-node payloads.
The worker must emit actual OAuth-attempt notifications. Old native binaries
without the capability fail readiness explicitly; there is no shim or Go restart
fallback. OAuth exchange is the one exception: when the target kernel does not
report `vm_telemetry`, the controller's `kin-oauth-auth` exchanges through the
slot's bound SOCKS5 instead of restarting that kernel (see OAUTH.md).
Source/build verification is not payload publication or production deployment.
Use the private local build instructions before any separately authorized
rollout, preserve VM storage/identity/credentials, and do not replace unrelated
working-tree changes.

## Safe status and audit

Kernel health exposes `vm_telemetry`, `telemetry_ready` and native `telemetry`.
Public projections contain only enable state, waiting/upload/error status,
pending count, last upload time and a bounded error code. A running process is
not evidence of upload; unreachable state is unknown, not disabled.

`run/telemetry-upload.log` keeps at most 40 JSON lines containing only `at`,
`ok`, `events` and sanitized `error`. No payload or identity is logged.
`GET /api/panel/vms/:id/seed-settings?debug=1` exposes those safe lines as
`telemetry_log`; without debug the field is omitted. Local reads reject links
and non-regular files; remote reads use the placement adapter and the panel
reprojects allowed fields rather than trusting remote JSON.
An unavailable audit source additionally returns
`telemetry_log_error: "telemetry_log_unavailable"`; the UI shows a read error,
not an empty successful history. Seed and global telemetry views share the
validated counts-only decoder and keep desired consent separate from observed
native state; neither invents a running-process observation from the policy.

## Verification limits

Synthetic local Docker, SOCKS/TLS and SSH2/SFTP scenarios validate their named
paths only. They are not real-account/provider or production-node acceptance.
Real KVM requires an accessible `/dev/kvm`; Docker/TCG, cross-compilation and
static guest paths cannot certify KVM execution. Keep environment blockers and
unexecuted criteria explicit in the task verification record.

The separately authorized private `1.4.026` deployment verified five local and
four remote existing Claude Docker slots in place, including mapped native
bytes, container identity and disabled/ready/pending-zero state. All ten Claude
opt-out policies and twelve VM scheduling policies retained their semantics;
eleven legacy Anthropic Go senders were retired. OpenAI container/native guest
files and Analytics configuration were unchanged; replacement of host OpenAI
kernel processes through their normal Node service lifecycle was explicitly
authorized. The official live gate passed over operator-side IPv4, including a
real `200 pong` conversation. No public payload Release was published, no
production telemetry was enabled, and neither KVM nor enabled upstream telemetry
was certified by that rollout.

The later seed/control alignment is an additional source change, not a claim
that the earlier private deployment contains it. Its isolated real Docker plus
HTTP smoke verified native acknowledgment without a container restart, custom
environment preservation and explicit deletion, opt-out through initialization,
stable identity, stopped publication without application, and unavailable-node
failure without controller-mirror fallback. Browser runs reproduced the old
polling-reset/failed-draft defects and verified repaired seed and bulk telemetry
flows at desktop and 390px widths. A real pinned loopback SSH/SFTP smoke verified
node-owned reads, four-file publication with atomic per-file writes, seed-only
isolation, refusal to claim success with a missing required file, and preservation
of node machine ID, OAuth config, internal token, and credentials. No production
account or telemetry switch was touched; real KVM and successful production-node
publication remain separate verification boundaries.
