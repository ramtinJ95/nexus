import {
	createHttpHooks,
	getInfoFromSshExecRequest,
	type SshExecPolicy,
	type VMOptions,
} from "@earendil-works/gondolin";
import type { BootSpec } from "./contracts.ts";

type Remote = NonNullable<BootSpec["ssh"]>["remotes"][number];

/** Gondolin's network options for one boot, and the secret placeholders the guest sees in place of values. */
export function networkOptions(
	spec: BootSpec,
): Pick<VMOptions, "httpHooks" | "ssh"> & { placeholders: Record<string, string> } {
	const { httpHooks, env } = createHttpHooks({
		allowedHosts: spec.allowedHosts,
		secrets: spec.secrets,
	});
	if (spec.ssh === null) return { httpHooks, placeholders: env };
	const { privateKey, knownHostsFile, remotes } = spec.ssh;
	const target = (r: Remote) => (r.port === 22 ? r.host : `${r.host}:${r.port}`);
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

/** Gondolin normalizes the leading slash and `~/` away. `.git` is optional on both sides. */
const repoPath = (path: string) =>
	path
		.replace(/^(?:~\/|\/)+/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");

function gitOnly(remotes: readonly Remote[]): SshExecPolicy {
	const allowed = remotes.map((r) => `${r.host}:${repoPath(r.repo)}`);
	return (request) => {
		const git = getInfoFromSshExecRequest(request);
		const ok =
			git !== null &&
			(git.service === "git-upload-pack" || git.service === "git-receive-pack") &&
			remotes.some(
				(r) =>
					r.host === request.hostname.toLowerCase() &&
					r.port === request.port &&
					repoPath(r.repo) === repoPath(git.repo),
			);
		return ok
			? { allow: true }
			: {
					allow: false,
					message: `SSH from this VM may only fetch from and push to ${allowed.join(", ")}`,
				};
	};
}
