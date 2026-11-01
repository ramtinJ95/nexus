import { once } from "node:events";
import { chmod, rm } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { controlSocket } from "./client.ts";
import { type Action, actionSchema, bootSchema } from "./contracts.ts";
import { lifecycleQueue, NotRunning, readIntent, runsBesideQueue, SandboxRuntime } from "./runtime.ts";
import { publishIdentity, readIdentity } from "./identity.ts";
import { controllerLogLimit, rotateLog } from "./log-rotation.ts";
import { agentError, readRecord } from "./storage.ts";
import { parse } from "../parse.ts";
import { BodyTooLarge, readBody } from "../request-body.ts";

async function main(): Promise<void> {
	const dir = process.argv[2];
	if (!dir) throw new Error("Instance directory required");
	const record = await readRecord(dir);
	const pidFile = join(dir, "controller.pid");
	await publishIdentity(pidFile);
	const log = join(dir, "controller.log");
	setInterval(() => void rotateLog(log, controllerLogLimit).catch((error: unknown) => console.error(error)), 60_000).unref();
	// The launching client writes the boot spec, secrets included, to stdin and closes it.
	const spec = bootSchema.parse(JSON.parse(await text(process.stdin)));
	const runtime = new SandboxRuntime(dir, record, spec);
	let prepare = false;
	try {
		const intent = await readIntent(dir);
		prepare = intent.prepare;
		await runtime.boot(intent.prepare);
	} catch (error) {
		await runtime.fail(error);
		await rm(pidFile, { force: true });
		process.exitCode = 1;
		return;
	}
	if (prepare) {
		await rm(pidFile, { force: true });
		return;
	}
	const queue = lifecycleQueue();
	const socket = controlSocket(dir);
	const closeServer = async () => {
		server.close();
		await rm(socket, { force: true });
	};
	const refuse = (res: http.ServerResponse, error: unknown) => {
		const failure = agentError(error);
		res.end(
			JSON.stringify({
				ok: false,
				error:
					failure instanceof Error
						? failure.message
						: "Sandbox operation failed. Inspect its state and logs before retrying",
			}),
		);
	};
	const handle = async (action: Action, res: http.ServerResponse) => {
		try {
			if (!("name" in action) || action.name !== record.name)
				throw new Error("Sandbox name does not match this instance");
			const result = await runtime.handle(action);
			res.end(JSON.stringify({ ok: true, result }));
			if (action.action === "stop" || action.action === "destroy") await closeServer();
		} catch (error) {
			if (error instanceof NotRunning) console.error(`deferred: ${error.message}`);
			else console.error(error);
			if (runtime.retired) {
				await closeServer();
				await rm(pidFile, { force: true });
			}
			refuse(res, error);
		}
	};
	const server = http.createServer(async (req, res) => {
		let action: Action;
		try {
			action = parse(actionSchema, JSON.parse(await readBody(req, 8 << 20)), "action");
		} catch (error) {
			if (!(error instanceof BodyTooLarge)) console.error(error);
			return refuse(res, error);
		}
		if (runsBesideQueue(action.action)) void handle(action, res);
		else void queue.run(() => handle(action, res));
	});
	server.listen(socket);
	await once(server, "listening");
	// A failed accept leaves the server listening, and the VM lives in this process, so an exit would only break the pylon.
	server.on("error", (error) => console.error(error));
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
		void queue
			.run(async () => {
				await runtime.stop();
				await closeServer();
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
