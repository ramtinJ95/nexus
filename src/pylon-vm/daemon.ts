import { once } from "node:events";
import { chmod, rm } from "node:fs/promises";
import http from "node:http";
import { text } from "node:stream/consumers";
import { instanceFiles, scratchDirectory, stateRootOf } from "./instance-layout.ts";
import { type Action, actions, actionSchema, bootSchema } from "./contracts.ts";
import { lifecycleQueue, NotRunning, readIntent, SandboxRuntime } from "./runtime.ts";
import { publishIdentity, readIdentity } from "./identity.ts";
import { controllerLogLimit, rotateLog } from "./log-rotation.ts";
import { stampLines } from "./controller-log.ts";
import { agentError, existsError, readRecord } from "./storage.ts";
import { parse } from "../parse.ts";
import { BodyTooLarge, readBody } from "../node-base/request-body.ts";

async function main(): Promise<void> {
	stampLines(process.stdout);
	stampLines(process.stderr);
	const dir = process.argv[2];
	if (!dir) throw new Error("Instance directory required");
	const record = await readRecord(dir);
	// The log is opened for appending, so it holds every controller this instance had, and this line tells them apart.
	console.error(`controller ${process.pid} started for ${record.name}`);
	const { pid: pidFile, log, socket } = instanceFiles(dir);
	await publishIdentity(pidFile);
	// The scratch directory goes first: once controller.pid is gone, a launch may make both again for its own controller,
	// so this runs once however many paths end the controller.
	let retiring: Promise<void> | undefined;
	const retire = () =>
		(retiring ??= (async () => {
			await rm(scratchDirectory(stateRootOf(dir), dir), { recursive: true, force: true });
			await rm(pidFile, { force: true });
		})());
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
		process.exitCode = 1;
		try {
			await runtime.fail(error);
		} finally {
			await retire();
		}
		return;
	}
	if (prepare) {
		await retire();
		return;
	}
	const queue = lifecycleQueue();
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
				await retire();
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
		if (actions[action.action].beside) void handle(action, res);
		else void queue.run(() => handle(action, res));
	});
	server.once("close", () => {
		void readIdentity(pidFile)
			.then(async (identity) => {
				if (identity?.pid === process.pid) await retire();
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
				try {
					await runtime.fail(error);
				} finally {
					server.close();
				}
			})
			.catch((error: unknown) => console.error(error));
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	server.listen(socket);
	await once(server, "listening");
	// A failed accept leaves the server listening, and the VM lives in this process, so an exit would only break the pylon.
	server.on("error", (error) => console.error(error));
	try {
		await chmod(socket, 0o600);
	} catch (error) {
		// Shutdown can remove the socket while startup is still setting its permissions.
		if (!ending || !existsError(error, "ENOENT")) throw error;
	}
}
await main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
