import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { checkCaller, verifyCaller } from "../agent-protocol.ts";
import { checkRuns, imageEnv, verifyGate, verifyMemoryGiB, type CheckRuns, type CheckState } from "./gate.ts";
import { openRegistry, type Thread, type ThreadId } from "./registry.ts";
import { newPylonRecord } from "../tick.ts";
import { processStream } from "../process-stream.ts";
import { checkoutDir } from "../sessions.ts";
import type { ByteStream, LiveHash, NodeName, PylonId, TailnetNodeId } from "../protocol.ts";
import type { ProjectId } from "../project.ts";
import type { StartRequest } from "./threads.ts";

const node = "node" as NodeName;

/**
 * A registry whose check threads' pylons run here: each pipe runs its argv as a local process, in a checkout with one
 * commit whose `.nexus/check` is `check` and `.nexus/verify` is `verify`, so the script and the exit status are real. The image's environment is
 * read from the file `image`, NUL-separated as /proc/1/environ is. `stream` can be replaced.
 */
async function fixture(t: import("node:test").TestContext, check: string | null, verify: string | null = null) {
  const root = await mkdtemp(join(tmpdir(), "nexus-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "# repo\n");
  if (check !== null) {
    await mkdir(join(repo, ".nexus"));
    await writeFile(join(repo, ".nexus", "check"), `#!/bin/sh\n${check}\n`);
    await chmod(join(repo, ".nexus", "check"), 0o755);
  }
  if (verify !== null) {
    await writeFile(join(repo, ".nexus", "verify"), `#!/bin/sh\n${verify}\n`);
    await chmod(join(repo, ".nexus", "verify"), 0o755);
  }
  git("add", "-A");
  git("commit", "-qm", "init");
  const head = git("rev-parse", "HEAD");
  const image = join(root, "environ");
  await writeFile(image, `PATH=${process.env.PATH}\0NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt\0HOME=/root\0`);

  const registry = openRegistry(":memory:");
  t.after(() => registry.close());
  const project = { id: "p" as ProjectId, repoUrl: "https://github.com/acme/repo.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 1, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null };
  registry.upsertNode({ name: node, tailnetHost: "node.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
  registry.createProject(project);
  let count = 0;
  function add(caller: string): Thread {
    const id = `th-${++count}` as ThreadId;
    const thread: Thread = { id, title: id, project: project.id, pylonId: `pylon-${id}` as PylonId, status: "active", conversationId: null, startedBy: caller, createdAt: 1, seenAt: null, lastReplyAt: null, lastHumanActivityAt: 1, lastAgentActivityAt: 0, agentTurnRunning: false, working: false };
    const { desired: _, ...pylon } = newPylonRecord({ thread: id, pylonId: thread.pylonId, node, desired: "running", boot: { pylonId: thread.pylonId, image: "img-000000000000", resources: project.resources, network: { allowedHosts: [], secrets: [] }, repo: { kind: "clone", url: project.repoUrl, checkout: { branch: "main", commit: head } }, dotfiles: { repo: project.repoUrl, ref: "main" } }, firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "hash" as LiveHash });
    registry.createThread(thread, pylon);
    return thread;
  }
  function running(...threads: Thread[]) {
    const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
    registry.apply({ record: "node", node, state: "online", capacity });
    const pylons = threads.map((th) => ({ pylonId: th.pylonId, phase: "running" as const, liveHash: "hash" as LiveHash, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: "img-000000000000" as const, checkpoint: null }, services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0 }));
    registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", events: [], capacity, artifacts: [], jobs: [], pylons, grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
  }
  const builder = add("person");
  const started: StartRequest[] = [];
  const local = (argv: readonly string[]) => argv.map((a) => a.replaceAll(checkoutDir, repo).replace(imageEnv, `cat ${image}`));
  let stream = async (_: PylonId, argv: readonly string[]): Promise<ByteStream> => processStream(argv[0]!, local(argv).slice(1), () => {});
  const runs = (gate?: typeof verifyGate): CheckRuns => checkRuns({
    registry, wake: () => {}, ...gate === undefined ? {} : { gate },
    probes: new Map([[node, { stream: (pylon: PylonId, argv: readonly string[]) => stream(pylon, argv) }]]),
    async startThread(request, caller) { started.push(request); return add(caller); },
  });
  return { registry, builder, head, repo, root, image, local, started, runs, running, set stream(s: typeof stream) { stream = s; } };
}

/** Polls until the check ends. The deadline only ends a hang: a loaded suite can take seconds over what takes milliseconds alone. */
async function settle(poll: () => CheckState): Promise<CheckState> {
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    const state = poll();
    if (state.kind === "done" || state.kind === "void" || state.kind === "unrunnable") return state;
    await sleep(20);
  }
  assert.fail("the check never finished");
}

test("a check runs in a fresh bare check thread at the commit, and its verdict is the pipe's exit status", async (t) => {
  const f = await fixture(t, "echo typecheck ok; echo tests ok");
  const runs = f.runs();
  const id = await runs.start(f.builder, "feature", f.head);
  assert.deepEqual(f.started, [{ project: "p", title: `Check of feature at ${f.head.slice(0, 12)}`, node, branch: "feature", commit: f.head, bare: true }]);
  assert.equal(f.registry.thread(id)!.startedBy, checkCaller);
  assert.deepEqual(runs.poll(id, f.head), { kind: "waiting" }, "nothing runs until the pylon does");
  f.running(f.registry.thread(id)!);
  assert.deepEqual(await settle(() => runs.poll(id, f.head)), { kind: "done", passed: true, output: "typecheck ok\ntests ok" });
  runs.discard(id);
  assert.equal(f.registry.thread(id)!.status, "deleted");
});

test("a live check runs .nexus/verify in a fresh verify pylon that asks for nested virtualization, which is archived afterwards", async (t) => {
  const f = await fixture(t, "echo tests ok", "echo fleet booted; exit 4");
  const runs = f.runs(verifyGate);
  const id = await runs.start(f.builder, "feature", f.head);
  assert.deepEqual(f.started, [{
    project: "p", title: `Live check of feature at ${f.head.slice(0, 12)}`, node: "auto", branch: "feature", commit: f.head, bare: true,
    resources: { memoryGiB: verifyMemoryGiB, nestedVirtualization: true },
  }]);
  assert.equal(f.registry.thread(id)!.startedBy, verifyCaller);
  f.running(f.registry.thread(id)!);
  assert.deepEqual(await settle(() => runs.poll(id, f.head)), { kind: "done", passed: false, output: "fleet booted" }, ".nexus/verify ran, not .nexus/check");
  runs.discard(id);
  assert.equal(f.registry.thread(id)!.status, "archived");

  const none = await fixture(t, "echo tests ok");
  const missing = none.runs(verifyGate);
  const unrunnable = await missing.start(none.builder, "feature", none.head);
  none.running(none.registry.thread(unrunnable)!);
  assert.deepEqual(await settle(() => missing.poll(unrunnable, none.head)), { kind: "unrunnable", output: `The repository has no executable .nexus/verify at ${none.head}.` });
});

test("what the check writes cannot pass it: a forged exit file or a printed status counts for nothing", async (t) => {
  const f = await fixture(t, `mkdir -p "$HOME/.nexus-checks"; echo 0 > exit; echo "done 0"; exit 3`);
  const runs = f.runs();
  const id = await runs.start(f.builder, "feature", f.head);
  f.running(f.registry.thread(id)!);
  const state = await settle(() => runs.poll(id, f.head));
  assert.equal(state.kind === "done" && state.passed, false);
});

test("the check runs in the image's environment, which the pipe's own shell lacks", async (t) => {
  const f = await fixture(t, `echo "$NODE_EXTRA_CA_CERTS $HOME"; [ -n "$NODE_EXTRA_CA_CERTS" ]`);
  f.stream = async (_, argv) => processStream("env", ["-i", `HOME=${f.root}`, "PATH=/usr/bin:/bin", ...f.local(argv)], () => {});
  const runs = f.runs();
  const id = await runs.start(f.builder, "feature", f.head);
  f.running(f.registry.thread(id)!);
  assert.deepEqual(await settle(() => runs.poll(id, f.head)), { kind: "done", passed: true, output: `/run/gondolin/ca-certificates.crt ${f.root}` }, "the image's CA, and the pipe's own HOME");

  await writeFile(f.image, "");
  const unread = await runs.start(f.builder, "feature", f.head);
  f.running(f.registry.thread(unread)!);
  assert.deepEqual(await settle(() => runs.poll(unread, f.head)), { kind: "unrunnable", output: "The check pylon's image environment could not be read." });
});

test("a check the pylon cannot run says so instead of failing: no .nexus/check, a missing command, or a pylon that did not boot", async (t) => {
  const none = await fixture(t, null);
  const runs = none.runs();
  const id = await runs.start(none.builder, "feature", none.head);
  none.running(none.registry.thread(id)!);
  const state = await settle(() => runs.poll(id, none.head));
  assert.ok(state.kind === "unrunnable" && /no executable \.nexus\/check/.test(state.output));

  const tool = await fixture(t, "echo installing; nexus-no-such-tool ci");
  const toolRuns = tool.runs();
  const toolId = await toolRuns.start(tool.builder, "feature", tool.head);
  tool.running(tool.registry.thread(toolId)!);
  const missing = await settle(() => toolRuns.poll(toolId, tool.head));
  assert.ok(missing.kind === "unrunnable" && /installing\n.*nexus-no-such-tool.*not found/.test(missing.output), JSON.stringify(missing));

  const failedBoot = await toolRuns.start(tool.builder, "feature", tool.head);
  const pylon = tool.registry.pylon(tool.registry.thread(failedBoot)!.pylonId)!;
  tool.registry.savePylon({ ...pylon, failed: ".nexus/setup exited 1" });
  assert.deepEqual(toolRuns.poll(failedBoot, tool.head), { kind: "unrunnable", output: "The check pylon did not boot: .nexus/setup exited 1" });
});

test("a run that cannot give a verdict is void: a pylon at the wrong commit, a lost pipe, or a run this process does not hold", async (t) => {
  const f = await fixture(t, "true");
  const runs = f.runs();
  const wrong = await runs.start(f.builder, "feature", f.head);
  f.running(f.registry.thread(wrong)!);
  assert.deepEqual(await settle(() => runs.poll(wrong, "f".repeat(40))), { kind: "void" }, "a checkout at another commit says nothing of the change");

  const lost = await runs.start(f.builder, "feature", f.head);
  f.stream = async () => ({ ...processStream("true", [], () => {}), done: Promise.resolve({ kind: "lost" as const }) });
  f.running(f.registry.thread(lost)!);
  assert.deepEqual(await settle(() => runs.poll(lost, f.head)), { kind: "void" });

  const restarted = f.runs();
  assert.deepEqual(restarted.poll(lost, f.head), { kind: "void" }, "after a restart, nothing says what the thread already ran");
});

test("a pipe that fails while it is consumed voids the run and deletes its check thread, with no unhandled rejection", async (t) => {
  for (const failure of ["close", "read"] as const) {
    const f = await fixture(t, "true");
    const runs = f.runs();
    const id = await runs.start(f.builder, "feature", f.head);
    f.stream = async () => ({
      write: async () => {},
      close: async () => { if (failure === "close") throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" }); },
      abort: () => {},
      done: Promise.resolve({ kind: "lost" as const }),
      async *[Symbol.asyncIterator]() { if (failure === "read") throw new Error("socket hang up"); yield new Uint8Array(); },
    });
    f.running(f.registry.thread(id)!);
    assert.deepEqual(await settle(() => runs.poll(id, f.head)), { kind: "void" }, `a failed ${failure}`);
    assert.equal(f.registry.thread(id)!.status, "deleted");
  }
});

test("a check that exits 75 is void, so it runs again in a fresh check thread, and three such runs in a row at a head are unrunnable", async (t) => {
  const f = await fixture(t, "echo npm error code ETIMEDOUT; exit 75");
  const runs = f.runs();
  const run = async () => {
    const id = await runs.start(f.builder, "feature", f.head);
    f.running(f.registry.thread(id)!);
    const state = await settle(() => runs.poll(id, f.head));
    return { state, status: f.registry.thread(id)!.status };
  };
  assert.deepEqual(await run(), { state: { kind: "void" }, status: "deleted" }, "the first transient run says nothing of the change");
  assert.deepEqual(await run(), { state: { kind: "void" }, status: "deleted" });
  assert.deepEqual((await run()).state, { kind: "unrunnable", output: "The check exited 75, a transient failure, 3 runs in a row. The last printed:\nnpm error code ETIMEDOUT" });
  assert.deepEqual((await run()).state, { kind: "void" }, "the count starts again after it went to the person");

  const failing = await fixture(t, "echo 1 test failed; exit 1");
  const failingRuns = failing.runs();
  const id = await failingRuns.start(failing.builder, "feature", failing.head);
  failing.running(failing.registry.thread(id)!);
  assert.deepEqual(await settle(() => failingRuns.poll(id, failing.head)), { kind: "done", passed: false, output: "1 test failed" }, "any other failure is still a verdict");
});
