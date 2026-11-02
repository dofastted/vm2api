### Code Sections (The Evidence)

- `src/server.mjs:1152-1154` (`server.mjs` HTTP request routing): Routes `POST /v1/messages` and `POST /messages` to `handleProtocol(req, res, 'anthropic.messages', p)`.
- `src/lib/http/respond.mjs:18-64` (`collectBody`): Streams raw incoming request chunks into an array and concatenates them with `Buffer.concat(chunks)`.
- `src/lib/http/respond.mjs:66-82` (`readBody`): Decodes buffer to a UTF-8 string with `buf.toString('utf8')` and parses it into a JavaScript object with `JSON.parse(raw)`.
- `src/lib/protocol/handle-protocol.mjs:531-617` (`handleProtocol`): Entry function for `/v1/messages`; starts request timer, verifies authentication, calls `readBody`, stores parsed JSON in `logBag.inbound_body`, and summarizes input.
- `src/lib/protocol/handle-protocol.mjs:695-703` (`sanitizeInboundBody` & intercepts): Sanitizes incoming request body and executes pre-conversion rules.
- `src/lib/protocol/handle-protocol.mjs:907-912` (`toClaudeMessages`): Normalizes messages into Anthropic format.
- `src/lib/protocol/handle-protocol.mjs:951-1038` (`session and sticky resolution`): Resolves caller session, CRS identity, and queries sticky session persistence.
- `src/lib/pool/sticky-router.mjs:388-422` (`sessionPoolKeys` / `familyPoolKey`): Resolves routing keys for a session by querying SQLite `sticky_sessions`.
- `src/lib/db/repos/sticky-repo.mjs:25` (`StickyRepo.get`): Executes SQLite query `SELECT * FROM sticky_sessions WHERE key = ?`.
- `src/lib/protocol/handle-protocol.mjs:1075-1083` (`applyCrsUnofficialPersona`): Injects persona prompts and generates billing headers.
- `src/lib/protocol/handle-protocol.mjs:1334-1358` (`getFailoverRunner().run`): Passes request to `FailoverRunner` with retry budget and attempt callbacks.
- `src/lib/pool/failover-runner.mjs:550-583` (`FailoverRunner.run`): Enforces serialization per session by chaining promises in `this.sessionTails` and awaiting `waitForSessionTurn`.
- `src/lib/pool/failover-runner.mjs:585-649` (`FailoverRunner.runOnce`): Coordinates candidate selection, retries, and hop dispatch.
- `src/lib/pool/pool-scheduler.mjs:465-470` (`PoolScheduler.selectAndReserve`): Dispatches candidate selection to `selectSeat` for seated sessions or `selectDirect` for seatless/probes.
- `src/lib/pool/pool-scheduler.mjs:645-853` (`PoolScheduler.selectSeat`): Evaluates candidate VMs and seats; enqueues ticket in `SeatPlanner` if VM is at concurrency or seat capacity.
- `src/lib/pool/pool-scheduler.mjs:1031-1085` (`PoolScheduler.eligibleCandidates`): Filters usable VMs and retrieves runtime snapshots via a single SQLite query `this.runtimeRepo.schedulingSnapshot(...)`.
- `src/lib/pool/seat-planner.mjs:78-107` (`SeatPlanner` state): Holds in-memory mappings `this.seats`, `this.byVm`, `this.vmQueues`, and `this.globalQueue`.
- `src/lib/pool/seat-planner.mjs:335-347` (`SeatPlanner.enqueue`): Queues a request ticket by VM or globally when all capacity slots are occupied.
- `src/lib/pool/seat-planner.mjs:420-456` (`SeatPlanner.pump` / `pumpOne`): Processes dirty queues to grant admitted tickets when a slot becomes free.
- `src/lib/protocol/handle-protocol.mjs:1437` (`applyAttempt` deep clone): Clones caller body with `structuredClone(personaIn)` before rendering slot-specific persona prompts.
- `src/lib/protocol/handle-protocol.mjs:1452-1463` (`prepareCliHopBody`): Prepares final CLI hop body, preserving wire system and thinking blocks.
- `src/lib/protocol/handle-protocol.mjs:1591-1701` (`callAttempt` streaming branch): Calls `dispatchStreamInference` and wires down-stream SSE transformations in `onEvent`.
- `src/lib/transport/kernel-router.mjs:67-80` (`waitForReadySlot`): Polls `rustKernelHealth` every 200ms up to `slot_wait_ms` (default 30s) when Rust kernel reports no free slots.
- `src/lib/transport/kernel-router.mjs:224-306` (`runHop`): Enforces Rust engine (`resolveHopEngine`), checks health/readiness, and dispatches to `streamRustKernel`.
- `src/lib/transport/rust-kernel-client.mjs:8-17` (`rustKernelPaths`): Resolves `socketPath` to `run/kernel.sock` or `vms/<vmId>/run/kernel.sock`.
- `src/lib/transport/rust-kernel-client.mjs:47-49` (`streamRustKernel`): Delegates to `streamGoWorker` with `withRustKernelExec(opts.exec)`.
- `src/lib/transport/go-worker-client.mjs:83-158` (`workerRequest`): Serializes envelope with `JSON.stringify(body)`, allocates buffer with `Buffer.from(...)`, and writes HTTP request over Unix domain socket using Node `http.request`.
- `src/lib/transport/go-worker-client.mjs:408-444` (`finalizeWorkerPayload`): Builds outbound headers and seals Claude Code headers via `sealClaudeCodeCch`.
- `src/lib/transport/go-worker-client.mjs:617-753` (`streamGoWorker` envelope & dispatch): Orchestrates request envelope creation and sends request to socket.
- `src/lib/transport/go-worker-client.mjs:843-911` (`streamGoWorker` chunk loop): Consumes response stream over Unix socket, performs string concatenation, parses lines, runs `applyClaudeSSELineToMessage`, and executes `JSON.parse` on SSE data events.
- `src/lib/protocol/handle-protocol.mjs:1665-1694` (`onEvent` SSE stream handler): Rewrites tool names, parses and recalculates usage via `hidePersonaUsageInSseLine`, and flushes transformed lines to client via `res.write`.
- `docs/INFERENCE.md:1-42` (Inference architecture documentation): Confirms that only `rust cli-hop` is active; Go HTTP forwarder is removed.
- `worker/cmd/kin-worker/main.go:10-16` (`kin-worker` entrypoint): Implements only the `oauth` CLI command via `oauthcmd.Run`.
- `worker/internal/slotgate/slotgate.go:1-120` (`kin-slot-gate` implementation): Splicing TCP/TLS listener that proxies connections directly to local Unix domain sockets (`kernel.sock` or `worker.sock`) for remote cluster nodes.
- `worker/internal/egress/server.go:1-50` (`kin-egress` implementation): Transparent TCP redirect / SOCKS5 proxy and DNS forwarder for VM outbound network traffic.
- `api-kernel/cmd/kin-api-kernel/main.go:19-53` (`kin-api-kernel` entrypoint): HTTP forwarder on a Unix socket, used exclusively for direct external API key inference (`inferenceBackend === 'api'`).
- `local-src/kin-kernel/src/provider/multiplex_cli/mod.rs:71-155` (`MultiplexConfig` & `Runtime`): Manages one CLI child process with up to 20 slots (`s00`..`s19`) communicating over stdin/stdout.
- `local-src/kin-kernel/src/provider/multiplex_cli/native_protocol.rs:14-107` (Protocol frames): Defines stdin commands (`job_start`, `cancel`, `ping`) and stdout frames (`init`, `slot_ready`, `stream_event`, `job_done`, `job_error`, `cancel_ack`).
- `local-src/kin-kernel/src/provider/multiplex_cli/scheduler.rs:14-105` (`SlotScheduler`): Kernel slot scheduler maintaining `ready` queue of slot IDs and `sticky` map of session-to-slot pins.
- `local-src/kin-kernel/src/provider/multiplex_cli/memory_guard.rs:18-103` (`MemoryLimits` & `effective` scaling): Evaluates container memory limits, scaling soft (3 GiB), drain (3.5 GiB), and reject (3.75 GiB) limits relative to cgroup limits.
- `local-src/kin-kernel/src/provider/multiplex_cli/memory_guard.rs:207-264` (`MemoryGuard.snapshot` & `check_admission`): Samples kernel RSS, Claude process RSS, and cgroup usage to classify admission into `Allow`, `AllowSmall`, `Drain`, or `Reject`.
- `local-src/cli-node/src/kin/nativeMessagesRunner.ts:67-86` (`runNativeMessagesLoop`): Boots N slots in an in-memory `Map<string, SlotState>`, writes `init`, and emits `slot_ready` for each slot.
- `local-src/cli-node/src/kin/nativeMessagesRunner.ts:137-209` (`startJob`): Allocates turn execution inside the single CLI process, setting `slot.phase = 'running'` and invoking `queryKinMessagesWithStreaming`.
- `local-src/cli-node/src/entrypoints/cli.tsx:12-14` (CLI entry options): Sets `process.env.NODE_OPTIONS = '--max-old-space-size=8192'` (8 GiB V8 heap ceiling).
- `docs/DEPLOY.md:31` (Container resource defaults): Documents slot container default memory ceiling of `512m` (or `1g`).

---

### Report (The Answers)

#### result

##### 1. Full Node Control-Plane Hot Path from `POST /v1/messages` to Rust Kernel Unix Socket

The exact call chain from incoming HTTP request to the Rust kernel Unix domain socket:
1. `src/server.mjs:1152` (`server.mjs`): HTTP request router detects `POST /v1/messages` and calls `handleProtocol(req, res, 'anthropic.messages', p)`.
2. `src/lib/protocol/handle-protocol.mjs:531` (`handleProtocol`):
   - Invokes `requireAuth(req, res)` (line 583).
   - Calls `readBody(req, limit)` (line 592).
   - Saves parsed body to `logBag.inbound_body = inbound` (line 609).
   - Calls `sanitizeInboundBody` (line 698) and `applyIntercept` (lines 702, 919).
   - Calls `toClaudeMessages` (line 907).
   - Resolves session identifiers via `extractCallerSession` (line 951), `resolveInboundIdentity` (line 973), and `stickyRouter.sessionPoolKeys` (line 1005).
   - Renders persona templates via `applyCrsUnofficialPersona` (line 1075).
   - Extracts canonical payload via `officialMessagesBody` (line 1236).
   - Calls `getFailoverRunner().run(...)` (line 1334).
3. `src/lib/pool/failover-runner.mjs:550` (`FailoverRunner.run`):
   - Chains session promise in `this.sessionTails` and awaits `waitForSessionTurn` (line 561).
   - Invokes `runOnce` (line 585).
   - Calls `this.scheduler.selectAndReserve(...)` (line 650+).
4. `src/lib/pool/pool-scheduler.mjs:465` (`PoolScheduler.selectAndReserve`):
   - Directs to `selectSeat` (line 645) or `selectDirect` (line 473).
   - Queries candidate eligibility and runtime state via `eligibleCandidates` (line 1031) using SQLite snapshot query.
   - If capacity is exhausted, enqueues request ticket in `SeatPlanner` (line 780).
5. `src/lib/protocol/handle-protocol.mjs:1358` (`applyAttempt` in `handleProtocol`):
   - Executes deep clone `structuredClone(personaIn)` (line 1437).
   - Re-renders slot-specific persona via `applyCrsUnofficialPersona` (line 1437).
   - Invokes `prepareCliHopBody` (line 1452), `ensureBillingAttribution` (line 1465), and `materializeRemoteImageSources` (line 1473).
   - Returns `{ body: hopBody, meta: ... }`.
6. `src/lib/protocol/handle-protocol.mjs:1591` (`callAttempt` in `handleProtocol`):
   - Invokes `dispatchStreamInference(...)` (line 1640).
7. `src/lib/transport/kernel-router.mjs:224` (`runHop`):
   - Runs `prepareRust(opts.exec, ...)` (line 230), which checks health via `rustKernelHealth` (line 197) and waits for available slot via `waitForReadySlot` (line 213) if busy.
   - Dispatches to `streamRustKernel(opts)` (line 267).
8. `src/lib/transport/rust-kernel-client.mjs:47` (`streamRustKernel`):
   - Resolves socket path (`run/kernel.sock` or `vms/<vmId>/run/kernel.sock`) via `withRustKernelExec` (line 19).
   - Invokes `streamGoWorker` (line 48).
9. `src/lib/transport/go-worker-client.mjs:617` (`streamGoWorker`):
   - Calls `workerEnvelope(...)` (line 728) and `finalizeWorkerPayload(...)` (line 408).
   - Dispatches HTTP POST to Unix socket via `workerRequest` (line 744).
10. `src/lib/transport/go-worker-client.mjs:83` (`workerRequest`):
    - Serializes body with `JSON.stringify(body)` (line 102).
    - Allocates payload buffer with `Buffer.from(...)` (line 102).
    - Opens Unix domain socket connection with Node `http.request({ socketPath, path: '/internal/v1/messages', method: 'POST', ... })` (line 139).
    - Writes payload buffer and ends socket write stream: `req.write(payload); req.end()` (lines 155-156).

##### 2. Allocations, Copies, and JSON Operations on the Inbound Path

For every single incoming request, Node makes at least 6 copies/transformations of the full payload:
1. `src/lib/http/respond.mjs:51`: `Buffer.concat(chunks)` allocates a contiguous buffer across all received TCP stream chunks.
2. `src/lib/http/respond.mjs:68`: `buf.toString('utf8')` allocates a full JavaScript V8 string of the entire payload.
3. `src/lib/http/respond.mjs:71`: `JSON.parse(raw)` builds a complete JavaScript object tree of all messages, system instructions, and tool definitions.
4. `src/lib/protocol/handle-protocol.mjs:1437`: `structuredClone(personaIn)` deep clones the entire AST object graph in V8 heap memory before rendering persona templates.
5. `src/lib/transport/go-worker-client.mjs:102`: `JSON.stringify(body)` serializes the full envelope back into a single massive JSON string.
6. `src/lib/transport/go-worker-client.mjs:102`: `Buffer.from(...)` creates another contiguous binary buffer to write to `kernel.sock`.

In addition:
- `src/lib/protocol/handle-protocol.mjs:609`: `logBag.inbound_body = inbound` retains the entire parsed JSON object tree in memory for the duration of the request until `res.on('finish')`.
- `src/lib/protocol/handle-protocol.mjs:1322`: `logBag.outbound_body = envelope.body` retains the outbound body if capture is enabled.

##### 3. Scheduler Waits and Database Queries

Three distinct wait mechanisms exist on the Node control-plane hot path:
1. **Session Serialization Queue (`failover-runner.mjs:550-583`)**:
   `FailoverRunner.run` serializes concurrent turns for the same session key using an in-memory Promise chain in `this.sessionTails`. If a previous request for that session is in-flight, the incoming request waits via `waitForSessionTurn(previous, signal, session_queue_timeout_ms)`.
2. **Concurrency / Seat Queue (`pool-scheduler.mjs:780-830`, `seat-planner.mjs:335-347`)**:
   If the target VM has reached its maximum inflight request cap or seat capacity, `selectSeat` calls `this.planner.enqueue(ticket)` and asynchronously awaits ticket grant. When an in-flight request releases its seat, `SeatPlanner.pump` grants waiting tickets in FIFO arrival order.
3. **Rust Kernel Slot Wait Poll (`kernel-router.mjs:67-80, 213`)**:
   If the Rust kernel returns `ready_slots == 0`, `waitForReadySlot` enters a polling loop with `setTimeout(..., 200)` querying `rustKernelHealth` over the Unix socket until a slot becomes ready or `slot_wait_ms` (default 30s) expires.

Database Queries:
- `src/lib/pool/sticky-router.mjs:388-422` & `src/lib/db/repos/sticky-repo.mjs:25`: Executes `SELECT * FROM sticky_sessions WHERE key = ?` to resolve session affinities.
- `src/lib/pool/pool-scheduler.mjs:1063-1065` & `src/lib/db/repos/runtime-repo.mjs`: Executes a single batched SQLite query `schedulingSnapshot(...)` to fetch state and accounts for all candidate VMs.

##### 4. Is Node on the Token-Stream Hot Path?

**YES, Node is strictly and actively on the token-stream hot path.** It is not a passive TCP pipe or proxy.
Evidence:
- `src/lib/transport/go-worker-client.mjs:843-911` (`streamGoWorker`):
  - Iterates over raw chunks from `kernel.sock`: `for await (const chunk of response)`.
  - Appends chunk to string buffer: `buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)`.
  - Parses newlines: `while ((newline = buffer.indexOf('\n')) >= 0)`.
  - Feeds each line to `applyClaudeSSELineToMessage(line, assembler)`, incrementally reconstructing the entire assistant message in memory.
  - On every line starting with `data:`, extracts payload and runs `JSON.parse(dataBuf)` in `takeSseEvent()`.
  - Emits line via `emitLine(line)` -> `onEvent(line)`.
- `src/lib/protocol/handle-protocol.mjs:1665-1694` (`onEvent` callback):
  - Runs string regex substitution via `restoreToolNamesInSSELine(line, ...)`.
  - If usage masking is enabled (`personaHideTokens > 0`), executes `hidePersonaUsageInSseLine(line, ...)` which calls `JSON.parse` on the line, modifies `usage` fields, and calls `JSON.stringify`.
  - Tracks stream lifecycle with `streamTracker?.observe(line)`.
  - For `anthropic.messages`: writes SSE line downstream via `res.write(String(outbound) + '\n')`.
  - For OpenAI protocols (`openai.chat`, `openai.completions`, `openai.responses`): converts Claude SSE line to OpenAI format and writes `data: ${JSON.stringify(chunk)}\n\n`.

##### 5. Go Worker Role vs Node

The Go components in the repository do **not** serve as an alternative inference hop or proxy for `/v1/messages`:
- `docs/INFERENCE.md:4-28`:
  Documented design specifies that Go HTTP forwarding was permanently retired ("Go hop 服务端已删除", "公开仓只走 rust cli-hop").
- `worker/cmd/kin-worker/main.go:10-16`:
  `kin-worker` only exposes an `oauth` CLI subcommand (`oauthcmd.Run`), used for offline OAuth token refresh.
- `worker/cmd/kin-slot-gate/main.go:15-36` & `worker/internal/slotgate/slotgate.go:1-120`:
  `kin-slot-gate` is a TLS listener that splices TLS TCP connections to local Unix sockets (`run/kernel.sock` or `run/worker.sock`). It provides connection proxying across distributed physical nodes and performs no HTTP routing or message inspection.
- `worker/cmd/kin-egress/main.go:16-55` & `worker/internal/egress/server.go:1-50`:
  `kin-egress` is an egress proxy handling transparent TCP redirection, SOCKS5 proxying, and DNS overrides so VM containers can connect to upstream Anthropic endpoints.
- `api-kernel/cmd/kin-api-kernel/main.go:19-53` & `api-kernel/internal/server/server.go:39-118`:
  `kin-api-kernel` is an HTTP forwarding utility used exclusively when `inferenceBackend === 'api'` (direct API key requests). It does not manage slot processes or the Claude Code CLI.

Replacing Node with Go cannot be achieved simply by flipping to an existing Go worker. Node currently houses critical business and protocol logic: API key authentication, request intercepts, Anthropic/OpenAI bidirectional protocol conversion, dynamic CRS persona generation, cache breakpoint management, SQLite-backed sticky session planning, `SeatPlanner` concurrency queues, stream error remapping, keepalives, and administrative panel APIs.

##### 6. Why One `cli-node` Slot Frequently OOMs on Long Sessions

1. **Architecture of a Slot (`local-src/cli-node/src/kin/nativeMessagesRunner.ts:68-85`)**:
   Inside each VM, there is **only one** `cli-node` OS process. It hosts N slots (default up to 20) inside a single in-memory JavaScript map (`Map<string, SlotState>`). Slots are not separate OS processes or worker threads; they are concurrent asynchronous tasks sharing the exact same V8 heap and garbage collection cycle.
2. **V8 Heap vs Container Cgroup Limits**:
   - In `local-src/cli-node/src/entrypoints/cli.tsx:13`, `cli-node` launches with:
     `process.env.NODE_OPTIONS = '--max-old-space-size=8192'` (8 GiB heap ceiling).
   - However, in `docs/DEPLOY.md:31`, slot containers default to a cgroup memory ceiling of `512m` (or `1g`).
3. **Long Session Memory Retention**:
   - Each turn of a long conversation transmits the cumulative history: system prompt blocks, all previous user and assistant turns, tool definitions, tool results, and thinking blocks.
   - For a long session (e.g., 50k–150k tokens), parsing the large JSON body into V8 objects, building SDK request payloads, and buffering streaming response chunks allocates tens to hundreds of megabytes in `cli-node`.
   - When multiple slots within the same `cli-node` process handle turns concurrently, or when a single long session experiences sudden memory spikes from large tool outputs or thinking signatures, the single `cli-node` process RSS exceeds the `512m` cgroup limit.
   - As a result, the Linux kernel OOM killer terminates the `cli-node` process (`SIGKILL`), causing all 20 slots to drop simultaneously.
4. **Rust Kernel Guard Trip (`memory_guard.rs:70-103, 207-264`)**:
   Even if the process avoids the OS OOM killer, `kin-kernel`'s `MemoryGuard` tracks process RSS and cgroup memory against limits dynamically scaled by the container limit. When memory reaches `drain` or `reject` thresholds, it begins rejecting requests with `KernelError::Overloaded` (503).

---

#### conclusions

1. **Node Control-Plane Overhead**: On every `/v1/messages` request, Node executes 6 distinct buffer/string/object copies, multiple JSON serializations, and one deep clone (`structuredClone`).
2. **Node Stream Involvement**: Node is directly on the token-stream hot path, performing chunk accumulation, string splitting, incremental message assembly, and per-line `JSON.parse` operations.
3. **No Existing Go Drop-in Replacement**: Existing Go binaries (`kin-worker`, `kin-slot-gate`, `kin-egress`, `kin-api-kernel`) are specialized egress/proxy tools; there is no Go hop that implements the control-plane routing or slot interaction.
4. **Slot Definition & OOM Mechanism**: A slot inside `cli-node` is simply an async entry in an in-memory map within a single Node/Bun process hosting up to 20 slots. The process sets an 8 GiB V8 heap limit while running in a container with a default `512m` (or `1g`) cgroup memory ceiling. Large message histories in long sessions cause the process RSS to exceed the container cgroup limit, triggering the Linux OOM killer.

---

#### relations

- `src/server.mjs` delegates `/v1/messages` requests to `src/lib/protocol/handle-protocol.mjs`.
- `handle-protocol.mjs` invokes `readBody` in `src/lib/http/respond.mjs` and resolves session affinity via `src/lib/pool/sticky-router.mjs` (which accesses SQLite via `src/lib/db/repos/sticky-repo.mjs`).
- `handle-protocol.mjs` queues and coordinates attempts using `FailoverRunner` in `src/lib/pool/failover-runner.mjs`.
- `failover-runner.mjs` coordinates VM and slot reservation via `PoolScheduler` in `src/lib/pool/pool-scheduler.mjs` and `SeatPlanner` in `src/lib/pool/seat-planner.mjs`.
- `handle-protocol.mjs` routes downstream streaming requests through `kernel-router.mjs`, which delegates to `rust-kernel-client.mjs` and `go-worker-client.mjs`.
- `go-worker-client.mjs` connects via Node `http.request` to `kernel.sock`, which is served by Rust `kin-kernel`.
- `kin-kernel` communicates with `cli-node` over stdin/stdout using `native_protocol.rs`.
- `cli-node` runs `runNativeMessagesLoop` in `nativeMessagesRunner.ts`, hosting up to 20 slots in an in-memory map within a single process.
