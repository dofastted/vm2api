#!/usr/bin/env node
import { parseOptions, HELP } from "../gateway/options.mjs";
import { startServer } from "../gateway/server.mjs";
import { V2_VERSION } from "../gateway/v2-runtime.mjs";
import { VERSION } from "../runtime/protocol303.mjs";

try {
	const options = parseOptions(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(`${HELP}\n`);
	} else if (options.version) {
		process.stdout.write(
			options.runtime === "v2"
				? `${V2_VERSION} (CRAG v2; original Claude Code bundle 2.1.88)\n`
				: `${VERSION} (Claude Code + CRAG; native base 2.1.88)\n`,
		);
	} else {
		const app = await startServer(options);
		const address = app.address;
		process.stderr.write(
			`CRAG ${VERSION} listening on ${typeof address === "string" ? address : `${address.address}:${address.port}`}\n`,
		);
		let closing = false;
		const close = async () => {
			if (closing) return;
			closing = true;
			try {
				await app.close();
			} catch (error) {
				process.stderr.write(`CRAG shutdown failed: ${error.message}\n`);
				process.exitCode = 1;
			}
		};
		process.once("SIGINT", close);
		process.once("SIGTERM", close);
	}
} catch (error) {
	process.stderr.write(`CRAG: ${error.message}\n`);
	process.exitCode = 1;
}
