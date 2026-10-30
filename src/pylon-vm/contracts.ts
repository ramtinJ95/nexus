import { z } from "zod";
import { previewText, serviceDecl, serviceName } from "../project.ts";

const nameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const guestPath = z
	.string()
	.startsWith("/")
	.refine((s) => !s.includes("\0"));
const cwd = z.string().refine((s) => !s.includes("\0"));
/** serviceDecl, with the defaults the supervisor runs a service with. */
const serviceSchema = serviceDecl.extend({
	cwd: serviceDecl.shape.cwd.default("."),
	env: serviceDecl.shape.env.default({}),
	preview: serviceDecl.shape.preview.default(false),
	previews: serviceDecl.shape.previews.default([]),
	timeoutMs: serviceDecl.shape.timeoutMs.default(30000),
});
export const configSchema = z
	.strictObject({
		version: z.literal(1).default(1),
		diskGiB: z.number().int().min(2).default(60),
		image: z.string().min(1).optional(),
		workspace: guestPath.default("/workspace"),
		setup: z.array(z.string().min(1)).default([]),
		/** A failed setup is not recorded on the disk, so every boot of it runs setup again until one succeeds. For a setup that is safe to rerun. */
		retrySetup: z.boolean().default(false),
		resume: z.array(z.string().min(1)).default([]),
		services: z.record(serviceName, serviceSchema).default({}),
	})
	.refine(
		(c) =>
			new Set(
				Object.values(c.services).flatMap((s) => (s.port ? [s.port] : [])),
			).size === Object.values(c.services).filter((s) => s.port).length,
		"Service ports must be unique",
	);
export type SandboxConfig = z.infer<typeof configSchema>;
export type Service = z.infer<typeof serviceSchema>;
const text1MiB = z
	.string()
	.max(1048576)
	.refine((s) => Buffer.byteLength(s) <= 1048576, "Text exceeds 1 MiB");
const userName = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/);
export const guestFileSchema = z.strictObject({
	path: guestPath,
	owner: userName,
	mode: z.number().int().min(0).max(0o7777),
	content: text1MiB,
});
export type GuestFile = z.infer<typeof guestFileSchema>;
const hostPattern = z.string().min(1);
/**
 * What one boot applies, given to every create, prepare and start. It holds secret values, so it is never
 * stored: the client hands it to the controller on its stdin, and the controller keeps it in memory.
 */
export const bootSchema = z.strictObject({
	resources: z.strictObject({
		cpus: z.number().int().positive(),
		memoryGiB: z.number().positive(),
		/** Loads the KVM modules at boot, so the guest can run VMs of its own. The boot fails when no /dev/kvm results. */
		nestedVirtualization: z.literal(true).optional(),
	}),
	allowedHosts: z.array(hostPattern),
	/**
	 * Keyed by the guest env name. A value is substituted only in requests to its own hosts, and is never
	 * written into the guest. A host that echoes it back in a response still shows it to the guest.
	 */
	secrets: z.record(
		z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
		z.strictObject({ hosts: z.array(hostPattern).min(1), value: z.string().min(1) }),
	),
	/** Git over SSH, terminated on the host. Only fetch and push of these repositories are let through. */
	ssh: z
		.strictObject({
			privateKey: z.string().min(1),
			knownHostsFile: z.string().startsWith("/"),
			remotes: z
				.array(
					z.strictObject({
						host: z.string().regex(/^[a-z0-9.-]+$/),
						port: z.number().int().min(1).max(65535),
						username: userName,
						/** The path as git sends it to the server, which is how the URL spells it. */
						repo: z.string().min(1),
					}),
				)
				.min(1),
		})
		.nullable(),
	/** Written before the hooks, on every boot. */
	files: z.array(guestFileSchema),
	/** Run on every boot, before setup or resume. Each waits to completion. A failure is logged, not fatal. */
	hooks: z.array(z.string().min(1)),
	/** Each service's PUBLIC_URL, the https address the probe publishes it at. A service without one has no PUBLIC_URL. */
	publicUrls: z.record(serviceName, z.url({ protocol: /^https$/ })),
	/** The probe's socket, which the guest's requests to http://nexus.pylon are forwarded to (host-bridge.ts). Null for a template build, which no pylon owns. */
	hostBridge: z.string().startsWith("/").nullable(),
});
export type BootSpec = z.infer<typeof bootSchema>;
export const commandOutcomeSchema = z.discriminatedUnion("state", [
	z.strictObject({ state: z.literal("exited"), exitCode: z.number().int() }),
	z.strictObject({ state: z.literal("timed-out") }),
]);
const identity = { name: nameSchema };
const labels = z.record(z.string(), z.string()).default({});
const waitMs = z.number().int().min(0).max(60000).default(10000);
export const actionSchema = z.discriminatedUnion("action", [
	z.strictObject({
		action: z.literal("list"),
		kind: z.enum(["instances", "templates"]).default("instances"),
	}),
	z.strictObject({
		action: z.literal("prepare"),
		...identity,
		config: configSchema,
		boot: bootSchema,
		labels,
	}),
	z.strictObject({
		action: z.literal("create"),
		...identity,
		config: configSchema,
		/** A prepared template's disk, copied in as the instance's disk. Its first boot then runs setup on it, and resume. */
		disk: guestPath.optional(),
		boot: bootSchema,
		labels,
	}),
	z.strictObject({ action: z.literal("start"), ...identity, boot: bootSchema }),
	z.strictObject({ action: z.enum(["stop", "inspect"]), ...identity }),
	z.strictObject({
		action: z.literal("shell"),
		...identity,
		user: z
			.string()
			.regex(/^[a-z_][a-z0-9_-]{0,31}$/)
			.default("root"),
	}),
	z.strictObject({
		action: z.literal("destroy"),
		...identity,
		kind: z.enum(["instances", "templates"]).default("instances"),
		confirm: nameSchema,
	}),
	z.strictObject({
		action: z.literal("exec"),
		...identity,
		cmd: z.string().min(1),
		cwd: cwd.optional(),
		timeoutMs: waitMs,
	}),
	z.strictObject({
		action: z.literal("exec-status"),
		...identity,
		pid: z.string().uuid(),
		timeoutMs: waitMs,
	}),
	z.strictObject({
		action: z.literal("exec-kill"),
		...identity,
		pid: z.string().uuid(),
	}),
	z.strictObject({ action: z.literal("read"), ...identity, path: guestPath }),
	z.strictObject({
		action: z.literal("write-files"),
		...identity,
		files: z.array(guestFileSchema).max(64),
	}),
	z.strictObject({
		action: z.literal("services"),
		...identity,
		op: z.enum(["ensure", "status", "restart", "stop"]),
		service: serviceName.optional(),
	}),
	z.strictObject({
		action: z.literal("service-start"),
		...identity,
		service: serviceName,
		title: previewText.optional(),
		description: previewText.optional(),
		...serviceSchema.shape,
	}),
	z.strictObject({
		action: z.literal("public-urls"),
		...identity,
		urls: bootSchema.shape.publicUrls,
	}),
	z.strictObject({
		action: z.literal("preview"),
		...identity,
		port: z.number().int().min(1).max(65535),
		title: z.string().optional(),
		description: z.string().optional(),
	}),
	z.strictObject({
		action: z.literal("unpreview"),
		...identity,
		port: z.number().int().min(1).max(65535),
	}),
	z.strictObject({
		action: z.literal("logs"),
		...identity,
		service: serviceName.optional(),
		lines: z.number().int().min(1).max(500).default(100),
	}),
	/** A new value for a secret this boot granted, swapped in on the running VM. It is never stored or logged. */
	z.strictObject({
		action: z.literal("update-secret"),
		...identity,
		secret: bootSchema.shape.secrets.keyType,
		value: z.string().min(1),
	}),
]);
export type Action = z.infer<typeof actionSchema>;
export const recordSchema = z.strictObject({
	version: z.literal(1),
	name: nameSchema,
	config: configSchema,
	createdAt: z.string(),
	labels,
});
export type SandboxRecord = z.infer<typeof recordSchema>;
export const statusSchema = z.strictObject({
	name: nameSchema,
	state: z.enum([
		"starting",
		"running",
		"stopping",
		"stopped",
		"prepared",
		"failed",
		"interrupted",
		"unavailable",
	]),
	resources: z.unknown().optional(),
	diskGiB: z.number().optional(),
	previews: z.record(z.string(), z.string()).optional(),
	persistence: z.literal("disk-only").optional(),
	bootedAt: z.string().optional(),
	startupError: z.string().optional(),
	/** What startupError joins, step by step: the setup that ran on this boot or that its disk recorded, then the services. */
	startupFailures: z
		.array(z.strictObject({ kind: z.enum(["setup", "services"]), message: z.string() }))
		.optional(),
	/** Whether the disk held this instance's finished setup when it booted. Absent from controllers that predate it. */
	setupRecorded: z.boolean().optional(),
	resumePid: z
		.union([z.string().uuid(), z.number().int().positive()])
		.optional(),
	recovery: z.string().optional(),
});
export const replySchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), result: z.unknown() }),
	z.object({ ok: z.literal(false), error: z.string() }),
]);
