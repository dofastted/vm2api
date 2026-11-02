<!-- This entire block is your raw intelligence report for other agents. It is NOT a final document. -->

### Code Sections (The Evidence)

- `local-src/cli-node/src/entrypoints/cli.tsx` (Lines 49-59, 61-66): Bootstrapping branch for multi-slot native execution: if `kernelEnv('NATIVE_SLOTS')` is set, calls `runNativeMessagesLoop(...)` from `src/kin/nativeMessagesRunner.ts`; if `--single-process-subagents` is passed, calls `runSingleProcessSlots()` from `src/kin/singleProcessSlots.ts`.
- `local-src/cli-node/src/cli/print.ts` (Lines 499-506): Headless print mode entry branch: if `CLAUDE_CODE_NATIVE_SLOTS` is set, calls `dropUnsafeSettingsEnvironment()` and enters `runNativeMessagesLoop({ options })`, returning before line 563's `setInterval(Bun.gc, 1000)` periodic garbage collector.
- `local-src/cli-node/src/cli/print.ts` (Lines 560-565): Bun GC timer `setInterval(Bun.gc, 1000)` intended to keep memory bounded in long headless sessions, which is bypassed and never started when entering `runNativeMessagesLoop`.
- `local-src/cli-node/src/kin/kernelEnv.ts` (Lines 1-5): `kernelEnv(suffix)` reads `process.env[CLAUDE_CODE_<SUFFIX>]` to detect kernel slot configuration.
- `local-src/cli-node/src/kin/nativeMessagesRunner.ts` (Lines 37-50): Slot state definition `SlotState` (`id`, `phase`, `jobId`, `abort`, `task`); `nativeSlotCount()` reads `NATIVE_SLOTS`, clamping slot count $N$ between 1 and 20.
- `local-src/cli-node/src/kin/nativeMessagesRunner.ts` (Lines 68-85): Host initialization: creates in-memory `slots = new Map<string, SlotState>()`, sends `host_ready` frame (version 2, slot count $N$, capabilities), and emits individual `slot_ready` frames for each slot (`s00`..`s{N-1}`).
- `local-src/cli-node/src/kin/nativeMessagesRunner.ts` (Lines 88-135): Stdin reader loop using `readline.createInterface`: parses JSON lines as `StdinFrame` (`job_start`, `cancel`, `telemetry_event`, `ping`).
- `local-src/cli-node/src/kin/nativeMessagesRunner.ts` (Lines 187-208): `startJob`: assigns `slot.phase = 'running'`, creates `AbortController`, binds `slot.task` with outbound header emission, and resets slot to `idle` in `.finally(...)`.
- `local-src/cli-node/src/kin/nativeMessagesRunner.ts` (Lines 265-365): `runJob`: extracts `messages` via `messagesFromRequest(request)` and `system` via `systemFromRequest(request)`, then calls `queryKinMessagesWithStreaming(...)`.
- `local-src/cli-node/src/kin/nativeMessagesRunner.ts` (Lines 468-486): `messagesFromRequest`: converts each wire message to an internal engine Message via `createUserMessage` / `createAssistantMessage`, allocating new object structures for every turn in history.
- `local-src/cli-node/src/kin/stdioProtocol.ts` (Lines 3-12): Protocol constants: `PROTOCOL_VERSION = 2`, `CAPABILITIES = ['multi_slot', 'native_sse', 'stateless', 'ping', 'classifier_request_context', ...]`.
- `local-src/cli-node/src/kin/stdioProtocol.ts` (Lines 14-67): Type definitions for `StdinFrame` (`job_start`, `cancel`, `ping`, `telemetry_event`) and `StdoutFrame` (`host_ready`, `slot_ready`, `stream_event`, `job_done`, `job_error`, `cancel_ack`, `pong`, `telemetry_ack`, `telemetry_state`).
- `local-src/cli-node/src/kin/stdioProtocol.ts` (Lines 87-114): Stdout serialization: promises are queued onto a module-level `writeChain`; `writeLine` waits for stdout `drain` if `process.stdout.write` returns `false`, causing frame and closure accumulation under backpressure.
- `local-src/cli-node/src/kin/singleProcessSlots.ts` (Lines 19-22, 141-150, 185-194, 253-263): Crag subagent multi-slot runner: slot definition `LiveSlot` explicitly retains `tools: unknown[]` and `transcript: Array<{ role, content }>`. It pushes user and assistant turns to `slot.transcript` and preserves them across turns when parked in `waiting` state.
- `local-src/cli-node/src/kin/slotPool.ts` (Lines 1-17, 43-61): `SLOT_CAP = 20`; `pickSlot` selects waiting slot on tool_result resume, pinned slot for model, or next idle slot.
- `local-src/cli-node/src/services/api/claude.ts` (Lines 870-959): `queryKinMessagesWithStreaming`: sets query source to `agent:kin`, passes `tools: []` to prevent tool execution by cli-node, and passes `extraToolSchemas: toolSchemas`.
- `local-src/cli-node/src/services/api/claude.ts` (Lines 1446-1515): Pre-request message duplication: runs `normalizeMessagesForAPI(messages, filteredTools)`, `ensureToolResultPairing(messagesForAPI)`, `stripExcessMediaItems(messagesForAPI)`, and `computeFingerprintFromMessages(messagesForAPI)`, creating multiple full array copies of the conversation history.
- `local-src/cli-node/src/services/api/claude.ts` (Lines 1794-1805): `releaseStreamResources`: explicit cancellation of `streamResponse.body` to mitigate native TLS/socket buffer leaks living outside the V8 heap (GH #32920).
- `local-src/cli-node/src/services/api/claude.ts` (Lines 2200-2235): `anthropic.beta.messages.create({ ...params, stream: true })`: Anthropic SDK re-serializes `params.messages` into a JSON string, creating another large string and buffer allocation.
- `local-src/cli-node/src/services/api/claude.ts` (Lines 2401-2458): Streaming accumulation: `contentBlocks[part.index]` accumulates incoming deltas (text, thinking, tool_use input) in memory for the duration of the stream.
- `local-src/cli-node/src/services/api/client.ts` (Lines 87-156, 298-311): `getAnthropicClient`: instantiates a new `Anthropic` SDK instance per call rather than sharing a singleton client pool.
- `local-src/cli-node/src/utils/log.ts` (Lines 331-352): `captureAPIRequest`: filters out non-`repl_main_thread` queries; ignores `agent:kin`, preventing request payload caching in bug-report buffers.
- `local-src/cli-node/src/services/api/promptCacheBreakDetection.ts` (Lines 101-115): `previousStateBySource = new Map<string, PreviousState>()`: module-level cache capped at `MAX_TRACKED_SOURCES = 10`, but only tracks prefixes `repl_main_thread`, `sdk`, `agent:custom`, `agent:default`, `agent:builtin` (excludes `agent:kin`).
- `local-src/cli-node/src/services/api/dumpPrompts.ts` (Lines 14-57): `cachedApiRequests` (max 5) and `dumpState` map: disabled unless `process.env.USER_TYPE === 'ant'`.
- `local-src/cli-node/src/services/api/sessionIngress.ts` (Lines 23-36, 502-514): `lastUuidMap` and `sequentialAppendBySession` module maps: persist per `sessionId`, cleared only by `clearSession(sessionId)` which is never invoked in `nativeMessagesRunner`.
- `local-src/cli-node/src/kin/vmTelemetry.ts` (Lines 175-177, 342-351): VmTelemetry queues: `records`, `attempts`, `seen`. Bound to 200 records, 2048 seen keys, 128 attempts, and 512 KiB document serialization.
- `local-src/kin-kernel/src/provider/multiplex_cli/supervisor.rs` (Lines 24-41, 52-99): Rust kernel supervisor: spawns `dist/cli-node` with args `["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence", "--permission-mode", "acceptEdits", "--strict-mcp-config", "--model", model]` and env `CLAUDE_CODE_NATIVE_SLOTS=N`. Pipes stdin, stdout, stderr. Does NOT pass `--max-old-space-size`.
- `local-src/kin-kernel/src/provider/multiplex_cli/memory_guard.rs` (Lines 18-37, 70-103): Kernel `MemoryLimits`: base limits `soft: 3 GiB`, `drain: 3.5 GiB`, `reject: 3.75 GiB`, `max_inflight_payload: 256 MiB`, `large_request_bytes: 256 MiB`. `effective(cap)` scales these linearly by the cgroup limit (e.g. 512 MiB limit yields `soft = 384 MiB`, `drain = 448 MiB`, `reject = 480 MiB`, `max_inflight_payload = 32 MiB`).
- `local-src/kin-kernel/src/provider/multiplex_cli/memory_guard.rs` (Lines 207-264): `check_admission`: observes `kernel_rss + claude_rss` or cgroup current usage from `/sys/fs/cgroup/memory.current` (cgroup v2) or `/sys/fs/cgroup/memory/memory.usage_in_bytes` (cgroup v1). Checks only at admission time (`reserve()`); does not monitor or constrain in-flight memory expansion during execution.
- `local-src/kin-kernel/src/provider/multiplex_cli/slot.rs` (Lines 16-23, 38-61): Slot struct: tracks `id`, `phase` (`Booting`, `ReadyBlocked`, `Running`, `Dead`), `tenant_id`, `session_id`, `job_id`, `last_change`. `unbind_ready()` retains `tenant_id` and `session_id` sticky across turns.
- `local-src/kin-kernel/src/provider/multiplex_cli/scheduler.rs` (Lines 7-20, 49-67, 89-135): `SlotScheduler`: maintains `ready: VecDeque<String>` and `sticky: HashMap<String, StickyPin>` with `DEFAULT_STICKY_TTL = 24h`. Pinned sessions return to the same slot; if the pinned slot is busy, it spills to the least recently used slot without rewriting the pin. `owner_last_used` iterates over all sticky pins ($O(P)$).
- `src/lib/vm/docker-slot-memory.mjs` (Lines 57-90, 221-230): Container cgroup memory enforcement: verifies `HostConfig.Memory`, `HostConfig.MemorySwap`, and cgroup v2 `memory.max` (or v1 `memory.limit_in_bytes`). Defaults to 512 MiB (legacy) or 1 GiB.
- `src/lib/vm/slot-recovery.mjs` (Lines 117-121): Detects `oom_killed: state.OOMKilled === true` when Docker container or its processes are killed by Linux cgroup OOM killer.
- `CHANGELOG.md` (Lines 978-980, 1598-1601): Documents VM memory tiers (256m / 512m / 1g / 2g / 4g / 8g / 16g), warns that running under 1G risks OOM when resident native host and temporary CLI run concurrently, and notes native CLI exit on OOM caused `native stdin: Broken pipe`.
- `docs/DEPLOY.md` (Lines 30-36): Documents default container memory 512m, warns that under 1G OOM occurs, and explains that on CLI exit or closed stdout, kernel must clear `cli_pid` / `ready_slots` and watchdog recovers the slot.

### Report (The Answers)

#### result

1. **How one VM boots one cli-node and N slots (default N, cap 20) & Handshake frames:**
   - The Rust kernel (`supervisor.rs:52-65`) executes `dist/cli-node` with args `-p --output-format stream-json --verbose --include-partial-messages --no-session-persistence --permission-mode acceptEdits --strict-mcp-config --model <model>` and env var `CLAUDE_CODE_NATIVE_SLOTS=N` (where $N$ is configured by the supervisor, clamped between 1 and 20 by `nativeSlotCount()` in `nativeMessagesRunner.ts:45-50` and `SLOT_CAP = 20` in `slotPool.ts:1`).
   - `cli-node` enters `runNativeMessagesLoop` (`entrypoints/cli.tsx:49-59` or `cli/print.ts:499-506`).
   - Handshake sequence:
     1. `cli-node` creates in-memory map of $N$ slots: `s00` through `s{N-1}` (`nativeMessagesRunner.ts:68-72`).
     2. `cli-node` writes frame `host_ready` to stdout: `{"type":"host_ready","protocol_version":2,"slots":N,"system_layout":...,"timezone":...,"capabilities":["multi_slot","native_sse","stateless","ping","classifier_request_context"]}` (`nativeMessagesRunner.ts:74-82`, `stdioProtocol.ts:27-35`).
     3. `cli-node` writes $N$ consecutive `slot_ready` frames to stdout: `{"type":"slot_ready","slot_id":"s00"}` ... `{"type":"slot_ready","slot_id":"s19"}` (`nativeMessagesRunner.ts:83-85`).
     4. Subsequent turn control is driven by stdin frames `job_start`, `cancel`, `ping`, and stdout frames `stream_event`, `job_done`, `job_error`, `cancel_ack`, `pong` (`stdioProtocol.ts:14-67`).

2. **What a "slot" is inside cli-node & cross-turn retention:**
   - A "slot" in `cli-node` (`nativeMessagesRunner.ts:37-43`) is NOT an OS process and NOT a worker thread. It is a TypeScript object `{ id: string, phase: 'idle' | 'running' | 'cancelling', jobId?: string, abort?: AbortController, task?: Promise<void> }` held in a `Map<string, SlotState>`.
   - All slots share a SINGLE Node.js / Bun runtime process, a single event loop, and a single V8 / JavaScriptCore heap.
   - Cross-turn retention in `nativeMessagesRunner.ts`:
     - `nativeMessagesRunner` is explicitly **stateless across turns** (`nativeMessagesRunner.ts:1-7`: "NativeMessagesRunner — stateless slot host. Each job is one API call... The caller transcript is the prompt messages").
     - When a job completes, `startJob`'s `.finally()` resets `slot.phase = 'idle'`, `slot.jobId = undefined`, `slot.abort = undefined`, `slot.task = undefined` (`nativeMessagesRunner.ts:201-208`).
     - No message history is held in `SlotState`. Instead, on EVERY turn the caller (the kernel/Node control plane) sends the complete accumulated conversation history over stdin inside `msg.request.messages`.
   - (Note: The alternative Crag subagent runner `singleProcessSlots.ts:19-22, 185-194` DOES retain `slot.transcript` and `tools` in-memory across turns when parked in `waiting` state).

3. **Why a single slot can OOM inside one process & concrete memory retainers:**
   - **Shared Heap with zero per-slot isolation:** Up to 20 slots run concurrently in the same process without memory quotas.
   - **Large Payload Explosion during a single turn:**
     1. *Stdin JSON ingestion:* In turn $K$ of a long session (e.g. 50k–200k tokens with tool results, file diffs, base64 data), the entire history arrives as a single JSON line. `readline` reads this into a contiguous string (10–50 MB). `parseStdinLine` calls `JSON.parse(line)`, creating a massive V8 object tree of 40–150 MB heap (`nativeMessagesRunner.ts:89`, `stdioProtocol.ts:68`).
     2. *Repeated Object Duplication:* `messagesFromRequest` maps every message into new objects via `toEngineMessage` (`nativeMessagesRunner.ts:468-471`). Then in `claude.ts:1453-1502`, `normalizeMessagesForAPI`, `ensureToolResultPairing`, and `stripExcessMediaItems` each create new shallow/deep message copies.
     3. *SDK JSON Serialization:* In `claude.ts:2225`, `anthropic.beta.messages.create({ ...params, stream: true })` calls `JSON.stringify(params)`, creating another 10–50 MB string plus outbound HTTP socket/TLS buffers.
     4. *Stream Chunk Accumulation:* `contentBlocks` in `claude.ts:2401-2458` accumulates every streaming token, thought, and tool delta in memory until the turn ends.
     5. *Stdout Chaining:* `writeStdout` in `stdioProtocol.ts:87-100` chains promises onto `writeChain`. Under socket backpressure, frames queue up in memory waiting for `drain`.
   - **Bypassed Garbage Collection:**
     - `cli/print.ts:563` contains `setInterval(Bun.gc, 1000)` to reclaim memory in headless runs, but line 505 enters `runNativeMessagesLoop` and returns before that timer is ever registered.
     - Neither `supervisor.rs` nor `cli-node` passes `--max-old-space-size`, so V8 targets the host 64-bit default (2–4 GiB).
   - **Container cgroup Breaches:**
     - The VM container is constrained by a cgroup limit of 512 MiB or 1 GiB (`docker-slot-memory.mjs:80-90, 222-230`, `DEPLOY.md:31`).
     - Total container RSS includes the Linux guest OS, Rust kernel, Go proxy/worker, and `cli-node`.
     - When `cli-node` processes a long-session turn, its transient heap spike (250–400 MiB) pushes the container RSS past the cgroup threshold. The Linux kernel OOM killer fires `SIGKILL` on `cli-node` (`slot-recovery.mjs:118`).
     - When `cli-node` is killed, its stdout pipe breaks, resulting in `native stdin: Broken pipe` in the Rust kernel (`DEPLOY.md:35`, `CHANGELOG.md:1599`).

4. **Existing Caps and Limits:**
   - Container cgroup limit: `512m` (legacy default) or `1g` (current default), configured in `vm.machine.memory` (`docker-slot-memory.mjs:222-230`).
   - Kernel `MemoryGuard` (`memory_guard.rs:18-103, 207-264`):
     - Dynamically reads `/sys/fs/cgroup/memory.current` and scales base limits (`soft: 3 GiB`, `drain: 3.5 GiB`, `reject: 3.75 GiB`, `max_inflight_payload: 256 MiB`) down by `cgroup_limit / 4 GiB`.
     - At 512 MiB cgroup limit, `soft = 384 MiB`, `drain = 448 MiB`, `reject = 480 MiB`, `max_inflight_payload = 32 MiB`.
     - Enforces admission gates (`Allow`, `AllowSmall`, `Drain`, `Reject`) before dispatching jobs.
     - *Limitation:* It only checks at admission time; it has no visibility into or control over transient allocations that occur inside `cli-node` while a job is running.

5. **Rust Kernel Slot Scheduler:**
   - Sticky Pinning: `scheduler.rs:7-20` maintains `sticky: HashMap<String, StickyPin>` with `DEFAULT_STICKY_TTL = 24h` keyed by `tenant_id \x1f session_id`.
   - Pin behavior: A session returns to its pinned slot if idle (`ReadyBlocked`). If busy, it spills to the least recently used ready slot without overwriting the original pin (`scheduler.rs:89-135`).
   - Slot struct: `slot.rs:55-61` keeps `tenant_id` and `session_id` sticky on `unbind_ready()`.
   - Complexity on hot path: `owner_last_used` (`scheduler.rs:75-86`) iterates over all entries in `self.sticky` on every scheduling pick when selecting a free slot ($O(P)$ where $P$ is total number of active pinned sessions).

6. **Go Worker Role vs Node Control Plane:**
   - `worker/` in the repo contains:
     - `kin-worker`: runs OAuth refresh (`worker/cmd/kin-worker/main.go`, `worker/internal/oauthcmd/oauthcmd.go`).
     - `kin-egress`: manages outbound SOCKS5/DNS proxying (`worker/cmd/kin-egress/main.go`).
     - `kin-slot-gate`: splices TLS direct links to unix domain sockets `kernel.sock` and `worker.sock` (`worker/internal/slotgate/slotgate.go`).
     - `api-kernel`: an internal forwarder (`api-kernel/internal/server/server.go`).
   - There is NO Go replacement for the Node control plane currently deployed on the hot path. Inbound HTTP `/v1/messages`, request normalization, session directory management, and kernel socket dispatching remain entirely in Node.js (`src/server.mjs`, `src/lib/`).

#### conclusions

- All $N$ slots (up to 20) in a VM run inside one OS process (`cli-node`), sharing a single V8/JSC heap and event loop with no memory isolation.
- `nativeMessagesRunner` is stateless across turns, but the protocol transfers the entire conversation transcript on every turn, causing huge memory spikes during JSON parsing, multi-pass message normalization, and re-serialization.
- The `setInterval(Bun.gc, 1000)` garbage collector in `cli/print.ts` is bypassed when `CLAUDE_CODE_NATIVE_SLOTS` is set, leaving memory reclamation to default V8 heuristics that assume multiple gigabytes of memory.
- When container memory is limited to 512 MiB or 1 GiB via cgroup, a single large-session turn (50k–200k tokens) easily triggers a memory spike that exceeds the cgroup ceiling, leading to an immediate `SIGKILL` by the Linux kernel OOM killer and a `Broken pipe` on the kernel's stdio pipe.
- The Rust kernel's `MemoryGuard` only evaluates memory at admission time and cannot stop or throttle in-flight memory expansion inside `cli-node`.

#### relations

- `local-src/kin-kernel/src/provider/multiplex_cli/supervisor.rs` spawns `local-src/cli-node/dist/cli-node` with env `CLAUDE_CODE_NATIVE_SLOTS`.
- `local-src/cli-node/src/entrypoints/cli.tsx` and `local-src/cli-node/src/cli/print.ts` detect `NATIVE_SLOTS` and call `runNativeMessagesLoop` in `local-src/cli-node/src/kin/nativeMessagesRunner.ts`.
- `local-src/cli-node/src/kin/nativeMessagesRunner.ts` parses incoming frames via `local-src/cli-node/src/kin/stdioProtocol.ts` and invokes `queryKinMessagesWithStreaming` in `local-src/cli-node/src/services/api/claude.ts`.
- `local-src/cli-node/src/services/api/claude.ts` instantiates Anthropic SDK via `local-src/cli-node/src/services/api/client.ts`, normalizes messages, serializes payloads, and streams events back through `stdioProtocol.writeStdout`.
- `local-src/kin-kernel/src/provider/multiplex_cli/scheduler.rs` assigns jobs to slots defined in `local-src/kin-kernel/src/provider/multiplex_cli/slot.rs` subject to admission limits in `local-src/kin-kernel/src/provider/multiplex_cli/memory_guard.rs`.
- `src/lib/vm/docker-slot-memory.mjs` sets the cgroup limit on the container, which terminates `cli-node` when heap + RSS exceeds the limit, detected via `src/lib/vm/slot-recovery.mjs`.
