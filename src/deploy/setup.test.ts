import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parseConfig } from "../control/main.ts";
import { parseProbeConfig } from "../probe/config.ts";
import { formatLeft, left, paths, parseFlags, parseTailnet, report, setup, type Existing, type Facts, type FileWrite, type Json, type Setup } from "./setup.ts";

const status = JSON.stringify({
  Version: "1.90.0",
  BackendState: "Running",
  Self: {
    ID: "nSelf1CNTRL", HostName: "rj-firebat", DNSName: "rj-firebat.tail1234.ts.net.",
    TailscaleIPs: ["100.64.0.2", "fd7a:115c:a1e0::2"], OS: "linux", Online: true,
  },
  Peer: {
    "nodekey:aaa": {
      ID: "nBench1CNTRL", HostName: "infra-testbench", DNSName: "infra-testbench.tail1234.ts.net.",
      TailscaleIPs: ["100.64.0.3", "fd7a:115c:a1e0::3"], OS: "linux", Online: true,
    },
    "nodekey:bbb": {
      ID: "nMac1CNTRL", HostName: "Ramtins-MacBook-Pro", DNSName: "ramtins-macbook-pro.tail1234.ts.net.",
      TailscaleIPs: ["100.64.0.4", "fd7a:115c:a1e0::4"], OS: "macOS", Online: true,
    },
  },
});
const tailnet = parseTailnet(status);
const token = "c".repeat(64);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const dotfiles = "https://github.com/example/dotfiles.git";
const fresh: Existing = { gitKey: false };

function run(args: readonly string[], existing: Existing = fresh, net = tailnet): Setup {
  return setup(net, parseFlags(["write", ...args]).flags, existing, token);
}
function files(result: Setup): Map<string, FileWrite> {
  assert.ok(result.ok, `expected no errors, got ${result.ok ? "" : result.errors.join("; ")}`);
  return new Map(result.files.map((f) => [f.path, f]));
}
function value(written: Map<string, FileWrite>, path: string): Record<string, any> {
  const f = written.get(path);
  assert.ok(f, `${path} is written`);
  return f.value as Record<string, any>;
}
function onDisk(written: Map<string, FileWrite>): Existing {
  return { gitKey: false, ...Object.fromEntries([...written.values()].map((f) => [{ [paths.control]: "control", [paths.probe]: "probe", [paths.deployer]: "deployer" }[f.path]!, f.value])) };
}

test("the tailnet is read from tailscale status, with the first label, the host without its dot and the IPv4 address", () => {
  assert.deepEqual(tailnet.self, { id: "nSelf1CNTRL", name: "rj-firebat", host: "rj-firebat.tail1234.ts.net", ip: "100.64.0.2" });
  assert.deepEqual(tailnet.peers.map((p) => p.name).sort(), ["infra-testbench", "ramtins-macbook-pro"]);
});

test("a fresh control install writes configs the control plane and probe accept, all for this machine", () => {
  const written = files(run(["--admit", "Ramtins-MacBook-Pro", "--dotfiles", dotfiles]));
  assert.deepEqual([...written.values()].map((f) => [f.path, f.mode, f.state]), [
    [paths.control, 0o644, "new"], [paths.probe, 0o644, "new"], [paths.deployer, 0o600, "new"],
  ]);
  const control = parseConfig(JSON.stringify(value(written, paths.control)));
  const probe = parseProbeConfig(JSON.stringify(value(written, paths.probe)));
  const deployer = value(written, paths.deployer);
  assert.deepEqual(control.callers, ["nMac1CNTRL"]);
  assert.deepEqual(control.deployers, ["nMac1CNTRL"]);
  assert.deepEqual(control.deployKeys, { nSelf1CNTRL: sha256(deployer.token) });
  assert.equal(control.https?.hostname, "rj-firebat.tail1234.ts.net");
  assert.deepEqual(control.listen, { host: "100.64.0.2", port: 7470, hostnames: ["rj-firebat", "rj-firebat.tail1234.ts.net", "100.64.0.2"] });
  assert.deepEqual(control.nodes, [{ name: "rj-firebat", tailnetHost: "rj-firebat.tail1234.ts.net", tailnetNodeId: "nSelf1CNTRL" }]);
  assert.equal(control.imageBuildNode, "rj-firebat");
  assert.deepEqual(control.dotfiles, { repo: dotfiles, ref: "main" });
  assert.equal(probe.node, "rj-firebat");
  assert.deepEqual(probe.listen, { host: "100.64.0.2", port: 7480 });
  assert.deepEqual(probe.auth, { controlPlane: "nSelf1CNTRL", peers: [] });
  assert.equal("gitSsh" in probe.backend, false);
  assert.deepEqual(deployer, { controlUrl: "http://100.64.0.2:7470/", controlNodeId: "nSelf1CNTRL", token, drainTimeoutMs: 300000, healthTimeoutMs: 60000 });
});

const nodeTailnet = parseTailnet(status.replaceAll("rj-firebat", "x-self").replaceAll("infra-testbench", "rj-firebat"));

test("a node rerun keeps a control plane URL the person set, since the remote port is not this machine's to know", () => {
  const first = onDisk(files(run(["--node", "rj-firebat"], fresh, nodeTailnet)));
  const deployer = { ...(first.deployer as Record<string, Json>), controlUrl: "http://rj-firebat.tail1234.ts.net:7471/" };
  const written = files(run(["--node", "rj-firebat"], { ...first, deployer }, nodeTailnet));
  assert.equal(value(written, paths.deployer).controlUrl, "http://rj-firebat.tail1234.ts.net:7471/");
  assert.equal(written.get(paths.deployer)!.state, "unchanged");
});

test("a probe.json from before the artifact store keeps its images and gains no artifacts beside them", () => {
  const first = onDisk(files(run(["--dotfiles", dotfiles])));
  const { artifacts: _, ...backend } = (first.probe as Record<string, any>).backend;
  const legacy = { ...(first.probe as Record<string, Json>), backend: { ...backend, images: { "img-0123456789ab": "/var/lib/nexus/images/img-0123456789ab" } } };
  const written = files(run([], { ...first, probe: legacy }));
  assert.equal(parseProbeConfig(JSON.stringify(value(written, paths.probe))).backend.artifacts, "/var/lib/nexus/images");
  assert.equal(written.get(paths.probe)!.state, "unchanged");
});

test("a deployer.json that lacks a token gains one, and the report never prints it", () => {
  const first = onDisk(files(run(["--dotfiles", dotfiles])));
  const { token: _, ...deployer } = first.deployer as Record<string, Json>;
  const result = run([], { ...first, deployer });
  assert.equal(value(files(result), paths.deployer).token, token);
  const text = report(result.ok ? result.files : []);
  assert.match(text, /added a new deployer token/);
  assert.doesNotMatch(text, /c{64}/);
});

test("a fresh node install points its probe and deployer at the control machine and writes no control.json", () => {
  const written = files(run(["--node", "rj-firebat"], fresh, parseTailnet(status.replaceAll("rj-firebat", "x-self").replaceAll("infra-testbench", "rj-firebat"))));
  assert.equal(written.has(paths.control), false);
  const probe = parseProbeConfig(JSON.stringify(value(written, paths.probe)));
  assert.equal(probe.node, "x-self");
  assert.deepEqual(probe.auth, { controlPlane: "nBench1CNTRL", peers: ["nBench1CNTRL"] });
  assert.deepEqual(value(written, paths.deployer), {
    controlUrl: "http://rj-firebat.tail1234.ts.net:7470/", controlNodeId: "nBench1CNTRL", token, drainTimeoutMs: 300000, healthTimeoutMs: 60000,
  });
});

test("a rerun keeps the token and every value the person changed, adds what is new, refreshes what follows from the deployer, and says what it left alone", () => {
  const first = onDisk(files(run(["--dotfiles", dotfiles])));
  const control = first.control as Record<string, any>;
  const existing: Existing = {
    ...first,
    control: { ...control, listen: { ...control.listen, port: 7471 }, gitIdentity: { name: "A Person", email: "a@example.com" } },
    deployer: { ...(first.deployer as Record<string, Json>), token: "d".repeat(64) },
  };
  const result = run(["--admit", "ramtins-macbook-pro", "--dotfiles", "https://github.com/example/other.git"], existing);
  const written = files(result);
  const merged = parseConfig(JSON.stringify(value(written, paths.control)));
  assert.equal(merged.listen.port, 7471);
  assert.deepEqual(merged.gitIdentity, { name: "A Person", email: "a@example.com" });
  assert.equal(merged.dotfiles.repo, dotfiles);
  assert.deepEqual(merged.callers, ["nMac1CNTRL"]);
  assert.deepEqual(merged.deployers, ["nMac1CNTRL"]);
  assert.equal(value(written, paths.deployer).token, "d".repeat(64));
  assert.equal(value(written, paths.deployer).controlUrl, "http://100.64.0.2:7471/", "the deployer follows the control plane's port");
  assert.equal((merged.deployKeys as Record<string, string>).nSelf1CNTRL, sha256("d".repeat(64)), "the digest follows the token on disk");
  assert.deepEqual([...written.values()].map((f) => f.state), ["updated", "unchanged", "updated"]);
  const text = report(result.ok ? result.files : []);
  assert.match(text, /^updated \/etc\/nexus\/control\.json$/m);
  assert.match(text, /added callers "nMac1CNTRL"/);
  assert.match(text, /left listen\.port alone: it is 7471, and this run would write 7470/);
  assert.match(text, /left dotfiles\.repo alone/);
  assert.match(text, /replaced controlUrl "http:\/\/100\.64\.0\.2:7470\/" with "http:\/\/100\.64\.0\.2:7471\/"/);
  assert.match(text, /kept the existing deployer token/);
  assert.match(text, new RegExp(`replaced deployKeys\\.nSelf1CNTRL "${sha256(token)}" with "${sha256("d".repeat(64))}"`));
  assert.doesNotMatch(text, /d{64}|c{64}/, "the report never shows a token");

  const again = files(run([], onDisk(written)));
  assert.deepEqual([...again.values()].map((f) => f.state), ["unchanged", "unchanged", "unchanged"]);
});

test("a rerun over a config without imageBuildNode leaves image builds on the default node", () => {
  const first = onDisk(files(run(["--dotfiles", dotfiles])));
  const { imageBuildNode: _, ...control } = first.control as Record<string, Json>;
  const written = files(run([], { ...first, control }));
  assert.equal(parseConfig(JSON.stringify(value(written, paths.control))).imageBuildNode, undefined);
  assert.equal(written.get(paths.control)!.state, "unchanged");
});

test("--add-node adds the node, its deploy key and the probe peer, once", () => {
  const digest = "b".repeat(64);
  const first = onDisk(files(run(["--dotfiles", dotfiles])));
  const written = files(run(["--add-node", `infra-testbench=${digest}`], first));
  const control = parseConfig(JSON.stringify(value(written, paths.control)));
  assert.deepEqual(control.nodes.map((n) => n.tailnetNodeId), ["nSelf1CNTRL", "nBench1CNTRL"]);
  assert.equal((control.deployKeys as Record<string, string>).nBench1CNTRL, digest);
  assert.equal((control.deployKeys as Record<string, string>).nSelf1CNTRL, sha256(token));
  assert.deepEqual(parseProbeConfig(JSON.stringify(value(written, paths.probe))).auth.peers, ["nBench1CNTRL"]);
  const again = files(run(["--add-node", `infra-testbench=${digest}`], onDisk(written)));
  assert.deepEqual(value(again, paths.control).nodes, value(written, paths.control).nodes);
  assert.deepEqual([...again.values()].map((f) => f.state), ["unchanged", "unchanged", "unchanged"]);
});

test("a git key on disk adds gitSsh to an existing probe.json", () => {
  const first = onDisk(files(run(["--dotfiles", dotfiles])));
  const written = files(run([], { ...first, gitKey: true }));
  assert.equal(written.get(paths.probe)?.state, "updated");
  assert.deepEqual(parseProbeConfig(JSON.stringify(value(written, paths.probe))).backend, {
    kind: "pylon-vm", stateRoot: "/var/lib/nexus/pylons", artifacts: "/var/lib/nexus/artifacts",
    gitSsh: { privateKeyFile: "/etc/nexus/git_ed25519", knownHostsFile: "/etc/nexus/git_known_hosts" },
  });
});

function errors(result: Setup): readonly string[] {
  assert.equal(result.ok, false, "nothing is written");
  return result.ok ? [] : result.errors;
}

test("every control-role mistake is reported together", () => {
  const existing: Existing = {
    gitKey: false,
    control: { nodes: [{ name: "infra-testbench", tailnetHost: "infra-testbench.tail1234.ts.net", tailnetNodeId: "nBench1CNTRL" }] },
  };
  const found = errors(run(["--admit", "rj-firebat", "--admit", "infra-testbench", "--admit", "nosuch", "--add-node", "ramtins-macbook-pro=xyz", "--peer", "ghost"], existing));
  assert.equal(found.length, 5);
  assert.match(found.join("\n"), /--admit rj-firebat: that is this machine/);
  assert.match(found.join("\n"), /--admit infra-testbench: that is a node/);
  assert.match(found.join("\n"), /--admit nosuch: tailscale knows no such device\. It knows infra-testbench, ramtins-macbook-pro, rj-firebat/);
  assert.match(found.join("\n"), /--add-node ramtins-macbook-pro=xyz: give <device>=<digest>/);
  assert.match(found.join("\n"), /--peer ghost: tailscale knows no such device/);
});

test("a first control install needs --dotfiles, and a node cannot become a control plane by accident", () => {
  assert.match(errors(run([])).join("\n"), /--dotfiles <git url> is needed/);
  const nodeProbe: Existing = { gitKey: false, probe: { auth: { controlPlane: "nBench1CNTRL", peers: [] } } };
  assert.match(errors(run(["--dotfiles", dotfiles], nodeProbe)).join("\n"), /already a node of the control plane infra-testbench\. Pass --node infra-testbench/);
});

test("control-only flags and this machine as --node are refused for a node install", () => {
  const found = errors(run(["--node", "rj-firebat", "--admit", "ramtins-macbook-pro", "--add-node", `infra-testbench=${"b".repeat(64)}`, "--dotfiles", dotfiles]));
  assert.equal(found.length, 4);
  assert.match(found.join("\n"), /--node rj-firebat: that is this machine/);
  assert.match(found.join("\n"), /--admit is for the control machine/);
  assert.match(found.join("\n"), /--add-node is for the control machine/);
  assert.match(found.join("\n"), /--dotfiles is for the control machine/);
});

test("a name two devices share is ambiguous, and the full MagicDNS name picks one", () => {
  const shared = parseTailnet(JSON.stringify({
    ...JSON.parse(status),
    Peer: { ...JSON.parse(status).Peer, "nodekey:ccc": { ID: "nOther1CNTRL", DNSName: "infra-testbench.other.ts.net.", TailscaleIPs: ["100.64.0.9"] } },
  }));
  assert.match(errors(run(["--peer", "Infra-Testbench", "--dotfiles", dotfiles], fresh, shared)).join("\n"), /more than one device has that name: infra-testbench\.tail1234\.ts\.net, infra-testbench\.other\.ts\.net/);
  const written = files(run(["--peer", "infra-testbench.other.ts.net", "--dotfiles", dotfiles], fresh, shared));
  assert.deepEqual(value(written, paths.probe).auth.peers, ["nOther1CNTRL"]);
});

const freshControl: Facts = {
  self: tailnet.self, secretNames: [], gitKey: false,
  role: "control", port: 7470, signedIn: false, admitted: false, dockerGroup: false, image: false,
};

test("a fresh control machine is left every step, the ChatGPT login first and the Mac CLI last", () => {
  const runs = left(freshControl).map((item) => item.run);
  assert.equal(runs.length, 8);
  assert.match(runs[0]![0]!, /control\/login\.ts \/etc\/nexus\/control\.json$/);
  assert.equal(runs[0]![1], "sudo systemctl start nexus-control");
  const all = runs.flat().join("\n");
  assert.match(all, /--admit <your Mac's tailnet name>/);
  assert.match(all, /^claude setup-token$/m);
  assert.match(all, /echo 'CLAUDE_CODE_OAUTH_TOKEN=<token>' \| sudo tee -a \/etc\/nexus\/secrets\.env/);
  assert.match(all, /echo 'GH_TOKEN=<token>'/);
  assert.match(all, /ssh-keygen -t ed25519 -N '' -C nexus@rj-firebat -f \/etc\/nexus\/git_ed25519/);
  assert.match(all, /usermod --append --groups docker nexus/);
  assert.match(all, /nexus image rollout <image ID it printed> --wait/);
  assert.match(runs.at(-1)!.join("\n"), /printf '\{"url":"http:\/\/rj-firebat\.tail1234\.ts\.net:7470"\}\\n' > ~\/\.config\/nexus\/cli\.json/);
});

test("a finished control machine is left only the Mac CLI", () => {
  const items = left({ ...freshControl, secretNames: ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"], gitKey: true, signedIn: true, admitted: true, dockerGroup: true, image: true });
  assert.equal(items.length, 1);
  assert.match(items[0]!.run.join("\n"), /ln -sf "\$PWD\/deploy\/mac\/nexus" ~\/\.local\/bin\/nexus/);
});

test("a node is told how to register itself with the control plane and its peers", () => {
  const control = tailnet.peers.find((p) => p.name === "infra-testbench")!;
  const items = left({ self: tailnet.self, secretNames: ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"], gitKey: false, role: "node", control, digest: "e".repeat(64) });
  const all = items.flatMap((i) => i.run).join("\n");
  assert.match(all, new RegExp(`^sudo deploy/install\\.sh --add-node rj-firebat=${"e".repeat(64)}$`, "m"));
  assert.match(all, /^sudo deploy\/install\.sh --node infra-testbench --peer rj-firebat$/m);
  assert.match(all, /^sudo deploy\/install\.sh --node infra-testbench --peer <other node> --peer <another node>$/m, "this node admits the other nodes too");
  assert.match(all, /^sudo deploy\/install\.sh --node infra-testbench$/m, "the git key step reruns the node install");
  assert.match(all, /"url":"http:\/\/infra-testbench\.tail1234\.ts\.net:7470"/);
  assert.equal(formatLeft(items).split("\n")[0], "What is left:");
});
