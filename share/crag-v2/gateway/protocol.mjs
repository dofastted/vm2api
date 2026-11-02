/**
 * Client protocol adapter: Anthropic Messages, OpenAI Chat Completions,
 * Gemini generateContent <-> canonical Anthropic Messages.
 *
 * No upstream I/O. Gemini tool ids are reconstructed per request only.
 */

const PROTOCOLS = new Set(["anthropic", "openai", "gemini"]);

const EMPTY_SCHEMA = { type: "object", properties: {} };

const IMAGE_TYPES = new Set([
	"image/jpeg",
	"image/jpg",
	"image/png",
	"image/gif",
	"image/webp",
]);

const DOCUMENT_TYPES = new Set([
	"application/pdf",
	"text/plain",
	"text/html",
	"text/csv",
	"text/markdown",
	"text/md",
	"application/json",
]);

const ANTHROPIC_BLOCK_TYPES = new Set([
	"text",
	"image",
	"document",
	"tool_use",
	"tool_result",
	"thinking",
	"redacted_thinking",
	"server_tool_use",
	"web_search_tool_result",
	"search_result",
	"container_upload",
]);

const OPENAI_EFFORT = {
	none: null,
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const ANTHROPIC_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);

const SECRET_RE =
	/\b(?:sk-ant-[a-z0-9_-]+|sk-[a-z0-9]{10,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s+[A-Za-z0-9._\-+=/]+)/gi;
const SECRET_KV_RE =
	/(?:api[_-]?key|authorization|x-api-key|secret|token|password|credential)\s*[:=]\s*([^\s,;]+)/gi;

export class ProtocolError extends Error {
	constructor(message, { status = 400, type = "invalid_request_error" } = {}) {
		super(message);
		this.name = "ProtocolError";
		this.status = status;
		this.type = type;
	}
}

export function normalizeRequest(protocol, body, options = {}) {
	const proto = checkProtocol(protocol);
	if (!isPlainObject(body)) {
		throw new ProtocolError("request body must be a JSON object");
	}
	const cloned = cloneJson(body);
	const normalized =
		proto === "anthropic"
			? normalizeAnthropic(cloned, options)
			: proto === "openai"
				? normalizeOpenAI(cloned, options)
				: normalizeGemini(cloned, options);
	return sanitizeCanonicalRequest(normalized);
}

const BILLING_SYSTEM_PREFIX = "x-anthropic-billing-header:";

function sanitizeCanonicalRequest(request) {
	const out = { ...request };
	delete out.metadata;
	delete out.betas;
	const system = out.system;
	if (typeof system === "string") {
		const cleaned = stripBillingLines(system);
		if (cleaned.trim()) out.system = cleaned;
		else delete out.system;
		return out;
	}
	if (!Array.isArray(system)) return out;
	let changed = false;
	const kept = [];
	for (const entry of system) {
		const text =
			typeof entry === "string"
				? entry
				: entry && typeof entry === "object" && entry.type === "text"
					? entry.text
					: null;
		if (typeof text !== "string") {
			kept.push(entry);
			continue;
		}
		const cleaned = text
			.split(/\r?\n/)
			.filter((line) => !line.trimStart().startsWith(BILLING_SYSTEM_PREFIX))
			.join("\n");
		if (cleaned === text) kept.push(entry);
		else {
			changed = true;
			if (cleaned.trim()) {
				kept.push(
					typeof entry === "string" ? cleaned : { ...entry, text: cleaned },
				);
			}
		}
	}
	if (kept.length === 0) delete out.system;
	else if (changed) out.system = kept;
	return out;
}

function normalizeCragPrompt(value) {
	if (!isPlainObject(value))
		throw new ProtocolError("crag_prompt must be an object");
	const mode = value.mode == null ? "append" : String(value.mode);
	if (mode !== "append" && mode !== "replace") {
		throw new ProtocolError("crag_prompt.mode must be append or replace");
	}
	const hasText = typeof value.text === "string";
	const hasFile = typeof value.file === "string";
	if (hasText === hasFile) {
		throw new ProtocolError("crag_prompt requires exactly one of text or file");
	}
	return { mode, ...(hasText ? { text: value.text } : { file: value.file }) };
}
function normalizeCacheTtl(value) {
	const ttl = String(value).toLowerCase();
	if (ttl !== "5m" && ttl !== "1h")
		throw new ProtocolError("cache_ttl must be 5m or 1h");
	return ttl;
}

function normalizeSessionSlots(value) {
	const slots = requirePositiveInt(value, "session_slots");
	if (slots > 256)
		throw new ProtocolError("session_slots must be from 1 to 256");
	return slots;
}

function applyCragOptions(out, value) {
	if (value != null && !isPlainObject(value))
		throw new ProtocolError("crag_options must be an object");
	const options = value || {};
	if (!out.model && options.model != null) out.model = String(options.model);
	if (out.crag_prompt == null && options.prompt != null)
		out.crag_prompt = normalizeCragPrompt(options.prompt);
	if (out.max_tokens == null && options.max_tokens != null)
		out.max_tokens = requirePositiveInt(options.max_tokens, "max_tokens");
	const effort = out.effort ?? options.effort;
	if (effort != null) {
		out.output_config = normalizeOutputConfig({
			...(isPlainObject(out.output_config) ? out.output_config : {}),
			effort,
		});
	}
	if (out.cache_ttl == null && options.cache_ttl != null)
		out.cache_ttl = options.cache_ttl;
	if (out.session_slots == null && options.session_slots != null)
		out.session_slots = options.session_slots;
	if (out.cache_ttl != null) out.cache_ttl = normalizeCacheTtl(out.cache_ttl);
	if (out.session_slots != null)
		out.session_slots = normalizeSessionSlots(out.session_slots);
	delete out.crag_options;
	delete out.effort;
	delete out.cacheTtl;
	return out;
}

function stripBillingLines(text) {
	return text
		.split(/\r?\n/)
		.filter((line) => !line.trimStart().startsWith(BILLING_SYSTEM_PREFIX))
		.join("\n");
}

export function formatResponse(protocol, message) {
	const proto = checkProtocol(protocol);
	if (!isPlainObject(message)) {
		throw new ProtocolError("message must be a JSON object");
	}
	if (proto === "anthropic") return formatAnthropicMessage(message);
	if (proto === "openai") return formatOpenAIResponse(message);
	return formatGeminiResponse(message);
}

export function createStreamEncoder(protocol, options = {}) {
	const proto = checkProtocol(protocol);
	if (proto === "anthropic") return anthropicEncoder();
	if (proto === "openai") return openaiEncoder(options);
	return geminiEncoder(options);
}

export function formatError(protocol, error) {
	const proto = checkProtocol(protocol, false);
	const { status, type, message } = inspectError(error);
	if (proto === "openai") {
		return {
			error: {
				message,
				type,
				param: null,
				code: openaiErrorCode(type, status),
			},
		};
	}
	if (proto === "gemini") {
		return {
			error: {
				code: status,
				message,
				status: geminiStatus(type, status),
			},
		};
	}
	return {
		type: "error",
		error: { type, message },
	};
}

function normalizeAnthropic(body, options) {
	rejectUnsupportedAnthropicRequest(body);
	const out = { ...body };
	if (options.model && !out.model) out.model = options.model;
	out.stream = toBool(out.stream);
	if (out.tools != null)
		out.tools = asArray(out.tools).map(normalizeAnthropicTool);
	if (!Array.isArray(out.messages)) {
		throw new ProtocolError("messages must be an array");
	}
	if (out.crag_prompt != null)
		out.crag_prompt = normalizeCragPrompt(out.crag_prompt);
	if (out.thinking != null) out.thinking = normalizeThinking(out.thinking);
	if (out.output_config != null)
		out.output_config = normalizeOutputConfig(out.output_config);
	applyCragOptions(out, out.crag_options);
	validateTokenBudget(out.max_tokens, out.thinking);
	return out;
}

function normalizeOpenAI(body, options) {
	rejectUnsupportedOpenAIRequest(body);
	const model = body.model || options.model || "";
	const messagesIn = asArray(body.messages);
	if (messagesIn.length === 0) {
		throw new ProtocolError("messages must be a non-empty array");
	}

	const systemBlocks = [];
	const messages = [];
	for (const raw of messagesIn) {
		if (!isPlainObject(raw)) {
			throw new ProtocolError("each message must be an object");
		}
		const role = raw.role;
		if (role === "system" || role === "developer") {
			systemBlocks.push(...openaiSystemBlocks(raw.content));
			continue;
		}
		if (role === "tool") {
			messages.push(openaiToolMessage(raw));
			continue;
		}
		if (role === "assistant") {
			messages.push(openaiAssistantMessage(raw));
			continue;
		}
		if (role === "user" || role === "function") {
			if (role === "function") {
				messages.push(openaiLegacyFunctionMessage(raw));
				continue;
			}
			messages.push({
				role: "user",
				content: openaiUserContent(raw.content),
			});
			continue;
		}
		throw new ProtocolError(`unsupported OpenAI role: ${role ?? "(missing)"}`);
	}

	const collapsed = collapseToolResults(messages);
	const tools = openaiTools(body);
	const out = {
		model,
		messages: collapsed,
		stream: toBool(body.stream),
	};
	if (body.crag_prompt != null)
		out.crag_prompt = normalizeCragPrompt(body.crag_prompt);
	const system = joinSystem(systemBlocks);
	if (system != null) out.system = system;
	if (tools.length) out.tools = tools;

	const maxTokens = firstDefined(body.max_completion_tokens, body.max_tokens);
	if (maxTokens != null)
		out.max_tokens = requirePositiveInt(maxTokens, "max_tokens");

	if (body.temperature != null) {
		out.temperature = requireUnitInterval(body.temperature, "temperature", 2);
		if (out.temperature > 1) {
			throw new ProtocolError(
				"temperature > 1 is not representable on the Anthropic Messages API",
			);
		}
	}
	if (body.top_p != null)
		out.top_p = requireUnitInterval(body.top_p, "top_p", 1);

	const stop = openaiStop(body.stop);
	if (stop.length) out.stop_sequences = stop;

	const toolChoice = openaiToolChoice(
		firstDefined(body.tool_choice, body.function_call),
		body.parallel_tool_calls,
	);
	if (toolChoice) out.tool_choice = toolChoice;

	const thinking = openaiThinking(body);
	if (thinking) out.thinking = thinking;

	const outputConfig = {};
	const effort = openaiEffort(body.reasoning_effort);
	if (effort) outputConfig.effort = effort;
	const format = openaiOutputFormat(body.response_format);
	if (format) outputConfig.format = format;
	if (Object.keys(outputConfig).length) out.output_config = outputConfig;

	if (body.user != null && body.user !== "") {
		out.metadata = { user_id: String(body.user) };
	}
	if (body.cache_ttl != null) out.cache_ttl = body.cache_ttl;
	if (body.cacheTtl != null) out.cacheTtl = body.cacheTtl;
	if (body.session_slots != null) out.session_slots = body.session_slots;
	if (body.effort != null) out.effort = body.effort;
	applyCragOptions(out, body.crag_options);

	constrainThinkingSampling(out);
	validateTokenBudget(out.max_tokens, out.thinking);
	return out;
}

function normalizeGemini(body, options) {
	rejectUnsupportedGeminiRequest(body);
	const urlModel = options.model ? stripModelsPrefix(options.model) : "";
	const bodyModel = stripModelsPrefix(
		firstDefined(body.model, pick(body, "modelName", "model_name")) || "",
	);
	const model = urlModel || bodyModel;

	const ids = createGeminiIdState();
	const contents = normalizeGeminiContents(body.contents);
	const messages = [];
	for (const content of contents) {
		const mapped = geminiContentToMessage(content, ids);
		if (mapped) messages.push(mapped);
	}
	if (messages.length === 0) {
		throw new ProtocolError(
			"contents must include at least one user or model turn",
		);
	}

	const gen = firstDefined(body.generationConfig, body.generation_config) || {};
	const out = {
		model,
		messages,
		stream: toBool(firstDefined(body.stream, gen.stream)),
	};
	if (body.crag_prompt != null)
		out.crag_prompt = normalizeCragPrompt(body.crag_prompt);

	const system = geminiSystem(
		firstDefined(body.systemInstruction, body.system_instruction),
	);
	if (system != null) out.system = system;

	const tools = geminiTools(body.tools);
	if (tools.length) out.tools = tools;

	const toolChoice = geminiToolChoice(
		firstDefined(body.toolConfig, body.tool_config),
	);
	if (toolChoice) out.tool_choice = toolChoice;

	const maxTokens = firstDefined(gen.maxOutputTokens, gen.max_output_tokens);
	if (maxTokens != null)
		out.max_tokens = requirePositiveInt(maxTokens, "maxOutputTokens");
	if (gen.temperature != null) {
		out.temperature = requireUnitInterval(gen.temperature, "temperature", 2);
		if (out.temperature > 1) {
			throw new ProtocolError(
				"temperature > 1 is not representable on the Anthropic Messages API",
			);
		}
	}
	if (gen.topP != null || gen.top_p != null) {
		out.top_p = requireUnitInterval(
			firstDefined(gen.topP, gen.top_p),
			"topP",
			1,
		);
	}
	if (gen.topK != null || gen.top_k != null) {
		out.top_k = requirePositiveInt(firstDefined(gen.topK, gen.top_k), "topK");
	}
	const stops = asArray(
		firstDefined(gen.stopSequences, gen.stop_sequences),
	).map(String);
	if (stops.length) out.stop_sequences = stops;

	const thinking = geminiThinking(
		firstDefined(gen.thinkingConfig, gen.thinking_config),
	);
	if (thinking) out.thinking = thinking;

	const format = geminiOutputFormat(gen);
	if (format) out.output_config = { format };
	if (body.cache_ttl != null) out.cache_ttl = body.cache_ttl;
	if (body.cacheTtl != null) out.cacheTtl = body.cacheTtl;
	if (body.session_slots != null) out.session_slots = body.session_slots;
	if (body.effort != null) out.effort = body.effort;
	applyCragOptions(out, body.crag_options);

	constrainThinkingSampling(out);
	validateTokenBudget(out.max_tokens, out.thinking);
	return out;
}

function canonicalizeAnthropicMessages(messages) {
	const mapped = [];
	for (const raw of messages) {
		if (!isPlainObject(raw)) {
			throw new ProtocolError("each message must be an object");
		}
		if (raw.role === "tool" || raw.role === "function") {
			mapped.push(
				raw.role === "function"
					? openaiLegacyFunctionMessage(raw)
					: openaiToolMessage(raw),
			);
			continue;
		}
		if (raw.role !== "user" && raw.role !== "assistant") {
			throw new ProtocolError(
				`unsupported Anthropic role: ${raw.role ?? "(missing)"}`,
			);
		}
		if (Array.isArray(raw.tool_calls) && raw.tool_calls.length) {
			mapped.push(openaiAssistantMessage(raw));
			continue;
		}
		const msg = {
			role: raw.role,
			content: canonicalizeAnthropicContent(raw.content),
		};
		for (const [key, value] of Object.entries(raw)) {
			if (
				key === "role" ||
				key === "content" ||
				key === "tool_calls" ||
				key === "tool_call_id"
			) {
				continue;
			}
			msg[key] = value;
		}
		mapped.push(msg);
	}
	return collapseToolResults(mapped);
}

function canonicalizeAnthropicContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) {
		throw new ProtocolError(
			"message content must be a string or array of blocks",
		);
	}
	return content.map((block) => {
		if (!isPlainObject(block) || typeof block.type !== "string") {
			throw new ProtocolError("content block must be an object with type");
		}
		if (block.type === "tool_result") return normalizeToolResultBlock(block);
		if (block.type === "tool_use" || block.type === "server_tool_use") {
			if (!block.id || !block.name) {
				throw new ProtocolError(`${block.type} requires id and name`);
			}
			return {
				...block,
				input: block.input == null ? {} : block.input,
			};
		}
		if (block.type === "image") return normalizeImageBlock(block);
		if (block.type === "document") return normalizeDocumentBlock(block);
		if (block.type === "thinking") {
			if (typeof block.thinking !== "string") {
				throw new ProtocolError("thinking block requires thinking text");
			}
			return block;
		}
		if (block.type === "text") {
			if (typeof block.text !== "string") {
				throw new ProtocolError("text block requires text");
			}
			return block;
		}
		if (!ANTHROPIC_BLOCK_TYPES.has(block.type)) {
			throw new ProtocolError(`unsupported content block type: ${block.type}`);
		}
		return block;
	});
}

function openaiUserContent(content) {
	if (typeof content === "string") return content;
	if (content == null) {
		throw new ProtocolError("user message content is required");
	}
	if (!Array.isArray(content)) {
		throw new ProtocolError(
			"OpenAI content must be a string or array of parts",
		);
	}
	const blocks = [];
	for (const part of content) {
		blocks.push(...openaiPartToBlocks(part, "user"));
	}
	if (blocks.length === 0) {
		throw new ProtocolError("user message has no representable content");
	}
	return blocks.length === 1 &&
		blocks[0].type === "text" &&
		!blocks[0].cache_control
		? blocks[0].text
		: blocks;
}

function openaiAssistantMessage(raw) {
	const blocks = [];
	if (typeof raw.content === "string" && raw.content) {
		blocks.push({ type: "text", text: raw.content });
	} else if (Array.isArray(raw.content)) {
		for (const part of raw.content) {
			blocks.push(...openaiPartToBlocks(part, "assistant"));
		}
	} else if (raw.content != null && raw.content !== "") {
		throw new ProtocolError("unsupported assistant content");
	}
	if (typeof raw.reasoning_content === "string" && raw.reasoning_content) {
		const thinkingBlocks = blocks.filter((block) => block.type === "thinking");
		if (thinkingBlocks.length === 0) {
			blocks.unshift({ type: "thinking", thinking: raw.reasoning_content });
		} else if (thinkingBlocks.every((block) => !block.thinking)) {
			thinkingBlocks[0].thinking = raw.reasoning_content;
		}
	}
	const calls = Array.isArray(raw.tool_calls)
		? raw.tool_calls
		: raw.function_call
			? [
					{
						id: raw.function_call.id || `call_${raw.function_call.name}_1`,
						type: "function",
						function: raw.function_call,
					},
				]
			: [];
	let callIndex = 0;
	for (const call of calls) {
		blocks.push(openaiToolCallToBlock(call, callIndex++));
	}
	if (blocks.length === 0) {
		return { role: "assistant", content: "" };
	}
	return { role: "assistant", content: blocks };
}

function openaiPartToBlocks(part, role) {
	if (typeof part === "string") return [{ type: "text", text: part }];
	if (!isPlainObject(part)) {
		throw new ProtocolError("content part must be an object");
	}
	const type = part.type;
	if (type === "text" || (type == null && typeof part.text === "string")) {
		if (typeof part.text !== "string") {
			throw new ProtocolError("text part requires text");
		}
		return [{ type: "text", text: part.text }];
	}
	if (type === "image_url" || part.image_url) {
		return [imageFromOpenAI(part.image_url || part)];
	}
	if (type === "file" || part.file) {
		return [documentFromOpenAI(part.file || part)];
	}
	if (type === "image_file") {
		const file = part.image_file || part;
		if (file.file_id) {
			return [
				{
					type: "image",
					source: { type: "file", file_id: String(file.file_id) },
				},
			];
		}
		throw new ProtocolError("image_file requires file_id");
	}
	if (type === "redacted_thinking" || type === "redacted_reasoning") {
		const block = {
			...part,
			type: "redacted_thinking",
			data: String(firstDefined(part.data, part.encrypted_content, "")),
		};
		delete block.encrypted_content;
		return [block];
	}
	if (type === "thinking" || type === "reasoning") {
		const thinking = String(
			firstDefined(part.thinking, part.text, part.reasoning) ?? "",
		);
		const block = { ...part, type: "thinking", thinking };
		delete block.text;
		delete block.reasoning;
		if (part.signature != null) block.signature = String(part.signature);
		return [block];
	}
	if (
		type === "input_audio" ||
		type === "audio" ||
		type === "video" ||
		type === "input_video"
	) {
		throw new ProtocolError(`unsupported OpenAI content type: ${type}`);
	}
	if (type === "refusal") {
		if (role === "assistant")
			return [{ type: "text", text: String(part.refusal ?? "") }];
		throw new ProtocolError("refusal parts are not valid on user messages");
	}
	throw new ProtocolError(
		`unsupported OpenAI content type: ${type ?? "(missing)"}`,
	);
}

function openaiToolCallToBlock(call, index) {
	if (!isPlainObject(call)) {
		throw new ProtocolError("tool_call must be an object");
	}
	const fn = call.function || call;
	const name = fn.name;
	if (!name) throw new ProtocolError("tool_call function name is required");
	const id = call.id || (name ? `call_${name}_${index + 1}` : "");
	if (!id) {
		throw new ProtocolError("OpenAI tool_call id is required");
	}
	const args = fn.arguments;
	let input = {};
	if (args == null || args === "") {
		input = {};
	} else if (typeof args === "string") {
		input = parseToolArguments(args, `tool_call ${name}`);
	} else if (isPlainObject(args) || Array.isArray(args)) {
		input = args;
	} else {
		throw new ProtocolError(`unsupported tool_call arguments for ${name}`);
	}
	return { type: "tool_use", id: String(id), name: String(name), input };
}

function openaiToolMessage(raw) {
	const id = raw.tool_call_id;
	if (!id) throw new ProtocolError("tool message requires tool_call_id");
	return {
		role: "user",
		content: [
			toolResultFromOpenAI(id, raw.content, raw.is_error || raw.isError),
		],
	};
}

function openaiLegacyFunctionMessage(raw) {
	const name = raw.name;
	if (!name) throw new ProtocolError("function message requires name");
	return {
		role: "user",
		content: [toolResultFromOpenAI(`call_${name}_1`, raw.content, false)],
	};
}

function toolResultFromOpenAI(id, content, isError) {
	const block = {
		type: "tool_result",
		tool_use_id: String(id),
		content: openaiToolResultContent(content),
	};
	if (isError) block.is_error = true;
	return block;
}

function openaiToolResultContent(content) {
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const blocks = [];
		for (const part of content) {
			if (typeof part === "string") {
				blocks.push({ type: "text", text: part });
				continue;
			}
			if (!isPlainObject(part)) {
				throw new ProtocolError("tool result part must be an object");
			}
			if (part.type === "text" || typeof part.text === "string") {
				blocks.push({ type: "text", text: String(part.text ?? "") });
				continue;
			}
			if (part.type === "image_url" || part.image_url) {
				blocks.push(imageFromOpenAI(part.image_url || part));
				continue;
			}
			if (part.type === "file" || part.file) {
				blocks.push(documentFromOpenAI(part.file || part));
				continue;
			}
			throw new ProtocolError(
				`unsupported tool result content type: ${part.type ?? "(missing)"}`,
			);
		}
		return blocks;
	}
	if (isPlainObject(content)) return jsonString(content);
	throw new ProtocolError("unsupported tool message content");
}

function openaiSystemBlocks(content) {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (content == null) return [];
	if (!Array.isArray(content)) {
		throw new ProtocolError("system content must be a string or array");
	}
	const blocks = [];
	for (const part of content) {
		if (typeof part === "string") {
			blocks.push({ type: "text", text: part });
			continue;
		}
		if (
			isPlainObject(part) &&
			(part.type === "text" || typeof part.text === "string")
		) {
			blocks.push({ type: "text", text: String(part.text ?? "") });
			continue;
		}
		throw new ProtocolError("system messages may only contain text");
	}
	return blocks;
}

function openaiTools(body) {
	const tools = [];
	if (Array.isArray(body.tools)) {
		for (const tool of body.tools) {
			if (!isPlainObject(tool))
				throw new ProtocolError("tool must be an object");
			const type = tool.type || "function";
			if (type !== "function") {
				throw new ProtocolError(`unsupported OpenAI tool type: ${type}`);
			}
			const fn = tool.function || tool;
			if (!fn.name) throw new ProtocolError("function tool name is required");
			const mapped = {
				name: String(fn.name),
				input_schema: ensureObjectSchema(
					firstDefined(fn.parameters, fn.input_schema),
				),
			};
			if (fn.description) mapped.description = String(fn.description);
			if (fn.strict === true || tool.strict === true) mapped.strict = true;
			tools.push(mapped);
		}
	} else if (Array.isArray(body.functions)) {
		for (const fn of body.functions) {
			if (!isPlainObject(fn) || !fn.name) {
				throw new ProtocolError("function name is required");
			}
			tools.push({
				name: String(fn.name),
				description: fn.description ? String(fn.description) : undefined,
				input_schema: ensureObjectSchema(fn.parameters),
			});
		}
	}
	return tools.map(stripUndefined);
}

function openaiToolChoice(choice, parallel) {
	let mapped;
	if (choice == null || choice === "") mapped = undefined;
	else if (choice === "auto") mapped = { type: "auto" };
	else if (choice === "none") mapped = { type: "none" };
	else if (choice === "required") mapped = { type: "any" };
	else if (isPlainObject(choice)) {
		const type = choice.type;
		const name = choice.function?.name || choice.name;
		if (
			name &&
			(type === "function" || type === "tool" || type == null || type === "")
		) {
			mapped = { type: "tool", name: String(name) };
		} else if (type === "auto" || type === "none" || type === "any") {
			mapped = { type };
		} else {
			throw new ProtocolError("unsupported OpenAI tool_choice");
		}
	} else {
		throw new ProtocolError("unsupported OpenAI tool_choice");
	}
	if (parallel === false) {
		mapped = {
			...(mapped || { type: "auto" }),
			disable_parallel_tool_use: true,
		};
	}
	return mapped;
}

function openaiStop(stop) {
	if (stop == null || stop === "") return [];
	if (typeof stop === "string") return [stop];
	if (Array.isArray(stop)) return stop.map(String);
	throw new ProtocolError("stop must be a string or array of strings");
}

function openaiEffort(value) {
	if (value == null || value === "") return undefined;
	const key = String(value).toLowerCase();
	if (!(key in OPENAI_EFFORT)) {
		throw new ProtocolError(`unsupported reasoning_effort: ${value}`);
	}
	return OPENAI_EFFORT[key] || undefined;
}

function openaiThinking(body) {
	if (body.reasoning_effort === "none") return { type: "disabled" };
	const thinking = body.thinking;
	if (thinking == null) return undefined;
	return normalizeThinking(thinking);
}

function openaiOutputFormat(responseFormat) {
	if (responseFormat == null) return undefined;
	if (typeof responseFormat === "string") {
		if (responseFormat === "text") return undefined;
		if (responseFormat === "json_object") {
			return { type: "json_schema", schema: { type: "object" } };
		}
		throw new ProtocolError(`unsupported response_format: ${responseFormat}`);
	}
	if (!isPlainObject(responseFormat)) {
		throw new ProtocolError("response_format must be an object");
	}
	const type = responseFormat.type;
	if (!type || type === "text") return undefined;
	if (type === "json_object") {
		return { type: "json_schema", schema: { type: "object" } };
	}
	if (type === "json_schema") {
		const spec = responseFormat.json_schema || responseFormat;
		const schema = spec.schema;
		if (!isPlainObject(schema)) {
			throw new ProtocolError("json_schema.schema is required");
		}
		const format = { type: "json_schema", schema };
		if (spec.name) format.name = String(spec.name);
		if (spec.strict === true) format.strict = true;
		return format;
	}
	throw new ProtocolError(`unsupported response_format type: ${type}`);
}

function imageFromOpenAI(imageUrl) {
	const spec = typeof imageUrl === "string" ? { url: imageUrl } : imageUrl;
	if (!isPlainObject(spec) || typeof spec.url !== "string" || !spec.url) {
		throw new ProtocolError("image_url.url is required");
	}
	const url = spec.url;
	if (url.startsWith("data:")) {
		const parsed = parseDataUrl(url);
		const mediaType = normalizeImageType(parsed.mediaType);
		if (!parsed.isBase64) {
			throw new ProtocolError("image data URLs must be base64");
		}
		return {
			type: "image",
			source: { type: "base64", media_type: mediaType, data: parsed.data },
		};
	}
	if (!isHttpUrl(url)) {
		throw new ProtocolError(
			`unsupported image URL scheme: ${url.slice(0, 32)}`,
		);
	}
	return { type: "image", source: { type: "url", url } };
}

function documentFromOpenAI(file) {
	if (!isPlainObject(file))
		throw new ProtocolError("file part must be an object");
	if (file.file_id) {
		return {
			type: "document",
			source: { type: "file", file_id: String(file.file_id) },
		};
	}
	const dataUrl = firstDefined(file.file_data, file.data);
	if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
		const parsed = parseDataUrl(dataUrl);
		const mediaType = parsed.mediaType || guessMedia(file.filename);
		return documentFromBase64(
			mediaType,
			parsed.data,
			parsed.isBase64,
			file.filename,
		);
	}
	if (typeof file.data === "string" && file.media_type) {
		return documentFromBase64(file.media_type, file.data, true, file.filename);
	}
	throw new ProtocolError("file part requires file_id or file_data data URL");
}

function geminiContentToMessage(content, ids) {
	const roleIn = content.role || "user";
	const role =
		roleIn === "model" || roleIn === "assistant" ? "assistant" : "user";
	if (
		roleIn &&
		roleIn !== "user" &&
		roleIn !== "model" &&
		roleIn !== "assistant"
	) {
		throw new ProtocolError(`unsupported Gemini role: ${roleIn}`);
	}
	const parts = geminiParts(content);
	const blocks = [];
	let pendingSignature = null;
	for (const part of parts) {
		if (part == null) continue;
		if (typeof part === "string") {
			if (part) blocks.push({ type: "text", text: part });
			continue;
		}
		if (!isPlainObject(part)) {
			throw new ProtocolError("Gemini part must be an object");
		}
		const thoughtSignature = firstDefined(
			part.thoughtSignature,
			part.thought_signature,
		);
		const text = part.text;
		const thought = part.thought === true;
		const inline = firstDefined(part.inlineData, part.inline_data);
		const file = firstDefined(part.fileData, part.file_data);
		const call = firstDefined(part.functionCall, part.function_call);
		const response = firstDefined(
			part.functionResponse,
			part.function_response,
		);
		const exec = firstDefined(part.executableCode, part.executable_code);
		const execResult = firstDefined(
			part.codeExecutionResult,
			part.code_execution_result,
		);
		const video = firstDefined(part.videoMetadata, part.video_metadata);

		if (exec || execResult) {
			throw new ProtocolError("Gemini code execution parts are not supported");
		}
		if (video && !inline && !file && text == null && !call && !response) {
			throw new ProtocolError("Gemini video parts are not supported");
		}

		if (call) {
			const name = call.name;
			if (!name) throw new ProtocolError("functionCall.name is required");
			const id = ids.takeCallId(name, firstDefined(call.id, call.callId));
			const input = firstDefined(call.args, call.arguments, {});
			if (input != null && typeof input !== "object") {
				throw new ProtocolError("functionCall.args must be an object");
			}
			blocks.push({
				type: "tool_use",
				id,
				name: String(name),
				input: input ?? {},
			});
			if (thoughtSignature) pendingSignature = String(thoughtSignature);
			continue;
		}
		if (response) {
			const name = response.name;
			if (!name) throw new ProtocolError("functionResponse.name is required");
			const id = ids.takeResponseId(
				name,
				firstDefined(response.id, response.callId),
			);
			blocks.push({
				type: "tool_result",
				tool_use_id: id,
				content: geminiFunctionResponseContent(response),
			});
			continue;
		}
		if (inline) {
			blocks.push(partFromInlineData(inline));
			continue;
		}
		if (file) {
			blocks.push(partFromFileData(file));
			continue;
		}
		if (part.redactedThought === true || part.redacted_thought === true) {
			const data = String(firstDefined(thoughtSignature, part.data, ""));
			const block = { type: "redacted_thinking", data };
			for (const [key, value] of Object.entries(part)) {
				if (
					key === "type" ||
					key === "text" ||
					key === "thought" ||
					key === "data" ||
					key === "thoughtSignature" ||
					key === "thought_signature" ||
					key === "redactedThought" ||
					key === "redacted_thought"
				) {
					continue;
				}
				if (!(key in block)) block[key] = value;
			}
			blocks.push(block);
			continue;
		}
		if (typeof thoughtSignature === "string" && text == null && !thought) {
			attachSignature(blocks, thoughtSignature);
			continue;
		}
		if (typeof text === "string") {
			if (thought) {
				const block = { type: "thinking", thinking: text };
				if (thoughtSignature) block.signature = String(thoughtSignature);
				blocks.push(block);
			} else if (text) {
				blocks.push({ type: "text", text });
			}
			continue;
		}
		if (Object.keys(part).length === 0) continue;
		throw new ProtocolError(
			`unsupported Gemini part: ${Object.keys(part).join(",") || "(empty)"}`,
		);
	}
	foldTrailingMediaIntoToolResults(blocks);
	if (pendingSignature) attachSignature(blocks, pendingSignature);
	if (blocks.length === 0) return null;
	return { role, content: blocks };
}

function geminiParts(content) {
	if (typeof content === "string") return [{ text: content }];
	if (Array.isArray(content.parts)) return content.parts;
	if (content.parts == null) {
		if (
			content.text != null ||
			content.functionCall ||
			content.inlineData ||
			content.fileData
		) {
			return [content];
		}
		return [];
	}
	throw new ProtocolError("Gemini content.parts must be an array");
}

function geminiToolResultContent(payload) {
	if (payload == null) return "";
	if (typeof payload === "string") return payload;
	if (Array.isArray(payload)) return jsonString(payload);
	if (isPlainObject(payload)) {
		if (
			typeof payload.content === "string" &&
			Object.keys(payload).length === 1
		) {
			return payload.content;
		}
		return jsonString(payload);
	}
	return String(payload);
}

function partFromInlineData(inline) {
	if (!isPlainObject(inline) || typeof inline.data !== "string") {
		throw new ProtocolError("inlineData requires base64 data");
	}
	const mediaType = String(firstDefined(inline.mimeType, inline.mime_type, ""));
	if (!mediaType) throw new ProtocolError("inlineData.mimeType is required");
	if (isImageType(mediaType)) {
		return {
			type: "image",
			source: {
				type: "base64",
				media_type: normalizeImageType(mediaType),
				data: inline.data,
			},
		};
	}
	return documentFromBase64(mediaType, inline.data, true);
}

function partFromFileData(file) {
	if (!isPlainObject(file))
		throw new ProtocolError("fileData must be an object");
	const uri = String(firstDefined(file.fileUri, file.file_uri, file.uri, ""));
	const mediaType = String(firstDefined(file.mimeType, file.mime_type, ""));
	if (!uri) throw new ProtocolError("fileData.fileUri is required");
	if (!isHttpUrl(uri)) {
		throw new ProtocolError(
			`Gemini fileUri is not fetchable by Anthropic (${uri.slice(0, 48)}). Use https URLs or inlineData`,
		);
	}
	if (isImageType(mediaType) || isImagePath(uri)) {
		return { type: "image", source: { type: "url", url: uri } };
	}
	if (mediaType && !isDocumentType(mediaType) && mediaType !== "") {
		if (mediaType.startsWith("audio/") || mediaType.startsWith("video/")) {
			throw new ProtocolError(`unsupported Gemini MIME type: ${mediaType}`);
		}
	}
	const source = { type: "url", url: uri };
	if (mediaType) source.media_type = mediaType;
	return { type: "document", source };
}

function documentFromBase64(mediaType, data, isBase64 = true, title) {
	const type = mediaType || "application/pdf";
	if (type.startsWith("audio/") || type.startsWith("video/")) {
		throw new ProtocolError(`unsupported MIME type: ${type}`);
	}
	if (type.startsWith("image/")) {
		return {
			type: "image",
			source: {
				type: "base64",
				media_type: normalizeImageType(type),
				data,
			},
		};
	}
	if (type.startsWith("text/") && isBase64) {
		const text = Buffer.from(data, "base64").toString("utf8");
		const block = {
			type: "document",
			source: { type: "text", media_type: type, data: text },
		};
		if (title) block.title = String(title);
		return block;
	}
	if (!isDocumentType(type) && type !== "application/octet-stream") {
		throw new ProtocolError(`unsupported document MIME type: ${type}`);
	}
	if (!isBase64) {
		throw new ProtocolError("binary documents must be base64 encoded");
	}
	const block = {
		type: "document",
		source: {
			type: "base64",
			media_type:
				type === "application/octet-stream" ? "application/pdf" : type,
			data,
		},
	};
	if (title) block.title = String(title);
	return block;
}

function geminiSystem(instruction) {
	if (instruction == null) return undefined;
	if (typeof instruction === "string") return instruction;
	if (!isPlainObject(instruction)) {
		throw new ProtocolError("systemInstruction must be an object or string");
	}
	const parts = geminiParts(instruction);
	const texts = [];
	for (const part of parts) {
		if (typeof part === "string") {
			if (part) texts.push(part);
			continue;
		}
		if (isPlainObject(part) && typeof part.text === "string") {
			texts.push(part.text);
			continue;
		}
		throw new ProtocolError("systemInstruction may only contain text parts");
	}
	const joined = texts.join("\n");
	return joined ? joined : undefined;
}

function geminiTools(tools) {
	if (tools == null) return [];
	const mapped = [];
	for (const tool of asArray(tools)) {
		if (!isPlainObject(tool)) throw new ProtocolError("tool must be an object");
		const builtins = Object.keys(tool).filter(
			(key) =>
				![
					"functionDeclarations",
					"function_declarations",
					"functions",
					"name",
					"description",
					"parameters",
					"parametersJsonSchema",
					"parameters_json_schema",
				].includes(key),
		);
		const hasFn =
			tool.functionDeclarations ||
			tool.function_declarations ||
			tool.functions ||
			tool.name;
		if (builtins.length && !hasFn) {
			throw new ProtocolError(
				`unsupported Gemini built-in tool: ${builtins.join(",")}`,
			);
		}
		if (builtins.length && hasFn) {
			throw new ProtocolError(
				`unsupported Gemini built-in tool mixed with functions: ${builtins.join(",")}`,
			);
		}
		const decls = asArray(
			firstDefined(
				tool.functionDeclarations,
				tool.function_declarations,
				tool.functions,
			),
		);
		if (tool.name && decls.length === 0) decls.push(tool);
		for (const decl of decls) {
			if (!isPlainObject(decl) || !decl.name) {
				throw new ProtocolError("functionDeclarations[].name is required");
			}
			const schema = firstDefined(
				decl.parametersJsonSchema,
				decl.parameters_json_schema,
				decl.parameters,
			);
			const item = {
				name: String(decl.name),
				input_schema: ensureObjectSchema(schema),
			};
			if (decl.description) item.description = String(decl.description);
			mapped.push(item);
		}
	}
	return mapped;
}

function geminiToolChoice(toolConfig) {
	if (!isPlainObject(toolConfig)) return undefined;
	const fcc = firstDefined(
		toolConfig.functionCallingConfig,
		toolConfig.function_calling_config,
	);
	if (!isPlainObject(fcc)) {
		const extra = Object.keys(toolConfig);
		if (extra.length) {
			throw new ProtocolError(
				`unsupported Gemini toolConfig fields: ${extra.join(",")}`,
			);
		}
		return undefined;
	}
	const mode = String(fcc.mode || "AUTO").toUpperCase();
	const allowed = asArray(
		firstDefined(fcc.allowedFunctionNames, fcc.allowed_function_names),
	).map(String);
	if (mode === "NONE") return { type: "none" };
	if (mode === "AUTO") return { type: "auto" };
	if (mode === "ANY" || mode === "REQUIRED") {
		if (allowed.length > 1) {
			throw new ProtocolError(
				"Gemini ANY with multiple allowedFunctionNames is not representable as Anthropic tool_choice",
			);
		}
		if (allowed.length === 1) return { type: "tool", name: allowed[0] };
		return { type: "any" };
	}
	throw new ProtocolError(
		`unsupported Gemini functionCallingConfig.mode: ${fcc.mode}`,
	);
}

function geminiThinking(config) {
	if (config == null) return undefined;
	if (!isPlainObject(config)) {
		throw new ProtocolError("thinkingConfig must be an object");
	}
	const budget = firstDefined(config.thinkingBudget, config.thinking_budget);
	if (budget == null) return { type: "adaptive" };
	if (typeof budget !== "number" || !Number.isInteger(budget)) {
		throw new ProtocolError("thinkingBudget must be an integer");
	}
	if (budget === 0) return { type: "disabled" };
	if (budget < 0) return { type: "adaptive" };
	return { type: "enabled", budget_tokens: budget };
}

function geminiOutputFormat(gen) {
	const mime = firstDefined(gen.responseMimeType, gen.response_mime_type);
	const schema = firstDefined(
		gen.responseJsonSchema,
		gen.response_json_schema,
		gen.responseSchema,
		gen.response_schema,
	);
	if (schema != null) {
		if (!isPlainObject(schema) && !Array.isArray(schema)) {
			throw new ProtocolError("responseSchema must be a JSON schema object");
		}
		return { type: "json_schema", schema };
	}
	if (!mime || mime === "text/plain") return undefined;
	if (mime === "application/json") {
		return { type: "json_schema", schema: { type: "object" } };
	}
	throw new ProtocolError(`unsupported responseMimeType: ${mime}`);
}

function normalizeGeminiContents(contents) {
	if (contents == null) {
		throw new ProtocolError("contents is required");
	}
	if (typeof contents === "string") {
		return [{ role: "user", parts: [{ text: contents }] }];
	}
	const list = asArray(contents);
	if (list.length === 0)
		throw new ProtocolError("contents must be a non-empty array");
	return list.map((item) => {
		if (typeof item === "string")
			return { role: "user", parts: [{ text: item }] };
		if (!isPlainObject(item)) {
			throw new ProtocolError("each contents item must be an object or string");
		}
		if (
			!item.parts &&
			(item.text != null ||
				item.functionCall ||
				item.functionResponse ||
				item.inlineData ||
				item.fileData)
		) {
			return { role: item.role || "user", parts: [item] };
		}
		return item;
	});
}

function createGeminiIdState() {
	const counts = new Map();
	const queues = new Map();
	function nextId(name) {
		const n = (counts.get(name) || 0) + 1;
		counts.set(name, n);
		return `call_${name}_${n}`;
	}
	function queue(name) {
		if (!queues.has(name)) queues.set(name, []);
		return queues.get(name);
	}
	return {
		takeCallId(name, explicit) {
			const id = explicit ? String(explicit) : nextId(name);
			queue(name).push(id);
			return id;
		},
		takeResponseId(name, explicit) {
			const q = queue(name);
			if (explicit) {
				const want = String(explicit);
				const i = q.indexOf(want);
				if (i >= 0) q.splice(i, 1);
				return want;
			}
			if (q.length) return q.shift();
			return nextId(name);
		},
	};
}

function attachSignature(blocks, signature) {
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (blocks[i].type === "thinking") {
			if (!blocks[i].signature) blocks[i].signature = signature;
			return;
		}
	}
	blocks.push({ type: "thinking", thinking: "", signature });
}

function foldTrailingMediaIntoToolResults(blocks) {
	let write = 0;
	for (const block of blocks) {
		const prev = write > 0 ? blocks[write - 1] : null;
		if (
			prev?.type === "tool_result" &&
			(block.type === "image" || block.type === "document")
		) {
			prev.content = appendToolResultMedia(prev.content, block);
			continue;
		}
		blocks[write++] = block;
	}
	blocks.length = write;
}

function appendToolResultMedia(content, block) {
	if (Array.isArray(content)) return [...content, block];
	if (typeof content === "string" && content) {
		return [{ type: "text", text: content }, block];
	}
	return [block];
}

function geminiFunctionResponseContent(response) {
	const payload = firstDefined(response.response, response.content);
	const textish = geminiToolResultContent(payload);
	const media = [];
	for (const item of asArray(
		firstDefined(response.parts, response.contentParts),
	)) {
		media.push(...geminiFunctionResponsePart(item));
	}
	if (!media.length) return textish;
	const folded = [];
	if (typeof textish === "string" && textish)
		folded.push({ type: "text", text: textish });
	else if (Array.isArray(textish)) folded.push(...textish);
	folded.push(...media);
	return folded;
}

function geminiFunctionResponsePart(item) {
	if (item == null) return [];
	if (typeof item === "string")
		return item ? [{ type: "text", text: item }] : [];
	if (!isPlainObject(item)) {
		throw new ProtocolError("functionResponse.parts entry must be an object");
	}
	const inline = firstDefined(item.inlineData, item.inline_data);
	const file = firstDefined(item.fileData, item.file_data);
	if (inline) return [partFromInlineData(inline)];
	if (file) return [partFromFileData(file)];
	if (typeof item.text === "string") return [{ type: "text", text: item.text }];
	if (Object.keys(item).length === 0) return [];
	return [{ type: "text", text: jsonString(item) }];
}

function collapseToolResults(messages) {
	const out = [];
	for (const msg of messages) {
		const prev = out[out.length - 1];
		if (
			msg.role === "user" &&
			prev &&
			prev.role === "user" &&
			isToolResultOnly(prev.content) &&
			isToolResultOnly(msg.content)
		) {
			prev.content = [...asBlocks(prev.content), ...asBlocks(msg.content)];
			continue;
		}
		out.push(msg);
	}
	return out;
}

function isToolResultOnly(content) {
	const blocks = asBlocks(content);
	return (
		blocks.length > 0 && blocks.every((block) => block.type === "tool_result")
	);
}

function asBlocks(content) {
	if (typeof content === "string") {
		return content ? [{ type: "text", text: content }] : [];
	}
	return Array.isArray(content) ? content : [];
}

function normalizeAnthropicTool(tool) {
	if (!isPlainObject(tool)) throw new ProtocolError("tool must be an object");
	const type = tool.type;
	if (type && type !== "custom") return tool;
	if (!tool.name) throw new ProtocolError("tool name is required");
	return {
		...tool,
		name: String(tool.name),
		input_schema: ensureObjectSchema(tool.input_schema),
	};
}

function normalizeToolResultBlock(block) {
	if (!block.tool_use_id) {
		throw new ProtocolError("tool_result requires tool_use_id");
	}
	const out = {
		...block,
		type: "tool_result",
		tool_use_id: String(block.tool_use_id),
	};
	if (out.content == null) out.content = "";
	return out;
}

function normalizeImageBlock(block) {
	const source = block.source;
	if (!isPlainObject(source) || !source.type) {
		throw new ProtocolError("image source is required");
	}
	if (source.type === "base64") {
		if (!source.data) throw new ProtocolError("image base64 data is required");
		const mediaType = normalizeImageType(source.media_type || source.mediaType);
		return {
			...block,
			source: { ...source, type: "base64", media_type: mediaType },
		};
	}
	if (source.type === "url") {
		if (!isHttpUrl(source.url)) {
			throw new ProtocolError("image URL must be http(s)");
		}
		return block;
	}
	if (source.type === "file") {
		if (!source.file_id && !source.fileId) {
			throw new ProtocolError("image file source requires file_id");
		}
		return block;
	}
	throw new ProtocolError(`unsupported image source type: ${source.type}`);
}

function normalizeDocumentBlock(block) {
	const source = block.source;
	if (!isPlainObject(source) || !source.type) {
		throw new ProtocolError("document source is required");
	}
	if (source.type === "url" && source.url && !isHttpUrl(source.url)) {
		throw new ProtocolError("document URL must be http(s)");
	}
	if (source.type === "base64" && !source.data) {
		throw new ProtocolError("document base64 data is required");
	}
	return block;
}

function normalizeThinking(thinking) {
	if (!isPlainObject(thinking) || !thinking.type) {
		throw new ProtocolError("thinking must be an object with type");
	}
	const type = thinking.type;
	if (type === "disabled" || type === "adaptive") return { ...thinking, type };
	if (type === "enabled") {
		const budget = firstDefined(thinking.budget_tokens, thinking.budgetTokens);
		if (budget == null) {
			throw new ProtocolError("thinking.type=enabled requires budget_tokens");
		}
		return {
			...thinking,
			type: "enabled",
			budget_tokens: requirePositiveInt(budget, "thinking.budget_tokens"),
		};
	}
	throw new ProtocolError(`unsupported thinking.type: ${type}`);
}

function normalizeOutputConfig(config) {
	if (!isPlainObject(config)) {
		throw new ProtocolError("output_config must be an object");
	}
	const out = { ...config };
	if (out.effort != null) {
		const effort = String(out.effort).toLowerCase();
		if (!ANTHROPIC_EFFORT.has(effort)) {
			throw new ProtocolError(
				`unsupported output_config.effort: ${out.effort}`,
			);
		}
		out.effort = effort;
	}
	if (
		out.format != null &&
		!isPlainObject(out.format) &&
		typeof out.format !== "string"
	) {
		throw new ProtocolError("output_config.format must be an object");
	}
	if (out.task_budget != null) {
		const budget = out.task_budget;
		if (!isPlainObject(budget) || budget.type !== "tokens") {
			throw new ProtocolError(
				'output_config.task_budget must be {type:"tokens", total}',
			);
		}
		budget.total = requirePositiveInt(budget.total, "task_budget.total");
	}
	return out;
}

function validateTokenBudget(maxTokens, thinking) {
	if (maxTokens != null) requirePositiveInt(maxTokens, "max_tokens");
	if (
		thinking &&
		thinking.type === "enabled" &&
		maxTokens != null &&
		thinking.budget_tokens >= maxTokens
	) {
		throw new ProtocolError(
			"thinking.budget_tokens must be less than max_tokens",
		);
	}
}

function constrainThinkingSampling(out) {
	if (!out.thinking?.type || out.thinking.type === "disabled") return;
	if (out.temperature == null) return;
	if (out.temperature !== 1) {
		throw new ProtocolError(
			"temperature is incompatible with thinking; omit temperature or set it to 1",
		);
	}
}

function rejectUnsupportedAnthropicRequest(body) {
	if (body.n != null && body.n !== 1) {
		throw new ProtocolError("n > 1 is not supported");
	}
}

function rejectUnsupportedOpenAIRequest(body) {
	if (body.n != null && body.n !== 1) {
		throw new ProtocolError("n > 1 is not supported");
	}
	if (
		Array.isArray(body.modalities) &&
		body.modalities.some((m) => m !== "text")
	) {
		throw new ProtocolError(
			`unsupported OpenAI modalities: ${body.modalities.join(",")}`,
		);
	}
	if (body.audio != null)
		throw new ProtocolError("OpenAI audio options are not supported");
	if (body.logit_bias != null) {
		throw new ProtocolError(
			"logit_bias is not representable on Anthropic Messages",
		);
	}
	if (body.seed != null) {
		throw new ProtocolError("seed is not representable on Anthropic Messages");
	}
	if (body.presence_penalty != null || body.frequency_penalty != null) {
		throw new ProtocolError(
			"presence_penalty/frequency_penalty are not representable on Anthropic Messages",
		);
	}
	if (body.logprobs === true || body.top_logprobs != null) {
		throw new ProtocolError(
			"logprobs is not representable on Anthropic Messages",
		);
	}
	if (body.prediction != null) {
		throw new ProtocolError("predicted outputs are not supported");
	}
}

function rejectUnsupportedGeminiRequest(body) {
	const gen = firstDefined(body.generationConfig, body.generation_config) || {};
	const count = firstDefined(gen.candidateCount, gen.candidate_count);
	if (count != null && count !== 1) {
		throw new ProtocolError("candidateCount > 1 is not supported");
	}
	if (body.cachedContent || body.cached_content) {
		throw new ProtocolError("Gemini cachedContent is not supported");
	}
	const safety = firstDefined(body.safetySettings, body.safety_settings);
	if (Array.isArray(safety) && safety.length) {
		throw new ProtocolError(
			"Gemini safetySettings are not representable on Anthropic Messages",
		);
	}
	if (gen.responseLogprobs || gen.response_logprobs) {
		throw new ProtocolError(
			"responseLogprobs is not representable on Anthropic Messages",
		);
	}
	if (
		gen.presencePenalty != null ||
		gen.frequencyPenalty != null ||
		gen.presence_penalty != null ||
		gen.frequency_penalty != null
	) {
		throw new ProtocolError(
			"Gemini presencePenalty/frequencyPenalty are not representable on Anthropic Messages",
		);
	}
}

function formatAnthropicMessage(message) {
	const usage = formatAnthropicUsage(message.usage);
	const out = {
		id: message.id ?? "",
		type: message.type ?? "message",
		role: message.role ?? "assistant",
		model: message.model ?? "",
		content: Array.isArray(message.content) ? message.content : [],
		stop_reason: message.stop_reason ?? null,
		stop_sequence: message.stop_sequence ?? null,
		usage,
	};
	for (const [key, value] of Object.entries(message)) {
		if (key in out) continue;
		if (key === "stack" || key === "cause") continue;
		out[key] = value;
	}
	return out;
}

function formatOpenAIResponse(message) {
	const { text, toolCalls, reasoning, contentParts, structuredThinking } =
		collectAssistantOutput(message.content);
	const choice = {
		index: 0,
		message: {
			role: "assistant",
			content: structuredThinking
				? contentParts
				: text === ""
					? toolCalls.length
						? null
						: ""
					: text,
		},
		finish_reason: openaiFinish(message.stop_reason),
		logprobs: null,
	};
	if (toolCalls.length) choice.message.tool_calls = toolCalls;
	if (reasoning && !structuredThinking)
		choice.message.reasoning_content = reasoning;
	const usage = openaiUsage(message.usage, reasoning);
	return {
		id: openaiResponseId(message.id),
		object: "chat.completion",
		created: unixNow(),
		model: message.model ?? "",
		choices: [choice],
		usage,
	};
}

function formatGeminiResponse(message) {
	const parts = geminiPartsFromBlocks(message.content);
	const finishReason = geminiFinish(message.stop_reason);
	const candidate = {
		content: { role: "model", parts: parts.length ? parts : [{ text: "" }] },
		finishReason,
		index: 0,
	};
	const out = { candidates: [candidate] };
	const usage = geminiUsage(message.usage, message.content);
	if (usage) out.usageMetadata = usage;
	if (message.model) out.modelVersion = message.model;
	return out;
}

function collectAssistantOutput(content) {
	const blocks = Array.isArray(content) ? content : [];
	let text = "";
	const toolCalls = [];
	let reasoning = "";
	const contentParts = [];
	let structuredThinking = false;
	for (const block of blocks) {
		if (!isPlainObject(block)) continue;
		if (block.type === "text") {
			text += block.text ?? "";
			contentParts.push({ ...block, type: "text", text: block.text ?? "" });
		} else if (block.type === "thinking") {
			reasoning += block.thinking ?? "";
			contentParts.push({
				...block,
				type: "thinking",
				thinking: block.thinking ?? "",
			});
			structuredThinking = true;
		} else if (block.type === "redacted_thinking") {
			contentParts.push({
				...block,
				type: "redacted_thinking",
				data: String(block.data ?? ""),
			});
			structuredThinking = true;
		} else if (block.type === "tool_use" || block.type === "server_tool_use") {
			toolCalls.push({
				id: String(block.id ?? ""),
				type: "function",
				function: {
					name: String(block.name ?? ""),
					arguments: jsonArgs(block.input),
				},
			});
		}
	}
	return {
		text,
		toolCalls,
		reasoning: reasoning || undefined,
		contentParts,
		structuredThinking,
	};
}

function geminiPartsFromBlocks(content) {
	const parts = [];
	for (const block of Array.isArray(content) ? content : []) {
		if (!isPlainObject(block)) continue;
		if (block.type === "text") {
			parts.push({ text: block.text ?? "" });
		} else if (block.type === "thinking") {
			parts.push({ text: block.thinking ?? "", thought: true });
			if (block.signature) parts.push({ thoughtSignature: block.signature });
		} else if (block.type === "redacted_thinking") {
			const part = {
				text: "",
				thought: true,
				redactedThought: true,
				thoughtSignature: String(block.data ?? ""),
			};
			for (const [key, value] of Object.entries(block)) {
				if (key === "type" || key === "data") continue;
				if (!(key in part)) part[key] = value;
			}
			parts.push(part);
		} else if (block.type === "tool_use" || block.type === "server_tool_use") {
			const call = {
				name: String(block.name ?? ""),
				args:
					isPlainObject(block.input) || Array.isArray(block.input)
						? block.input
						: {},
			};
			if (block.id) call.id = String(block.id);
			parts.push({ functionCall: call });
		} else if (block.type === "image") {
			const mapped = geminiPartFromImage(block);
			if (mapped) parts.push(mapped);
		} else if (block.type === "document") {
			const mapped = geminiPartFromDocument(block);
			if (mapped) parts.push(mapped);
		}
	}
	return parts;
}

function geminiPartFromImage(block) {
	const source = block.source;
	if (!isPlainObject(source)) return null;
	if (source.type === "base64") {
		return {
			inlineData: {
				mimeType: source.media_type || source.mediaType || "image/png",
				data: source.data,
			},
		};
	}
	if (source.type === "url" && source.url) {
		return {
			fileData: {
				mimeType: source.media_type || "image/jpeg",
				fileUri: source.url,
			},
		};
	}
	return null;
}

function geminiPartFromDocument(block) {
	const source = block.source;
	if (!isPlainObject(source)) return null;
	if (source.type === "base64") {
		return {
			inlineData: {
				mimeType: source.media_type || "application/pdf",
				data: source.data,
			},
		};
	}
	if (source.type === "text") {
		return {
			inlineData: {
				mimeType: source.media_type || "text/plain",
				data: Buffer.from(source.data || "", "utf8").toString("base64"),
			},
		};
	}
	if (source.type === "url" && source.url) {
		return {
			fileData: {
				mimeType: source.media_type || "application/pdf",
				fileUri: source.url,
			},
		};
	}
	return null;
}

function anthropicEncoder() {
	let stopped = false;
	let errored = false;
	return {
		push(event) {
			if (!isPlainObject(event)) return [];
			const type = event.type || "message";
			if (type === "message_stop") stopped = true;
			if (type === "error") errored = true;
			return [sseNamed(type, event)];
		},
		finish() {
			if (stopped || errored) return [];
			stopped = true;
			return [sseNamed("message_stop", { type: "message_stop" })];
		},
	};
}

function openaiEncoder({ model = "", id = "" } = {}) {
	const created = unixNow();
	let currentId = openaiResponseId(id);
	let currentModel = model;
	let roleSent = false;
	let finished = false;
	let done = false;
	let errored = false;
	let stopReason = null;
	const usage = { input: 0, output: 0, extra: null };
	const toolIndex = new Map();
	let nextTool = 0;
	const signatureSent = new Set();
	const structuredThinking = new Set();

	function chunk(delta, finish = null, extra = {}) {
		const body = {
			id: currentId,
			object: "chat.completion.chunk",
			created,
			model: currentModel,
			choices: [
				{
					index: 0,
					delta,
					finish_reason: finish,
				},
			],
		};
		Object.assign(body, extra);
		return sseData(body);
	}

	function assignTool(index) {
		if (!toolIndex.has(index)) toolIndex.set(index, nextTool++);
		return toolIndex.get(index);
	}

	return {
		push(event) {
			if (!isPlainObject(event)) return [];
			const type = event.type;
			if (type === "message_start") {
				const message = event.message || {};
				if (message.id) currentId = openaiResponseId(message.id);
				if (message.model) currentModel = message.model;
				mergeUsage(usage, message.usage);
				if (roleSent) return [];
				roleSent = true;
				return [chunk({ role: "assistant", content: "" })];
			}
			if (type === "content_block_start") {
				const index = eventIndex(event);
				const block = event.content_block || {};
				if (block.type === "text" && block.text) {
					return [chunk({ content: block.text })];
				}
				if (block.type === "thinking") {
					if (block.signature) {
						structuredThinking.add(index);
						signatureSent.add(index);
						const part = {
							type: "thinking",
							thinking: block.thinking ?? "",
							signature: block.signature,
						};
						for (const [key, value] of Object.entries(block)) {
							if (key === "type" || key in part) continue;
							part[key] = value;
						}
						return [chunk({ content: [part] })];
					}
					const thinking = block.thinking ?? "";
					return thinking ? [chunk({ reasoning_content: thinking })] : [];
				}
				if (block.type === "redacted_thinking") {
					structuredThinking.add(index);
					const part = {
						type: "redacted_thinking",
						data: String(block.data ?? ""),
					};
					for (const [key, value] of Object.entries(block)) {
						if (key === "type" || key in part) continue;
						part[key] = value;
					}
					return [chunk({ content: [part] })];
				}
				if (block.type === "tool_use" || block.type === "server_tool_use") {
					const ti = assignTool(index);
					return [
						chunk({
							tool_calls: [
								{
									index: ti,
									id: block.id ?? "",
									type: "function",
									function: { name: block.name ?? "", arguments: "" },
								},
							],
						}),
					];
				}
				return [];
			}
			if (type === "content_block_delta") {
				const index = eventIndex(event);
				const delta = event.delta || {};
				if (delta.type === "text_delta") {
					const text = delta.text ?? "";
					return text ? [chunk({ content: text })] : [];
				}
				if (delta.type === "thinking_delta") {
					const thinking = delta.thinking ?? "";
					if (!thinking) return [];
					if (structuredThinking.has(index)) {
						return [chunk({ content: [{ type: "thinking", thinking }] })];
					}
					return [chunk({ reasoning_content: thinking })];
				}
				if (delta.type === "signature_delta") {
					const signature = delta.signature ?? "";
					if (!signature || signatureSent.has(index)) return [];
					signatureSent.add(index);
					structuredThinking.add(index);
					return [chunk({ content: [{ type: "thinking", signature }] })];
				}
				if (delta.type === "input_json_delta") {
					const ti = assignTool(index);
					const partial = delta.partial_json ?? "";
					return [
						chunk({
							tool_calls: [{ index: ti, function: { arguments: partial } }],
						}),
					];
				}
				return [];
			}
			if (type === "message_delta") {
				const reason = event.delta?.stop_reason;
				if (reason != null) stopReason = reason;
				mergeUsage(usage, event.usage);
				return [];
			}
			if (type === "message_stop") {
				return flushOpenAIFinish();
			}
			if (type === "error") {
				errored = true;
				finished = true;
				const mapped = formatError("openai", streamError(event));
				return [sseData(mapped)];
			}
			return [];
		},
		finish() {
			const frames = [];
			if (!finished && !errored) frames.push(...flushOpenAIFinish());
			if (!done) {
				done = true;
				frames.push("data: [DONE]\n\n");
			}
			return frames;
		},
	};

	function flushOpenAIFinish() {
		if (finished) return [];
		finished = true;
		const frames = [chunk({}, openaiFinish(stopReason))];
		if (usage.input || usage.output || usage.extra) {
			frames.push(
				sseData({
					id: currentId,
					object: "chat.completion.chunk",
					created,
					model: currentModel,
					choices: [],
					usage: openaiUsage(
						{
							input_tokens: usage.input,
							output_tokens: usage.output,
							...(usage.extra || {}),
						},
						null,
					),
				}),
			);
		}
		return frames;
	}
}

function geminiEncoder({ model = "", id = "" } = {}) {
	void id;
	let currentModel = model;
	let finished = false;
	let errored = false;
	let stopReason = null;
	const usage = { input: 0, output: 0, extra: null };
	const toolBuf = new Map();
	const signatureSent = new Set();

	function emitParts(parts, extra = {}) {
		const candidate = {
			content: { role: "model", parts },
			index: 0,
			...extra,
		};
		const body = { candidates: [candidate] };
		if (currentModel) body.modelVersion = currentModel;
		return sseData(body);
	}

	return {
		push(event) {
			if (!isPlainObject(event)) return [];
			const type = event.type;
			if (type === "message_start") {
				const message = event.message || {};
				if (message.model) currentModel = message.model;
				mergeUsage(usage, message.usage);
				return [];
			}
			if (type === "content_block_start") {
				const index = eventIndex(event);
				const block = event.content_block || {};
				if (block.type === "text" && block.text) {
					return [emitParts([{ text: block.text }])];
				}
				if (block.type === "thinking") {
					const parts = [];
					if (block.thinking)
						parts.push({ text: block.thinking, thought: true });
					if (block.signature) {
						parts.push({ thoughtSignature: block.signature });
						signatureSent.add(index);
					}
					return parts.length ? [emitParts(parts)] : [];
				}
				if (block.type === "redacted_thinking") {
					const part = {
						text: "",
						thought: true,
						redactedThought: true,
						thoughtSignature: String(block.data ?? ""),
					};
					for (const [key, value] of Object.entries(block)) {
						if (key === "type" || key === "data") continue;
						if (!(key in part)) part[key] = value;
					}
					return [emitParts([part])];
				}
				if (block.type === "tool_use" || block.type === "server_tool_use") {
					toolBuf.set(index, {
						id: block.id ?? "",
						name: block.name ?? "",
						json: "",
						emitted: false,
					});
					return [];
				}
				return [];
			}
			if (type === "content_block_delta") {
				const index = eventIndex(event);
				const delta = event.delta || {};
				if (delta.type === "text_delta") {
					const text = delta.text ?? "";
					return text ? [emitParts([{ text }])] : [];
				}
				if (delta.type === "thinking_delta") {
					const thinking = delta.thinking ?? "";
					return thinking
						? [emitParts([{ text: thinking, thought: true }])]
						: [];
				}
				if (delta.type === "signature_delta") {
					const signature = delta.signature ?? "";
					if (!signature || signatureSent.has(index)) return [];
					signatureSent.add(index);
					return [emitParts([{ thoughtSignature: signature }])];
				}
				if (delta.type === "input_json_delta") {
					const state = toolBuf.get(index) || {
						id: "",
						name: "",
						json: "",
						emitted: false,
					};
					state.json += delta.partial_json ?? "";
					toolBuf.set(index, state);
					return [];
				}
				return [];
			}
			if (type === "content_block_stop") {
				const index = eventIndex(event);
				const state = toolBuf.get(index);
				if (!state || state.emitted) return [];
				state.emitted = true;
				let args = {};
				if (state.json) {
					try {
						args = JSON.parse(state.json);
					} catch {
						args = {};
					}
				}
				const functionCall = { name: state.name, args };
				if (state.id) functionCall.id = state.id;
				return [emitParts([{ functionCall }])];
			}
			if (type === "message_delta") {
				if (event.delta?.stop_reason != null)
					stopReason = event.delta.stop_reason;
				mergeUsage(usage, event.usage);
				return [];
			}
			if (type === "message_stop") {
				return flushGeminiFinish();
			}
			if (type === "error") {
				errored = true;
				finished = true;
				return [sseData(formatError("gemini", streamError(event)))];
			}
			return [];
		},
		finish() {
			if (finished || errored) return [];
			return flushGeminiFinish();
		},
	};

	function flushGeminiFinish() {
		if (finished) return [];
		finished = true;
		const leftover = [];
		for (const state of toolBuf.values()) {
			if (state.emitted) continue;
			state.emitted = true;
			let args = {};
			if (state.json) {
				try {
					args = JSON.parse(state.json);
				} catch {
					args = {};
				}
			}
			const functionCall = { name: state.name, args };
			if (state.id) functionCall.id = state.id;
			leftover.push({ functionCall });
		}
		const extra = { finishReason: geminiFinish(stopReason) };
		const usageMeta = geminiUsage(
			{
				input_tokens: usage.input,
				output_tokens: usage.output,
				...(usage.extra || {}),
			},
			null,
		);
		const candidate = {
			content: { role: "model", parts: leftover.length ? leftover : [] },
			finishReason: extra.finishReason,
			index: 0,
		};
		const body = { candidates: [candidate] };
		if (usageMeta) body.usageMetadata = usageMeta;
		if (currentModel) body.modelVersion = currentModel;
		return [sseData(body)];
	}
}

function openaiFinish(stop) {
	if (stop == null || stop === "") return null;
	switch (stop) {
		case "tool_use":
		case "tool_calls":
			return "tool_calls";
		case "max_tokens":
		case "length":
			return "length";
		case "refusal":
		case "content_filter":
			return "content_filter";
		case "pause_turn":
			return "stop";
		case "cancelled":
		case "canceled":
		case "abort":
		case "aborted":
			return null;
		default:
			return "stop";
	}
}

function geminiFinish(stop) {
	if (stop == null || stop === "") return "STOP";
	switch (stop) {
		case "max_tokens":
		case "length":
			return "MAX_TOKENS";
		case "refusal":
		case "content_filter":
			return "SAFETY";
		case "cancelled":
		case "canceled":
		case "abort":
		case "aborted":
			return "OTHER";
		default:
			return "STOP";
	}
}

function formatAnthropicUsage(usage) {
	const src = isPlainObject(usage) ? usage : {};
	const out = {
		input_tokens: num(src.input_tokens),
		output_tokens: num(src.output_tokens),
	};
	if (src.cache_creation_input_tokens) {
		out.cache_creation_input_tokens = num(src.cache_creation_input_tokens);
	}
	if (src.cache_read_input_tokens) {
		out.cache_read_input_tokens = num(src.cache_read_input_tokens);
	}
	for (const [key, value] of Object.entries(src)) {
		if (key in out || key === "prompt_tokens" || key === "completion_tokens")
			continue;
		out[key] = value;
	}
	return out;
}

function openaiUsage(usage, reasoning) {
	const src = isPlainObject(usage) ? usage : {};
	const prompt = num(firstDefined(src.input_tokens, src.prompt_tokens));
	const completion = num(
		firstDefined(src.output_tokens, src.completion_tokens),
	);
	const out = {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: prompt + completion,
	};
	const cached = num(
		firstDefined(src.cache_read_input_tokens, src.cached_tokens),
	);
	if (cached) out.prompt_tokens_details = { cached_tokens: cached };
	const reasoningTokens = num(src.reasoning_tokens);
	if (reasoningTokens || reasoning) {
		out.completion_tokens_details = {
			reasoning_tokens: reasoningTokens,
		};
	}
	return out;
}

function geminiUsage(usage, content) {
	const src = isPlainObject(usage) ? usage : {};
	const prompt = num(
		firstDefined(src.input_tokens, src.prompt_tokens, src.promptTokenCount),
	);
	const completion = num(
		firstDefined(
			src.output_tokens,
			src.completion_tokens,
			src.candidatesTokenCount,
		),
	);
	const cached = num(
		firstDefined(src.cache_read_input_tokens, src.cachedContentTokenCount),
	);
	let thoughts = num(firstDefined(src.thoughts_tokens, src.thoughtsTokenCount));
	if (!thoughts && Array.isArray(content)) {
		const hasThought = content.some((block) => block?.type === "thinking");
		if (hasThought) thoughts = 0;
	}
	if (!prompt && !completion && !cached) return undefined;
	const out = {
		promptTokenCount: prompt,
		candidatesTokenCount: completion,
		totalTokenCount: prompt + completion,
	};
	if (cached) out.cachedContentTokenCount = cached;
	if (thoughts) out.thoughtsTokenCount = thoughts;
	return out;
}

function mergeUsage(target, usage) {
	if (!isPlainObject(usage)) return;
	const input = num(firstDefined(usage.input_tokens, usage.prompt_tokens));
	const output = num(
		firstDefined(usage.output_tokens, usage.completion_tokens),
	);
	if (input) target.input = input;
	if (output) target.output = output;
	const extra = { ...usage };
	delete extra.input_tokens;
	delete extra.output_tokens;
	delete extra.prompt_tokens;
	delete extra.completion_tokens;
	if (Object.keys(extra).length) {
		target.extra = { ...(target.extra || {}), ...extra };
	}
}

function streamError(event) {
	const err = event.error;
	if (isPlainObject(err)) {
		return new ProtocolError(err.message || "stream error", {
			status: errorStatus(err.type, 500),
			type: err.type || "api_error",
		});
	}
	return new ProtocolError(event.message || "stream error", {
		status: 500,
		type: "api_error",
	});
}

function inspectError(error) {
	if (typeof error === "string") {
		return { status: 500, type: "api_error", message: sanitizeMessage(error) };
	}
	if (error == null || typeof error !== "object") {
		return { status: 500, type: "api_error", message: "internal error" };
	}
	const statusNum = Number(error.status);
	const status =
		Number.isInteger(statusNum) && statusNum > 0
			? statusNum
			: errorStatus(error.type, 500);
	const type =
		error.type || (status >= 500 ? "api_error" : "invalid_request_error");
	return {
		status,
		type,
		message: sanitizeMessage(error.message || "error"),
	};
}

function errorStatus(type, fallback) {
	switch (type) {
		case "invalid_request_error":
			return 400;
		case "authentication_error":
			return 401;
		case "permission_error":
			return 403;
		case "not_found_error":
			return 404;
		case "rate_limit_error":
			return 429;
		case "timeout_error":
			return 504;
		case "overloaded_error":
			return 529;
		case "api_error":
			return 500;
		default:
			return fallback;
	}
}

function openaiErrorCode(type, status) {
	if (type === "rate_limit_error") return "rate_limit_exceeded";
	if (type === "authentication_error") return "invalid_api_key";
	if (status === 409) return "conflict";
	return null;
}

function geminiStatus(type, status) {
	if (status === 409) return "ABORTED";
	if (status === 499 || type === "cancelled" || type === "canceled")
		return "CANCELLED";
	if (type === "invalid_request_error" || status === 400)
		return "INVALID_ARGUMENT";
	if (type === "authentication_error" || status === 401)
		return "UNAUTHENTICATED";
	if (type === "permission_error" || status === 403) return "PERMISSION_DENIED";
	if (type === "not_found_error" || status === 404) return "NOT_FOUND";
	if (type === "rate_limit_error" || status === 429)
		return "RESOURCE_EXHAUSTED";
	if (type === "overloaded_error" || status === 503 || status === 529)
		return "UNAVAILABLE";
	if (type === "timeout_error" || status === 504) return "DEADLINE_EXCEEDED";
	return "INTERNAL";
}

function sanitizeMessage(message) {
	let text = String(message ?? "error");
	text = text.replace(SECRET_RE, "[redacted]");
	text = text.replace(SECRET_KV_RE, (full, value) =>
		full.replace(value, "[redacted]"),
	);
	if (text.length > 4000) text = `${text.slice(0, 4000)}…`;
	return text;
}

function ensureObjectSchema(schema) {
	if (schema == null || schema === "") {
		return cloneJson(EMPTY_SCHEMA);
	}
	if (!isPlainObject(schema)) {
		throw new ProtocolError("tool JSON schema must be an object");
	}
	if (Object.keys(schema).length === 0) return cloneJson(EMPTY_SCHEMA);
	if (!schema.type) return { type: "object", properties: {}, ...schema };
	return schema;
}

function parseToolArguments(raw, label) {
	try {
		return JSON.parse(raw);
	} catch {
		throw new ProtocolError(`${label} arguments must be valid JSON`);
	}
}

function parseDataUrl(url) {
	const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
	if (!match) throw new ProtocolError("invalid data URL");
	return {
		mediaType: match[1] || "application/octet-stream",
		isBase64: Boolean(match[2]),
		data: match[3],
	};
}

function normalizeImageType(mediaType) {
	const type = String(mediaType || "").toLowerCase();
	if (type === "image/jpg") return "image/jpeg";
	if (!IMAGE_TYPES.has(type)) {
		throw new ProtocolError(
			`unsupported image media type: ${mediaType || "(missing)"}`,
		);
	}
	return type === "image/jpg" ? "image/jpeg" : type;
}

function isImageType(mediaType) {
	const type = String(mediaType || "").toLowerCase();
	return IMAGE_TYPES.has(type) || type === "image/jpg";
}

function isDocumentType(mediaType) {
	return DOCUMENT_TYPES.has(String(mediaType || "").toLowerCase());
}

function isImagePath(uri) {
	return /\.(png|jpe?g|gif|webp)(\?|$)/i.test(uri);
}

function guessMedia(filename) {
	const name = String(filename || "").toLowerCase();
	if (name.endsWith(".pdf")) return "application/pdf";
	if (name.endsWith(".txt")) return "text/plain";
	if (name.endsWith(".html")) return "text/html";
	if (name.endsWith(".md")) return "text/markdown";
	if (name.endsWith(".json")) return "application/json";
	if (name.endsWith(".png")) return "image/png";
	if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
	if (name.endsWith(".webp")) return "image/webp";
	if (name.endsWith(".gif")) return "image/gif";
	return "application/pdf";
}

function isHttpUrl(url) {
	return typeof url === "string" && /^https?:\/\//i.test(url);
}

function joinSystem(blocks) {
	const texts = blocks
		.filter((block) => block.type === "text" && block.text)
		.map((block) => block.text);
	if (texts.length === 0) return undefined;
	if (texts.length === 1) return texts[0];
	return texts.map((text) => ({ type: "text", text }));
}

function checkProtocol(protocol, strict = true) {
	const proto = String(protocol || "").toLowerCase();
	if (PROTOCOLS.has(proto)) return proto;
	if (!strict && proto === "") return "anthropic";
	throw new ProtocolError(`unsupported protocol: ${protocol}`);
}

function openaiResponseId(id) {
	if (!id) return "chatcmpl-unknown";
	const s = String(id);
	return s.startsWith("chatcmpl-") ? s : `chatcmpl-${s}`;
}

function eventIndex(event) {
	const index = event.index;
	return Number.isInteger(index) ? index : 0;
}

function sseNamed(type, data) {
	return `event: ${type}\ndata: ${jsonString(data)}\n\n`;
}

function sseData(data) {
	return `data: ${jsonString(data)}\n\n`;
}

function jsonString(value) {
	return JSON.stringify(value);
}

function jsonArgs(input) {
	if (typeof input === "string") return input;
	if (input == null) return "{}";
	return JSON.stringify(input);
}

function stripModelsPrefix(model) {
	const s = String(model || "");
	return s.startsWith("models/") ? s.slice("models/".length) : s;
}

function stripUndefined(obj) {
	const out = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

function requirePositiveInt(value, name) {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new ProtocolError(`${name} must be a positive integer`);
	}
	return value;
}

function requireUnitInterval(value, name, max) {
	if (
		typeof value !== "number" ||
		Number.isNaN(value) ||
		value < 0 ||
		value > max
	) {
		throw new ProtocolError(`${name} must be a number between 0 and ${max}`);
	}
	return value;
}

function toBool(value) {
	return value === true || value === 1 || value === "1" || value === "true";
}

function asArray(value) {
	if (value == null) return [];
	return Array.isArray(value) ? value : [value];
}

function firstDefined(...values) {
	for (const value of values) {
		if (value !== undefined && value !== null) return value;
	}
	return undefined;
}

function pick(obj, ...keys) {
	for (const key of keys) {
		if (obj[key] !== undefined) return obj[key];
	}
	return undefined;
}

function isPlainObject(value) {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
	return JSON.parse(JSON.stringify(value));
}

function num(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function unixNow() {
	return Math.floor(Date.now() / 1000);
}
