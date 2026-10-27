/**
 * Prints what a node, a probe, a deploy or a person can observe of the code that issue #139 merges: JSON files on
 * disk (bytes, mode, leftovers), exit codes taken as results, and error text. It imports the checkout given as its
 * argument, so run.sh runs it unchanged against main and against the branch.
 *
 *   node docs/verification/shared-helpers/capture.ts <checkout>
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const root = resolve(process.argv[2] ?? ".");
const src = (path: string) => import(join(root, "src", path));
const work = await mkdtemp(join(tmpdir(), "nexus-capture-"));
const lines: string[] = [];
const scrub = (text: string) => text.replaceAll(work, "<tmp>").replaceAll(String(process.pid), "<pid>");
const say = (line: string) => lines.push(scrub(line));
const section = (title: string) => say(`\n## ${title}`);
const outcome = async (label: string, run: () => Promise<unknown>) => {
  try {
    say(`${label}: resolves ${JSON.stringify(await run())}`);
  } catch (err) {
    say(`${label}: rejects ${(err as Error).name} ${JSON.stringify((err as Error).message)}`);
  }
};

/** Every entry under `dir`, with its mode, and the bytes of each file. */
async function listing(dir: string) {
  for (const name of (await readdir(dir)).sort()) {
    const stat = await lstat(join(dir, name));
    if (stat.isSymbolicLink()) say(`  ${name} symlink`);
    else if (stat.isDirectory()) say(`  ${name}/ ${(stat.mode & 0o777).toString(8)}`);
    else say(`  ${name} ${(stat.mode & 0o777).toString(8)} ${JSON.stringify(await readFile(join(dir, name), "utf8"))}`);
  }
}

const commit = "a".repeat(40);
const old = "b".repeat(40);

section("deploy journal: ReleaseInstaller.install, then observed() on a missing and a malformed journal");
{
  const { ReleaseInstaller } = await src("deploy/install.ts");
  const prefix = join(work, "install");
  await mkdir(prefix);
  await symlink("old", join(prefix, "control-current"));
  const boundary = { prepare: async () => "new", restart: async () => {}, healthy: async () => true, journal: async () => "" };
  await outcome("install", () => new ReleaseInstaller(prefix, "control", boundary).install(commit));
  await listing(prefix);
  await outcome("observed, probe journal missing", () => new ReleaseInstaller(prefix, "probe", boundary).observed());
  await writeFile(join(prefix, "probe-deploy.json"), "{");
  await outcome("observed, probe journal malformed", () => new ReleaseInstaller(prefix, "probe", boundary).observed());
}

section("deploy report: reconcileRole on a healthy release, and with its role's local config missing");
{
  const { reconcileRole } = await src("deploy/worker.ts");
  const prefix = join(work, "worker");
  for (const path of ["etc", "units", "deployer", `releases/${commit}`]) await mkdir(join(prefix, path), { recursive: true });
  await writeFile(join(prefix, `releases/${commit}/release-commit`), commit);
  await symlink(`releases/${commit}`, join(prefix, "control-current"));
  const server = createServer((_req, res) => res.end(JSON.stringify({ commit }))).listen(0, "127.0.0.1");
  await once(server, "listening");
  await writeFile(join(prefix, "etc/control.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: (server.address() as { port: number }).port } }));
  const reports: unknown[] = [];
  const api = async (path: string, body?: unknown) => {
    if (path === "release") return { desired: { commit, requestedBy: "nMac", requestedAt: 0 }, nodes: [] };
    if (path === "report") { reports.push(body); return { ok: true }; }
    throw new Error(`unexpected ${path}`);
  };
  const config = { controlUrl: "http://control/", controlNodeId: "nControl", token: "a".repeat(64), healthTimeoutMs: 1000, drainTimeoutMs: 0 };
  const boundary = { prefix, etc: join(prefix, "etc"), units: join(prefix, "units"), checkout: async () => {}, run: async () => "" };
  await outcome("reconcileRole control", () => reconcileRole("control", config, api, boundary));
  server.close();
  say(`  sent ${JSON.stringify(reports)}`);
  for (const name of (await readdir(prefix)).filter((n) => n.endsWith(".json") || n.includes(".json."))) {
    const path = join(prefix, name);
    const text = (await readFile(path, "utf8")).replace(/"observedAt": ?\d+/, '"observedAt":<now>');
    say(`  ${name} ${((await lstat(path)).mode & 0o777).toString(8)} ${JSON.stringify(text)}`);
  }
  await outcome("reconcileRole probe, etc/probe.json missing", () => reconcileRole("probe", config, api, boundary));
}

section("preview routes: a converge's routes file under umask 022 and 077, and readRoutes of a missing and a malformed file");
{
  const { createTailscaleServe, readRoutes } = await src("probe/serve.ts");
  const { fakeTailscale } = await src("probe/fake-tailscale.ts");
  for (const umask of [0o022, 0o077]) {
    const dir = join(work, `routes-${umask.toString(8)}`);
    await mkdir(dir);
    const previous = process.umask(umask);
    const gateway = { origin: "http://127.0.0.1:7481", routes: new Map() };
    const serve = createTailscaleServe({ cli: fakeTailscale().cli, gateway, routesFile: join(dir, "preview-routes.json"), get: async () => 204 });
    await outcome(`converge under umask ${umask.toString(8)}`, () => serve.converge("pylon-a", [{ service: "web", httpsPort: 10000 }, { service: "port-6006", httpsPort: 10001 }], AbortSignal.timeout(5000)));
    process.umask(previous);
    await listing(dir);
    await outcome("readRoutes of it", async () => [...await readRoutes(join(dir, "preview-routes.json"))]);
  }
  await outcome("readRoutes, missing", async () => [...await readRoutes(join(work, "no-routes.json"))]);
  await writeFile(join(work, "bad-routes.json"), "{");
  await outcome("readRoutes, malformed", async () => [...await readRoutes(join(work, "bad-routes.json"))]);
  await writeFile(join(work, "wrong-routes.json"), '{"a":1}');
  await outcome("readRoutes, not a list", async () => [...await readRoutes(join(work, "wrong-routes.json"))]);
}

section("pylon-vm saveJson, which the pylon controller writes status.json, services.json, linked.json and the checkpoint sidecar with");
{
  const { saveJson } = existsSync(join(root, "src/json-file.ts")) ? await src("json-file.ts") : await src("pylon-vm/storage.ts");
  const dir = join(work, "pylon");
  await mkdir(dir);
  await saveJson(join(dir, "status.json"), { state: "running", ports: [3000] });
  await listing(dir);
}

section("deploy bootstrap: the files install-deployer.sh copies, then the bootstrap worker's --check");
{
  const script = await readFile(join(root, "deploy/install-deployer.sh"), "utf8");
  const boot = join(work, "bootstrap");
  await mkdir(join(boot, "src/deploy"), { recursive: true });
  if (!script.includes('cp "$repo/src/deploy/"*.ts "$prefix/deployer/bootstrap/src/deploy/"')) throw new Error("install-deployer.sh copies src/deploy differently now");
  for (const name of await readdir(join(root, "src/deploy"))) if (name.endsWith(".ts")) await cp(join(root, "src/deploy", name), join(boot, "src/deploy", name));
  for (const [, file] of script.matchAll(/^install -o root -g root -m 0600 "\$repo\/src\/(\S+)" "\$prefix\/deployer\/bootstrap\/src\/\1"$/gm)) {
    say(`  copies src/${file}`);
    await cp(join(root, "src", file!), join(boot, "src", file!));
  }
  await writeFile(join(boot, "package.json"), '{"type":"module"}\n');
  await outcome("node src/deploy/worker.ts --check", async () => {
    try {
      await promisify(execFile)(process.execPath, [join(boot, "src/deploy/worker.ts"), "--check"], { cwd: boot });
      return "exit 0";
    } catch (err) {
      const { code, stderr } = err as { code: number; stderr: string };
      return `exit ${code}: ${stderr.split("\n").find((line) => /Error|Cannot find/.test(line))}`;
    }
  });
}

section("deploy worker's module graph: the repo files and packages src/deploy/worker.ts loads");
{
  const esbuild = await import(join(root, "node_modules/esbuild/lib/main.js"));
  const { metafile } = await esbuild.build({ entryPoints: [join(root, "src/deploy/worker.ts")], bundle: true, write: false, platform: "node", format: "esm", packages: "external", metafile: true, logLevel: "silent", absWorkingDir: root });
  const files = Object.keys(metafile.inputs).sort();
  const packages = [...new Set(Object.values(metafile.inputs).flatMap((input: any) => input.imports.filter((i: any) => i.external && !i.path.startsWith("node:")).map((i: any) => i.path)))].sort();
  say(`  files ${JSON.stringify(files)}`);
  say(`  packages ${JSON.stringify(packages)}`);
}

// A fake `docker` and `tailscale` first on PATH. Each logs its argv, one line per run, and answers as FAKE_* says.
const bin = join(work, "bin");
const argvLog = join(work, "argv.log");
await mkdir(bin);
await writeFile(join(bin, "tailscale"), `#!/bin/sh
echo "tailscale $*" >> "${argvLog}"
[ -n "$FAKE_SLEEP" ] && sleep "$FAKE_SLEEP"
printf '%s' "$FAKE_STDOUT"
printf '%s' "$FAKE_STDERR" >&2
exit "\${FAKE_EXIT:-0}"
`);
await writeFile(join(bin, "docker"), `#!/bin/sh
echo "docker $*" >> "${argvLog}"
case "$1 $2" in
  "ps -a") echo cid-1; exit 0 ;;
  "ps --filter") echo pylon-a; exit 0 ;;
  "container inspect") echo '[{"Id":"cid-1","State":{"Status":"running","StartedAt":"2026-10-27T00:00:00Z","ExitCode":0},"Config":{"Labels":{"nexus.pylon":"pylon-a"}}}]'; exit 0 ;;
  "port "*) exit 0 ;;
esac
if [ "$1" = exec ]; then
  case "$*" in
    *"test -e"*) exit 3 ;;
    *"cat /run/nexus-services/linked"*) exit 0 ;;
    *"rm -f"*) echo "rm: cannot remove: Read-only file system" >&2; exit 1 ;;
  esac
  [ -n "$FAKE_SLEEP" ] && sleep "$FAKE_SLEEP"
  printf '%s' "$FAKE_STDOUT"
  printf '%s' "$FAKE_STDERR" >&2
  exit "\${FAKE_EXIT:-0}"
fi
printf '%s' "$FAKE_STDERR" >&2
exit "\${FAKE_EXIT:-0}"
`);
await chmod(join(bin, "tailscale"), 0o755);
await chmod(join(bin, "docker"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
const fake = (env: Record<string, string>) => {
  for (const key of ["FAKE_STDOUT", "FAKE_STDERR", "FAKE_EXIT", "FAKE_SLEEP"]) delete process.env[key];
  Object.assign(process.env, env);
};
const argv = async () => {
  const text = existsSync(argvLog) ? await readFile(argvLog, "utf8") : "";
  await rm(argvLog, { force: true });
  for (const line of text.split("\n").filter((l) => l !== "")) say(`  ran ${line}`);
};

section("probe tailscaleCli: stdout, a nonzero exit with and without stderr, an abort");
{
  const { tailscaleCli } = await src("probe/serve.ts");
  const cli = tailscaleCli();
  fake({ FAKE_STDOUT: '  {"TCP":{}}\n\n' });
  await outcome("exit 0", () => cli(["serve", "status", "--json"], AbortSignal.timeout(5000)));
  fake({ FAKE_STDERR: "error: port 443 is taken\n", FAKE_EXIT: "1" });
  await outcome("exit 1 with stderr", () => cli(["serve", "--bg", "--https=443", "http://127.0.0.1:7481"], AbortSignal.timeout(5000)));
  fake({ FAKE_EXIT: "2" });
  await outcome("exit 2 without stderr", () => cli(["serve", "--https=443", "off"], AbortSignal.timeout(5000)));
  fake({ FAKE_SLEEP: "5" });
  await outcome("aborted", () => cli(["serve", "status", "--json"], AbortSignal.timeout(200)));
  await outcome("missing binary", () => tailscaleCli(join(work, "no-tailscale"))(["version"], AbortSignal.timeout(5000)));
  await argv();
}

section("Docker backend: label filters, a failing docker command, and a guest exec's exit code, output and timeout");
{
  const { createDockerBackend } = await src("docker-backend.ts");
  const backend = createDockerBackend({ images: {}, labels: { "nexus.test": "capture", "nexus.run": "1" } });
  fake({});
  await outcome("artifacts.list", () => backend.artifacts.list());
  await argv();
  fake({ FAKE_STDERR: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n", FAKE_EXIT: "1" });
  await outcome("artifacts.list, docker down", () => backend.artifacts.list());
  fake({ FAKE_EXIT: "1" });
  await outcome("artifacts.list, docker exits 1 silently", () => backend.artifacts.list());
  await argv();
  const guest = backend.guest("pylon-a");
  fake({ FAKE_STDOUT: "out\n", FAKE_STDERR: "err\n" });
  await outcome("exec exit 0", () => guest.exec(["sh", "-c", "true"], { cwd: "/workspace", timeoutMs: 5000 }));
  fake({ FAKE_STDOUT: "partial\n", FAKE_STDERR: "failed\n", FAKE_EXIT: "7" });
  await outcome("exec exit 7", () => guest.exec(["false"], { cwd: "/workspace", timeoutMs: 5000 }));
  fake({ FAKE_STDOUT: "", FAKE_SLEEP: "5" });
  await outcome("exec past its timeout", () => guest.exec(["sleep", "60"], { cwd: "/", timeoutMs: 300 }));
  await argv();
}

section("Docker services: a missing services file is exit 3, a result; a checked script that fails");
{
  const { dockerServices } = await src("docker-services.ts");
  fake({});
  await outcome("apply to a booted container", () => dockerServices().apply("pylon-a", {}, true));
  const services = dockerServices();
  await outcome("apply to a running container, then list", async () => { await services.apply("pylon-a", {}, false); return services.operate("pylon-a", "list"); });
  await argv();
}

section("Docker host bridge: the docker ps a NEXUS_API request runs, with its label filters");
{
  const { dockerHostBridge } = await src("docker-host-bridge.ts");
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  probe.close();
  fake({});
  const bridge = await dockerHostBridge(port, { "nexus.test": "capture" })(async (pylonId: string, body: string) => ({ status: 200, body: JSON.stringify({ pylonId, body }) }));
  const res = await fetch(`http://127.0.0.1:${port}/${"0".repeat(32)}/v1/request`, { method: "POST", body: "{}" });
  say(`  answered ${res.status} ${await res.text()}`);
  await bridge.close();
  await argv();
}

section("project mirror: git exits that are results, a git failure's text, an abort");
{
  const { projectMirror } = await src("control/mirror.ts");
  const git = (cwd: string, ...args: string[]) => promisify(execFile)("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: "2026-10-27T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-27T00:00:00Z" } });
  const repo = join(work, "repo");
  await mkdir(join(repo, ".nexus"), { recursive: true });
  await git(repo, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(repo, "README"), "no setup\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "--quiet", "-m", "first");
  await git(repo, "checkout", "--quiet", "-b", "with-setup");
  await writeFile(join(repo, ".nexus/setup"), "#!/bin/sh\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "--quiet", "-m", "setup");
  const mirror = projectMirror({ githubToken: null });
  const project = { repoUrl: `file://${repo}` };
  await outcome("main, no .nexus/setup", () => mirror.setupInputs(project, { branch: "main" }));
  await outcome("with-setup", () => mirror.setupInputs(project, { branch: "with-setup" }));
  await outcome("a branch the remote lacks", () => mirror.setupInputs(project, { branch: "gone" }));
  await outcome("an ssh remote", () => mirror.setupInputs({ repoUrl: "git@github.com:o/r.git" }, { branch: "main" }));
  await outcome("aborted", () => mirror.setupInputs(project, { branch: "main" }, AbortSignal.abort()));
}

await rm(work, { recursive: true, force: true });
console.log(lines.join("\n").trimStart());
