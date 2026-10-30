/**
 * Test double for a Gondolin 0.13 VM whose guest commands start and never finish, with file writes that hold where
 * a test says. guest.ts runs a shell command through a watchdog that reports its outcome on stderr, and a short one
 * directly, and every command exits 0 unless `fails` says. A command's files read as a launched process's that runs
 * on: its `pid` reads 42, and its `done`, `output` and `truncated` are missing, as sandboxd reports a missing file.
 *
 * Its file writes end as Gondolin's do (sandbox/server-ops.js, writeGuestFile). One `queued` for its turn, or
 * `sending` its data, ends when its signal aborts, the latter once its cleanup EOF goes out. One `blocked`, sending
 * into a full bridge, also waits for the bridge to take that EOF, and one `answering`, which sent all its data and
 * awaits the guest's answer, no longer heeds its signal: only `answer` or the VM's close ends either. A write that
 * holds Gondolin's one file slot, any but `queued`, holds every command back until it ends. A close fails the
 * writes holding the slot but not the queued ones, which then wait for good, as Gondolin's late registration does.
 *
 * Its commands are admitted as Gondolin's are (sandbox/server-ops.js, handleExec): at most 64 at once, each counted
 * from its request until the guest answers it, also while it waits behind a file write. One that `hangs` is answered only by `answer`, or failed by the VM's close. An abort ends
 * the host's wait and nothing else (exec.js, rejectExecSession), so the command keeps its slot.
 */
import { writeFile } from "node:fs/promises";
import type { VM } from "@earendil-works/gondolin";

export type WritePhase = "queued" | "sending" | "blocked" | "answering";

export interface FakeVm {
	readonly vm: VM;
	/** Resolves once a write to a path ending in `suffix` holds. */
	holding(suffix: string): Promise<void>;
	/** The guest answers every write that holds and every command that hangs, and the bridge drains. */
	answer(): void;
	readonly checkpoints: string[];
	/** The guest commands that ran, in order: a watchdog's shell command, or a direct one's argv joined by spaces. */
	readonly commands: string[];
	/** The guest files read, in order. */
	readonly reads: string[];
	/** What closed, in order: "ssh" for the guest terminal's SSH, "vm" for the VM. */
	readonly closed: string[];
	/** The most commands outstanding at once, and the commands the guest refused as full. */
	readonly peak: number;
	readonly refused: string[];
}

/** `hold` says where a write to `path` holds, or undefined for one that ends at once, and `fails` which commands exit 1. */
/** The shell command a guest.ts watchdog runs, or undefined for a direct exec. */
export function watched(argv: readonly string[]): string | undefined {
	return argv[0] === "python3" && argv[1] === "-c" && argv[2]!.startsWith("import json,os,signal,subprocess,sys,time") ? argv[3] : undefined;
}
/** Gondolin's error for a read of a file the guest does not have (sandbox/server.js, sandboxd/main.zig). */
export const fileNotFound = (path: string) => new Error(`failed to read guest file '${path}': file_read_failed: FileNotFound`);

export function fakeVm(hold: (path: string) => WritePhase | undefined = () => undefined, fails: (cmd: string) => boolean = () => false, hangs: (cmd: string) => boolean = () => false): FakeVm {
	type Write = { path: string; phase: WritePhase; end(error?: Error): void };
	const held: Write[] = [];
	const waiters: { suffix: string; accept(): void }[] = [];
	const slotWaiters = new Set<() => void>();
	const checkpoints: string[] = [];
	const commands: string[] = [];
	const reads: string[] = [];
	const closed: string[] = [];
	const refused: string[] = [];
	const hanging = new Set<(error?: Error) => void>();
	let outstanding = 0;
	let peak = 0;
	const release = (write: Write, error?: Error) => {
		if (!held.includes(write)) return;
		held.splice(held.indexOf(write), 1);
		write.end(error);
		for (const wake of [...slotWaiters]) {
			slotWaiters.delete(wake);
			wake();
		}
	};
	const slotFree = () => !held.some((w) => w.phase !== "queued");
	const close = () => {
		closed.push("vm");
		for (const write of [...held]) if (write.phase !== "queued") release(write, new Error("sandbox closed"));
		for (const answer of hanging) answer(new Error("sandbox closed"));
	};
	const vm = {
		async exec(argv: string[], options?: { signal?: AbortSignal }) {
			const shell = watched(argv);
			const cmd = shell ?? argv.join(" ");
			if (outstanding >= 64) {
				refused.push(cmd);
				throw new Error("error queue_full: too many concurrent exec requests (limit 64)");
			}
			outstanding += 1;
			peak = Math.max(peak, outstanding);
			const run = (async () => {
				while (!slotFree()) await new Promise<void>((wake) => slotWaiters.add(wake));
				commands.push(cmd);
				if (hangs(cmd))
					await new Promise<void>((accept, reject) => {
						const answer = (error?: Error) => {
							hanging.delete(answer);
							if (error) reject(error);
							else accept();
						};
						hanging.add(answer);
					});
				const exitCode = fails(cmd) ? 1 : 0;
				if (shell === undefined) return { exitCode, stdout: "", stderr: "" };
				return { exitCode: 0, stdout: "", stderr: JSON.stringify({ state: "exited", exitCode }) };
			})().finally(() => (outstanding -= 1));
			const signal = options?.signal;
			if (signal === undefined) return run;
			return Promise.race([run, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("exec aborted")), { once: true }))]);
		},
		fs: {
			async writeFile(path: string, _data: unknown, options?: { signal?: AbortSignal }) {
				const signal = options?.signal;
				if (signal?.aborted) throw new Error("operation aborted");
				const phase = hold(path);
				if (phase === undefined) return;
				await new Promise<void>((accept, reject) => {
					const write: Write = { path, phase, end: (error) => (error ? reject(error) : accept()) };
					held.push(write);
					if (phase === "queued" || phase === "sending")
						signal?.addEventListener("abort", () => release(write, new Error("operation aborted")), { once: true });
					for (const waiter of waiters.filter((w) => path.endsWith(w.suffix))) waiter.accept();
				});
			},
			async readFile(path: string) {
				reads.push(path);
				if (/\/(done|output|truncated)$/.test(path)) throw fileNotFound(path);
				return Buffer.from("42");
			},
			async deleteFile() {},
		},
		async enableSsh() {
			return { port: 1, identityFile: "/nonexistent/key", close: async () => void closed.push("ssh") };
		},
		async checkpoint(path: string) {
			await writeFile(path, "");
			checkpoints.push(path);
			close();
		},
		async close() {
			close();
		},
	} as unknown as VM;
	return {
		vm,
		holding: (suffix) =>
			held.some((w) => w.path.endsWith(suffix))
				? Promise.resolve()
				: new Promise<void>((accept) => waiters.push({ suffix, accept })),
		answer: () => {
			for (const write of [...held]) release(write);
			for (const answer of [...hanging]) answer();
		},
		checkpoints,
		commands,
		reads,
		closed,
		get peak() {
			return peak;
		},
		refused,
	};
}
