#!/usr/bin/env node
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	decryptKernel,
	parseKernelKey,
	sha256,
} from "./crag-kernel-crypto.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR =
	path.basename(HERE) === "runtime" ? path.resolve(HERE, "..") : HERE;

function parseArgs(argv) {
	const options = {
		payload: path.join(PACKAGE_DIR, "crag-kernel.bin.enc"),
		manifest: path.join(PACKAGE_DIR, "crag-kernel.manifest.json"),
		execDir: process.env.CRAG_KERNEL_EXEC_DIR || "/run/crag",
		kernelArgs: [],
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--payload") options.payload = argv[++i];
		else if (arg === "--manifest") options.manifest = argv[++i];
		else if (arg === "--exec-dir") options.execDir = argv[++i];
		else if (arg === "--") options.kernelArgs.push(...argv.slice(i + 1));
		else options.kernelArgs.push(arg);
	}
	return options;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
	if (manifest.encrypted !== true || manifest.algorithm !== "aes-256-gcm") {
		throw new Error("kernel manifest is not an encrypted AES-256-GCM payload");
	}
	const keyValue =
		process.env.CRAG_KERNEL_KEY ||
		(process.env.CRAG_KERNEL_KEY_FILE
			? await readFile(process.env.CRAG_KERNEL_KEY_FILE, "utf8")
			: "");
	const key = parseKernelKey(keyValue);
	const plaintext = decryptKernel(await readFile(options.payload), key);
	if (
		manifest.plaintext_sha256 &&
		sha256(plaintext) !== manifest.plaintext_sha256
	) {
		throw new Error("decrypted kernel digest does not match manifest");
	}
	await mkdir(options.execDir, { recursive: true, mode: 0o700 });
	const executable = path.join(
		options.execDir,
		`.crag-kernel-${process.pid}-${randomUUID()}`,
	);
	await writeFile(executable, plaintext, { mode: 0o700 });
	await chmod(executable, 0o700);
	const env = { ...process.env };
	delete env.CRAG_KERNEL_KEY;
	delete env.CRAG_KERNEL_KEY_FILE;
	const child = spawn(executable, options.kernelArgs, {
		stdio: "inherit",
		env,
	});
	const forward = (signal) => {
		if (!child.killed) child.kill(signal);
	};
	process.on("SIGINT", () => forward("SIGINT"));
	process.on("SIGTERM", () => forward("SIGTERM"));
	const result = await new Promise((resolve) => {
		child.once("error", (error) => resolve({ code: 127, error }));
		child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
	});
	await rm(executable, { force: true });
	if (result.error) throw result.error;
	if (result.signal) process.kill(process.pid, result.signal);
	process.exitCode = result.code;
}

main().catch((error) => {
	console.error(`crag-kernel-loader: ${error.message}`);
	process.exitCode = 1;
});
