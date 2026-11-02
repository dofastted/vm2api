/**
 * Native Claude Code slot worker. Owns NDJSON stdin/stdout and concurrent
 * native.ask() generators. Client tools suspend on real promises until
 * crag_resume; the same ask() continues. No host shell, no extra MCP process,
 * no /v1/messages client, no per-request process.env.
 */
import { randomUUID } from "node:crypto";
import {
	THINKING_DISPLAYS,
	withRequestContext,
	getRequestContext,
	billingIndexesFromMessages,
} from "./protocol303.mjs";

const VERSION = "2.1.303";
const CAPABILITIES = ["native_slots", "continuous_tools", "session_reset"];
const MCP_SERVER = "crag_tools";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_STDOUT_BUFFER = 16 * 1024 * 1024;
const SECRET_RE =
	/\b(?:sk-ant-[a-z0-9_-]+|sk-[a-z0-9]{10,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s+[A-Za-z0-9._\-+=/]+)/gi;
const SECRET_KV_RE =
	/(?:api[_-]?key|authorization|x-api-key|secret|token|password|credential)\s*[:=]\s*([^\s,;]+)/gi;
const PATH_RE =
	/(?:\/(?:home|mnt|usr|opt|var|tmp|root|Users)\/[^\s'"`:]+|[A-Za-z]:\\[^\s'"`:]+)/g;

let stdoutChain = Promise.resolve();
let stdoutBuffered = 0;
const stdoutWaiters = [];

export async function runWorker(native) {
	if (!native || typeof native !== "object") {
		throw new Error("runWorker requires a native adapter");
	}
	assertNative(native, { requireZ: false });
	await native.initialize({
		noninteractive: true,
		sessionPersistence: false,
	});
	assertNative(native, { requireZ: true });
	applyNativeLifecycleGuards(native);

	const slots = new Map();
	const inflight = new Set();
	let shuttingDown = false;
	let shutdownPromise = null;
	const passthroughSchema = makePassthroughSchema(native.z);

	stdoutChain = Promise.resolve();
	stdoutBuffered = 0;
	stdoutWaiters.length = 0;

	await emit({
		type: "crag_ready",
		version: VERSION,
		pid: process.pid,
		capabilities: CAPABILITIES,
	});

	const track = (promise) => {
		const started = Promise.resolve(promise);
		inflight.add(started);
		started.finally(() => inflight.delete(started)).catch(() => {});
		return started;
	};

	for await (const item of readBoundedNdjson(process.stdin, MAX_FRAME_BYTES)) {
		if (shuttingDown) break;
		if (item.error) {
			track(
				emit({
					type: "crag_error",
					request_id: null,
					slot_id: null,
					error: {
						message: "NDJSON frame exceeds maximum size",
						type: "invalid_request_error",
						status: 400,
					},
				}),
			);
			continue;
		}
		track(dispatch(item.line));
	}
	await shutdown();

	async function dispatch(line) {
		const trimmed = String(line ?? "").trim();
		if (!trimmed) return;
		let frame;
		try {
			frame = JSON.parse(trimmed);
		} catch {
			await emit({
				type: "crag_error",
				request_id: null,
				slot_id: null,
				error: {
					message: "invalid NDJSON frame",
					type: "invalid_request_error",
					status: 400,
				},
			});
			return;
		}
		if (!isPlainObject(frame) || typeof frame.type !== "string") return;
		try {
			switch (frame.type) {
				case "crag_request":
					startRequest(frame);
					break;
				case "crag_resume":
					resumeRequest(frame);
					break;
				case "crag_cancel":
					await cancelSlot(frame);
					break;
				case "crag_reset":
					await resetSlot(frame);
					break;
				case "crag_shutdown":
					await shutdown();
					break;
				default:
					break;
			}
		} catch (error) {
			await emit({
				type: "crag_error",
				request_id: frame.request_id ?? null,
				slot_id: frame.slot_id ?? null,
				error: sanitizeError(error),
			});
		}
	}

	function startRequest(frame) {
		const slotId = requireId(frame.slot_id, "slot_id");
		const requestId = requireId(frame.request_id, "request_id");
		const request = frame.request;
		if (!isPlainObject(request))
			throw statusError("request body is required", 400);
		rejectEnvInjection(request);
		toThinkingConfig(request.thinking);

		const existing = slots.get(slotId);
		if (existing && !isIdle(existing)) {
			throw statusError("slot is busy", 409, "conflict_error");
		}
		if (existing) forgetSlot(existing);

		const model = request.model != null ? String(request.model) : "";
		const { history, prompt, prefill } = splitPrompt(request.messages, native);
		const abort = new AbortController();
		const position = billingIndexesFromMessages(request.messages);
		const context = {
			request,
			session_id: frame.session_id || randomUUID(),
			slot_id: slotId,
			request_id: requestId,
			model,
			subagent: true,
			previousRequestId: undefined,
			promptId: randomUUID(),
			promptIndex: position?.promptIndex ?? 0,
			turnIndex: position?.turnIndex ?? 1,
		};

		const slot = {
			id: slotId,
			phase: "running",
			abort,
			context,
			model,
			tools: [],
			history,
			prompt,
			prefill,
			state: null,
			cache: native.createFileCache(),
			pending: new Map(),
			earlyResults: new Map(),
			queuedResume: null,
			assembler: createAssembler(),
			endedTurn: false,
			waitingForTools: false,
			finalMessage: null,
			runner: null,
		};
		slot.getAppState = () => slot.state;
		slot.setAppState = (fn) => {
			slot.state = fn(slot.state);
		};
		slot.getReadFileCache = () => slot.cache;
		slot.setReadFileCache = (next) => {
			slot.cache = next;
		};
		slot.tools = createBridgeTools(
			slot,
			passthroughSchema,
			asArray(request.tools),
		);
		slot.state = configureState(native.createState(), {
			model,
			toolNames: slot.tools.map((tool) => tool.name),
		});
		slots.set(slotId, slot);

		slot.runner = Promise.resolve(
			withRequestContext(context, () => runAsk(native, slot)),
		);
		track(slot.runner);
	}

	function resumeRequest(frame) {
		const slotId = requireId(frame.slot_id, "slot_id");
		const requestId = requireId(frame.request_id, "request_id");
		const slot = slots.get(slotId);
		if (!slot) throw statusError("unknown slot", 400);
		if (slot.phase === "cancelling" || slot.phase === "resetting") {
			throw statusError("slot is cancelling", 409, "conflict_error");
		}
		rejectEnvInjection(frame.request);

		if (slot.waitingForTools) {
			applyResume(slot, frame, requestId);
			return;
		}
		if (slot.phase === "running" && !slot.endedTurn) {
			slot.queuedResume = frame;
			stashToolResults(slot, asArray(frame.tool_results));
			return;
		}
		throw statusError("slot is not waiting for tools", 409, "conflict_error");
	}

	async function cancelSlot(frame) {
		const slotId = requireId(frame.slot_id, "slot_id");
		const requestId = frame.request_id ?? null;
		const slot = slots.get(slotId);
		if (!slot || isIdle(slot)) {
			slots.delete(slotId);
			await emit({
				type: "crag_cancelled",
				request_id: requestId,
				slot_id: slotId,
			});
			return;
		}
		const boundId = requestId ?? slot.context.request_id;
		await abortAndSettle(slot, "cancelling");
		forgetSlot(slot);
		slots.delete(slotId);
		await emit({
			type: "crag_cancelled",
			request_id: boundId,
			slot_id: slotId,
		});
	}

	async function resetSlot(frame) {
		const slotId = requireId(frame.slot_id, "slot_id");
		const requestId = frame.request_id ?? null;
		const slot = slots.get(slotId);
		if (slot && !isIdle(slot)) {
			await abortAndSettle(slot, "resetting");
		}
		if (slot) forgetSlot(slot);
		slots.delete(slotId);
		await emit({
			type: "crag_reset_done",
			request_id: requestId,
			slot_id: slotId,
			clean: true,
		});
	}

	async function shutdown() {
		if (shutdownPromise) return shutdownPromise;
		shuttingDown = true;
		shutdownPromise = (async () => {
			const active = [...slots.values()];
			await Promise.all(
				active.map(async (slot) => {
					if (isIdle(slot)) {
						slots.delete(slot.id);
						return;
					}
					const requestId = slot.context.request_id;
					const slotId = slot.id;
					await abortAndSettle(slot, "cancelling");
					forgetSlot(slot);
					slots.delete(slotId);
					await emit({
						type: "crag_cancelled",
						request_id: requestId,
						slot_id: slotId,
					});
				}),
			);
			slots.clear();
			await Promise.allSettled([...inflight]);
			await flushStdout();
			process.exit(0);
		})();
		return shutdownPromise;
	}
}

async function runAsk(native, slot) {
	const iterator = native.ask(buildAskOptions(slot, native));
	try {
		for await (const message of iterator) {
			await handleSdkMessage(slot, message);
		}
		if (slot.phase === "cancelling" || slot.phase === "resetting") return;
		if (slot.waitingForTools) {
			await emitSlotError(
				slot,
				statusError(
					"native loop ended while waiting for tools",
					502,
					"api_error",
				),
			);
			return;
		}
		if (slot.finalMessage && slot.endedTurn) {
			const assembled = slot.finalMessage;
			slot.finalMessage = null;
			cleanSettledSlot(slot);
			slot.phase = "idle";
			await emit({
				type: "crag_turn_end",
				...ids(slot),
				message: assembled,
				waiting_for_tools: false,
			});
			return;
		}
		if (!slot.endedTurn) {
			await emitSlotError(
				slot,
				statusError(
					"native loop ended without a complete message",
					502,
					"api_error",
				),
			);
		}
	} catch (error) {
		if (!isAbortLike(error)) {
			await emitSlotError(slot, error);
		}
	} finally {
		try {
			await iterator.return?.();
		} catch (error) {
			if (!isAbortLike(error)) {
				await emitSlotError(slot, error);
			}
		}
		if (slot.phase === "running" || slot.phase === "waiting") {
			slot.phase = "idle";
			slot.waitingForTools = false;
		}
	}
}

async function handleSdkMessage(slot, message) {
	if (!message || typeof message !== "object") return;
	if (message.type === "stream_event" && message.event) {
		if (slot.phase === "cancelling" || slot.phase === "resetting") return;
		await emit({
			type: "crag_event",
			...ids(slot),
			event: message.event,
		});
		try {
			const completed = slot.assembler.push(message.event);
			if (completed) await finishTurn(slot, completed);
		} catch (error) {
			await emitSlotError(slot, error);
			try {
				slot.abort.abort();
			} catch {
				/* ignore */
			}
		}
		return;
	}
	if (
		message.type === "result" &&
		message.is_error &&
		!slot.endedTurn &&
		slot.phase !== "cancelling" &&
		slot.phase !== "resetting"
	) {
		await emitSlotError(
			slot,
			statusError(
				resultErrorMessage(message),
				resultStatus(message),
				message.subtype || "api_error",
			),
		);
	}
}

async function finishTurn(slot, assembled) {
	if (slot.phase === "cancelling" || slot.phase === "resetting") return;
	const waiting = assembled.content.some(
		(block) => block && block.type === "tool_use",
	);
	slot.endedTurn = true;
	slot.waitingForTools = waiting;
	if (waiting) {
		slot.finalMessage = null;
		if (slot.phase === "running") slot.phase = "waiting";
		await emit({
			type: "crag_turn_end",
			...ids(slot),
			message: assembled,
			waiting_for_tools: true,
		});
		if (slot.queuedResume) {
			const queued = slot.queuedResume;
			slot.queuedResume = null;
			applyResume(slot, queued, queued.request_id);
		}
		return;
	}
	slot.finalMessage = assembled;
}

function applyResume(slot, frame, requestId) {
	slot.context.request_id = requestId;
	if (isPlainObject(frame.request)) slot.context.request = frame.request;
	slot.context.turnIndex += 1;
	slot.waitingForTools = false;
	slot.endedTurn = false;
	slot.finalMessage = null;
	slot.queuedResume = null;
	slot.assembler = createAssembler();
	slot.phase = "running";
	stashToolResults(slot, asArray(frame.tool_results));
}

function stashToolResults(slot, toolResults) {
	for (const block of toolResults) {
		if (!isPlainObject(block)) continue;
		const id = block.tool_use_id;
		if (typeof id !== "string" || !id) continue;
		const payload = {
			content: block.content ?? "",
			is_error: Boolean(block.is_error),
		};
		const waiter = slot.pending.get(id);
		if (waiter) {
			slot.pending.delete(id);
			waiter.resolve(payload);
		} else {
			slot.earlyResults.set(id, payload);
		}
	}
}

async function abortAndSettle(slot, phase) {
	slot.phase = phase;
	slot.waitingForTools = false;
	slot.queuedResume = null;
	slot.finalMessage = null;
	try {
		slot.abort.abort();
	} catch {
		/* ignore */
	}
	rejectPending(slot, abortError());
	if (slot.runner) {
		try {
			await slot.runner;
		} catch (error) {
			if (!isAbortLike(error)) {
				await emitSlotError(slot, error);
			}
		}
	}
}

function cleanSettledSlot(slot) {
	slot.earlyResults.clear();
	slot.pending.clear();
	slot.tools = [];
	slot.history = [];
	slot.prompt = null;
	slot.prefill = null;
	slot.state = null;
	slot.cache = null;
	slot.assembler = createAssembler();
	slot.queuedResume = null;
	slot.waitingForTools = false;
}

function forgetSlot(slot) {
	rejectPending(slot, abortError());
	slot.earlyResults.clear();
	slot.pending.clear();
	slot.tools = [];
	slot.history = [];
	slot.prompt = null;
	slot.prefill = null;
	slot.state = null;
	slot.cache = null;
	slot.assembler = createAssembler();
	slot.finalMessage = null;
	slot.queuedResume = null;
	slot.waitingForTools = false;
	slot.endedTurn = true;
	slot.phase = "idle";
	slot.runner = null;
}

function rejectPending(slot, error) {
	for (const waiter of slot.pending.values()) {
		try {
			waiter.reject(error);
		} catch {
			/* ignore */
		}
	}
	slot.pending.clear();
	slot.earlyResults.clear();
}

function waitForToolResult(slot, toolUseId, signal) {
	if (slot.earlyResults.has(toolUseId)) {
		const ready = slot.earlyResults.get(toolUseId);
		slot.earlyResults.delete(toolUseId);
		return Promise.resolve(ready);
	}
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const waiter = { resolve: null, reject: null };
		const onAbort = () => {
			if (slot.pending.get(toolUseId) === waiter)
				slot.pending.delete(toolUseId);
			reject(abortError());
		};
		waiter.resolve = (value) => {
			signal?.removeEventListener?.("abort", onAbort);
			resolve(value);
		};
		waiter.reject = (error) => {
			signal?.removeEventListener?.("abort", onAbort);
			reject(error);
		};
		slot.pending.set(toolUseId, waiter);
		signal?.addEventListener?.("abort", onAbort, { once: true });
	});
}

function createBridgeTools(slot, inputSchema, tools) {
	const out = [];
	for (const spec of tools) {
		if (!isClientTool(spec)) continue;
		const name = String(spec.name);
		const description =
			spec.description != null ? String(spec.description) : "";
		const jsonSchema = asInputJsonSchema(spec.input_schema || spec.inputSchema);
		out.push({
			name,
			aliases: [],
			isMcp: true,
			mcpInfo: { serverName: MCP_SERVER, toolName: name },
			alwaysLoad: true,
			shouldDefer: false,
			maxResultSizeChars: Infinity,
			inputSchema,
			inputJSONSchema: jsonSchema,
			isEnabled: () => true,
			isConcurrencySafe: () => true,
			isReadOnly: () => true,
			isDestructive: () => false,
			isOpenWorld: () => false,
			interruptBehavior: () => "cancel",
			userFacingName: () => name,
			toAutoClassifierInput: (input) =>
				input && typeof input === "object"
					? Object.keys(input)
							.map((key) => `${key}=${String(input[key])}`)
							.join(" ")
					: name,
			async description() {
				return description;
			},
			async prompt() {
				return description;
			},
			async checkPermissions(input) {
				return { behavior: "allow", updatedInput: input };
			},
			async call(_args, context) {
				const toolUseId = context?.toolUseId || toolUseIdFrom(context);
				if (!toolUseId) throw statusError("tool call missing tool_use_id", 500);
				const signal = context?.abortController?.signal || slot.abort.signal;
				const result = await waitForToolResult(slot, toolUseId, signal);
				return { data: result };
			},
			mapToolResultToToolResultBlockParam(data, toolUseID) {
				const block = {
					type: "tool_result",
					tool_use_id: toolUseID,
					content: data?.content ?? "",
				};
				if (data?.is_error) block.is_error = true;
				return block;
			},
			renderToolUseMessage() {
				return null;
			},
			renderToolResultMessage() {
				return null;
			},
		});
	}
	return out;
}

function buildAskOptions(slot, native) {
	const request = slot.context.request || {};
	const mutableMessages = [];
	for (const message of slot.history) {
		if (!isPlainObject(message)) continue;
		if (message.role === "user") {
			mutableMessages.push(
				native.makeUserMessage({ content: cloneJson(message.content) }),
			);
		} else if (message.role === "assistant") {
			mutableMessages.push(
				native.makeAssistantMessage({
					content: cloneJson(message.content),
					usage: cloneJson(message.usage),
				}),
			);
		}
	}
	if (
		Array.isArray(slot.prefill) &&
		typeof native.applyAssistantPrefill === "function"
	) {
		native.applyAssistantPrefill(
			mutableMessages,
			slot.prefill.map((message) => cloneJson(message)),
		);
	}
	return {
		commands: [],
		prompt: asAskPrompt(slot.prompt),
		cwd: process.cwd(),
		tools: slot.tools,
		mcpClients: [],
		verbose: false,
		thinkingConfig: toThinkingConfig(request.thinking),
		taskBudget: taskBudgetFrom(request),
		canUseTool: async (_tool, input) => ({
			behavior: "allow",
			updatedInput: input,
		}),
		mutableMessages,
		getReadFileCache: slot.getReadFileCache,
		setReadFileCache: slot.setReadFileCache,
		appendSystemPrompt: systemToAppend(request.system),
		userSpecifiedModel: slot.model || undefined,
		jsonSchema: jsonSchemaFrom(request),
		getAppState: slot.getAppState,
		setAppState: slot.setAppState,
		abortController: slot.abort,
		replayUserMessages: false,
		includePartialMessages: true,
		agents: [],
	};
}

function asAskPrompt(content) {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	if (Array.isArray(content)) return cloneJson(content);
	if (content == null) return [{ type: "text", text: "" }];
	return cloneJson(content);
}

function configureState(state, { model, toolNames }) {
	const current = isPlainObject(state) ? state : {};
	const permission = current.toolPermissionContext || {};
	return {
		...current,
		mainLoopModel: model || current.mainLoopModel,
		mainLoopModelForSession: model || current.mainLoopModelForSession,
		toolPermissionContext: {
			...permission,
			mode: "bypassPermissions",
			additionalWorkingDirectories:
				permission.additionalWorkingDirectories instanceof Map
					? permission.additionalWorkingDirectories
					: new Map(),
			alwaysAllowRules: {
				...(permission.alwaysAllowRules || {}),
				cliArg: [...toolNames],
			},
			alwaysDenyRules: permission.alwaysDenyRules || {},
			alwaysAskRules: permission.alwaysAskRules || {},
			isBypassPermissionsModeAvailable: true,
			shouldAvoidPermissionPrompts: true,
		},
		mcp: {
			...(current.mcp || {}),
			clients: [],
			tools: [],
			commands: [],
			resources: {},
		},
	};
}

function createAssembler() {
	let message = null;
	const blocks = [];
	return {
		push(event) {
			if (!isPlainObject(event)) return null;
			switch (event.type) {
				case "message_start": {
					message = cloneJson(event.message) || emptyMessage();
					message.content = [];
					if (message.stop_reason === undefined) message.stop_reason = null;
					if (message.stop_sequence === undefined) message.stop_sequence = null;
					blocks.length = 0;
					break;
				}
				case "content_block_start": {
					const index = Number(event.index) || 0;
					blocks[index] = cloneJson(event.content_block) || {};
					if (blocks[index].type === "tool_use") {
						blocks[index]._json = "";
						if (blocks[index].input == null) blocks[index].input = {};
					}
					break;
				}
				case "content_block_delta": {
					applyDelta(blocks[Number(event.index) || 0], event.delta);
					break;
				}
				case "content_block_stop": {
					const index = Number(event.index) || 0;
					blocks[index] = finalizeBlock(blocks[index]);
					break;
				}
				case "message_delta": {
					if (!message) break;
					const delta = event.delta || {};
					if (delta.stop_reason != null)
						message.stop_reason = delta.stop_reason;
					if (Object.prototype.hasOwnProperty.call(delta, "stop_sequence")) {
						message.stop_sequence = delta.stop_sequence;
					}
					if (isPlainObject(event.usage)) {
						message.usage = { ...(message.usage || {}), ...event.usage };
					}
					break;
				}
				case "message_stop": {
					if (!message) message = emptyMessage();
					message.type = "message";
					message.role = message.role || "assistant";
					message.content = blocks
						.filter(Boolean)
						.map((block) => finalizeBlock(block));
					const complete = message;
					message = null;
					blocks.length = 0;
					return complete;
				}
				default:
					break;
			}
			return null;
		},
	};
}

function emptyMessage() {
	return {
		id: "",
		type: "message",
		role: "assistant",
		model: "",
		content: [],
		stop_reason: null,
		stop_sequence: null,
		usage: {},
	};
}

function applyDelta(block, delta) {
	if (!block || !isPlainObject(delta)) return;
	switch (delta.type) {
		case "text_delta":
			block.text = (block.text || "") + (delta.text || "");
			break;
		case "input_json_delta":
			block._json = (block._json || "") + (delta.partial_json || "");
			break;
		case "thinking_delta":
			block.thinking = (block.thinking || "") + (delta.thinking || "");
			break;
		case "signature_delta":
			block.signature = (block.signature || "") + (delta.signature || "");
			break;
		case "citations_delta":
			if (!Array.isArray(block.citations)) block.citations = [];
			if (delta.citation) block.citations.push(delta.citation);
			break;
		default:
			break;
	}
}

function finalizeBlock(block) {
	if (!isPlainObject(block)) return block;
	if (block.type === "tool_use") {
		if (block._json) {
			let parsed;
			try {
				parsed = JSON.parse(block._json);
			} catch {
				delete block._json;
				throw statusError("malformed tool_use input JSON", 502, "api_error");
			}
			if (!isPlainObject(parsed)) {
				delete block._json;
				throw statusError("malformed tool_use input JSON", 502, "api_error");
			}
			block.input = parsed;
		} else if (block.input == null) {
			block.input = {};
		}
		delete block._json;
	}
	return block;
}

function splitPrompt(messages, native) {
	if (!Array.isArray(messages) || messages.length === 0) {
		throw statusError("messages must be a non-empty array", 400);
	}
	let lastUser = -1;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]?.role === "user") {
			lastUser = i;
			break;
		}
	}
	if (lastUser === -1)
		throw statusError("request must include a user message", 400);
	const history = messages.slice(0, lastUser);
	const prompt = messages[lastUser].content;
	const lastText =
		typeof prompt === "string"
			? prompt
			: Array.isArray(prompt)
				? prompt.findLast((block) => block?.type === "text")?.text
				: undefined;
	if (typeof lastText === "string" && lastText.trimStart().startsWith("/")) {
		throw statusError(
			"slash commands are not available through the CRAG API",
			400,
		);
	}
	const trailing = messages.slice(lastUser + 1);
	if (trailing.length === 0) return { history, prompt, prefill: null };
	if (trailing.some((message) => message?.role !== "assistant")) {
		throw statusError(
			"trailing messages after the last user message are not supported",
			400,
		);
	}
	if (typeof native.applyAssistantPrefill === "function") {
		return { history, prompt, prefill: trailing };
	}
	throw statusError("trailing assistant prefill is not supported", 400);
}

function systemToAppend(system) {
	if (system == null) return undefined;
	if (typeof system === "string") return system || undefined;
	if (!Array.isArray(system)) return undefined;
	const texts = [];
	for (const block of system) {
		if (typeof block === "string" && block) texts.push(block);
		else if (block && block.type === "text" && block.text)
			texts.push(block.text);
	}
	return texts.length ? texts.join("\n") : undefined;
}

function toThinkingConfig(thinking) {
	if (!isPlainObject(thinking)) return undefined;
	if (
		thinking.display != null &&
		!THINKING_DISPLAYS.includes(thinking.display)
	) {
		throw statusError(`unsupported thinking display: ${thinking.display}`, 400);
	}
	const extra = thinking.display ? { display: thinking.display } : {};
	if (thinking.type === "disabled") return { type: "disabled", ...extra };
	if (thinking.type === "adaptive") return { type: "adaptive", ...extra };
	if (thinking.type === "enabled") {
		const budget = thinking.budget_tokens ?? thinking.budgetTokens;
		return {
			type: "enabled",
			budgetTokens: budget == null ? 1024 : Number(budget),
			...extra,
		};
	}
	return extra.display ? extra : undefined;
}

function jsonSchemaFrom(request) {
	const format = request?.output_config?.format;
	if (isPlainObject(format)) {
		if (isPlainObject(format.schema)) return format.schema;
		if (format.type === "json_schema" && format.json_schema?.schema) {
			return format.json_schema.schema;
		}
	}
	if (request?.output_format?.schema) return request.output_format.schema;
	return undefined;
}

function taskBudgetFrom(request) {
	const budget = request?.output_config?.task_budget;
	if (isPlainObject(budget) && budget.total != null) {
		return { total: Number(budget.total) };
	}
	return undefined;
}

function isClientTool(spec) {
	if (!isPlainObject(spec) || spec.name == null || spec.name === "")
		return false;
	if (spec.type && spec.type !== "custom") return false;
	return true;
}

function asInputJsonSchema(schema) {
	if (!isPlainObject(schema)) return { type: "object", properties: {} };
	return {
		...schema,
		type: schema.type || "object",
		properties: schema.properties || {},
	};
}

function makePassthroughSchema(z) {
	const zod = z && typeof z.object === "function" ? z : z?.z;
	if (!zod || typeof zod.object !== "function") {
		throw new Error("native.z does not expose Zod object()");
	}
	const schema = zod.object({});
	if (typeof schema.passthrough === "function") return schema.passthrough();
	if (typeof zod.looseObject === "function") return zod.looseObject({});
	return schema;
}

function toolUseIdFrom(context) {
	if (context?.toolUseId) return context.toolUseId;
	const content = context?.messages?.at?.(-1)?.message?.content;
	if (Array.isArray(content)) {
		const block = content.find((item) => item?.type === "tool_use" && item.id);
		if (block) return block.id;
	}
	return null;
}

function ids(slot) {
	const ctx = getRequestContext() || slot.context;
	return {
		request_id: ctx.request_id,
		slot_id: ctx.slot_id || slot.id,
	};
}

function isIdle(slot) {
	return !slot || slot.phase === "idle";
}

async function emitSlotError(slot, error) {
	slot.endedTurn = true;
	slot.waitingForTools = false;
	slot.finalMessage = null;
	await emit({
		type: "crag_error",
		...ids(slot),
		error: sanitizeError(error),
	});
}

async function emit(frame) {
	let line;
	try {
		line = `${JSON.stringify(frame)}\n`;
	} catch {
		return;
	}
	try {
		await enqueueStdout(line);
	} catch {
		/* stdout closed */
	}
}

async function enqueueStdout(line) {
	const size = Buffer.byteLength(line, "utf8");
	while (
		stdoutBuffered > 0 &&
		stdoutBuffered + size > MAX_STDOUT_BUFFER &&
		!process.stdout.writableEnded &&
		!process.stdout.destroyed
	) {
		await new Promise((resolve) => {
			stdoutWaiters.push(resolve);
		});
	}
	stdoutBuffered += size;
	const task = stdoutChain.then(() => writeStdout(line));
	stdoutChain = task.catch(() => {});
	try {
		await task;
	} finally {
		stdoutBuffered -= size;
		while (stdoutWaiters.length && stdoutBuffered < MAX_STDOUT_BUFFER) {
			stdoutWaiters.shift()();
		}
	}
}

async function writeStdout(line) {
	if (process.stdout.writableEnded || process.stdout.destroyed) return;
	const ok = process.stdout.write(line);
	if (!ok) await waitForDrain(process.stdout);
}

function waitForDrain(stream) {
	return new Promise((resolve) => {
		if (
			stream.writableEnded ||
			stream.destroyed ||
			stream.writableNeedDrain === false
		) {
			resolve();
			return;
		}
		const done = () => {
			stream.off("drain", done);
			stream.off("error", done);
			stream.off("close", done);
			resolve();
		};
		stream.once("drain", done);
		stream.once("error", done);
		stream.once("close", done);
	});
}

async function flushStdout() {
	await stdoutChain.catch(() => {});
}

async function* readBoundedNdjson(stream, maxBytes) {
	if (typeof stream.setEncoding === "function") stream.setEncoding("utf8");
	let buffer = "";
	let overflow = false;
	for await (const chunk of stream) {
		const text = String(chunk);
		if (overflow) {
			const nl = text.indexOf("\n");
			if (nl === -1) continue;
			overflow = false;
			buffer = text.slice(nl + 1);
		} else {
			buffer += text;
		}
		while (!overflow) {
			const nl = buffer.indexOf("\n");
			if (nl === -1) {
				if (Buffer.byteLength(buffer, "utf8") > maxBytes) {
					buffer = "";
					overflow = true;
					yield { error: "frame_too_large" };
				}
				break;
			}
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (Buffer.byteLength(line, "utf8") > maxBytes) {
				yield { error: "frame_too_large" };
				continue;
			}
			yield { line };
		}
	}
	if (overflow) return;
	if (buffer.length) {
		if (Buffer.byteLength(buffer, "utf8") > maxBytes)
			yield { error: "frame_too_large" };
		else yield { line: buffer };
	}
}

function sanitizeError(error) {
	const raw =
		error && typeof error === "object"
			? String(error.message || error)
			: String(error || "internal error");
	const message = raw
		.replace(SECRET_RE, "<redacted>")
		.replace(SECRET_KV_RE, (full, value) =>
			full.replace(String(value), "<redacted>"),
		)
		.replace(PATH_RE, "<path>")
		.slice(0, 500);
	return {
		message: message || "internal error",
		type: (error && (error.type || error.name)) || "error",
		status: Number(error?.status || error?.statusCode) || 500,
	};
}

function statusError(message, status, type = "invalid_request_error") {
	const error = new Error(message);
	error.status = status;
	error.type = type;
	return error;
}

function abortError() {
	const error = new Error("cancelled");
	error.name = "AbortError";
	error.status = 499;
	error.type = "cancelled";
	return error;
}

function isAbortLike(error) {
	if (!error) return false;
	return (
		error.name === "AbortError" ||
		error.code === "ABORT_ERR" ||
		error.type === "cancelled" ||
		/aborted|cancelled/i.test(String(error.message || ""))
	);
}

function resultErrorMessage(message) {
	if (Array.isArray(message.errors) && message.errors.length) {
		return String(message.errors[0]);
	}
	return message.subtype || "native error";
}

function resultStatus(message) {
	if (
		message.subtype === "error_max_turns" ||
		message.subtype === "error_max_budget_usd"
	) {
		return 400;
	}
	return 502;
}

function rejectEnvInjection(request) {
	if (!isPlainObject(request)) return;
	if (
		request.env != null ||
		request.environment != null ||
		request.processEnv != null
	) {
		throw statusError("request env injection is not permitted", 400);
	}
}

function requireId(value, name) {
	if (typeof value !== "string" || !value) {
		throw statusError(`${name} is required`, 400);
	}
	return value;
}

function asArray(value) {
	if (value == null) return [];
	return Array.isArray(value) ? value : [value];
}

function isPlainObject(value) {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
	if (value == null) return value;
	return JSON.parse(JSON.stringify(value));
}

function applyNativeLifecycleGuards(native) {
	if (typeof native.setSessionPersistenceDisabled === "function") {
		native.setSessionPersistenceDisabled(true);
	}
	if (typeof native.setIsInteractive === "function") {
		native.setIsInteractive(false);
	}
	if (typeof native.setIsNonInteractiveSession === "function") {
		native.setIsNonInteractiveSession(true);
	}
	if (typeof native.setSessionCallbacks === "function") {
		native.setSessionCallbacks({
			recordTranscript: async () => {},
			flushSessionStorage: async () => {},
			materializeSessionFile: async () => {},
		});
	}
}

function assertNative(native, { requireZ = false } = {}) {
	for (const key of [
		"initialize",
		"createState",
		"createFileCache",
		"ask",
		"makeUserMessage",
		"makeAssistantMessage",
	]) {
		if (typeof native[key] !== "function") {
			throw new Error(`native adapter missing ${key}()`);
		}
	}
	if (requireZ && !native.z) throw new Error("native adapter missing z");
}
