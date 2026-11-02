const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const DEFAULT_MAX_PROCS = 20;
const DEFAULT_MIN_PROCS = 0;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_QUEUE = 100;
const DEFAULT_TELEMETRY_FEATURES = "none";
const DEFAULT_ONE_SHOT_STRATEGY = "process";

const BOOLEAN_TRUE = new Set([
	"--help",
	"--version",
	"--single-process-subagents",
	"--continuous-tool-loop",
	"--no-continuous-tool-loop",
	"--one-shot",
	"--no-one-shot",
	"--strict-isolation",
	"--no-strict-isolation",
	"--direct",
	"--no-refusal-cutoff",
	"--allow-unauthenticated",
	"--bare",
]);

const VALUE_FLAGS = new Set([
	"--runtime",
	"--v2-transport",
	"--bun-path",
	"--host",
	"--port",
	"--api-key-env",
	"--max-procs",
	"--session-slots",
	"--min-procs",
	"--one-shot-strategy",
	"--claude-path",
	"--request-timeout-ms",
	"--tool-timeout-ms",
	"--queue-timeout-ms",
	"--max-queue",
	"--proxy",
	"--entrypoint",
	"--telemetry-features",
]);
export const HELP = `Usage: crag [options]

HTTP gateway for Claude Code with selectable native or v2 process runtimes.
Default runtime: native single-process logical-slot pool.
V2 runtime: --runtime=v2 --max-procs=20 --min-procs=0

  --runtime native|v2                 Runtime implementation (default: native)
  --v2-transport tui|print            v2 transport (default: tui; Linux tui only)
  --bare                              Pass Claude Code --bare (v2 mock auth)
  --host <addr>                      Bind address (default: 127.0.0.1)
  --port <n>                         Bind port (default: 8765)
  --api-key-env <name>               Env var holding the local API key
  --allow-unauthenticated            Allow a non-loopback bind without a key
  --max-procs <n>                    Physical capacity; v2 may run fewer TUI processes
  --session-slots <n>                Initial v2 runnable TUI slots (default: max-procs)
  --min-procs <n>                    Native warm slots; v2 starts per request
  --continuous-tool-loop             Keep native loop alive across tool results
  --no-continuous-tool-loop          Disable continuous tool waits
  --one-shot                         Isolate each request (see strategy)
  --no-one-shot                      Subagent slot pool (default)
  --one-shot-strategy process|session-reset
                                     process: retire the child after the turn
                                     session-reset: verified slot cleanup reuse
  --strict-isolation                 Distinct native session id per slot
  --no-strict-isolation              Shared process session id (default)
  --claude-path <path>                Claude cli.js path (v2 default: original 2.1.88)
  --request-timeout-ms <n>           Active turn deadline (default: 120000)
  --tool-timeout-ms <n>              Pending tool-wait deadline (default: 300000)
  --queue-timeout-ms <n>             Queue wait deadline (default: 30000)
  --max-queue <n>                    Max queued requests (default: 100)
  --proxy <url>                      Proxy for the Claude child only
  --direct                           Disable proxy for the Claude child only
  --entrypoint <name>                Child CLAUDE_CODE_ENTRYPOINT
  --telemetry-features none          Child telemetry allow-list (default: none)
  --no-refusal-cutoff                Keep refusal bytes unmodified
  --help                             Print this help
  --version                          Print version

Unknown options are errors. A public bind requires --api-key-env or
--allow-unauthenticated.`;

export function parseOptions(argv, env = process.env) {
	if (!Array.isArray(argv)) {
		throw new Error("argv must be an array of strings");
	}
	const envSource = env == null ? {} : env;

	const options = {
		runtime: "native",
		v2Transport: "tui",
		bare: false,
		bunPath: undefined,
		host: DEFAULT_HOST,
		port: DEFAULT_PORT,
		apiKey: undefined,
		apiKeyEnv: undefined,
		allowUnauthenticated: false,
		maxProcs: DEFAULT_MAX_PROCS,
		sessionSlots: undefined,
		minProcs: DEFAULT_MIN_PROCS,
		mode: "subagent-pool",
		strictIsolation: false,
		continuousToolLoop: true,
		claudePath: undefined,
		requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
		toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
		queueTimeoutMs: DEFAULT_QUEUE_TIMEOUT_MS,
		maxQueue: DEFAULT_MAX_QUEUE,
		entrypoint: undefined,
		telemetryFeatures: DEFAULT_TELEMETRY_FEATURES,
		noRefusalCutoff: false,
		help: false,
		version: false,
	};

	let pool = true;
	let strategy = DEFAULT_ONE_SHOT_STRATEGY;
	let proxyMode = "inherit";
	let proxyUrl;
	let apiKeyEnv;

	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (typeof token !== "string") {
			throw new Error("argv must be an array of strings");
		}
		if (token === "--") {
			if (i + 1 < argv.length) {
				throw new Error(`unexpected argument: ${argv[i + 1]}`);
			}
			break;
		}
		if (!token.startsWith("--")) {
			throw new Error(`unexpected argument: ${token}`);
		}

		let name = token;
		let value;
		let hasValue = false;
		const eq = token.indexOf("=");
		if (eq >= 0) {
			name = token.slice(0, eq);
			value = token.slice(eq + 1);
			hasValue = true;
		}

		if (BOOLEAN_TRUE.has(name)) {
			if (hasValue) {
				throw new Error(`${name} does not take a value`);
			}
			switch (name) {
				case "--help":
					options.help = true;
					break;
				case "--version":
					options.version = true;
					break;
				case "--single-process-subagents":
					pool = true;
					break;
				case "--continuous-tool-loop":
					options.continuousToolLoop = true;
					break;
				case "--no-continuous-tool-loop":
					options.continuousToolLoop = false;
					break;
				case "--one-shot":
					pool = false;
					break;
				case "--no-one-shot":
					pool = true;
					break;
				case "--strict-isolation":
					options.strictIsolation = true;
					break;
				case "--no-strict-isolation":
					options.strictIsolation = false;
					break;
				case "--direct":
					proxyMode = "direct";
					proxyUrl = undefined;
					break;
				case "--no-refusal-cutoff":
					options.noRefusalCutoff = true;
					break;
				case "--allow-unauthenticated":
					options.allowUnauthenticated = true;
					break;
				case "--bare":
					options.bare = true;
					break;
				default:
					throw new Error(`unknown option: ${name}`);
			}
			continue;
		}

		if (!VALUE_FLAGS.has(name)) {
			throw new Error(`unknown option: ${name}`);
		}

		if (!hasValue) {
			const next = argv[i + 1];
			if (next == null || typeof next !== "string" || next.startsWith("--")) {
				throw new Error(`${name} requires a value`);
			}
			value = next;
			i += 1;
		}
		if (value === "") {
			throw new Error(`${name} requires a value`);
		}

		switch (name) {
			case "--runtime":
				if (value !== "native" && value !== "v2") {
					throw new Error("--runtime must be native or v2");
				}
				options.runtime = value;
				break;
			case "--v2-transport":
				if (value !== "tui" && value !== "print") {
					throw new Error("--v2-transport must be tui or print");
				}
				options.v2Transport = value;
				break;
			case "--bun-path":
				options.bunPath = value;
				break;
			case "--host":
				options.host = value;
				break;
			case "--port":
				options.port = parseInteger(name, value, 0, 65535);
				break;
			case "--api-key-env":
				apiKeyEnv = value;
				break;
			case "--max-procs":
				options.maxProcs = parseInteger(
					name,
					value,
					1,
					Number.MAX_SAFE_INTEGER,
				);
				break;
			case "--session-slots":
				options.sessionSlots = parseInteger(
					name,
					value,
					1,
					Number.MAX_SAFE_INTEGER,
				);
				break;
			case "--min-procs":
				options.minProcs = parseInteger(
					name,
					value,
					0,
					Number.MAX_SAFE_INTEGER,
				);
				break;
			case "--one-shot-strategy":
				if (value !== "process" && value !== "session-reset") {
					throw new Error(
						"--one-shot-strategy must be process or session-reset",
					);
				}
				strategy = value;
				break;
			case "--claude-path":
				options.claudePath = value;
				break;
			case "--request-timeout-ms":
				options.requestTimeoutMs = parseInteger(
					name,
					value,
					0,
					Number.MAX_SAFE_INTEGER,
				);
				break;
			case "--tool-timeout-ms":
				options.toolTimeoutMs = parseInteger(
					name,
					value,
					0,
					Number.MAX_SAFE_INTEGER,
				);
				break;
			case "--queue-timeout-ms":
				options.queueTimeoutMs = parseInteger(
					name,
					value,
					0,
					Number.MAX_SAFE_INTEGER,
				);
				break;
			case "--max-queue":
				options.maxQueue = parseInteger(
					name,
					value,
					0,
					Number.MAX_SAFE_INTEGER,
				);
				break;
			case "--proxy":
				proxyMode = "proxy";
				proxyUrl = parseProxyUrl(value);
				break;
			case "--entrypoint":
				options.entrypoint = value;
				break;
			case "--telemetry-features":
				if (value !== "none") {
					throw new Error("--telemetry-features only supports none");
				}
				options.telemetryFeatures = value;
				break;
			default:
				throw new Error(`unknown option: ${name}`);
		}
	}

	if (options.minProcs > options.maxProcs) {
		throw new Error("--min-procs cannot exceed --max-procs");
	}
	if (options.sessionSlots != null && options.sessionSlots > options.maxProcs) {
		throw new Error("--session-slots cannot exceed --max-procs");
	}

	options.oneShotStrategy = strategy;
	options.mode = pool ? "subagent-pool" : strategy;

	if (apiKeyEnv) {
		options.apiKeyEnv = apiKeyEnv;
		if (!Object.hasOwn(envSource, apiKeyEnv)) {
			throw new Error(`environment variable ${apiKeyEnv} is not set`);
		}
		const apiKey = envSource[apiKeyEnv];
		if (typeof apiKey !== "string" || apiKey.length === 0) {
			throw new Error(`environment variable ${apiKeyEnv} is empty`);
		}
		options.apiKey = apiKey;
	}

	const envOverlay = {};
	if (options.entrypoint) {
		envOverlay.CLAUDE_CODE_ENTRYPOINT = options.entrypoint;
	}
	if (proxyMode === "proxy") {
		envOverlay.HTTP_PROXY = proxyUrl;
		envOverlay.HTTPS_PROXY = proxyUrl;
		envOverlay.ALL_PROXY = proxyUrl;
		envOverlay.http_proxy = proxyUrl;
		envOverlay.https_proxy = proxyUrl;
		envOverlay.all_proxy = proxyUrl;
	} else if (proxyMode === "direct") {
		envOverlay.HTTP_PROXY = "";
		envOverlay.HTTPS_PROXY = "";
		envOverlay.ALL_PROXY = "";
		envOverlay.http_proxy = "";
		envOverlay.https_proxy = "";
		envOverlay.all_proxy = "";
		envOverlay.NO_PROXY = "*";
		envOverlay.no_proxy = "*";
	}
	if (Object.keys(envOverlay).length > 0) {
		options.env = envOverlay;
	}

	if (!options.help && !options.version) {
		assertBindAuth(options);
	}

	return options;
}

export function assertBindAuth(options) {
	const host = options?.host ?? DEFAULT_HOST;
	const apiKey = options?.apiKey;
	const allow = options?.allowUnauthenticated === true;
	if (!isLoopbackHost(host) && !hasKey(apiKey) && !allow) {
		throw new Error(
			"non-loopback bind requires --api-key-env or --allow-unauthenticated",
		);
	}
}

export function isLoopbackHost(host) {
	if (host == null) return false;
	const raw = String(host).trim();
	if (raw.length === 0) return false;
	const value = raw.replace(/^\[|\]$/g, "").toLowerCase();
	if (value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1") {
		return true;
	}
	if (value.startsWith("::ffff:")) {
		return isLoopbackHost(value.slice("::ffff:".length));
	}
	const parts = value.split(".");
	if (parts.length === 4 && parts[0] === "127") {
		return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
	}
	return false;
}

function hasKey(apiKey) {
	return typeof apiKey === "string" && apiKey.length > 0;
}

function parseInteger(flag, raw, min, max) {
	if (!/^-?\d+$/.test(raw)) {
		throw new Error(`${flag} requires an integer`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) {
		throw new Error(`${flag} is out of range`);
	}
	if (value < min || value > max) {
		throw new Error(`${flag} must be between ${min} and ${max}`);
	}
	return value;
}

function parseProxyUrl(raw) {
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("--proxy must be a valid URL");
	}
	if (!parsed.protocol || parsed.protocol === ":") {
		throw new Error("--proxy must be a valid URL");
	}
	return raw;
}
