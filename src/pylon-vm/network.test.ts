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
	publicUrls: {},
	hostBridge: "/var/lib/nexus/pylons/host-bridge.sock",
};

async function sentAuthorization(url: string): Promise<string | null> {
	const { httpHooks, placeholders } = networkOptions(spec, "pylon-t1");
	const request = new Request(url, { headers: { authorization: `Bearer ${placeholders["STRIPE_KEY"]}` } });
	const sent = await httpHooks!.onRequest!(request);
	assert.ok(sent instanceof Request);
	return sent.headers.get("authorization");
}

test("the guest sees a placeholder, never the secret value", () => {
	const { placeholders } = networkOptions(spec, "pylon-t1");
	assert.ok(placeholders["STRIPE_KEY"]);
	assert.notEqual(placeholders["STRIPE_KEY"], "sk_live_real");
});

test("a secret's value is sent only to its own hosts", async () => {
	assert.equal(await sentAuthorization("https://api.stripe.com/v1/charges"), "Bearer sk_live_real");
	await assert.rejects(sentAuthorization("https://github.com/acme/web"), { status: 403, message: /STRIPE_KEY not allowed for host: github.com/ });
});

test("without SSH remotes, SSH egress stays off", () => {
	assert.equal(networkOptions({ ...spec, ssh: null }, "pylon-t1").ssh, undefined);
});

test("SSH egress reaches only the remotes' hosts, each with the node's key and the remote's user", () => {
	const { ssh } = networkOptions(spec, "pylon-t1");
	assert.deepEqual(ssh?.allowedHosts, ["github.com", "git.example.com:2222"]);
	assert.deepEqual(ssh?.credentials, {
		"github.com": { username: "git", privateKey: spec.ssh!.privateKey },
		"git.example.com:2222": { username: "deploy", privateKey: spec.ssh!.privateKey },
	});
	assert.equal(ssh?.knownHostsFile, "/etc/nexus/known_hosts");
});

test("SSH lets through only fetch and push of the remotes' repositories, as git spells the commands", async () => {
	const policy = networkOptions(spec, "pylon-t1").ssh!.execPolicy!;
	const decide = async (hostname: string, port: number, command: string) => {
		const request: SshExecRequest = { hostname, port, guestUsername: "git", command, src: { ip: "10.0.2.15", port: 40000 } };
		return (await policy(request)).allow;
	};
	assert.equal(await decide("github.com", 22, "git-upload-pack 'acme/web.git'"), true);
	assert.equal(await decide("github.com", 22, "git-receive-pack 'acme/web.git'"), true);
	assert.equal(await decide("git.example.com", 2222, "git-upload-pack '/me/dotfiles'"), true);
	// Gondolin forwards the command upstream as it is, so each of these could name another program or repository there.
	for (const [command, why] of [
		["/tmp/git-upload-pack 'acme/web.git'", "a program path the guest chose"],
		["/usr/bin/git-upload-pack 'acme/web.git'", "any program path"],
		["git-upload-pack acme/web.git", "an unquoted path"],
		["git-upload-pack 'acme/web'", "the path without .git"],
		["git-upload-pack '/acme/web.git'", "the path with a leading slash"],
		["git-upload-pack '~/acme/web.git'", "the path under ~"],
		["git-upload-pack 'acme/web.git/'", "the path with a trailing slash"],
		["git-upload-pack 'acme/other.git'", "another repository"],
		["git-upload-archive 'acme/web.git'", "another git service"],
		["sh -c id", "not git"],
	] as const) assert.equal(await decide("github.com", 22, command), false, why);
	assert.equal(await decide("git.example.com", 2222, "git-upload-pack 'me/dotfiles'"), false, "the dotfiles path without its slash");
	assert.equal(await decide("git.example.com", 2222, "git-upload-pack '/me/dotfiles.git'"), false, "the dotfiles path with .git");
	assert.equal(await decide("github.com", 2222, "git-upload-pack 'acme/web.git'"), false, "another port");
	assert.equal(await decide("git.example.com", 2222, "git-upload-pack 'acme/web.git'"), false, "the repository on another host");
});

test("without a host bridge, as for a template build, nexus.pylon is an ordinary host that the allowlist blocks", async () => {
	const { httpHooks } = networkOptions({ ...spec, hostBridge: null }, "template-t1");
	const sent = await httpHooks!.onRequest!(new Request("http://nexus.pylon/v1/request", { method: "POST", body: "{}" }));
	assert.ok(sent instanceof Request, "the hooks did not answer it");
	assert.equal(await httpHooks!.isIpAllowed!({ hostname: "nexus.pylon", ip: "198.18.0.1", family: 4, port: 80, protocol: "http" }), false);
});
