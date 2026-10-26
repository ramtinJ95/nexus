import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
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

test("Claude OAuth uses a placeholder substituted only for its granted Anthropic host", async () => {
	const { httpHooks, placeholders } = networkOptions({
		...spec, allowedHosts: ["api.anthropic.com", "github.com"],
		secrets: { CLAUDE_CODE_OAUTH_TOKEN: { hosts: ["api.anthropic.com"], value: "test-oauth-not-a-real-token" } },
	}, "pylon-t1");
	const placeholder = placeholders.CLAUDE_CODE_OAUTH_TOKEN;
	assert.ok(placeholder);
	assert.notEqual(placeholder, "test-oauth-not-a-real-token");
	const send = (host: string) => httpHooks!.onRequest!(new Request(`https://${host}/v1/messages`, { headers: { authorization: `Bearer ${placeholder}` } }));
	const request = await send("api.anthropic.com");
	assert.ok(request instanceof Request);
	assert.equal(request.headers.get("authorization"), "Bearer test-oauth-not-a-real-token");
	await assert.rejects(async () => send("github.com"), { status: 403 });
});

test("guest requests that fail upstream fail one by one and never take the controller down", async () => {
	// Gondolin does not export its network backend, so the test loads the module the VM runs.
	const { QemuNetworkBackend } = await import(new URL("qemu/net.js", import.meta.resolve("@earendil-works/gondolin")).href);
	let served = 0;
	const upstream = http.createServer((req, res) => {
		if (++served % 6 === 0) return setTimeout(() => req.socket.destroy(), served % 30);
		res.writeHead(200);
		const body = setInterval(() => res.write("x"), served % 10 + 1);
		setTimeout(() => { clearInterval(body); res.end(); }, served % 40);
	});
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	const port = (upstream.address() as AddressInfo).port;
	const statuses = new Set<string>();
	try {
		let flow = 0;
		for (let round = 0; round < 15; round++) {
			let checks = 0;
			const backend = new QemuNetworkBackend({ socketPath: "/nonexistent", httpHooks: { isIpAllowed: () => ++checks % 4 !== 0 } });
			backend.on("error", () => {});
			const replies = new Map<string, { text: string; end: () => void }>();
			backend.stack = {
				handleTcpData: ({ key, data }: { key: string; data: Buffer }) => { replies.get(key)!.text += data.toString("latin1"); },
				handleTcpEnd: ({ key }: { key: string }) => replies.get(key)?.end(),
				handleTcpError: ({ key }: { key: string }) => replies.get(key)?.end(),
			};
			await Promise.all(Array.from({ length: 30 }, async (_, i) => {
				await sleep(i % 20);
				const key = `flow-${++flow}`;
				const ended = new Promise<void>((end) => replies.set(key, { text: "", end }));
				backend.tcpSessions.set(key, { srcIP: "192.168.127.3", srcPort: 40000 + i, dstIP: "10.0.0.1", dstPort: port, protocol: "http", pendingWrites: [], pendingWriteBytes: 0, flowControlPaused: false });
				backend.handleTcpSend({ key, data: Buffer.from(`GET / HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`) });
				if (flow % 3 === 0) setTimeout(() => { backend.handleTcpClose({ key }); replies.get(key)!.end(); }, flow % 30);
				await Promise.race([ended, sleep(1000)]);
				statuses.add(replies.get(key)!.text.slice(9, 12));
			}));
			await sleep(30);
		}
	} finally {
		upstream.closeAllConnections();
		upstream.close();
	}
	assert.ok(statuses.has("200") && statuses.has("502"), `both served and failed requests, got ${[...statuses]}`);
});
