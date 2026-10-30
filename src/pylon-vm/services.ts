import { join, posix } from "node:path";
import type { VM } from "@earendil-works/gondolin";
import { z } from "zod";
import { linkedName, parseServicesFile, relayPorts, reservedPortMessage, reservedPorts, serviceReference, shellQuote as q, wantsPreview, withPublicUrls } from "../project.ts";
import { configSchema, type Service } from "./contracts.ts";
import { checked, direct, readGuestFile, serviceRunning, startService, stopService } from "./guest.ts";
import { openPortal } from "./portals.ts";
import { linkTarget, serviceState, unlinkRefusal, type PreviewService } from "../preview-links.ts";
import { noRelayStatus, readRelayStatus, relayLog, writeRelayMap } from "./relay.ts";
import { readJson, saveJson } from "../json-file.ts";
import { parse } from "../parse.ts";
import { serialQueue } from "../single-flight.ts";
import type { ServiceFact } from "../protocol.ts";

const relayPortList = Array.from({ length: relayPorts.last - relayPorts.first + 1 }, (_, i) => relayPorts.first + i);
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
	/** The services file's last parse, and the stamp `stat` gave the file then. */
	private declared: { stamp: string; services: Record<string, Service> } | undefined;
	/** What each service was last started with, as envKey gives it. A stop removes it. */
	private wanted = new Map<string, string>();
	/** Why the last start of a service failed. Cleared by the next start, or a stop. */
	private failures = new Map<string, string>();
	/** Services stopped on purpose, which a new public URL does not start. A start clears it. */
	private held = new Set<string>();
	/**
	 * The start whose readiness is being watched, per service. A later start, a stop or a close replaces or drops it,
	 * which ends that watch without a verdict.
	 */
	private watches = new Map<string, object>();
	/** The relay port each previewed port is served on. A port keeps its relay port while it stays previewed. */
	private relays = new Map<number, number>();
	/** The generation of the last relay map written, the last map, and the relay's last status. */
	private generation = 0;
	private relaysWritten = "";
	private relayStatus = noRelayStatus;
	/** The ingress routes last set, and why each previewed port without one has none. */
	private published: { prefix: string; port: number; stripPrefix: boolean }[] | undefined;
	private unrouted = new Map<number, string>();
	/** Map writes and status reads, one at a time, so a map lands, and is confirmed, in the order its routes changed. */
	private relayQueue = serialQueue();
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
		const assignments = await readJson(join(this.dir, "services.json"));
		if (assignments !== undefined) this.assignments = assignmentsSchema.parse(assignments);
		// Saved by a controller that let Nexus's own ports through, they are dropped rather than failing the wake.
		for (const [name, assignment] of Object.entries(this.assignments))
			if (reservedPorts.has(assignment.port)) {
				console.log(`services: ${name}'s saved port ${assignment.port} ${reservedPortMessage}, so it gets another`);
				delete this.assignments[name];
			}
		const adHoc = await readJson(join(this.dir, "adhoc.json"));
		for (const [name, service] of Object.entries(adHoc === undefined ? {} : z.record(z.string(), z.unknown()).parse(adHoc))) {
			try {
				this.adHocConfig[name] = parse(configSchema.shape.services, { [name]: service }, "adhoc.json")[name]!;
			} catch (error) {
				console.log(`services: ad hoc service ${name} is not restored: ${(error as Error).message}`);
			}
		}
		// A linked port outlives the boot, because the control plane keeps its preview for the thread's life.
		const linked = linkedSchema.parse(await readJson(join(this.dir, "linked.json"), []));
		for (const port of linked) {
			if (reservedPorts.has(port)) console.log(`services: linked port ${port} ${reservedPortMessage}, so it is not routed`);
			else this.attached.set(port, await openPortal(await this.ingress(), `/${linkedName(port)}`));
		}
		await this.routes();
	}
	/** A repo without the file declares no services. The file is parsed again only once its size, inode or mtime changed. */
	private async declaredFile(): Promise<Record<string, Service>> {
		const stat = await direct(this.vm, ["stat", "-L", "-c", "%s %i %y", this.configPath]);
		if (stat.exitCode !== 0) {
			if (stat.stderr.includes("No such file or directory")) return {};
			throw new Error(`${this.configPath} could not be read: ${stat.stderr.trim()}`);
		}
		const stamp = stat.stdout.trim();
		if (this.declared?.stamp === stamp) return this.declared.services;
		if (Number(stamp.split(" ")[0]) > 1048576)
			throw new Error("Service YAML exceeds 1 MiB");
		const text = await readGuestFile(this.vm, this.configPath);
		if (text === null) return {};
		const services = configSchema.parse(parseServicesFile(text.toString("utf8"))).services;
		this.declared = { stamp, services };
		return services;
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
				for (const match of value.matchAll(serviceReference)) {
					const dependency = match[1];
					if (!dependency) continue;
					const target = config[dependency];
					if (
						!target ||
						!this.declaredNames.has(dependency) ||
						!wantsPreview(target)
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
		if (wantsPreview(service) && !portal) this.roomFor(port);
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
		await this.routes();
		return entry;
	}
	/** Each preview, a service's or a linked port's, by its ingress prefix. */
	private previews(): { prefix: string; port: number }[] {
		return [
			...[...this.entries].flatMap(([name, entry]) => (entry.portal ? [{ prefix: `/${name}/`, port: entry.port }] : [])),
			...[...this.attached.keys()].map((port) => ({ prefix: `/${linkedName(port)}/`, port })),
		];
	}
	/**
	 * Gives each preview a relay port, tells the relay, and routes the preview to its relay port once the relay
	 * confirms it carries that port to the preview's app (relay.ts). The ingress dials only 127.0.0.1 and the relay
	 * reaches `::1` too. A service without a preview needs no route, since its health is asked in the guest. A dropped
	 * preview's route goes before the relay hears that its relay port is free, and a relay port is routed again only
	 * once the relay confirms its new app, so the ingress never reaches the wrong app. A preview that finds no free relay
	 * port, only one restored from an earlier boot since roomFor refuses new ones, stays unrouted rather than failing
	 * the boot, and takes the next relay port freed.
	 */
	private async routes(): Promise<void> {
		const ports = new Set(this.previews().map((route) => route.port));
		for (const port of this.relays.keys()) if (!ports.has(port)) this.relays.delete(port);
		const taken = new Set(this.relays.values());
		for (const port of ports) {
			if (this.relays.has(port)) continue;
			const relay = relayPortList.find((candidate) => !taken.has(candidate));
			if (relay === undefined) {
				console.log(`services: port ${port} is not routed, because ${this.full}`);
				continue;
			}
			this.relays.set(port, relay);
			taken.add(relay);
		}
		this.publish();
		const relays = new Map(this.relays);
		await this.relayStep(async () => {
			const json = JSON.stringify([...relays]);
			if (json !== this.relaysWritten) {
				await writeRelayMap(this.vm, ++this.generation, relays);
				this.relaysWritten = json;
			}
			await this.confirm();
		});
	}
	private relayStep(step: () => Promise<void>): Promise<void> {
		return this.relayQueue.run(async () => {
			await step();
			this.publish();
		});
	}
	/**
	 * Reads the relay's status until it has applied the last map, for at most 5 s. A preview it has not stays unrouted,
	 * and since every fact waits on the relay queue behind this, a fact only ever reports one the wait gave up on.
	 */
	private async confirm(): Promise<void> {
		const deadline = Date.now() + 5000;
		for (;;) {
			this.relayStatus = await readRelayStatus(this.vm);
			if (this.relayStatus.generation >= this.generation || Date.now() >= deadline) return;
			await new Promise((accept) => setTimeout(accept, 100));
		}
	}
	/**
	 * Routes each preview whose relay port the relay's status shows carrying to its app. A status from before the last
	 * map keeps only the routes already set, whose relay ports that map left as they were.
	 */
	private publish(): void {
		const current = this.relayStatus.generation >= this.generation;
		const routes: { prefix: string; port: number; stripPrefix: boolean }[] = [];
		this.unrouted.clear();
		for (const { prefix, port } of this.previews()) {
			const relay = this.relays.get(port);
			const confirmed =
				relay !== undefined &&
				(current
					? this.relayStatus.bound[relay] === port
					: !!this.published?.some((route) => route.prefix === prefix && route.port === relay));
			if (confirmed) routes.push({ prefix, port: relay, stripPrefix: true });
			else
				this.unrouted.set(
					port,
					relay === undefined
						? `the preview has no relay port, because ${this.full}. Unpublish another preview to free one`
						: current && this.relayStatus.failed[relay] !== undefined
							? `the relay cannot listen on its relay port 127.0.0.1:${relay}: ${this.relayStatus.failed[relay]}`
							: `the relay did not confirm its relay port 127.0.0.1:${relay} within 5 s. Read ${relayLog} in the pylon`,
				);
		}
		if (JSON.stringify(routes) === JSON.stringify(this.published)) return;
		this.vm.setIngressRoutes(routes);
		this.published = routes;
	}
	private readonly full = `every relay port from ${relayPorts.first} to ${relayPorts.last} serves another preview`;
	/** Refuses a new preview that no relay port is free for, before anything is saved. */
	private roomFor(port: number): void {
		if (!this.relays.has(port) && this.relays.size >= relayPortList.length)
			throw new Error(`Port ${port} cannot be previewed, because ${this.full}. Unpublish one first`);
	}
	private previewServices(): PreviewService[] {
		return [...this.entries].map(([name, entry]) => ({ name, port: entry.port, previewed: entry.portal !== undefined, declared: entry.declared }));
	}
	/** Previews a port that is already listening, unsupervised. Returns the name it is reported under. */
	async attach(port: number): Promise<string> {
		const target = linkTarget(port, this.previewServices(), this.configPath);
		if (target !== "link") {
			if ("refused" in target) throw new Error(target.refused);
			return target.service;
		}
		if (!this.attached.has(port)) {
			this.roomFor(port);
			// Saved before the port counts as attached, so a failed save leaves a retry to save it again.
			const portal = await openPortal(await this.ingress(), `/${linkedName(port)}`);
			try {
				await saveJson(join(this.dir, "linked.json"), [...this.attached.keys(), port]);
			} catch (error) {
				await portal.close();
				throw error;
			}
			this.attached.set(port, portal);
		}
		// Also when the port was linked already, so a retry after a failed write of the relay map writes it.
		await this.routes();
		return linkedName(port);
	}
	/**
	 * Stops previewing a port that attach linked. A port that is not linked is left as it is. Returns why it refused,
	 * for a port a service's preview publishes, which only the service's declaration can drop, or a port whose linked
	 * name a service holds, because the caller drops the preview of that name. Otherwise null.
	 */
	async detach(port: number): Promise<string | null> {
		const portal = this.attached.get(port);
		if (!portal) return unlinkRefusal(port, this.previewServices(), this.configPath);
		// Saved before the port stops counting as attached, so a failed save leaves it linked and a retry saves it again.
		await saveJson(join(this.dir, "linked.json"), [...this.attached.keys()].filter((linked) => linked !== port));
		this.attached.delete(port);
		await this.routes();
		await portal.close();
		return null;
	}
	/** `running` is whether its process runs, when the caller has just asked. */
	private async healthy(name: string, entry: Entry, running?: boolean): Promise<boolean> {
		if (entry.service.health === "process")
			return running ?? serviceRunning(this.vm, name);
		return this.answers(entry.port, entry.service.health);
	}
	private async answers(port: number, path?: string): Promise<boolean> {
		return (await checked(this.vm, `python3 -c ${q(answersScript)} ${port}${path === undefined ? "" : ` ${q(path)}`}`)).trim() === "True";
	}
	/** The env and PUBLIC_URL a start gives the service. Throws while a URL it needs is unassigned. */
	private environment(name: string, entry: Entry): { env: Record<string, string>; url: string | undefined } {
		return { env: withPublicUrls(name, entry.service.env, this.publicUrls), url: this.publicUrls[name] };
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
		this.held.delete(name);
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
	 * before its preview was assigned, and starts each declared one that has not been, such as one declared while
	 * the pylon ran, which waited for its preview's URL. A service stopped on purpose stays stopped.
	 */
	async setPublicUrls(urls: Record<string, string>): Promise<void> {
		this.publicUrls = urls;
		for (const [name, entry] of this.entries) {
			const before = this.wanted.get(name);
			if (before === undefined) {
				if (!entry.declared || this.held.has(name)) continue;
			} else {
				if (before === this.envKey(name, entry)) continue;
				await stopService(this.vm, name);
			}
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
					this.held.delete(name);
					delete this.assignments[name];
				}
			}
			await saveJson(join(this.dir, "services.json"), this.assignments);
			await this.routes();
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
			for (const name of names) {
				await this.stop(name);
				this.held.add(name);
			}
		else
			for (const name of names) {
				if (this.entries.has(name) || !this.declaredNames.has(name)) continue;
				// A service declared since the last ensure gets its port, route and portal now, so it is reported and
				// its preview can be assigned. One with a preview starts once its URL arrives (setPublicUrls). One
				// without needs nothing more, and no spawn would follow to start it, so it starts here.
				const entry = await this.configure(name, config[name]!, true);
				if (!wantsPreview(entry.service)) await this.start(name, entry, entry.service.timeoutMs);
			}
		// The relay may have confirmed a relay port since the routes last changed, or lost one.
		await this.relayStep(async () => {
			this.relayStatus = await readRelayStatus(this.vm);
		});
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
		const state = serviceState({
			running,
			healthy: running && (await this.healthy(name, entry, running)),
			failed: this.failures.has(name),
			watched: this.watches.has(name),
		});
		return {
			name,
			state,
			port: entry.port,
			declared: entry.declared,
			wantsPreview: wantsPreview(entry.service),
			...(entry.portal ? this.unroutedFact(entry.port) : {}),
		};
	}
	private unroutedFact(port: number): Pick<ServiceFact, "unrouted"> {
		const unrouted = this.unrouted.get(port);
		return unrouted === undefined ? {} : { unrouted };
	}
	private async linkedFact(port: number): Promise<ServiceFact> {
		return {
			name: linkedName(port),
			state: (await this.answers(port)) ? "ready" : "stopped",
			port,
			declared: false,
			wantsPreview: true,
			...this.unroutedFact(port),
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

/**
 * argv: a port, then optionally a path. Prints whether the port listens on 127.0.0.1, or else `::1`, the two addresses
 * the relay carries to, and with a path, whether it answers a GET of it with a 2xx or 3xx, all within 2 s. It asks the
 * port itself, never through the relay, so a relay port that listens while the service does not cannot make it ready.
 */
export const answersScript = [
	"import http.client,os,signal,socket,sys",
	"def late(*_): sys.stdout.write('False\\n'); sys.stdout.flush(); os._exit(0)",
	"signal.signal(signal.SIGALRM,late); signal.setitimer(signal.ITIMER_REAL,2)",
	"port=int(sys.argv[1]); path=sys.argv[2] if len(sys.argv)>2 else None",
	"def up(family,host):",
	" try:",
	"  with socket.socket(family) as s: s.settimeout(1); return s.connect_ex((host,port))==0",
	" except OSError: return False",
	"host=next((h for f,h in ((socket.AF_INET,'127.0.0.1'),(socket.AF_INET6,'::1')) if up(f,h)),None)",
	"ok=host is not None",
	"if ok and path:",
	" try:",
	"  c=http.client.HTTPConnection(host,port,timeout=2); c.request('GET',path); ok=200<=c.getresponse().status<400",
	" except (OSError,http.client.HTTPException): ok=False",
	"print(ok)",
].join("\n");

