import fs from "node:fs";
import {
	applyTuiRequestOverrides,
	tuiRequestOptionsFromEnv,
} from "./tui-request-options.mjs";

// Linux-only Bun preload used by the CRAG TUI helper. It tees the main
// Messages SSE response into a private JSONL file and applies CRAG-only
// generation controls at the original Claude fetch boundary.
(() => {
	const file = process.env.CRAG_TUI_TAP || "";
	const requestOptions = tuiRequestOptionsFromEnv();
	if (!file && Object.keys(requestOptions).length === 0) return;
	if (file) delete process.env.CRAG_TUI_TAP;

	const preload = /(^|\s)--preload(?:=|\s+)\S*linux-tui-tap\.js/;
	const options = (process.env.BUN_OPTIONS || "").replace(preload, "").trim();
	if (options) process.env.BUN_OPTIONS = options;
	else delete process.env.BUN_OPTIONS;

	const argv = process.execArgv;
	for (let i = argv.length - 1; i >= 0; i -= 1) {
		if (!/linux-tui-tap\.js/.test(argv[i])) continue;
		if (argv[i].startsWith("--preload=")) argv.splice(i, 1);
		else if (argv[i - 1] === "--preload") argv.splice(i - 1, 2);
	}

	let fd = null;
	if (file) {
		try {
			fd = fs.openSync(file, "a", 0o600);
		} catch {}
	}

	const put = (value) => {
		if (fd == null) return;
		try {
			fs.writeSync(fd, JSON.stringify(value) + "\n");
		} catch {}
	};

	const FetchSession = globalThis.Bun && Bun.FetchSession;
	const RealFetch = globalThis.fetch;
	if (typeof FetchSession !== "function" && typeof RealFetch !== "function") {
		put({ tap: "none" });
		return;
	}

	let streamId = 0;
	const read = async (id, body) => {
		const decoder = new TextDecoder();
		let buffer = "";
		const parse = (packet) => {
			const data = packet
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).replace(/^ /, ""))
				.join("\n");
			if (!data) return;
			let event;
			try {
				event = JSON.parse(data);
			} catch {
				return;
			}
			if (event && event.type !== "ping") put({ s: id, e: event });
		};
		try {
			for await (const chunk of body) {
				buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(
					/\r\n?/g,
					"\n",
				);
				let boundary;
				while ((boundary = buffer.indexOf("\n\n")) >= 0) {
					parse(buffer.slice(0, boundary));
					buffer = buffer.slice(boundary + 2);
				}
			}
			if (buffer.trim()) parse(buffer);
			put({ s: id, end: "done" });
		} catch {
			put({ s: id, end: "cut" });
		}
	};

	async function maybeCapture(input, init, response) {
		try {
			const url = String((input && input.url) || input);
			const headers = new Headers(
				(init && init.headers) || (input && input.headers) || undefined,
			);
			if (
				headers.get("x-claude-code-request-class") === "main" &&
				/\/v1\/messages(?:\?|$)/.test(url) &&
				response.body &&
				/^text\/event-stream/.test(response.headers.get("content-type") || "")
			) {
				const [original, copy] = response.body.tee();
				Object.defineProperty(response, "body", {
					value: original,
					configurable: true,
				});
				const id = ++streamId;
				put({ s: id, open: true });
				void read(id, copy);
			}
		} catch {}
		return response;
	}

	if (typeof FetchSession === "function") {
		class CragFetchSession extends FetchSession {
			async fetch(input, init) {
				const prepared = applyTuiRequestOverrides(input, init, requestOptions);
				return maybeCapture(
					prepared.input,
					prepared.init,
					await super.fetch(prepared.input, prepared.init),
				);
			}
		}
		try {
			Bun.FetchSession = CragFetchSession;
			put({
				tap: Bun.FetchSession === CragFetchSession ? "on" : "none",
				mode: "fetch_session",
			});
		} catch {
			put({ tap: "none" });
		}
		return;
	}

	try {
		globalThis.fetch = async (input, init) => {
			const prepared = applyTuiRequestOverrides(input, init, requestOptions);
			return maybeCapture(
				prepared.input,
				prepared.init,
				await RealFetch(prepared.input, prepared.init),
			);
		};
		put({ tap: "on", mode: "global_fetch" });
	} catch {
		put({ tap: "none" });
	}
})();
