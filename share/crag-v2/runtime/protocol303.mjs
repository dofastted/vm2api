import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** User-facing and billing/UA/MACRO version. Native base remains 2.1.88. */
export const VERSION = "2.1.303";
export const NATIVE_BASE_VERSION = "2.1.88";

/**
 * Actual SDK package version compiled into claude-code-2.1.88/cli.js
 * (`var pt="0.74.0"` → X-Stainless-Package-Version). Not 0.39.0 (cli-node)
 * and not official 2.1.303's 0.128.0. Do not spoof the Stainless header.
 */
export const NATIVE_SDK_PACKAGE_VERSION = "0.74.0";
export const OFFICIAL_303_SDK_PACKAGE_VERSION = "0.128.0";

export const USER_FACING_VERSION = `${VERSION} (Claude Code)`;
export const MACRO_VERSION = VERSION;

export const EFFORT_LEVELS = Object.freeze([
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
export const EFFORT_XHIGH_WARNING =
	"May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.";
export const THINKING_MODES = Object.freeze([
	"enabled",
	"adaptive",
	"disabled",
]);
export const THINKING_DISPLAYS = Object.freeze([
	"summarized",
	"omitted",
	"highlights",
]);
export const PERMISSION_MODES_303 = Object.freeze([
	"acceptEdits",
	"auto",
	"bypassPermissions",
	"manual",
	"dontAsk",
	"plan",
]);
/** 2.1.303 CLI name `manual` is 88 engine `default`. */
export const PERMISSION_MODE_ENGINE = Object.freeze({
	manual: "default",
	default: "default",
});
export const PERMISSION_PROMPT_TARGETS = Object.freeze(["host", "none"]);
export const REQUEST_CLASSES = Object.freeze([
	"main",
	"subagent",
	"workflow",
	"compaction",
	"auxiliary",
	"side_reply",
]);
export const PROJECT_ID_RE =
	/^claude_proj_(?:staging_|local_)?01[1-9A-HJ-NP-Za-km-z]{22}$/;
export const PROJECT_SOURCES = Object.freeze([
	"harness",
	"user",
	"project",
	"local",
	"flag",
	"managed",
	"admin_default",
]);
export const PREV_REQ_RE = /^req_[A-Za-z0-9_-]{1,36}$/;
export const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TURN_ORIGIN_RE = /^[a-z][a-z_]{0,31}$/;
export const BILLING_INDEX_MAX = 1e7;
export const CCH_SEED = 0x4d659218e32a3268n;
export const CCH_PLACEHOLDER = "00000";
export const MIN_THINKING_BUDGET = 1024;

const ALS_KEY = "__CRAG_REQUEST_ALS";
const P303_KEY = "__CRAG_P303";
const CLI_STATE_KEY = "__CRAG_P303_CLI";

function als() {
	if (!globalThis[ALS_KEY]) globalThis[ALS_KEY] = new AsyncLocalStorage();
	return globalThis[ALS_KEY];
}

/**
 * Wrap an async native slot runner. `context` is the slot-owned mutable object.
 * Resume must mutate request_id/request/turn fields in place — do not replace
 * the store or write per-slot values into process.env.
 */
export function withRequestContext(context, fn) {
	if (
		context == null ||
		typeof context !== "object" ||
		Array.isArray(context)
	) {
		throw new TypeError("withRequestContext requires a mutable context object");
	}
	return als().run(context, fn);
}

export function getRequestContext() {
	return als().getStore() ?? null;
}

function emptyCliState() {
	return {
		fallbackModels: [],
		thinkingDisplay: undefined,
		permissionPrompts: "host",
		promptSuggestions: undefined,
		restricted: false,
		safeMode: false,
		excludeDynamicSystemPromptSections: false,
		forwardSubagentText: false,
		systemPromptSnapshot: undefined,
		systemPromptSnapshotValue: undefined,
		detachedPromptSections: undefined,
		extraBetas: [],
	};
}

function globalCliState() {
	if (!globalThis[CLI_STATE_KEY]) globalThis[CLI_STATE_KEY] = emptyCliState();
	return globalThis[CLI_STATE_KEY];
}

function cloneCliState(src) {
	return {
		...src,
		fallbackModels: Array.isArray(src.fallbackModels)
			? src.fallbackModels.slice()
			: [],
		extraBetas: Array.isArray(src.extraBetas) ? src.extraBetas.slice() : [],
		detachedPromptSections:
			src.detachedPromptSections &&
			typeof src.detachedPromptSections === "object" &&
			!Array.isArray(src.detachedPromptSections)
				? { ...src.detachedPromptSections }
				: undefined,
	};
}

function cliState() {
	const ctx = getRequestContext();
	if (ctx) {
		if (
			ctx.cliState == null ||
			typeof ctx.cliState !== "object" ||
			Array.isArray(ctx.cliState)
		) {
			ctx.cliState = cloneCliState(globalCliState());
		}
		return ctx.cliState;
	}
	return globalCliState();
}

export function getCliProtocolState() {
	return cliState();
}

function capSet(raw) {
	if (!raw) return Object.freeze([]);
	const parts = String(raw)
		.replace(/^"+|"+$/g, "")
		.split(",")
		.map((s) => s.trim().replace(/^"+|"+$/g, ""))
		.filter(Boolean);
	return Object.freeze(parts);
}

function tokens(raw) {
	if (!raw) return { default: undefined, upper: undefined };
	const out = {};
	for (const part of String(raw).split(",")) {
		const [k, v] = part.split(":");
		if (k && v) out[k] = Number(v);
	}
	return out;
}

/** Product catalog (2.1.303 catalog.json), excluding signing/design tokens. */
export const MODELS = Object.freeze(
	[
		[
			"claude-3-5-haiku",
			"Haiku 3.5",
			"medium",
			"",
			"default:8192,upper:8192",
			"claude-haiku-4-5",
			"February 2025",
		],
		[
			"claude-haiku-4-5",
			"Haiku 4.5",
			"medium",
			"context_management",
			"default:32000,upper:64000",
			"claude-haiku-4-5",
			"February 2025",
		],
		[
			"claude-haiku-5-5",
			"Haiku 5.5",
			"medium",
			"effort,max_effort,xhigh_effort,adaptive_thinking,mid_conv_tool_change,context_management,rejects_disabled_thinking,per_turn_effort,lean_prompt,org_locked_thinking,haiku_5_5_early_stopping_guidance",
			"default:128000,upper:128000",
			"claude-haiku-4-5",
			"June 2026",
		],
		[
			"claude-3-5-sonnet",
			"Sonnet 3.5",
			null,
			"",
			"default:8192,upper:8192",
			"claude-sonnet-4-0",
			"January 2025",
		],
		[
			"claude-3-7-sonnet",
			"Sonnet 3.7",
			null,
			"",
			"default:32000,upper:64000",
			"claude-sonnet-4-0",
			"January 2025",
		],
		[
			"claude-sonnet-4-0",
			"Sonnet 4",
			null,
			"context_management",
			"default:32000,upper:64000",
			"claude-sonnet-4-0",
			"January 2025",
		],
		[
			"claude-sonnet-4-5",
			"Sonnet 4.5",
			"high",
			"context_management",
			"default:32000,upper:64000",
			"claude-sonnet-4-0",
			"January 2025",
		],
		[
			"claude-sonnet-4-6",
			"Sonnet 4.6",
			"high",
			"effort,max_effort,adaptive_thinking,context_management",
			"default:32000,upper:128000",
			"claude-sonnet-4-5",
			"August 2025",
		],
		[
			"claude-sonnet-5",
			"Sonnet 5",
			"high",
			"effort,max_effort,xhigh_effort,adaptive_thinking,context_management",
			"default:64000,upper:128000",
			"claude-sonnet-4-6",
			"January 2026",
		],
		[
			"claude-sonnet-5-5",
			"Sonnet 5.5",
			"medium",
			"effort,max_effort,xhigh_effort,adaptive_thinking,mid_conv_tool_change,context_management,rejects_disabled_thinking,per_turn_effort,per_turn_timing,lean_prompt,refusal_fallback,silent_turn_reminder,org_locked_thinking",
			"default:128000,upper:128000",
			"claude-sonnet-5",
			"June 2026",
		],
		[
			"claude-opus-4-0",
			"Opus 4",
			null,
			"context_management",
			"default:32000,upper:32000",
			"claude-opus-4-1",
			"January 2025",
		],
		[
			"claude-opus-4-1",
			"Opus 4.1",
			null,
			"context_management",
			"default:32000,upper:32000",
			"claude-opus-4-1",
			"January 2025",
		],
		[
			"claude-opus-4-5",
			"Opus 4.5",
			"xhigh",
			"context_management",
			"default:32000,upper:64000",
			"claude-opus-4-1",
			"May 2025",
		],
		[
			"claude-opus-4-6",
			"Opus 4.6",
			"xhigh",
			"effort,max_effort,adaptive_thinking,context_management",
			"default:64000,upper:128000",
			"claude-opus-4-5",
			"May 2025",
		],
		[
			"claude-opus-4-7",
			"Opus 4.7",
			"xhigh",
			"effort,max_effort,xhigh_effort,adaptive_thinking,context_management",
			"default:64000,upper:128000",
			"claude-opus-4-6",
			"January 2026",
		],
		[
			"claude-opus-4-8",
			"Opus 4.8",
			"high",
			"effort,max_effort,xhigh_effort,adaptive_thinking,mid_conv_tool_change,context_management,fast_mode,lean_prompt",
			"default:64000,upper:128000",
			"claude-opus-4-7",
			"January 2026",
		],
		[
			"claude-opus-5",
			"Opus 5",
			"high",
			"effort,max_effort,xhigh_effort,adaptive_thinking,mid_conv_tool_change,context_management,thinking_disabled_effort_cap,fast_mode,lean_prompt,refusal_fallback,opus_5_prompt_bundle",
			"default:64000,upper:128000",
			"claude-opus-4-8",
			"May 2026",
		],
		[
			"claude-opus-5-5",
			"Opus 5.5",
			"medium",
			"effort,max_effort,xhigh_effort,adaptive_thinking,rejects_disabled_thinking,mid_conv_tool_change,per_turn_effort,per_turn_timing,context_management,fast_mode,lean_prompt,refusal_fallback,opus_5_5_prompt_bundle",
			"default:128000,upper:128000",
			"claude-opus-5",
			"June 2026",
		],
		[
			"claude-fable-5",
			"Fable 5",
			"high",
			"effort,max_effort,xhigh_effort,adaptive_thinking,rejects_disabled_thinking,mid_conv_tool_change,context_management,lean_prompt,fable_5_mitigations,refusal_fallback",
			"default:64000,upper:128000",
			"claude-opus-5-5",
			"January 2026",
		],
		[
			"claude-fable-5-1",
			"Fable 5.1",
			"high",
			"effort,max_effort,xhigh_effort,adaptive_thinking,rejects_disabled_thinking,mid_conv_tool_change,per_turn_effort,per_turn_timing,context_management,lean_prompt,fable_5_mitigations,refusal_fallback,fable_5_1_prompt_bundle",
			"default:64000,upper:128000",
			"claude-fable-5",
			"June 2026",
		],
		[
			"claude-mythos-5",
			"Mythos 5",
			"high",
			"",
			"default:64000,upper:128000",
			null,
			"January 2026",
		],
		[
			"claude-mythos-5-1",
			"Mythos 5.1",
			"high",
			"effort,max_effort,xhigh_effort,adaptive_thinking,rejects_disabled_thinking,mid_conv_tool_change,per_turn_timing,context_management,lean_prompt,fable_5_mitigations,fable_5_1_prompt_bundle",
			"default:64000,upper:128000",
			null,
			"June 2026",
		],
	].map(
		([id, displayName, defaultEffort, caps, maxOut, fallback3p, cutoff]) => {
			const capabilities = capSet(caps);
			const maxOutputTokens = tokens(maxOut);
			return Object.freeze({
				id,
				displayName,
				defaultEffort,
				capabilities,
				maxOutputTokens,
				fallback3p,
				knowledgeCutoff: cutoff,
				effort: capabilities.includes("effort"),
				maxEffort: capabilities.includes("max_effort"),
				xhighEffort: capabilities.includes("xhigh_effort"),
				adaptiveThinking: capabilities.includes("adaptive_thinking"),
				rejectsDisabledThinking: capabilities.includes(
					"rejects_disabled_thinking",
				),
				perTurnEffort: capabilities.includes("per_turn_effort"),
				perTurnTiming: capabilities.includes("per_turn_timing"),
				contextManagement: capabilities.includes("context_management"),
				fastMode: capabilities.includes("fast_mode"),
				midConvToolChange: capabilities.includes("mid_conv_tool_change"),
			});
		},
	),
);

export const MODEL_BY_ID = Object.freeze(
	Object.fromEntries(MODELS.map((m) => [m.id, m])),
);

/** 2.1.303 alias prefix (catalog.json + chunk-w4f5s3e0.js). */
export const ALIASES = Object.freeze({
	opus: Object.freeze({
		default: "claude-opus-5-5",
		per_provider: Object.freeze({
			firstParty: "claude-opus-5-5",
			bedrock: "claude-opus-5-5",
			vertex: "claude-opus-5-5",
			foundry: "claude-opus-4-6",
			mantle: "claude-opus-5-5",
			anthropic_aws: "claude-opus-5-5",
			gateway: "claude-opus-4-7",
		}),
	}),
	sonnet: Object.freeze({
		default: "claude-sonnet-5-5",
		per_provider: Object.freeze({
			firstParty: "claude-sonnet-5-5",
			bedrock: "claude-sonnet-4-5",
			vertex: "claude-sonnet-4-5",
			foundry: "claude-sonnet-4-5",
			mantle: "claude-sonnet-4-5",
			anthropic_aws: "claude-sonnet-4-6",
			gateway: "claude-sonnet-4-6",
		}),
	}),
	haiku: Object.freeze({
		default: "claude-haiku-5-5",
		per_provider: Object.freeze({
			firstParty: "claude-haiku-5-5",
			bedrock: "claude-haiku-4-5",
			vertex: "claude-haiku-4-5",
			foundry: "claude-haiku-4-5",
			mantle: "claude-haiku-4-5",
			anthropic_aws: "claude-haiku-4-5",
			anthropic_google_cloud: "claude-haiku-4-5",
			gateway: "claude-haiku-4-5",
		}),
	}),
	fable: Object.freeze({
		default: "claude-fable-5-1",
		per_provider: Object.freeze({
			gateway: "claude-fable-5",
		}),
	}),
});

export const LATEST_PER_FAMILY = Object.freeze({
	fable: "claude-fable-5-1",
	opus: "claude-opus-5-5",
	sonnet: "claude-sonnet-5-5",
	haiku: "claude-haiku-5-5",
});

/** 2.1.303 named beta registry (chunk-pj5cyqhw.js k(name, header)). */
export const BETA_REGISTRY = Object.freeze({
	claude_code: "claude-code-20250219",
	oauth_auth: "oauth-2025-04-20",
	interleaved_thinking: "interleaved-thinking-2025-05-14",
	long_context: "context-1m-2025-08-07",
	context_management: "context-management-2025-06-27",
	structured_outputs: "structured-outputs-2025-12-15",
	web_search: "web-search-2025-03-05",
	tool_search_1p: "advanced-tool-use-2025-11-20",
	tool_search_3p: "tool-search-tool-2025-10-19",
	effort: "effort-2025-11-24",
	task_budgets: "task-budgets-2026-03-13",
	prompt_caching_scope: "prompt-caching-scope-2026-01-05",
	prompt_caching_evict: "prompt-caching-evict-2026-05-12",
	cache_keepalive: "cache-keepalive-2026-09-03",
	extended_cache_ttl: "extended-cache-ttl-2025-04-11",
	speed: "fast-mode-2026-02-01",
	redact_thinking: "redact-thinking-2026-02-12",
	thinking_resumption: "thinking-resumption-2026-07-17",
	thinking_token_count: "thinking-token-count-2026-05-13",
	afk_mode: "afk-mode-2026-01-31",
	advisor_tool: "advisor-tool-2026-03-01",
	cache_diagnosis: "cache-diagnosis-2026-04-07",
	context_hint: "context-hint-2026-04-09",
	mcp_servers: "mcp-servers-2025-12-04",
	files_api: "files-api-2025-04-14",
	environments: "environments-2025-11-01",
	ccr_byoc: "ccr-byoc-2025-07-29",
	per_message_effort: "per-turn-control-2026-07-01",
	per_turn_timing: "timing-2026-09-09",
	mid_conv_tool_change: "mid-conversation-tool-changes-2026-07-01",
	inline_tools: "inline-tools-2026-09-15",
	server_side_fallback: "server-side-fallback-2026-06-01",
	server_side_fallback_category: "server-side-fallback-2026-07-01",
	fallback_credit: "fallback-credit-2026-06-01",
	auto_mode_classifier: "auto-mode-classifier-2026-07-16",
	dangerous_tool_use: "dangerous-tool-use-2026-09-03",
	thinking_display_updates: "thinking-display-updates-2026-08-18",
	thinking_binding_controls: "thinking-binding-controls-2026-08-01",
	message_threads: "message-threads-2026-08-12",
});

/** 303 LU() drops generally-available headers from ANTHROPIC_BETAS. bR("mid_conversation_system") is header:null. */
export const ENV_BETA_SKIP = Object.freeze(
	new Set([BETA_REGISTRY.afk_mode, "mid-conversation-system-2026-04-07"]),
);

export const RESIDUAL_GAPS = Object.freeze({
	sdkPackageVersion: {
		native: NATIVE_SDK_PACKAGE_VERSION,
		official303: OFFICIAL_303_SDK_PACKAGE_VERSION,
		note: "88 bundle embeds Stainless 0.74.0. Official 2.1.303 embeds 0.128.0. Headers keep the real 0.74.0 identity; do not stamp 0.128.0. Body JSON in 88 is already compact (JSON.stringify).",
	},
	cch: {
		note: "JS placeholder is cch=00000. Official overwrite is Bun native HTTP (not in this Node distribution). stampCchBody is an equivalent xxHash64, not the same implementation. TLS/HTTP2 wire bytes unverified.",
	},
	gatewayProject: {
		note: "cc_gateway/cc_project emit only from trusted context fields. No invented values.",
	},
	restrictedFileConfine: {
		note: "303 --restricted also confines Read/Edit/Write to cwd + --add-dir. 88 has no unique restricted-path choke; tool deny-list and user/project/local settings skip are implemented. File-root confinement needs a Read/Edit/Write path-guard patch if required.",
	},
	n8SessionId: {
		note: "getSessionId is function N8(){return G8.sessionId}. scripts/build.mjs patches N8 to ALS session_id after patch303. Do not double-patch N8 here.",
	},
});

/** Concrete 88 minified symbols for the parent builder / worker. */
export const NATIVE_HOOKS = Object.freeze({
	getSessionId: "function N8(){return G8.sessionId}",
	lastMainRequestIdGet: "function ub6(){return G8.lastMainRequestId}",
	lastMainRequestIdSet: "function Ki8(q){G8.lastMainRequestId=q}",
	isClaudeAISubscriber:
		"function d7(){if(!WJ())return!1;return KS(Kq()?.scopes)}",
	sdkClientHeaders:
		'j={"x-app":"cli","User-Agent":hS(),"X-Claude-Code-Session-Id":N8()',
	compactEncoder:
		'var tj7=({headers:q,body:K})=>{return{bodyHeaders:{"content-type":"application/json"},body:JSON.stringify(K)}}',
	messagesCreate: "create(q,K){let _=yH7(q),{betas:z,...Y}=_;",
	billing: "function mf8(q)",
	setAllowedSettingSources: "function bi8(q){G8.allowedSettingSources=q}",
	normalizeModelForAPI: 'function uf(q){return q.replace(/\\[(1|2)m\\]/gi,"")}',
	maxOutputTokens:
		'function t86(q){let K,_,z=bY(q);if(z.includes("opus-4-6"))K=64000,_=128000;else if(z.includes("sonnet-4-6"))K=32000,_=128000;else if(z.includes("opus-4-5")||z.includes("sonnet-4")||z.includes("haiku-4"))K=32000,_=64000;else if(z.includes("opus-4-1")||z.includes("opus-4"))K=32000,_=32000;else if(z.includes("claude-3-opus"))K=4096,_=4096;else if(z.includes("claude-3-sonnet"))K=8192,_=8192;else if(z.includes("claude-3-haiku"))K=4096,_=4096;else if(z.includes("3-5-sonnet")||z.includes("3-5-haiku"))K=8192,_=8192;else if(z.includes("3-7-sonnet"))K=32000,_=64000;else K=Lt9,_=Rt9;let Y=oT1(q);if(Y?.max_tokens&&Y.max_tokens>=4096)_=Y.max_tokens,K=Math.min(K,_);return{default:K,upperLimit:_}}',
	fallbackThrow: "new IO6(_.model,_.fallbackModel)",
	fallbackCatch: "if(h6 instanceof IO6&&A){if(l=A,f6=!0",
});

export function canonicalModelId(model) {
	if (typeof model !== "string" || !model) return "";
	let name = model.toLowerCase().replace(/\[(1|2)m\]/gi, "");
	const ordered = [
		"claude-fable-5-1",
		"claude-fable-5",
		"claude-mythos-5-1",
		"claude-mythos-5",
		"claude-opus-5-5",
		"claude-opus-5",
		"claude-opus-4-8",
		"claude-opus-4-7",
		"claude-opus-4-6",
		"claude-opus-4-5",
		"claude-opus-4-1",
		"claude-opus-4-0",
		"claude-opus-4",
		"claude-sonnet-5-5",
		"claude-sonnet-5",
		"claude-sonnet-4-6",
		"claude-sonnet-4-5",
		"claude-sonnet-4-0",
		"claude-sonnet-4",
		"claude-haiku-5-5",
		"claude-haiku-4-5",
		"claude-3-7-sonnet",
		"claude-3-5-sonnet",
		"claude-3-5-haiku",
	];
	for (const id of ordered) {
		if (name.includes(id) || name.includes(id.replace("claude-", "")))
			return id;
	}
	const match = name.match(/(claude-(?:\d+-\d+-)?[a-z0-9-]+)/);
	return match ? match[1] : name;
}

export function getModel(model) {
	const id = canonicalModelId(model);
	return MODEL_BY_ID[id] ?? null;
}

export function currentProvider() {
	if (isTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) return "bedrock";
	if (isTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) return "vertex";
	if (isTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) return "foundry";
	return "firstParty";
}

export function resolveModelAlias(input, provider = currentProvider()) {
	if (typeof input !== "string" || !input.trim()) return input;
	const raw = input.trim();
	const suffix = raw.match(/\[(1|2)m\]$/i)?.[0] ?? "";
	const base = raw.replace(/\[(1|2)m\]$/i, "").toLowerCase();
	const family = ALIASES[base];
	if (!family) return raw;
	const mapped = family.per_provider[provider] ?? family.default;
	return mapped + suffix;
}

const MODEL_SUFFIX_RE = /\[(1|2)m\]$/i;
const SCOPED_BODY_KEYS = Object.freeze([
	"max_tokens",
	"temperature",
	"top_p",
	"top_k",
	"stop_sequences",
	"tool_choice",
	"output_config",
	"thinking",
]);

export function has1mSuffix(model) {
	return (
		typeof model === "string" &&
		MODEL_SUFFIX_RE.test(model) &&
		!isTruthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)
	);
}

export function stripModelSuffix(model) {
	if (typeof model !== "string") return model;
	return model.replace(MODEL_SUFFIX_RE, "").replace(/\[(1|2)m\]/gi, "");
}

/** Alias map including haiku/fable. Keep [1m] as a beta flag; strip it from the upstream model id. */
export function upstreamModel(input, provider = currentProvider()) {
	const raw = typeof input === "string" ? input.trim() : "";
	const oneM = has1mSuffix(raw);
	const mapped = resolveModelAlias(raw, provider);
	return { model: stripModelSuffix(mapped), oneM, mapped };
}

export function nativeRequestId(value) {
	return typeof value === "string" && PREV_REQ_RE.test(value)
		? value
		: undefined;
}

export function nextFallbackModel(currentModel, configured) {
	const state = cliState();
	const list =
		Array.isArray(state.fallbackModels) && state.fallbackModels.length
			? state.fallbackModels
			: configured
				? [configured]
				: [];
	if (list.length === 0) return undefined;
	const current = stripModelSuffix(
		resolveModelAlias(String(currentModel ?? "")),
	);
	const resolved = list.map((id) => stripModelSuffix(resolveModelAlias(id)));
	const idx = resolved.findIndex(
		(id) =>
			id === current || canonicalModelId(id) === canonicalModelId(current),
	);
	const next = idx >= 0 ? resolved[idx + 1] : resolved[0];
	if (!next || next === current) return undefined;
	return next;
}

export function modelSupportsEffort(model) {
	const rec = getModel(model);
	if (rec) return rec.effort;
	const id = canonicalModelId(model);
	if (
		/haiku-4-5|sonnet-4-5$|opus-4-5$|opus-4-1|opus-4-0|sonnet-4-0|claude-3-/.test(
			id,
		)
	)
		return false;
	return true;
}

export function modelSupportsMaxEffort(model) {
	const rec = getModel(model);
	if (rec) return rec.maxEffort;
	return /opus-4-6/.test(canonicalModelId(model));
}

export function modelSupportsXhighEffort(model) {
	const rec = getModel(model);
	if (rec) return rec.xhighEffort;
	const id = canonicalModelId(model);
	return rec
		? rec.xhighEffort
		: /haiku-5-5|sonnet-5|opus-4-7|opus-4-8|opus-5|fable-5|mythos-5-1/.test(id);
}

export function modelSupportsAdaptiveThinking(model) {
	const rec = getModel(model);
	if (rec) return rec.adaptiveThinking;
	return modelSupportsEffort(model);
}

export function modelSupportsThinking(model) {
	const id = canonicalModelId(model);
	return !id.includes("claude-3-");
}

export function defaultEffortForModel(model) {
	return getModel(model)?.defaultEffort ?? undefined;
}

export function isEffortLevel(value) {
	return EFFORT_LEVELS.includes(value);
}

export function parseEffortValue(raw) {
	if (raw == null || raw === "")
		return { level: undefined, warning: undefined };
	if (typeof raw === "number" && Number.isInteger(raw))
		return { level: raw, warning: undefined };
	const value = String(raw).trim().toLowerCase();
	if (value === "unset" || value === "auto")
		return { level: undefined, warning: undefined };
	if (isEffortLevel(value)) {
		const warning =
			value === "xhigh" || value === "max" ? EFFORT_XHIGH_WARNING : undefined;
		return { level: value, warning };
	}
	const n = Number.parseInt(value, 10);
	if (!Number.isNaN(n) && Number.isInteger(n))
		return { level: n, warning: undefined };
	return {
		level: undefined,
		warning: `Unknown --effort value '${raw}' — ignoring it and using the default effort. Valid values: ${EFFORT_LEVELS.join(", ")}.`,
	};
}

/** Commander argParser: 303 Yft — unknown values warn and fall through. */
export function parseCliEffort(raw) {
	const { level, warning } = parseEffortValue(raw);
	if (warning && level === undefined) {
		process.stderr.write(`Warning: ${warning}\n`);
		return undefined;
	}
	if (warning && (level === "xhigh" || level === "max")) {
		process.stderr.write(`Warning: ${warning}\n`);
	}
	if (
		level !== undefined &&
		typeof level === "string" &&
		!isEffortLevel(level)
	) {
		throw new Error(`It must be one of: ${EFFORT_LEVELS.join(", ")}`);
	}
	return level;
}

export function parseThinkingMode(raw) {
	if (raw == null || raw === "") return undefined;
	const value = String(raw).toLowerCase();
	if (!THINKING_MODES.includes(value)) {
		throw new Error(`--thinking must be one of: ${THINKING_MODES.join(", ")}`);
	}
	return value;
}

export function parseThinkingDisplay(raw) {
	if (raw == null || raw === "") return undefined;
	const value = String(raw).toLowerCase();
	if (!THINKING_DISPLAYS.includes(value)) {
		throw new Error(
			`--thinking-display must be one of: ${THINKING_DISPLAYS.join(", ")}`,
		);
	}
	cliState().thinkingDisplay = value;
	return value;
}

export function parseTaskBudget(raw) {
	const tokensValue = Number(raw);
	if (!Number.isInteger(tokensValue) || tokensValue <= 0) {
		throw new Error("--task-budget must be a positive integer");
	}
	return tokensValue;
}

export function parsePermissionMode(raw) {
	if (raw == null || raw === "") return undefined;
	const value = String(raw);
	if (value === "default") return "default";
	if (!PERMISSION_MODES_303.includes(value) && value !== "default") {
		throw new Error(
			`--permission-mode must be one of: ${PERMISSION_MODES_303.join(", ")}`,
		);
	}
	return toEnginePermissionMode(value);
}

export function toEnginePermissionMode(mode) {
	if (mode === "manual") return "default";
	return mode;
}

export function toUserPermissionMode(mode) {
	if (mode === "default" || mode == null) return "manual";
	return mode;
}

export function parsePermissionPrompts(raw) {
	const value = String(raw ?? "host");
	if (!PERMISSION_PROMPT_TARGETS.includes(value)) {
		throw new Error("--permission-prompts must be host or none");
	}
	cliState().permissionPrompts = value;
	return value;
}

export function parsePromptSuggestions(raw) {
	const value = String(raw ?? "true").toLowerCase();
	const truthy = new Set(["true", "1", "yes", "on"]);
	const falsy = new Set(["false", "0", "no", "off"]);
	if (!truthy.has(value) && !falsy.has(value)) {
		throw new Error("Allowed choices are true, false, 1, 0, yes, no, on, off.");
	}
	const enabled = truthy.has(value);
	cliState().promptSuggestions = enabled;
	return enabled;
}

export function parseFallbackModels(raw) {
	if (raw == null || raw === "") return [];
	const list = String(raw)
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => resolveModelAlias(s));
	if (list.length === 0)
		throw new Error("--fallback-model requires at least one model");
	return list;
}

export function parseFallbackModelFlag(raw) {
	const list = parseFallbackModels(raw);
	cliState().fallbackModels = list;
	return list[0];
}

export function parseBetasFlag(raw) {
	const parts = Array.isArray(raw)
		? raw.flatMap((s) => String(s).split(","))
		: String(raw ?? "").split(",");
	const betas = parts
		.map((s) => s.trim())
		.filter((s) => s && !ENV_BETA_SKIP.has(s));
	cliState().extraBetas = betas;
	return betas;
}

export function parseAgentsJsonOrFile(
	raw,
	{ allowFile = false, cwd = process.cwd() } = {},
) {
	if (raw == null || raw === "") return undefined;
	const text = String(raw).trim();
	if (text.startsWith("{") || text.startsWith("[")) {
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object")
			throw new Error("--agents must be a JSON object");
		return parsed;
	}
	if (!allowFile) {
		throw new Error("--agents file path is only accepted with --print");
	}
	const file = isAbsolute(text) ? text : resolve(cwd, text);
	let st;
	try {
		st = statSync(file);
	} catch {
		throw new Error(`--agents file not found: ${text}`);
	}
	if (!st.isFile()) throw new Error(`--agents is not a file: ${text}`);
	const parsed = JSON.parse(readFileSync(file, "utf8"));
	if (!parsed || typeof parsed !== "object")
		throw new Error("--agents file must contain a JSON object");
	return parsed;
}

export function thinkingConfigFromCli(mode, display, maxTokens) {
	const resolvedDisplay = display ?? cliState().thinkingDisplay;
	if (mode === "disabled") return { type: "disabled" };
	if (mode === "adaptive" || mode === "enabled") {
		const extra = resolvedDisplay ? { display: resolvedDisplay } : {};
		if (mode === "enabled" && maxTokens) {
			return { type: "enabled", budgetTokens: maxTokens, ...extra };
		}
		return { type: "adaptive", ...extra };
	}
	return undefined;
}

export function assembleThinkingParam(
	thinkingConfig,
	model,
	{ maxOutputTokens } = {},
) {
	const ctx = getRequestContext();
	const cfg = thinkingConfig ?? ctx?.request?.thinking ?? ctx?.thinkingConfig;
	const display = cfg?.display ?? cliState().thinkingDisplay;
	const cap = getModel(model);
	const disableEnv = isTruthy(process.env.CLAUDE_CODE_DISABLE_THINKING);
	if (disableEnv) return undefined;
	if (!cfg || cfg.type === "disabled") {
		if (cap?.rejectsDisabledThinking) {
			if (modelSupportsAdaptiveThinking(model)) {
				return display ? { type: "adaptive", display } : { type: "adaptive" };
			}
			return undefined;
		}
		return modelSupportsThinking(model) ? { type: "disabled" } : undefined;
	}
	if (!modelSupportsThinking(model)) return undefined;
	const useAdaptive =
		!isTruthy(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING) &&
		(cfg.type === "adaptive" ||
			(cfg.type === "enabled" && modelSupportsAdaptiveThinking(model)));
	if (useAdaptive && modelSupportsAdaptiveThinking(model)) {
		return display ? { type: "adaptive", display } : { type: "adaptive" };
	}
	const rec = getModel(model);
	const capDefault = rec?.maxOutputTokens?.default ?? 32000;
	const ceiling = Math.max(
		MIN_THINKING_BUDGET,
		(maxOutputTokens ?? capDefault) - 1,
	);
	let budget = cfg.budgetTokens ?? cfg.budget_tokens ?? ceiling;
	budget = Math.max(MIN_THINKING_BUDGET, Math.min(ceiling, budget));
	return display
		? { type: "enabled", budget_tokens: budget, display }
		: { type: "enabled", budget_tokens: budget };
}

export function configureEffortParams(
	effortValue,
	outputConfig,
	extraBodyParams,
	betas,
	model,
) {
	if (!outputConfig || typeof outputConfig !== "object") return;
	if (
		!modelSupportsEffort(model) ||
		Object.prototype.hasOwnProperty.call(outputConfig, "effort")
	) {
		if (!modelSupportsEffort(model)) delete outputConfig.effort;
		return;
	}
	const effort = effortFromContext(effortValue, model);
	const header = BETA_REGISTRY.effort;
	if (effort === undefined) {
		if (Array.isArray(betas) && !betas.includes(header)) betas.push(header);
		return;
	}
	if (typeof effort === "string") {
		if (effort === "max" && !modelSupportsMaxEffort(model)) {
			throw new Error(
				`effort=max is not supported for ${canonicalModelId(model)}`,
			);
		}
		if (
			effort === "xhigh" &&
			!modelSupportsXhighEffort(model) &&
			!modelSupportsEffort(model)
		) {
			throw new Error(
				`effort=xhigh is not supported for ${canonicalModelId(model)}`,
			);
		}
		outputConfig.effort = effort;
		if (Array.isArray(betas) && !betas.includes(header)) betas.push(header);
		return;
	}
	if (
		typeof effort === "number" &&
		extraBodyParams &&
		typeof extraBodyParams === "object"
	) {
		extraBodyParams.anthropic_internal = {
			...(extraBodyParams.anthropic_internal ?? {}),
			effort_override: effort,
		};
	}
}

export function effortFromContext(explicit, model) {
	if (explicit !== undefined && explicit !== null && explicit !== "")
		return explicit;
	const ctx = getRequestContext();
	const req = ctx?.request;
	const fromReq =
		req?.output_config?.effort ??
		req?.effort ??
		ctx?.effort ??
		defaultEffortForModel(model ?? ctx?.model);
	return fromReq === undefined ? undefined : fromReq;
}

export function configureTaskBudgetParams(taskBudget, outputConfig, betas) {
	if (!outputConfig || typeof outputConfig !== "object") return;
	const budget = taskBudget ?? taskBudgetFromContext();
	if (
		!budget ||
		Object.prototype.hasOwnProperty.call(outputConfig, "task_budget")
	)
		return;
	const total = typeof budget === "number" ? budget : budget.total;
	if (!Number.isInteger(total) || total <= 0) return;
	outputConfig.task_budget = {
		type: "tokens",
		total,
		...(typeof budget === "object" && budget.remaining !== undefined
			? { remaining: budget.remaining }
			: {}),
	};
	if (Array.isArray(betas) && !betas.includes(BETA_REGISTRY.task_budgets)) {
		betas.push(BETA_REGISTRY.task_budgets);
	}
}

export function taskBudgetFromContext() {
	const ctx = getRequestContext();
	const req = ctx?.request;
	return req?.output_config?.task_budget ?? req?.task_budget ?? ctx?.taskBudget;
}

export function normalizeRequestOptions(input = {}, { model: urlModel } = {}) {
	const body = input && typeof input === "object" ? input : {};
	const ctx = getRequestContext();
	const rawModel =
		body.model ?? urlModel ?? ctx?.model ?? ctx?.request?.model ?? "";
	const { model, oneM } = upstreamModel(rawModel);
	const rec = getModel(model);
	const effortParsed = parseEffortValue(
		body.effort ?? body.output_config?.effort ?? ctx?.request?.effort,
	);
	const thinkingIn = body.thinking ?? ctx?.request?.thinking;
	const thinkingMode =
		typeof thinkingIn === "string"
			? parseThinkingMode(thinkingIn)
			: thinkingIn?.type;
	const thinkingDisplay =
		body.thinking_display ?? thinkingIn?.display ?? cliState().thinkingDisplay;
	const maxTokens = body.max_tokens ?? rec?.maxOutputTokens?.default;
	const thinking = assembleThinkingParam(
		thinkingConfigFromCli(
			thinkingMode,
			thinkingDisplay,
			thinkingIn?.budget_tokens ?? thinkingIn?.budgetTokens,
		),
		model,
		{ maxOutputTokens: maxTokens },
	);
	const outputConfig = {
		...(body.output_config && typeof body.output_config === "object"
			? body.output_config
			: {}),
	};
	const betas = Array.isArray(body.betas) ? [...body.betas] : [];
	configureEffortParams(effortParsed.level, outputConfig, {}, betas, model);
	const taskBudget =
		body.task_budget ?? body.output_config?.task_budget ?? body.taskBudget;
	configureTaskBudgetParams(taskBudget, outputConfig, betas);
	if (body.format && !outputConfig.format) outputConfig.format = body.format;
	const extras = selectBetas({
		model,
		thinking,
		effort: outputConfig.effort,
		taskBudget: outputConfig.task_budget,
		extra: [...betas, ...cliState().extraBetas, ...parseEnvBetas()],
		oneM,
		fastMode: body.speed != null || body.fastMode === true,
		perTurnEffort: body.per_turn_effort != null || body.perTurnEffort === true,
		perTurnTiming: body.per_turn_timing === true || body.perTurnTiming === true,
		midConvToolChange: body.mid_conv_tool_change === true,
	});
	return {
		model,
		stream: Boolean(body.stream),
		max_tokens: maxTokens,
		thinking,
		output_config: Object.keys(outputConfig).length ? outputConfig : undefined,
		betas: extras,
		temperature:
			thinking && thinking.type !== "disabled" ? undefined : body.temperature,
		top_p: body.top_p,
		top_k: body.top_k,
		stop_sequences: body.stop_sequences,
		tool_choice: body.tool_choice,
		tools: body.tools,
	};
}

function overlayClientToolSchemas(nativeTools, callerTools) {
	if (!Array.isArray(callerTools)) return nativeTools;
	const native = Array.isArray(nativeTools)
		? nativeTools.map((tool) => ({ ...tool }))
		: [];
	const byName = new Map(native.map((tool) => [tool?.name, tool]));
	for (const client of callerTools) {
		if (
			!client ||
			typeof client !== "object" ||
			typeof client.name !== "string"
		)
			continue;
		const schema = client.input_schema ?? client.inputSchema;
		const existing = byName.get(client.name);
		if (existing) {
			if (schema) existing.input_schema = schema;
			if (client.description != null) existing.description = client.description;
		} else {
			const added = {
				name: client.name,
				description: client.description,
				...(schema ? { input_schema: schema } : {}),
			};
			native.push(added);
			byName.set(client.name, added);
		}
	}
	return native;
}

function overlayScopedOptions(native, caller, model) {
	const out = native;
	for (const key of SCOPED_BODY_KEYS) {
		if (
			!Object.prototype.hasOwnProperty.call(caller, key) ||
			caller[key] === undefined
		)
			continue;
		if (
			key === "output_config" &&
			caller.output_config &&
			typeof caller.output_config === "object"
		) {
			out.output_config = {
				...(out.output_config && typeof out.output_config === "object"
					? out.output_config
					: {}),
				...caller.output_config,
			};
			continue;
		}
		if (key === "thinking") {
			const thinkingIn = caller.thinking;
			const thinkingMode =
				typeof thinkingIn === "string"
					? parseThinkingMode(thinkingIn)
					: thinkingIn?.type;
			const assembled = assembleThinkingParam(
				thinkingConfigFromCli(
					thinkingMode,
					caller.thinking_display ?? thinkingIn?.display,
					thinkingIn?.budget_tokens ?? thinkingIn?.budgetTokens,
				) ?? thinkingIn,
				model,
				{ maxOutputTokens: caller.max_tokens ?? out.max_tokens },
			);
			if (assembled !== undefined) out.thinking = assembled;
			continue;
		}
		out[key] = caller[key];
	}
	if (caller.effort != null) {
		const parsed = parseEffortValue(caller.effort);
		out.output_config = {
			...(out.output_config && typeof out.output_config === "object"
				? out.output_config
				: {}),
		};
		if (!Array.isArray(out.betas)) out.betas = [];
		configureEffortParams(
			parsed.level,
			out.output_config,
			{},
			out.betas,
			model,
		);
	}
	const taskBudget =
		caller.task_budget ??
		caller.taskBudget ??
		caller.output_config?.task_budget;
	if (taskBudget != null) {
		out.output_config = {
			...(out.output_config && typeof out.output_config === "object"
				? out.output_config
				: {}),
		};
		if (!Array.isArray(out.betas)) out.betas = [];
		configureTaskBudgetParams(taskBudget, out.output_config, out.betas);
	}
	if (caller.format && !(out.output_config && out.output_config.format)) {
		out.output_config = {
			...(out.output_config && typeof out.output_config === "object"
				? out.output_config
				: {}),
			format: caller.format,
		};
	}
	if (caller.json_schema && !(out.output_config && out.output_config.format)) {
		out.output_config = {
			...(out.output_config && typeof out.output_config === "object"
				? out.output_config
				: {}),
			format: { type: "json_schema", schema: caller.json_schema },
		};
	}
	if (out.thinking && out.thinking.type !== "disabled") delete out.temperature;
	return out;
}

/**
 * Overlay CRAG scoped options onto the native-built Messages.create params
 * before SDK beta stripping. Does not force stream. Ordinary CLI (no ALS)
 * is identity. Extra betas are merged onto params so create() consumes them
 * into headers; they must not remain in the JSON body.
 */
export function nativeMessagesParams(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return body;
	const ctx = getRequestContext();
	if (!ctx) return body;
	const caller =
		ctx.request &&
		typeof ctx.request === "object" &&
		!Array.isArray(ctx.request)
			? ctx.request
			: null;
	const out = { ...body };
	if ("messages" in body) out.messages = body.messages;
	if ("system" in body) out.system = body.system;
	const model =
		typeof out.model === "string" && out.model
			? out.model
			: typeof ctx.model === "string"
				? ctx.model
				: caller?.model;
	out.betas = Array.isArray(body.betas) ? [...body.betas] : [];
	if (caller) {
		overlayScopedOptions(out, caller, model);
		// Client metadata is removed at the canonical gateway boundary. Keep the
		// native account/device/session identity already present in body.metadata.
		if (Array.isArray(caller.tools))
			out.tools = overlayClientToolSchemas(body.tools, caller.tools);
	}
	const extras = selectBetas({
		model,
		thinking: out.thinking,
		effort: out.output_config?.effort,
		taskBudget: out.output_config?.task_budget,
		oneM: has1mSuffix(
			typeof caller?.model === "string"
				? caller.model
				: typeof ctx.model === "string"
					? ctx.model
					: "",
		),
		fastMode: out.speed != null || caller?.fastMode === true,
		perTurnEffort:
			caller?.perTurnEffort === true || caller?.per_turn_effort != null,
		perTurnTiming:
			caller?.perTurnTiming === true || caller?.per_turn_timing === true,
		midConvToolChange:
			caller?.midConvToolChange === true ||
			caller?.mid_conv_tool_change === true,
	});
	for (const h of extras) {
		if (h && !out.betas.includes(h)) out.betas.push(h);
	}
	const indexes = billingIndexesFromMessages(out.messages);
	if (indexes) {
		if (ctx.promptIndex == null) ctx.promptIndex = indexes.promptIndex;
		if (ctx.turnIndex == null) ctx.turnIndex = indexes.turnIndex;
	}
	return out;
}

export function adaptNativeRequestBoundary(params = {}) {
	const native = params.body;
	if (!native || typeof native !== "object" || Array.isArray(native)) {
		throw new TypeError(
			"adaptNativeRequestBoundary requires the native-built request body; it must not rebuild history from the initial caller request",
		);
	}
	const ctx = getRequestContext();
	const body = nativeMessagesParams(native);
	return {
		body,
		bodyText: compactJson(body),
		headers: adaptNativeHeaders(params.headers ?? {}, {
			model: body.model,
			betas: body.betas,
		}),
		betas: body.betas,
		session_id: ctx?.session_id,
		slot_id: ctx?.slot_id,
		request_id: ctx?.request_id,
	};
}

export function adaptNativeHeaders(base = {}, { model, betas } = {}) {
	const ctx = getRequestContext();
	const headers = { ...base };
	if (ctx?.session_id) headers["X-Claude-Code-Session-Id"] = ctx.session_id;
	if (ctx?.subagent === true)
		headers["x-claude-code-request-class"] = "subagent";
	else if (ctx?.requestClass && REQUEST_CLASSES.includes(ctx.requestClass)) {
		headers["x-claude-code-request-class"] = ctx.requestClass;
	}
	if (ctx?.promptId && UUID_RE.test(ctx.promptId))
		headers["x-claude-code-prompt-id"] = ctx.promptId;
	if (
		Array.isArray(betas) &&
		betas.length &&
		!headers["anthropic-beta"] &&
		!headers["Anthropic-Beta"]
	) {
		headers["anthropic-beta"] = betas.join(",");
	}
	void model;
	return headers;
}

export function buildUserAgent({
	entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli",
	agentSdk = process.env.CLAUDE_AGENT_SDK_VERSION,
	clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP,
	workload,
} = {}) {
	const agent = agentSdk ? `, agent-sdk/${agentSdk}` : "";
	const app = clientApp ? `, client-app/${clientApp}` : "";
	const wl = workload ? `, workload/${workload}` : "";
	return `claude-cli/${VERSION} (external, ${entrypoint}${agent}${app}${wl})`;
}

export function buildMcpUserAgent() {
	const parts = [];
	if (process.env.CLAUDE_CODE_ENTRYPOINT)
		parts.push(process.env.CLAUDE_CODE_ENTRYPOINT);
	if (process.env.CLAUDE_AGENT_SDK_VERSION)
		parts.push(`agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`);
	if (process.env.CLAUDE_AGENT_SDK_CLIENT_APP) {
		parts.push(`client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`);
	}
	const suffix = parts.length ? ` (${parts.join(", ")})` : "";
	return `claude-code/${VERSION}${suffix}`;
}

function assumeFirstPartyBaseUrl() {
	const v = process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL;
	if (v == null || v === "") return false;
	return !isFalsyEnv(v);
}

function firstPartyBaseUrlAllowed() {
	const e = process.env.ANTHROPIC_BASE_URL;
	if (!e) return true;
	try {
		return new URL(e).host === "api.anthropic.com";
	} catch {
		return false;
	}
}

function firstPartyBaseUrlEligible() {
	return assumeFirstPartyBaseUrl() || firstPartyBaseUrlAllowed();
}

function projectAttributionEligible(provider) {
	const prov = provider ?? currentProvider();
	return (
		prov === "firstParty" &&
		firstPartyBaseUrlAllowed() &&
		!process.env.ANTHROPIC_UNIX_SOCKET &&
		!isTruthy(process.env.CLAUDE_CODE_REMOTE) &&
		!isFalsyEnv(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)
	);
}

export function attributionGates({ provider } = {}) {
	const prov = provider ?? currentProvider();
	const firstPartyXi = prov === "firstParty" && firstPartyBaseUrlEligible();
	return {
		includeCch: firstPartyXi || prov === "vertex",
		includeSubscriberFields: firstPartyXi,
	};
}

export function boundedBillingIndex(value, min) {
	if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
	if (value < min || value > BILLING_INDEX_MAX) return undefined;
	return value;
}

export function billingIndexesFromMessages(messages) {
	if (!Array.isArray(messages)) return null;
	let prompts = 0;
	let assistants = 0;
	for (const message of messages) {
		const role = messageRole(message);
		if (role === "assistant") assistants += 1;
		else if (role === "user" && !toolResultOnly(message)) prompts += 1;
	}
	if (prompts < 1) return null;
	return { promptIndex: prompts - 1, turnIndex: assistants + 1 };
}

function messageRole(message) {
	if (!message || typeof message !== "object") return "";
	if (message.role != null) return String(message.role);
	if (
		message.message &&
		typeof message.message === "object" &&
		message.message.role != null
	) {
		return String(message.message.role);
	}
	return "";
}

function messageContent(message) {
	if (!message || typeof message !== "object") return undefined;
	if ("content" in message) return message.content;
	if (
		message.message &&
		typeof message.message === "object" &&
		"content" in message.message
	) {
		return message.message.content;
	}
	return undefined;
}

function toolResultOnly(message) {
	const content = messageContent(message);
	if (!Array.isArray(content) || content.length === 0) return false;
	return content.every(
		(block) =>
			block && typeof block === "object" && block.type === "tool_result",
	);
}

function trustedGateway(ctx) {
	const g = ctx?.trustedGateway ?? ctx?.gateway;
	if (!g || typeof g !== "object") return "";
	const url = g.url ?? g.baseUrl;
	if (url && typeof URL.canParse === "function" && !URL.canParse(url))
		return "";
	const verdict = g.hostVerdict;
	if (verdict && typeof verdict === "object" && "vouched" in verdict) return "";
	if (g.kind === "1" || g.credential === true) return "1";
	if (g.kind === "env" || g.env === true) return "env";
	return "";
}

function trustedProject(ctx) {
	const project = ctx?.attributionProject ?? ctx?.project;
	if (!project || typeof project !== "object") return null;
	if (!PROJECT_ID_RE.test(project.taggedId ?? "")) return null;
	if (!PROJECT_SOURCES.includes(project.source)) return null;
	if (ctx?.remote === true || isTruthy(process.env.CLAUDE_CODE_REMOTE))
		return null;
	if (!projectAttributionEligible(ctx?.provider ?? currentProvider()))
		return null;
	return project;
}

/**
 * 303 GPo field order. Gateway/project only when trusted context is present.
 * Does not invent subscriber identity.
 */
export function buildAttributionHeader(fingerprint, opts = {}) {
	if (
		isFalsyEnv(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER) &&
		!opts.ignoreEnvOptOut
	) {
		return "";
	}
	const ctx = opts.context === undefined ? getRequestContext() : opts.context;
	const provider = opts.provider ?? ctx?.provider ?? currentProvider();
	const gates = attributionGates({ provider });
	const includeCch = opts.includeCch ?? gates.includeCch;
	const includeSub =
		opts.includeSubscriberFields ?? gates.includeSubscriberFields;
	const fp = fingerprint == null ? "" : String(fingerprint);
	const version = `${VERSION}.${fp}`;
	const entrypoint =
		opts.entrypoint ?? process.env.CLAUDE_CODE_ENTRYPOINT ?? "unknown";
	const workload = opts.workload ?? ctx?.workload;
	const cch = includeCch ? ` cch=${CCH_PLACEHOLDER};` : "";
	const workloadPair = workload ? ` cc_workload=${workload};` : "";
	const isSubagent = opts.isSubagent ?? ctx?.subagent === true;
	const sub = isSubagent ? " cc_is_subagent=true;" : "";
	const prevReqId =
		nativeRequestId(opts.prevReqId) ??
		nativeRequestId(ctx?.previousRequestId) ??
		nativeRequestId(ctx?.prevReqId);
	const promptId = opts.promptId ?? ctx?.promptId;
	const turnOrigin = opts.turnOrigin ?? ctx?.turnOrigin;
	const promptIndex = opts.promptIndex ?? ctx?.promptIndex;
	const turnIndex = opts.turnIndex ?? ctx?.turnIndex;
	const prev = includeSub && prevReqId ? ` cc_prev_req=${prevReqId};` : "";
	const prompt =
		includeSub && promptId && UUID_RE.test(promptId)
			? ` cc_prompt_id=${promptId};`
			: "";
	const origin =
		includeSub && turnOrigin && TURN_ORIGIN_RE.test(turnOrigin)
			? ` cc_turn_origin=${turnOrigin};`
			: "";
	const pIdx = includeSub ? boundedBillingIndex(promptIndex, 0) : undefined;
	const tIdx = includeSub ? boundedBillingIndex(turnIndex, 1) : undefined;
	const indexes =
		pIdx !== undefined && tIdx !== undefined
			? ` cc_prompt_index=${pIdx}; cc_turn_index=${tIdx};`
			: "";
	const gw = trustedGateway(ctx);
	const gatewayPair = gw ? ` cc_gateway=${gw};` : "";
	const project = trustedProject(ctx);
	const projectPair = project
		? ` cc_project=${project.taggedId}; cc_project_src=${project.source};`
		: "";
	return `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint};${cch}${workloadPair}${sub}${prev}${prompt}${origin}${indexes}${gatewayPair}${projectPair}`;
}

export function parseEnvBetas() {
	const raw = process.env.ANTHROPIC_BETAS;
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s && !ENV_BETA_SKIP.has(s));
}

export function selectBetas({
	model,
	thinking,
	effort,
	taskBudget,
	extra = [],
	subscriber,
	oneM = false,
	provider,
	interleavedThinking = true,
	fastMode = false,
	perTurnEffort = false,
	perTurnTiming = false,
	midConvToolChange = false,
} = {}) {
	const prov = provider ?? currentProvider();
	const betas = [];
	const add = (h) => {
		if (h && !ENV_BETA_SKIP.has(h) && !betas.includes(h)) betas.push(h);
	};
	const id = canonicalModelId(model);
	const experimentalOff = isTruthy(
		process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
	);
	const firstPartyOnly =
		(prov === "firstParty" || prov === "foundry") && !experimentalOff;
	if (!id.includes("haiku-3") && !id.includes("claude-3-5-haiku"))
		add(BETA_REGISTRY.claude_code);
	if (subscriber === true) add(BETA_REGISTRY.oauth_auth);
	if (oneM || has1mSuffix(model)) add(BETA_REGISTRY.long_context);
	const thinkingOn = thinking && thinking.type && thinking.type !== "disabled";
	if (
		interleavedThinking &&
		thinkingOn &&
		modelSupportsThinking(model) &&
		!isTruthy(process.env.DISABLE_INTERLEAVED_THINKING)
	) {
		add(BETA_REGISTRY.interleaved_thinking);
	}
	if (effort !== undefined) add(BETA_REGISTRY.effort);
	if (taskBudget) add(BETA_REGISTRY.task_budgets);
	if (thinking && thinking.display) add(BETA_REGISTRY.thinking_display_updates);
	if (perTurnEffort === true) add(BETA_REGISTRY.per_message_effort);
	if (perTurnTiming === true) add(BETA_REGISTRY.per_turn_timing);
	if (midConvToolChange === true) add(BETA_REGISTRY.mid_conv_tool_change);
	if (fastMode === true) add(BETA_REGISTRY.speed);
	if (firstPartyOnly && getModel(model)?.contextManagement === true) {
		add(BETA_REGISTRY.context_management);
	}
	if (firstPartyOnly) add(BETA_REGISTRY.prompt_caching_scope);
	for (const h of extra) add(h);
	for (const h of parseEnvBetas()) add(h);
	for (const h of cliState().extraBetas) add(h);
	return betas;
}

export function compactJson(value) {
	if (typeof value === "string") {
		try {
			return JSON.stringify(JSON.parse(value));
		} catch {
			return value;
		}
	}
	return JSON.stringify(value);
}

const U64 = (1n << 64n) - 1n;
const XX_P1 = 0x9e3779b185ebca87n;
const XX_P2 = 0xc2b2ae3d27d4eb4fn;
const XX_P3 = 0x165667b19e3779f9n;
const XX_P4 = 0x85ebca77c2b2ae63n;
const XX_P5 = 0x27d4eb2f165667c5n;

function rotl(x, r) {
	return ((x << r) | (x >> (64n - r))) & U64;
}

function xxRound(acc, input) {
	acc = (acc + ((input * XX_P2) & U64)) & U64;
	return (rotl(acc, 31n) * XX_P1) & U64;
}

function xxMerge(acc, val) {
	return ((acc ^ xxRound(0n, val)) * XX_P1 + XX_P4) & U64;
}

function read64(data, offset) {
	let n = 0n;
	for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(data[offset + i]);
	return n;
}

function read32(data, offset) {
	let n = 0n;
	for (let i = 3; i >= 0; i--) n = (n << 8n) | BigInt(data[offset + i]);
	return n;
}

export function xxh64(data, seed = CCH_SEED) {
	const n = data.length;
	let i = 0;
	let h;
	if (n >= 32) {
		let v1 = (seed + XX_P1 + XX_P2) & U64;
		let v2 = (seed + XX_P2) & U64;
		let v3 = seed & U64;
		let v4 = (seed - XX_P1) & U64;
		while (i <= n - 32) {
			v1 = xxRound(v1, read64(data, i));
			i += 8;
			v2 = xxRound(v2, read64(data, i));
			i += 8;
			v3 = xxRound(v3, read64(data, i));
			i += 8;
			v4 = xxRound(v4, read64(data, i));
			i += 8;
		}
		h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & U64;
		h = xxMerge(h, v1);
		h = xxMerge(h, v2);
		h = xxMerge(h, v3);
		h = xxMerge(h, v4);
	} else {
		h = (seed + XX_P5) & U64;
	}
	h = (h + BigInt(n)) & U64;
	while (i + 8 <= n) {
		h = (rotl(h ^ xxRound(0n, read64(data, i)), 27n) * XX_P1 + XX_P4) & U64;
		i += 8;
	}
	if (i + 4 <= n) {
		h =
			(rotl(h ^ ((read32(data, i) * XX_P1) & U64), 23n) * XX_P2 + XX_P3) & U64;
		i += 4;
	}
	while (i < n) {
		h = (rotl(h ^ ((BigInt(data[i]) * XX_P5) & U64), 11n) * XX_P1) & U64;
		i += 1;
	}
	h = (h ^ (h >> 33n)) & U64;
	h = (h * XX_P2) & U64;
	h = (h ^ (h >> 29n)) & U64;
	h = (h * XX_P3) & U64;
	h = h ^ (h >> 32n);
	return h;
}

function commaSpan(s, start, end) {
	if (end < s.length && s[end] === ",") end += 1;
	else if (start > 0 && s[start - 1] === ",") start -= 1;
	return [start, end];
}

function mergeSpans(spans) {
	if (spans.length === 0) return [];
	const sorted = spans.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const out = [[sorted[0][0], sorted[0][1]]];
	for (let i = 1; i < sorted.length; i++) {
		const start = sorted[i][0];
		const end = sorted[i][1];
		const last = out[out.length - 1];
		if (start < last[1]) last[1] = Math.max(last[1], end);
		else out.push([start, end]);
	}
	return out;
}

function cutSpans(s, spans) {
	const merged = mergeSpans(spans);
	if (merged.length === 0) return s;
	const parts = [];
	let i = 0;
	for (const [start, end] of merged) {
		parts.push(s.slice(i, start));
		i = end;
	}
	parts.push(s.slice(i));
	return parts.join("");
}

function blankStringModels(s) {
	const needle = '"model":"';
	const out = [];
	let i = 0;
	while (true) {
		const j = s.indexOf(needle, i);
		if (j < 0) {
			out.push(s.slice(i));
			break;
		}
		let k = j + needle.length;
		while (k < s.length) {
			if (s[k] === "\\" && k + 1 < s.length) {
				k += 2;
				continue;
			}
			if (s[k] === '"') break;
			k += 1;
		}
		out.push(s.slice(i, j + needle.length));
		i = k;
	}
	return out.join("");
}

function collectFallbacks(s) {
	const needle = '"fallbacks":[';
	const spans = [];
	let from = 0;
	while (from < s.length) {
		const j = s.indexOf(needle, from);
		if (j < 0) break;
		let i = j + needle.length - 1;
		let depth = 0;
		let inStr = false;
		let esc = false;
		let closed = false;
		while (i < s.length) {
			const c = s[i];
			if (inStr) {
				if (esc) esc = false;
				else if (c === "\\") esc = true;
				else if (c === '"') inStr = false;
			} else if (c === '"') inStr = true;
			else if (c === "[") depth += 1;
			else if (c === "]") {
				depth -= 1;
				if (depth === 0) {
					spans.push(commaSpan(s, j, i + 1));
					from = i + 1;
					closed = true;
					break;
				}
			}
			i += 1;
		}
		if (!closed) break;
	}
	return spans;
}

function collectCredit(s) {
	const needle = '"fallback_credit_token":"';
	const spans = [];
	let from = 0;
	while (from < s.length) {
		const j = s.indexOf(needle, from);
		if (j < 0) break;
		let k = j + needle.length;
		let found = false;
		while (k < s.length) {
			if (s[k] === "\\" && k + 1 < s.length) {
				k += 2;
				continue;
			}
			if (s[k] === '"') {
				spans.push(commaSpan(s, j, k + 1));
				from = k + 1;
				found = true;
				break;
			}
			k += 1;
		}
		if (!found) break;
	}
	return spans;
}

function collectMaxTokens(s) {
	const needle = '"max_tokens":';
	const spans = [];
	let from = 0;
	while (from < s.length) {
		const j = s.indexOf(needle, from);
		if (j < 0) break;
		let k = j + needle.length;
		if (k >= s.length || s[k] < "0" || s[k] > "9") {
			from = j + needle.length;
			continue;
		}
		while (k < s.length && s[k] >= "0" && s[k] <= "9") k += 1;
		spans.push(commaSpan(s, j, k));
		from = k;
	}
	return spans;
}

const BILLING_TEXT_PREFIX = "x-anthropic-billing-header:";
const CCH_FIELD_RE = /cch=[0-9a-f]{5}/;

function rootBillingEntryText(entry) {
	if (typeof entry === "string") {
		return entry.startsWith(BILLING_TEXT_PREFIX) ? entry : null;
	}
	if (
		entry &&
		typeof entry === "object" &&
		typeof entry.text === "string" &&
		entry.text.startsWith(BILLING_TEXT_PREFIX)
	) {
		return entry.text;
	}
	return null;
}

function findRootBillingText(obj) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
	const system = obj.system;
	if (typeof system === "string") return rootBillingEntryText(system);
	if (!Array.isArray(system)) return null;
	for (const entry of system) {
		const text = rootBillingEntryText(entry);
		if (text) return text;
	}
	return null;
}

function applyRootBillingText(obj, text) {
	const system = obj.system;
	if (typeof system === "string" && system.startsWith(BILLING_TEXT_PREFIX)) {
		obj.system = text;
		return;
	}
	if (!Array.isArray(system)) return;
	for (let i = 0; i < system.length; i++) {
		const entry = system[i];
		if (typeof entry === "string" && entry.startsWith(BILLING_TEXT_PREFIX)) {
			system[i] = text;
			return;
		}
		if (
			entry &&
			typeof entry === "object" &&
			typeof entry.text === "string" &&
			entry.text.startsWith(BILLING_TEXT_PREFIX)
		) {
			entry.text = text;
			return;
		}
	}
}

function compactJsonText(body) {
	let material = typeof body === "string" ? body : JSON.stringify(body);
	try {
		const compact = JSON.stringify(JSON.parse(material));
		if (typeof compact === "string") material = compact;
	} catch {
		/* keep */
	}
	return material;
}

function resetRootBillingJson(material) {
	try {
		const parsed = JSON.parse(material);
		const billing = findRootBillingText(parsed);
		if (!billing) return material;
		const reset = billing.replace(CCH_FIELD_RE, `cch=${CCH_PLACEHOLDER}`);
		if (reset === billing) return material;
		applyRootBillingText(parsed, reset);
		return JSON.stringify(parsed);
	} catch {
		return material;
	}
}

export function projectForCch(body) {
	const material = resetRootBillingJson(compactJsonText(body));
	const blanked = blankStringModels(material);
	return cutSpans(blanked, [
		...collectFallbacks(blanked),
		...collectCredit(blanked),
		...collectMaxTokens(blanked),
	]);
}

export function computeCch(body) {
	const material = new TextEncoder().encode(projectForCch(body));
	const digest = xxh64(material, CCH_SEED);
	return (digest & 0xfffffn).toString(16).padStart(5, "0");
}

export function stampCchBody(body) {
	const wire = compactJsonText(body);
	let parsed;
	try {
		parsed = JSON.parse(wire);
	} catch {
		return wire;
	}
	const billing = findRootBillingText(parsed);
	if (!billing) return wire;
	const placeholder = `cch=${CCH_PLACEHOLDER}`;
	if (!billing.includes(placeholder)) return wire;
	const stamped = billing.replace(placeholder, `cch=${computeCch(wire)}`);
	applyRootBillingText(parsed, stamped);
	return JSON.stringify(parsed);
}

export function shouldExcludeDynamicSection(name) {
	void name;
	return cliState().excludeDynamicSystemPromptSections === true;
}

export function stashDetachedPromptSection(name, value) {
	if (!shouldExcludeDynamicSection(name) || value == null) return;
	const state = cliState();
	state.detachedPromptSections = {
		...(state.detachedPromptSections ?? {}),
		[name]: value,
	};
}

export function mergeDetachedPromptContext(userContext = {}) {
	const extra = cliState().detachedPromptSections;
	if (!extra || !shouldExcludeDynamicSection()) return userContext;
	return { ...userContext, ...extra };
}

export function readSystemPromptSnapshot() {
	const state = cliState();
	if (
		state.systemPromptSnapshot !== "on" &&
		state.systemPromptSnapshot !== true
	)
		return undefined;
	return state.systemPromptSnapshotValue;
}

export function storeSystemPromptSnapshot(value) {
	const state = cliState();
	if (
		state.systemPromptSnapshot !== "on" &&
		state.systemPromptSnapshot !== true
	)
		return value;
	if (state.systemPromptSnapshotValue === undefined)
		state.systemPromptSnapshotValue = value;
	return state.systemPromptSnapshotValue;
}

export function applyCliActionFlags(options = {}) {
	const state = cliState();
	if (options.safeMode) {
		state.safeMode = true;
		process.env.CLAUDE_CODE_SAFE_MODE = "1";
		process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
	}
	if (options.restricted) {
		state.restricted = true;
		process.env.CLAUDE_CODE_RESTRICTED = "1";
	}
	if (options.excludeDynamicSystemPromptSections) {
		state.excludeDynamicSystemPromptSections = true;
	}
	if (options.forwardSubagentText) state.forwardSubagentText = true;
	if (options.systemPromptSnapshot != null) {
		state.systemPromptSnapshot = options.systemPromptSnapshot;
		if (
			options.systemPromptSnapshot === "off" ||
			options.systemPromptSnapshot === false
		) {
			state.systemPromptSnapshotValue = undefined;
		}
	}
	if (options.promptSuggestions === true)
		process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = "1";
	if (options.promptSuggestions === false)
		process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = "0";
	if (options.permissionPrompts === "none" && !options.permissionMode) {
		options.permissionMode = "dontAsk";
	}
	if (options.workload)
		process.env.CLAUDE_CODE_WORKLOAD = String(options.workload);
	return options;
}

export function restrictedDisallowedTools(explicitTools) {
	const named = new Set(
		(Array.isArray(explicitTools)
			? explicitTools
			: String(explicitTools ?? "").split(/[\s,]+/)
		)
			.map((s) => s.trim())
			.filter(Boolean),
	);
	const dangerous = [
		"Bash",
		"PowerShell",
		"WebFetch",
		"BashOutput",
		"KillShell",
	];
	return dangerous.filter(
		(name) => !named.has(name) && !named.has(name.toLowerCase()),
	);
}

export function nativeCliArgs(options = {}) {
	const args = [
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--replay-user-messages",
		"--no-session-persistence",
	];
	const sessionId = options.session_id ?? options.sessionId;
	if (sessionId) args.push("--session-id", sessionId);
	const model = options.model ? resolveModelAlias(options.model) : undefined;
	if (model) args.push("--model", model);
	const effort = options.effort ?? options.output_config?.effort;
	if (effort != null) args.push("--effort", String(effort));
	const thinking = options.thinking;
	if (typeof thinking === "string") args.push("--thinking", thinking);
	else if (thinking?.type) {
		args.push(
			"--thinking",
			thinking.type === "enabled" ? "enabled" : thinking.type,
		);
		if (thinking.display) args.push("--thinking-display", thinking.display);
	}
	if (options.thinkingDisplay)
		args.push("--thinking-display", options.thinkingDisplay);
	const budget =
		options.taskBudget ??
		options.task_budget ??
		options.output_config?.task_budget;
	if (typeof budget === "number") args.push("--task-budget", String(budget));
	else if (budget?.total) args.push("--task-budget", String(budget.total));
	const permissionMode = options.permissionMode ?? "bypassPermissions";
	args.push(
		"--permission-mode",
		permissionMode === "default" ? "manual" : permissionMode,
	);
	args.push("--permission-prompts", options.permissionPrompts ?? "host");
	if (options.forwardSubagentText) args.push("--forward-subagent-text");
	if (options.excludeDynamicSystemPromptSections)
		args.push("--exclude-dynamic-system-prompt-sections");
	if (options.systemPromptSnapshot)
		args.push("--system-prompt-snapshot", options.systemPromptSnapshot);
	if (options.promptSuggestions != null) {
		args.push(
			"--prompt-suggestions",
			options.promptSuggestions ? "true" : "false",
		);
	}
	if (options.restricted) args.push("--restricted");
	if (options.safeMode) args.push("--safe-mode");
	if (options.workload) args.push("--workload", options.workload);
	const betas = options.betas;
	if (Array.isArray(betas) && betas.length)
		args.push("--betas", betas.join(","));
	const fallback = options.fallbackModels ?? options.fallbackModel;
	if (Array.isArray(fallback) && fallback.length)
		args.push("--fallback-model", fallback.join(","));
	else if (typeof fallback === "string" && fallback)
		args.push("--fallback-model", fallback);
	if (options.jsonSchema) {
		args.push(
			"--json-schema",
			typeof options.jsonSchema === "string"
				? options.jsonSchema
				: JSON.stringify(options.jsonSchema),
		);
	}
	if (options.agents) {
		args.push(
			"--agents",
			typeof options.agents === "string"
				? options.agents
				: JSON.stringify(options.agents),
		);
	}
	if (options.systemPrompt) args.push("--system-prompt", options.systemPrompt);
	if (options.appendSystemPrompt)
		args.push("--append-system-prompt", options.appendSystemPrompt);
	return args;
}

/** CRAG-relevant 303 flags that 88 lacked or must change. */
export const CRAG_PORTABLE_CLI = Object.freeze([
	{
		flag: "--effort",
		change: "add xhigh; 5-level parser with xhigh/max warning",
	},
	{
		flag: "--thinking / --thinking-display",
		change:
			"enabled|adaptive|disabled + summarized|omitted|highlights on thinking body",
	},
	{
		flag: "--task-budget",
		change: "already in 88; keep integer → output_config.task_budget",
	},
	{
		flag: "--permission-mode",
		change: "CLI enum manual (maps to 88 default); keep default as alias",
	},
	{
		flag: "--permission-prompts",
		change: "host keeps SDK can_use_tool; none ⇒ dontAsk deny",
	},
	{ flag: "--agents", change: "json-or-file in --print" },
	{
		flag: "--fallback-model",
		change:
			"comma list tried in order via nextFallbackModel; each ask() user turn starts on primary",
	},
	{
		flag: "--exclude-dynamic-system-prompt-sections",
		change:
			"drop env_info/memory from system prompt; move gitStatus into prepended user context",
	},
	{
		flag: "--forward-subagent-text",
		change:
			"gate IN8 agent_progress assistant/user yield; parent_tool_use_id already set on that path",
	},
	{
		flag: "--prompt-suggestions",
		change: "sets CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION (existing 88 gate)",
	},
	{
		flag: "--system-prompt-snapshot",
		change: "on caches first getSystemPrompt (QP) result for the conversation",
	},
	{
		flag: "--restricted",
		change:
			"disallow Bash/PowerShell/WebFetch unless --tools names them; bi8 flag+policy settings only",
	},
	{
		flag: "--safe-mode",
		change:
			"CLAUDE_CODE_SAFE_MODE=1 and CLAUDE_CODE_DISABLE_CLAUDE_MDS=1; does not set SIMPLE/--bare",
	},
	{
		flag: "--betas / --workload / --json-schema",
		change: "already in 88; wire through context, not per-slot env",
	},
]);

function isTruthy(value) {
	if (value == null || value === "") return false;
	return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function isFalsyEnv(value) {
	if (value == null || value === "") return false;
	return ["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

const api = {
	VERSION,
	NATIVE_BASE_VERSION,
	NATIVE_SDK_PACKAGE_VERSION,
	OFFICIAL_303_SDK_PACKAGE_VERSION,
	USER_FACING_VERSION,
	MODELS,
	MODEL_BY_ID,
	ALIASES,
	LATEST_PER_FAMILY,
	EFFORT_LEVELS,
	THINKING_MODES,
	THINKING_DISPLAYS,
	PERMISSION_MODES_303,
	BETA_REGISTRY,
	RESIDUAL_GAPS,
	NATIVE_HOOKS,
	CRAG_PORTABLE_CLI,
	withRequestContext,
	getRequestContext,
	getCliProtocolState,
	canonicalModelId,
	getModel,
	resolveModelAlias,
	upstreamModel,
	stripModelSuffix,
	has1mSuffix,
	nativeRequestId,
	nextFallbackModel,
	modelSupportsEffort,
	modelSupportsMaxEffort,
	modelSupportsXhighEffort,
	modelSupportsAdaptiveThinking,
	modelSupportsThinking,
	defaultEffortForModel,
	parseEffortValue,
	parseCliEffort,
	parseThinkingMode,
	parseThinkingDisplay,
	parseTaskBudget,
	parsePermissionMode,
	toEnginePermissionMode,
	toUserPermissionMode,
	parsePermissionPrompts,
	parsePromptSuggestions,
	parseFallbackModels,
	parseFallbackModelFlag,
	parseBetasFlag,
	parseAgentsJsonOrFile,
	thinkingConfigFromCli,
	assembleThinkingParam,
	configureEffortParams,
	configureTaskBudgetParams,
	effortFromContext,
	taskBudgetFromContext,
	normalizeRequestOptions,
	nativeMessagesParams,
	adaptNativeRequestBoundary,
	adaptNativeHeaders,
	buildUserAgent,
	buildMcpUserAgent,
	buildAttributionHeader,
	attributionGates,
	billingIndexesFromMessages,
	boundedBillingIndex,
	selectBetas,
	parseEnvBetas,
	compactJson,
	projectForCch,
	computeCch,
	stampCchBody,
	xxh64,
	applyCliActionFlags,
	shouldExcludeDynamicSection,
	stashDetachedPromptSection,
	mergeDetachedPromptContext,
	readSystemPromptSnapshot,
	storeSystemPromptSnapshot,
	restrictedDisallowedTools,
	nativeCliArgs,
	currentProvider,
};

globalThis[P303_KEY] = api;
globalThis[ALS_KEY] = als();

export default api;
