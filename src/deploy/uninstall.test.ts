import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { backupRoot } from "../control/backup.ts";
import { etc, ports, prefix, stateDirs, unitDir, unitNames, users } from "../node-base/node-layout.ts";

const repo = resolve(import.meta.dirname, "../..");
const gateway = `http://127.0.0.1:${ports.gateway}`;

/**
 * A machine with every part of an install under `root`, and shims for the commands that read or change what lives
 * outside the file system: systemd, the users and groups, the pylons' controllers and tailscaled. Each shim keeps its
 * state in a file under `state` and logs each change it makes to `log`.
 */
async function machine(t: TestContext, { controllers = [] as number[], booting = [] as number[], hiddenFor = 0, stopWait = 180, lateEntry = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-uninstall-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "root");
  const state = join(dir, "state");
  const shims = join(dir, "bin");
  const log = join(dir, "log");
  const at = (path: string) => join(root, path);
  const files = [
    ...Object.values(unitNames).map((unit) => join(unitDir, unit)),
    join(unitDir, "tailscaled.service.d", "nexus-cert.conf"),
    join(prefix, "releases", "a".repeat(12), "package.json"),
    join(prefix, "deployer", "lock"),
    join(etc, "control.json"),
    join(stateDirs.probe, "pylons", "instances", "pyl-1", "disk.qcow2"),
    join(stateDirs.control, "registry.db"),
    join(stateDirs.backup, "status.json"),
    join(backupRoot, "2026-11-01T00-23-41Z", "manifest.json"),
  ];
  for (const file of files) {
    await mkdir(dirname(at(file)), { recursive: true });
    await writeFile(at(file), "x");
  }
  await writeFile(at(join(etc, "probe.json")), JSON.stringify({ previews: { gatewayPort: ports.gateway } }));
  await mkdir(state);
  await writeFile(join(state, "users"), `${users.probe}\n${users.control}\n`);
  await writeFile(join(state, "groups"), `${users.probe}\n${users.control}\n`);
  await writeFile(join(state, "controllers"), [...controllers, ...booting].map((pid) => `${pid}\n`).join(""));
  await writeFile(join(state, "pgrep-calls"), "");
  for (const pid of controllers) {
    await mkdir(join(state, "instances", String(pid)), { recursive: true });
    await writeFile(join(state, "instances", String(pid), "control.sock"), "");
  }
  await writeFile(join(state, "prefs.json"), JSON.stringify({ OperatorUser: users.probe }));
  await writeFile(join(state, "serve.json"), JSON.stringify({
    TCP: { 443: { HTTPS: true }, 3001: { HTTPS: true }, 8443: { HTTPS: true } },
    Web: {
      "firebat.tail1234.ts.net:443": { Handlers: { "/": { Proxy: gateway } } },
      "firebat.tail1234.ts.net:3001": { Handlers: { "/": { Proxy: gateway } } },
      "firebat.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
    },
  }));

  await mkdir(shims);
  const shim = async (name: string, body: string) => {
    await writeFile(join(shims, name), `#!/bin/sh\nstate="${state}"\nlog="${log}"\n${body}\n`);
    await chmod(join(shims, name), 0o755);
  };
  const drop = (file: string) => `grep -vx "$NAME" "$state/${file}" > "$state/${file}.new" || true; mv "$state/${file}.new" "$state/${file}"`;
  await shim("id", `[ "$1" != -u ] || { echo 0; exit 0; }\ngrep -qx "$1" "$state/users"`);
  await shim("getent", `[ "$1" = group ] && grep -qx "$2" "$state/groups"`);
  await shim("userdel", `echo "userdel $*" >> "$log"\nNAME=$1\n${drop("users")}`);
  await shim("groupdel", `echo "groupdel $*" >> "$log"\nNAME=$1\n${drop("groups")}`);
  await shim("pgrep", `echo >> "$state/pgrep-calls"\n[ "$(wc -l < "$state/pgrep-calls")" -gt ${hiddenFor} ] || exit 1\n[ "$1 $2" = "-u nexus" ] && cat "$state/controllers"`);
  const late = `[ "$*" != "disable --now ${unitNames.probe}" ] || node -e '
  const fs = require("fs"), file = process.argv[1], config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.TCP[3002] = { HTTPS: true };
  config.Web["firebat.tail1234.ts.net:3002"] = { Handlers: { "/": { Proxy: process.argv[2] } } };
  fs.writeFileSync(file, JSON.stringify(config));' "$state/serve.json" "${gateway}"`;
  await shim("systemctl", `case $1 in show|is-active|is-enabled) exit 0 ;; esac\necho "systemctl $*" >> "$log"\n${lateEntry ? late : ""}`);
  await shim("tailscale", `case "$1 $2" in
"serve status") cat "$state/serve.json" ;;
"debug prefs") cat "$state/prefs.json" ;;
"set --operator=") echo "tailscale $*" >> "$log"; echo '{"OperatorUser":""}' > "$state/prefs.json" ;;
serve\\ --https=*) echo "tailscale $*" >> "$log"; port=\${2#--https=}; node -e '
  const fs = require("fs"), [file, port] = process.argv.slice(1), config = JSON.parse(fs.readFileSync(file, "utf8"));
  delete config.TCP[port];
  for (const key of Object.keys(config.Web)) if (key.endsWith(":" + port)) delete config.Web[key];
  fs.writeFileSync(file, JSON.stringify(config));' "$state/serve.json" "$port" ;;
*) echo "unexpected tailscale $*" >&2; exit 2 ;;
esac`);

  const overrides = `prefix="${at(prefix)}"; etc="${at(etc)}"; unit_dir="${at(unitDir)}"; dropin="${at(unitDir)}/tailscaled.service.d/nexus-cert.conf"
state_dirs=("${at(stateDirs.probe)}" "${at(stateDirs.control)}" "${at(stateDirs.backup)}"); backups="${at(backupRoot)}"; service_path="${shims}:$PATH"
controller_dir() { echo "${state}/instances/$1"; }
kill() { [ "$1" = -TERM ] || return 1; echo "kill $*" >> "${log}"; grep -vx "$2" "${state}/controllers" > "${state}/controllers.new" || true; mv "${state}/controllers.new" "${state}/controllers"; }`;
  const tailscaleShim = await readFile(join(shims, "tailscale"), "utf8");
  const tailscaled = (up: boolean) => writeFile(join(shims, "tailscale"), up ? tailscaleShim : `#!/bin/sh\necho "failed to connect to local tailscaled" >&2\nexit 1\n`);
  const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile("bash", ["-c", `. "$1/deploy/uninstall.sh"; ${overrides}; stop_wait=${stopWait}; shift; main "$@"`, "uninstall", repo, ...args], { env: { PATH: `${shims}:${process.env.PATH}` } },
      (err, stdout, stderr) => done({ code: err === null ? 0 : (err.code as number), stdout, stderr }));
  });
  const tree = async () => (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => !entry.isDirectory()).map((entry) => `/${relative(root, join(entry.parentPath, entry.name))}`).sort();
  const machineState = async () => Object.fromEntries(await Promise.all(["users", "groups", "controllers", "prefs.json", "serve.json"].map(async (name) => [name, await readFile(join(state, name), "utf8")])));
  const changes = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
  const serve = async () => Object.keys((JSON.parse(await readFile(join(state, "serve.json"), "utf8")) as { Web: object }).Web);
  return { run, tailscaled, root, state, tree, machineState, changes, serve, files };
}

const everyUnit = Object.values(unitNames);

test("without --yes the uninstall prints each thing it would remove and changes nothing", async (t) => {
  const m = await machine(t);
  const [tree, state] = [await m.tree(), await m.machineState()];
  const run = await m.run();
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual([await m.tree(), await m.machineState(), await m.changes()], [tree, state, []]);
  for (const unit of everyUnit) assert.match(run.stdout, new RegExp(`stop, disable and remove ${RegExp.escape(unit)}`));
  for (const port of [443, 3001]) assert.match(run.stdout, new RegExp(`serve entry on https port ${port}\\b`));
  assert.doesNotMatch(run.stdout, /port 8443/, "an entry that is not the gateway's is not Nexus's");
  assert.match(run.stdout, /unset tailscaled's operator, nexus/);
  assert.match(run.stdout, /What would remain:\n- dir \S+\/var\/backups\/nexus, kept without --remove-backups\n/);
});

test("the uninstall refuses while a pylon's controller runs, unless --stop-pylons, and changes nothing", async (t) => {
  const m = await machine(t, { controllers: [4242] });
  const [tree, state] = [await m.tree(), await m.machineState()];
  for (const args of [[], ["--yes"]]) {
    const run = await m.run(...args);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /the pylons' controllers 4242 run, .*Nothing was changed\. Rerun with --stop-pylons/);
  }
  assert.deepEqual([await m.tree(), await m.machineState(), await m.changes()], [tree, state, []]);
});

test("--yes --stop-pylons removes each thing once, in order, and a rerun finds only the backups and changes nothing", async (t) => {
  const m = await machine(t, { controllers: [4242, 4343] });
  const run = await m.run("--yes", "--stop-pylons");
  assert.equal(run.code, 0, run.stderr);
  const stopOrder = [unitNames.deployerPath, unitNames.deployerTimer, unitNames.deployer, unitNames.backupTimer, unitNames.backup, unitNames.control, unitNames.probe];
  const removedEach = stopOrder.flatMap((unit) => [`systemctl disable --now ${unit}`, "systemctl daemon-reload", `systemctl reset-failed ${unit}`]);
  assert.deepEqual(await m.changes(), [
    ...removedEach, "kill -TERM 4242", "kill -TERM 4343",
    "tailscale serve --https=443 off", "tailscale serve --https=3001 off", "tailscale set --operator=",
    "systemctl daemon-reload",
    ...Object.values(users).flatMap((user) => [`userdel ${user}`, `groupdel ${user}`]),
  ]);
  assert.deepEqual(await m.tree(), m.files.filter((file) => file.startsWith(`${backupRoot}/`)), "only the backups stay");
  assert.deepEqual(await m.serve(), ["firebat.tail1234.ts.net:8443"], "the serve entry that is not Nexus's stays");
  assert.match(run.stdout, /What remains of Nexus here:\n- dir \S+\/var\/backups\/nexus, kept without --remove-backups\n/);

  const before = await m.changes();
  const rerun = await m.run("--yes");
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.deepEqual(await m.changes(), before, "a rerun changes nothing more");
  assert.doesNotMatch(rerun.stdout, /^- (stop|remove|unset)/m);
  assert.match(rerun.stdout, /What remains of Nexus here:\n- dir \S+\/var\/backups\/nexus, kept without --remove-backups\n/);

  const backups = await m.run("--yes", "--remove-backups");
  assert.equal(backups.code, 0, backups.stderr);
  assert.deepEqual(await m.tree(), []);
  assert.match(backups.stdout, /What remains of Nexus here:\n- nothing\n/);
});

test("a tailscaled that does not answer keeps its serve entries, its operator and /etc/nexus, and a rerun once it answers removes them", async (t) => {
  const m = await machine(t);
  const moved = "http://127.0.0.1:9000";
  await writeFile(join(m.root, etc, "probe.json"), JSON.stringify({ previews: { gatewayPort: 9000 } }));
  await writeFile(join(m.state, "serve.json"), JSON.stringify({
    TCP: { 443: { HTTPS: true }, 3001: { HTTPS: true } },
    Web: { "firebat.tail1234.ts.net:443": { Handlers: { "/": { Proxy: moved } } }, "firebat.tail1234.ts.net:3001": { Handlers: { "/": { Proxy: gateway } } } },
  }));
  await m.tailscaled(false);
  const down = await m.run("--yes", "--remove-backups");
  assert.equal(down.code, 0, down.stderr);
  assert.deepEqual(await m.tree(), [join(etc, "control.json"), join(etc, "probe.json")].sort());
  assert.ok(!(await m.changes()).some((line) => line.startsWith("tailscale ")));
  assert.match(down.stdout, /^- leave tailscale's serve entries and operator, which could not be read\. Rerun once tailscaled runs$/m);
  assert.match(down.stdout, /What remains of Nexus here:\n- unread tailscale's serve entries and operator, which could not be read\n- dir \S+\/etc\/nexus, kept until tailscaled answers/);

  await m.tailscaled(true);
  const up = await m.run("--yes", "--remove-backups");
  assert.equal(up.code, 0, up.stderr);
  assert.deepEqual(await m.tree(), []);
  assert.deepEqual(await m.serve(), ["firebat.tail1234.ts.net:3001"], "only the entry to the gateway probe.json names was Nexus's");
  assert.match(up.stdout, /What remains of Nexus here:\n- nothing\n/);
});

test("--stop-pylons waits for a controller that still boots, and signals none until every one listens", async (t) => {
  const m = await machine(t, { controllers: [4242], booting: [4343], stopWait: 0 });
  const run = await m.run("--yes", "--stop-pylons");
  assert.equal(run.code, 1);
  assert.match(run.stderr, /the controllers 4343 still boot after 0 s, and SIGTERM would end them before they can save their disks\. Rerun once they run/);
  assert.ok(!(await m.changes()).some((line) => line.startsWith("kill ")));
  assert.ok((await m.tree()).includes(join(stateDirs.probe, "pylons", "instances", "pyl-1", "disk.qcow2")));
});

test("a controller that starts after the check is not stopped without --stop-pylons", async (t) => {
  const m = await machine(t, { controllers: [4242], hiddenFor: 1 });
  const run = await m.run("--yes");
  assert.equal(run.code, 1);
  assert.match(run.stderr, /the pylons' controllers 4242 started after the check\. Rerun with --stop-pylons/);
  assert.ok(!(await m.changes()).some((line) => line.startsWith("kill ")));
});

test("a serve entry the probe adds while it stops is read after the services stop, and removed", async (t) => {
  const m = await machine(t, { lateEntry: true });
  const run = await m.run("--yes", "--remove-backups");
  assert.equal(run.code, 0, run.stderr);
  const removed = (await m.changes()).filter((line) => line.startsWith("tailscale serve"));
  assert.deepEqual(removed, ["tailscale serve --https=443 off", "tailscale serve --https=3001 off", "tailscale serve --https=3002 off"]);
  assert.deepEqual(await m.serve(), ["firebat.tail1234.ts.net:8443"]);
  assert.match(run.stdout, /What remains of Nexus here:\n- nothing\n/);
});

test("--keep-state keeps the state directories, /etc/nexus and the users that own them, and removes the rest", async (t) => {
  const m = await machine(t);
  const run = await m.run("--yes", "--keep-state");
  assert.equal(run.code, 0, run.stderr);
  const kept = [etc, ...Object.values(stateDirs), backupRoot];
  assert.deepEqual(await m.tree(), [...m.files, join(etc, "probe.json")].filter((file) => kept.some((dir) => file.startsWith(`${dir}/`))).sort());
  assert.ok(!(await m.changes()).some((line) => /^(userdel|groupdel)/.test(line)), "the users stay");
  for (const user of Object.values(users)) assert.match(run.stdout, new RegExp(`^- user ${user}, kept by --keep-state$`, "m"));
});

test("the uninstall names the layout's units, users and state, and the backup's directory", async () => {
  const listed = await new Promise<string>((done, fail) => execFile("bash", ["-c", `. "$1/deploy/uninstall.sh"; printf '%s\\n' "\${units[@]}" -- "\${users[@]}" -- "\${state_dirs[@]}" -- "$unit_dir" "$backups" "$prefix" "$etc"`, "uninstall", repo],
    (err, stdout) => err === null ? done(stdout) : fail(err)));
  const [units, names, dirs, rest] = listed.trim().split("\n--\n").map((part) => part.split("\n"));
  assert.deepEqual([...units!].sort(), [...everyUnit].sort());
  assert.deepEqual(names, Object.values(users));
  assert.deepEqual(dirs, Object.values(stateDirs));
  assert.deepEqual(rest, [unitDir, backupRoot, prefix, etc]);
});
