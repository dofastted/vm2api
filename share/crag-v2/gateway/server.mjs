import { createHash, timingSafeEqual } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createServer } from "node:http";
import {
	ProtocolError,
	normalizeRequest,
	formatResponse,
	createStreamEncoder,
	formatError,
} from "./protocol.mjs";
import { createRuntime as defaultCreateRuntime } from "./runtime.mjs";
import { createV2Runtime } from "./v2-runtime.mjs";
import { MODELS } from "../runtime/protocol303.mjs";
import { assertBindAuth } from "./options.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const SSE_HEADERS = {
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache, no-transform",
	connection: "keep-alive",
};
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
};
const GEMINI_PATH =
	/^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/;

export async function startServer(
	options = {},
	createRuntimeFn = defaultCreateRuntime,
) {
	const opts = normalizeServerOptions(options);
	assertBindAuth(opts);

	const models = opts.models ?? MODELS;
	if (!Array.isArray(models)) {
		throw new Error(
			"model catalog missing: pass options.models or export MODELS from runtime/protocol303.mjs",
		);
	}

	const factory =
		typeof createRuntimeFn === "function" &&
		createRuntimeFn !== defaultCreateRuntime
			? createRuntimeFn
			: opts.runtime === "v2"
				? createV2Runtime
				: defaultCreateRuntime;
	const runtime = await Promise.resolve(factory(runtimeOptions(opts)));
	if (
		runtime == null ||
		typeof runtime.run !== "function" ||
		typeof runtime.health !== "function" ||
		typeof runtime.close !== "function"
	) {
		throw new Error("createRuntime must return {run, health, close}");
	}

	const server = createServer((req, res) => {
		handleRequest(req, res, { opts, runtime, models }).catch((error) => {
			if (res.headersSent || res.destroyed) {
				if (!res.destroyed) res.destroy();
				return;
			}
			const protocol = protocolFor(
				new URL(req.url ?? "/", "http://127.0.0.1").pathname,
			);
			sendJson(res, errorStatus(error), safeFormatError(protocol, error));
		});
	});
	const sockets = new Set();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
  server.timeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  try {
    await listen(server, opts);
  } catch (error) {
    await runtime.close();
    throw error;
  }

	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		const httpClosed = new Promise((resolve, reject) => {
			server.close((error) => {
				if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
				else resolve();
			});
			destroyHttpConnections(server, sockets);
		});
    try {
      await runtime.close();
    } finally {
      destroyHttpConnections(server, sockets);
      await httpClosed;
      if (opts.socketPath) await unlink(opts.socketPath).catch(() => {});
    }

  };
	return {
		server,
		runtime,
		address: server.address(),
		close,
	};
}

function normalizeServerOptions(options) {
  const opts = options == null ? {} : options;
  return {
    ...opts,
    host: opts.host ?? DEFAULT_HOST,
    port: opts.port ?? DEFAULT_PORT,
    socketPath: opts.socketPath == null ? null : String(opts.socketPath),
    internalToken: opts.internalToken == null ? "" : String(opts.internalToken),
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    allowUnauthenticated: opts.allowUnauthenticated === true,
  };
}

function runtimeOptions(opts) {
	const selected = {
		runtime: opts.runtime,
		v2Transport: opts.v2Transport,
		bare: opts.bare,
		bunPath: opts.bunPath,
		maxProcs: opts.maxProcs,
		sessionSlots: opts.sessionSlots,
		minProcs: opts.minProcs,
		mode: opts.mode,
		strictIsolation: opts.strictIsolation,
		continuousToolLoop: opts.continuousToolLoop,
		requestTimeoutMs: opts.requestTimeoutMs,
		toolTimeoutMs: opts.toolTimeoutMs,
		queueTimeoutMs: opts.queueTimeoutMs,
		maxQueue: opts.maxQueue,
		env: opts.env,
		cwd: opts.cwd,
		entrypoint: opts.entrypoint,
		telemetryFeatures: opts.telemetryFeatures,
		noRefusalCutoff: opts.noRefusalCutoff,
	};
	if (opts.claudePath != null) selected.claudePath = opts.claudePath;
	return Object.fromEntries(
		Object.entries(selected).filter(([, value]) => value !== undefined),
	);
}

async function listen(server, options) {
  const { host, port, socketPath } = options;
  if (socketPath) {
    await unlink(socketPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (socketPath) server.listen(socketPath);
    else server.listen({ host, port });
  });
}

async function handleRequest(req, res, context) {
	const { opts, runtime, models } = context;
	const url = new URL(
		req.url ?? "/",
		`http://${req.headers.host || "127.0.0.1"}`,
	);
	const pathname = url.pathname;
	const protocol = protocolFor(pathname);
	const method = (req.method ?? "GET").toUpperCase();
	try {
    if (pathname === "/health" || pathname === "/healthz") {
      if (method !== "GET" && method !== "HEAD") {
        throwMethod(protocol, "GET, HEAD");
      }
      return sendHealth(res, runtime, method === "HEAD");
    }

    if (
      opts.internalToken &&
      !timingSafeEqualKey(headerValue(req.headers["x-kin-internal-token"]), opts.internalToken) &&
      !timingSafeEqualKey(headerValue(req.headers["x-internal-token"]), opts.internalToken)
    ) {
      throwHttp(401, "authentication_error", "Invalid internal token");
    }
    if (pathname === "/internal/health") {
      if (method !== "GET" && method !== "HEAD") {
        throwMethod(protocol, "GET, HEAD");
      }
      return sendHealth(res, runtime, method === "HEAD");
    }

    if (opts.apiKey && !authorized(req, url, opts.apiKey)) {
      throwHttp(401, "authentication_error", "Invalid API key");
    }

    if (pathname === "/v1/models") {
      if (method !== "GET" && method !== "HEAD") {
        throwMethod(protocol, "GET, HEAD");
      }
      const body = {
        object: "list",
        data: models.map(cloneModel),
        has_more: false,
      };
      if (models.length > 0) {
        const first = models[0];
        const last = models[models.length - 1];
        if (first && typeof first === "object" && first.id != null)
          body.first_id = first.id;
        if (last && typeof last === "object" && last.id != null)
          body.last_id = last.id;
      }
      if (method === "HEAD") {
        res.writeHead(200, JSON_HEADERS);
        res.end();
        return;
      }
      sendJson(res, 200, body);
      return;
    }

    const gemini = GEMINI_PATH.exec(pathname);
    const internal = pathname.startsWith("/internal/");
    const isMessageRoute =
      pathname === "/v1/messages" ||
      pathname === "/v1/chat/completions" ||
      pathname === "/internal/v1/messages" ||
      pathname === "/internal/v1/chat/completions" ||
      gemini;
    if (isMessageRoute) {
      if (method !== "POST") {
        throwMethod(protocol, "POST");
      }
      const envelope = internal ? await readJsonBody(req, opts.maxBodyBytes) : null;
      const body = internal
        ? envelope.body
        : await readJsonBody(req, opts.maxBodyBytes);
      const urlModel = gemini ? decodeURIComponent(gemini[1]) : undefined;
      const forceStream = internal
        ? envelope.stream === true || gemini?.[2] === "streamGenerateContent"
        : gemini?.[2] === "streamGenerateContent";
      await dispatchTurn(req, res, {
        runtime,
        protocol,
        body,
        urlModel,
        forceStream,
        maxBodyBytes: opts.maxBodyBytes,
        internal,
        principal: principalIdentity(
          internal
            ? headerValue(req.headers["x-tenant-id"]) || opts.internalToken
            : opts.apiKey,
        ),
      });
      return;
    }

		throwHttp(404, "not_found_error", "Not found");
	} catch (error) {
		await sendFailure(res, protocol, error);
		if (error?.status === 413 && !req.destroyed) req.destroy();
	}
}

async function sendHealth(res, runtime, head) {
	let health;
	try {
		health = runtime.health();
	} catch (error) {
		sendJson(res, 500, fallbackError("anthropic", error));
		return;
	}
	const ready = health?.ok !== false && health?.ready !== false;
	const status = ready ? 200 : 503;
	if (head) {
		res.writeHead(status, JSON_HEADERS);
		res.end();
		return;
	}
	sendJson(res, status, health);
}

async function dispatchTurn(
	req,
	res,
  {
    runtime,
    protocol,
    body,
    urlModel,
    forceStream,
    maxBodyBytes,
    internal = false,
    principal = "",
  },
) {
	const canonical = normalizeRequest(
		protocol,
		body,
		urlModel == null ? {} : { model: urlModel },
	);
	const stream = forceStream || canonical?.stream === true;
  const ac = new AbortController();
  let eventCount = 0;
  let settled = false;
	const onDisconnect = () => {
		if (settled || res.writableEnded) return;
		if (!ac.signal.aborted) ac.abort(abortError());
	};
	// IncomingMessage 'close' after readJsonBody means the request completed, not
	// that the client dropped the response socket.
	res.on("close", onDisconnect);
	res.on("error", onDisconnect);

	const encoder = stream
		? createStreamEncoder(protocol, {
				model: canonical?.model,
				id: canonical?.id,
			})
		: null;
	const writer = stream
		? createBoundedWriter(res, ac, maxBodyBytes, () => settled)
		: null;

	try {
    if (stream) {
      res.writeHead(200, {
        ...SSE_HEADERS,
        ...(internal ? { trailer: "x-terminal-state, x-event-count, x-usage, x-model, x-stop-reason" } : {}),
      });
      if (typeof res.flushHeaders === "function") res.flushHeaders();
    }

    const message = await runtime.run(canonical, {
      signal: ac.signal,
      principal: principal == null ? "" : String(principal),
      onEvent: stream
        ? (event) => {
            eventCount += 1;
            return writer.write(encoder.push(event));
          }
        : undefined,
    });
		settled = true;

    if (stream) {
      writer.write(encoder.finish());
      await writer.flush();
      if (internal && typeof res.addTrailers === "function")
        res.addTrailers(internalMetaHeaders(message, "verified", eventCount));
      if (!res.writableEnded) res.end();
      return;
    }

    sendJson(
      res,
      200,
      formatResponse(protocol, message),
      internal ? internalMetaHeaders(message, "verified", eventCount) : {},
    );
	} catch (error) {
		settled = true;
		if (
			isAbortError(error) ||
			isDisconnectError(error) ||
			isAbortError(ac.signal.reason) ||
			isDisconnectError(ac.signal.reason)
		) {
			if (!res.headersSent && !res.destroyed) {
				res.statusCode = 499;
				res.end();
			} else if (!res.writableEnded && !res.destroyed) {
				res.end();
			}
			return;
		}
		await sendFailure(res, protocol, error);
	} finally {
		settled = true;
		res.off("close", onDisconnect);
		res.off("error", onDisconnect);
	}
}

function createBoundedWriter(res, ac, limitBytes, isSettled) {
	let chain = Promise.resolve();
	let queued = 0;
	let failed = null;

	const fail = (error) => {
		const err = error instanceof Error ? error : new Error(String(error));
		const mapped = isDisconnectError(err)
			? isAbortError(err)
				? err
				: abortError()
			: err;
		if (!failed) failed = mapped;
		if (!isSettled() && !ac.signal.aborted) ac.abort(failed);
		return failed;
	};

	const writeRaw = async (data) => {
		if (failed) throw failed;
		if (ac.signal.aborted) {
			throw fail(
				ac.signal.reason instanceof Error ? ac.signal.reason : abortError(),
			);
		}
		if (res.destroyed || res.errored) {
			throw fail(res.errored instanceof Error ? res.errored : abortError());
		}
		if (res.writableEnded) {
			throw fail(abortError());
		}
		let ok;
		try {
			ok = res.write(data);
		} catch (error) {
			throw fail(error);
		}
		if (ok === false) {
			await waitForDrain(res, ac.signal);
		}
	};

	return {
		write(chunks) {
			if (failed) throw failed;
			const data = joinChunks(chunks);
			if (!data) return chain;
			const size = Buffer.byteLength(data);
			queued += size;
			if (queued > limitBytes) {
				queued -= size;
				const error = httpError(
					503,
					"overloaded_error",
					"SSE backpressure limit exceeded",
				);
				throw fail(error);
			}
			const previous = chain;
			chain = (async () => {
				try {
					await previous;
					await writeRaw(data);
				} catch (error) {
					throw fail(error);
				} finally {
					queued -= size;
				}
			})();
			return chain;
		},
		async flush() {
			try {
				await chain;
			} catch (error) {
				throw failed || error;
			}
			if (failed) throw failed;
		},
	};
}

function joinChunks(chunks) {
	if (chunks == null) return "";
	if (typeof chunks === "string") return chunks;
	if (Buffer.isBuffer(chunks)) return chunks.toString("utf8");
	if (Array.isArray(chunks)) return chunks.join("");
	return String(chunks);
}

async function waitForDrain(res, signal) {
	if (signal.aborted) {
		throw signal.reason instanceof Error ? signal.reason : abortError();
	}
	if (res.destroyed || res.writableEnded || res.errored) {
		throw res.errored instanceof Error ? res.errored : abortError();
	}
	if (!res.writableNeedDrain) return;
	const { promise, resolve, reject } = Promise.withResolvers();
	const onDrain = () => resolve();
	const onClose = () => reject(abortError());
	const onError = (err) => reject(err instanceof Error ? err : abortError());
	const onAbort = () =>
		reject(signal.reason instanceof Error ? signal.reason : abortError());
	res.once("drain", onDrain);
	res.once("close", onClose);
	res.once("error", onError);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await promise;
	} finally {
		res.off("drain", onDrain);
		res.off("close", onClose);
		res.off("error", onError);
		signal.removeEventListener("abort", onAbort);
	}
}

function abortError() {
	const error = new Error("aborted");
	error.name = "AbortError";
	return error;
}

function isAbortError(error) {
	return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function isDisconnectError(error) {
	if (error == null) return false;
	if (isAbortError(error)) return true;
	const code = error.code;
	return (
		code === "EPIPE" ||
		code === "ECONNRESET" ||
		code === "ECONNABORTED" ||
		code === "ERR_STREAM_DESTROYED" ||
		code === "ERR_STREAM_WRITE_AFTER_END" ||
		code === "ERR_STREAM_PREMATURE_CLOSE" ||
		code === "ERR_HTTP_STREAM_DESTROYED"
	);
}

function destroyHttpConnections(server, sockets) {
	if (typeof server.closeIdleConnections === "function") {
		server.closeIdleConnections();
	}
	if (typeof server.closeAllConnections === "function") {
		server.closeAllConnections();
	}
	for (const socket of sockets) {
		socket.destroy();
	}
	sockets.clear();
}

function principalIdentity(apiKey) {
	if (typeof apiKey !== "string" || apiKey.length === 0) return "";
	return createHash("sha256").update(apiKey).digest("hex");
}

async function sendFailure(res, protocol, error) {
	if (res.destroyed) return;
	if (isAbortError(error) || isDisconnectError(error)) {
		if (res.writableEnded) return;
		try {
			if (!res.headersSent) res.statusCode = 499;
			res.end();
		} catch {
			if (!res.destroyed) res.destroy();
		}
		return;
	}
	const status = errorStatus(error);
	const body = safeFormatError(protocol, error);
	const extra = {};
	if (error?.allow) extra.allow = error.allow;
	try {
		if (!res.headersSent) {
			sendJson(res, status, body, extra);
			return;
		}
		if (!res.writableEnded) {
			res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
			res.end();
		}
	} catch {
		if (!res.destroyed) res.destroy();
	}
}
function internalMetaHeaders(message, terminal, eventCount) {
  return {
    "x-terminal-state": terminal,
    "x-event-count": String(eventCount),
    "x-usage": JSON.stringify(message?.usage || {}),
    "x-model": String(message?.model || ""),
    "x-stop-reason": String(message?.stop_reason || ""),
  };
}


function sendJson(res, status, body, extraHeaders = {}) {
	if (res.destroyed || res.writableEnded) return;
	const payload = JSON.stringify(body);
	try {
		res.writeHead(status, {
			...JSON_HEADERS,
			"content-length": Buffer.byteLength(payload),
			...extraHeaders,
		});
		res.end(payload);
	} catch (error) {
		if (!res.destroyed) res.destroy();
		if (!isDisconnectError(error) && !isAbortError(error)) throw error;
	}
}

function authorized(req, url, expected) {
	const presented = presentedKey(req, url);
	return presented != null && timingSafeEqualKey(presented, expected);
}

function presentedKey(req, url) {
	const authorization = headerValue(req.headers.authorization);
	if (authorization) {
		const match = /^Bearer\s+(\S+)/i.exec(authorization);
		if (match) return match[1];
		return null;
	}
	const apiKey = headerValue(req.headers["x-api-key"]);
	if (apiKey) return apiKey;
	const googleKey = headerValue(req.headers["x-goog-api-key"]);
	if (googleKey) return googleKey;
	const queryKey = url.searchParams.get("key");
	if (queryKey) return queryKey;
	return null;
}

function headerValue(value) {
	if (value == null) return null;
	return Array.isArray(value) ? value[0] : value;
}

function timingSafeEqualKey(presented, expected) {
	const left = Buffer.from(String(presented));
	const right = Buffer.from(String(expected));
	if (left.length !== right.length) {
		if (left.length > 0) timingSafeEqual(left, left);
		return false;
	}
	return timingSafeEqual(left, right);
}

async function readJsonBody(req, maxBodyBytes) {
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > maxBodyBytes) {
		throwHttp(413, "invalid_request_error", "Request body too large");
	}

	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > maxBodyBytes) {
			req.pause();
			throwHttp(413, "invalid_request_error", "Request body too large");
		}
		chunks.push(chunk);
	}

	if (size === 0) {
		throwHttp(400, "invalid_request_error", "Request body is required");
	}

	let parsed;
	try {
		parsed = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
	} catch {
		throwHttp(400, "invalid_request_error", "Invalid JSON");
	}
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throwHttp(400, "invalid_request_error", "JSON body must be an object");
	}
	return parsed;
}

function protocolFor(pathname) {
	if (pathname === "/v1/chat/completions") return "openai";
	if (pathname.startsWith("/v1beta/")) return "gemini";
	return "anthropic";
}

function cloneModel(entry) {
	if (entry && typeof entry === "object") return { ...entry };
	return { id: String(entry) };
}

function throwMethod(protocol, allow) {
	const error = httpError(405, "invalid_request_error", "Method not allowed");
	error.allow = allow;
	error.protocol = protocol;
	throw error;
}

function throwHttp(status, type, message) {
	throw httpError(status, type, message);
}

function httpError(status, type, message) {
	const error = new ProtocolError(message, { status, type });
	error.status = status;
	error.type = type;
	return error;
}

function errorStatus(error) {
	const status = Number(error?.status);
	if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
	return 500;
}

function safeFormatError(protocol, error) {
	try {
		const body = formatError(protocol, error);
		if (body && typeof body === "object") return body;
	} catch {
		// fall through
	}
	return fallbackError(protocol, error);
}

function fallbackError(protocol, error) {
	const message = publicMessage(error);
	const type =
		error?.type ||
		(errorStatus(error) === 401 ? "authentication_error" : "api_error");
	if (protocol === "openai") {
		return { error: { message, type, code: type } };
	}
	if (protocol === "gemini") {
		return {
			error: {
				code: errorStatus(error),
				message,
				status: type,
			},
		};
	}
	return {
		type: "error",
		error: { type, message },
	};
}

function publicMessage(error) {
	if (!error) return "internal error";
	const message = String(error.message || "internal error");
	if (message.includes("\n")) return message.split("\n")[0];
	return message;
}
