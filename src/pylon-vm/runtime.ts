import { access, readFile, rename } from "node:fs/promises";
import { join, posix } from "node:path";
import { VM, type VMOptions, VmCheckpoint } from "@earendil-works/gondolin";
import type { Action, BootSpec, SandboxRecord } from "./contracts.ts";
import {
	checked,
	execute,
	guestExists,
	serviceRoot,
	stagingRoot,
	writeFiles,
} from "./guest.ts";
import { networkOptions } from "./network.ts";
import { openTerminal } from "./portals.ts";
import { GuestProcesses } from "./processes.ts";
import { GuestServices } from "./services.ts";
import { existsError, shellQuote as q, saveJson } from "./storage.ts";

/**
 * Logs a resume's output and then one `resume:` line with its outcome, however long it runs. A failed resume
 * does not fail the boot, so that an agent can still fix the script. Waits at most `waitMs`, and true means
 * the resume is still running and is followed to its end in the background.
 */
export async function reportResume(
	processes: Pick<GuestProcesses, "status">,
	pid: string,
	waitMs: number,
	log: (line: string) => void,
): Promise<boolean> {
	const follow = async (timeoutMs: number) => {
		const result = await processes.status(pid, timeoutMs);
		if (result.output) log(result.output);
		if (result.running) return true;
		const code = result.exitCode!;
		// The process supervisor reports a death by signal N as 128 + N.
		log(`resume: exited ${code}${code > 128 ? ` (signal ${code - 128})` : ""}`);
		return false;
	};
	if (!(await follow(waitMs))) return false;
	log(`resume: continues in the background as ${pid}`);
	void (async () => {
		while (await follow(60000));
	})().catch((error: unknown) =>
		log(`resume: no outcome, because ${error instanceof Error ? error.message : String(error)}`),
	);
	return true;
}

export class SandboxRuntime {
	private vm: VM | undefined;
	private processes: GuestProcesses | undefined;
	private managed: GuestServices | undefined;
	private failures: { kind: "setup" | "services"; message: string }[] = [];
	private setupRecorded = false;
	private get startupError(): string | undefined {
		return this.failures.length ? this.failures.map((f) => f.message).join("\n") : undefined;
	}
	private get setupError(): string | undefined {
		return this.failures.find((f) => f.kind === "setup")?.message;
	}
	private resumePid: string | undefined;
	private bootedAt: string | undefined;
	private recovery: string | undefined;
	private terminal:
		| { user: string; command: string; close(): Promise<void> }
		| undefined;
	private state:
		| "starting"
		| "running"
		| "stopping"
		| "stopped"
		| "prepared"
		| "interrupted"
		| "failed" = "starting";
	private dir: string;
	private record: SandboxRecord;
	private spec: BootSpec;
	constructor(dir: string, record: SandboxRecord, spec: BootSpec) {
		this.dir = dir;
		this.record = record;
		this.spec = spec;
	}
	async boot(prepare: boolean, setupRan?: SetupRun): Promise<void> {
		const config = this.record.config;
		const { resources } = this.spec;
		const { placeholders, ...network } = networkOptions(this.spec, this.record.name);
		const options: VMOptions = {
			cpus: resources.cpus,
			memory: `${resources.memoryGiB}G`,
			tmpfs: {},
			rootfs: { mode: "cow", size: `${config.diskGiB}G` },
			sessionLabel: `pi-sandbox:${this.record.name}`,
			sandbox: {
				vmm: "qemu",
				accel: process.platform === "darwin" ? "hvf" : "kvm",
				...(config.image ? { imagePath: config.image } : {}),
			},
			...network,
			env: {
				HOME: "/root",
				PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			},
		};
		const disk = join(this.dir, "disk.qcow2");
		let resume = false;
		try {
			await access(disk);
			resume = true;
		} catch (error) {
			if (!existsError(error, "ENOENT")) throw error;
		}
		const vm: VM = resume
			? await (await VmCheckpoint.load(disk)).resume(options)
			: await VM.create(options);
		this.vm = vm;
		await vm.start();
		this.bootedAt = new Date().toISOString();
		this.processes = new GuestProcesses(vm);
		// Disabling scratch tmpfs preserves HOME on disk. OCI images still need
		// normal Unix temporary-directory permissions for unprivileged tools.
		await checked(vm, "mkdir -p /tmp /var/tmp; chmod 1777 /tmp /var/tmp");
		await checked(vm, `mkdir -p ${q(config.workspace)}`);
		// A checkpoint restores filesystem files, not processes. Old service pid
		// files must never be mistaken for newly booted unrelated processes.
		await checked(
			vm,
			`rm -f ${serviceRoot}/*.pid; rm -rf /var/lib/pi-sandbox/commands ${stagingRoot}`,
		);
		// Placeholders are new on every boot, and login shells, which every guest command runs through, read profile.d.
		await writeFiles(vm, [
			{
				path: "/etc/profile.d/nexus-secrets.sh",
				owner: "root",
				mode: 0o644,
				content: Object.entries(placeholders)
					.map(([name, placeholder]) => `export ${name}=${q(placeholder)}\n`)
					.join(""),
			},
			{
				path: "/etc/ssh/ssh_config.d/nexus.conf",
				owner: "root",
				mode: 0o644,
				content: guestSshConfig,
			},
			...this.spec.files,
		]);
		for (const hook of this.spec.hooks) {
			const pid = await this.processes.launch(hook, "/", true, 120);
			let result = await this.processes.status(pid, 60000);
			while (result.running) {
				console.log(result.output);
				result = await this.processes.status(pid, 60000);
			}
			console.log(result.output);
			if (result.exitCode !== 0) console.error(`Boot hook exited ${result.exitCode}`);
		}
		const configPath = posix.join(config.workspace, ".sandbox.yaml");
		if (!(await guestExists(vm, configPath)))
			await vm.fs.writeFile(configPath, JSON.stringify(config, null, 2));
		const marker =
			resume && (await guestExists(vm, setupMarker))
				? await vm.fs.readFile(setupMarker, { encoding: "utf8" })
				: null;
		const { done, mark } = setupState(resume, marker, this.record, setupRan);
		this.setupRecorded = done !== null;
		this.failures = done?.setupError ? [{ kind: "setup", message: done.setupError }] : [];
		if (mark) await this.recordSetup(vm);
		if (done === null) {
			const setup = config.setup;
			if (setup.length) {
				const pid = await this.processes.launch(
					setup.map((cmd) => `/bin/sh -lc ${q(cmd)} || exit $?`).join("\n"),
					config.workspace,
					true,
					1200,
				);
				let result = await this.processes.status(pid, 60000);
				while (result.running) {
					console.log(result.output);
					result = await this.processes.status(pid, 60000);
				}
				console.log(result.output);
				if (result.exitCode !== 0) {
					this.failures.push({ kind: "setup", message: `Setup exited ${result.exitCode}. Read controller logs. No prepared template was published` });
					if (prepare) throw new Error(this.setupError);
				}
			}
			if (this.setupError === undefined || !config.retrySetup) await this.recordSetup(vm);
		}
		if (prepare) {
			await this.stop(true);
			return;
		}
		// Every boot from a disk runs resume, a template's first boot after its setup too. A boot from no disk ran
		// the whole setup, which leaves its processes running as resume would start them, so it skips resume.
		const hooks = resume ? config.resume : [];
		if (hooks.length) {
			const pid = await this.processes.launch(
				hooks.map((cmd) => `/bin/sh -lc ${q(cmd)} || exit $?`).join("\n"),
				config.workspace,
			);
			if (await reportResume(this.processes, pid, 10000, console.log))
				this.resumePid = pid;
		}
		this.managed = new GuestServices(
			vm,
			this.dir,
			configPath,
			config.workspace,
		);
		await this.managed.initialize();
		this.state = "running";
		await this.persistStatus();
		try {
			await this.managed.operate("ensure");
		} catch (error) {
			this.failures.push({
				kind: "services",
				message: error instanceof Error ? error.message : "Service readiness failed. Read service logs",
			});
			console.error(error);
		}
		await this.persistStatus();
	}
	private requireVm(): VM {
		if (!this.vm) throw new Error("Sandbox is not running. Use start first");
		return this.vm;
	}
	private status() {
		return {
			name: this.record.name,
			state: this.state,
			resources: this.spec.resources,
			diskGiB: this.record.config.diskGiB,
			previews: this.managed?.urls() ?? {},
			persistence: "disk-only",
			...(this.bootedAt ? { bootedAt: this.bootedAt } : {}),
			...(this.failures.length ? { startupError: this.startupError, startupFailures: this.failures } : {}),
			setupRecorded: this.setupRecorded,
			...(this.resumePid ? { resumePid: this.resumePid } : {}),
			...(this.recovery ? { recovery: this.recovery } : {}),
		};
	}
	private async persistStatus(): Promise<void> {
		await saveJson(join(this.dir, "status.json"), this.status());
	}
	beginShutdown(): void {
		if (this.state === "running") this.state = "stopping";
	}
	async stop(prepare = false): Promise<unknown> {
		if (this.state === "stopped" || this.state === "prepared")
			return this.status();
		const vm = this.requireVm();
		this.state = "stopping";
		const next = join(this.dir, "disk.next.qcow2");
		// Every step is inside the try: a failure before the checkpoint must not leave the controller in stopping.
		try {
			await this.persistStatus();
			await this.closeAccess();
			await this.managed?.stopAll();
			await checked(vm, "sync");
			await vm.checkpoint(next);
			this.vm = undefined;
			await rename(next, join(this.dir, "disk.qcow2"));
		} catch (error) {
			console.error(error);
			await vm.close();
			this.vm = undefined;
			this.state = "interrupted";
			this.recovery =
				"Stop failed before its checkpoint completed, and the VM is shut down. Start restores only the last completed checkpoint, or a fresh disk if none exists. Changes since that checkpoint were not saved";
			try {
				await this.persistStatus();
			} catch (statusError) {
				console.error(statusError);
			}
			throw new Error(this.recovery);
		}
		this.state = prepare ? "prepared" : "stopped";
		await this.persistStatus();
		return this.status();
	}
	get retired(): boolean {
		return this.state === "interrupted";
	}
	async handle(action: Action): Promise<unknown> {
		if (action.action === "inspect")
			return {
				name: this.record.name,
				createdAt: this.record.createdAt,
				labels: this.record.labels,
				workspace: this.record.config.workspace,
				configPath: posix.join(this.record.config.workspace, ".sandbox.yaml"),
				status: this.status(),
				connected: true,
				services: this.managed?.names() ?? [],
			};
		if (action.action === "stop") return this.stop();
		if (action.action === "destroy") {
			if (action.confirm !== this.record.name)
				throw new Error("confirm must match name");
			this.state = "stopping";
			await this.closeAccess();
			await this.vm?.close();
			this.vm = undefined;
			return { name: this.record.name, state: "destroyed" };
		}
		const vm = this.requireVm();
		if (this.state !== "running")
			throw new Error(
				"Sandbox is stopping. Wait for stop to complete, then use start",
			);
		switch (action.action) {
			case "shell": {
				if (this.terminal && this.terminal.user !== action.user)
					throw new Error(
						`Guest terminal is already configured for ${this.terminal.user}. Stop and start the instance to choose another user`,
					);
				if (!this.terminal) {
					await checked(
						vm,
						"command -v sshd >/dev/null && command -v sandboxssh >/dev/null || { echo 'Guest terminal requires an image with OpenSSH server and Gondolin SSH helper'; exit 1; }",
					);
					const ssh = await vm.enableSsh({
						user: action.user,
						listenHost: "127.0.0.1",
						listenPort: 0,
					});
					const terminal = await openTerminal(ssh.port);
					this.terminal = {
						user: action.user,
						command: `ssh -p ${terminal.port} -i ${q(ssh.identityFile)} -o ForwardAgent=no -o ClearAllForwardings=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${action.user}@127.0.0.1`,
						close: async () => {
							await terminal.close();
							await ssh.close();
						},
					};
				}
				return {
					name: this.record.name,
					command: this.terminal.command,
					handoff:
						"Run this command in a terminal on this host to access the guest. No host credentials were copied",
				};
			}
			case "exec":
				return this.processes!.status(
					await this.processes!.launch(
						action.cmd,
						posix.resolve(this.record.config.workspace, action.cwd ?? "."),
					),
					action.timeoutMs,
				);
			case "exec-status":
				return this.processes!.status(action.pid, action.timeoutMs);
			case "exec-kill":
				return this.processes!.kill(action.pid);
			case "read": {
				const result = await execute(
					vm,
					`head -c 65537 ${q(action.path)}`,
					"/",
					10000,
				);
				if (result.exitCode !== 0)
					throw new Error(`Guest file could not be read: ${result.output}`);
				return {
					path: action.path,
					content: result.output,
					truncated: result.truncated,
				};
			}
			case "write-files":
				await writeFiles(vm, action.files);
				return { paths: action.files.map((file) => file.path) };
			case "services":
				return this.managed!.operate(action.op, action.service);
			case "service-start": {
				const {
					action: _action,
					name: _name,
					service,
					title,
					description,
					...definition
				} = action;
				if (definition.preview && (title || description))
					definition.preview = {
						...(typeof definition.preview === "boolean"
							? { url: "/" }
							: definition.preview),
						...(title ? { title } : {}),
						...(description ? { description } : {}),
					};
				return this.managed!.adHoc(service, definition);
			}
			case "preview":
				return this.managed!.attach(
					action.port,
					action.title,
					action.description,
				);
			case "logs": {
				if (!action.service || !this.managed?.names().includes(action.service))
					throw new Error("Choose a started service for guest logs");
				return execute(
					vm,
					`tail -n ${action.lines} ${q(`${serviceRoot}/${action.service}.log`)}`,
					"/",
					10000,
				);
			}
			default:
				throw new Error("Action unavailable on a running instance");
		}
	}
	private async recordSetup(vm: VM): Promise<void> {
		await checked(vm, `mkdir -p ${q(posix.dirname(setupMarker))}`);
		await vm.fs.writeFile(setupMarker, setupMarkerOf(this.record, this.setupError));
	}
	async fail(error: unknown): Promise<void> {
		console.error(error);
		this.state = "failed";
		await this.persistStatus();
		await this.closeAccess();
		await this.vm?.close();
	}
	private async closeAccess(): Promise<void> {
		await this.terminal?.close();
		this.terminal = undefined;
		await this.managed?.close();
	}
}

/** Every SSH connection from the guest ends at Gondolin's proxy, which shows its own host key and checks the real one against the host's known_hosts. */
const guestSshConfig = `Host *
	StrictHostKeyChecking no
	UserKnownHostsFile /dev/null
	LogLevel ERROR
`;

/**
 * Whether setup ran on a disk is written on the disk, so it holds exactly when the disk holds setup's work: a
 * controller that died before its first checkpoint boots the older disk and runs setup again, and one that died
 * just after it does not. The marker names the instance, because a template's disk carries its build's marker,
 * and a pylon booted from it still runs its own setup.
 */
const setupMarker = "/var/lib/pi-sandbox/setup.json";
export function setupMarkerOf(record: SandboxRecord, setupError: string | undefined): string {
	return JSON.stringify({ instance: record.name, createdAt: record.createdAt, ...(setupError ? { setupError } : {}) });
}
/** A setup that ran, and how it failed if it did. */
export type SetupRun = { setupError?: string };
/** null when this instance's setup has not run on the disk. */
export function setupOnDisk(marker: string | null, record: SandboxRecord): SetupRun | null {
	if (marker === null) return null;
	const ran = JSON.parse(marker) as { instance: string; createdAt: string; setupError?: string };
	if (ran.instance !== record.name || ran.createdAt !== record.createdAt) return null;
	return ran.setupError === undefined ? {} : { setupError: ran.setupError };
}
/**
 * Whether a boot runs setup (`done` null), and whether it writes the marker. An instance created before setup
 * was recorded on its disk keeps what its intent said, `setupRan`, and the boot writes the marker its disk lacks,
 * which the next checkpoint keeps. A boot from no disk always runs setup, as it did then.
 */
export function setupState(disk: boolean, marker: string | null, record: SandboxRecord, setupRan: SetupRun | undefined): { done: SetupRun | null; mark: boolean } {
	if (!disk) return { done: null, mark: false };
	const onDisk = setupOnDisk(marker, record);
	if (onDisk !== null || setupRan === undefined) return { done: onDisk, mark: false };
	return { done: setupRan, mark: true };
}

export async function readIntent(dir: string): Promise<{ prepare: boolean; setupRan?: SetupRun }> {
	const { z } = await import("zod");
	const intent = z
		.union([
			z.strictObject({ prepare: z.boolean() }),
			// Written before setup was recorded on the disk: fresh is false once setup ran, with its error if it failed.
			z.strictObject({ prepare: z.boolean(), fresh: z.boolean(), setupError: z.string().optional() }),
		])
		.parse(JSON.parse(await readFile(join(dir, "intent.json"), "utf8")));
	if (!("fresh" in intent) || intent.fresh) return { prepare: intent.prepare };
	return { prepare: intent.prepare, setupRan: intent.setupError === undefined ? {} : { setupError: intent.setupError } };
}
