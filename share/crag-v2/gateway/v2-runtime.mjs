import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolError } from "./protocol.mjs";
import {
	appendPreload,
	createLinuxTuiHelper,
} from "../runtime/linux-tui-helper.mjs";
import { normalizeTuiRequestOptions } from "../runtime/tui-request-options.mjs";

const VERSION = "2.1.88-v2";
const MODE = "v2-process-pool";
const MAX_PROMPT_ARG_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_QUEUE = 100;
const CALLBACK_HOST = "127.0.0.1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CLAUDE_PATH = path.join(ROOT, "claude-code-2.1.88", "cli.js");
const MCP_BRIDGE_PATH = path.join(ROOT, "runtime", "mcp-bridge.mjs");
const TAP_PRELOAD_PATH = path.join(ROOT, "runtime", "linux-tui-tap.js");
const timers = new Set();

export const V2_VERSION = VERSION;

export function createV2Runtime(options = {}) {
	const opts = options == null ? {} : options;
	const cwd = path.resolve(String(opts.cwd || process.cwd()));
	const claudePath = path.resolve(
		cwd,
		String(opts.claudePath || DEFAULT_CLAUDE_PATH),
	);
	const bunPath = String(opts.bunPath || process.env.CRAG_BUN_PATH || "bun");
	const bare = opts.bare === true;
	const transport = String(opts.v2Transport || "tui");
	if (transport !== "tui" && transport !== "print") {
		throw fail("unsupported v2 transport", 400, "invalid_request_error");
	}
	if (transport === "tui" && process.platform !== "linux") {
		throw fail(
			"Linux TUI transport requires Linux",
			400,
			"invalid_request_error",
		);
	}
	const maxProcs = intOpt(opts.maxProcs, 20, 1, 256);
	const sessionSlots = intOpt(opts.sessionSlots, maxProcs, 1, maxProcs);
	const minProcs = intOpt(opts.minProcs, 0, 0, maxProcs);
	const requestTimeoutMs = intOpt(
		opts.requestTimeoutMs,
		DEFAULT_REQUEST_TIMEOUT_MS,
		1,
		86_400_000,
	);
	const toolTimeoutMs = intOpt(
		opts.toolTimeoutMs,
		DEFAULT_TOOL_TIMEOUT_MS,
		1,
		86_400_000,
	);
	const queueTimeoutMs = intOpt(
		opts.queueTimeoutMs,
		DEFAULT_QUEUE_TIMEOUT_MS,
		1,
		86_400_000,
	);
	const maxQueue = intOpt(opts.maxQueue, DEFAULT_MAX_QUEUE, 0, 1_000_000);
	const childEnv = {
		...process.env,
		...(opts.env || {}),
		DISABLE_TELEMETRY: "1",
		DISABLE_ERROR_REPORTING: "1",
	};
	const slots = Array.from({ length: maxProcs }, (_, id) => makeSlot(id));
	const queue = [];
	const pendingByKey = new Map();
	const consumed = new Map();
	let runnableSlots = sessionSlots;
	let callbackServer = null;
	let callbackPort = null;
	let callbackReady = null;
	let closed = false;
	let closePromise = null;

	if (minProcs > 0) {
		// TUI/interactive processes are bound to model, prompt and tools. They
		// cannot be meaningfully preheated without claiming a request config.
		void minProcs;
	}

	async function run(body, runOptions = {}) {
		if (closed) throw fail("runtime closed", 503, "overloaded_error");
		assertRequest(body);
		configureSessionSlots(body);
		const ctx = normalizeRunOptions(runOptions);
		throwIfAborted(ctx.signal);
		const intent = continuationIntent(body);
		if (intent.present) return continueRun(body, ctx, intent);
		return startFresh(body, ctx);
	}
	function configureSessionSlots(body) {
		if (body.session_slots == null) return;
		const requested = Number(body.session_slots);
		if (!Number.isInteger(requested) || requested < 1 || requested > maxProcs)
			throw fail(
				`session_slots must be from 1 to ${maxProcs}`,
				400,
				"invalid_request_error",
			);
		if (requested === runnableSlots) return;
		runnableSlots = requested;
		pumpQueue();
	}

	function health() {
		const pids = slots
			.map((slot) => slot.child?.pid)
			.filter((pid) => Number.isInteger(pid) && pid > 0);
		return {
			version: VERSION,
			mode: MODE,
			transport,
			capacity: maxProcs,
			runnable_capacity: runnableSlots,
			session_slots: runnableSlots,
			active: slots.filter((slot) => slot.phase === "running").length,
			waiting: slots.filter((slot) => slot.phase === "waiting").length,
			queued: queue.length,
			pids: [...new Set(pids)],
			ready: !closed,
			ok: !closed,
			capabilities: [
				"original_claude_bundle",
				"process_pool",
				"dynamic_session_slots",
				"request_model",
				"request_effort",
				"request_max_tokens",
				"request_cache_ttl",
				"prompt_append",
				"prompt_replace",
				"mcp_continuation",
				...(transport === "tui" ? ["linux_tui_pty", "transcript_tail"] : []),
			],
			continuations: pendingByKey.size,
		};
	}

	function close() {
		if (closePromise) return closePromise;
		closed = true;
		closePromise = (async () => {
			for (const item of queue.splice(0)) {
				unschedule(item.timer);
				item.reject(fail("runtime closed", 503, "overloaded_error"));
			}
			for (const slot of slots) {
				if (slot.waiter && !slot.waiter.settled) {
					settle(slot.waiter, fail("runtime closed", 503, "overloaded_error"));
				}
				forgetPending(slot, "lost");
				await stopSlot(slot, "runtime closed");
			}
			for (const timer of [...timers]) unschedule(timer);
			consumed.clear();
			pendingByKey.clear();
			if (callbackServer) {
				await new Promise((resolve) => callbackServer.close(() => resolve()));
				callbackServer = null;
			}
		})().catch((error) => {
			closePromise = null;
			throw error;
		});
		return closePromise;
	}

	async function continueRun(body, ctx, intent) {
		const record = claimPending(intent, ctx.principal, body);
		const slot = record.slot;
		if (!slot || slot.child?.dead) {
			forgetPending(slot, "lost");
			throw fail(
				"tool continuation process is gone",
				410,
				"invalid_request_error",
			);
		}
		for (const call of record.calls) {
			call.resolve(toMcpResult(intent.results.get(call.id)));
		}
		return await runOnSlot(slot, body, ctx, { continuation: record });
	}

	async function startFresh(body, ctx) {
		const slot = takeIdleSlot();
		if (!slot) return enqueue(body, ctx);
		return runOnSlot(slot, body, ctx, { continuation: null });
	}

	async function runOnSlot(slot, body, ctx, { continuation }) {
		slot.phase = "running";
		slot.principal = ctx.principal;
		slot.body = body;
		try {
			if (!slot.child) await spawnSlot(slot, body);
			throwIfAborted(ctx.signal);
			const waiter = createWaiter(slot, ctx, body);
			if (!continuation) {
				const prompt = renderInitialPrompt(body, slot.prompt);
				if (transport === "tui") await slot.helper.send(prompt);
				else await sendUser(slot, prompt);
			}
			if (continuation) continuation.sent = true;
			return await waiter.promise;
		} catch (error) {
			if (slot.waiter && !slot.waiter.settled) settle(slot.waiter, error);
			if (continuation && !continuation.sent) restorePending(continuation);
			else await releaseSlot(slot, "error");
			throw error;
		}
	}

	function createWaiter(slot, ctx, body) {
		let resolvePromise;
		let rejectPromise;
		const promise = new Promise((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});
		const waiter = {
			slot,
			body,
			onEvent: ctx.onEvent,
			resolve: resolvePromise,
			reject: rejectPromise,
			settled: false,
			promise,
			timer: null,
			signal: ctx.signal,
			onAbort: null,
			lastAssistant: null,
		};
		waiter.timer = schedule(() => {
			void cancelSlot(slot, fail("request timed out", 504, "timeout_error"));
		}, requestTimeoutMs);
		waiter.onAbort = () => {
			void cancelSlot(
				slot,
				ctx.signal?.reason instanceof Error
					? ctx.signal.reason
					: fail("request cancelled", 400, "invalid_request_error"),
			);
		};
		slot.waiter = waiter;
		if (ctx.signal?.aborted) waiter.onAbort();
		else
			ctx.signal?.addEventListener?.("abort", waiter.onAbort, { once: true });
		return waiter;
	}

	async function spawnSlot(slot, body) {
		await ensureCallbackServer();
		const runId = randomUUID();
		const sessionId = randomUUID();
		const tempDir = path.join(cwd, `.crag-v2-${runId}`);
		await mkdir(tempDir, { recursive: true, mode: 0o700 });
		slot.tempDir = tempDir;
		slot.runId = runId;
		slot.sessionId = sessionId;
		const prompt = await resolvePrompt(body, cwd);
		const requestOptions = resolveTuiRequestOptions(body);
		const childRunEnv = {
			...childEnv,
			CRAG_V2_RUN_ID: runId,
			...(requestOptions.maxTokens != null
				? { CRAG_TUI_MAX_TOKENS: String(requestOptions.maxTokens) }
				: {}),
			...(requestOptions.effort
				? { CRAG_TUI_EFFORT: requestOptions.effort }
				: {}),
			...(requestOptions.cacheTtl
				? { CRAG_TUI_CACHE_TTL: requestOptions.cacheTtl }
				: {}),
		};
		slot.prompt = prompt;
		const tools = Array.isArray(body.tools) ? body.tools : [];
		const callbackToken = randomUUID();
		const mcpConfigPath = path.join(tempDir, "mcp.json");
		const mcpConfig = {
			mcpServers: {
				crag: {
					command: process.execPath,
					args: [MCP_BRIDGE_PATH, "--config", mcpConfigPath],
				},
			},
			crag: {
				callbackUrl: `http://${CALLBACK_HOST}:${callbackPort}/_crag-v2/mcp/${callbackToken}`,
				tools: tools.map(toMcpTool),
			},
		};
		await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), {
			mode: 0o600,
			encoding: "utf8",
		});
		const args =
			transport === "tui"
				? [
						"--session-id",
						sessionId,
						"--strict-mcp-config",
						"--mcp-config",
						mcpConfigPath,
						"--permission-mode",
						"default",
						...(bare ? ["--bare"] : []),
						"--tools",
						"",
						"--no-chrome",
					]
				: [
						claudePath,
						"--print",
						"--input-format",
						"stream-json",
						"--output-format",
						"stream-json",
						"--replay-user-messages",
						"--verbose",
						"--no-session-persistence",
						...(bare ? ["--bare"] : []),
						"--strict-mcp-config",
						"--mcp-config",
						mcpConfigPath,
						"--session-id",
						sessionId,
					];
		if (body.model) args.push("--model", String(body.model));
		if (prompt.nativeText) {
			args.push(
				prompt.mode === "replace"
					? "--system-prompt"
					: "--append-system-prompt",
				prompt.nativeText,
			);
		}
		if (transport === "tui") {
			const helper = await createLinuxTuiHelper({
				bunPath,
				claudePath,
				args,
				cwd,
				env: childRunEnv,
				sessionId,
				tempDir,
				preloadPath: TAP_PRELOAD_PATH,
				onTranscript: (row) => onTuiRow(slot, row),
				onTap: (row) => onTuiTap(slot, row),
				onScreen: (screen) => {
					slot.screen = screen;
				},
			});
			slot.helper = helper;
			slot.child = { pid: helper.pid(), dead: false };
			slot.runId = runId;
			slot.sessionId = sessionId;
			slot.token = callbackToken;
			slot.tempDir = tempDir;
			slot.pendingCalls = new Map();
			slot.lastAssistant = null;
			slot.dead = false;
			return;
		}
    const runtimeName = path.basename(bunPath).toLowerCase();
    const nodeRuntime = runtimeName === "node" || runtimeName === "node.exe";
    const child = spawn(bunPath, args, {
      cwd,
      env: {
        ...childRunEnv,
        ...(nodeRuntime
          ? { NODE_OPTIONS: [childRunEnv.NODE_OPTIONS, `--import=${TAP_PRELOAD_PATH}`].filter(Boolean).join(" ") }
          : { BUN_OPTIONS: appendPreload(childRunEnv.BUN_OPTIONS, TAP_PRELOAD_PATH) }),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
		slot.child = child;
		slot.runId = runId;
		slot.sessionId = sessionId;
		slot.token = callbackToken;
		slot.tempDir = tempDir;
		slot.pendingCalls = new Map();
		slot.lastAssistant = null;
		slot.dead = false;
		child.stdin?.setDefaultEncoding("utf8");
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.on("error", (error) => {
			slot.dead = true;
			if (slot.waiter && !slot.waiter.settled)
				settle(slot.waiter, childError(error));
		});
		child.on("close", (code, signal) => {
			slot.dead = true;
			const error = childExitError(code, signal, slot.stderr);
			if (slot.waiter && !slot.waiter.settled) settle(slot.waiter, error);
			forgetPending(slot, "lost");
		});
		if (child.stderr) {
			child.stderr.on("data", (chunk) => {
				slot.stderr = bounded(`${slot.stderr}${String(chunk)}`, 32 * 1024);
			});
		}
		if (!child.stdout || !child.stdin)
			throw fail("Claude process stdio unavailable", 502, "api_error");
		const rl = createInterface({ input: child.stdout });
		rl.on("line", (line) => onChildLine(slot, line));
		await onceSpawned(child);
	}

	async function sendUser(slot, content) {
		if (!slot.child?.stdin || slot.dead)
			throw fail("Claude process is unavailable", 502, "api_error");
		const frame = {
			type: "user",
			uuid: randomUUID(),
			message: { role: "user", content },
		};
		const text = JSON.stringify(frame);
		if (Buffer.byteLength(text) > MAX_FRAME_BYTES)
			throw fail("prompt frame too large", 413, "invalid_request_error");
		await new Promise((resolve, reject) => {
			slot.child.stdin.write(`${text}\n`, (error) =>
				error ? reject(error) : resolve(),
			);
		});
	}

	function onChildLine(slot, raw) {
		if (slot.dead) return;
		const line = String(raw || "");
		if (!line.trim() || Buffer.byteLength(line) > MAX_FRAME_BYTES) return;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		const waiter = slot.waiter;
		if (message.type === "stream_event") {
			const event = message.event || message;
			if (waiter?.onEvent && isObject(event)) {
				try {
					waiter.onEvent(event);
				} catch {
					void cancelSlot(
						slot,
						fail("stream writer failed", 503, "overloaded_error"),
					);
				}
			}
			return;
		}
		if (message.type === "assistant" && isObject(message.message)) {
			slot.lastAssistant = normalizeAssistant(
				message.message,
				slot.body?.model,
			);
			return;
		}
		if (message.type === "result") {
			if (!waiter || waiter.settled) return;
			try {
				const result = messageToResult(
					message,
					slot.lastAssistant,
					slot.body?.model,
				);
				settle(waiter, result);
				void releaseSlot(slot, "complete");
			} catch (error) {
				settle(waiter, null, error);
				void releaseSlot(slot, "error");
			}
		}
	}
	function onTuiRow(slot, row) {
		if (!row || slot.dead) return;
		if (row.type === "assistant" && isObject(row.message)) {
			slot.lastAssistant = normalizeAssistant(row.message, slot.body?.model);
			return;
		}
		const isTurnEnd = row.type === "system" && row.subtype === "turn_duration";
		if (!isTurnEnd) return;
		queueMicrotask(() => {
			void (async () => {
				await slot.helper?.settleTap?.(1_000);
				if (!slot.waiter || slot.waiter.settled) return;
				try {
					const result = messageToResult(
						{ subtype: "success", usage: row.usage },
						slot.lastAssistant,
						slot.body?.model,
					);
					settle(slot.waiter, result);
					void releaseSlot(slot, "complete");
				} catch (error) {
					settle(slot.waiter, null, error);
					void releaseSlot(slot, "error");
				}
			})();
		});
	}
	function onTuiTap(slot, row) {
		if (!row?.e || !slot.waiter || slot.waiter.settled) return;
		if (!slot.waiter.onEvent) return;
		try {
			slot.waiter.onEvent(row.e);
		} catch {
			void cancelSlot(
				slot,
				fail("stream writer failed", 503, "overloaded_error"),
			);
		}
	}

	async function handleCallback(token, body) {
		const slot = slots.find(
			(candidate) => candidate.token === token && !candidate.dead,
		);
		if (!slot) throw fail("unknown MCP callback", 404, "invalid_request_error");
		if (!isObject(body) || !body.name || !isObject(body.arguments)) {
			throw fail("invalid MCP callback", 400, "invalid_request_error");
		}
		const id = `crag_tool_${randomUUID()}`;
		const call = await new Promise((resolve, reject) => {
			const record = {
				id,
				name: String(body.name),
				arguments: body.arguments,
				resolve,
				reject,
				timer: null,
			};
			record.timer = schedule(() => {
				record.reject(fail("MCP tool wait expired", 504, "timeout_error"));
				void cancelSlot(
					slot,
					fail("MCP tool wait expired", 504, "timeout_error"),
				);
			}, toolTimeoutMs);
			slot.pendingCalls.set(id, record);
			const key = pendingKey(slot.principal, id);
			pendingByKey.set(key, { slot, call: record });
			if (slot.waiter && !slot.waiter.settled) scheduleToolReply(slot);
		});
		return call;
	}

	function scheduleToolReply(slot) {
		if (slot.toolReplyTimer) return;
		slot.toolReplyTimer = schedule(() => {
			slot.toolReplyTimer = null;
			const waiter = slot.waiter;
			if (!waiter || waiter.settled || slot.pendingCalls.size === 0) return;
			const calls = [...slot.pendingCalls.values()];
			const message = {
				id: randomUUID(),
				type: "message",
				role: "assistant",
				model: waiter.body.model || "",
				content: calls.map((call) => ({
					type: "tool_use",
					id: call.id,
					name: call.name,
					input: call.arguments,
				})),
				stop_reason: "tool_use",
				stop_sequence: null,
				usage: {},
			};
			const record = {
				kind: "live",
				slot,
				calls,
				fingerprint: continuationFingerprint(waiter.body, message),
				claimed: false,
				sent: false,
			};
			slot.continuation = record;
			slot.phase = "waiting";
			for (const call of calls)
				pendingByKey.set(pendingKey(slot.principal, call.id), {
					slot,
					call,
					record,
				});
			settle(waiter, message);
		}, 10);
	}

	function claimPending(intent, principal, body) {
		const records = [];
		for (const id of intent.ids) {
			const past = consumed.get(pendingKey(principal, id));
			if (past)
				throw fail(
					past === "replay"
						? "tool_result replayed"
						: "tool continuation expired",
					past === "replay" ? 409 : 410,
					"invalid_request_error",
				);
			const found = pendingByKey.get(pendingKey(principal, id));
			if (!found)
				throw fail("unknown tool_result", 400, "invalid_request_error");
			records.push(found);
		}
		const record = records[0]?.record || records[0]?.slot?.continuation;
		if (
			!record ||
			records.some((item) => item.record && item.record !== record)
		)
			throw fail(
				"tool_result ownership mismatch",
				400,
				"invalid_request_error",
			);
		if (record.claimed)
			throw fail(
				"tool continuation already claimed",
				409,
				"invalid_request_error",
			);
		if (
			record.calls.length !== intent.ids.length ||
			!record.calls.every((call) => intent.results.has(call.id))
		)
			throw fail("tool_result set mismatch", 400, "invalid_request_error");
		if (record.fingerprint !== continuationFingerprint(body))
			throw fail("tool_result history mismatch", 400, "invalid_request_error");
		record.claimed = true;
		record.sent = false;
		for (const call of record.calls) {
			pendingByKey.delete(pendingKey(principal, call.id));
			consumed.set(pendingKey(principal, call.id), "replay");
			unschedule(call.timer);
			record.slot.pendingCalls.delete(call.id);
		}
		record.slot.continuation = null;
		record.slot.phase = "running";
		return record;
	}

	function restorePending(record) {
		if (!record || record.sent || record.claimed) return;
		for (const call of record.calls) {
			consumed.delete(pendingKey(record.slot.principal, call.id));
			pendingByKey.set(pendingKey(record.slot.principal, call.id), {
				slot: record.slot,
				call,
				record,
			});
		}
		record.claimed = false;
		record.slot.continuation = record;
		record.slot.phase = "waiting";
	}

	function forgetPending(slot, reason) {
		if (!slot) return;
		for (const call of slot.pendingCalls?.values?.() || []) {
			unschedule(call.timer);
			pendingByKey.delete(pendingKey(slot.principal, call.id));
			consumed.set(pendingKey(slot.principal, call.id), reason);
			call.reject(
				fail(
					"MCP continuation is no longer available",
					410,
					"invalid_request_error",
				),
			);
		}
		slot.pendingCalls?.clear?.();
		slot.continuation = null;
	}

	async function cancelSlot(slot, error) {
		if (!slot || slot.phase === "idle") return;
		if (slot.waiter && !slot.waiter.settled) settle(slot.waiter, error);
		forgetPending(slot, "expired");
		await releaseSlot(slot, "cancel");
	}

	async function releaseSlot(slot, reason) {
		if (!slot || slot.releasing) return;
		slot.releasing = true;
		slot.phase = "stopping";
		if (slot.waiter && !slot.waiter.settled && reason !== "complete") {
			settle(slot.waiter, fail("slot released", 502, "api_error"));
		}
		await stopSlot(slot, reason);
		slot.phase = "idle";
		slot.releasing = false;
		slot.body = null;
		slot.principal = "";
		slot.waiter = null;
		slot.continuation = null;
		pumpQueue();
	}

	async function stopSlot(slot) {
		const child = slot.child;
		if (slot.helper) {
			await slot.helper.stop("slot release").catch(() => {});
		} else if (child && !slot.dead) {
			try {
				child.kill("SIGTERM");
			} catch {}
			await waitForClose(child, 1_000);
			if (!slot.dead) {
				try {
					child.kill("SIGKILL");
				} catch {}
			}
		}
		if (slot.tempDir)
			await rm(slot.tempDir, { recursive: true, force: true }).catch(() => {});
		slot.helper = null;
		slot.child = null;
		slot.tempDir = null;
		slot.token = null;
		slot.runId = null;
		slot.sessionId = null;
		slot.prompt = null;
		slot.dead = false;
	}

	function takeIdleSlot() {
		const slot = slots.find(
			(candidate) => candidate.id < runnableSlots && candidate.phase === "idle",
		);
		if (!slot) return null;
		slot.phase = "starting";
		slot.generation += 1;
		return slot;
	}

	function enqueue(body, ctx) {
		if (queue.length >= maxQueue)
			throw fail("runtime queue is full", 503, "overloaded_error");
		return new Promise((resolve, reject) => {
			const item = {
				body,
				ctx,
				resolve,
				reject,
				timer: schedule(() => {
					const index = queue.indexOf(item);
					if (index >= 0) queue.splice(index, 1);
					reject(fail("runtime queue timeout", 504, "timeout_error"));
				}, queueTimeoutMs),
			};
			queue.push(item);
			pumpQueue();
		});
	}

	function pumpQueue() {
		while (!closed && queue.length) {
			const slot = takeIdleSlot();
			if (!slot) return;
			const item = queue.shift();
			unschedule(item.timer);
			void runOnSlot(slot, item.body, item.ctx, { continuation: null }).then(
				item.resolve,
				item.reject,
			);
		}
	}

	async function ensureCallbackServer() {
		if (callbackReady) return callbackReady;
		callbackReady = new Promise((resolve, reject) => {
			callbackServer = createServer(async (req, res) => {
				try {
					const match = /^\/\_crag-v2\/mcp\/([^/]+)$/.exec(req.url || "");
					if (req.method !== "POST" || !match)
						throw fail("MCP callback not found", 404, "invalid_request_error");
					const body = await readJson(req);
					const result = await handleCallback(match[1], body);
					sendJson(res, 200, result);
				} catch (error) {
					sendJson(res, error.status || 500, { error: sanitizeError(error) });
				}
			});
			callbackServer.once("error", reject);
			callbackServer.listen(0, CALLBACK_HOST, () => {
				callbackServer.off("error", reject);
				callbackPort = callbackServer.address().port;
				resolve();
			});
		});
		return callbackReady;
	}

	return { run, health, close };
}

function makeSlot(id) {
	return {
		id,
		phase: "idle",
		generation: 0,
		helper: null,
		child: null,
		dead: false,
		releasing: false,
		body: null,
		prompt: null,
		principal: "",
		waiter: null,
		continuation: null,
		pendingCalls: new Map(),
		stderr: "",
		toolReplyTimer: null,
	};
}

function normalizeRunOptions(options) {
	return {
		signal: options?.signal,
		principal: String(options?.principal || "anonymous"),
		onEvent: typeof options?.onEvent === "function" ? options.onEvent : null,
	};
}

function assertRequest(body) {
	if (
		!isObject(body) ||
		!Array.isArray(body.messages) ||
		body.messages.length === 0
	) {
		throw fail(
			"messages must be a non-empty array",
			400,
			"invalid_request_error",
		);
	}
	if (!body.model)
		throw fail("model is required", 400, "invalid_request_error");
}

function continuationIntent(body) {
	const blocks = [];
	for (const message of body.messages || []) {
		for (const block of asArray(message?.content)) {
			if (block?.type === "tool_result" && block.tool_use_id)
				blocks.push(block);
		}
	}
	const results = new Map(
		blocks.map((block) => [String(block.tool_use_id), block]),
	);
	return {
		present: blocks.length > 0,
		blocks,
		ids: [...results.keys()],
		results,
	};
}

function continuationFingerprint(body, assistant = null) {
	const source = body.messages || [];
	const last = source.at(-1);
	const trailingToolResult =
		last?.role === "user" &&
		asArray(last.content).length > 0 &&
		asArray(last.content).every((block) => block?.type === "tool_result");
	const messages = (trailingToolResult ? source.slice(0, -1) : source).map(
		(message) => ({
			...message,
			content: asArray(message.content).filter(
				(block) => block?.type !== "tool_result",
			),
		}),
	);
	if (assistant)
		messages.push({ role: "assistant", content: assistant.content });
	return hashJson({
		model: body.model,
		system: body.system,
		crag_prompt: body.crag_prompt,
		max_tokens: body.max_tokens,
		output_config: body.output_config,
		cache_ttl: body.cache_ttl,
		tools: body.tools,
		messages,
	});
}

function renderInitialPrompt(body, prompt = null) {
	const messages = body.messages || [];
	const lastUser = [...messages]
		.reverse()
		.find((message) => message?.role === "user");
	if (!lastUser)
		throw fail(
			"request must include a user message",
			400,
			"invalid_request_error",
		);
	const history = messages.slice(0, messages.lastIndexOf(lastUser));
	const instructions = prompt?.renderedText
		? `<external_system_instructions>\n${prompt.renderedText}\n</external_system_instructions>\n\n`
		: "";
	const renderedHistory = history.length
		? `<conversation_history>\n${history.map(renderMessage).join("\n\n")}\n</conversation_history>\n\n`
		: "";
	const current = renderContent(lastUser.content);
	if (!current.trim())
		throw fail("user message is empty", 400, "invalid_request_error");
	return `${instructions}${renderedHistory}<current_turn>\n${current}\n</current_turn>`;
}

function renderMessage(message) {
	return `[${String(message.role || "message")}]\n${renderContent(message.content)}`;
}

function renderContent(content) {
	if (typeof content === "string") return content;
	return asArray(content)
		.map((block) => {
			if (typeof block === "string") return block;
			if (block?.type === "text") return block.text || "";
			if (block?.type === "tool_use")
				return `[tool call ${block.name}]\n${JSON.stringify(block.input || {})}`;
			if (block?.type === "tool_result")
				return `[tool result ${block.tool_use_id}]\n${renderContent(block.content)}`;
			return `[unsupported content block: ${block?.type || "unknown"}]`;
		})
		.join("\n");
}

function resolveTuiRequestOptions(body) {
	try {
		return normalizeTuiRequestOptions({
			maxTokens: body.max_tokens,
			effort: body.output_config?.effort,
			cacheTtl: body.cache_ttl,
		});
	} catch (error) {
		throw fail(
			error instanceof Error ? error.message : String(error),
			400,
			"invalid_request_error",
		);
	}
}

async function resolvePrompt(body, cwd) {
	const custom = body.crag_prompt;
	let text = systemText(body.system);
	let mode = "append";
	if (isObject(custom)) {
		mode = custom.mode === "replace" ? "replace" : "append";
		let extra = custom.text;
		if (custom.file != null) {
			const file = path.resolve(cwd, String(custom.file));
			if (file !== cwd && !file.startsWith(`${cwd}${path.sep}`)) {
				throw fail(
					"prompt file must be inside cwd",
					400,
					"invalid_request_error",
				);
			}
			extra = await readFile(file, "utf8");
		}
		if (typeof extra !== "string")
			throw fail(
				"crag_prompt.text or file is required",
				400,
				"invalid_request_error",
			);
		text =
			mode === "replace" ? extra : [text, extra].filter(Boolean).join("\n\n");
	}
	if (!text) return { mode, nativeText: null, renderedText: null };
	if (Buffer.byteLength(text, "utf8") <= MAX_PROMPT_ARG_BYTES)
		return { mode, nativeText: text, renderedText: null };
	if (mode === "replace")
		throw fail(
			"prompt too large for original CLI replace mode",
			400,
			"invalid_request_error",
		);
	return { mode: "rendered", nativeText: null, renderedText: text };
}

function systemText(system) {
	if (typeof system === "string") return system;
	return asArray(system)
		.map((entry) =>
			typeof entry === "string"
				? entry
				: entry?.type === "text"
					? entry.text
					: "",
		)
		.filter(Boolean)
		.join("\n");
}

function normalizeAssistant(message, model) {
	return {
		id: message.id || randomUUID(),
		type: "message",
		role: "assistant",
		model: message.model || model || "",
		content: Array.isArray(message.content)
			? message.content
			: [{ type: "text", text: String(message.content || "") }],
		stop_reason: message.stop_reason ?? null,
		stop_sequence: message.stop_sequence ?? null,
		usage: isObject(message.usage) ? message.usage : {},
	};
}

function messageToResult(result, assistant, model) {
	if (result.subtype && result.subtype !== "success") {
		throw fail(
			String(result.result || result.subtype || "Claude request failed"),
			502,
			"api_error",
		);
	}
	if (assistant) {
		return {
			...assistant,
			stop_reason: assistant.stop_reason || "end_turn",
			usage: { ...(assistant.usage || {}), ...(result.usage || {}) },
		};
	}
	return {
		id: randomUUID(),
		type: "message",
		role: "assistant",
		model: model || "",
		content: [{ type: "text", text: String(result.result || "") }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: isObject(result.usage) ? result.usage : {},
	};
}

function toMcpTool(tool) {
	return {
		name: String(tool.name),
		description: tool.description == null ? "" : String(tool.description),
		inputSchema: tool.input_schema ||
			tool.inputSchema || { type: "object", properties: {} },
	};
}

function toMcpResult(block) {
	if (!block || typeof block !== "object")
		return { content: [{ type: "text", text: "" }] };
	const content =
		typeof block.content === "string"
			? [{ type: "text", text: block.content }]
			: asArray(block.content).map((item) =>
					typeof item === "string" ? { type: "text", text: item } : item,
				);
	return { content, isError: block.is_error === true };
}

function pendingKey(principal, id) {
	return `${hashPrincipal(principal)}\0${id}`;
}

function hashPrincipal(principal) {
	return createHash("sha256").update(String(principal)).digest("hex");
}

function hashJson(value) {
	return createHash("sha256")
		.update(JSON.stringify(sortKeys(value)))
		.digest("hex");
}

function sortKeys(value) {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (isObject(value))
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, sortKeys(value[key])]),
		);
	return value;
}

function settle(waiter, value, error = null) {
	if (!waiter || waiter.settled) return;
	waiter.settled = true;
	waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
	if (error) waiter.reject(error);
	else waiter.resolve(value);
}

function schedule(fn, delay) {
	const timer = setTimeout(() => {
		timers.delete(timer);
		fn();
	}, delay);
	timers.add(timer);
	return timer;
}

function unschedule(timer) {
	if (!timer) return;
	clearTimeout(timer);
	timers.delete(timer);
}

function throwIfAborted(signal) {
	if (signal?.aborted)
		throw signal.reason instanceof Error
			? signal.reason
			: fail("request cancelled", 400, "invalid_request_error");
}

function onceSpawned(child) {
	return new Promise((resolve, reject) => {
		if (child.exitCode != null) {
			reject(childExitError(child.exitCode, child.signalCode, ""));
			return;
		}
		child.once("spawn", resolve);
		child.once("error", reject);
	});
}

function waitForClose(child, timeout) {
	if (child.exitCode != null) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, timeout);
		child.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

async function readJson(request) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of request) {
		bytes += Buffer.byteLength(chunk);
		if (bytes > MAX_FRAME_BYTES)
			throw fail("MCP callback body too large", 413, "invalid_request_error");
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw fail("invalid MCP callback JSON", 400, "invalid_request_error");
	}
}

function sendJson(response, status, body) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
	});
	response.end(JSON.stringify(body));
}

function sanitizeError(error) {
	return {
		type: error?.type || "api_error",
		message: String(error?.message || error),
	};
}

function childError(error) {
	return fail(
		`Claude process error: ${error?.code || error?.message || "unknown"}`,
		502,
		"api_error",
	);
}

function childExitError(code, signal, stderr) {
	if (code === 0)
		return fail("Claude process ended without a result", 502, "api_error");
	return fail(
		`Claude process exited${signal ? ` by ${signal}` : ` with code ${code}`}${stderr ? `: ${bounded(stderr, 500)}` : ""}`,
		502,
		"api_error",
	);
}

function bounded(value, max) {
	return String(value).slice(-max);
}

function fail(message, status = 400, type = "invalid_request_error") {
	return new ProtocolError(message, { status, type });
}

function intOpt(value, fallback, min, max) {
	const n = value == null ? fallback : Number(value);
	if (!Number.isInteger(n) || n < min || n > max)
		throw fail(
			`invalid integer option: ${value}`,
			400,
			"invalid_request_error",
		);
	return n;
}

function isObject(value) {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
	return Array.isArray(value) ? value : value == null ? [] : [value];
}
