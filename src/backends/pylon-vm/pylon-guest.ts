/**
 * The Guest of one pylon-vm instance, for the probe. Every call goes through the instance's controller
 * except previewOrigin, which the preview gateway asks synchronously on every request, so it reads the
 * status file the controller rewrites after each services change, and parses it again only once it changed.
 */
import { readFileSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { z } from "zod";
import type { Guest, PreviewOrigin } from "../backend.ts";
import { processStream } from "../../process-stream.ts";
import type { PylonId } from "../../ids.ts";
import { logTailBounds } from "../../protocol/observations.ts";
import type { PylonLog } from "../../probe/guest/session-wake.ts";
import { type ActionInput, type Reply, statusSchema } from "../../pylon-vm/contracts.ts";
import { settled } from "../../pylon-vm/services.ts";
import { stamped } from "../../pylon-vm/controller-log.ts";
import { shellQuote as q } from "../../shell.ts";
import { existsError, readLogTail } from "../../pylon-vm/storage.ts";
import { instanceFiles } from "../../pylon-vm/instance-layout.ts";
import { asUser } from "../../guest-contract.ts";

/** A login shell as `user`, in `cwd`, as one command string. The fork runs guest commands as root. */
export const asUserIn = (script: string, cwd: string) => asUser(`cd ${q(cwd)} && ${script}`).map(q).join(" ");

/** The instance's controller log, which `logs` without a service reads. The controller appends to it too. */
export const controllerLog = (dir: string): PylonLog => (line) => appendFile(instanceFiles(dir).log, `${stamped(line)}\n`, { mode: 0o600 });

/** The end of a build's or an instance's controller log, for a JobFailure's or a broken pylon's logTail. */
export async function controllerLogTail(dir: string): Promise<string> {
  return (await readLogTail(instanceFiles(dir).log, logTailBounds.lines)).output.slice(-logTailBounds.chars);
}

/** gondolin build writes gondolin.json's env here, for login shells. sandboxd's execs get the same env directly. */
export const imageEnv = "/etc/profile.d/gondolin-image-env.sh";

/**
 * sshd hands the remote command to the user's shell as one string, so each argument is quoted to reach the
 * guest process unchanged. That shell is no login shell, so it reads the image's env first, as sandboxd's execs have
 * it: without NODE_EXTRA_CA_CERTS, npm in a stream, as in the review loop's check, refuses Gondolin's TLS proxy. The
 * process then replaces the shell, so the stream's exit status is its own.
 */
export const remoteCommand = (argv: readonly string[]) => `[ ! -r ${imageEnv} ] || . ${imageEnv}; exec ${argv.map(q).join(" ")}`;

/** `run` in the fork's client.ts, for one state root. */
export type Sandbox = <I extends ActionInput>(action: I, signal?: AbortSignal) => Promise<Reply<I["action"]>>;

/** ssh's arguments for the guest's sshd up to its remote command, without a terminal. */
export function guestSsh({ access }: Reply<"shell">): string[] {
	return [
		"-F", "none", "-T", "-p", String(access.port), "-i", access.identityFile,
		"-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
		"-o", "LogLevel=ERROR", "-o", "ConnectTimeout=15", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
		`${access.user}@127.0.0.1`,
	];
}
const loopback = /^http:\/\/127\.0\.0\.1:\d+$/;

/**
 * Each instance's status.json as previewOrigin last parsed it, under its inode, size and mtime. The controller replaces
 * the file by rename, so every write gets a new inode, even two within one mtime tick.
 */
export type StatusCache = Map<PylonId, { stamp: string; state: z.infer<typeof statusSchema>["state"]; previews: Record<string, string> }>;

/**
 * Each instance's `shell` action while it is in flight. The controller cannot cancel an action, so a stream that starts
 * while one waits shares it rather than queueing another behind it on a pylon that is already slow.
 */
export type ShellFlights = Map<PylonId, Promise<Reply<"shell">>>;

/** `dir` is the instance directory. */
export function pylonGuest(pylonId: PylonId, dir: string, run: Sandbox, statuses: StatusCache, shells: ShellFlights = new Map()): Guest {
	const name = pylonId;
	const ready = (facts: Reply<"services">) => settled(facts, () => run({ action: "services", name, op: "status" }));
	return {
		async exec(argv, { cwd, timeoutMs }) {
			const deadline = Date.now() + timeoutMs;
			// The fork waits at most 60 s per call, and a wait never kills the command.
			const wait = () => Math.max(0, Math.min(60_000, deadline - Date.now()));
			const cmd = asUserIn(argv.map(q).join(" "), cwd);
			let reply = await run({ action: "exec", name, cmd, cwd: "/", timeoutMs: wait() });
			let output = reply.output;
			while (reply.running) {
				if (Date.now() >= deadline) {
					await run({ action: "exec-kill", name, pid: reply.pid });
					return { exitCode: null, output, truncated: reply.truncated ?? false };
				}
				reply = await run({ action: "exec-status", name, pid: reply.pid, timeoutMs: wait() });
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
		async stream(argv, log, signal) {
			signal?.throwIfAborted();
			let asking = shells.get(pylonId);
			if (asking === undefined) {
				const flight = run({ action: "shell", name, user: "user" }).finally(() => {
					if (shells.get(pylonId) === flight) shells.delete(pylonId);
				});
				// Every caller may have given up by the time it settles.
				flight.catch(() => undefined);
				shells.set(pylonId, asking = flight);
			}
			let leave = () => {};
			const left = new Promise<never>((_, reject) => { leave = () => reject(signal!.reason); });
			signal?.addEventListener("abort", leave, { once: true });
			let shell: Reply<"shell">;
			try {
				shell = await Promise.race([asking, left]);
			} finally {
				signal?.removeEventListener("abort", leave);
			}
			return processStream("ssh", [...guestSsh(shell), "--", remoteCommand(argv)], log);
		},

		async writeFiles(files) {
			await run({ action: "write-files", name, files });
		},

		async services(op, service, lines) {
			if (op !== "logs") {
				const forkOp = op === "list" ? "status" : op;
				const facts = await run({ action: "services", name, op: forkOp, ...(service === undefined ? {} : { service }) });
				return { services: op === "ensure" || op === "restart" ? await ready(facts) : facts };
			}
			if (service === undefined) throw new Error("service logs needs the service's name");
			const { output } = await run({ action: "logs", name, service, ...(lines === undefined ? {} : { lines }) });
			return { services: await run({ action: "services", name, op: "status", service }), logs: output };
		},

		async startService(service, decl) {
			return ready(await run({ action: "service-start", name, service, ...decl }));
		},

		async linkPort(port, title) {
			return (await run({ action: "preview", name, port, ...(title === undefined ? {} : { title }) })).service;
		},

		async unlinkPort(port) {
			return (await run({ action: "unpreview", name, port })).refused;
		},

		previewOrigin(service) {
			const path = instanceFiles(dir).status;
			let status = statuses.get(pylonId);
			try {
				const { ino, size, mtimeNs } = statSync(path, { bigint: true });
				const stamp = `${ino}:${size}:${mtimeNs}`;
				if (status?.stamp !== stamp) {
					const { state, previews = {} } = statusSchema.parse(JSON.parse(readFileSync(path, "utf8")));
					statuses.set(pylonId, status = { stamp, state, previews });
				}
			} catch (err) {
				if (!existsError(err, "ENOENT")) throw err;
				statuses.delete(pylonId);
				return { unavailable: `${pylonId} is not on this node` };
			}
			if (status.state !== "running") return { unavailable: `${pylonId} is ${status.state}` };
			const origin = status.previews[service];
			if (origin === undefined) return { unavailable: `${pylonId} has no preview of ${service}` };
			if (!loopback.test(origin)) throw new Error(`${pylonId} reports ${origin} as the preview origin of ${service}, which is not a loopback port`);
			return origin as PreviewOrigin;
		},
	};
}
