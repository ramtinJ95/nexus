/**
 * Test double for a Gondolin 0.13 VM whose guest commands start and never finish, with file writes that hold where
 * a test says. guest.ts runs every command through a watchdog that reports its outcome on stderr, so
 * `test -e <path>/done` exits 1 and every other command exits 0.
 *
 * Its file writes end as Gondolin's do (sandbox/server-ops.js, writeGuestFile). One `queued` for its turn, or
 * `sending` its data, ends when its signal aborts, the latter once its cleanup EOF goes out. One `blocked`, sending
 * into a full bridge, also waits for the bridge to take that EOF, and one `answering`, which sent all its data and
 * awaits the guest's answer, no longer heeds its signal: only `answer` or the VM's close ends either. A write that
 * holds Gondolin's one file slot, any but `queued`, holds every command back until it ends. A close fails the
 * writes holding the slot but not the queued ones, which then wait for good, as Gondolin's late registration does.
 */
import { writeFile } from "node:fs/promises";
import type { VM } from "@earendil-works/gondolin";

export type WritePhase = "queued" | "sending" | "blocked" | "answering";

export interface FakeVm {
	readonly vm: VM;
	/** Resolves once a write to a path ending in `suffix` holds. */
	holding(suffix: string): Promise<void>;
	/** The guest answers every write that holds, and the bridge drains. */
	answer(): void;
	readonly checkpoints: string[];
	/** What closed, in order: "ssh" for the guest terminal's SSH, "vm" for the VM. */
	readonly closed: string[];
}

/** `hold` says where a write to `path` holds, or undefined for one that ends at once. */
export function fakeVm(hold: (path: string) => WritePhase | undefined = () => undefined): FakeVm {
	type Write = { path: string; phase: WritePhase; end(error?: Error): void };
	const held: Write[] = [];
	const waiters: { suffix: string; accept(): void }[] = [];
	const slotWaiters = new Set<() => void>();
	const checkpoints: string[] = [];
	const closed: string[] = [];
	const release = (write: Write, error?: Error) => {
		if (!held.includes(write)) return;
		held.splice(held.indexOf(write), 1);
		write.end(error);
		for (const wake of slotWaiters) wake();
	};
	const slotFree = () => !held.some((w) => w.phase !== "queued");
	const close = () => {
		closed.push("vm");
		for (const write of [...held]) if (write.phase !== "queued") release(write, new Error("sandbox closed"));
	};
	const vm = {
		async exec(argv: string[], options?: { signal?: AbortSignal }) {
			while (!slotFree()) {
				options?.signal?.throwIfAborted();
				let wake!: () => void;
				await new Promise<void>((accept) => {
					wake = accept;
					slotWaiters.add(wake);
					options?.signal?.addEventListener("abort", wake, { once: true });
				});
				slotWaiters.delete(wake);
			}
			const exitCode = /\/done'?$/.test(argv[3]!) ? 1 : 0;
			return { exitCode: 0, stdout: "", stderr: JSON.stringify({ state: "exited", exitCode }) };
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
			async readFile() {
				return "42";
			},
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
		},
		checkpoints,
		closed,
	};
}
