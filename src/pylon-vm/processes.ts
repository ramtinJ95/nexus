import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { VM } from "@earendil-works/gondolin";
import { z } from "zod";
import { direct, readGuestFile } from "./guest.ts";

/** Every boot makes it empty and private (runtime.ts), so a handle's directory and the worker never outlive the boot. */
export const commandsRoot = "/var/lib/pi-sandbox/commands";
const workerPath = `${commandsRoot}/worker.py`;
const expired = "Command status expired. Completed handles retain status for 128 commands";
const completedLimit = 128;
const outcome = z.strictObject({
	exitCode: z.number().int(),
	truncated: z.boolean(),
});
const worker = [
	"import ctypes,json,os,select,signal,subprocess,sys,time",
	"cmd,cwd,path,cleanup,deadline=sys.argv[1:]",
	"cleanup=cleanup=='true'",
	"if cleanup: ctypes.CDLL(None).prctl(36,1,0,0,0)",
	"try: p=subprocess.Popen(['/bin/sh','-lc',cmd],cwd=cwd,start_new_session=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)",
	"except Exception as e:",
	" open(path+'/output','wb').write(str(e).encode()[:65536]); open(path+'/done.tmp','w').write(json.dumps({'exitCode':127,'truncated':False})); os.rename(path+'/done.tmp',path+'/done'); sys.exit(0)",
	"open(path+'/pid.tmp','w').write(str(p.pid)); os.rename(path+'/pid.tmp',path+'/pid')",
	"os.set_blocking(p.stdout.fileno(),False)",
	"size=0; truncated=False; started=time.monotonic(); expired=False; killed=None",
	"with open(path+'/output','wb',buffering=0) as out:",
	" while True:",
	"  select.select([p.stdout],[],[],0.05)",
	"  try: data=os.read(p.stdout.fileno(),65536)",
	"  except BlockingIOError: data=b''",
	"  if not data: time.sleep(0.05)",
	"  if data:",
	"   room=max(0,65536-size); out.write(data[:room]); size+=min(room,len(data)); truncated=truncated or len(data)>room",
	"   if truncated and not os.path.exists(path+'/truncated'): open(path+'/truncated','w').close()",
	"  if killed is None and os.path.exists(path+'/kill'):",
	"   killed=time.monotonic()",
	"   try: os.killpg(p.pid,signal.SIGTERM)",
	"   except ProcessLookupError: pass",
	"  if killed is not None and time.monotonic()-killed>=2:",
	"   try: os.killpg(p.pid,signal.SIGKILL)",
	"   except ProcessLookupError: pass",
	"  if float(deadline)>0 and time.monotonic()-started>float(deadline):",
	"   expired=True",
	"   try: os.killpg(p.pid,signal.SIGKILL)",
	"   except ProcessLookupError: pass",
	"   break",
	"  if p.poll() is not None and (cleanup or not data) and (killed is None or time.monotonic()-killed>=2): break",
	"if cleanup:",
	" while True:",
	"  children=[]",
	"  for name in os.listdir('/proc'):",
	"   if not name.isdigit(): continue",
	"   try:",
	"    fields=open('/proc/'+name+'/stat').read().rsplit(')',1)[1].split()",
	"    if int(fields[1])==os.getpid(): children.append(int(name))",
	"   except (OSError,ValueError): pass",
	"  if not children: break",
	"  for child in children:",
	"   try: os.kill(child,signal.SIGKILL)",
	"   except ProcessLookupError: pass",
	"  while True:",
	"   try:",
	"    if os.waitpid(-1,os.WNOHANG)[0]==0: break",
	"   except ChildProcessError: break",
	"  time.sleep(0.01)",
	"p.wait()",
	"with open(path+'/output','ab',buffering=0) as out:",
	" for attempt in range(4):",
	"  try: data=os.read(p.stdout.fileno(),65536)",
	"  except BlockingIOError: break",
	"  if not data: break",
	"  room=max(0,65536-size); out.write(data[:room]); size+=min(room,len(data)); truncated=truncated or len(data)>room",
	"p.stdout.close()",
	"code=124 if expired else (p.returncode if p.returncode>=0 else 128-p.returncode)",
	"open(path+'/done.tmp','w').write(json.dumps({'exitCode':code,'truncated':truncated}))",
	"os.rename(path+'/done.tmp',path+'/done')",
].join("\n");
/** argv: the command's directory, then the worker's. It makes the directory and leaves the worker running on its own. */
const launcher = "import os,subprocess,sys; os.mkdir(sys.argv[1],0o700); subprocess.Popen(['python3']+sys.argv[2:],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)";

type Command = {
	path: string;
	offset: number;
	decoder: StringDecoder;
	final?: { exitCode: number; truncated: boolean };
	cursor: Promise<unknown>;
};

// Only the short launcher is a guest command. Long waits never hold Gondolin's
// foreground exec/file-RPC lock. Handles belong to this controller lifetime.
export class GuestProcesses {
	private commands = new Map<string, Command>();
	private vm: VM;
	/** Aborted when the controller stops, which ends every status wait and file operation so the stop can settle it (runtime.ts). */
	private stopping: AbortSignal;
	private worker: Promise<void> | undefined;
	constructor(vm: VM, stopping: AbortSignal) {
		this.vm = vm;
		this.stopping = stopping;
	}
	private read(path: string): Promise<Buffer | null> {
		return readGuestFile(this.vm, path, this.stopping);
	}
	private remove(path: string): Promise<void> {
		return this.vm.fs.deleteFile(path, { recursive: true, force: true, signal: this.stopping });
	}
	private installWorker(): Promise<void> {
		this.worker ??= this.vm.fs.writeFile(workerPath, worker, { signal: this.stopping }).catch((error: unknown) => {
			this.worker = undefined;
			throw error;
		});
		return this.worker;
	}
	async launch(
		cmd: string,
		cwd: string,
		cleanup = false,
		deadlineSeconds = 0,
	): Promise<string> {
		const handle = randomUUID();
		const path = `${commandsRoot}/${handle}`;
		await this.installWorker();
		const started = await direct(this.vm, ["python3", "-c", launcher, path, workerPath, cmd, cwd, path, String(cleanup), String(deadlineSeconds)], 30000);
		if (started.exitCode !== 0)
			throw new Error(`Guest command exited ${started.exitCode}: ${started.stderr || started.stdout}`);
		const deadline = Date.now() + 5000;
		let pid: Buffer | null;
		while (true) {
			// The worker writes pid before done, so a done seen first settles whether pid will ever appear.
			const done = await this.read(`${path}/done`);
			pid = await this.read(`${path}/pid`);
			if (pid !== null) break;
			if (done !== null) {
				const { exitCode } = outcome.parse(JSON.parse(done.toString("utf8")));
				const output = (await this.read(`${path}/output`))?.toString("utf8");
				await this.remove(path);
				throw new Error(
					`Guest command could not start: its worker wrote done but never pid, so spawning it failed (exit ${exitCode}): ${output || "(no output)"}`,
				);
			}
			if (Date.now() >= deadline)
				throw new Error(
					"Guest command did not start: neither its pid nor its done file appeared within 5 s. Check its working directory and image Python installation",
				);
			await new Promise((accept) => setTimeout(accept, 50));
		}
		z.number().int().positive().parse(Number(pid.toString("utf8")));
		this.commands.set(handle, {
			path,
			offset: 0,
			decoder: new StringDecoder("utf8"),
			cursor: Promise.resolve(),
		});
		await this.pruneCompleted();
		return handle;
	}
	/** Forgets the oldest completed commands past the newest 128, and removes the directory of each not yet consumed. */
	private async pruneCompleted(): Promise<void> {
		if (this.commands.size <= completedLimit) return;
		const completed: [string, Command][] = [];
		for (const entry of this.commands)
			if (entry[1].final || (await this.read(`${entry[1].path}/done`)) !== null) completed.push(entry);
		for (const [handle, command] of completed.slice(0, Math.max(0, completed.length - completedLimit))) {
			if (!command.final) {
				await command.cursor.catch(() => {});
				await this.remove(command.path);
			}
			this.commands.delete(handle);
		}
	}
	async status(
		pid: string,
		timeoutMs: number,
	): Promise<{
		pid: string;
		running: boolean;
		output: string;
		exitCode?: number;
		truncated?: boolean;
	}> {
		const command = this.commands.get(pid);
		if (!command)
			throw new Error(
				"Unknown or expired command handle. Completed status is bounded; handles do not survive stop or controller restart",
			);
		// Only short reads and output consumption share the cursor, never waits.
		if (command.final)
			return { pid, running: false, output: "", ...command.final };
		const deadline = Date.now() + timeoutMs;
		let done: Buffer | null;
		while (true) {
			this.stopping.throwIfAborted();
			if (this.commands.get(pid) !== command) throw new Error(expired);
			const probe = command.cursor.catch(() => {}).then(() => (command.final ? null : this.read(`${command.path}/done`)));
			command.cursor = probe;
			done = await probe;
			if (done !== null || command.final || Date.now() >= deadline) break;
			await new Promise((accept) => setTimeout(accept, 100));
		}
		const consume = command.cursor
			.catch(() => {})
			.then(async () => {
				if (this.commands.get(pid) !== command) throw new Error(expired);
				if (command.final)
					return { pid, running: false, output: "", ...command.final };
				// done was read before output, so an output read after a done holds all of it.
				const final = done === null ? undefined : outcome.parse(JSON.parse(done.toString("utf8")));
				const bytes = (await this.read(`${command.path}/output`)) ?? Buffer.alloc(0);
				let output =
					bytes.length > command.offset
						? command.decoder.write(bytes.subarray(command.offset))
						: "";
				command.offset = Math.max(command.offset, bytes.length);
				if (final) {
					output += command.decoder.end();
					await this.remove(command.path);
					command.final = final;
				}
				return {
					pid,
					running: !final,
					output,
					truncated: final?.truncated ?? (await this.read(`${command.path}/truncated`)) !== null,
					...(final ?? {}),
				};
			});
		command.cursor = consume;
		const result = await consume;
		if (!result.running) await this.pruneCompleted();
		return result;
	}
	async kill(pid: string): Promise<unknown> {
		const command = this.commands.get(pid);
		if (!command)
			throw new Error("Unknown command handle. Use the pid returned by exec");
		// The cursor contains only short RPCs, never the status wait.
		const kill = command.cursor
			.catch(() => {})
			.then(async () => {
				if (command.final) return { pid, killRequested: false, running: false };
				await this.vm.fs.writeFile(`${command.path}/kill`, "kill\n", { signal: this.stopping });
				return { pid, killRequested: true };
			});
		command.cursor = kill;
		return kill;
	}
}
