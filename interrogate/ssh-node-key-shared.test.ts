/**
 * Team mode, points 3 and 5: per-principal credentials and an egress guard over REST and GraphQL. A project whose
 * repoUrl is SSH (POST /v1/projects takes one from any allowed caller) gives every pylon of it the node's one git SSH
 * key (pylon-vm-backend.ts gitSshOf reads gitSsh.privateKeyFile), whoever owns the thread, and push goes through
 * Gondolin's SSH proxy, where the only hook is an exec policy that sees the command and never the refs pushed, and
 * never passes through httpHooks.onRequest, where a REST/GraphQL guard would sit.
 */
import { test } from "node:test";
import type { SshExecRequest } from "@earendil-works/gondolin";
import { networkOptions } from "../src/pylon-vm/network.ts";
import type { BootSpec } from "../src/pylon-vm/contracts.ts";

const nodeKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nthe node's one key\n";
const specFor = (): BootSpec => ({
  resources: { cpus: 2, memoryGiB: 4 }, allowedHosts: ["api.github.com", "github.com"],
  secrets: { GH_TOKEN: { hosts: ["api.github.com", "github.com"], value: "per-user" } },
  ssh: { privateKey: nodeKey, knownHostsFile: "/etc/nexus/known_hosts", remotes: [{ host: "github.com", port: 22, username: "git", repo: "acme/mono.git" }] },
  files: [], hooks: [], publicUrls: {}, hostBridge: null,
});

test("A's and B's pylons push with the same node key, and the push is invisible to an HTTP egress guard", async () => {
  let httpHookCalls = 0;
  for (const [owner, pylon] of [["engineer A", "pylon-th-a"], ["engineer B", "pylon-th-b"]] as const) {
    const options = networkOptions(specFor(), pylon);
    const guarded = options.httpHooks!.onRequest!;
    options.httpHooks!.onRequest = async (r) => { httpHookCalls++; return guarded(r); };
    const request: SshExecRequest = { hostname: "github.com", port: 22, guestUsername: "git", command: "git-receive-pack 'acme/mono.git'", src: { ip: "10.0.2.15", port: 40000 } };
    console.log(`${owner}: ssh key for github.com is the node key: ${options.ssh!.credentials!["github.com"]!.privateKey === nodeKey}; exec policy fields: ${Object.keys(request).join(",")}; git-receive-pack allowed: ${(await options.ssh!.execPolicy!(request)).allow}`);
  }
  console.log("HTTP onRequest (guard) calls during both pushes:", httpHookCalls);
});
