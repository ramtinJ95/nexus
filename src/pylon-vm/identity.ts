import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { existsError, saveJson } from "./storage.ts";

const execFileAsync = promisify(execFile);

/**
 * A process as the host knows it: its PID, when it started, and which boot of the host it runs in. A PID
 * alone outlives its process, because the kernel hands it out again, and the start time alone repeats
 * across host boots.
 */
export const identitySchema = z.strictObject({
	pid: z.number().int().positive(),
	start: z.string().min(1),
	boot: z.string().min(1),
});
export type ProcessIdentity = z.infer<typeof identitySchema>;

/** Null when no process has this PID. */
export async function identityOf(pid: number): Promise<ProcessIdentity | null> {
	if (process.platform === "linux") {
		let stat: string;
		try {
			stat = await readFile(`/proc/${pid}/stat`, "utf8");
		} catch (error) {
			if (existsError(error, "ENOENT")) return null;
			throw error;
		}
		// The command name in parentheses may hold spaces, so fields count from its closing parenthesis. The
		// start time, in clock ticks since boot, is field 22, the 20th after it.
		const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		if (start === undefined) throw new Error(`/proc/${pid}/stat has no start time`);
		const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		return { pid, start, boot };
	}
	if (process.platform === "darwin") {
		// For the tests on a Mac. ps prints the start time in the caller's time zone and locale, which the
		// controller and its clients need not share, and exits 1 when no process has the PID.
		let start: string;
		try {
			const env = { ...process.env, TZ: "UTC", LC_ALL: "C" };
			start = (await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { env })).stdout.trim();
		} catch (error) {
			if ((error as { code?: unknown }).code === 1) return null;
			throw error;
		}
		// `{ sec = 1729000000, usec = 123 } <local date>`: the numbers alone are the same in every time zone.
		const boottime = (await execFileAsync("sysctl", ["-n", "kern.boottime"])).stdout;
		const boot = /\{ sec = (\d+), usec = (\d+) \}/.exec(boottime)?.slice(1).join(".");
		if (boot === undefined) throw new Error(`sysctl kern.boottime printed ${JSON.stringify(boottime)}`);
		return { pid, start, boot };
	}
	throw new Error(`Sandbox controllers run on Linux and macOS, not ${process.platform}`);
}

/** Renamed in whole, because clients read it while its process starts. */
export async function publishIdentity(file: string): Promise<void> {
	const identity = await identityOf(process.pid);
	if (identity === null) throw new Error(`This process ${process.pid} has no identity`);
	await saveJson(file, identity);
}

/** Null when the file is missing. A file that does not hold an identity is an error, never a dead process. */
export async function readIdentity(file: string): Promise<ProcessIdentity | null> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		if (existsError(error, "ENOENT")) return null;
		throw error;
	}
	try {
		return identitySchema.parse(JSON.parse(raw));
	} catch {
		throw new Error(
			`Sandbox process identity in ${file} is invalid. Inspect controller logs before retrying`,
		);
	}
}

/** A PID the kernel has handed to another process, or one from an earlier boot of the host, is dead. */
export async function alive(identity: ProcessIdentity): Promise<boolean> {
	const now = await identityOf(identity.pid);
	return now !== null && now.start === identity.start && now.boot === identity.boot;
}
