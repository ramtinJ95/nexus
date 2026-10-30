/**
 * Runs the real daemon.ts without a VM: `node --import ./fake-runtime.ts daemon.ts <dir>`. As a preload it points
 * daemon.ts's import of runtime.ts here, where SandboxRuntime boots, stops and inspects at once, a `services` action
 * never ends, so it holds the lifecycle queue for good, and every other export is runtime.ts's own. Each SIGUSR2 fails
 * one accept on the controller's server: Node's handler for its listening socket gets the error libuv passes it, and
 * the line `injected accept error <n>` goes to stderr after it.
 */
import { constants } from "node:os";
import http from "node:http";
import { registerHooks } from "node:module";
import type { Action, BootSpec, SandboxRecord } from "./contracts.ts";

export { lifecycleQueue, NotRunning, readIntent, runsBesideQueue } from "./runtime.ts";

export class SandboxRuntime {
	retired = false;
	private state = "starting";
	private readonly name: string;
	constructor(_dir: string, record: SandboxRecord, _spec: BootSpec) {
		this.name = record.name;
	}
	async boot(): Promise<void> {
		this.state = "running";
	}
	async fail(error: unknown): Promise<void> {
		console.error(error);
	}
	async handle(action: Action): Promise<unknown> {
		if (action.action === "services") return new Promise(() => {});
		if (action.action === "stop") this.state = "stopped";
		return { name: this.name, status: { name: this.name, state: this.state } };
	}
	beginShutdown(): void {}
	async stop(): Promise<void> {
		this.state = "stopped";
	}
}

registerHooks({
	resolve: (specifier, context, next) =>
		specifier === "./runtime.ts" && context.parentURL?.endsWith("/daemon.ts")
			? next(import.meta.url, context)
			: next(specifier, context),
});
let server: http.Server | undefined;
const createServer = http.createServer;
http.createServer = ((...args: Parameters<typeof createServer>) => (server = createServer(...args))) as typeof createServer;
let injected = 0;
process.on("SIGUSR2", () => {
	const handle = (server as unknown as { _handle: { onconnection(this: unknown, err: number): void } })._handle;
	handle.onconnection(-constants.errno.ENOBUFS);
	process.stderr.write(`injected accept error ${++injected}\n`);
});
