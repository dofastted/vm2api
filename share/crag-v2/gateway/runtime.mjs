/**
 * Gateway-owned native worker runtime.
 *
 * Lifecycle
 * ---------
 * createRuntime() is synchronous. Children are spawned lazily (minProcs=0) as
 * `process.execPath claudePath --crag-worker` and must emit crag_ready with
 * required capabilities before any crag_request.
 *
 * Modes (never disguised):
 * - subagent-pool: exactly one CLI process; maxProcs logical slots share it.
 * - process: each slot is a real OS process; a finished turn retires that PID
 *   and may preheat a replacement up to minProcs. Continuations in continuous
 *   mode hold the same PID until tools complete.
 * - session-reset: reuse a PID only after crag_reset_done {clean:true}.
 *
 * Slot phases: idle → running → (waiting → running)* → idle|resetting|retiring
 *   waiting exists only when continuousToolLoop is true: the native ask stays
 *   alive and the next HTTP turn is crag_resume.
 *
 * continuousToolLoop=false still implements the client tool HTTP pattern:
 *   tool_use ends the HTTP turn, gateway sends crag_cancel, waits
 *   crag_cancelled, frees the slot, and keeps bounded continuation metadata
 *   (tool ids, principal, system/tools/model/history). A later verified
 *   tool_result starts a NEW crag_request with the full structured history.
 *   It never sends crag_resume and never pretends the ask survived.
 *
 * Matching: exact pending tool_use id set namespaced by principal +
 * system/tools/model/history. Ambiguous same-principal tool ids → 409, never
 * overwrite. Unknown/expired/mismatch → 400; replay/concurrent claim → 409.
 * Claim is synchronous (atomic in this process). Client abort cancels a
 * running turn; a completed tool-wait survives ordinary HTTP close.
 * Principal is stored hashed so raw API tokens never sit on the slot.
 *
 * No upstream HTTP inference. Unknown request fields are not env injection.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolError } from "./protocol.mjs";

const VERSION = "2.1.303";
const MODES = new Set(["subagent-pool", "process", "session-reset"]);
const REQUIRED_CAPS = {
	always: ["native_slots"],
	continuous: ["continuous_tools"],
	reset: ["session_reset"],
};

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_FRAMES = 64;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_FRAMES = 32;
const MAX_EVENT_BYTES = 1 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_CONSUMED = 4096;
const READY_TIMEOUT_MS = 30_000;
const RESET_TIMEOUT_MS = 15_000;
const CANCEL_TIMEOUT_MS = 5_000;
const SHUTDOWN_DRAIN_MS = 2_000;
const SIGTERM_GRACE_MS = 1_000;

const PROXY_UNSET = new Set([
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
]);

const SECRET_RE =
	/\b(?:sk-ant-[a-z0-9_-]+|sk-[a-z0-9]{10,}|AIza[0-9A-Za-z_-]{20,}|gsk_[a-z0-9]+|Bearer\s+[A-Za-z0-9._\-+=/]+)/gi;
const SECRET_KV_RE =
	/(?:api[_-]?key|authorization|x-api-key|secret|token|password|credential)\s*[:=]\s*([^\s,;]+)/gi;
const PATH_RE =
	/(?:file:\/\/[^\s)]+)|(?:(?:[A-Za-z]:)?(?:[\\/][^\s)\]'",:]{1,})+\.(?:js|mjs|cjs|ts|json|node|sh)(?::\d+(?::\d+)?)?)|(?:(?:\/(?:home|usr|mnt|opt|var|tmp|private|Users|root)|[A-Za-z]:\\)[^\s)\]'",:]{1,})/g;
const DEFAULT_CLAUDE_PATH = fileURLToPath(
	new URL("../dist/claude/cli.js", import.meta.url),
);

export function createRuntime(options = {}) {
	const opts = options == null ? {} : options;
	const cwd = opts.cwd == null ? process.cwd() : String(opts.cwd);
	const claudePath =
		opts.claudePath == null || opts.claudePath === ""
			? DEFAULT_CLAUDE_PATH
			: path.resolve(cwd, String(opts.claudePath));
	const maxProcs = intOpt(opts.maxProcs, 20, 1, 10_000);
	const minProcs = intOpt(opts.minProcs, 0, 0, maxProcs);
	const mode = opts.mode == null ? "subagent-pool" : String(opts.mode);
	if (!MODES.has(mode)) {
		throw fail(
			`unsupported runtime mode: ${mode}`,
			400,
			"invalid_request_error",
		);
	}
	const strictIsolation = opts.strictIsolation === true;
	const continuousToolLoop = opts.continuousToolLoop !== false;
	const requestTimeoutMs = intOpt(
		opts.requestTimeoutMs,
		120_000,
		1,
		86_400_000,
	);
	const toolTimeoutMs = intOpt(opts.toolTimeoutMs, 300_000, 1, 86_400_000);
	const queueTimeoutMs = intOpt(opts.queueTimeoutMs, 30_000, 1, 86_400_000);
	const maxQueue = intOpt(opts.maxQueue, 100, 0, 1_000_000);
	const childEnv = buildChildEnv(opts);
	const pool = mode === "subagent-pool";
	const maxDetached = Math.max(maxProcs + maxQueue, 32);

	const sharedSessionId = randomUUID();
	const slots = [];
	for (let i = 0; i < maxProcs; i += 1) {
		slots.push(makeSlot(i, pool, strictIsolation, sharedSessionId));
	}

	const children = new Set();
	const waiters = new Map();
	const waitingIndex = new Map();
	const consumed = new Map();
	const detached = new Set();
	const queue = [];
	const timers = new Set();

	let closed = false;
	let closePromise = null;
	let poolChild = null;
	let poolSpawn = null;
	let workerVersion = VERSION;
	let workerCaps = [];
	let pumping = false;

	if (minProcs > 0) {
		void preheat().catch(() => {});
	}

	async function run(body, runOpts = {}) {
		if (closed) throw fail("runtime closed", 503, "overloaded_error");
		assertCanonical(body);
		const ctx = normalizeRunOpts(runOpts);
		throwIfAborted(ctx.signal);
		const intent = continuationIntent(body);
		if (intent.present) {
			return continueTurn(body, ctx, intent);
		}
		return startFresh(body, ctx);
	}

	function health() {
		const pids = [];
		const seen = new Set();
		for (const child of children) {
			if (child.dead) continue;
			const pid = Number(child.pid);
			if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
			seen.add(pid);
			pids.push(pid);
		}
		let active = 0;
		let waitingSlots = 0;
		for (const slot of slots) {
			if (
				slot.phase === "running" ||
				slot.phase === "cancelling" ||
				slot.phase === "starting"
			) {
				active += 1;
			} else if (slot.phase === "waiting") {
				waitingSlots += 1;
			}
		}
		const ready = !closed && (minProcs === 0 || readyCount() >= neededReady());
		return {
			version: workerVersion,
			mode,
			capacity: maxProcs,
			active,
			waiting: waitingSlots,
			queued: queue.length,
			pids,
			ready,
			ok: ready,
			capabilities: workerCaps.slice(),
			continuations: detached.size + waitingSlots,
		};
	}

	function close() {
		if (closePromise) return closePromise;
		closed = true;
		closePromise = (async () => {
			for (const item of queue.splice(0)) {
				unschedule(item.timer);
				detachAbort(item);
				item.reject(fail("runtime closed", 503, "overloaded_error"));
			}
			for (const record of [...detached]) {
				forgetContinuation(record, "lost");
			}
			for (const slot of slots) {
				const waiter = slot.waiter;
				if (waiter && !waiter.settled) {
					settleWaiter(waiter, fail("runtime closed", 503, "overloaded_error"));
				}
				unindexSlot(slot);
				unschedule(slot.toolTimer);
				slot.phase = "idle";
				slot.child = null;
			}
			for (const waiter of [...waiters.values()]) {
				if (!waiter.settled) {
					settleWaiter(waiter, fail("runtime closed", 503, "overloaded_error"));
				}
			}
			waiters.clear();
			waitingIndex.clear();
			const live = [...children];
			await Promise.all(live.map((child) => shutdownChild(child)));
			for (const timer of [...timers]) unschedule(timer);
			consumed.clear();
		})();
		return closePromise;
	}

	async function continueTurn(body, ctx, intent) {
		const record = claimContinuation(intent, ctx.principal, body);
		if (record.kind === "live") {
			const slot = record.slot;
			slot.phase = "running";
			slot.gen += 1;
			slot.principal = ctx.principal;
			try {
				return await runOnSlot(slot, body, ctx, {
					resume: true,
					toolResults: intent.blocks,
					continuation: record,
				});
			} catch (error) {
				if (!record.sent) restoreLive(record);
				throw error;
			}
		}
		try {
			return await startFresh(body, ctx, record);
		} catch (error) {
			if (!record.sent) restoreContinuation(record);
			throw error;
		}
	}

	async function startFresh(body, ctx, continuation = null) {
		const slot = pickIdleSlot(body.model, ctx.principal);
		if (!slot) return enqueue(body, ctx, continuation);
		return runOnSlot(slot, body, ctx, { resume: false, continuation });
	}

	async function runOnSlot(slot, body, ctx, how) {
		const gen = slot.gen;
		try {
			throwIfAborted(ctx.signal);
			if (pool) {
				await ensurePoolChild();
				if (slot.child?.dead) slot.child = poolChild;
			} else if (!slot.child || slot.child.dead || !slot.child.ready) {
				await spawnForSlot(slot);
			}
			if (closed) throw fail("runtime closed", 503, "overloaded_error");
			throwIfAborted(ctx.signal);
			const child = slot.child;
			if (!child || child.dead || !child.ready) {
				throw fail("native worker is not ready", 502, "api_error");
			}
			if (strictIsolation && !how.resume) {
				slot.sessionId = randomUUID();
			} else if (!strictIsolation && !pool) {
				slot.sessionId = child.sessionId;
			}
			slot.model = body.model;
			slot.principal = ctx.principal;
			slot.phase = "running";
			const requestId = randomUUID();
			slot.requestId = requestId;
			const turn = waitForTurn(slot, requestId, body, ctx, gen);
			if (slot.waiter?.settled || ctx.signal?.aborted) {
				return await turn;
			}
			const frame = how.resume
				? {
						type: "crag_resume",
						request_id: requestId,
						slot_id: slot.id,
						tool_results: how.toolResults,
						request: body,
					}
				: {
						type: "crag_request",
						request_id: requestId,
						slot_id: slot.id,
						session_id: slot.sessionId,
						request: body,
					};
			try {
				await send(child, frame);
				if (how.continuation) how.continuation.sent = true;
			} catch (error) {
				if (slot.waiter && !slot.waiter.settled)
					settleWaiter(slot.waiter, error);
				throw error;
			}
			return await turn;
		} catch (error) {
			if (
				slot.gen === gen &&
				(slot.phase === "running" || slot.phase === "starting")
			) {
				if (slot.waiter && !slot.waiter.settled)
					settleWaiter(slot.waiter, error);
				if (how.resume && how.continuation && !how.continuation.sent) {
					restoreLive(how.continuation);
				} else {
					releaseSlot(slot, gen, "error");
				}
			}
			throw error;
		}
	}

	function waitForTurn(slot, requestId, body, ctx, gen) {
		return new Promise((resolve, reject) => {
			const waiter = {
				kind: "turn",
				requestId,
				slotId: slot.id,
				slot,
				body,
				gen,
				onEvent: ctx.onEvent,
				signal: ctx.signal,
				resolve,
				reject,
				settled: false,
				timer: null,
				onAbort: null,
				eventQueue: [],
				eventBytes: 0,
				eventPumping: false,
			};
			slot.waiter = waiter;
			waiter.timer = schedule(() => {
				void terminateRunning(
					waiter,
					fail("request timed out", 504, "timeout_error"),
					"timeout",
					"request timeout",
				);
			}, requestTimeoutMs);
			waiter.onAbort = () => {
				const reason = ctx.signal?.reason;
				const err =
					reason instanceof Error
						? attachStatus(reason, 400, "invalid_request_error")
						: fail("request cancelled", 400, "invalid_request_error");
				void terminateRunning(waiter, err, "cancel", "client disconnect");
			};
			if (ctx.signal?.aborted) {
				waiter.onAbort();
				return;
			}
			if (ctx.signal) {
				ctx.signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			waiters.set(requestId, waiter);
		});
	}

	async function terminateRunning(waiter, error, releaseReason, cancelReason) {
		if (!waiter || waiter.settled) return;
		const slot = waiter.slot;
		const gen = waiter.gen;
		settleWaiter(waiter, error);
		if (slot.gen !== gen) return;
		slot.phase = "cancelling";
		await cancelRunning(slot, waiter.requestId, gen, cancelReason);
		releaseSlot(slot, gen, releaseReason);
	}

	async function onTurnEnd(waiter, frame) {
		if (waiter.settled) return;
		const message = frame.message;
		if (!isPlainObject(message) || !Object.hasOwn(message, "content")) {
			settleWaiter(
				waiter,
				fail("native worker returned an invalid message", 502, "api_error"),
			);
			releaseSlot(waiter.slot, waiter.gen, "error");
			return;
		}
		const toolIds = toolUseIds(message);
		const waiting = frame.waiting_for_tools === true && toolIds.length > 0;
		const slot = waiter.slot;
		const gen = waiter.gen;
		const body = waiter.body;
		settleWaiter(waiter, null, message);
		if (waiting && continuousToolLoop) {
			parkLive(slot, body, message, toolIds);
			return;
		}
		if (waiting) {
			parkDetached(body, message, toolIds, slot.principal, slot.model);
			slot.phase = "cancelling";
			await cancelRunning(
				slot,
				waiter.requestId,
				gen,
				"non-continuous tool_use",
			);
			releaseSlot(slot, gen, "complete");
			return;
		}
		releaseSlot(slot, gen, "complete");
	}

	function parkLive(slot, body, message, toolIds) {
		slot.phase = "waiting";
		slot.requestId = null;
		slot.waiter = null;
		const record = {
			kind: "live",
			slot,
			toolIds,
			pendingSet: new Set(toolIds),
			principal: slot.principal,
			fingerprint: parkFingerprint(body, message),
			model: slot.model,
			claimed: false,
			sent: false,
		};
		slot.continuation = record;
		indexContinuation(record);
		unschedule(slot.toolTimer);
		slot.toolTimer = schedule(() => expireContinuation(record), toolTimeoutMs);
	}

	function parkDetached(body, message, toolIds, principal, model) {
		while (detached.size >= maxDetached) {
			const oldest = detached.values().next().value;
			if (!oldest) break;
			expireContinuation(oldest);
		}
		const record = {
			kind: "detached",
			slot: null,
			toolIds,
			pendingSet: new Set(toolIds),
			principal,
			fingerprint: parkFingerprint(body, message),
			model,
			claimed: false,
			sent: false,
		};
		detached.add(record);
		indexContinuation(record);
		record.timer = schedule(() => expireContinuation(record), toolTimeoutMs);
	}

	function claimContinuation(intent, principal, body) {
		const { ids } = intent;
		const reasons = [];
		for (const id of ids) {
			const past = consumed.get(waitKey(principal, id));
			if (past) reasons.push(past.reason);
		}
		if (reasons.length) {
			if (reasons.includes("replay") || reasons.every((r) => r === "replay")) {
				throw fail("tool_result replayed", 409, "invalid_request_error");
			}
			if (reasons.includes("expired")) {
				throw fail("tool_result wait expired", 400, "invalid_request_error");
			}
			throw fail(
				"the bound runtime is no longer available",
				400,
				"invalid_request_error",
			);
		}

		let record = null;
		for (const id of ids) {
			const found = lookupWaiting(principal, id);
			if (found === "ambiguous") {
				throw fail("ambiguous tool_result", 409, "invalid_request_error");
			}
			if (!found) {
				throw fail("unknown tool_result", 400, "invalid_request_error");
			}
			if (record && found !== record) {
				throw fail(
					"tool_result ownership mismatch",
					400,
					"invalid_request_error",
				);
			}
			record = found;
		}
		if (!record || record.claimed) {
			throw fail(
				"tool_result continuation already bound",
				409,
				"invalid_request_error",
			);
		}
		if (
			record.pendingSet.size !== ids.length ||
			!ids.every((id) => record.pendingSet.has(id))
		) {
			throw fail(
				"tool_result ownership mismatch",
				400,
				"invalid_request_error",
			);
		}
		if (record.principal !== principal) {
			throw fail(
				"tool_result principal mismatch",
				400,
				"invalid_request_error",
			);
		}
		if (record.fingerprint !== continuationFingerprint(body)) {
			throw fail("tool_result history mismatch", 400, "invalid_request_error");
		}
		if (record.kind === "live") {
			const slot = record.slot;
			if (!slot || slot.phase !== "waiting" || slot.continuation !== record) {
				throw fail(
					"tool_result continuation already bound",
					409,
					"invalid_request_error",
				);
			}
			if (!slot.child || slot.child.dead) {
				forgetContinuation(record, "lost");
				throw fail(
					"the bound runtime is no longer available",
					400,
					"invalid_request_error",
				);
			}
		}
		record.claimed = true;
		unindexRecord(record);
		remember(principal, ids, "replay");
		if (record.kind === "live") {
			unschedule(record.slot.toolTimer);
			record.slot.continuation = null;
		} else {
			unschedule(record.timer);
			detached.delete(record);
		}
		return record;
	}

	function restoreContinuation(record) {
		if (!record || record.sent || record.kind === "live") return;
		if (isIndexed(record)) return;
		for (const id of record.toolIds)
			consumed.delete(waitKey(record.principal, id));
		record.claimed = false;
		detached.add(record);
		indexContinuation(record);
		unschedule(record.timer);
		record.timer = schedule(() => expireContinuation(record), toolTimeoutMs);
	}

	function restoreLive(record) {
		if (!record || record.sent || record.kind !== "live") return;
		const slot = record.slot;
		if (!slot || !slot.child || slot.child.dead) {
			forgetContinuation(record, "lost");
			return;
		}
		if (
			slot.phase === "cancelling" ||
			slot.phase === "retiring" ||
			slot.phase === "resetting" ||
			slot.phase === "idle"
		) {
			return;
		}
		for (const id of record.toolIds)
			consumed.delete(waitKey(record.principal, id));
		record.claimed = false;
		slot.phase = "waiting";
		slot.continuation = record;
		slot.waiter = null;
		slot.requestId = null;
		slot.cancelSent = false;
		indexContinuation(record);
		unschedule(slot.toolTimer);
		slot.toolTimer = schedule(() => expireContinuation(record), toolTimeoutMs);
	}

	function expireContinuation(record) {
		if (!record || record.claimed) return;
		forgetContinuation(record, "expired");
		if (
			record.kind === "live" &&
			record.slot &&
			record.slot.phase === "waiting"
		) {
			const slot = record.slot;
			const gen = slot.gen;
			slot.phase = "cancelling";
			void (async () => {
				await cancelRunning(
					slot,
					slot.requestId || randomUUID(),
					gen,
					"tool wait expired",
				);
				releaseSlot(slot, gen, "expire");
			})().catch(() => {});
		}
	}

	function forgetContinuation(record, reason) {
		if (!record) return;
		unindexRecord(record);
		remember(record.principal, record.toolIds, reason);
		unschedule(record.timer);
		detached.delete(record);
		if (record.kind === "live" && record.slot) {
			unschedule(record.slot.toolTimer);
			if (record.slot.continuation === record) record.slot.continuation = null;
		}
	}

	function waitKey(principal, id) {
		return `${principal}\0${id}`;
	}

	function lookupWaiting(principal, id) {
		const cur = waitingIndex.get(waitKey(principal, id));
		if (!cur) return null;
		if (cur instanceof Set) {
			if (cur.size === 0) return null;
			if (cur.size > 1) return "ambiguous";
			return cur.values().next().value;
		}
		return cur;
	}

	function isIndexed(record) {
		const id = record.toolIds[0];
		if (id == null) return false;
		const cur = waitingIndex.get(waitKey(record.principal, id));
		if (cur === record) return true;
		return cur instanceof Set && cur.has(record);
	}

	function indexContinuation(record) {
		for (const id of record.toolIds) {
			const key = waitKey(record.principal, id);
			const cur = waitingIndex.get(key);
			if (!cur) {
				waitingIndex.set(key, record);
			} else if (cur === record) {
				continue;
			} else if (cur instanceof Set) {
				cur.add(record);
			} else {
				waitingIndex.set(key, new Set([cur, record]));
			}
		}
	}

	function unindexRecord(record) {
		for (const id of record.toolIds) {
			const key = waitKey(record.principal, id);
			const cur = waitingIndex.get(key);
			if (cur === record) waitingIndex.delete(key);
			else if (cur instanceof Set) {
				cur.delete(record);
				if (cur.size === 0) waitingIndex.delete(key);
				else if (cur.size === 1)
					waitingIndex.set(key, cur.values().next().value);
			}
		}
	}

	function unindexSlot(slot) {
		if (slot.continuation) forgetContinuation(slot.continuation, "lost");
	}

	function pickIdleSlot(model, principal) {
		const idle = slots.filter((slot) => slot.phase === "idle");
		if (idle.length === 0) return null;
		const want = model ?? null;
		const pinned = idle.find((slot) => slot.model === want);
		const unpinned = idle.find((slot) => slot.model == null);
		const chosen = pinned || unpinned || idle[0];
		chosen.phase = "running";
		chosen.gen += 1;
		chosen.model = want;
		chosen.principal = principal;
		chosen.continuation = null;
		chosen.requestId = null;
		chosen.waiter = null;
		chosen.cancelSent = false;
		if (strictIsolation) chosen.sessionId = randomUUID();
		return chosen;
	}

	function enqueue(body, ctx, continuation) {
		if (maxQueue <= 0 || queue.length >= maxQueue) {
			throw fail("runtime queue is full", 429, "overloaded_error");
		}
		return new Promise((resolve, reject) => {
			const item = {
				body,
				ctx,
				continuation,
				resolve,
				reject,
				timer: null,
				onAbort: null,
			};
			item.timer = schedule(() => {
				const i = queue.indexOf(item);
				if (i >= 0) queue.splice(i, 1);
				detachAbort(item);
				if (continuation && !continuation.sent)
					restoreContinuation(continuation);
				reject(fail("queued request timed out", 504, "timeout_error"));
			}, queueTimeoutMs);
			if (ctx.signal) {
				item.onAbort = () => {
					const i = queue.indexOf(item);
					if (i >= 0) queue.splice(i, 1);
					unschedule(item.timer);
					if (continuation && !continuation.sent)
						restoreContinuation(continuation);
					const reason = ctx.signal.reason;
					reject(
						reason instanceof Error
							? attachStatus(reason, 400, "invalid_request_error")
							: fail("request cancelled", 400, "invalid_request_error"),
					);
				};
				if (ctx.signal.aborted) {
					unschedule(item.timer);
					item.onAbort();
					return;
				}
				ctx.signal.addEventListener("abort", item.onAbort, { once: true });
			}
			queue.push(item);
		});
	}

	function pumpQueue() {
		if (pumping || closed) return;
		pumping = true;
		try {
			while (queue.length && slots.some((slot) => slot.phase === "idle")) {
				const item = queue.shift();
				unschedule(item.timer);
				detachAbort(item);
				startFresh(item.body, item.ctx, item.continuation).then(
					item.resolve,
					(error) => {
						if (item.continuation && !item.continuation.sent)
							restoreContinuation(item.continuation);
						item.reject(error);
					},
				);
			}
		} finally {
			pumping = false;
		}
	}

	function releaseSlot(slot, gen, reason) {
		if (slot.gen !== gen) return;
		if (
			slot.phase === "idle" ||
			slot.phase === "retiring" ||
			slot.phase === "resetting"
		) {
			if (reason === "death") slot.child = null;
			if (slot.phase === "idle") pumpQueue();
			return;
		}
		unschedule(slot.toolTimer);
		slot.waiter = null;
		slot.requestId = null;
		slot.cancelSent = false;
		if (
			slot.continuation &&
			slot.continuation.kind === "live" &&
			reason !== "complete"
		) {
			forgetContinuation(
				slot.continuation,
				reason === "expire" ? "expired" : "lost",
			);
		}
		if (closed) {
			slot.phase = "idle";
			return;
		}
		if (reason === "death") {
			slot.child = null;
			slot.phase = "idle";
			if (strictIsolation) slot.sessionId = randomUUID();
			pumpQueue();
			return;
		}
		if (mode === "process") {
			slot.phase = "retiring";
			void retireProcessSlot(slot, gen);
			return;
		}
		if (mode === "session-reset") {
			slot.phase = "resetting";
			void resetThenIdle(slot, gen);
			return;
		}
		slot.phase = "idle";
		if (strictIsolation) slot.sessionId = randomUUID();
		pumpQueue();
	}

	async function resetThenIdle(slot, gen) {
		const child = slot.child;
		const requestId = randomUUID();
		try {
			if (!child || child.dead)
				throw fail("native worker gone", 502, "api_error");
			const done = waitAux(child, slot, requestId, "reset", RESET_TIMEOUT_MS);
			await send(child, {
				type: "crag_reset",
				request_id: requestId,
				slot_id: slot.id,
			});
			const frame = await done;
			if (frame?.clean !== true)
				throw fail("session reset was not clean", 502, "api_error");
			if (slot.gen !== gen) return;
			slot.phase = "idle";
			if (strictIsolation) slot.sessionId = randomUUID();
			pumpQueue();
		} catch {
			if (slot.gen !== gen) return;
			await retireProcessSlot(slot, gen);
		}
	}

	async function retireProcessSlot(slot, gen) {
		if (pool) {
			if (slot.gen === gen) {
				slot.phase = "idle";
				pumpQueue();
			}
			return;
		}
		const child = slot.child;
		if (slot.gen === gen) {
			slot.child = null;
			slot.phase = "idle";
			if (strictIsolation) slot.sessionId = randomUUID();
		}
		if (child && !child.dead) {
			children.delete(child);
			await shutdownChild(child);
		}
		if (!closed) {
			const readyIdle = slots.filter(
				(s) => s.phase === "idle" && s.child?.ready && !s.child.dead,
			).length;
			if (readyIdle < minProcs) {
				const target = slots.find(
					(s) => s.phase === "idle" && (!s.child || s.child.dead),
				);
				if (target) void spawnForSlot(target).catch(() => {});
			}
			pumpQueue();
		}
	}

	async function cancelRunning(slot, requestId, gen, reason) {
		if (gen != null && slot.gen !== gen) return;
		const child = slot.child;
		if (!child || child.dead) return;
		if (slot.cancelSent && slot.cancelPromise) return slot.cancelPromise;
		slot.cancelSent = true;
		const id = requestId || randomUUID();
		slot.cancelPromise = (async () => {
			try {
				const occupied = waiters.get(id);
				const acked = occupied
					? Promise.resolve(true)
					: waitAux(child, slot, id, "cancel", CANCEL_TIMEOUT_MS);
				await send(child, {
					type: "crag_cancel",
					request_id: id,
					slot_id: slot.id,
					reason: String(reason || "cancel"),
				});
				await acked;
			} catch {
				/* caller releases the slot */
			} finally {
				slot.cancelPromise = null;
			}
		})();
		return slot.cancelPromise;
	}

	function waitAux(child, slot, requestId, kind, timeoutMs) {
		return new Promise((resolve, reject) => {
			const waiter = {
				kind,
				requestId,
				slotId: slot.id,
				slot,
				child,
				settled: false,
				resolve,
				reject,
				timer: null,
				onEvent: null,
				onAbort: null,
				signal: null,
			};
			waiter.timer = schedule(() => {
				settleWaiter(waiter, fail(`${kind} timed out`, 504, "timeout_error"));
			}, timeoutMs);
			waiters.set(requestId, waiter);
		});
	}

	function settleWaiter(waiter, error, value) {
		if (!waiter || waiter.settled) return;
		waiter.settled = true;
		unschedule(waiter.timer);
		if (waiter.onAbort && waiter.signal) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
		}
		waiters.delete(waiter.requestId);
		if (waiter.slot && waiter.slot.waiter === waiter) waiter.slot.waiter = null;
		if (Array.isArray(waiter.eventQueue)) {
			waiter.eventQueue.length = 0;
			waiter.eventBytes = 0;
		}
		if (error) waiter.reject?.(error);
		else waiter.resolve?.(value);
	}

	async function dispatchFrame(child, frame) {
		if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
		switch (frame.type) {
			case "crag_ready":
				settleReady(child, frame);
				return;
			case "crag_reset_done": {
				const waiter = waiters.get(frame.request_id);
				if (waiter && waiter.kind === "reset")
					settleWaiter(waiter, null, frame);
				return;
			}
			case "crag_event":
			case "crag_turn_end":
			case "crag_error":
			case "crag_cancelled": {
				const waiter = waiters.get(frame.request_id);
				if (frame.type === "crag_cancelled" && waiter?.kind === "cancel") {
					settleWaiter(waiter, null, true);
					return;
				}
				if (frame.type === "crag_error" && waiter && waiter.kind !== "turn") {
					settleWaiter(waiter, nativeError(frame.error));
					return;
				}
				if (frame.type === "crag_error" && !waiter) {
					if (frame.request_id == null)
						failChildWaiters(child, nativeError(frame.error));
					return;
				}
				if (
					!waiter ||
					waiter.kind !== "turn" ||
					waiter.slotId !== frame.slot_id
				)
					return;
				enqueueWaiterFrame(waiter, frame);
				return;
			}
			default:
				return;
		}
	}

	function enqueueWaiterFrame(waiter, frame) {
		if (!waiter || waiter.settled) return;
		if (!Array.isArray(waiter.eventQueue)) {
			waiter.eventQueue = [];
			waiter.eventBytes = 0;
		}
		const bytes = byteSize(JSON.stringify(frame));
		if (
			waiter.eventQueue.length >= MAX_EVENT_FRAMES ||
			waiter.eventBytes + bytes > MAX_EVENT_BYTES
		) {
			waiter.eventQueue.length = 0;
			waiter.eventBytes = 0;
			void terminateRunning(
				waiter,
				fail("native event backlog exceeded", 429, "overloaded_error"),
				"error",
				"event backlog exceeded",
			);
			return;
		}
		waiter.eventQueue.push({ frame, bytes });
		waiter.eventBytes += bytes;
		void pumpWaiterFrames(waiter);
	}

	async function pumpWaiterFrames(waiter) {
		if (waiter.eventPumping) return;
		waiter.eventPumping = true;
		try {
			while (waiter.eventQueue.length && !waiter.settled) {
				const item = waiter.eventQueue.shift();
				waiter.eventBytes = Math.max(0, waiter.eventBytes - (item.bytes || 0));
				const frame = item.frame;
				try {
					if (frame.type === "crag_event") {
						if (typeof waiter.onEvent === "function")
							await waiter.onEvent(frame.event);
					} else if (frame.type === "crag_turn_end") {
						await onTurnEnd(waiter, frame);
					} else if (frame.type === "crag_error") {
						settleWaiter(waiter, nativeError(frame.error));
						releaseSlot(waiter.slot, waiter.gen, "error");
					} else if (frame.type === "crag_cancelled") {
						settleWaiter(
							waiter,
							fail("request cancelled", 400, "invalid_request_error"),
						);
						releaseSlot(waiter.slot, waiter.gen, "cancel");
					}
				} catch (error) {
					if (waiter.settled) return;
					if (frame.type === "crag_event") {
						await terminateRunning(waiter, error, "error", "onEvent failed");
					} else {
						settleWaiter(waiter, error);
						releaseSlot(waiter.slot, waiter.gen, "error");
					}
				}
			}
		} catch {
			/* never reject the unbound waiter pump */
		} finally {
			waiter.eventPumping = false;
			if (waiter.eventQueue.length && !waiter.settled)
				void pumpWaiterFrames(waiter);
		}
	}

	function settleReady(child, frame) {
		if (child.ready || child.dead) return;
		const caps = Array.isArray(frame.capabilities)
			? frame.capabilities.map(String)
			: [];
		const missing = requiredCaps().filter((cap) => !caps.includes(cap));
		if (missing.length) {
			const err = fail(
				`native worker missing capabilities: ${missing.join(", ")}`,
				500,
				"api_error",
			);
			child.readyReject?.(err);
			void killChild(child, "missing capabilities");
			return;
		}
		child.ready = true;
		child.capabilities = caps;
		workerCaps = caps;
		if (typeof frame.version === "string" && frame.version)
			workerVersion = frame.version;
		if (Number.isInteger(frame.pid) && frame.pid > 0) child.pid = frame.pid;
		unschedule(child.readyTimer);
		child.readyResolve?.();
	}

	function requiredCaps() {
		const needed = [...REQUIRED_CAPS.always, ...REQUIRED_CAPS.continuous];
		if (mode === "session-reset") needed.push(...REQUIRED_CAPS.reset);
		return needed;
	}

	async function preheat() {
		if (pool) {
			if (minProcs > 0) await ensurePoolChild();
			return;
		}
		const want = Math.min(minProcs, slots.length);
		await Promise.all(
			slots.slice(0, want).map((slot) => spawnForSlot(slot).catch(() => {})),
		);
	}

	async function ensurePoolChild() {
		if (poolChild && !poolChild.dead && poolChild.ready) return poolChild;
		if (poolSpawn) return poolSpawn;
		poolSpawn = (async () => {
			const child = spawnChild();
			poolChild = child;
			try {
				await child.readyPromise;
				for (const slot of slots) {
					if (!slot.child || slot.child.dead) slot.child = child;
				}
				return child;
			} catch (error) {
				if (poolChild === child) poolChild = null;
				throw error;
			} finally {
				poolSpawn = null;
			}
		})();
		return poolSpawn;
	}

	async function spawnForSlot(slot) {
		if (pool) {
			const child = await ensurePoolChild();
			slot.child = child;
			return child;
		}
		if (slot.child && !slot.child.dead && slot.child.ready) return slot.child;
		if (slot.spawnPromise) return slot.spawnPromise;
		slot.spawnPromise = (async () => {
			const child = spawnChild();
			slot.child = child;
			if (!strictIsolation) slot.sessionId = child.sessionId;
			try {
				await child.readyPromise;
				return child;
			} catch (error) {
				if (slot.child === child) slot.child = null;
				throw error;
			} finally {
				slot.spawnPromise = null;
			}
		})();
		return slot.spawnPromise;
	}

	function spawnChild() {
		const proc = spawn(process.execPath, [claudePath, "--crag-worker"], {
			cwd,
			env: childEnv,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const child = {
			proc,
			pid: proc.pid,
			sessionId: randomUUID(),
			ready: false,
			dead: false,
			deathHandled: false,
			capabilities: [],
			stderr: "",
			stdoutBuf: "",
			pendingFrames: [],
			pendingBytes: 0,
			dispatching: false,
			stdoutPaused: false,
			writeChain: Promise.resolve(),
			readyTimer: null,
			readyResolve: null,
			readyReject: null,
			readyPromise: null,
			exitPromise: null,
		};
		children.add(child);
		child.readyPromise = new Promise((resolve, reject) => {
			let settled = false;
			child.readyResolve = () => {
				if (settled) return;
				settled = true;
				unschedule(child.readyTimer);
				resolve(child);
			};
			child.readyReject = (error) => {
				if (settled) return;
				settled = true;
				unschedule(child.readyTimer);
				reject(error);
			};
			child.readyTimer = schedule(() => {
				const err = fail("native worker ready timeout", 504, "timeout_error");
				child.readyReject(err);
				void killChild(child, "ready timeout");
			}, READY_TIMEOUT_MS);
		});
		child.readyPromise.catch(() => {});
		child.exitPromise = new Promise((resolve) => {
			let exitSettled = false;
			const settleExit = (code, signal) => {
				if (exitSettled) return;
				exitSettled = true;
				child.dead = true;
				if (code !== undefined) child.exitCode = code;
				if (signal !== undefined) child.exitSignal = signal;
				resolve({ code, signal });
				onChildDeath(child);
			};
			proc.once("exit", (code, signal) => settleExit(code, signal));
			proc.once("close", () =>
				settleExit(child.exitCode ?? null, child.exitSignal ?? null),
			);
			proc.once("error", (error) => {
				const code = typeof error?.code === "string" ? error.code : null;
				const err = fail(
					sanitize(
						code
							? `failed to spawn native worker: ${code}`
							: "failed to spawn native worker",
					),
					500,
					"api_error",
				);
				child.readyReject?.(err);
				if (proc.pid == null) settleExit(null, null);
			});
		});
		attachIo(child);
		return child;
	}

	function attachIo(child) {
		const { proc } = child;
		if (!proc.stdout || !proc.stderr || !proc.stdin) {
			child.readyReject?.(
				fail("native worker stdio missing", 500, "api_error"),
			);
			void killChild(child, "stdio missing");
			return;
		}
		proc.stdout.setEncoding("utf8");
		proc.stderr.setEncoding("utf8");
		proc.stdin.setDefaultEncoding("utf8");
		proc.stdout.on("data", (chunk) => {
			if (child.dead) return;
			const text = String(chunk);
			if (
				byteSize(child.stdoutBuf) + byteSize(text) >
				MAX_FRAME_BYTES + MAX_PENDING_BYTES
			) {
				child.stdoutBuf = "";
				void killChild(child, "stdout backlog exceeded");
				return;
			}
			child.stdoutBuf += text;
			parseAvailable(child);
			void pumpDispatch(child);
		});
		proc.stderr.on("data", (chunk) => {
			child.stderr = appendBounded(
				child.stderr,
				sanitize(String(chunk)),
				MAX_STDERR_BYTES,
			);
		});
		proc.stdout.on("error", () => {});
		proc.stderr.on("error", () => {});
		proc.stdin.on("error", () => {});
	}

	function parseAvailable(child) {
		if (child.dead) return;
		for (;;) {
			if (
				child.pendingFrames.length >= MAX_PENDING_FRAMES ||
				child.pendingBytes >= MAX_PENDING_BYTES
			) {
				pauseStdout(child);
				if (byteSize(child.stdoutBuf) > MAX_PENDING_BYTES) {
					child.stdoutBuf = "";
					void killChild(child, "stdout backlog exceeded");
				}
				return;
			}
			const nl = child.stdoutBuf.indexOf("\n");
			if (nl === -1) {
				if (byteSize(child.stdoutBuf) > MAX_FRAME_BYTES) {
					child.stdoutBuf = "";
					void killChild(child, "stdout frame exceeded bound");
				}
				return;
			}
			const raw = child.stdoutBuf.slice(0, nl);
			child.stdoutBuf = child.stdoutBuf.slice(nl + 1);
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			const bytes = byteSize(line);
			if (bytes > MAX_FRAME_BYTES) {
				void killChild(child, "stdout frame exceeded bound");
				return;
			}
			if (!line.trim()) continue;
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				void killChild(child, "native worker emitted non-JSON stdout");
				return;
			}
			child.pendingFrames.push({ frame, bytes });
			child.pendingBytes += bytes;
		}
	}

	function pauseStdout(child) {
		if (child.stdoutPaused || child.dead) return;
		child.stdoutPaused = true;
		try {
			child.proc.stdout?.pause();
		} catch {
			/* ignore */
		}
	}

	function resumeStdout(child) {
		if (!child.stdoutPaused || child.dead) return;
		if (
			child.pendingFrames.length >= MAX_PENDING_FRAMES ||
			child.pendingBytes >= MAX_PENDING_BYTES
		)
			return;
		child.stdoutPaused = false;
		try {
			child.proc.stdout?.resume();
		} catch {
			/* ignore */
		}
		parseAvailable(child);
	}

	async function pumpDispatch(child) {
		if (child.dispatching) return;
		child.dispatching = true;
		try {
			while (child.pendingFrames.length && !child.dead) {
				const item = child.pendingFrames.shift();
				child.pendingBytes = Math.max(
					0,
					child.pendingBytes - (item.bytes || 0),
				);
				try {
					await dispatchFrame(child, item.frame);
				} catch {
					/* per-frame errors must not stall NDJSON or other slots */
				}
				resumeStdout(child);
			}
		} finally {
			child.dispatching = false;
			if (child.pendingFrames.length && !child.dead) void pumpDispatch(child);
			else resumeStdout(child);
		}
	}

	function onChildDeath(child) {
		if (child.deathHandled) return;
		child.deathHandled = true;
		child.dead = true;
		children.delete(child);
		unschedule(child.readyTimer);
		child.pendingFrames.length = 0;
		child.pendingBytes = 0;
		child.stdoutBuf = "";
		const diag = child.stderr.trim();
		const status =
			child.exitSignal != null
				? `signal ${child.exitSignal}`
				: child.exitCode != null
					? `code ${child.exitCode}`
					: "startup failed";
		const err = fail(
			truncate(
				`native worker exited (${status})${diag ? `: ${diag}` : ""}`,
				1000,
			),
			502,
			"api_error",
		);
		if (!child.ready) child.readyReject?.(err);
		failChildWaiters(child, err);
		if (poolChild === child) poolChild = null;
		for (const slot of slots) {
			if (slot.child !== child) continue;
			if (slot.continuation?.kind === "live")
				forgetContinuation(slot.continuation, "lost");
			const gen = slot.gen;
			slot.child = null;
			if (slot.phase !== "idle") releaseSlot(slot, gen, "death");
			else slot.child = null;
		}
		if (!closed && pool && minProcs > 0) {
			void ensurePoolChild().catch(() => {});
		}
	}

	function failChildWaiters(child, err) {
		for (const waiter of [...waiters.values()]) {
			if (waiter.slot?.child !== child && waiter.child !== child) continue;
			settleWaiter(waiter, err);
		}
	}

	function send(child, frame) {
		if (
			!child ||
			child.dead ||
			!child.proc.stdin ||
			child.proc.stdin.destroyed
		) {
			return Promise.reject(
				fail("native worker stdin closed", 502, "api_error"),
			);
		}
		let line;
		try {
			line = `${JSON.stringify(frame)}\n`;
		} catch (error) {
			return Promise.reject(
				fail(
					`request is not serializable: ${error.message}`,
					400,
					"invalid_request_error",
				),
			);
		}
		if (byteSize(line) > MAX_FRAME_BYTES) {
			return Promise.reject(
				fail("native frame exceeds bound", 413, "request_too_large"),
			);
		}
		child.writeChain = child.writeChain.then(
			() => writeLine(child, line),
			() => writeLine(child, line),
		);
		return child.writeChain;
	}

	function writeLine(child, line) {
		return new Promise((resolve, reject) => {
			if (child.dead || !child.proc.stdin || child.proc.stdin.destroyed) {
				reject(fail("native worker stdin closed", 502, "api_error"));
				return;
			}
			const stdin = child.proc.stdin;
			let settled = false;
			const done = (error) => {
				if (settled) return;
				settled = true;
				stdin.off("error", onError);
				if (error)
					reject(
						fail(`native worker stdin: ${error.message}`, 502, "api_error"),
					);
				else resolve();
			};
			const onError = (error) => done(error);
			stdin.once("error", onError);
			const flushed = stdin.write(line, "utf8", (error) => {
				if (error) done(error);
			});
			if (flushed) done();
			else stdin.once("drain", () => done());
		});
	}

	async function shutdownChild(child) {
		if (!child || child.dead) return;
		try {
			await send(child, { type: "crag_shutdown" });
		} catch {
			/* still terminate */
		}
		if (await waitExit(child, SHUTDOWN_DRAIN_MS)) return;
		try {
			child.proc.kill("SIGTERM");
		} catch {
			/* ignore */
		}
		if (await waitExit(child, SIGTERM_GRACE_MS)) return;
		try {
			child.proc.kill("SIGKILL");
		} catch {
			/* ignore */
		}
		await waitExit(child, 1000);
		try {
			child.proc.stdin?.destroy();
		} catch {
			/* ignore */
		}
		try {
			child.proc.stdout?.destroy();
		} catch {
			/* ignore */
		}
		try {
			child.proc.stderr?.destroy();
		} catch {
			/* ignore */
		}
	}

	async function killChild(child, reason) {
		if (!child || child.dead) return;
		child.readyReject?.(
			fail(`native worker killed: ${reason}`, 502, "api_error"),
		);
		try {
			child.proc.kill("SIGTERM");
		} catch {
			/* ignore */
		}
		if (!(await waitExit(child, SIGTERM_GRACE_MS))) {
			try {
				child.proc.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			await waitExit(child, 1000);
		}
	}

	function waitExit(child, ms) {
		if (!child || child.dead) return Promise.resolve(true);
		if (!child.exitPromise) return Promise.resolve(false);
		return new Promise((resolve) => {
			const timer = schedule(() => resolve(false), ms);
			child.exitPromise.then(
				() => {
					unschedule(timer);
					resolve(true);
				},
				() => {
					unschedule(timer);
					resolve(true);
				},
			);
		});
	}

	function readyCount() {
		if (pool) return poolChild && !poolChild.dead && poolChild.ready ? 1 : 0;
		let n = 0;
		for (const child of children) {
			if (!child.dead && child.ready) n += 1;
		}
		return n;
	}

	function neededReady() {
		if (minProcs <= 0) return 0;
		return pool ? 1 : minProcs;
	}

	function remember(principal, ids, reason) {
		const at = Date.now();
		for (const id of ids) {
			const key = waitKey(principal, id);
			consumed.delete(key);
			consumed.set(key, { reason, at });
		}
		while (consumed.size > MAX_CONSUMED) {
			const first = consumed.keys().next().value;
			consumed.delete(first);
		}
	}

	function schedule(fn, ms) {
		const timer = setTimeout(() => {
			timers.delete(timer);
			fn();
		}, ms);
		timers.add(timer);
		return timer;
	}

	function unschedule(timer) {
		if (timer == null) return;
		clearTimeout(timer);
		timers.delete(timer);
	}

	function detachAbort(item) {
		if (item?.onAbort && item.ctx?.signal) {
			item.ctx.signal.removeEventListener("abort", item.onAbort);
		}
	}

	return { run, health, close };
}

function makeSlot(index, pool, strictIsolation, sharedSessionId) {
	return {
		id: `${pool ? "s" : "p"}${String(index).padStart(2, "0")}`,
		sessionId: strictIsolation ? randomUUID() : sharedSessionId,
		phase: "idle",
		model: null,
		principal: "",
		child: null,
		gen: 0,
		requestId: null,
		waiter: null,
		continuation: null,
		toolTimer: null,
		cancelSent: false,
		cancelPromise: null,
		spawnPromise: null,
	};
}

function buildChildEnv(options) {
	const childEnv = { ...process.env };
	const overlay = isPlainObject(options.env) ? options.env : {};
	for (const [key, value] of Object.entries(overlay)) {
		if (value == null) continue;
		const str = String(value);
		if (PROXY_UNSET.has(key) && str === "") {
			delete childEnv[key];
			continue;
		}
		childEnv[key] = str;
	}
	if (
		options.entrypoint != null &&
		options.entrypoint !== "" &&
		childEnv.CLAUDE_CODE_ENTRYPOINT == null
	) {
		childEnv.CLAUDE_CODE_ENTRYPOINT = String(options.entrypoint);
	}
	if (
		options.telemetryFeatures != null &&
		childEnv.CRAG_TELEMETRY_FEATURES == null
	) {
		childEnv.CRAG_TELEMETRY_FEATURES = String(options.telemetryFeatures);
	}
	if (options.noRefusalCutoff === true) {
		childEnv.CRAG_NO_REFUSAL_CUTOFF = "1";
	}
	return childEnv;
}

function normalizeRunOpts(runOpts) {
	const opts = runOpts == null ? {} : runOpts;
	return {
		signal: opts.signal,
		onEvent: opts.onEvent,
		principal: isolatePrincipal(opts.principal),
	};
}

function assertCanonical(body) {
	if (!isPlainObject(body)) {
		throw fail(
			"canonical request body is required",
			400,
			"invalid_request_error",
		);
	}
	if (typeof body.model !== "string" || body.model.length === 0) {
		throw fail("model is required", 400, "invalid_request_error");
	}
	if (!Array.isArray(body.messages) || body.messages.length === 0) {
		throw fail("messages is required", 400, "invalid_request_error");
	}
}

function continuationIntent(body) {
	const last = lastUserMessage(body);
	if (!last) return { present: false, ids: [], blocks: [] };
	const blocks = asBlocks(last.content).filter(
		(block) => block && block.type === "tool_result",
	);
	if (blocks.length === 0) return { present: false, ids: [], blocks: [] };
	const ids = [];
	for (const block of blocks) {
		if (
			typeof block.tool_use_id !== "string" ||
			block.tool_use_id.length === 0
		) {
			throw fail(
				"tool_result is missing tool_use_id",
				400,
				"invalid_request_error",
			);
		}
		ids.push(block.tool_use_id);
	}
	if (new Set(ids).size !== ids.length) {
		throw fail("duplicate tool_result ids", 400, "invalid_request_error");
	}
	return { present: true, ids, blocks };
}

function lastUserMessage(body) {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]?.role === "user") return messages[i];
	}
	return null;
}

function asBlocks(content) {
	if (content == null) return [];
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content : [];
}

function toolUseIds(message) {
	return asBlocks(message?.content)
		.filter(
			(block) =>
				block &&
				block.type === "tool_use" &&
				typeof block.id === "string" &&
				block.id,
		)
		.map((block) => block.id);
}

function messagesWithoutTrailingToolResults(body) {
	const messages = Array.isArray(body?.messages) ? body.messages.slice() : [];
	const last = lastUserMessage(body);
	if (
		last &&
		asBlocks(last.content).some(
			(block) => block && block.type === "tool_result",
		)
	) {
		const index = messages.lastIndexOf(last);
		if (index >= 0) messages.splice(index, 1);
	}
	return messages;
}

function continuationFingerprint(body) {
	return stableStringify({
		model: body?.model ?? null,
		system: body?.system ?? null,
		tools: body?.tools ?? null,
		messages: normalizeHistoryMessages(
			messagesWithoutTrailingToolResults(body),
		),
	});
}

function parkFingerprint(body, message) {
	return stableStringify({
		model: body?.model ?? null,
		system: body?.system ?? null,
		tools: body?.tools ?? null,
		messages: normalizeHistoryMessages([
			...(Array.isArray(body?.messages) ? body.messages : []),
			{ role: "assistant", content: message.content },
		]),
	});
}

function normalizeHistoryMessages(messages) {
	return messages.map((message) => {
		if (!isPlainObject(message)) return message;
		const out = {
			role: message.role ?? null,
			content: message.content ?? null,
		};
		if (message.name != null) out.name = message.name;
		return out;
	});
}

function stableStringify(value) {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort())
			out[key] = sortKeys(value[key]);
		return out;
	}
	return value;
}

function nativeError(error) {
	const message = sanitize(String(error?.message || "native worker error"));
	const status = Number.isInteger(error?.status) ? error.status : 500;
	const type =
		typeof error?.type === "string" && error.type ? error.type : "api_error";
	return fail(truncate(message, 1000), status, type);
}

function throwIfAborted(signal) {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	throw reason instanceof Error
		? attachStatus(reason, 400, "invalid_request_error")
		: fail("request cancelled", 400, "invalid_request_error");
}

function attachStatus(error, status, type) {
	if (error.status == null) error.status = status;
	if (error.type == null) error.type = type;
	return error;
}

function fail(message, status = 400, type = "invalid_request_error") {
	return new ProtocolError(message, { status, type });
}

function intOpt(value, fallback, min, max) {
	if (value == null || value === "") return fallback;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	const i = Math.trunc(n);
	if (i < min) return min;
	if (i > max) return max;
	return i;
}

function isPlainObject(value) {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function byteSize(text) {
	return Buffer.byteLength(text, "utf8");
}

function appendBounded(prev, next, max) {
	const joined = prev + next;
	if (joined.length <= max) return joined;
	return joined.slice(joined.length - max);
}

function isolatePrincipal(value) {
	const raw = value == null ? "" : String(value);
	if (!raw) return "";
	return createHash("sha256").update(raw, "utf8").digest("hex");
}

function sanitize(text) {
	let out = String(text ?? "");
	SECRET_RE.lastIndex = 0;
	out = out.replace(SECRET_RE, "[redacted]");
	SECRET_RE.lastIndex = 0;
	SECRET_KV_RE.lastIndex = 0;
	out = out.replace(SECRET_KV_RE, (full, value) =>
		full.replace(value, "[redacted]"),
	);
	SECRET_KV_RE.lastIndex = 0;
	out = out.replace(/\s+at\s+\S+\s+\([^)]+\)/g, "");
	out = out.replace(
		/\s+at\s+(?:async\s+)?(?:file:\/\/|[A-Za-z]:\\|\/)\S+/g,
		"",
	);
	PATH_RE.lastIndex = 0;
	out = out.replace(PATH_RE, "[path]");
	PATH_RE.lastIndex = 0;
	return out;
}

function truncate(text, max) {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}
