import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootSecrets, effectiveAllowedHosts, type Project } from "./control/project.ts";
import { renderOverlay, type PylonOverlay } from "./control/overlay.ts";
import { chatgptTokenGrant, githubTokenGrant, secretHostPattern, secretNamePattern } from "./secret-grants.ts";
import { installFileCommand } from "./shell.ts";
import type { NodeName, ProjectId, PylonId } from "./ids.ts";

const project: Project = {
  id: "acme-web" as ProjectId,
  repoUrl: "git@github.com:ramtin/acme-web.git",
  defaultBranch: "main",
  defaultNode: "rj-firebat" as NodeName,
  resources: { cpus: 4, memoryGiB: 8, diskGiB: 20 },
  allowedHosts: ["registry.npmjs.org", "api.stripe.com"],
  secrets: [{ name: "STRIPE_KEY", hosts: ["api.stripe.com", "files.stripe.com"] }],
  logins: ["chatgpt"],
  preSetup: null,
};

test("effectiveAllowedHosts joins project hosts, login hosts and secret hosts, sorted and deduped", () => {
  assert.deepEqual(effectiveAllowedHosts(project), [
    "api.openai.com", "api.stripe.com", "auth.openai.com", "chatgpt.com", "files.stripe.com", "registry.npmjs.org",
  ]);
  assert.deepEqual(effectiveAllowedHosts({ ...project, allowedHosts: [], secrets: [], logins: [] }), []);
});

test("effectiveAllowedHosts lets a project reach its own HTTPS repo host, and adds nothing for an SSH one", () => {
  const bare = { ...project, allowedHosts: [], secrets: [], logins: [] };
  assert.deepEqual(effectiveAllowedHosts({ ...bare, repoUrl: "https://github.com/octocat/Spoon-Knife.git" }), ["github.com"]);
  assert.deepEqual(effectiveAllowedHosts({ ...bare, repoUrl: "https://Git.Example.com:8443/acme/web.git", allowedHosts: ["git.example.com"] }), ["git.example.com"]);
  assert.deepEqual(effectiveAllowedHosts({ ...bare, repoUrl: "ssh://git@github.com/acme/web.git" }), []);
});

test("effectiveAllowedHosts of a scratch project adds no repo host and keeps its grants' hosts", () => {
  const scratch = { ...project, repoUrl: null, allowedHosts: [], logins: [] };
  assert.deepEqual(effectiveAllowedHosts({ ...scratch, secrets: [] }), []);
  assert.deepEqual(effectiveAllowedHosts({ ...scratch, secrets: [githubTokenGrant] }), ["api.github.com", "github.com"]);
});

test("a pylon is granted the ChatGPT token exactly when its project has the chatgpt login", () => {
  assert.deepEqual(bootSecrets(project), [...project.secrets, { name: "NEXUS_CHATGPT_TOKEN", hosts: ["api.openai.com"] }]);
  assert.deepEqual(bootSecrets({ ...project, logins: ["claude"] }), project.secrets);
  assert.deepEqual(bootSecrets({ ...project, logins: [] }), project.secrets);
});

const overlay: PylonOverlay = {
  pylonId: "pylon-t1" as PylonId,
  threadId: "t1",
  project: "acme-web" as ProjectId,
  node: "rj-firebat" as NodeName,
  allowedHosts: ["api.openai.com", "registry.npmjs.org"],
  previews: [{ service: "web", url: "https://rj-firebat.example.ts.net:8443/" }],
  logins: ["chatgpt"],
  dotfiles: { repo: "git@github.com:ramtin/dotfiles.git", ref: "abc123" },
  repo: { kind: "clone", url: "git@github.com:ramtin/acme-web.git", checkout: { branch: "main", commit: "origin/main" } },
  secrets: [],
};

test("renderOverlay renders the profile script, pylon.json and PYLON.md", () => {
  const files = renderOverlay(overlay);
  assert.deepEqual(files.map(({ path, mode, owner }) => [path, mode, owner]), [
    ["/etc/profile.d/nexus.sh", 0o644, "root"],
    ["/home/user/.nexus/pylon.json", 0o644, "user"],
    ["/home/user/.nexus/PYLON.md", 0o644, "user"],
  ]);
  assert.deepEqual(renderOverlay(overlay), files, "the same overlay renders the same bytes, so LiveHash is stable");
});

test("the profile script exports the NEXUS_ facts to a login shell, quoting every value", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-overlay-"));
  const script = join(dir, "nexus.sh");
  writeFileSync(script, renderOverlay({ ...overlay, threadId: "it's $HOME `id`" })[0]!.content);
  const env = execFileSync("sh", ["-c", `. "$1" && env`, "sh", script], { encoding: "utf8", env: {} });
  const nexus = Object.fromEntries(env.split("\n").filter((l) => l.startsWith("NEXUS_")).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  assert.deepEqual(nexus, {
    NEXUS_PYLON: "1",
    NEXUS_PYLON_ID: "pylon-t1",
    NEXUS_THREAD_ID: "it's $HOME `id`",
    NEXUS_PROJECT: "acme-web",
    NEXUS_NODE: "rj-firebat",
    NEXUS_API: "http://nexus.pylon",
  });
});

test("pylon.json carries the overlay facts for nexus info --json", () => {
  assert.deepEqual(JSON.parse(renderOverlay(overlay)[1]!.content), {
    pylonId: "pylon-t1",
    threadId: "t1",
    project: "acme-web",
    node: "rj-firebat",
    api: "http://nexus.pylon",
    allowedHosts: ["api.openai.com", "registry.npmjs.org"],
    previews: [{ service: "web", url: "https://rj-firebat.example.ts.net:8443/" }],
    logins: ["chatgpt"],
    dotfiles: { repo: "git@github.com:ramtin/dotfiles.git", ref: "abc123" },
  });
});

test("PYLON.md tells the agent its hosts, previews, logins and how to declare outputs", () => {
  const md = renderOverlay(overlay)[2]!.content;
  for (const fact of ["Thread: t1", "- api.openai.com\n", "- registry.npmjs.org\n", "Every other host is blocked", "web: https://rj-firebat.example.ts.net:8443/", "chatgpt", "device-code", "nexus output add file", "only files on disk survive", "X-Forwarded-Proto: https", "server.allowedHosts"]) {
    assert.ok(md.includes(fact), `PYLON.md mentions ${JSON.stringify(fact)}`);
  }
  const bare = renderOverlay({ ...overlay, previews: [], logins: [] })[2]!.content;
  assert.match(bare, /No previews are published yet/);
  assert.match(bare, /no interactive logins/);
  assert.doesNotMatch(bare, /device-code/);
});

test("PYLON.md of a pylon granted the ChatGPT token says pi is signed in to it, and device-code only for the other logins", () => {
  const md = renderOverlay({ ...overlay, secrets: [chatgptTokenGrant] })[2]!.content;
  for (const fact of [
    "pi is already signed in to ChatGPT as its `openai` provider", "`openai/gpt-6-astra`", "Nexus rewrites that entry of ~/.pi/agent/auth.json on every boot",
    "`openai-codex` provider is not signed in, and needs no `/login`", "## Secrets", "- NEXUS_CHATGPT_TOKEN: api.openai.com\n",
  ]) assert.ok(md.includes(fact), `PYLON.md mentions ${JSON.stringify(fact)}`);
  assert.doesNotMatch(md, /device-code|no interactive logins/);

  const withClaude = renderOverlay({ ...overlay, logins: ["claude", "chatgpt"], secrets: [chatgptTokenGrant] })[2]!.content;
  assert.ok(withClaude.includes("This project also allows these logins: claude. Sign in with the device-code flow"));

  const bootedBefore = renderOverlay({ ...overlay, secrets: [] })[2]!.content;
  assert.ok(bootedBefore.includes("This project allows these logins: chatgpt. Sign in with the device-code flow"), "a pylon booted without the grant was not signed in");
  assert.doesNotMatch(bootedBefore, /signed in to ChatGPT/);
});

test("PYLON.md tells Claude Code to have a shepherdr reviewer check its diff before a pull request, and whether pi is signed in for it", () => {
  const md = renderOverlay({ ...overlay, secrets: [chatgptTokenGrant] })[2]!.content;
  for (const fact of [
    "## Review before a pull request", "`mcp__shepherdr__agents`", "Before you open a pull request or push to one", "`agent_type: \"reviewer\"`",
    "which findings you accepted and which you rejected, and why", "Without the tool, say the review was skipped",
    "The reviewer runs on pi's `openai` provider, which is signed in here",
  ]) assert.ok(md.includes(fact), `PYLON.md mentions ${JSON.stringify(fact)}`);
  const notGranted = renderOverlay({ ...overlay, secrets: [] })[2]!.content;
  assert.ok(notGranted.includes("This pylon was not granted the ChatGPT token"), "says why the reviewer cannot run");
  assert.ok(notGranted.includes("the review was skipped and why"));
  assert.doesNotMatch(notGranted, /which is signed in here/);
});

test("PYLON.md of a scratch project with GitHub access says nothing is kept and how to publish without inventing an author", () => {
  const md = renderOverlay({ ...overlay, repo: { kind: "empty", branch: "trunk" }, secrets: [githubTokenGrant] })[2]!.content;
  for (const fact of [
    "new repository on branch trunk with no commits and no remote", "Nothing in this pylon is kept when the thread is deleted",
    "Nexus has no git identity configured", "do not invent an identity",
    "gh repo create <owner>/<name> --private --source . --remote origin --push", "Use HTTPS remotes",
    "## Secrets", "- GH_TOKEN: api.github.com, github.com\n", "changes on every boot",
  ]) assert.ok(md.includes(fact), `PYLON.md mentions ${JSON.stringify(fact)}`);
  assert.doesNotMatch(md, /ask the human which name/);
});

test("PYLON.md of a scratch project without GitHub access says how to get it and to ask for a git author", () => {
  const md = renderOverlay({ ...overlay, repo: { kind: "empty", branch: "main" } })[2]!.content;
  assert.ok(md.includes("new repository on branch main with no commits and no remote"));
  assert.ok(md.includes("--scratch --secret GH_TOKEN:api.github.com,github.com"), "names the grant to ask for");
  assert.ok(md.includes("ask the human; do not invent an identity"));
  assert.doesNotMatch(md, /gh repo create|## Secrets|gh api user/);
});

test("PYLON.md of a clone names its remote, and never infers an author from GitHub access", () => {
  const md = renderOverlay(overlay)[2]!.content;
  assert.ok(md.includes("is a clone of git@github.com:ramtin/acme-web.git, on branch main from origin/main"));
  assert.ok(md.includes("ask the human; do not invent an identity"));
  assert.doesNotMatch(md, /gh repo create|## Secrets|GH_TOKEN/);

  const granted = renderOverlay({ ...overlay, secrets: [githubTokenGrant, { name: "STRIPE_KEY", hosts: ["api.stripe.com"] }] })[2]!.content;
  for (const fact of ["Nexus has no git identity configured", "- GH_TOKEN: api.github.com, github.com\n", "- STRIPE_KEY: api.stripe.com\n"]) {
    assert.ok(granted.includes(fact), `PYLON.md mentions ${JSON.stringify(fact)}`);
  }
  assert.doesNotMatch(granted, /gh repo create|ask the human which name/);
});

test("a secret grant names an upper-case variable and sends it to hostnames of two labels or more", () => {
  assert.ok(secretNamePattern.test("GH_TOKEN"));
  assert.ok(secretHostPattern.test("api.github.com"));
  assert.ok(!secretNamePattern.test("gh_token"), "a lower-case name");
  assert.ok(!secretHostPattern.test("localhost"), "a single-label host");
});

test("installFileCommand makes the parent as a user owner, as root for root, and installs with the owner's group and mode, a path with a space and a quote intact", (t) => {
  const bin = mkdtempSync(join(tmpdir(), "nexus-install-"));
  t.after(() => rmSync(bin, { recursive: true }));
  const log = join(bin, "argv");
  const record = `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify([require("node:path").basename(process.argv[1]), ...process.argv.slice(2)]) + "\\n");\n`;
  for (const program of ["mkdir", "install", "runuser"]) writeFileSync(join(bin, program), record, { mode: 0o755 });
  writeFileSync(join(bin, "id"), "#!/bin/sh\necho \"group-of-$2\"\n", { mode: 0o755 });
  const run = (command: string) => {
    rmSync(log, { force: true });
    execFileSync("/bin/sh", ["-c", command], { env: { PATH: bin } });
    return execFileSync("/bin/cat", [log], { encoding: "utf8" }).trim().split("\n").map((line) => JSON.parse(line));
  };
  assert.deepEqual(run(installFileCommand("/etc/nexus/a.conf", "root", 0o644, "/staging/0")), [
    ["mkdir", "-p", "/etc/nexus"],
    ["install", "-o", "root", "-g", "group-of-root", "-m", "644", "/staging/0", "/etc/nexus/a.conf"],
  ]);
  const path = "/home/user/it's a dir/run me.sh";
  assert.deepEqual(run(installFileCommand(path, "user", 0o755, "/staging/it's 1")), [
    ["runuser", "-u", "user", "--", "mkdir", "-p", "/home/user/it's a dir"],
    ["install", "-o", "user", "-g", "group-of-user", "-m", "755", "/staging/it's 1", path],
  ]);
});

test("code that runs on nodes never imports project.ts, the control plane's Project record and overlay", () => {
  const src = new URL("./", import.meta.url);
  const nodeFiles = [
    ...["probe", "protocol", "pylon-vm"].flatMap((dir) => readdirSync(new URL(dir, src), { recursive: true, encoding: "utf8" })
      .filter((file) => /\.[jt]s$/.test(file) && !/\.(test|check)\.[jt]s$/.test(file)).map((file) => `${dir}/${file}`)),
    "backend.ts", "docker-backend.ts", "docker-services.ts", "pylon-vm-backend.ts", "images.ts",
  ];
  const importers = nodeFiles.filter((file) => /\b(?:from|import)\s*\(?\s*["'][^"']*\/project\.ts["']/.test(readFileSync(new URL(file, src), "utf8")));
  assert.deepEqual(importers, []);
});
