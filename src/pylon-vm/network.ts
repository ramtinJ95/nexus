import {
	createHttpHooks,
	getInfoFromSshExecRequest,
	type SshExecPolicy,
	type VMOptions,
} from "@earendil-works/gondolin";
import type { BootSpec } from "./contracts.ts";
import { hostBridgeHook } from "./host-bridge.ts";

type Remote = NonNullable<BootSpec["ssh"]>["remotes"][number];

/**
 * Gondolin's network options for one boot, and the secret placeholders the guest sees in place of values.
 * The host substitutes a value only in requests to its own hosts, so no value is ever provisioned into the
 * guest. A granted host that reflects a request header in its response still hands the value to the guest,
 * so a secret should be granted only to hosts that never echo credentials back.
 */
export function networkOptions(
	spec: BootSpec,
	instance: string,
): Pick<VMOptions, "httpHooks" | "ssh"> & { placeholders: Record<string, string> } {
	const { httpHooks, env } = createHttpHooks({
		allowedHosts: spec.allowedHosts,
		secrets: spec.secrets,
		...(spec.hostBridge === null ? {} : { onRequest: hostBridgeHook(spec.hostBridge, instance) }),
	});
	if (spec.ssh === null) return { httpHooks, placeholders: env };
	const { privateKey, knownHostsFile, remotes } = spec.ssh;
	return {
		httpHooks,
		placeholders: env,
		ssh: {
			allowedHosts: [...new Set(remotes.map(target))],
			credentials: Object.fromEntries(
				remotes.map((r) => [target(r), { username: r.username, privateKey }]),
			),
			knownHostsFile,
			execPolicy: gitOnly(remotes),
		},
	};
}

const target = (r: Remote) => (r.port === 22 ? r.host : `${r.host}:${r.port}`);

/**
 * The two commands git sends for a remote, the program name and then the path exactly as the remote's URL
 * spells it, in single quotes. Gondolin forwards the command upstream unchanged, so nothing is normalized: a
 * program path or another spelling of the path could mean something else to the server. Gondolin's own
 * parser runs first and fails closed on anything a shell would expand, so git's quotes are the only quoting.
 */
const gitCommands = (r: Remote) =>
	["git-upload-pack", "git-receive-pack"].map((program) => `${program} '${r.repo}'`);

function gitOnly(remotes: readonly Remote[]): SshExecPolicy {
	const allowed = remotes.map((r) => `${target(r)}:${r.repo}`);
	return (request) => {
		const ok =
			getInfoFromSshExecRequest(request) !== null &&
			remotes.some(
				(r) =>
					r.host === request.hostname.toLowerCase() &&
					r.port === request.port &&
					gitCommands(r).includes(request.command),
			);
		return ok
			? { allow: true }
			: {
					allow: false,
					message: `SSH from this VM may only fetch from and push to ${allowed.join(", ")}`,
				};
	};
}
