import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseConfig } from "../control/main.ts";
import { parseProbeConfig } from "../probe/config.ts";
import { parseControlPlane } from "./control-plane.ts";
import { parseTailscaleStatus } from "../tailscale.ts";
import type { FollowUp } from "./credentials.ts";
import { formatLeft, holdsImage, install, left, paths, parseFlags, report, tailnetDevices, setup, type Existing, type Facts, type FileWrite, type InstallSteps, type Json, type Setup } from "./setup.ts";

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
const tailnet = tailnetDevices(parseTailscaleStatus(status));
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
  return { gitKey: false, ...Object.fromEntries([...written.values()].map((f) => [{ [paths.control]: "control", [paths.controlPlane]: "controlPlane", [paths.probe]: "probe", [paths.deployer]: "deployer" }[f.path]!, f.value])) };
}

test("the tailnet is read from tailscale status, with the first label, the host without its dot and the IPv4 address", () => {
  assert.deepEqual(tailnet.self, { id: "nSelf1CNTRL", name: "rj-firebat", host: "rj-firebat.tail1234.ts.net", ip: "100.64.0.2" });
  assert.deepEqual(tailnet.peers.map((p) => p.name).sort(), ["infra-testbench", "ramtins-macbook-pro"]);
});

test("a fresh control install writes configs the control plane and probe accept, all for this machine", () => {
  const written = files(run(["--admit", "Ramtins-MacBook-Pro", "--dotfiles", dotfiles]));
  assert.deepEqual([...written.values()].map((f) => [f.path, f.mode, f.state]), [
    [paths.control, 0o644, "new"], [paths.controlPlane, 0o644, "new"], [paths.probe, 0o644, "new"], [paths.deployer, 0o600, "new"],
  ]);
  assert.deepEqual(parseControlPlane(value(written, paths.controlPlane)), { tailnetNodeId: "nSelf1CNTRL", url: "http://100.64.0.2:7470/" });
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
  assert.deepEqual(probe.auth, { peers: [] });
  assert.equal("gitSsh" in probe.backend, false);
  assert.deepEqual(deployer, { token, drainTimeoutMs: 300000, healthTimeoutMs: 60000 });
});

const nodeTailnet = tailnetDevices(parseTailscaleStatus(status.replaceAll("rj-firebat", "x-self").replaceAll("infra-testbench", "rj-firebat")));

test("a node rerun keeps a control plane URL the person set, since the remote port is not this machine's to know", () => {
  const first = onDisk(files(run(["--node", "rj-firebat"], fresh, nodeTailnet)));
  const controlPlane = { ...(first.controlPlane as Record<string, Json>), url: "http://rj-firebat.tail1234.ts.net:7471/" };
  const written = files(run(["--node", "rj-firebat"], { ...first, controlPlane }, nodeTailnet));
  assert.equal(value(written, paths.controlPlane).url, "http://rj-firebat.tail1234.ts.net:7471/");
  assert.equal(written.get(paths.controlPlane)!.state, "unchanged");
});

test("a rerun over an install from before control-plane.json writes it from probe.json and deployer.json, and leaves their old keys", () => {
  const first = onDisk(files(run(["--node", "rj-firebat"], fresh, nodeTailnet)));
  const { controlPlane: _, ...rest } = first;
  const old: Existing = {
    ...rest,
    probe: { ...(first.probe as Record<string, any>), auth: { controlPlane: "nBench1CNTRL", peers: ["nBench1CNTRL"] } },
    deployer: { ...(first.deployer as Record<string, Json>), controlUrl: "http://rj-firebat.tail1234.ts.net:7471/", controlNodeId: "nBench1CNTRL" },
  };
  const written = files(run(["--node", "rj-firebat"], old, nodeTailnet));
  assert.equal(written.get(paths.controlPlane)!.state, "new");
  assert.deepEqual(value(written, paths.controlPlane), { tailnetNodeId: "nBench1CNTRL", url: "http://rj-firebat.tail1234.ts.net:7471/" }, "the URL the person set carries over");
  assert.equal(value(written, paths.probe).auth.controlPlane, "nBench1CNTRL", "a rollback still finds what it reads");
  assert.equal(value(written, paths.deployer).controlUrl, "http://rj-firebat.tail1234.ts.net:7471/");
  assert.deepEqual([...written.keys()], [paths.controlPlane, paths.probe, paths.deployer]);
  assert.equal(files(run(["--node", "rj-firebat"], onDisk(written), nodeTailnet)).get(paths.controlPlane)!.state, "unchanged");
});

test("a rerun over an install whose probe.json and deployer.json name different control planes refuses and writes nothing", () => {
  for (const args of [["--node", "rj-firebat"], ["--dotfiles", dotfiles]]) {
    const net = args[0] === "--node" ? nodeTailnet : tailnet;
    const { controlPlane: _, ...first } = onDisk(files(run(args, fresh, net)));
    const self = args[0] === "--node" ? "nBench1CNTRL" : "nSelf1CNTRL";
    const old: Existing = {
      ...first,
      probe: { ...(first.probe as Record<string, any>), auth: { controlPlane: self, peers: [] } },
      deployer: { ...(first.deployer as Record<string, Json>), controlUrl: "http://100.64.0.9:7470/", controlNodeId: "nOther1CNTRL" },
    };
    const result = run(args, old, net);
    assert.equal(result.ok, false, "no file is written");
    assert.match(result.ok ? "" : result.errors.join("\n"), /auth\.controlPlane "n\w+" and deployer\.json's controlNodeId "nOther1CNTRL" name different control planes/);
  }
});

test("a rerun over an install whose probe.json alone names the control plane carries it over", () => {
  const { controlPlane: _, deployer: __, ...first } = onDisk(files(run(["--node", "rj-firebat"], fresh, nodeTailnet)));
  const old: Existing = { ...first, probe: { ...(first.probe as Record<string, any>), auth: { controlPlane: "nBench1CNTRL", peers: [] } } };
  assert.deepEqual(value(files(run(["--node", "rj-firebat"], old, nodeTailnet)), paths.controlPlane), { tailnetNodeId: "nBench1CNTRL", url: "http://rj-firebat.tail1234.ts.net:7470/" });
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
  assert.doesNotMatch(text, /kept the existing deployer token/, "a token this run added is not also kept");
  assert.doesNotMatch(text, /c{64}/);
});

test("a fresh node install points its probe and deployer at the control machine and writes no control.json", () => {
  const written = files(run(["--node", "rj-firebat"], fresh, tailnetDevices(parseTailscaleStatus(status.replaceAll("rj-firebat", "x-self").replaceAll("infra-testbench", "rj-firebat")))));
  assert.equal(written.has(paths.control), false);
  const probe = parseProbeConfig(JSON.stringify(value(written, paths.probe)));
  assert.equal(probe.node, "x-self");
  assert.deepEqual(probe.auth, { peers: ["nBench1CNTRL"] });
  assert.deepEqual(value(written, paths.controlPlane), { tailnetNodeId: "nBench1CNTRL", url: "http://rj-firebat.tail1234.ts.net:7470/" });
  assert.deepEqual(value(written, paths.deployer), { token, drainTimeoutMs: 300000, healthTimeoutMs: 60000 });
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
  assert.equal(value(written, paths.controlPlane).url, "http://100.64.0.2:7471/", "the node follows the control plane's port");
  assert.equal((merged.deployKeys as Record<string, string>).nSelf1CNTRL, sha256("d".repeat(64)), "the digest follows the token on disk");
  assert.deepEqual([...written.values()].map((f) => f.state), ["updated", "updated", "unchanged", "unchanged"]);
  const text = report(result.ok ? result.files : []);
  assert.match(text, /^updated \/etc\/nexus\/control\.json$/m);
  assert.match(text, /added callers "nMac1CNTRL"/);
  assert.match(text, /left listen\.port alone: it is 7471, and this run would write 7470/);
  assert.match(text, /left dotfiles\.repo alone/);
  assert.match(text, /replaced url "http:\/\/100\.64\.0\.2:7470\/" with "http:\/\/100\.64\.0\.2:7471\/"/);
  assert.match(text, /kept the existing deployer token/);
  assert.match(text, new RegExp(`replaced deployKeys\\.nSelf1CNTRL "${sha256(token)}" with "${sha256("d".repeat(64))}"`));
  assert.doesNotMatch(text, /d{64}|c{64}/, "the report never shows a token");

  const again = files(run([], onDisk(written)));
  assert.deepEqual([...again.values()].map((f) => f.state), ["unchanged", "unchanged", "unchanged", "unchanged"]);
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
  assert.deepEqual([...again.values()].map((f) => f.state), ["unchanged", "unchanged", "unchanged", "unchanged"]);
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
  assert.match(errors(run(["--join", "token", "--dotfiles", dotfiles])).join("\n"), /--join needs --node <the control plane's tailnet name>/);
  const nodeProbe: Existing = { gitKey: false, probe: { auth: { controlPlane: "nBench1CNTRL", peers: [] } } };
  assert.match(errors(run(["--dotfiles", dotfiles], nodeProbe)).join("\n"), /already a node of the control plane infra-testbench\. Pass --node infra-testbench/);
  const nodeControlPlane: Existing = { gitKey: false, controlPlane: { tailnetNodeId: "nBench1CNTRL", url: "http://infra-testbench.tail1234.ts.net:7470/" } };
  assert.match(errors(run(["--dotfiles", dotfiles], nodeControlPlane)).join("\n"), /already a node of the control plane infra-testbench/);
});

test("control-only flags and this machine as --node are refused for a node install", () => {
  const found = errors(run(["--node", "rj-firebat", "--admit", "ramtins-macbook-pro", "--add-node", `infra-testbench=${"b".repeat(64)}`, "--dotfiles", dotfiles]));
  assert.equal(found.length, 4);
  assert.match(found.join("\n"), /--node rj-firebat: that is this machine/);
  assert.match(found.join("\n"), /--admit is for the control machine/);
  assert.match(found.join("\n"), /--add-node is for the control machine/);
  assert.match(found.join("\n"), /--dotfiles is for the control machine/);
});

test("--admit takes the tailnet node ID that nexus connect prints, as well as a name", () => {
  const written = files(run(["--admit", "nMac1CNTRL", "--dotfiles", dotfiles]));
  assert.deepEqual(parseConfig(JSON.stringify(value(written, paths.control))).callers, ["nMac1CNTRL"]);
});

test("--github-watch names the control plane's token file in the control.json on disk, keeps whatever else is there, and never replaces one it names", () => {
  const first = onDisk(files(run(["--dotfiles", dotfiles])));
  const admitted = { ...first, control: { ...(first.control as Record<string, Json>), callers: ["nMac1CNTRL"] } };
  const written = files(run(["--github-watch"], admitted));
  const control = parseConfig(JSON.stringify(value(written, paths.control)));
  assert.deepEqual(control.github, { tokenFile: "/etc/nexus/github-token" });
  assert.deepEqual(control.callers, ["nMac1CNTRL"], "a caller another run admitted meanwhile stays");
  const named = { ...first, control: { ...(first.control as Record<string, Json>), github: { tokenFile: "/srv/token" } } };
  assert.deepEqual(value(files(run(["--github-watch"], named)), paths.control).github, { tokenFile: "/srv/token" });
  assert.match(errors(run(["--node", "rj-firebat", "--github-watch"])).join("\n"), /--github-watch is for the control machine/);
});

test("a name two devices share is ambiguous, and the full MagicDNS name picks one", () => {
  const shared = tailnetDevices(parseTailscaleStatus(JSON.stringify({
    ...JSON.parse(status),
    Peer: { ...JSON.parse(status).Peer, "nodekey:ccc": { ID: "nOther1CNTRL", DNSName: "infra-testbench.other.ts.net.", TailscaleIPs: ["100.64.0.9"] } },
  })));
  assert.match(errors(run(["--peer", "Infra-Testbench", "--dotfiles", dotfiles], fresh, shared)).join("\n"), /more than one device has that name: infra-testbench\.tail1234\.ts\.net, infra-testbench\.other\.ts\.net/);
  const written = files(run(["--peer", "infra-testbench.other.ts.net", "--dotfiles", dotfiles], fresh, shared));
  assert.deepEqual(value(written, paths.probe).auth.peers, ["nOther1CNTRL"]);
});

const freshControl: Facts = {
  self: tailnet.self, secretNames: [], gitKey: false,
  role: "control", signedIn: false, admitted: false, docker: { kind: "missing" }, dockerGroup: false, image: false,
};

test("a fresh control machine is left every step: setup, then the agents' credentials, then the first image", () => {
  const items = left(freshControl);
  const runs = items.map((item) => item.run);
  assert.deepEqual(items.map((item) => item.stage), ["setup", "setup", "setup", "setup", "credentials", "image"]);
  const credentials = items.find((item) => item.stage === "credentials")!;
  assert.deepEqual(credentials.run, ["sudo deploy/install.sh"]);
  for (const missing of [/the harness's login, with ChatGPT or an OpenAI API key/, /a Claude token, which `claude setup-token` prints/, /a GitHub token, fine-grained for all repositories with Administration and Contents read and write/, /a git SSH key/]) {
    assert.match(credentials.say, missing);
  }
  const all = runs.flat().join("\n");
  assert.match(all, /--admit <your Mac's tailnet name>/);
  assert.doesNotMatch(all, /secrets\.env|ssh-keygen|login\.ts/, "nothing left is a credential file to edit by hand");
  assert.match(all, /usermod --append --groups docker nexus/);
  assert.match(all, /nexus image rollout <image ID it printed> --wait/);
  const cli = runs.findIndex((run) => run.includes("deploy/mac/install"));
  assert.deepEqual(runs[cli], ["deploy/mac/install", "nexus connect rj-firebat.tail1234.ts.net"]);
  assert.ok(runs.every((run, i) => i > cli || !run.some((command) => command.startsWith("nexus image"))), "no nexus command before the CLI is set up");
  assert.ok(runs.findIndex((run) => run.some((command) => command.startsWith("nexus image"))) > cli);
});

test("the credentials item names only what is missing, and an Anthropic API key counts as the Claude token", () => {
  const say = (facts: Partial<Facts>) => left({ ...freshControl, ...facts } as Facts).find((item) => item.stage === "credentials")?.say ?? "";
  const partly = say({ signedIn: true, secretNames: ["ANTHROPIC_API_KEY"], gitKey: true });
  assert.match(partly, /a GitHub token/);
  assert.doesNotMatch(partly, /harness|Claude|SSH/);
  assert.equal(say({ signedIn: true, secretNames: ["ANTHROPIC_API_KEY", "GH_TOKEN"], gitKey: true }), "");
});

test("a host without Docker is told to install Docker with buildx and start it, before joining its group", () => {
  const commands = left(freshControl).flatMap((item) => item.run);
  const install = commands.indexOf("curl -fsSL https://get.docker.com | sudo sh");
  assert.ok(install >= 0);
  assert.equal(commands[install + 1], "sudo systemctl enable --now docker");
  assert.ok(commands.findIndex((command) => command.includes("usermod --append --groups docker nexus")) > install);
  const ready = left({ ...freshControl, docker: { kind: "ready" } }).flatMap((item) => item.run);
  assert.ok(!ready.some((command) => /get\.docker\.com|buildx/.test(command)));
});

test("a Docker without buildx is told the buildx package of its own package manager and source", () => {
  const cases = [
    ["apt", "docker", "sudo apt-get install -y docker-buildx-plugin"],
    ["apt", "distribution", "sudo apt-get install -y docker-buildx"],
    ["dnf", "docker", "sudo dnf install -y docker-buildx-plugin"],
    ["dnf", "distribution", "sudo dnf install -y docker-buildx"],
  ] as const;
  for (const [manager, from, command] of cases) {
    const commands: readonly string[] = left({ ...freshControl, docker: { kind: "no-buildx", manager, from } }).flatMap((item) => item.run);
    assert.ok(commands.includes(command), `${manager} ${from}`);
    assert.ok(!commands.some((c) => c.includes("get.docker.com") || (c.includes("buildx") && c !== command)), `${manager} ${from} gets one buildx command`);
  }
  const other = left({ ...freshControl, docker: { kind: "no-buildx", manager: "other", from: "distribution" } });
  const item = other.find((i) => i.say.includes("buildx plugin"))!;
  assert.deepEqual(item.run, []);
  assert.match(item.say, /https:\/\/docs\.docker\.com\/go\/buildx\//);
});

test("the credentials are printed under their own heading as the next step, and the image after them", () => {
  const text = formatLeft(left(freshControl));
  assert.match(text, /^What is left:\n1\. /);
  assert.match(text, /\n\nNext, give the agents their credentials, on this machine:\n5\. Rerun the installer in a terminal/);
  assert.match(text, /\n\nThen, with the control plane running:\n6\. Build the first pylon image/);
  assert.doesNotMatch(formatLeft(left({ ...freshControl, secretNames: ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"], gitKey: true, signedIn: true })), /credentials/);
});

test("a finished control machine is left only the Mac CLI", () => {
  const items = left({ ...freshControl, secretNames: ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"], gitKey: true, signedIn: true, admitted: true, docker: { kind: "ready" }, dockerGroup: true, image: true });
  assert.equal(items.length, 1);
  assert.deepEqual(items[0]!.run, ["deploy/mac/install", "nexus connect rj-firebat.tail1234.ts.net"]);
});

test("a node is told how to join the control plane, unless this run joined it", () => {
  const control = tailnet.peers.find((p) => p.name === "infra-testbench")!;
  const items = left({ self: tailnet.self, secretNames: ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"], gitKey: false, role: "node", control, joined: false });
  const all = items.flatMap((i) => i.run).join("\n");
  assert.match(all, /^sudo deploy\/install\.sh --join-token$/m);
  assert.match(all, /^sudo deploy\/install\.sh --join <token> --node infra-testbench$/m);
  assert.doesNotMatch(all, /--add-node|--peer/, "no digest to paste and no other node to rerun");
  assert.match(all, /^sudo deploy\/install\.sh --node infra-testbench$/m, "the git key is made by a rerun of the node install");
  assert.match(all, /^nexus connect infra-testbench\.tail1234\.ts\.net$/m, "the Mac connects to the control plane, not to this node");
  assert.equal(formatLeft(items).split("\n")[0], "What is left:");
  const joined = left({ self: tailnet.self, secretNames: [], gitKey: true, role: "node", control, joined: true }).flatMap((i) => i.run).join("\n");
  assert.doesNotMatch(joined, /--join/);
});

test("a store holds an image only once an image ID is in it, not a crashed fill's partial", async () => {
  const store = await mkdtemp(join(tmpdir(), "nexus-store-"));
  assert.equal(await holdsImage(join(store, "missing")), false);
  assert.equal(await holdsImage(store), false);
  await mkdir(join(store, "img-0123456789ab.partial"));
  await mkdir(join(store, "tpl-0123456789ab"));
  assert.equal(await holdsImage(store), false);
  await mkdir(join(store, "img-0123456789ab"));
  assert.equal(await holdsImage(store), true);
});

const repo = resolve(import.meta.dirname, "../..");

/**
 * Runs install with stand-ins for what it runs, each recorded as it ran. The credentials step adds `next` to the
 * follow-ups. `refuse` names the step that fails: a config write with exit code 2, the join, or the credentials.
 */
async function installing(args: readonly string[], next: readonly FollowUp[] = [], refuse?: "write" | "join" | "credentials"): Promise<{ code: number | Error; ran: string[]; said: string[] }> {
  const ran: string[] = [];
  const said: string[] = [];
  const steps: InstallSteps = {
    async run(program, rest) {
      ran.push([program, ...rest].join(" ").replace(process.execPath, "node").replaceAll(repo, "."));
      return refuse === "write" && rest.includes("write") ? 2 : 0;
    },
    async join(token) {
      ran.push(`join ${token}`);
      if (refuse === "join") throw new Error("the control plane at http://100.64.0.2:7470/ did not take the join: the token is spent");
    },
    async credentials(found) {
      ran.push("credentials");
      for (const step of next) found.add(step);
      if (refuse === "credentials") throw new Error("NEXUS_GH_TOKEN: a GitHub token is letters, digits and underscores");
    },
    async left() {
      ran.push("left");
    },
  };
  const { error, log } = console;
  console.error = (line: string) => said.push(line);
  console.log = () => {};
  try {
    return { code: await install(parseFlags(["install", ...args]).flags, args, steps).catch((err: Error) => err), ran, said };
  } finally {
    Object.assign(console, { error, log });
  }
}
const lockDir = "install -d -o root -g root -m 0700 /opt/nexus/deployer";
const write = (args: string) => `flock -x /opt/nexus/deployer/lock node ./src/deploy/setup.ts write ${args}`;

test("install writes the configs under the deployer's lock, runs each role's installer, gives the agents their credentials, then says what is left", async () => {
  const args = ["--admit", "macbook", "--dotfiles", dotfiles];
  assert.deepEqual(await installing(args), {
    code: 0, said: [],
    ran: [lockDir, write(args.join(" ")), "bash ./deploy/install-control.sh", "bash ./deploy/install-probe.sh", "bash ./deploy/install-deployer.sh control probe", "credentials", "left"],
  });
  assert.deepEqual((await installing(["--node", "firebat", "--non-interactive"])).ran, [
    lockDir, write("--node firebat --non-interactive"), "bash ./deploy/install-probe.sh", "bash ./deploy/install-deployer.sh probe", "credentials", "left",
  ]);
});

test("after the credentials, a new git key rewrites the configs and reinstalls the probe, a new secret restarts the probe if it runs, and a signed-in harness installs the control plane again", async () => {
  const after = async (next: readonly FollowUp[]) => {
    const { code, ran } = await installing(["--dotfiles", dotfiles], next);
    assert.equal(code, 0);
    return ran.slice(ran.indexOf("credentials") + 1, -1);
  };
  assert.deepEqual(await after(["config", "probe", "control"]), [lockDir, write(`--dotfiles ${dotfiles}`), "bash ./deploy/install-probe.sh", "bash ./deploy/install-control.sh"]);
  assert.deepEqual(await after(["watch", "probe", "control"]), [
    lockDir, write(`--github-watch --dotfiles ${dotfiles}`), "systemctl try-restart nexus-probe.service", "bash ./deploy/install-control.sh",
  ], "control.json gains github.tokenFile under the deployer's lock, from the file as it is then");
  assert.deepEqual(await after(["config", "watch"]), [lockDir, write(`--github-watch --dotfiles ${dotfiles}`), "bash ./deploy/install-probe.sh"], "one config write does both");
  assert.deepEqual(await after(["probe"]), ["systemctl try-restart nexus-probe.service"]);
  assert.deepEqual(await after([]), [], "a run that changed no credential restarts nothing");
});

test("a failed credentials step still restarts what its writes need, then stops before it says what is left", async () => {
  const { code, ran, said } = await installing(["--node", "firebat"], ["probe"], "credentials");
  assert.match(String(code), /the credentials step failed, after the restarts its writes needed/);
  assert.equal(ran.at(-1), "systemctl try-restart nexus-probe.service");
  assert.deepEqual(said, ["install: NEXUS_GH_TOKEN: a GitHub token is letters, digits and underscores"]);
});

test("a join runs after the role installers and before the credentials, and a refused one stops the run", async () => {
  const args = ["--join", "tok3n", "--node", "firebat"];
  assert.deepEqual((await installing(args)).ran, [
    lockDir, write(args.join(" ")), "bash ./deploy/install-probe.sh", "bash ./deploy/install-deployer.sh probe", "join tok3n", "credentials", "left",
  ]);
  const refused = await installing(args, [], "join");
  assert.match(String(refused.code), /the configs are written and the probe runs, but the control plane did not take the join/);
  assert.deepEqual(refused.said, ["install: the control plane at http://100.64.0.2:7470/ did not take the join: the token is spent"]);
  assert.ok(!refused.ran.includes("credentials"), refused.ran.join("\n"));
});

test("a config write that refuses, such as --join without --node, stops install before anything else runs, with its exit code", async () => {
  assert.match(errors(run(["--join", "tok3n", "--dotfiles", dotfiles])).join("\n"), /--join needs --node/);
  assert.deepEqual(await installing(["--join", "tok3n"], [], "write"), { code: 2, said: [], ran: [lockDir, write("--join tok3n")] });
});

test("install.sh names the package manager it found, and parseFlags refuses one it does not know", () => {
  assert.equal(parseFlags(["install", "--package-manager", "dnf"]).flags.packageManager, "dnf");
  assert.throws(() => parseFlags(["install", "--package-manager", "pacman"]), /--package-manager pacman: give apt, dnf, other/);
});

test("the watch's config write names --github-watch where parseFlags reads it, even after arguments that end with --", async () => {
  const { ran } = await installing(["--dotfiles", dotfiles, "--"], ["watch"]);
  const rewrite = ran.filter((line) => line.includes(" write ")).at(-1)!;
  assert.equal(parseFlags(rewrite.slice(rewrite.indexOf(" write ") + 1).split(" ")).flags.githubWatch, true, rewrite);
});
