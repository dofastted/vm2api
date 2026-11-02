const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CACHE_TTLS = new Set(["5m", "1h"]);
const MAX_TUI_TOKENS = 1_000_000;

export function normalizeTuiRequestOptions(options = {}) {
	const out = {};
	if (options.maxTokens != null) {
		const n = Number(options.maxTokens);
		if (!Number.isSafeInteger(n) || n < 1 || n > MAX_TUI_TOKENS)
			throw new Error("max_tokens must be an integer from 1 to 1000000");
		out.maxTokens = n;
	}
	if (options.effort != null) {
		const effort = String(options.effort).toLowerCase();
		if (!EFFORTS.has(effort))
			throw new Error("effort must be low, medium, high, xhigh, or max");
		out.effort = effort;
	}
	if (options.cacheTtl != null) {
		const ttl = String(options.cacheTtl).toLowerCase();
		if (!CACHE_TTLS.has(ttl)) throw new Error("cache_ttl must be 5m or 1h");
		out.cacheTtl = ttl;
	}
	return out;
}

export function tuiRequestOptionsFromEnv(env = process.env) {
	return normalizeTuiRequestOptions({
		maxTokens: env?.CRAG_TUI_MAX_TOKENS,
		effort: env?.CRAG_TUI_EFFORT,
		cacheTtl: env?.CRAG_TUI_CACHE_TTL,
	});
}

/**
 * Apply CRAG-only generation controls to the original Claude Messages body.
 * The Claude bundle remains unchanged; this runs at its fetch boundary.
 */
export function applyTuiRequestOverrides(input, init, options = {}) {
	const overrides = normalizeTuiRequestOptions(options);
	if (Object.keys(overrides).length === 0) return { input, init };

	const url = String((input && input.url) || input || "");
	if (!/\/v1\/messages(?:\?|$)/.test(url)) return { input, init };
	if (!init || typeof init !== "object" || init.body == null)
		return { input, init };

	const source = decodeBody(init.body);
	if (!source) return { input, init };
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return { input, init };
	}
	if (!body || typeof body !== "object" || Array.isArray(body))
		return { input, init };

	let changed = false;
	if (overrides.maxTokens != null) {
		body.max_tokens = overrides.maxTokens;
		changed = true;
	}
	if (overrides.effort != null) {
		body.output_config = {
			...(body.output_config && typeof body.output_config === "object"
				? body.output_config
				: {}),
			effort: overrides.effort,
		};
		changed = true;
	}
	if (overrides.cacheTtl != null) {
		changed = applyCacheTtl(body, overrides.cacheTtl) || changed;
	}
	if (!changed) return { input, init };

	const nextInit = { ...init, body: JSON.stringify(body) };
	if (init.headers != null) {
		const headers = new Headers(init.headers);
		headers.delete("content-length");
		nextInit.headers = headers;
	}
	return { input, init: nextInit };
}

function decodeBody(value) {
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
	return null;
}

function applyCacheTtl(value, ttl) {
	let changed = false;
	if (Array.isArray(value)) {
		for (const item of value) changed = applyCacheTtl(item, ttl) || changed;
		return changed;
	}
	if (!value || typeof value !== "object") return false;
	if (value.cache_control && typeof value.cache_control === "object") {
		value.cache_control.ttl = ttl;
		changed = true;
	}
	for (const child of Object.values(value))
		changed = applyCacheTtl(child, ttl) || changed;
	return changed;
}
