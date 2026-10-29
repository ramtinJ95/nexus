import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { parseConfig } from "../control/main.ts";
import { harnessModels, openCredentials, requireModel } from "../harness/credentials.ts";
import { provision, scripted, stores, system, type Answers, type FollowUp, type Host } from "./credentials.ts";
import { snapshot } from "../test-kit.ts";

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "../..");
const harnessFile = stores.harness.file;

/** What `ssh-keyscan github.com` prints, GitHub's keys as https://api.github.com/meta publishes them. */
const githubScan = [
  "# github.com:22 SSH-2.0-1f2e3d4",
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "",
].join("\n");

/** A machine after the role installers ran, under a temporary directory: control.json and probe.json, and secrets.env from the example. */
async function machine(t: TestContext, role: "control" | "node", scan = githubScan) {
  const root = await mkdtemp(join(tmpdir(), "nexus-credentials-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const at = (path: string) => join(root, path);
  const put = async (path: string, text: string, mode: number) => {
    await mkdir(dirname(at(path)), { recursive: true });
    await writeFile(at(path), text, { mode });
    await chmod(at(path), mode);
  };
  if (role === "control") await put("/etc/nexus/control.json", await readFile(join(repo, "deploy/control.example.json"), "utf8"), 0o644);
  await put("/etc/nexus/probe.json", `${JSON.stringify({ node: "rj-firebat" })}\n`, 0o644);
  await put(stores.claude.file, await readFile(join(repo, "deploy/secrets.example.env"), "utf8"), 0o640);

  const owners: string[] = [];
  const runs: string[][] = [];
  const host: Host = {
    read: (path) => readFile(at(path), "utf8").catch(() => undefined),
    exists: (path) => access(at(path)).then(() => true, () => false),
    async write(path, text, { mode, owner }) {
      await put(`${path}.tmp`, text, mode);
      await rename(at(`${path}.tmp`), at(path));
      owners.push(`${owner} ${path}`);
    },
    append: (path, text) => appendFile(at(path), text),
    async own(path, { mode, owner }) {
      await chmod(at(path), mode);
      owners.push(`${owner} ${path}`);
    },
    async run(program, args, options) {
      runs.push([program, ...args]);
      if (program === "ssh-keyscan") return scan;
      if (program === "ssh-keygen") {
        const file = args.indexOf("-f") + 1;
        await exec("ssh-keygen", args.map((arg, i) => i === file ? at(arg) : arg));
        return "";
      }
      if (program === "runuser") {
        assert.equal(options?.interactive, true, "the login has the terminal");
        await put(harnessFile, `${JSON.stringify({ deviceId: "8c1c3a51-7d5e-4a8e-9a43-2b1f4c1e0d9a", credentials: { openai: { type: "oauth" } } })}\n`, 0o600);
        return "";
      }
      return assert.fail(`ran ${program}`);
    },
  };
  return { root, at, put, host, owners, runs };
}

/** Answers from `given`, by each question's variable. A question it has no answer for fails the test. */
function answering(given: Record<string, string | undefined>) {
  const asked: string[] = [];
  const answers: Answers = {
    async secret(q) {
      asked.push(q.key);
      if (!(q.key in given)) assert.fail(`asked for ${q.key}`);
      const value = given[q.key];
      if (value !== undefined) assert.equal(q.check(value), undefined, `${q.key} passes its check`);
      return value;
    },
    async choose(q) {
      asked.push(q.key);
      const value = given[q.key];
      if (value === undefined) return assert.fail(`asked for ${q.key}`);
      assert.ok(q.choices.some((c) => c.id === value), `${value} is a choice of ${q.key}`);
      return value;
    },
  };
  return { asked, answers };
}

const silent = () => {};
const claudeToken = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz_0123456789-ABCDEFG";
const ghToken = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz";

test("a first install asks for each credential, keeps each where Nexus keeps it, and says what the installer does next", async (t) => {
  const m = await machine(t, "control");
  const said: string[] = [];
  const { asked, answers } = answering({
    NEXUS_HARNESS_LOGIN: "chatgpt", NEXUS_CLAUDE_TOKEN: claudeToken, NEXUS_GH_TOKEN: ghToken, NEXUS_GITHUB_WATCH: "yes", NEXUS_GIT_KEY: "yes",
  });
  const next = await provision("control", m.host, answers, (line) => said.push(line));

  assert.deepEqual(asked, ["NEXUS_HARNESS_LOGIN", "NEXUS_CLAUDE_TOKEN", "NEXUS_GH_TOKEN", "NEXUS_GITHUB_WATCH", "NEXUS_GIT_KEY"]);
  assert.deepEqual([...next].sort(), ["config", "control", "probe", "watch"]);
  assert.deepEqual(m.runs[0], ["runuser", "-u", "nexus-control", "--", "env", "PATH=/usr/local/bin:/usr/bin", "node", "/opt/nexus/control-current/src/control/login.ts", "/etc/nexus/control.json"]);

  const secrets = await readFile(m.at(stores.claude.file), "utf8");
  assert.ok(secrets.startsWith(await readFile(join(repo, "deploy/secrets.example.env"), "utf8")), "secrets.env keeps what it had");
  assert.ok(secrets.endsWith(`\nCLAUDE_CODE_OAUTH_TOKEN=${claudeToken}\nGH_TOKEN=${ghToken}\n`));
  assert.equal((await stat(m.at(stores.claude.file))).mode & 0o777, 0o640);

  assert.equal(await readFile(m.at(stores.githubWatch.file), "utf8"), `${ghToken}\n`);
  assert.equal((await stat(m.at(stores.githubWatch.file))).mode & 0o777, 0o640);
  assert.equal(parseConfig(await readFile(m.at("/etc/nexus/control.json"), "utf8")).github, undefined, "the installer names the file under the deployer's lock, after this step");

  assert.equal(await readFile(m.at("/etc/nexus/git_known_hosts"), "utf8"), githubScan.split("\n").filter((l) => l.startsWith("github.com")).map((l) => `${l}\n`).join(""));
  assert.equal((await stat(m.at(stores.gitKey.file))).mode & 0o777, 0o400);
  const publicKey = (await readFile(m.at(`${stores.gitKey.file}.pub`), "utf8")).trim();
  assert.match(publicKey, /^ssh-ed25519 \S+ nexus@rj-firebat$/);
  assert.deepEqual(m.owners, [
    "root:nexus-control /etc/nexus/github-token", "root:root /etc/nexus/git_known_hosts", "nexus:nexus /etc/nexus/git_ed25519",
  ]);
  assert.ok(said.includes(publicKey), "the public key is printed");
  assert.ok(said.some((line) => line.includes("https://github.com/settings/ssh/new")));
  assert.ok(!said.some((line) => line.includes(claudeToken) || line.includes(ghToken)), "no token is printed");
});

test("an OpenAI API key signs the harness in the way the harness reads one, under the device ID it had", async (t) => {
  const m = await machine(t, "control");
  const deviceId = "0f6d7c1e-2b3a-4c5d-8e9f-a0b1c2d3e4f5";
  await m.put(harnessFile, `${JSON.stringify({ deviceId, credentials: {} })}\n`, 0o600);
  const { answers } = answering({ NEXUS_HARNESS_LOGIN: "api-key", NEXUS_OPENAI_API_KEY: "sk-proj-abc_DEF-123", NEXUS_CLAUDE_TOKEN: undefined, NEXUS_GH_TOKEN: undefined, NEXUS_GIT_KEY: "no" });
  assert.deepEqual([...await provision("control", m.host, answers, silent)], ["control"]);
  assert.equal((await stat(m.at(harnessFile))).mode & 0o777, 0o600);
  assert.deepEqual(m.owners, [`nexus-control:nexus-control ${harnessFile}`]);
  const credentials = await openCredentials(m.at(harnessFile));
  assert.equal(credentials.deviceId, deviceId);
  assert.deepEqual(await credentials.store.read("openai"), { type: "api_key", key: "sk-proj-abc_DEF-123" });
  await requireModel(harnessModels(credentials), { provider: "openai", modelId: "gpt-6-astra" });
});

test("a failed ChatGPT login offers the choice again, and an API key then keeps the device ID the login made", async (t) => {
  const m = await machine(t, "control");
  const deviceId = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
  m.host.run = async (program) => {
    m.runs.push([program]);
    await m.put(harnessFile, `${JSON.stringify({ deviceId, credentials: {} })}\n`, 0o600);
    throw new Error("runuser exited with 1");
  };
  const choices = ["chatgpt", "api-key"];
  const { answers } = answering({ NEXUS_OPENAI_API_KEY: "sk-proj-abc", NEXUS_CLAUDE_TOKEN: undefined, NEXUS_GH_TOKEN: undefined, NEXUS_GIT_KEY: "no" });
  const said: string[] = [];
  const next = await provision("control", m.host, { ...answers, choose: async (q) => q.key === "NEXUS_HARNESS_LOGIN" ? choices.shift()! : answers.choose(q) }, (line) => said.push(line));
  assert.deepEqual([...next], ["control"]);
  assert.deepEqual(choices, [], "asked twice");
  assert.ok(said.includes("The ChatGPT login failed: runuser exited with 1."));
  assert.equal((await openCredentials(m.at(harnessFile))).deviceId, deviceId);
});

test("a rerun over credentials already in place asks nothing, runs nothing and changes no file", async (t) => {
  for (const claude of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    const m = await machine(t, "control");
    await m.put(harnessFile, `${JSON.stringify({ deviceId: "8c1c3a51-7d5e-4a8e-9a43-2b1f4c1e0d9a", credentials: { openai: { type: "oauth" } } })}\n`, 0o600);
    await m.put(stores.claude.file, `# by hand\n${claude}=x\nGH_TOKEN=y`, 0o640);
    await m.put(stores.gitKey.file, "a key made by hand\n", 0o400);
    const control = JSON.parse(await readFile(m.at("/etc/nexus/control.json"), "utf8")) as object;
    await m.put("/etc/nexus/control.json", `${JSON.stringify({ ...control, github: { tokenFile: "/etc/nexus/github-token" } })}\n`, 0o644);
    const before = await snapshot(m.root);
    const said: string[] = [];
    const next = await provision("control", m.host, answering({}).answers, (line) => said.push(line));
    assert.deepEqual([...next], []);
    assert.deepEqual([m.runs, m.owners], [[], []]);
    assert.deepEqual(await snapshot(m.root), before);
    assert.deepEqual(said, [
      `Left the harness's login in ${harnessFile} alone.`,
      `Left ${claude} in /etc/nexus/secrets.env alone.`,
      "Left GH_TOKEN in /etc/nexus/secrets.env alone.",
      "Left github.tokenFile /etc/nexus/github-token in /etc/nexus/control.json alone.",
      "Left the git SSH key /etc/nexus/git_ed25519 alone.",
    ]);
  }
});

test("a declined or unfinished PR watch is offered again on a rerun, with the GitHub token already in place and nothing rewritten", async (t) => {
  const m = await machine(t, "control");
  const rest = { NEXUS_HARNESS_LOGIN: "skip", NEXUS_CLAUDE_TOKEN: undefined, NEXUS_GIT_KEY: "no" };
  assert.deepEqual([...await provision("control", m.host, answering({ ...rest, NEXUS_GH_TOKEN: ghToken, NEXUS_GITHUB_WATCH: "no" }).answers, silent)], ["probe"]);
  assert.equal(await m.host.exists(stores.githubWatch.file), false);

  const secrets = await readFile(m.at(stores.claude.file), "utf8");
  const declined = answering({ ...rest, NEXUS_GITHUB_WATCH: "yes" });
  assert.deepEqual([...await provision("control", m.host, declined.answers, silent)].sort(), ["control", "watch"]);
  assert.deepEqual(declined.asked, ["NEXUS_HARNESS_LOGIN", "NEXUS_CLAUDE_TOKEN", "NEXUS_GITHUB_WATCH", "NEXUS_GIT_KEY"], "the token is not asked for again");
  assert.equal(await readFile(m.at(stores.githubWatch.file), "utf8"), `${ghToken}\n`, "the token in secrets.env is reused");
  assert.equal(await readFile(m.at(stores.claude.file), "utf8"), secrets);

  const before = await snapshot(m.root);
  const said: string[] = [];
  const unfinished = await provision("control", m.host, answering({ ...rest, NEXUS_GITHUB_WATCH: "yes" }).answers, (line) => said.push(line));
  assert.deepEqual([...unfinished].sort(), ["control", "watch"], "a token file control.json does not name yet is named on the next run");
  assert.ok(said.includes(`Left ${stores.githubWatch.file} alone.`));
  assert.deepEqual(await snapshot(m.root), before);
});

test("without a terminal, the PR watch is turned on for a GitHub token the run was given, never for one an install already had", async (t) => {
  const m = await machine(t, "control");
  await m.put(stores.claude.file, `GH_TOKEN=${ghToken}\n`, 0o640);
  const before = await snapshot(m.root);
  assert.deepEqual([...await provision("control", m.host, scripted({ NEXUS_GIT_KEY: "no" }), silent)], []);
  assert.deepEqual(await snapshot(m.root), before);
});

test("a probe.json that names its own secrets file and git key is read where it points, and the defaults are left alone", async (t) => {
  const m = await machine(t, "node");
  await m.put("/etc/nexus/probe.json", `${JSON.stringify({ node: "rj-firebat", secretsFile: "/srv/secrets.env", backend: { gitSsh: { privateKeyFile: "/srv/git_key", knownHostsFile: "/srv/known_hosts" } } })}\n`, 0o644);
  await m.put("/srv/secrets.env", "ANTHROPIC_API_KEY=x\nGH_TOKEN=y\n", 0o640);
  await m.put("/srv/git_key", "a key\n", 0o400);
  const before = await snapshot(m.root);
  const said: string[] = [];
  assert.deepEqual([...await provision("node", m.host, answering({}).answers, (line) => said.push(line))], []);
  assert.deepEqual(await snapshot(m.root), before);
  assert.deepEqual(said, ["Left ANTHROPIC_API_KEY in /srv/secrets.env alone.", "Left GH_TOKEN in /srv/secrets.env alone.", "Left the git SSH key /srv/git_key alone."]);
});

test("a run that fails partway still says what the writes it made need", async (t) => {
  const m = await machine(t, "node");
  const next = new Set<FollowUp>();
  await assert.rejects(provision("node", m.host, scripted({ NEXUS_CLAUDE_TOKEN: claudeToken, NEXUS_GH_TOKEN: "not a token" }), silent, next), /NEXUS_GH_TOKEN/);
  assert.match(await readFile(m.at(stores.claude.file), "utf8"), /\nCLAUDE_CODE_OAUTH_TOKEN=/);
  assert.deepEqual([...next], ["probe"]);
});

test("root never follows a symlink when it sets a credential's owner and mode", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-credentials-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "target"), "root's file\n", { mode: 0o600 });
  await symlink(join(dir, "target"), join(dir, "harness-credentials.json"));
  await assert.rejects(system.own(join(dir, "harness-credentials.json"), stores.harness), { code: "ELOOP" });
  assert.equal((await stat(join(dir, "target"))).mode & 0o777, 0o600);
});

test("a skipped credential writes nothing, and the next run asks for it again", async (t) => {
  const m = await machine(t, "control");
  const before = await snapshot(m.root);
  const skip = { NEXUS_HARNESS_LOGIN: "skip", NEXUS_CLAUDE_TOKEN: undefined, NEXUS_GH_TOKEN: undefined, NEXUS_GIT_KEY: "no" };
  assert.deepEqual([...await provision("control", m.host, answering(skip).answers, silent)], []);
  assert.deepEqual(await snapshot(m.root), before);
  assert.deepEqual([m.runs, m.owners], [[], []]);
  const again = answering({ ...skip, NEXUS_GIT_KEY: "yes" });
  assert.deepEqual([...await provision("control", m.host, again.answers, silent)], ["config"]);
  assert.deepEqual(again.asked, ["NEXUS_HARNESS_LOGIN", "NEXUS_CLAUDE_TOKEN", "NEXUS_GH_TOKEN", "NEXUS_GIT_KEY"]);
});

test("a further node asks for its own Claude token, GitHub token and git key, and nothing that is the control plane's", async (t) => {
  const m = await machine(t, "node");
  const { asked, answers } = answering({ NEXUS_CLAUDE_TOKEN: claudeToken, NEXUS_GH_TOKEN: ghToken, NEXUS_GIT_KEY: "yes" });
  assert.deepEqual([...await provision("node", m.host, answers, silent)].sort(), ["config", "probe"]);
  assert.deepEqual(asked, ["NEXUS_CLAUDE_TOKEN", "NEXUS_GH_TOKEN", "NEXUS_GIT_KEY"]);
  assert.equal(await m.host.exists(stores.githubWatch.file), false);
  assert.equal(await m.host.exists(harnessFile), false);
  assert.deepEqual(m.runs.map((r) => r[0]), ["ssh-keyscan", "ssh-keygen"], "it copies nothing from another machine");
});

test("host keys for github.com that GitHub does not publish make no git key", async (t) => {
  const m = await machine(t, "node", "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  const before = await snapshot(m.root);
  const said: string[] = [];
  const next = await provision("node", m.host, answering({ NEXUS_CLAUDE_TOKEN: undefined, NEXUS_GH_TOKEN: undefined, NEXUS_GIT_KEY: "yes" }).answers, (line) => said.push(line));
  assert.deepEqual([...next], []);
  assert.deepEqual(await snapshot(m.root), before);
  assert.match(said.join("\n"), /Made no git SSH key, because github\.com's host keys could not be checked: github\.com offered the ssh-ed25519 key SHA256:\S+, which is not one GitHub publishes/);
});

test("without a terminal the answers come from NEXUS_* variables or the files they name, the rest are skipped, and a bad value fails", async (t) => {
  const m = await machine(t, "control");
  const tokenFile = m.at("/root/gh-token");
  await m.put("/root/gh-token", `${ghToken}\n`, 0o600);
  const env = { NEXUS_CLAUDE_TOKEN: "sk-ant-api03-abcdef", NEXUS_GH_TOKEN_FILE: tokenFile };
  const next = await provision("control", m.host, scripted(env), silent);
  assert.deepEqual([...next].sort(), ["config", "control", "probe", "watch"]);
  assert.match(await readFile(m.at(stores.claude.file), "utf8"), /\nANTHROPIC_API_KEY=sk-ant-api03-abcdef\nGH_TOKEN=github_pat_\w+\n$/);
  assert.equal(await m.host.exists(harnessFile), false, "the harness needs a person or an API key");
  assert.equal(await m.host.exists(stores.gitKey.file), true, "the git key is made unless NEXUS_GIT_KEY=no");
  assert.deepEqual(m.runs.map((r) => r[0]), ["ssh-keyscan", "ssh-keygen"], "no login is started without a terminal");

  for (const [env, wrong] of [
    [{ NEXUS_CLAUDE_TOKEN: `${claudeToken}\nGH_TOKEN=other` }, /NEXUS_CLAUDE_TOKEN: a token is one line/],
    [{ NEXUS_GH_TOKEN: "not a token" }, /NEXUS_GH_TOKEN: a GitHub token is/],
    [{ NEXUS_GIT_KEY: "maybe" }, /NEXUS_GIT_KEY is maybe, and without a terminal must be one of yes, no/],
    [{ NEXUS_HARNESS_LOGIN: "chatgpt" }, /NEXUS_HARNESS_LOGIN is chatgpt, and without a terminal must be one of api-key, skip/],
  ] as const) {
    const fresh = await machine(t, "control");
    const before = await snapshot(fresh.root);
    await assert.rejects(provision("control", fresh.host, scripted(env), silent), wrong);
    assert.deepEqual(await snapshot(fresh.root), before);
  }
});
