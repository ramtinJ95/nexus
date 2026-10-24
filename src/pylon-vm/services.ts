import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { VM } from "@earendil-works/gondolin";
import { parseDocument } from "yaml";
import { z } from "zod";
import { linkedName, reservedPorts } from "../project.ts";
import { configSchema, type Service } from "./contracts.ts";
import { checked, guestExists, serviceRunning, startService, stopService } from "./guest.ts";
import { openPortal } from "./portals.ts";
import { existsError, shellQuote as q, saveJson } from "./storage.ts";

const reference = /\$\{services\.([a-z0-9][a-z0-9-]{0,31})\.publicURL\}/g;
type Entry = {
	service: Service;
	declared: boolean;
	port: number;
	portal: Awaited<ReturnType<typeof openPortal>> | undefined;
};
const assignmentsSchema = z.record(
	z.string(),
	z.strictObject({
		port: z.number().int().min(1).max(65535),
		portalPort: z.number().int().min(1).max(65535).optional(),
	}),
);

/** One service as Nexus reports it, ServiceFact in src/protocol.ts. */
export type ServiceFact = {
	name: string;
	state: "starting" | "ready" | "failed" | "stopped";
	port: number;
	declared: boolean;
	wantsPreview: boolean;
};
const linkedSchema = z.array(z.number().int().min(1).max(65535));

/**
 * Supervises the services `configPath` declares, plus ad hoc ones, each as `user` from `root`. A service's
 * PUBLIC_URL, and any `${services.<name>.publicURL}` naming it, is the https address the probe publishes it
 * at, not its loopback portal. The portal is only the origin the probe's preview gateway forwards to.
 */
export class GuestServices {
	private entries = new Map<string, Entry>();
	private assignments: z.infer<typeof assignmentsSchema> = {};
	private base: string | undefined;
	private reservedPorts: number[] = [];
	private attached = new Map<number, Awaited<ReturnType<typeof openPortal>>>();
	private adHocConfig: Record<string, Service> = {};
	private declaredNames = new Set<string>();
	/** What each service was last started with, as envKey gives it. A stop removes it. */
	private wanted = new Map<string, string>();
	/** Why the last start of a service failed. Cleared by the next start, or a stop. */
	private failures = new Map<string, string>();
	/**
	 * The start whose readiness is being watched, per service. A later start, a stop or a close replaces or drops it,
	 * which ends that watch without a verdict.
	 */
	private watches = new Map<string, object>();
	private vm: VM;
	private dir: string;
	readonly configPath: string;
	private root: string;
	private user: string;
	private publicUrls: Record<string, string>;
	constructor(
		vm: VM,
		dir: string,
		configPath: string,
		root: string,
		user: string,
		publicUrls: Record<string, string>,
	) {
		this.vm = vm;
		this.dir = dir;
		this.configPath = configPath;
		this.root = root;
		this.user = user;
		this.publicUrls = publicUrls;
	}
	async initialize(): Promise<void> {
		try {
			this.assignments = assignmentsSchema.parse(
				JSON.parse(await readFile(join(this.dir, "services.json"), "utf8")),
			);
		} catch (error) {
			if (!existsError(error, "ENOENT")) throw error;
		}
		try {
			this.adHocConfig = configSchema.parse({
				services: JSON.parse(
					await readFile(join(this.dir, "adhoc.json"), "utf8"),
				),
			}).services;
		} catch (error) {
			if (!existsError(error, "ENOENT")) throw error;
		}
		// A linked port outlives the boot, because the control plane keeps its preview for the thread's life.
		let linked: number[] = [];
		try {
			linked = linkedSchema.parse(JSON.parse(await readFile(join(this.dir, "linked.json"), "utf8")));
		} catch (error) {
			if (!existsError(error, "ENOENT")) throw error;
		}
		for (const port of linked)
			this.attached.set(port, await openPortal(await this.ingress(), `/${linkedName(port)}`));
		this.routes();
	}
	/** A repo without the file declares no services. */
	private async declaredFile(): Promise<Record<string, Service>> {
		if (!(await guestExists(this.vm, this.configPath))) return {};
		if ((await this.vm.fs.stat(this.configPath)).size > 1048576)
			throw new Error("Service YAML exceeds 1 MiB");
		const text = await this.vm.fs.readFile(this.configPath, {
			encoding: "utf8",
		});
		if (Buffer.byteLength(text) > 1048576)
			throw new Error("Service YAML exceeds 1 MiB");
		const document = parseDocument(text, { uniqueKeys: true });
		if (document.errors.length)
			throw new Error(`Invalid service YAML: ${document.errors[0]?.message}`);
		return configSchema.parse(document.toJS({ maxAliasCount: 20 })).services;
	}
	private async declarations(): Promise<Record<string, Service>> {
		const services = await this.declaredFile();
		this.declaredNames = new Set(Object.keys(services));
		let promoted = false;
		for (const name of this.declaredNames) {
			if (this.adHocConfig[name]) {
				delete this.adHocConfig[name];
				promoted = true;
			}
		}
		if (promoted)
			await saveJson(join(this.dir, "adhoc.json"), this.adHocConfig);
		this.reservedPorts = Object.values(services).flatMap((service) =>
			service.port ? [service.port] : [],
		);
		return { ...this.adHocConfig, ...services };
	}
	private eligible(service: Service): boolean {
		return !service.platforms || service.platforms.includes("linux");
	}
	private order(config: Record<string, Service>, names: string[]): string[] {
		const ordered: string[] = [];
		const visiting = new Set<string>();
		const visit = (name: string) => {
			if (ordered.includes(name)) return;
			if (visiting.has(name))
				throw new Error(
					`Service dependency cycle at ${name}. Correct env references in ${this.configPath}`,
				);
			const service = config[name] ?? this.entries.get(name)?.service;
			if (!service)
				throw new Error(
					`Unknown service ${name}. Edit ${this.configPath} or use service-start`,
				);
			if (!this.eligible(service))
				throw new Error(
					`Referenced service ${name} excludes the guest's Linux platform`,
				);
			visiting.add(name);
			for (const value of Object.values(service.env))
				for (const match of value.matchAll(reference)) {
					const dependency = match[1];
					if (!dependency) continue;
					const target = config[dependency];
					if (
						!target ||
						!this.declaredNames.has(dependency) ||
						(!target.preview && !target.previews.length)
					)
						throw new Error(
							`Service ${name} references ${dependency}, which must be declared with a preview`,
						);
					visit(dependency);
				}
			visiting.delete(name);
			ordered.push(name);
		};
		for (const name of names) visit(name);
		return ordered;
	}
	private async ingress(): Promise<URL> {
		if (!this.base)
			this.base = (
				await this.vm.enableIngress({ listenHost: "127.0.0.1", listenPort: 0 })
			).url;
		return new URL(this.base);
	}
	private async configure(
		name: string,
		service: Service,
		declared: boolean,
		preserve = false,
	): Promise<Entry> {
		const current = this.entries.get(name);
		if (preserve && current)
			service = {
				...service,
				preview: current.service.preview,
				previews: current.service.previews,
			};
		let port = current?.port ?? this.assignments[name]?.port ?? service.port;
		if (!port) {
			const reserved = [
				...this.reservedPorts,
				...Object.values(this.assignments).map((entry) => entry.port),
				...[...this.entries.values()].map((entry) => entry.port),
			];
			port = Number(
				(
					await checked(
						this.vm,
						`python3 -c ${q("import json,socket,sys; reserved=json.loads(sys.argv[1]); s=socket.socket(); s.bind(('127.0.0.1',0)); port=s.getsockname()[1];\nwhile port in reserved:\n s.close(); s=socket.socket(); s.bind(('127.0.0.1',0)); port=s.getsockname()[1]\nprint(port)")} ${q(JSON.stringify(reserved))}`,
					)
				).trim(),
			);
		}
		for (const [other, assignment] of Object.entries(this.assignments))
			if (other !== name && assignment.port === port)
				throw new Error(`Service port ${port} is already assigned to ${other}`);
		for (const linked of this.attached.keys())
			if (linked !== port && linkedName(linked) === name)
				throw new Error(`Service ${name} has the name linked port ${linked} is previewed under. Rename it`);
		let portal = current?.portal;
		const base = await this.ingress();
		if (wantsPreview(service) && !portal)
			portal = await openPortal(base, `/${name}`, this.assignments[name]?.portalPort);
		if (!wantsPreview(service) && portal) {
			await portal.close();
			portal = undefined;
		}
		const entry = { service, declared, port, portal };
		this.entries.set(name, entry);
		this.assignments[name] = {
			port,
			...(portal ? { portalPort: Number(new URL(portal.url).port) } : {}),
		};
		await saveJson(join(this.dir, "services.json"), this.assignments);
		this.routes();
		return entry;
	}
	private routes(): void {
		this.vm.setIngressRoutes([
			...[...this.entries].map(([name, entry]) => ({
				prefix: `/${name}/`,
				port: entry.port,
				stripPrefix: true,
			})),
			...[...this.attached.keys()].map((port) => ({
				prefix: `/${linkedName(port)}/`,
				port,
				stripPrefix: true,
			})),
		]);
	}
	/** Previews a port that is already listening, unsupervised. Returns the name it is reported under. */
	async attach(port: number): Promise<string> {
		if (reservedPorts.has(port))
			throw new Error(`Port ${port} is Nexus's own, so it cannot be previewed`);
		const owner = [...this.entries].find(([, entry]) => entry.port === port);
		if (owner) {
			if (!owner[1].portal)
				throw new Error(
					`Port ${port} belongs to service ${owner[0]}, which has no preview. Declare one in ${this.configPath}`,
				);
			return owner[0];
		}
		if (this.entries.has(linkedName(port)))
			throw new Error(
				`Service ${linkedName(port)} runs on another port, so port ${port} cannot be previewed under that name. Rename the service`,
			);
		if (!this.attached.has(port)) {
			// Saved before the port counts as attached, so a failed save leaves a retry to save it again.
			const portal = await openPortal(await this.ingress(), `/${linkedName(port)}`);
			try {
				await saveJson(join(this.dir, "linked.json"), [...this.attached.keys(), port]);
			} catch (error) {
				await portal.close();
				throw error;
			}
			this.attached.set(port, portal);
			this.routes();
		}
		return linkedName(port);
	}
	/**
	 * Stops previewing a port that attach linked. A port that is not linked is left as it is. Returns why it refused,
	 * for a port a service's preview publishes, which only the service's declaration can drop, or a port whose linked
	 * name a service holds, because the caller drops the preview of that name. Otherwise null.
	 */
	async detach(port: number): Promise<string | null> {
		const portal = this.attached.get(port);
		if (!portal) {
			const owner = [...this.entries].find(([, entry]) => entry.port === port && entry.portal);
			if (owner)
				return `Port ${port} is the preview of service ${owner[0]}, not a linked port. ${owner[1].declared ? `Remove the preview from ${this.configPath} to unpublish it` : "An ad hoc service keeps its preview"}`;
			return this.entries.has(linkedName(port))
				? `Service ${linkedName(port)} is not a linked port, so port ${port} has no linked preview to unpublish. Rename the service`
				: null;
		}
		// Saved before the port stops counting as attached, so a failed save leaves it linked and a retry saves it again.
		await saveJson(join(this.dir, "linked.json"), [...this.attached.keys()].filter((linked) => linked !== port));
		this.attached.delete(port);
		this.routes();
		await portal.close();
		return null;
	}
	private async listening(port: number): Promise<boolean> {
		const listening = await checked(
			this.vm,
			`python3 -c ${q("import socket,sys; s=socket.socket(); s.settimeout(1); print(s.connect_ex(('127.0.0.1',int(sys.argv[1])))==0); s.close()")} ${port}`,
		);
		return listening.trim() === "True";
	}
	private async healthy(name: string, entry: Entry): Promise<boolean> {
		if (entry.service.health === "process")
			return serviceRunning(this.vm, name);
		if (!(await this.listening(entry.port))) return false;
		if (!entry.service.health) return true;
		try {
			const response = await fetch(
				`${this.base}/${name}${entry.service.health}`,
				{ signal: AbortSignal.timeout(2000), redirect: "manual" },
			);
			await response.body?.cancel();
			return response.status >= 200 && response.status < 400;
		} catch {
			return false;
		}
	}
	/** The env and PUBLIC_URL a start gives the service. Throws while a URL it needs is unassigned. */
	private environment(name: string, entry: Entry): { env: Record<string, string>; url: string | undefined } {
		const env = Object.fromEntries(
			Object.entries(entry.service.env).map(([key, value]) => [
				key,
				value.replace(reference, (_match, dependency: string) => {
					const url = this.publicUrls[dependency];
					if (!url)
						throw new Error(
							`Service ${name} needs the public URL of ${dependency}, which has no preview assigned yet. It starts once one is`,
						);
					return url;
				}),
			]),
		);
		return { env, url: this.publicUrls[name] };
	}
	private envKey(name: string, entry: Entry): string {
		try {
			return JSON.stringify(this.environment(name, entry));
		} catch (error) {
			return `unresolved: ${(error as Error).message}`;
		}
	}
	/**
	 * Launches the service and returns without waiting for it to answer: its readiness is watched in the background,
	 * and it fails once `timeoutMs` passes without health. Every caller holds the controller's lifecycle queue, which a
	 * health wait would hold for as long. A failure is recorded and logged, not thrown, so one service never stops the
	 * others or the boot.
	 */
	private async start(
		name: string,
		entry: Entry,
		timeoutMs: number,
	): Promise<void> {
		this.wanted.set(name, this.envKey(name, entry));
		this.failures.delete(name);
		const watch = {};
		this.watches.set(name, watch);
		try {
			const { env, url } = this.environment(name, entry);
			await startService(
				this.vm,
				name,
				{
					...entry.service,
					cwd: posix.resolve(this.root, entry.service.cwd),
					// The supervisor loop runs as root and keeps the service's process group. runuser without
					// --login keeps PORT, PUBLIC_URL and the env, and the login shell adds the user's profile.
					command: `runuser -u ${q(this.user)} -- /bin/sh -lc ${q(entry.service.command)}`,
					port: entry.port,
					env,
				},
				url,
			);
		} catch (error) {
			this.watches.delete(name);
			this.failed(name, error);
			return;
		}
		void this.watch(name, entry, watch, Date.now() + timeoutMs);
	}
	private async watch(name: string, entry: Entry, watch: object, deadline: number): Promise<void> {
		const current = () => this.watches.get(name) === watch;
		try {
			while (current() && !(await this.healthy(name, entry))) {
				if (Date.now() >= deadline)
					throw new Error(
						`Service ${name} started but is not responding. Read logs, then restart or stop it`,
					);
				await new Promise((accept) => setTimeout(accept, 200));
			}
		} catch (error) {
			if (current()) this.failed(name, error);
		} finally {
			if (current()) this.watches.delete(name);
		}
	}
	private failed(name: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.failures.set(name, message);
		console.log(`services: ${name} failed: ${message}`);
	}
	private async stop(name: string): Promise<void> {
		this.watches.delete(name);
		await stopService(this.vm, name);
		this.wanted.delete(name);
		this.failures.delete(name);
	}
	/**
	 * Restarts each service that was asked to run and whose env the new URLs change, such as one that started
	 * before its preview was assigned. A service stopped on purpose stays stopped.
	 */
	async setPublicUrls(urls: Record<string, string>): Promise<void> {
		this.publicUrls = urls;
		for (const [name, entry] of this.entries) {
			const before = this.wanted.get(name);
			if (before === undefined || before === this.envKey(name, entry)) continue;
			await stopService(this.vm, name);
			await this.start(name, entry, entry.service.timeoutMs);
		}
	}
	async operate(
		op: "ensure" | "status" | "restart" | "stop",
		selected?: string,
	): Promise<ServiceFact[]> {
		const config = op === "stop" ? {} : await this.declarations();
		if (selected && !config[selected] && !this.entries.has(selected))
			throw new Error(`Unknown service ${selected}. Edit ${this.configPath}`);
		if (op === "ensure" || op === "restart") {
			// A reopened controller has no active entries. Reconcile disk-backed
			// service ownership first, not only processes in this controller.
			// Attached raw portals have separate ownership and routes.
			for (const name of Object.keys(this.assignments)) {
				if (!config[name] || !this.eligible(config[name]))
					delete this.assignments[name];
			}
			for (const [name, entry] of this.entries) {
				if (entry.declared && (!config[name] || !this.eligible(config[name]))) {
					await this.stop(name);
					await entry.portal?.close();
					this.entries.delete(name);
					delete this.assignments[name];
				}
			}
			await saveJson(join(this.dir, "services.json"), this.assignments);
			this.routes();
			if (selected && !config[selected] && !this.entries.has(selected))
				throw new Error(
					`Service ${selected} is no longer declared. Edit ${this.configPath}`,
				);
		}
		let names = selected
			? [selected]
			: [...new Set([...Object.keys(config), ...this.entries.keys()])];
		names = names.filter((name) =>
			this.eligible(config[name] ?? this.entries.get(name)!.service),
		);
		if (op === "ensure" || op === "restart") {
			names = this.order(config, names);
			for (const name of names) {
				const definition = config[name] ?? this.entries.get(name)!.service;
				// Ensure does not silently replace a live process's environment.
				const entry = await this.configure(
					name,
					definition,
					this.declaredNames.has(name),
					op === "restart",
				);
				if (op === "restart" && (!selected || selected === name))
					await stopService(this.vm, name);
				await this.start(name, entry, entry.service.timeoutMs);
			}
		} else if (op === "stop")
			for (const name of names) await this.stop(name);
		// Only a configured service has a port. A declared one that no ensure has reached yet is not reported.
		const facts = await Promise.all(
			names.flatMap((name) => {
				const entry = this.entries.get(name);
				return entry ? [this.fact(name, entry)] : [];
			}),
		);
		if (selected) return facts;
		return [...facts, ...(await Promise.all([...this.attached.keys()].map((port) => this.linkedFact(port))))];
	}
	private async fact(name: string, entry: Entry): Promise<ServiceFact> {
		const running = await serviceRunning(this.vm, name);
		const state =
			running && (await this.healthy(name, entry))
				? "ready"
				: this.failures.has(name)
					? "failed"
					: running
						? "starting"
						: "stopped";
		return {
			name,
			state,
			port: entry.port,
			declared: entry.declared,
			wantsPreview: wantsPreview(entry.service),
		};
	}
	private async linkedFact(port: number): Promise<ServiceFact> {
		return {
			name: linkedName(port),
			state: (await this.listening(port)) ? "ready" : "stopped",
			port,
			declared: false,
			wantsPreview: true,
		};
	}
	async adHoc(name: string, service: Service): Promise<ServiceFact[]> {
		const config = await this.declarations();
		if (this.declaredNames.has(name))
			throw new Error(
				`Service ${name} is declared. Use services ensure or restart`,
			);
		if (this.entries.has(name) || this.adHocConfig[name])
			throw new Error(`Service ${name} already exists. Use services restart`);
		if (!this.eligible(service))
			throw new Error(`Service ${name} excludes the Linux guest`);
		for (const dependency of this.order({ ...config, [name]: service }, [
			name,
		]).filter((key) => key !== name))
			await this.operate("ensure", dependency);
		const entry = await this.configure(name, service, false);
		this.adHocConfig[name] = service;
		await saveJson(join(this.dir, "adhoc.json"), this.adHocConfig);
		await this.start(name, entry, 60000);
		return this.operate("status", name);
	}
	/** The loopback origin of every preview, keyed by the name it is reported under. */
	urls(): Record<string, string> {
		return Object.fromEntries([
			...[...this.entries].flatMap(([name, entry]) =>
				entry.portal ? [[name, entry.portal.url]] : [],
			),
			...[...this.attached].map(([port, portal]) => [linkedName(port), portal.url]),
		]);
	}
	names(): string[] {
		return [...this.entries.keys()];
	}
	async close(): Promise<void> {
		this.watches.clear();
		for (const entry of this.entries.values()) {
			await entry.portal?.close();
			entry.portal = undefined;
		}
		for (const portal of this.attached.values()) await portal.close();
		this.attached.clear();
	}
	async stopAll(): Promise<void> {
		for (const name of this.entries.keys()) await stopService(this.vm, name);
	}
}

const wantsPreview = (service: Service) => !!service.preview || service.previews.length > 0;
