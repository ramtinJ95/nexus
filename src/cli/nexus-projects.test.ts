/**
 * nexus project and nexus item, against the control plane's real API with a fake harness behind it. src/test-
 * support/cli-kit.ts says when a test runs the CLI in its own process and when as a child.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineItem } from "../control/pipeline.ts";
import type { Thread } from "../control/thread-store.ts";
import { defaultProjectResources, type Project } from "../control/project.ts";
import type { ProjectId } from "../ids.ts";
import { freePort } from "../test-support/kit.ts";
import { cli, node, laptop, phone, project, setup } from "../test-support/cli-kit.ts";

test("project add sizes a project at 2 CPUs, 4 GiB of memory and 10 GiB of disk, and each size flag overrides its own field", async (t) => {
  const s = await setup(t);
  const repo = "https://github.com/octocat/Hello-World.git";
  assert.deepEqual((await s.json(["project", "add", "plain", repo, "--node", node])).resources, { cpus: 2, memoryGiB: 4, diskGiB: 10 });
  assert.deepEqual((await s.json(["project", "add", "big", repo, "--node", node, "--memory", "6"])).resources, { cpus: 2, memoryGiB: 6, diskGiB: 10 });
  assert.deepEqual((await s.json(["project", "add", "wide", repo, "--node", node, "--cpus", "4"])).resources, { cpus: 4, memoryGiB: 4, diskGiB: 10 });
  assert.deepEqual(s.registry.projects.project("big" as ProjectId)?.resources, { cpus: 2, memoryGiB: 6, diskGiB: 10 });
});

test("project add creates a project with the contract's defaults or its flags, and maps the API's refusals", async (t) => {
  const s = await setup(t);
  const repo = "https://github.com/octocat/Hello-World.git";
  const added = await s.nexus(["project", "add", "hello", repo, "--node", node]);
  assert.deepEqual([added.code, added.stdout, added.stderr], [0, `Added project hello (${repo}) on ${node}\n`, ""]);
  assert.deepEqual(s.registry.projects.project("hello" as ProjectId), {
    id: "hello", repoUrl: repo, defaultBranch: "main", defaultNode: node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  }, "an unflagged project gets main, 2 CPUs, 4 GiB of memory and 10 GiB of disk");
  assert.deepEqual(s.registry.projects.project("hello" as ProjectId)?.resources, defaultProjectResources, "the resources the dashboard's new-project dialog gives");

  const custom = await s.json([
    "project", "add", "custom", "git@github.com:octocat/Spoon-Knife.git", "--node", node, "--branch", "dev", "--cpus", "4", "--memory", "8", "--disk", "20",
    "--allow-host", "registry.npmjs.org", "--login", "claude", "--allow-host", "api.stripe.com", "--login", "chatgpt",
  ]);
  assert.deepEqual(custom, {
    id: "custom", repoUrl: "git@github.com:octocat/Spoon-Knife.git", defaultBranch: "dev", defaultNode: node,
    resources: { cpus: 4, memoryGiB: 8, diskGiB: 20 }, allowedHosts: ["registry.npmjs.org", "api.stripe.com"], secrets: [], logins: ["claude", "chatgpt"], preSetup: null,
  }, "--json prints the created project, with each repeated flag's values in order");
  assert.deepEqual(s.registry.projects.project("custom" as ProjectId), custom);
  assert.deepEqual((await s.json(["projects"])).map((p: Project) => p.id).toSorted(), ["acme", "custom", "hello"]);

  const fails = async (args: readonly string[], code: number, error: Record<string, unknown>, overrides?: Record<string, string>) => {
    const res = await s.nexus([...args, "--json"], overrides);
    assert.equal(res.code, code, `${args.join(" ")}: ${res.stderr}`);
    assert.equal(res.stdout, "");
    const reported = JSON.parse(res.stderr);
    assert.deepEqual(Object.fromEntries(Object.keys(error).map((k) => [k, reported[k]])), error);
  };
  await fails(["project", "add", "hello", repo, "--node", node], 5, { kind: "conflict", status: 409, error: "project hello exists" });
  await fails(["project", "add", "other", repo, "--node", "nowhere"], 64, { kind: "invalid", status: 400, error: "no node nowhere" });
  await fails(["project", "add", "Not_An_Id", repo, "--node", node], 64, { kind: "invalid", status: 400 });
  await fails(["project", "add", "other", "https://", "--node", node], 64, { kind: "invalid", status: 400 });
  await fails(["project", "add", "other", repo, "--node", node, "--login", "gemini"], 64, { kind: "invalid", status: 400 });
  await fails(["project", "add", "other", repo, "--node", node, "--cpus", "two"], 64, { kind: "invalid", status: null, error: "--cpus takes a whole number, got two" });
  await fails(["project", "add"], 64, { kind: "invalid", status: null, error: "project add takes 1 to 2 arguments, got 0" });
  await fails(["project", "other"], 64, { kind: "invalid", status: null, error: "unknown command project" });
  assert.deepEqual(s.registry.projects.projects().map((p) => p.id).toSorted(), ["acme", "custom", "hello"], "no refused project was created");

  const spread = await s.nexus(["project", "add", "spread", repo]);
  assert.deepEqual([spread.code, spread.stdout, spread.stderr], [0, `Added project spread (${repo}) on auto\n`, ""]);
  assert.equal(s.registry.projects.project("spread" as ProjectId)!.defaultNode, "auto", "without --node its threads boot where they fit best");
});

test("project add --scratch makes a project with no repository, --secret grants each NAME:HOST in order, and start cannot pin its commit", async (t) => {
  const s = await setup(t);
  const added = await s.nexus(["project", "add", "sketch", "--scratch", "--node", node, "--secret", "GH_TOKEN:api.github.com,github.com", "--secret", "EXA_API_KEY:api.exa.ai"]);
  assert.deepEqual([added.code, added.stdout, added.stderr], [0, `Added scratch project sketch on ${node}\n`, ""]);
  assert.deepEqual(s.registry.projects.project("sketch" as ProjectId), {
    id: "sketch", repoUrl: null, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [],
    secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com", "github.com"] }, { name: "EXA_API_KEY", hosts: ["api.exa.ai"] }], logins: [], preSetup: null,
  });
  assert.match((await s.nexus(["projects"])).stdout, /^sketch +node rj-firebat +branch main +auto review off +pipeline off +scratch$/m);

  const pinned = await s.nexus(["start", "--project", "sketch", "--title", "x", "--commit", "abc123", "--json"]);
  assert.equal(pinned.code, 64);
  assert.deepEqual((({ kind, status, error }) => ({ kind, status, error }))(JSON.parse(pinned.stderr)), { kind: "invalid", status: 400, error: "project sketch is a scratch project, so it has no commit to check out" });

  // Through a proxy nothing listens on, so each of these fails before it sends a request.
  const offline = { NEXUS_SOCKS: `127.0.0.1:${await freePort()}` };
  const refused = async (args: readonly string[], error: string) => {
    const res = await s.nexus(["project", "add", "other", ...args, "--node", node, "--json"], offline);
    assert.deepEqual([res.code, res.stdout], [64, ""], `${args.join(" ")}: ${res.stderr}`);
    assert.deepEqual((({ kind, status, error }) => ({ kind, status, error }))(JSON.parse(res.stderr)), { kind: "invalid", status: null, error }, args.join(" "));
    return res.stderr;
  };
  const either = "project add takes a <repo-url> or --scratch, and not both";
  await refused(["https://github.com/octocat/Hello-World.git", "--scratch"], either);
  await refused([], either);
  const grant = "--secret takes NAME:HOST[,HOST...], an upper-case name and lower-case hostnames, such as GH_TOKEN:api.github.com,github.com. The value stays in each node's secret file";
  assert.doesNotMatch(await refused(["--scratch", "--secret", "GH_TOKEN=ghp_pastedbymistake"], grant), /ghp_pastedbymistake/, "a pasted token is not repeated");
  for (const malformed of ["gh_token:github.com", "GH_TOKEN:", "GH_TOKEN:github.com,", "GH_TOKEN:ghp_pastedbymistake", "GH_TOKEN:GitHub.com"]) {
    await refused(["--scratch", "--secret", malformed], grant);
  }
  assert.deepEqual(s.registry.projects.projects().map((p) => p.id).toSorted(), ["acme", "sketch"], "no refused project was created");
});

test("project edit replaces supplied grants and preserves omitted settings", async (t) => {
  const repo = "https://github.com/example/repo.git";
  const s = await setup(t);
  await s.nexus(["project", "add", "editable", repo, "--node", node]);
  const changed = await s.nexus(["project", "edit", "editable", "--login", "claude", "--secret", "CLAUDE_CODE_OAUTH_TOKEN:api.anthropic.com", "--git-name", "Example Person", "--git-email", "person@example.com", "--json"]);
  assert.equal(changed.code, 0, changed.stderr);
  const p = JSON.parse(changed.stdout);
  assert.deepEqual(p.secrets, [{ name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com"] }]);
  assert.equal(p.repoUrl, repo);
  assert.equal(p.defaultNode, node);
  assert.equal((await s.nexus(["project", "edit", "editable", "--secret", "TOKEN:*.example.com"])).code, 64);
  assert.equal((await s.json(["project", "edit", "editable", "--node", "auto"])).defaultNode, "auto");
  assert.match((await s.nexus(["projects"])).stdout, /^editable +node auto +branch main/m);
  const cleared = await s.nexus(["project", "edit", "editable", "--clear-secrets", "--clear-git-identity", "--json"]);
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.deepEqual(JSON.parse(cleared.stdout).secrets, []);
  assert.equal(JSON.parse(cleared.stdout).gitIdentity, null);
});

test("project edit turns reviews of its own on and off, and projects shows who turned them on", async (t) => {
  const s = await setup(t);
  await s.nexus(["project", "add", "auto", "--scratch", "--node", node]);
  assert.match((await s.nexus(["projects"])).stdout, new RegExp(`^auto +node ${node} +branch main +auto review off +pipeline off +scratch$`, "m"));
  assert.equal((await s.nexus(["project", "edit", "auto", "--auto-review", "always"])).code, 64);
  const landing = await s.nexus(["project", "edit", "auto", "--auto-review", "land"]);
  assert.equal(landing.stdout, `Updated project auto, auto review and land, for ${laptop}, pipeline off. Existing threads keep their boot settings and grants; start a new thread to apply them.\n`);
  assert.match((await s.nexus(["projects"])).stdout, new RegExp(`^auto +node ${node} +branch main +auto review and land, for ${laptop} +pipeline off +scratch$`, "m"));
  assert.deepEqual((await s.json(["project", "edit", "auto", "--auto-review", "review"])).autoReview, { mode: "review", enabledBy: laptop });
  const yolo = await s.nexus(["project", "edit", "auto", "--auto-review", "yolo"]);
  assert.equal(yolo.stdout, `Updated project auto, auto review and land, waiving holds, for ${laptop}, pipeline off. Existing threads keep their boot settings and grants; start a new thread to apply them.\n`);
  assert.match((await s.nexus(["project", "show", "auto"])).stdout, new RegExp(`^auto review and land, waiving holds, for ${laptop}, pipeline off$`, "m"));
  assert.equal((await s.json(["project", "edit", "auto", "--auto-review", "off"])).autoReview, undefined);
  const added = await s.nexus(["project", "add", "overnight", "--scratch", "--node", node, "--auto-review", "yolo"]);
  assert.equal(added.stdout, `Added scratch project overnight on ${node}, auto review and land, waiving holds, for ${laptop}\n`);
  assert.equal((await s.nexus(["project", "add", "bad", "--scratch", "--node", node, "--auto-review", "always"])).code, 64);
  assert.doesNotMatch((await s.nexus(["projects"])).stdout, /^bad /m, "an invalid value is refused before the add");
  s.callAs(phone);
  const refused = await s.nexus(["project", "add", "phoned", "--scratch", "--node", node, "--auto-review", "yolo"]);
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /^nexus: Added project phoned, but its auto review was not set: .*only deployers may.*\. Set it with nexus project edit phoned --auto-review/m);
});

test("project edit sets which pull requests get a second reviewer on another model, and project show says it", async (t) => {
  const s = await setup(t);
  await s.nexus(["project", "add", "second", "--scratch", "--node", node]);
  for (const bad of ["yes", "lines=0", "reserved,reserved", "lines=1,lines=2", "lines"]) assert.equal((await s.nexus(["project", "edit", "second", "--second-reviewer", bad])).code, 64, bad);
  const on = await s.nexus(["project", "edit", "second", "--second-reviewer", "on"]);
  assert.equal(on.stdout, "Updated project second, auto review off, pipeline off, a second reviewer on another model for a pull request with a reserved path hold or at least 150 changed lines. Existing threads keep their boot settings and grants; start a new thread to apply them.\n");
  assert.deepEqual((await s.json(["project", "edit", "second", "--second-reviewer", "lines=400"])).secondReview, { always: false, lines: 400, reserved: false });
  assert.deepEqual((await s.json(["project", "edit", "second", "--second-reviewer", "always"])).secondReview, { always: true });
  assert.match((await s.nexus(["project", "show", "second"])).stdout, /^a second reviewer on another model for every pull request$/m);
  assert.deepEqual((await s.json(["project", "edit", "second", "--node", node])).secondReview, { always: true }, "an edit that does not name it keeps it");
  assert.equal((await s.json(["project", "edit", "second", "--second-reviewer", "off"])).secondReview, undefined);
  assert.doesNotMatch((await s.nexus(["project", "show", "second"])).stdout, /second reviewer/);
});

test("project add and edit set standing rules from a file or stdin, edit clears them, and project show and show print them", async (t) => {
  const s = await setup(t);
  const dir = await mkdtemp(join(tmpdir(), "nexus-rules-"));
  t.after(() => rm(dir, { recursive: true }));
  const file = join(dir, "rules.md");
  await writeFile(file, "- Run npm test before you push.\n");
  const added = await s.nexus(["project", "add", "ruled", "--scratch", "--node", node, "--rules-file", file]);
  assert.deepEqual([added.code, added.stdout, added.stderr], [0, `Added scratch project ruled on ${node}, with standing rules\n`, ""]);
  const ruled = () => s.registry.projects.project("ruled" as ProjectId)!;
  assert.deepEqual(ruled().standingRules, { text: "- Run npm test before you push.", revision: 1 });

  const show = await s.nexus(["project", "show", "ruled"]);
  assert.deepEqual([show.code, show.stdout], [0, [
    "ruled: scratch",
    `node ${node}, branch main, 2 CPUs, 4 GiB memory, 10 GiB disk`,
    "hosts: none. logins: none. secrets: none",
    "auto review off, pipeline off",
    "",
    "Standing rules, revision 1:",
    "",
    "- Run npm test before you push.",
    "",
  ].join("\n")]);
  assert.deepEqual(await s.json(["project", "show", "ruled"]), ruled(), "--json prints the project");

  const piped = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, [cli, "project", "edit", "ruled", "--rules-file", "-"], { env: s.env() }, (err, stdout, stderr) => {
      resolve({ code: err === null ? 0 : (err as { code: number }).code, stdout, stderr });
    });
    child.stdin!.end("- Keep commits small.\n");
  });
  assert.equal(piped.code, 0, piped.stderr);
  assert.match(piped.stdout, / Builder threads started from now get its standing rules, revision 2\.\n$/);
  assert.deepEqual(ruled().standingRules, { text: "- Keep commits small.", revision: 2 }, "- reads stdin");

  const thread: Thread = await s.json(["start", "--project", "ruled", "--message", "Fix the build"]);
  assert.equal(s.fake.transcript(thread.id).messages[0]!.content, "Fix the build\n\n## Standing rules for this project\n\n- Keep commits small.");
  assert.match((await s.nexus(["show", thread.id])).stdout, /^standing rules: revision 2 of the project's, sent with its first message$/m);

  const fails = async (args: readonly string[], code: number, error: Record<string, unknown>) => {
    const res = await s.nexus([...args, "--json"]);
    assert.deepEqual([res.code, res.stdout], [code, ""], `${args.join(" ")}: ${res.stderr}`);
    const reported = JSON.parse(res.stderr);
    assert.deepEqual(Object.fromEntries(Object.keys(error).map((k) => [k, reported[k]])), error, args.join(" "));
  };
  await fails(["project", "edit", "ruled", "--rules-file", file, "--clear-rules"], 64, { kind: "invalid", status: null, error: "--clear-rules conflicts with --rules-file" });
  await fails(["project", "edit", "ruled", "--rules-file", join(dir, "missing.md")], 64, { kind: "invalid", status: null });
  await writeFile(join(dir, "empty.md"), "\n");
  await fails(["project", "edit", "ruled", "--rules-file", join(dir, "empty.md")], 64, { kind: "invalid", status: 400 });
  await fails(["project", "show", "nope"], 4, { kind: "not-found", status: null, error: "no project nope" });
  assert.deepEqual(ruled().standingRules, { text: "- Keep commits small.", revision: 2 }, "no refused edit changed the rules");

  assert.deepEqual((await s.json(["project", "edit", "ruled", "--clear-rules"])).standingRules, { text: null, revision: 3 });
  assert.match((await s.nexus(["project", "show", "ruled"])).stdout, /\n\nNo standing rules, cleared at revision 3\.\n$/);
  assert.match((await s.nexus(["project", "show", "acme"])).stdout, /\n\nNo standing rules\.\n$/);
});

test("concurrent project edits preserve independently changed resources", async (t) => {
  const s = await setup(t);
  assert.equal((await s.nexus(["project", "add", "concurrent", "--scratch", "--node", node, "--cpus", "1", "--memory", "3", "--disk", "10"])).code, 0);
  const before = s.proxy.connects.length;
  const edits = await Promise.all([
    s.nexus(["project", "edit", "concurrent", "--cpus", "4"]),
    s.nexus(["project", "edit", "concurrent", "--memory", "8"]),
  ]);
  for (const result of edits) assert.equal(result.code, 0, result.stderr);
  assert.equal(s.proxy.connects.length - before, 4, "each edit reads health, then sends only its PATCH, without reading the project first");
  const projects = await s.json(["projects"]);
  assert.deepEqual(projects.find((p: Project) => p.id === "concurrent").resources, { cpus: 4, memoryGiB: 8, diskGiB: 10 });
});

test("project add and edit exit 64 for duplicate secret names and explain how to combine hosts", async (t) => {
  const s = await setup(t);
  const before = s.registry.projects.project(project.id);
  for (const args of [
    ["project", "add", "duplicate", "--scratch", "--node", node],
    ["project", "edit", project.id],
  ]) {
    const result = await s.nexus([...args, "--secret", "TOKEN:a.example", "--secret", "TOKEN:b.example", "--json"]);
    assert.equal(result.code, 64);
    const error = JSON.parse(result.stderr);
    assert.equal(error.status, 400);
    assert.match(error.error, /duplicate secret names: list all of a secret's hosts in one grant/);
  }
  assert.equal(s.registry.projects.project("duplicate" as ProjectId), undefined);
  assert.deepEqual(s.registry.projects.project(project.id), before);
  const added = await s.json(["project", "add", "combined", "--scratch", "--node", node, "--secret", "TOKEN:a.example,b.example"]);
  assert.deepEqual(added.secrets, [{ name: "TOKEN", hosts: ["a.example", "b.example"] }]);
  const edited = await s.json(["project", "edit", project.id, "--secret", "TOKEN:a.example,b.example"]);
  assert.deepEqual(edited.secrets, added.secrets);
});

test("item add lines up items behind each other, project edit --pipeline decides whether they start on their own, and items and item show say each one's phase", async (t) => {
  const s = await setup(t, { queue: true });
  const off = await s.nexus(["item", "add", "--project", "acme", "--message", "Build A"]);
  assert.deepEqual([off.code, off.stderr], [5, "nexus: the pipeline does not run for project acme. nexus project edit acme --pipeline start turns it on\n"]);
  assert.equal((await s.nexus(["item", "add", "--project", "acme", "--title", "No brief"])).code, 64);
  assert.equal((await s.nexus(["project", "edit", "acme", "--pipeline", "sometimes"])).code, 64);
  assert.match((await s.nexus(["project", "edit", "acme", "--pipeline", "approve"])).stdout, /^Updated project acme, auto review off, pipeline waits for approval\./);
  assert.match((await s.nexus(["projects"])).stdout, /^acme\s+node rj-firebat\s+branch main\s+auto review off\s+pipeline waits for approval\s/m);

  const added = await s.nexus(["item", "add", "--project", "acme", "--message", "Build A\nwith tests"]);
  assert.equal(added.code, 0, added.stderr);
  const [a] = s.registry.pipeline.items();
  assert.equal(added.stdout, `Added ${a!.id} to acme: Build A. It is held: project acme waits for the person to approve each item: nexus item approve ${a!.id}.\n`);
  const b: PipelineItem = await s.json(["item", "add", "--project", "acme", "--title", "B", "--claude", "Build B", "--model", "claude-sonnet-5-5", "--after", a!.id]);
  assert.deepEqual([b.worker, b.model, b.brief, b.after, b.phase.kind], ["claude", "claude-sonnet-5-5", "Build B", [a!.id], "planned"]);
  assert.equal((await s.nexus(["item", "add", "--project", "acme", "--message", "x", "--after", "it-000000000000"])).code, 4);

  const approved = await s.nexus(["item", "approve", a!.id]);
  assert.equal(approved.code, 0, approved.stderr);
  const thread = s.registry.queue.queuedThread(s.registry.queue.queuedThreads()[0]!.id)!;
  assert.match(approved.stdout, new RegExp(`^Approved ${a!.id}\\. It is (queued|building): `));
  assert.equal(thread.message, "Build A\nwith tests", "the brief is the queued thread's first message");
  const cancelled = await s.nexus(["item", "cancel", b.id]);
  assert.equal(cancelled.stdout, `Cancelled ${b.id}. It will never become a thread.\n`);
  assert.equal((await s.nexus(["item", "cancel", a!.id])).code, 5, "an item that is a thread is cancelled by archiving its thread");

  const rows = (await s.nexus(["items"])).stdout;
  assert.match(rows, new RegExp(`^${a!.id}\\s+(queued|building)\\s+.+\\s+${thread.id}\\s+acme\\s+\\S+ ago\\s+Build A$`, "m"));
  assert.doesNotMatch(rows, new RegExp(b.id), "a cancelled item is listed only with --all");
  assert.match((await s.nexus(["items", "--all"])).stdout, new RegExp(`^${b.id}\\s+cancelled\\s+cancelled by nLAPTOP\\s+no thread yet\\s`, "m"));
  assert.deepEqual((await s.json(["items", "--project", "other"])), []);
  const shown = (await s.nexus(["item", "show", b.id])).stdout;
  assert.equal(shown, [
    `${b.id}  B`, "project: acme", "phase: cancelled, cancelled by nLAPTOP", "thread: none yet", "worker: Claude worker, model claude-sonnet-5-5", `after: ${a!.id}`, "brief: Build B",
    shown.split("\n")[7], "",
  ].join("\n"));
  assert.match(shown.split("\n")[7]!, /^added by nLAPTOP \S+ ago$/);
  assert.equal((await s.nexus(["item", "show", "it-000000000000"])).code, 4);
});
