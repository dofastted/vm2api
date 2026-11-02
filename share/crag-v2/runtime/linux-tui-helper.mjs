import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { open, readFile, mkdir, writeFile } from "node:fs/promises";

const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const TRANSCRIPT_POLL_MS = 40;
const TAP_POLL_MS = 40;
const MAX_SCREEN_BYTES = 32 * 1024;

export async function createLinuxTuiHelper(options) {
	if (process.platform !== "linux") {
		throw new Error("Linux TUI helper requires Linux");
	}
	const helper = new LinuxTuiHelper(options);
	try {
		await helper.start();
		return helper;
	} catch (error) {
		await helper.stop("startup failed").catch(() => {});
		throw error;
	}
}

class LinuxTuiHelper {
	constructor(options = {}) {
		this.bunPath = String(options.bunPath || "bun");
		this.claudePath = String(options.claudePath);
		this.args = Array.isArray(options.args) ? options.args.map(String) : [];
		this.cwd = path.resolve(String(options.cwd || process.cwd()));
		this.env = { ...process.env, ...(options.env || {}) };
		this.sessionId = String(options.sessionId || randomUUID());
		this.tempDir = path.resolve(String(options.tempDir || this.cwd));
		this.readyTimeoutMs = Number(
			options.readyTimeoutMs || DEFAULT_READY_TIMEOUT_MS,
		);
		this.onTranscript =
			typeof options.onTranscript === "function"
				? options.onTranscript
				: () => {};
		this.onScreen =
			typeof options.onScreen === "function" ? options.onScreen : () => {};
		this.onTap = typeof options.onTap === "function" ? options.onTap : () => {};
		this.preloadPath = options.preloadPath
			? path.resolve(String(options.preloadPath))
			: null;
		this.tapPath = path.resolve(
			String(options.tapPath || path.join(this.tempDir, "tap.jsonl")),
		);
		this.child = null;
		this.dead = false;
		this.screen = "";
		this.stderr = "";
		this.ready = false;
		this.closed = false;
		this.readyPromise = null;
		this.readyResolve = null;
		this.readyReject = null;
		this.readyTimer = null;
		this.readyCandidateTimer = null;
		this.userWaiters = [];
		this.transcript = new TranscriptTailer(
			this.transcriptPath(),
			(row, sequence) => {
				this.onTranscript(row, sequence);
				this.resolveUserWaiters(row, sequence);
			},
		);
		this.tap = new TapTailer(this.tapPath, (row) => this.onTap(row));
	}

	pid() {
		return this.child?.pid || null;
	}

	async start() {
		await mkdir(this.tempDir, { recursive: true, mode: 0o700 });
		await writeFile(this.tapPath, "", { mode: 0o600 });
		this.transcript.start();
		this.tap.start();
		const command = [this.bunPath, this.claudePath, ...this.args]
			.map(shellQuote)
			.join(" ");
		const env = {
			...this.env,
			CRAG_TUI_TAP: this.tapPath,
			...(this.preloadPath
				? { BUN_OPTIONS: appendPreload(this.env.BUN_OPTIONS, this.preloadPath) }
				: {}),
		};
		const child = spawn("script", ["-qefc", `exec ${command}`, "/dev/null"], {
			cwd: this.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
			windowsHide: true,
		});
		this.child = child;
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => this.acceptScreen(String(chunk)));
		child.stderr?.on("data", (chunk) => {
			this.stderr = bounded(`${this.stderr}${String(chunk)}`, 32 * 1024);
		});
		child.once("error", (error) => this.fail(error));
		child.once("close", (code, signal) => {
			this.dead = true;
			const detail = this.stderr || this.screen;
			const error = new Error(
				`Claude TUI exited${signal ? ` by ${signal}` : ` with code ${code}`}${detail ? `: ${bounded(detail, 800)}` : ""}`,
			);
			if (!this.ready) this.readyReject?.(error);
			for (const waiter of this.userWaiters.splice(0)) waiter.reject(error);
		});
		this.readyPromise = new Promise((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
			this.readyTimer = setTimeout(() => {
				this.stop("ready timeout").catch(() => {});
				reject(
					new Error(
						`Claude TUI ready timeout${this.screen ? `: ${bounded(this.screen, 800)}` : ""}`,
					),
				);
			}, this.readyTimeoutMs);
		});
		await this.readyPromise;
	}

	async send(content) {
		if (!this.ready || this.dead || !this.child?.stdin) {
			throw new Error("Claude TUI is not ready");
		}
		const sequence = this.transcript.sequence;
		const pieces = await materializePieces(content, this.tempDir);
		const userQueued = this.waitForUser(sequence);
		try {
			for (const piece of pieces) {
				await this.writePaste(piece);
			}
			await this.writeRaw("\r");
			await userQueued;
		} finally {
			await removePieces(pieces);
		}
	}

	async stop(reason = "stopped") {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.readyTimer);
		clearTimeout(this.readyCandidateTimer);
		this.transcript.stop();
		this.tap.stop();
		for (const waiter of this.userWaiters.splice(0)) {
			if (reason === "slot release") waiter.resolve();
			else waiter.reject(new Error(`TUI stopped: ${reason}`));
		}
		const child = this.child;
		if (!child || child.exitCode != null) return;
		const pid = Number(child.pid);
		try {
			if (pid > 0) process.kill(-pid, "SIGTERM");
			else child.kill("SIGTERM");
		} catch {}
		await waitForClose(child, 2_000);
		if (child.exitCode == null) {
			try {
				if (pid > 0) process.kill(-pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {}
		}
	}

	async settleTap(timeoutMs = 1_000) {
		await sleep(50);
		return this.tap.waitSettled(timeoutMs);
	}

	transcriptPath() {
		const configDir =
			this.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
		return path.join(
			configDir,
			"projects",
			sanitizePath(this.cwd),
			`${this.sessionId}.jsonl`,
		);
	}

	acceptScreen(chunk) {
		const clean = stripAnsi(chunk);
		this.screen = bounded(`${this.screen}${clean}`, MAX_SCREEN_BYTES);
		this.onScreen(this.screen);
		if (!this.ready && isInteractiveRefusal(this.screen)) {
			this.readyReject?.(
				new Error(`Claude TUI refused startup: ${bounded(this.screen, 800)}`),
			);
			return;
		}
		if (!this.ready && isReadyScreen(this.screen)) {
			if (this.screen.includes("CRAG_READY")) {
				this.confirmReady();
			} else if (!this.readyCandidateTimer) {
				this.readyCandidateTimer = setTimeout(() => {
					this.readyCandidateTimer = null;
					if (!this.ready && !isInteractiveRefusal(this.screen))
						this.confirmReady();
				}, 500);
			}
		}
	}

	confirmReady() {
		if (this.ready) return;
		this.ready = true;
		clearTimeout(this.readyTimer);
		this.readyResolve?.();
	}

	async writePaste(piece) {
		const raw = piece.path || piece.text || "";
		const clean = pasteable(raw);
		await this.writeRaw(`\x1b[200~${clean}\x1b[201~`);
		await sleep(40);
	}

	async writeRaw(value) {
		if (!this.child?.stdin || this.dead)
			throw new Error("Claude TUI stdin is closed");
		await new Promise((resolve, reject) => {
			this.child.stdin.write(value, (error) =>
				error ? reject(error) : resolve(),
			);
		});
	}

	waitForUser(afterSequence) {
		return new Promise((resolve, reject) => {
			this.userWaiters.push({ afterSequence, resolve, reject });
		});
	}

	resolveUserWaiters(row, sequence) {
		if (row?.type !== "user" || sequence <= 0) return;
		for (let i = this.userWaiters.length - 1; i >= 0; i -= 1) {
			const waiter = this.userWaiters[i];
			if (sequence <= waiter.afterSequence) continue;
			this.userWaiters.splice(i, 1);
			waiter.resolve();
		}
	}

	fail(error) {
		this.dead = true;
		if (!this.ready) this.readyReject?.(error);
		for (const waiter of this.userWaiters.splice(0)) waiter.reject(error);
	}
}

class TranscriptTailer {
	constructor(file, onRow) {
		this.file = file;
		this.onRow = onRow;
		this.offset = 0;
		this.buffer = "";
		this.sequence = 0;
		this.timer = null;
		this.running = false;
		this.polling = false;
		this.chunk = Buffer.allocUnsafe(64 * 1024);
	}

	start() {
		if (this.running) return;
		this.running = true;
		void this.poll();
		this.timer = setInterval(() => void this.poll(), TRANSCRIPT_POLL_MS);
	}

	stop() {
		this.running = false;
		clearInterval(this.timer);
		this.timer = null;
	}

	async poll() {
		if (!this.running || this.polling) return;
		this.polling = true;
		try {
			const next = await readIncremental(
				this.file,
				this.offset,
				this.buffer,
				this.chunk,
			);
			this.offset = next.offset;
			this.buffer = next.buffer;
			const lines = this.buffer.split(/\r?\n/);
			this.buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					this.sequence += 1;
					this.onRow(JSON.parse(line), this.sequence);
				} catch {}
			}
		} catch (error) {
			if (error?.code !== "ENOENT") this.stop();
		} finally {
			this.polling = false;
		}
	}
}

class TapTailer {
	constructor(file, onRow) {
		this.file = file;
		this.onRow = onRow;
		this.offset = 0;
		this.buffer = "";
		this.open = new Set();
		this.timer = null;
		this.running = false;
		this.polling = false;
		this.chunk = Buffer.allocUnsafe(64 * 1024);
		this.waiters = [];
	}

	start() {
		if (this.running) return;
		this.running = true;
		void this.poll();
		this.timer = setInterval(() => void this.poll(), TAP_POLL_MS);
	}

	stop() {
		this.running = false;
		clearInterval(this.timer);
		this.timer = null;
		for (const waiter of this.waiters.splice(0)) waiter();
	}

	waitSettled(timeoutMs) {
		if (this.open.size === 0) return Promise.resolve();
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				const index = this.waiters.indexOf(done);
				if (index >= 0) this.waiters.splice(index, 1);
				resolve();
			}, timeoutMs);
			this.waiters.push(done);
		});
	}

	async poll() {
		if (!this.running || this.polling) return;
		this.polling = true;
		try {
			const next = await readIncremental(
				this.file,
				this.offset,
				this.buffer,
				this.chunk,
			);
			this.offset = next.offset;
			this.buffer = next.buffer;
			const lines = this.buffer.split(/\r?\n/);
			this.buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const row = JSON.parse(line);
					if (row.open && row.s != null) this.open.add(row.s);
					if (row.end && row.s != null) this.open.delete(row.s);
					this.onRow(row);
					if (this.open.size === 0) {
						for (const waiter of this.waiters.splice(0)) waiter();
					}
				} catch {}
			}
		} catch (error) {
			if (error?.code !== "ENOENT") this.stop();
		} finally {
			this.polling = false;
		}
	}
}

async function readIncremental(file, offset, buffered, chunk) {
	const handle = await open(file, "r");
	try {
		const { size } = await handle.stat();
		let position = offset;
		let buffer = buffered;
		if (size < position) {
			position = 0;
			buffer = "";
		}
		while (position < size) {
			const length = Math.min(chunk.length, size - position);
			const { bytesRead } = await handle.read(chunk, 0, length, position);
			if (!bytesRead) break;
			buffer += chunk.subarray(0, bytesRead).toString("utf8");
			position += bytesRead;
		}
		return { offset: position, buffer };
	} finally {
		await handle.close();
	}
}

async function materializePieces(content, tempDir) {
	const blocks = Array.isArray(content)
		? content
		: [{ type: "text", text: String(content ?? "") }];
	const pieces = [];
	for (const block of blocks) {
		if (typeof block === "string" || block?.type === "text") {
			pieces.push({
				text: typeof block === "string" ? block : block.text || "",
			});
			continue;
		}
		if (block?.type === "image" && block.source?.type === "base64") {
			const media = String(block.source.media_type || "").toLowerCase();
			const ext = {
				"image/png": "png",
				"image/jpeg": "jpg",
				"image/gif": "gif",
				"image/webp": "webp",
			}[media];
			if (!ext)
				throw new Error(`unsupported TUI image type: ${media || "unknown"}`);
			const file = path.join(tempDir, `image-${randomUUID()}.${ext}`);
			await writeFile(
				file,
				Buffer.from(String(block.source.data || ""), "base64"),
				{ mode: 0o600 },
			);
			pieces.push({ path: file });
			continue;
		}
		throw new Error(
			`unsupported TUI content block: ${block?.type || "unknown"}`,
		);
	}
	return pieces;
}

async function removePieces(pieces) {
	for (const piece of pieces) {
		if (piece.path) {
			try {
				await import("node:fs/promises").then(({ unlink }) =>
					unlink(piece.path),
				);
			} catch {}
		}
	}
}

function transcriptContent(row) {
	const content = row?.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text || "")
		.join("\n");
}

function pasteable(value) {
	let text = String(value).replace(/\r\n?/g, "\n").replace(CONTROL_RE, "");
	if (/^[\/*!#&]/.test(text)) text = `\n${text}`;
	return text.trim() ? text : ".";
}

function isReadyScreen(screen) {
	return (
		screen.includes("CRAG_READY") ||
		/(?:^|\n)\s*[❯›][ \t]?[^\n]*$/m.test(screen)
	);
}

function isInteractiveRefusal(screen) {
	return /(?:sign\s*in|log\s*in|login\s*method|select\s*login|onboarding|trust\s*this\s*folder|permission\s*required|choose\s*the\s*text\s*style)/i.test(
		screen,
	);
}

function stripAnsi(value) {
	return String(value).replace(ANSI_RE, "");
}
function sanitizePath(value) {
	const sanitized = String(value).replace(/[^a-zA-Z0-9]/g, "-");
	if (sanitized.length <= 200) return sanitized;
	const hash = createHash("sha256")
		.update(String(value))
		.digest("hex")
		.slice(0, 12);
	return `${sanitized.slice(0, 200)}-${hash}`;
}

export function appendPreload(existing, preloadPath) {
	const option = `--preload=${preloadPath}`;
	return existing ? `${existing} ${option}` : option;
}
function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function bounded(value, max) {
	const text = String(value);
	return text.length > max ? text.slice(-max) : text;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
