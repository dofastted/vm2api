# HA request correlation and recovery prerequisites

## Implemented correlation

This increment only links normal Claude Messages requests in `kubernetes-ha`.
It never recovers, releases or bills an abandoned request. Standalone and singleton
Kubernetes keep nullable links and do not require the new wrapper.

The server generates a unique request ID independently of a caller's
`x-request-id`, admits the maintenance activity with that ID, and inside
`gate.run` calls:

```js
await withHaRequestContext({db, requestId, activity: gate}, callback)
// gate exposes {activityId, ownerId, epoch}
```

The wrapper verifies the actual admitted activity scope and persists
`ha_request_contexts` before entering AsyncLocalStorage. Protocol logs use this
request ID. No static foreign key references the private coordination schema.
Every new child locks the same open parent before taking its normal locks and
inserting its nullable `ha_request_id`:

| Child | Exact association |
| --- | --- |
| API key admission | Reservation ID, key/user IDs and original reservation owner; one per HA request. |
| Session turn | Original turn ID, session key, queue sequence and turn owner. |
| Execution admission | Original admission ID, VM/account IDs, seat generation and admission owner. |
| Request attempt | The request's attempt number and selected VM/account/model. |
| Execution job | Original node command ID, admission ID, attempt number and immutable node binding. |

The runner enters `withHaRequestAttempt(attemptNo, callback)` around the actual
attempt call. Multiple kernel hops retain separate command IDs under that
attempt. Job binding requires a matching parent, an existing attempt for the
same VM/account, and node binding before submission. Similar-looking
`request_id` values are not used to infer any association.

Parent-row locks precede device/account/VM, session, or key locks. Wrapper return
closes `accepting_children` and records `handler_returned_at`; it does not certify
that remote work ended. Local inherited callbacks and SQL operations racing a
closed parent cannot add children. Existing execution, key/user concurrency,
session and unknown claims remain held. Normal result completion and settlement
still use their existing APIs; no owner-wide release is introduced.

## Node prerequisites for a later recovery increment

At the inspected baseline, a failed downstream `response.Write` returns and closes
the kernel socket. The node must instead continue observing the original kernel
response after controller loss, without replaying a request. Only a verified
normal protocol terminal and original EOF may persist completed state.

A separate read-only command-status RPC must accept the original VM, captured
fence and command ID from PG. It must not require the dead controller's in-memory
ticket or current daemon runtime. Historical completed records remain queryable
after generation advancement. It must never return a fresh fence for relabeling.

Not-found is not proof of non-execution. A typed seal-not-started operation must
atomically and durably tombstone the original absent or undispatched command ID
under the node authority lock. Late prepare/forward then fails. If dispatch wins
the race, the node retains unknown/pending work or its eventual original terminal
receipt. No timeout or controller-disconnection TTL may clear it.

Before resolving abandoned children, PG recovery must close the exact parent to
stop new child binding, then enumerate the original committed command set. A new
recovery proof path may resolve uncertainty; the current ordinary release APIs
intentionally cannot clear an `uncertain_at` latch. Requests lacking the new
links, non-node executions and unresolved non-inference effects stay occupied.

## Minimum terminal receipt for billing

The node should atomically persist a bounded receipt with the original command
ID and fence, terminal/dispatched state, immutable receipt ID, actual model,
fixed stop reason, and an explicit usage-complete indication. Usage is a whitelist:
uncached input, output, cache-read, cache-creation and 5-minute/1-hour creation
counts, plus web-search count and supported speed/service-tier metadata. JSON and
SSE observation must merge the original protocol's usage without double counting.
Counts must survive JSON without precision loss. No response text, thinking,
tool arguments, headers or credentials are retained in that receipt.

PG additionally needs the request's billing policy snapshot: requested/resolved
model, group multiplier, cache TTL/requested speed, and the applicable unit prices
and price version/source. A version string without historical prices cannot
reconstruct a previous tariff. Node completion alone does not prove zero usage.

API-key settlement can reuse its reservation-row idempotency, but must bind the
chosen billable command/usage receipt explicitly. Existing behavior charges the
final request result; recovery must not silently sum every retried hop. Initially,
only an unambiguous single normal completion or an already persisted final-choice
record can be settled automatically. Missing usage, ambiguous multi-hop choice,
deleted-key handling or a failed SQL settlement requires a separate billing
resolution and cannot release reserved request quota as zero spend.

Finally, exact execution/seat release, session-turn release and completion of the
original private activity need proof-aware, idempotent transitions after all
linked work is resolved. A request completion cannot clear unrelated background
claims. Background producers need their own activity/task/child links; current
owner IDs and partly matching schedule strings are insufficient.
