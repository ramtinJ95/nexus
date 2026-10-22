import { chmod, rm } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { actionSchema, bootSchema } from "./contracts.ts";
import { readIntent, SandboxRuntime } from "./runtime.ts";
import { publishIdentity, readIdentity } from "./identity.ts";
import { agentError, readRecord } from "./storage.ts";

async function main(): Promise<void> {
	const dir = process.argv[2];
	if (!dir) throw new Error("Instance directory required");
	const record = await readRecord(dir);
	const pidFile = join(dir, "controller.pid");
	await publishIdentity(pidFile);
	// The launching client writes the boot spec, secrets included, to stdin and closes it.
	const spec = bootSchema.parse(JSON.parse(await text(process.stdin)));
	const runtime = new SandboxRuntime(dir, record, spec);
	const intent = await readIntent(dir);
	try {
		await runtime.boot(intent.prepare, intent.fresh, intent.setupError);
	} catch (error) {
		await runtime.fail(error);
		await rm(pidFile, { force: true });
		process.exitCode = 1;
		return;
	}
	if (intent.prepare) {
		await rm(pidFile, { force: true });
		return;
	}
	let queue: Promise<unknown> = Promise.resolve();
	const socket = join(dir, "control.sock");
	const server = http.createServer((req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			body += chunk;
			if (body.length > 8388608) req.destroy();
		});
		req.on("end", () => {
			const handle = async () => {
				try {
					const action = actionSchema.parse(JSON.parse(body));
					if (!("name" in action) || action.name !== record.name)
						throw new Error("Sandbox name does not match this instance");
					const result = await runtime.handle(action);
					res.end(JSON.stringify({ ok: true, result }));
					if (action.action === "stop" || action.action === "destroy") {
						server.close();
						await rm(socket, { force: true });
					}
				} catch (error) {
					console.error(error);
					const failure = agentError(error);
					if (runtime.retired) {
						server.close();
						await rm(socket, { force: true });
						await rm(pidFile, { force: true });
					}
					res.end(
						JSON.stringify({
							ok: false,
							error:
								failure instanceof Error
									? failure.message
									: "Sandbox operation failed. Inspect its state and logs before retrying",
						}),
					);
				}
			};
			// Process waits and cancellation must not occupy the lifecycle queue.
			let inspect = false;
			try {
				inspect = [
					"inspect",
					"exec",
					"exec-status",
					"exec-kill",
					"read",
					"write-files",
					"logs",
				].includes(actionSchema.parse(JSON.parse(body)).action);
			} catch {}
			if (inspect) void handle();
			else queue = queue.catch(() => {}).then(handle);
		});
	});
	await new Promise<void>((accept, reject) => {
		server.once("error", reject);
		server.listen(socket, accept);
	});
	await chmod(socket, 0o600);
	server.once("close", () => {
		void readIdentity(pidFile)
			.then(async (identity) => {
				if (identity?.pid === process.pid) await rm(pidFile, { force: true });
			})
			.catch((error: unknown) => console.error(error));
	});
	let ending = false;
	const shutdown = () => {
		if (ending) return;
		ending = true;
		runtime.beginShutdown();
		queue = queue
			.catch(() => {})
			.then(async () => {
				await runtime.stop();
				server.close();
				await rm(socket, { force: true });
			})
			.catch(async (error: unknown) => {
				await runtime.fail(error);
				server.close();
			});
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
await main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
