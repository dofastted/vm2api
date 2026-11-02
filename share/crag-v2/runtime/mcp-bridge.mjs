import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";

const configPath = readOption(process.argv.slice(2), "--config");
if (!configPath) fail("--config is required");
const config = JSON.parse(await readFile(configPath, "utf8"));
const bridge = config.crag;
if (!bridge || typeof bridge.callbackUrl !== "string")
	fail("invalid CRAG MCP config");
const tools = Array.isArray(bridge.tools) ? bridge.tools : [];
const input = createInterface({ input: process.stdin });

for await (const line of input) {
	if (!line.trim()) continue;
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		continue;
	}
	if (!request || request.jsonrpc !== "2.0") continue;
	try {
		const response = await dispatch(request);
		if (response !== null)
			process.stdout.write(`${JSON.stringify(response)}\n`);
	} catch (error) {
		if (request.id !== undefined) {
			process.stdout.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: -32603, message: String(error?.message || error) },
				})}\n`,
			);
		}
	}
}

async function dispatch(request) {
	const method = request.method;
	if (
		method === "notifications/initialized" ||
		method === "notifications/cancelled"
	)
		return null;
	if (method === "initialize") {
		return {
			jsonrpc: "2.0",
			id: request.id,
			result: {
				protocolVersion: request.params?.protocolVersion || "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "crag-v2", version: "2.1.88-v2" },
			},
		};
	}
	if (method === "tools/list") {
		return { jsonrpc: "2.0", id: request.id, result: { tools } };
	}
	if (method === "tools/call") {
		const name = String(request.params?.name || "");
		const definition = tools.find((tool) => tool.name === name);
		if (!definition) throw new Error(`unknown tool: ${name}`);
		const response = await fetch(bridge.callbackUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name,
				arguments: isObject(request.params?.arguments)
					? request.params.arguments
					: {},
			}),
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok)
			throw new Error(
				payload?.error?.message || `callback HTTP ${response.status}`,
			);
		return {
			jsonrpc: "2.0",
			id: request.id,
			result: {
				content: Array.isArray(payload.content)
					? payload.content
					: [{ type: "text", text: String(payload.content || "") }],
				isError: payload.isError === true,
			},
		};
	}
	if (method === "ping") return { jsonrpc: "2.0", id: request.id, result: {} };
	return {
		jsonrpc: "2.0",
		id: request.id,
		error: { code: -32601, message: `method not found: ${method}` },
	};
}

function readOption(argv, name) {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

function isObject(value) {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
	process.stderr.write(`crag-v2-mcp: ${message}\n`);
	process.exit(1);
}
