import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type { VM } from "@earendil-works/gondolin";
import { commandOutcomeSchema, type GuestFile, type Service } from "./contracts.ts";
import { installFileCommand, shellQuote as q } from "../shell.ts";

/**
 * Gondolin refuses a command once 64 are outstanding, and counts one until the guest answers it, also after the host
 * stopped waiting (sandbox/server-ops.js, handleExec; exec.js, rejectExecSession). They are counted here the same way.
 * While the VM runs, its commands may hold only `runningSlots`, and the next waits for one to free, so that the
 * commands a stop runs always find room. Gondolin has no way to cancel a command it sent, and sandboxd answers one only
 * once its process exited and its stdout and stderr closed (sandboxd/main.zig), so a command that got no answer gives
 * its slot back only when its guest processes end. Each carries `commandMark` in its env, which the processes it starts
 * inherit, so a reap can find and kill them. A launched worker, a service and the relay drop it, as they hold none of
 * its output and outlive it on purpose. One reap runs at a time, in one of the slots a stop keeps.
 */
const gondolinSlots = 64;
const runningSlots = 48;
const commandMark = "NEXUS_GUEST_COMMAND";
/** Guest commands in a row that got no answer, past which the guest counts as not answering until it answers one. */
const unansweredLimit = 3;
type Slots = {
	outstanding: number;
	limit: number;
	waiting: Set<{ start(): void; refuse(error: Error): void }>;
	/** The commands that got no answer and that no reap has tried to kill yet. */
	stuck: Set<string>;
	reaping: boolean;
	/** The guest commands in a row that got no answer, and when the first of them started. */
	unanswered: { count: number; since: string } | null;
};
const slots = new WeakMap<VM, Slots>();
let commandCount = 0;
function slotsOf(vm: VM): Slots {
	let held = slots.get(vm);
	if (held === undefined) slots.set(vm, (held = { outstanding: 0, limit: runningSlots, waiting: new Set(), stuck: new Set(), reaping: false, unanswered: null }));
	return held;
}
function takeSlot(held: Slots, id: string, waitMs: number): Promise<void> {
	if (held.waiting.size === 0 && held.outstanding < held.limit) {
		held.outstanding += 1;
		return Promise.resolve();
	}
	const queued = Date.now();
	console.error(`guest command ${id} waits for a slot, ${held.outstanding} of ${held.limit} held`);
	return new Promise((start, refuse) => {
		const waiter = {
			start() {
				clearTimeout(expiry);
				held.outstanding += 1;
				console.error(`guest command ${id} got a slot after ${Date.now() - queued} ms`);
				start();
			},
			refuse(error: Error) {
				clearTimeout(expiry);
				refuse(error);
			},
		};
		const expiry = setTimeout(() => {
			held.waiting.delete(waiter);
			console.error(`guest command ${id} got no slot within ${waitMs} ms`);
			refuse(new Error(`Guest command was not started: no command slot freed within ${waitMs} ms, as ${held.outstanding} earlier guest commands hold them until the guest answers`));
		}, waitMs);
		held.waiting.add(waiter);
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
/** Since when the VM's guest has not answered its last guest commands, or undefined while it answers. */
export function notAnswering(vm: VM): { since: string; timeouts: number } | undefined {
	const unanswered = slots.get(vm)?.unanswered;
	return unanswered && unanswered.count >= unansweredLimit ? { since: unanswered.since, timeouts: unanswered.count } : undefined;
}

/**
 * Runs `run` in a slot `held` counts, with `id` in the env it gives, and waits until `deadline` for the guest's answer.
 * The slot is held until the guest answers. Only a command that is not a reap counts toward or clears `unanswered`,
 * and joins `stuck` when it got no answer.
 */
async function answered<T>(vm: VM, held: Slots, id: string, deadline: number, budgetMs: number, run: (env: Record<string, string>) => Promise<T>, reaps: boolean): Promise<T> {
	const started = Date.now();
	let late = false;
	const answer = run({ [commandMark]: id }).finally(() => {
		giveSlot(held);
		if (!late) return;
		held.stuck.delete(id);
		console.error(`guest command ${id} answered and released its slot ${Date.now() - started} ms after it started`);
	});
	let expiry: NodeJS.Timeout | undefined;
	const expired = new Promise<"expired">((accept) => (expiry = setTimeout(accept, Math.max(0, deadline - started), "expired")));
	const outcome = await Promise.race([answer.then((value) => ({ value }), (error: unknown) => ({ error })), expired]).finally(() => clearTimeout(expiry));
	if (outcome !== "expired") {
		if (reaps && held.unanswered !== null) {
			if (held.unanswered.count >= unansweredLimit) console.error(`guest: answers again, after ${held.unanswered.count} guest commands in a row got no answer`);
			held.unanswered = null;
		}
		if ("error" in outcome) throw outcome.error;
		return outcome.value;
	}
	late = true;
	console.error(`guest command ${id} got no answer within ${budgetMs} ms and keeps its slot, ${held.outstanding} of ${held.limit} held`);
	if (!reaps) {
		console.error(`guest: reaps wait until reap ${id} answers, so the commands that get no answer meanwhile keep their slots`);
		throw new Error(`Guest command got no answer within ${budgetMs} ms (${id} in the controller log)`);
	}
	held.unanswered = { count: (held.unanswered?.count ?? 0) + 1, since: held.unanswered?.since ?? new Date(started).toISOString() };
	if (held.unanswered.count === unansweredLimit) console.error(`guest: not answering, as ${unansweredLimit} guest commands in a row got no answer since ${held.unanswered.since}`);
	held.stuck.add(id);
	reap(vm, held);
	throw new Error(`Guest command got no answer within ${budgetMs} ms (${id} in the controller log). It keeps its command slot until the guest answers, and it may still have run or may run later, so check what it does before retrying it`);
}
/**
 * Runs `run` while it holds one of the VM's command slots. Its wait for a slot and for the guest's answer share one
 * deadline, `waitMs` from its start, so a slow slot never lets a command start later than that.
 */
async function counted<T>(vm: VM, waitMs: number, run: (env: Record<string, string>) => Promise<T>): Promise<T> {
	const held = slotsOf(vm);
	const id = `g${++commandCount}`;
	const deadline = Date.now() + waitMs;
	await takeSlot(held, id, waitMs);
	return answered(vm, held, id, deadline, waitMs, run, true);
}

/** Kills every guest process whose env carries one of the marks named after the script, and prints how many it killed. */
const reaper = [
	"import os,signal,sys",
	`marks={('${commandMark}='+i).encode() for i in sys.argv[1:]}`,
	"killed=set()",
	"for attempt in range(3):",
	" found=False",
	" for name in os.listdir('/proc'):",
	"  if not name.isdigit() or int(name) in killed or int(name)==os.getpid(): continue",
	"  try:",
	"   if marks.isdisjoint(open('/proc/'+name+'/environ','rb').read().split(b'\\0')): continue",
	"   os.kill(int(name),signal.SIGKILL); killed.add(int(name)); found=True",
	"  except OSError: pass",
	" if not found: break",
	"print(len(killed))",
].join("\n");
/** Kills the guest processes of the stuck commands, in a slot past `runningSlots`, unless a reap still holds one or the VM stops. */
function reap(vm: VM, held: Slots): void {
	if (held.reaping || held.stuck.size === 0 || held.limit !== runningSlots) return;
	const ids = [...held.stuck];
	held.stuck.clear();
	held.reaping = true;
	held.outstanding += 1;
	const id = `g${++commandCount}`;
	const run = (env: Record<string, string>) =>
		vm.exec(["python3", "-c", reaper, ...ids], { cwd: "/", env }).finally(() => {
			held.reaping = false;
			setImmediate(() => reap(vm, held));
		});
	answered(vm, held, id, Date.now() + 13000, 13000, run, false).then(
		(result) => console.error(`guest command ${id} killed ${result.stdout.trim() || "no"} guest processes of ${ids.join(" ")}`),
		(error: unknown) => console.error(`guest command ${id} could not kill the guest processes of ${ids.join(" ")}: ${error instanceof Error ? error.message : String(error)}`),
	);
}
/**
 * Runs `argv` in the guest as it is, with no shell and no watchdog, so only for a command that ends on its own within
 * `timeoutMs`. Nothing stops it in the guest after that but a reap.
 */
export function direct(vm: VM, argv: string[], timeoutMs = 3000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return counted(vm, timeoutMs + 10000, async (env) => await vm.exec(argv, { cwd: "/", env }));
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
	const result = await counted(vm, timeoutMs + 10000, async (env) =>
		await vm.exec(["python3", "-c", watchdog, cmd, String(timeoutMs / 1000)], {
			cwd,
			env,
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
	const install = files.map((file, i) =>
		installFileCommand(file.path, file.owner, file.mode, `${staging}/${i}`),
	);
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
		`setsid env -u ${commandMark} /bin/sh ${q(script)} </dev/null >>${q(log)} 2>&1 & echo $! > ${q(`${serviceRoot}/${name}.pid`)}`,
	);
}
