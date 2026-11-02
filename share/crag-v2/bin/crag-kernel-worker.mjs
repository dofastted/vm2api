#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createV2Runtime } from "../gateway/v2-runtime.mjs";
import { startServer } from "../gateway/server.mjs";


function parseArgs(argv) {
  let configPath = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--gateway-worker") continue;
    if (arg === "--config") configPath = argv[++i] || "";
    else if (arg.startsWith("--config=")) configPath = arg.slice("--config=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!configPath) throw new Error("--config is required");
  return path.resolve(configPath);
}

async function loadConfig(configPath) {
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("kernel config must be an object");
  return raw;
}

async function firstExisting(paths) {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return paths[0];
}

function intOr(value, fallback, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function workerRuntime(options) {
  const runtime = createV2Runtime(options);
  return {
    run: runtime.run,
    close: runtime.close,
    health() {
      const health = runtime.health();
      const runnable = Number(health.runnable_capacity ?? health.capacity ?? 0);
      const used = Number(health.active || 0) + Number(health.waiting || 0);
      return {
        ...health,
        engine: "crag-v2",
        provider: "local_cli",
        worker_version: health.version,
        ready_slots: Math.max(0, runnable - used),
        closed_slots: 0,
        cli_pid: Number(health.pids?.[0] || 0),
        healthy: health.ok !== false,
        recovering: false,
        execution_mode: "v2_process_pool",
      };
    },
  };
}

async function main() {
  const configPath = parseArgs(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const packageRoot = path.resolve(
    String(
      config.crag_v2_root ||
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    ),
  );
  const defaultClaude = await firstExisting([
    path.join(packageRoot, "claude-code-2.1.88", "cli.js"),
    path.join(packageRoot, "dist", "claude", "cli.js"),
  ]);
  const cwd = path.resolve(String(config.work_dir || process.env.HOME || "/tmp"));
  const slots = intOr(config.slots_per_worker, 20, 1, 256);
  const nodePath = String(config.node_bin || process.execPath);
  const env = {
    ...process.env,
    HOME: process.env.HOME || cwd,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || cwd, ".claude"),
    CLAUDE_CODE_DISABLE_TELEMETRY: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    ...(config.proxy_url
      ? {
          HTTP_PROXY: String(config.proxy_url),
          HTTPS_PROXY: String(config.proxy_url),
          ALL_PROXY: String(config.proxy_url),
        }
      : {}),
    ...(config.timezone ? { TZ: String(config.timezone) } : {}),
  };
  const app = await startServer(
    {
      runtime: "v2",
      v2Transport: "print",
      socketPath: String(config.socket_path || "/run/kin/kernel.sock"),
      internalToken: String(config.internal_token || ""),
      maxBodyBytes: intOr(config.max_request_bytes, 32 * 1024 * 1024, 1, 256 * 1024 * 1024),
      maxProcs: slots,
      sessionSlots: slots,
      maxQueue: Math.max(0, slots * 2),
      requestTimeoutMs: intOr(config.request_timeout_seconds, 120, 1, 86_400) * 1000,
      toolTimeoutMs: intOr(config.tool_timeout_seconds, 300, 1, 86_400) * 1000,
      queueTimeoutMs: intOr(config.queue_timeout_seconds, 30, 1, 86_400) * 1000,
      cwd,
      bunPath: nodePath,
      claudePath: String(config.crag_claude_bin || defaultClaude),
      env,
      models: undefined,
    },
    workerRuntime,
  );

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  process.stderr.write(
    `CRAG v2 worker listening on ${String(config.socket_path || "/run/kin/kernel.sock")} slots=${slots}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`crag-kernel-worker: ${error.message}\n`);
  process.exitCode = 1;
});
