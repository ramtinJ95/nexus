/**
 * count.ts <src/pylon-vm of a checkout>: counts the guest calls and controller requests that ordinary reads make, with
 * that checkout's processes.ts, services.ts, runtime.ts and client.ts over a guest that only this script simulates. Its
 * guest keeps files in memory, answers the shell commands those modules send, and runs a launched worker at once, so
 * the command is finished by its first status. The counts are what the modules ask of Gondolin, not timings.
 */
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const src = process.argv[2]!;
const load = (file: string) => import(pathToFileURL(join(src, file)).href);
const { GuestProcesses } = await load("processes.ts");
const { GuestServices } = await load("services.ts");
const { SandboxRuntime } = await load("runtime.ts");
const { run } = await load("client.ts");

type Calls = { execs: string[]; reads: number; writes: number; deletes: number };
function guest() {
	const files = new Map<string, string>();
	const calls: Calls = { execs: [], reads: 0, writes: 0, deletes: 0 };
	const running = new Set<string>();
	let relay = "";
	let port = 41000;
	const missing = (path: string) => new Error(`failed to read guest file '${path}': file_read_failed: FileNotFound`);
	const work = (path: string) => files.set(`${path}/pid`, "42").set(`${path}/output`, "hello\n").set(`${path}/done`, JSON.stringify({ exitCode: 0, truncated: false }));
	const shell = (cmd: string): { exitCode: number; stdout?: string } => {
		const exists = /^test -e '([^']*)'$/.exec(cmd);
		if (exists) return { exitCode: files.has(exists[1]!) ? 0 : 1 };
		const launched = /'(\/var\/lib\/pi-sandbox\/commands\/[0-9a-f-]+)\/worker\.py'/.exec(cmd);
		if (launched) work(launched[1]!);
		const removed = /^rm -rf '([^']*)'$/.exec(cmd);
		if (removed) for (const key of [...files.keys()]) if (key.startsWith(removed[1]!)) files.delete(key);
		const relayMap = /printf '%s' '([^']*)' > '[^']*relays\.json\.new'/.exec(cmd);
		if (relayMap) {
			const map = JSON.parse(relayMap[1]!) as { generation: number; relays: Record<string, number> };
			relay = JSON.stringify({ generation: map.generation, bound: map.relays, failed: {} });
		}
		if (cmd.startsWith("cat ") && cmd.includes("relay-status.json")) return { exitCode: 0, stdout: relay };
		if (cmd.includes("connect_ex")) return { exitCode: 0, stdout: "True\n" };
		if (cmd.includes("getsockname")) return { exitCode: 0, stdout: `${port++}\n` };
		const service = /services\/([a-z0-9-]+)\.pid/.exec(cmd)?.[1];
		if (cmd.startsWith("test -f")) return { exitCode: running.has(service!) ? 0 : 1 };
		if (cmd.startsWith("setsid")) running.add(service!);
		return { exitCode: 0 };
	};
	const vm = {
		async exec(argv: string[], options?: { stdout?: { write(chunk: string): void } }) {
			const watched = argv[0] === "python3" && argv[1] === "-c" && argv[2]!.startsWith("import json,os,signal,subprocess,sys,time");
			if (watched) {
				const cmd = argv[3]!;
				calls.execs.push(cmd.startsWith("python3") ? "launcher" : cmd.split(" ")[0]!);
				const { exitCode, stdout } = shell(cmd);
				if (stdout) options!.stdout!.write(stdout);
				return { exitCode: 0, stdout: "", stderr: JSON.stringify({ state: "exited", exitCode }) };
			}
			calls.execs.push(argv[0] === "python3" ? "launcher" : argv[0]!);
			if (argv[0] === "python3") work(argv[3]!);
			if (argv[0] === "stat") {
				const file = files.get(argv.at(-1)!);
				return file === undefined
					? { exitCode: 1, stdout: "", stderr: `stat: cannot statx '${argv.at(-1)}': No such file or directory\n` }
					: { exitCode: 0, stdout: `${file.length} 1 2026-10-30 00:00:00.000000000 +0000\n`, stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		},
		fs: {
			async readFile(path: string, options?: { encoding?: string }) {
				calls.reads++;
				const file = files.get(path);
				if (file === undefined) throw missing(path);
				return options?.encoding ? file : Buffer.from(file);
			},
			async writeFile(path: string, content: string) {
				calls.writes++;
				files.set(path, String(content));
			},
			async deleteFile(path: string) {
				calls.deletes++;
				for (const key of [...files.keys()]) if (key.startsWith(path)) files.delete(key);
			},
			async stat(path: string) {
				calls.execs.push("fs.stat");
				return { size: files.get(path)!.length };
			},
		},
		async enableIngress() {
			return { url: "http://127.0.0.1:9/" };
		},
		setIngressRoutes() {},
	};
	const reset = () => {
		calls.execs.length = 0;
		calls.reads = calls.writes = calls.deletes = 0;
	};
	const report = (what: string) => {
		const kinds = Object.entries(Object.groupBy(calls.execs, (kind) => kind)).map(([kind, all]) => `${kind} x${all!.length}`);
		console.log(`${what}: ${calls.execs.length} guest commands (${kinds.join(", ") || "none"}), ${calls.reads} file reads, ${calls.writes} file writes, ${calls.deletes} deletes`);
		reset();
	};
	return { vm, files, report, reset };
}

const work = await mkdtemp(join(tmpdir(), "nx-count-"));
try {
	{
		const g = guest();
		const processes = new GuestProcesses(g.vm, new AbortController().signal);
		await processes.status(await processes.launch("cat /etc/hostname", "/"), 10000);
		g.report("a probe exec, launch and status of a one-line command");
		await processes.status(await processes.launch("cat /etc/hostname", "/"), 10000);
		g.report("a second probe exec");
	}
	{
		const g = guest();
		const configPath = "/workspace/repo/.nexus/services.yaml";
		g.files.set(configPath, "services:\n  worker:\n    command: work\n    health: process\n");
		const services = new GuestServices(g.vm, work, configPath, "/workspace/repo", "user", {});
		await services.initialize();
		const record = { name: "pylon-c", createdAt: "2027-01-01T00:00:00.000Z", labels: {}, config: { diskGiB: 8, workspace: "/workspace" } };
		const runtime = new SandboxRuntime(work, record, { resources: { cpus: 1, memoryGiB: 1 } }, { vm: g.vm, settleMs: 0, services });
		await runtime.handle({ action: "services", name: "pylon-c", op: "ensure" });
		await new Promise((accept) => setTimeout(accept, 300));
		// A rename gives the file a new inode and a new mtime, and a freed inode can be handed out again, so both are compared.
		const stamp = async () => {
			const { ino, mtimeNs } = await stat(join(work, "status.json"), { bigint: true });
			return `${ino} ${mtimeNs}`;
		};
		g.reset();
		for (const what of ["a services status of one process-health service, after an ensure", "a second services status"]) {
			const before = await stamp();
			await runtime.handle({ action: "services", name: "pylon-c", op: "status" });
			g.report(`${what}, which ${(await stamp()) === before ? "left status.json as it was" : "rewrote status.json"}`);
		}
		await services.close();
	}
	{
		const root = join(work, "root");
		const dir = join(root, "instances", "pylon-c");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmod(root, 0o700);
		await writeFile(join(dir, "record.json"), JSON.stringify({ version: 1, name: "pylon-c", config: {}, createdAt: "2027-01-01T00:00:00.000Z", labels: {} }));
		const arrived: string[] = [];
		const server = http.createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => (body += chunk)).on("end", () => {
				const { action } = JSON.parse(body) as { action: string };
				arrived.push(action);
				res.end(JSON.stringify({ ok: true, result: action === "inspect" ? { name: "pylon-c", status: { name: "pylon-c", state: "running" }, connected: true } : [] }));
			});
		});
		await new Promise<void>((accept) => server.listen(join(dir, "control.sock"), accept));
		await run(root, { action: "services", name: "pylon-c", op: "status" });
		console.log(`a services status through the client: ${arrived.length} controller requests (${arrived.join(", ")})`);
		arrived.length = 0;
		await run(root, { action: "inspect", name: "pylon-c" });
		console.log(`an inspect through the client: ${arrived.length} controller requests (${arrived.join(", ")})`);
		server.close();
	}
} finally {
	await rm(work, { recursive: true, force: true });
}
