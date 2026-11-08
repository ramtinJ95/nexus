import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export const kinds = ["instances", "templates"] as const;
export type Kind = (typeof kinds)[number];

export const stateFiles = (root: string) => ({
	kind: (kind: Kind) => join(root, kind),
	scratch: join(root, "tmp"),
	/** Where the probe listens for the controllers' forwarded requests. Under the private state root, so only the probe's user reaches it. */
	hostBridge: join(root, "host-bridge.sock"),
});

export const directory = (root: string, kind: Kind, name: string): string => join(root, kind, name);
/** Where `create` builds an instance before it renames it into place. Hidden, so `list` skips it. */
export const stagingDirectory = (root: string, kind: Kind, name: string): string => join(root, kind, `.${name}.creating`);
/** Where `destroy` renames an instance before it removes it. Hidden, so `list` skips it. */
export const tombstoneDirectory = (root: string, kind: Kind, name: string): string => join(root, kind, `.${name}.deleting`);
export const stateRootOf = (dir: string): string => dirname(dirname(dir));
/** The controller's TMPDIR. */
export const scratchDirectory = (root: string, dir: string): string =>
	join(stateFiles(root).scratch, createHash("sha256").update(dir).digest("hex").slice(0, 12));

export const instanceFiles = (dir: string) => ({
	record: join(dir, "record.json"),
	intent: join(dir, "intent.json"),
	status: join(dir, "status.json"),
	disk: join(dir, "disk.qcow2"),
	nextDisk: join(dir, "disk.next.qcow2"),
	log: join(dir, "controller.log"),
	pid: join(dir, "controller.pid"),
	socket: join(dir, "control.sock"),
	launchLock: join(dir, "launch.lock"),
	retryStop: join(dir, "retry-stop.json"),
	services: join(dir, "services.json"),
	adHoc: join(dir, "adhoc.json"),
	linked: join(dir, "linked.json"),
	/** Nexus's adapter writes it, and the fork removes it with its instance. */
	checkpoint: join(dir, "nexus-checkpoint.json"),
});
