import { test } from "node:test";
import assert from "node:assert/strict";
import type { SshExecRequest } from "@earendil-works/gondolin";
import type { BootSpec } from "./contracts.ts";
import { networkOptions } from "./network.ts";

const spec: BootSpec = {
	resources: { cpus: 2, memoryGiB: 4 },
	allowedHosts: ["api.stripe.com", "github.com"],
	secrets: { STRIPE_KEY: { hosts: ["api.stripe.com"], value: "sk_live_real" } },
	ssh: {
		privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n",
		knownHostsFile: "/etc/nexus/known_hosts",
		remotes: [
			{ host: "github.com", port: 22, username: "git", repo: "acme/web.git" },
			{ host: "git.example.com", port: 2222, username: "deploy", repo: "/me/dotfiles" },
		],
	},
	files: [],
	hooks: [],
};

async function sentAuthorization(url: string): Promise<string | null> {
	const { httpHooks, placeholders } = networkOptions(spec);
	const request = new Request(url, { headers: { authorization: `Bearer ${placeholders["STRIPE_KEY"]}` } });
	const sent = await httpHooks!.onRequest!(request);
	assert.ok(sent instanceof Request);
	return sent.headers.get("authorization");
}

test("the guest sees a placeholder, never the secret value", () => {
	const { placeholders } = networkOptions(spec);
	assert.ok(placeholders["STRIPE_KEY"]);
	assert.notEqual(placeholders["STRIPE_KEY"], "sk_live_real");
});

test("a secret's value is sent only to its own hosts", async () => {
	assert.equal(await sentAuthorization("https://api.stripe.com/v1/charges"), "Bearer sk_live_real");
	await assert.rejects(sentAuthorization("https://github.com/acme/web"), { status: 403, message: /STRIPE_KEY not allowed for host: github.com/ });
});

test("without SSH remotes, SSH egress stays off", () => {
	assert.equal(networkOptions({ ...spec, ssh: null }).ssh, undefined);
});

test("SSH egress reaches only the remotes' hosts, each with the node's key and the remote's user", () => {
	const { ssh } = networkOptions(spec);
	assert.deepEqual(ssh?.allowedHosts, ["github.com", "git.example.com:2222"]);
	assert.deepEqual(ssh?.credentials, {
		"github.com": { username: "git", privateKey: spec.ssh!.privateKey },
		"git.example.com:2222": { username: "deploy", privateKey: spec.ssh!.privateKey },
	});
	assert.equal(ssh?.knownHostsFile, "/etc/nexus/known_hosts");
});

test("SSH lets through only fetch and push of the remotes' repositories", async () => {
	const policy = networkOptions(spec).ssh!.execPolicy!;
	const decide = async (hostname: string, port: number, command: string) => {
		const request: SshExecRequest = { hostname, port, guestUsername: "git", command, src: { ip: "10.0.2.15", port: 40000 } };
		return (await policy(request)).allow;
	};
	assert.equal(await decide("github.com", 22, "git-upload-pack 'acme/web.git'"), true);
	assert.equal(await decide("github.com", 22, "git-receive-pack '/acme/web'"), true);
	assert.equal(await decide("git.example.com", 2222, "git-upload-pack '~/me/dotfiles.git'"), true);
	assert.equal(await decide("github.com", 22, "git-upload-pack 'acme/other.git'"), false, "another repository");
	assert.equal(await decide("github.com", 22, "git-upload-archive 'acme/web.git'"), false, "another git service");
	assert.equal(await decide("github.com", 22, "sh -c id"), false, "not git");
	assert.equal(await decide("github.com", 2222, "git-upload-pack 'acme/web.git'"), false, "another port");
	assert.equal(await decide("git.example.com", 2222, "git-upload-pack 'acme/web.git'"), false, "the repository on another host");
});
