/**
 * The Guest of one pylon-vm instance, for the probe. Every call goes through the instance's controller
 * except previewOrigin, which the preview gateway asks synchronously on every request, so it reads the
 * status file the controller rewrites after each services change.
 */
import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Guest } from "../backend.ts";
import { processStream } from "../process-stream.ts";
import type { PylonId } from "../protocol.ts";
import type { PylonLog } from "../session-wake.ts";
import { statusSchema } from "./contracts.ts";
import { existsError, shellQuote as q } from "./storage.ts";

/** A login shell as `user`, in `cwd`. The fork runs guest commands as root. */
export const asUser = (script: string, cwd: string) => `runuser -l user -c ${q(`cd ${q(cwd)} && ${script}`)}`;

/** The instance's controller log, which `logs` without a service reads. The controller appends to it too. */
export const controllerLog = (dir: string): PylonLog => (line) => appendFile(join(dir, "controller.log"), `${line}\n`, { mode: 0o600 });

/**
 * sshd hands the remote command to the user's shell as one string, so each argument is quoted to reach the
 * guest process unchanged.
 */
export const remoteCommand = (argv: readonly string[]) => argv.map(q).join(" ");

const execReplySchema = z.object({
	pid: z.string(),
	running: z.boolean(),
	output: z.string(),
	exitCode: z.number().int().optional(),
	truncated: z.boolean().optional(),
});
/** The controller's answer to the `shell` action: the guest's sshd on a loopback port, and the key it lets in. */
export const shellReplySchema = z.object({ access: z.strictObject({ user: z.string(), port: z.number().int(), identityFile: z.string() }) });

/**
 * ssh's arguments for the guest's sshd up to its remote command. Without a terminal, -T. With one, -t, and escapes
 * off, so the person at it cannot reach ssh's command line, which could forward ports as the probe's user.
 */
export function guestSsh({ access }: z.infer<typeof shellReplySchema>, terminal: boolean): string[] {
	return [
		"-F", "none", ...terminal ? ["-t", "-e", "none"] : ["-T"], "-p", String(access.port), "-i", access.identityFile,
		"-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
		"-o", "LogLevel=ERROR", "-o", "ConnectTimeout=15", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
		`${access.user}@127.0.0.1`,
	];
}
const factsSchema = z.array(z.strictObject({
	name: z.string(),
	state: z.enum(["starting", "ready", "failed", "stopped"]),
	port: z.number().int(),
	declared: z.boolean(),
	wantsPreview: z.boolean(),
}));
const logsReplySchema = z.object({ output: z.string() });
const linkReplySchema = z.object({ service: z.string() });
const unlinkReplySchema = z.object({ refused: z.string().nullable() });
const loopback = /^http:\/\/127\.0\.0\.1:\d+$/;
/**
 * How long ensure, restart and service-start wait for the services they started: the longest `timeoutMs` a
 * service may declare (contracts.ts), and a margin for its last health check. The controller fails each start
 * that outlasts its own timeout, so a service still starting after this went unhealthy after it was ready.
 */
const readyWaitMs = 130_000;
const readyPollMs = 250;

/** `run` sends an action to the instance's controller, and `dir` is the instance directory. */
export function pylonGuest(pylonId: PylonId, dir: string, run: (action: Record<string, unknown>) => Promise<unknown>): Guest {
	const name = pylonId;
	/**
	 * The controller only launches a service and watches its readiness itself, so that no health wait holds its
	 * lifecycle queue. A caller of ensure, restart or service-start still gets each service ready or failed, from
	 * status reads that queue between other actions.
	 */
	async function ready(facts: z.infer<typeof factsSchema>, service: string | undefined) {
		const deadline = Date.now() + readyWaitMs;
		while (facts.some((fact) => fact.state === "starting") && Date.now() < deadline) {
			await delay(readyPollMs);
			facts = factsSchema.parse(await run({ action: "services", name, op: "status", ...(service === undefined ? {} : { service }) }));
		}
		return facts;
	}
	return {
		async exec(argv, { cwd, timeoutMs }) {
			const deadline = Date.now() + timeoutMs;
			// The fork waits at most 60 s per call, and a wait never kills the command.
			const wait = () => Math.max(0, Math.min(60_000, deadline - Date.now()));
			const cmd = asUser(argv.map(q).join(" "), cwd);
			let reply = execReplySchema.parse(await run({ action: "exec", name, cmd, cwd: "/", timeoutMs: wait() }));
			let output = reply.output;
			while (reply.running) {
				if (Date.now() >= deadline) {
					await run({ action: "exec-kill", name, pid: reply.pid });
					return { exitCode: null, output, truncated: reply.truncated ?? false };
				}
				reply = execReplySchema.parse(await run({ action: "exec-status", name, pid: reply.pid, timeoutMs: wait() }));
				output += reply.output;
			}
			if (reply.exitCode === undefined) throw new Error(`exec in ${pylonId} finished without an exit code`);
			return { exitCode: reply.exitCode, output, truncated: reply.truncated ?? false };
		},

		/**
		 * Over SSH to the guest's sshd, the route S13 measured for the pi-env daemon. The controller's `shell`
		 * action enables it for `user` once per boot and hands out the loopback port and key. With -T, the
		 * remote stderr arrives on ssh's own stderr, so only the process's stdout is the stream. ssh's own
		 * failures also exit 255, which the stream reports as that exit code. A pause closes the forwarder,
		 * which ends every stream.
		 */
		async stream(request, log) {
			// OpenSSH sends a window change only when its own terminal resizes, and the probe has no terminal.
			if (request.pty !== null) throw new Error(`${pylonId}: pylon VM streams carry raw pipes only, because nothing could resize a pty`);
			const shell = shellReplySchema.parse(await run({ action: "shell", name, user: "user" }));
			return processStream("ssh", [...guestSsh(shell, false), "--", remoteCommand(request.argv)], log);
		},

		async writeFiles(files) {
			await run({ action: "write-files", name, files });
		},

		async services(op, service, lines) {
			if (op !== "logs") {
				const forkOp = op === "list" ? "status" : op;
				const facts = factsSchema.parse(await run({ action: "services", name, op: forkOp, ...(service === undefined ? {} : { service }) }));
				return { services: op === "ensure" || op === "restart" ? await ready(facts, service) : facts };
			}
			if (service === undefined) throw new Error("service logs needs the service's name");
			const { output } = logsReplySchema.parse(await run({ action: "logs", name, service, ...(lines === undefined ? {} : { lines }) }));
			return { services: factsSchema.parse(await run({ action: "services", name, op: "status", service })), logs: output };
		},

		async startService(service, decl) {
			return ready(factsSchema.parse(await run({ action: "service-start", name, service, ...decl })), service);
		},

		async linkPort(port, title) {
			return linkReplySchema.parse(await run({ action: "preview", name, port, ...(title === undefined ? {} : { title }) })).service;
		},

		async unlinkPort(port) {
			return unlinkReplySchema.parse(await run({ action: "unpreview", name, port })).refused;
		},

		previewOrigin(service) {
			let text: string;
			try {
				text = readFileSync(join(dir, "status.json"), "utf8");
			} catch (err) {
				if (existsError(err, "ENOENT")) throw new Error(`${pylonId} is not on this node`);
				throw err;
			}
			const status = statusSchema.parse(JSON.parse(text));
			if (status.state !== "running") throw new Error(`${pylonId} is ${status.state}`);
			const origin = status.previews?.[service];
			if (origin === undefined) throw new Error(`${pylonId} has no preview of ${service}`);
			if (!loopback.test(origin)) throw new Error(`${pylonId} reports ${origin} as the preview origin of ${service}, which is not a loopback port`);
			return origin as `http://127.0.0.1:${number}`;
		},
	};
}
