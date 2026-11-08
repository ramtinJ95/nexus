import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import * as layout from "./node-layout.ts";
import { backupStatusFile, configFiles, controlPath, deployerFiles, deployerLink, deployerWakeFile, etc, ports, prefix, releasesDir, roleLinks, servicePath, stateDirs, unitDir, unitNames, users } from "./node-layout.ts";
import { defaultPreviewPorts, parseConfig } from "./control/main.ts";
import { probePort } from "./protocol/routes.ts";
import { stores } from "./deploy/credentials.ts";
import { parseFlags, setup } from "./deploy/setup.ts";
import { backupBudgetMs, drainYieldMs } from "./deploy/worker.ts";
import { shutdownPauseMs } from "./probe/shutdown.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const seconds = (text: string, key: string) => {
  const [, value, unit] = new RegExp(`^${key}=(\\d+)(min|s)?$`, "m").exec(text) ?? assert.fail(`${key} is set`);
  return Number(value) * (unit === "min" ? 60 : 1);
};

test("each layout constant is the literal it replaced", () => {
  const values = Object.fromEntries(Object.entries(layout).filter(([, value]) => typeof value !== "function"));
  assert.deepEqual(values, {
    prefix: "/opt/nexus",
    etc: "/etc/nexus",
    unitDir: "/etc/systemd/system",
    users: { probe: "nexus", control: "nexus-control" },
    stateDirs: { probe: "/var/lib/nexus", control: "/var/lib/nexus-control", backup: "/var/lib/nexus-backup" },
    configFiles: {
      control: "/etc/nexus/control.json",
      controlPlane: "/etc/nexus/control-plane.json",
      probe: "/etc/nexus/probe.json",
      deployer: "/etc/nexus/deployer.json",
      secrets: "/etc/nexus/secrets.env",
      githubToken: "/etc/nexus/github-token",
      gitKey: "/etc/nexus/git_ed25519",
      gitKnownHosts: "/etc/nexus/git_known_hosts",
    },
    servicePath: "/usr/local/bin:/usr/bin",
    rootPath: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    unitNames: {
      probe: "nexus-probe.service",
      control: "nexus-control.service",
      backup: "nexus-backup.service",
      backupTimer: "nexus-backup.timer",
      deployer: "nexus-deployer.service",
      deployerTimer: "nexus-deployer.timer",
      deployerPath: "nexus-deployer.path",
    },
    ports: { control: 7470, dashboard: 7443, probe: 7480, gateway: 7481 },
    links: { current: "the probe", "control-current": "the control plane", "deployer-current": "the deployer's worker" },
    roleLinks: { probe: "current", control: "control-current" },
    deployerLink: "deployer-current",
    releasesDir: "releases",
    deployerFiles: { lock: "deployer/lock", roles: "deployer/roles", repo: "deployer/repo", rejected: "deployer/rejected", releaseBytes: "deployer/release-bytes.json" },
    deployerWakeFile: "/var/lib/nexus/deployer-wake",
    backupStatusFile: "/var/lib/nexus-backup/status.json",
    releaseName: /^(?:[0-9a-f]{12}|[0-9a-f]{40})$/,
  });
  assert.equal(layout.deployJournal("control"), "control-deploy.json");
  assert.equal(controlPath("registry.db"), "/var/lib/nexus-control/registry.db");
  assert.equal(controlPath("/srv/registry.db"), "/srv/registry.db");
  assert.equal(layout.releaseCommitFile("/opt/nexus/releases/x"), "/opt/nexus/releases/x/release-commit");
  assert.deepEqual(stores, {
    harness: { machines: "control", file: "/var/lib/nexus-control/harness-credentials.json", owner: "nexus-control:nexus-control", mode: 0o600 },
    claude: { machines: "every", file: "/etc/nexus/secrets.env", owner: "root:nexus", mode: 0o640 },
    githubWatch: { machines: "control", file: "/etc/nexus/github-token", owner: "root:nexus-control", mode: 0o640 },
    gitKey: { machines: "every", file: "/etc/nexus/git_ed25519", owner: "nexus:nexus", mode: 0o400 },
  });
});

test("release.sh and the role installers name the layout's prefix, releases, release names, state, users, links and lock", () => {
  const release = read("deploy/release.sh");
  for (const line of [
    `prefix=${prefix}`, `etc=${etc}`, `service_path=${servicePath}`,
    `make_state ${users.control} ${stateDirs.control}`, `make_state ${users.probe} ${stateDirs.probe} pylons artifacts`,
    `exec 9>"$prefix/${deployerFiles.lock}"`, `flock -x "$prefix/${deployerFiles.lock}" "$@"`,
    `install -d -o root -g root -m 0755 "$prefix" "$prefix/${releasesDir}"`, `mv "$staging" "$prefix/${releasesDir}/$release"`,
    "| sha256sum | cut -c1-12)", '[[ "$NEXUS_COMMIT" =~ ^[0-9a-f]{40}$ ]]',
    `install -o root -g ${stores.claude.owner.split(":")[1]} -m 0${stores.claude.mode.toString(8)} "$1/deploy/secrets.example.env" "$etc/secrets.env"`,
  ]) assert.ok(release.includes(line), line);
  assert.ok(stores.claude.file === `${etc}/secrets.env` && stores.claude.owner.startsWith("root:"));
  assert.ok(layout.releaseName.test("a".repeat(12)) && layout.releaseName.test("a".repeat(40)) && !layout.releaseName.test("a".repeat(13)), "release.sh's two name shapes");
  assert.match(read("deploy/install-probe.sh"), new RegExp(`^link_release "\\$prefix/${roleLinks.probe}"$`, "m"));
  assert.match(read("deploy/install-control.sh"), new RegExp(`^link_release "\\$prefix/${roleLinks.control}"$`, "m"));
  const installDeployer = read("deploy/install-deployer.sh");
  assert.ok(installDeployer.includes(`touch "$prefix/${deployerFiles.roles}/$role"`));
  assert.ok(installDeployer.includes(`[ -e ${configFiles.deployer} ]`));
});

test("supervise-deployer.sh, which runs alone, names the layout's prefix, lock, link and rejected file", () => {
  const supervise = read("deploy/supervise-deployer.sh");
  for (const line of [
    `prefix=${prefix}`, `exec 9>"$prefix/${deployerFiles.lock}"`, `worker="$prefix/${deployerLink}/src/deploy/worker.ts"`,
    `readlink "$prefix/${deployerLink}" > "$prefix/${deployerFiles.rejected}"`, `rm -f "$prefix/${deployerLink}"`,
  ]) assert.ok(supervise.includes(line), line);
});

test("the units run the layout's users, state, PATH, links and configs, and the deployer.path watches its wake file", () => {
  const probe = read(`deploy/${unitNames.probe}`);
  for (const line of [`User=${users.probe}`, `WorkingDirectory=${stateDirs.probe}`, `Environment=PATH=${servicePath}`, `ExecStart=/usr/bin/env node ${prefix}/${roleLinks.probe}/src/probe/main.ts ${configFiles.probe}`]) {
    assert.match(probe, new RegExp(`^${RegExp.escape(line)}$`, "m"), line);
  }
  const control = read(`deploy/${unitNames.control}`);
  for (const line of [`User=${users.control}`, `WorkingDirectory=${stateDirs.control}`, `ReadWritePaths=${stateDirs.control}`, `Environment=PATH=${servicePath}`, `ExecStart=/usr/bin/env node ${prefix}/${roleLinks.control}/src/control/main.ts ${configFiles.control}`]) {
    assert.match(control, new RegExp(`^${RegExp.escape(line)}$`, "m"), line);
  }
  assert.match(read(`deploy/${unitNames.backup}`), new RegExp(`^ExecStart=/usr/bin/env node ${RegExp.escape(`${prefix}/${roleLinks.control}/src/control/backup.ts`)} backup ${RegExp.escape(configFiles.control)}$`, "m"));
  assert.match(read("deploy/nexus-deployer.path"), new RegExp(`^PathChanged=${RegExp.escape(deployerWakeFile)}$`, "m"));
  assert.ok(backupStatusFile.startsWith(`${stateDirs.backup}/`));
});

test("the deployer's and the probe's own deadlines fit inside the timeouts their scripts and units give them", () => {
  const supervise = read("deploy/supervise-deployer.sh");
  const [, kill, worker] = (/timeout --kill-after=(\d+)s (\d+)s/.exec(supervise) ?? assert.fail("the supervisor bounds the worker")).map(Number) as [number, number, number];
  assert.equal(worker, 900);
  assert.ok(backupBudgetMs < worker * 1000 && drainYieldMs < worker * 1000, "a backup or a drain wait yields before the supervisor's timeout");
  assert.ok(2 * (worker + kill) <= seconds(read("deploy/nexus-deployer.service"), "TimeoutStartSec"), "the unit outlasts a failed worker and the bootstrap after it");
  assert.ok(shutdownPauseMs / 1000 + 30 <= seconds(read(`deploy/${unitNames.probe}`), "TimeoutStopSec"), "the probe's stop timeout leaves 30 s for the close after the pauses");
});

test("unitNames names every unit file in deploy/", () => {
  const files = readdirSync(new URL("../deploy/", import.meta.url)).filter((name) => /\.(service|timer|path)$/.test(name));
  assert.deepEqual([...Object.values(unitNames)].sort(), files.sort());
});

test("the example configs and the probe protocol use the layout's ports, and the default preview ports stay clear of them", () => {
  const control = JSON.parse(read("deploy/control.example.json")) as { listen: { port: number } };
  const probe = JSON.parse(read("deploy/probe.example.json")) as { listen: { port: number }; previews: { gatewayPort: number } };
  assert.equal(control.listen.port, ports.control);
  assert.equal(ports.probe, probePort, "src/protocol may not import the layout, so routes.ts keeps its own copy");
  assert.equal(probe.listen.port, ports.probe);
  assert.equal(probe.previews.gatewayPort, ports.gateway);
  for (const port of Object.values(ports)) assert.ok(port < defaultPreviewPorts.first || port > defaultPreviewPorts.last, `${port} is outside the preview range`);
});

test("control.json's db is opened from the control plane's working directory", () => {
  const example = JSON.parse(read("deploy/control.example.json")) as Record<string, unknown>;
  assert.equal(parseConfig(JSON.stringify({ ...example, db: "registry.db" })).db, `${stateDirs.control}/registry.db`);
  assert.equal(parseConfig(JSON.stringify(example)).db, "/var/lib/nexus-control/registry.db");
  assert.equal(parseConfig(JSON.stringify({ ...example, db: "/srv/nexus/registry.db" })).db, "/srv/nexus/registry.db");
});

test("the backup and the deployer units run as root, and the deployer's worker finds Node where the units do", () => {
  const backup = read(`deploy/${unitNames.backup}`);
  const deployer = read(`deploy/${unitNames.deployer}`);
  for (const unit of [backup, deployer]) for (const line of ["User=root", "Group=root"]) assert.match(unit, new RegExp(`^${line}$`, "m"), line);
  assert.match(backup, new RegExp(`^Environment=PATH=${RegExp.escape(servicePath)}$`, "m"));
  const [, supervisor] = /^ExecStart=(\S+)$/m.exec(deployer) ?? assert.fail("the deployer unit runs one script");
  assert.ok(read("deploy/install-deployer.sh").includes(`install -o root -g root -m 0700 "$repo/deploy/supervise-deployer.sh" "${supervisor!.replace(prefix, "$prefix")}"`), `install-deployer.sh installs the supervisor at ${supervisor}`);
  const [, unitPath] = /^Environment=PATH=(\S+)$/m.exec(deployer) ?? assert.fail("the deployer unit sets PATH");
  const [, workerPath] = /\/usr\/bin\/env -i PATH=(\S+) node "\$1"/.exec(read("deploy/supervise-deployer.sh")) ?? assert.fail("the supervisor sets the worker's PATH");
  assert.equal(workerPath, unitPath);
  assert.ok(workerPath!.startsWith(`${servicePath}:`), "the worker searches the units' PATH first, so it runs the same Node");
});

test("the units' groups, the probe's kvm and tailscale operator rights, and tailscaled's cert permit name the layout's users", () => {
  for (const [role, user] of Object.entries(users)) {
    const unit = read(`deploy/${unitNames[role as keyof typeof users]}`);
    assert.match(unit, new RegExp(`^Group=${user}$`, "m"), `${role} runs in its own group`);
  }
  assert.match(read(`deploy/${unitNames.probe}`), /^SupplementaryGroups=kvm$/m);
  const release = read("deploy/release.sh");
  for (const line of [`usermod --append --groups kvm ${users.probe}`, `tailscale set --operator=${users.probe}`]) assert.match(release, new RegExp(`^\\s*${RegExp.escape(line)}$`, "m"), line);
  assert.ok(read("deploy/install.sh").includes(`grep -qx 'TS_PERMIT_CERT_UID=${users.control}'`), "the control plane's user fetches the dashboard's certificate");
});

test("the installers install each unit file under its own name in the layout's unit directory", () => {
  const release = read("deploy/release.sh");
  for (const line of [`local source=$1 unit=${unitDir}/$2`, `sha256sum < "${unitDir}/$unit"`, `"${releasesDir}/$release"`]) assert.ok(release.includes(line), line);
  const installed = ["deploy/release.sh", "deploy/install-deployer.sh"].flatMap((file) => [...read(file).matchAll(/^\s*install_unit "\$\w+\/deploy\/([\w.-]+)" ([\w.-]+)$/gm)]);
  for (const [line, source, unit] of installed) assert.equal(source, unit, line);
  assert.deepEqual(installed.map(([, , unit]) => unit).sort(), [...Object.values(unitNames)].sort());
  const started = ["deploy/install-probe.sh", "deploy/install-control.sh"].flatMap((file) => [...read(file).matchAll(/^\s*start_unit ([\w.-]+) /gm)].map(([, unit]) => unit));
  assert.deepEqual(started, [unitNames.probe, unitNames.control]);
});

test("the example configs name the state and secrets paths setup.ts writes on a fresh node", () => {
  const tailnet = { self: { id: "nSelf1CNTRL", name: "rj-firebat", host: "rj-firebat.example.ts.net", ip: "100.64.0.2" }, peers: [] };
  const result = setup(tailnet, parseFlags(["write", "--dotfiles", "https://github.com/example/dotfiles.git"]).flags, { gitKey: false }, "c".repeat(64));
  assert.ok(result.ok, result.ok ? "" : result.errors.join("; "));
  const written = (path: string) => result.files.find((file) => file.path === path)?.value as Record<string, Record<string, unknown>>;
  const control = written(configFiles.control);
  const probe = written(configFiles.probe);
  const controlExample = JSON.parse(read("deploy/control.example.json")) as typeof control;
  const probeExample = JSON.parse(read("deploy/probe.example.json")) as typeof probe;
  assert.equal(controlExample["db"], control["db"]);
  assert.deepEqual([controlExample["harness"]!["storage"], controlExample["harness"]!["credentials"]], [control["harness"]!["storage"], control["harness"]!["credentials"]]);
  assert.deepEqual([probeExample["backend"]!["stateRoot"], probeExample["backend"]!["artifacts"]], [probe["backend"]!["stateRoot"], probe["backend"]!["artifacts"]]);
  assert.equal(probeExample["secretsFile"], probe["secretsFile"]);
  assert.deepEqual([probe["backend"]!["stateRoot"], probe["backend"]!["artifacts"]], [`${stateDirs.probe}/pylons`, `${stateDirs.probe}/artifacts`], "release.sh makes these as the probe's user");
});
