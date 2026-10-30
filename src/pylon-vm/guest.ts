import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Writable } from "node:stream";
import type { VM } from "@earendil-works/gondolin";
import { commandOutcomeSchema, type GuestFile, type Service } from "./contracts.ts";
import { shellQuote as q } from "../project.ts";

/**
 * Gondolin refuses a command once 64 are outstanding, and counts one until the guest answers it, also after the host
 * stopped waiting (sandbox/server-ops.js, handleExec; exec.js, rejectExecSession). They are counted here the same way.
 * While the VM runs, its commands may hold only `runningSlots`, and the next waits for one to free, so that the
 * commands a stop runs always find room.
 */
const gondolinSlots = 64;
const runningSlots = 48;
type Slots = { outstanding: number; limit: number; waiting: Set<{ start(): void; refuse(error: Error): void }> };
const slots = new WeakMap<VM, Slots>();
function slotsOf(vm: VM): Slots {
	let held = slots.get(vm);
	if (held === undefined) slots.set(vm, (held = { outstanding: 0, limit: runningSlots, waiting: new Set() }));
	return held;
}
function takeSlot(held: Slots, signal: AbortSignal): Promise<void> {
	if (held.waiting.size === 0 && held.outstanding < held.limit) {
		held.outstanding += 1;
		return Promise.resolve();
	}
	return new Promise((start, refuse) => {
		const waiter = {
			start() {
				signal.removeEventListener("abort", expire);
				held.outstanding += 1;
				start();
			},
			refuse,
		};
		const expire = () => {
			held.waiting.delete(waiter);
			refuse(signal.reason);
		};
		held.waiting.add(waiter);
		signal.addEventListener("abort", expire, { once: true });
	});
}
function giveSlot(held: Slots): void {
	held.outstanding -= 1;
	const [next] = held.waiting;
	if (next === undefined || held.outstanding >= held.limit) return;
	held.waiting.delete(next);
	next.start();
}
/** Once the VM stops running, only what closes it starts commands, and they may take every slot. */
export function freeReservedSlots(vm: VM): void {
	const held = slotsOf(vm);
	held.limit = gondolinSlots;
	for (const waiter of held.waiting) waiter.refuse(new Error("Guest command was not started, because the VM stopped running while it waited for a command slot"));
	held.waiting.clear();
}

/** Runs `run` while it holds one of the VM's command slots. Its wait ends after `waitMs`, but the slot is held until the guest answers. */
async function counted<T>(vm: VM, waitMs: number, run: () => Promise<T>): Promise<T> {
	const held = slotsOf(vm);
	// Not Gondolin's signal, whose abort would end the wait and leave the command running uncounted.
	const expiry = AbortSignal.timeout(waitMs);
	const expired = new Promise<never>((_, reject) =>
		expiry.addEventListener("abort", () => reject(new Error(`Guest command got no answer within ${waitMs} ms. Once started, it holds a command slot until it answers`)), { once: true }),
	);
	await Promise.race([takeSlot(held, expiry), expired]);
	return Promise.race([run().finally(() => giveSlot(held)), expired]);
}
/**
 * Runs `argv` in the guest as it is, with no shell and no watchdog, so only for a command that ends on its own within
 * `timeoutMs`. Nothing stops it in the guest after that.
 */
export function direct(vm: VM, argv: string[], timeoutMs = 3000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return counted(vm, timeoutMs + 10000, async () => await vm.exec(argv, { cwd: "/" }));
}
export async function execute(
	vm: VM,
	cmd: string,
	cwd: string,
	timeoutMs: number,
): Promise<{ exitCode: number; output: string; truncated: boolean }> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	let truncated = false;
	const sink = new Writable({
		write(chunk: Buffer, _encoding, done) {
			const room = 65536 - bytes;
			if (chunk.length > room) truncated = true;
			if (room > 0) {
				const part = chunk.subarray(0, room);
				chunks.push(part);
				bytes += part.length;
			}
			done();
		},
	});
	// The guest watchdog owns a separate process group and terminates it on timeout.
	const watchdog = [
		"import json,os,signal,subprocess,sys,time",
		"p=subprocess.Popen(['/bin/sh','-lc',sys.argv[1]],start_new_session=True,stderr=subprocess.STDOUT)",
		"try:",
		" code=p.wait(timeout=float(sys.argv[2]))",
		" result={'state':'exited','exitCode':code if code>=0 else 128-code}",
		"except subprocess.TimeoutExpired:",
		" try: os.killpg(p.pid,signal.SIGTERM)",
		" except ProcessLookupError: pass",
		" time.sleep(2)",
		" try: os.killpg(p.pid,signal.SIGKILL)",
		" except ProcessLookupError: pass",
		" p.wait()",
		" result={'state':'timed-out'}",
		"sys.stderr.write(json.dumps(result))",
	].join("\n");
	const result = await counted(vm, timeoutMs + 10000, async () =>
		await vm.exec(["python3", "-c", watchdog, cmd, String(timeoutMs / 1000)], {
			cwd,
			stdout: sink,
			stderr: "buffer",
		}),
	);
	const output = Buffer.concat(chunks).toString("utf8");
	if (result.exitCode !== 0)
		throw new Error(
			"Guest command could not start. Check cwd and that the image includes Python 3",
		);
	const outcome = commandOutcomeSchema.parse(JSON.parse(result.stderr));
	if (outcome.state === "timed-out")
		throw new Error(
			`Guest command timed out after ${timeoutMs} ms. Its process group was stopped. Inspect files before retrying`,
		);
	return { exitCode: outcome.exitCode, output, truncated };
}
export async function checked(
	vm: VM,
	cmd: string,
	cwd = "/",
	timeoutMs = 30000,
): Promise<string> {
	const result = await execute(vm, cmd, cwd, timeoutMs);
	if (result.exitCode !== 0)
		throw new Error(
			`Guest command exited ${result.exitCode}: ${result.output}`,
		);
	return result.output;
}
/** The guest file's bytes, or null when it does not exist. A read goes over sandboxd's file RPC and starts no process. */
export async function readGuestFile(vm: VM, path: string, signal?: AbortSignal): Promise<Buffer | null> {
	try {
		return await vm.fs.readFile(path, signal ? { signal } : {});
	} catch (error) {
		// sandboxd names the open's Zig error (sandboxd/main.zig, file_read_failed), which Gondolin puts in the message.
		if (error instanceof Error && error.message.endsWith("file_read_failed: FileNotFound")) return null;
		throw error;
	}
}
export const serviceRoot = "/var/lib/pi-sandbox/services";
export const stagingRoot = "/var/lib/pi-sandbox/staging";
/** Missing parent directories are made as the file's owner, so a user's file never lands in a directory only root can write. */
export async function writeFiles(
	vm: VM,
	files: readonly GuestFile[],
	signal: AbortSignal,
): Promise<void> {
	if (files.length === 0) return;
	const staging = `${stagingRoot}/${randomUUID()}`;
	await checked(vm, `mkdir -p ${q(staging)}; chmod 700 ${q(staging)}`);
	for (const [i, file] of files.entries())
		await vm.fs.writeFile(`${staging}/${i}`, file.content, { signal });
	const install = files.map((file, i) => {
		const owner = q(file.owner);
		const dir = q(posix.dirname(file.path));
		const mkdir =
			file.owner === "root"
				? `mkdir -p ${dir}`
				: `runuser -u ${owner} -- mkdir -p ${dir}`;
		return `${mkdir} && install -o ${owner} -g "$(id -gn ${owner})" -m ${file.mode.toString(8)} ${q(`${staging}/${i}`)} ${q(file.path)}`;
	});
	await checked(vm, [...install, `rm -rf ${q(staging)}`].join(" &&\n"));
}
export async function serviceRunning(vm: VM, name: string): Promise<boolean> {
	const result = await execute(
		vm,
		`test -f ${q(`${serviceRoot}/${name}.pid`)} && pid=$(cat ${q(`${serviceRoot}/${name}.pid`)}) && kill -0 "$pid" 2>/dev/null && test "$(cut -d ' ' -f 3 "/proc/$pid/stat")" != Z`,
		"/",
		3000,
	);
	return result.exitCode === 0;
}
export async function stopService(vm: VM, name: string): Promise<void> {
	const path = `${serviceRoot}/${name}.pid`;
	await checked(
		vm,
		`if test -f ${q(path)}; then
pid=$(cat ${q(path)})
case "$pid" in ''|*[!0-9]*) echo 'Invalid service process identity'; exit 1;; esac
if test -d "/proc/$pid" && ! tr '\\000' '\\n' < "/proc/$pid/cmdline" | grep -Fx ${q(`${serviceRoot}/${name}.sh`)} >/dev/null; then
  rm -f ${q(path)}; exit 0
fi
kill -TERM "-$pid" 2>/dev/null || true
attempt=0
while kill -0 "-$pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  if test "$attempt" -ge 20; then kill -KILL "-$pid" 2>/dev/null || true; break; fi
  sleep 0.1
done
rm -f ${q(path)}
fi`,
	);
}
export async function startService(
	vm: VM,
	name: string,
	service: Service,
	url?: string,
): Promise<void> {
	if (await serviceRunning(vm, name)) return;
	const script = `${serviceRoot}/${name}.sh`;
	const log = `${serviceRoot}/${name}.log`;
	const environment = {
		...service.env,
		PORT: String(service.port),
		...(url ? { PUBLIC_URL: url } : {}),
	};
	const content = [
		"#!/bin/sh",
		`cd ${q(service.cwd)} || exit 1`,
		...Object.entries(environment).map(
			([key, value]) => `export ${key}=${q(value)}`,
		),
		"trap 'exit 0' TERM INT",
		"while :; do",
		`  /bin/sh -lc ${q(service.command)}`,
		"  code=$?",
		"  printf '\\nService exited %s, restarting in 1s\\n' \"$code\"",
		`  if test "$(wc -c < ${q(log)})" -gt 1048576; then mv ${q(log)} ${q(`${log}.previous`)}; exec >>${q(log)} 2>&1; fi`,
		"  sleep 1",
		"done",
		"",
	].join("\n");
	await checked(vm, `mkdir -p ${q(serviceRoot)}`);
	await vm.fs.writeFile(script, content);
	await checked(
		vm,
		`setsid /bin/sh ${q(script)} </dev/null >>${q(log)} 2>&1 & echo $! > ${q(`${serviceRoot}/${name}.pid`)}`,
	);
}
