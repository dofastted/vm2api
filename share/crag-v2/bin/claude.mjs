#!/usr/bin/env node
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const entry = new URL("../dist/claude/cli.js", import.meta.url);
try {
	await access(entry);
} catch {
	process.stderr.write(
		"Claude Code distribution is missing. Run npm run build first.\n",
	);
	process.exit(1);
}
process.argv[1] = fileURLToPath(entry);
await import(entry.href);
