/**
 * Runs the repository's `.nexus/check`, its typecheck and full test suite, at an approved commit, for the merge
 * policy's "the typecheck and the full test suite pass".
 *
 * The check runs the pull request's own code, so nothing it can write may decide the verdict. Each run gets a fresh
 * check thread, a bare one with no agent, whose pylon clones the repository at the commit. The check is the process
 * of one raw pipe into that pylon, and its verdict is that process's exit status as the probe reports it, never a
 * file in the guest. Afterwards the thread is deleted, so no process the check left behind survives into a later
 * round, and no reviewer's pylon ever runs it.
 *
 * Only this process knows that it opened a run's pipe, so a check thread it holds no run for, as after a restart, may
 * have run something already. It is thrown away, and the check starts again in a fresh one.
 */
import type { ByteStream, NodeName, ProbeClient, ProbeError } from "../protocol.ts";
import { checkoutDir } from "../sessions.ts";
import type { Registry, Thread, ThreadId } from "./registry.ts";
import type { StartRequest } from "./threads.ts";

/** Who starts a check thread, as its `startedBy`. */
export const checkCaller = "nexus-check";
const tailBytes = 6_000;
/** The pipe's exit status when the pylon was not fit to run the check, which says nothing of the change. */
const unfit = 125;
/** The shell's statuses for a command it cannot run or find, which the script also gives when it cannot start the check. */
const missing = new Set([126, 127]);
/**
 * Prints the environment Gondolin gave the guest's PID 1 from the image, its PATH and the egress proxy's CA among it,
 * which the probe's ssh pipe does not get. It is fixed at boot, before `.nexus/setup` ran, unlike /etc/profile.d.
 */
export const imageEnv = "sudo -n cat /proc/1/environ";

/** `$1` is the commit. The check replaces the shell, so the pipe's process is the check's and its status the check's. */
export const checkScript = `cd ${checkoutDir} || exit ${unfit}
[ "$(git rev-parse HEAD)" = "$1" ] || { echo "The check pylon's checkout is not at $1."; exit ${unfit}; }
[ -x .nexus/check ] || { echo "The repository has no executable .nexus/check at $1."; exit 127; }
image=$(${imageEnv} | tr '\\0' '\\n')
[ -n "$image" ] || { echo "The check pylon's image environment could not be read."; exit 127; }
set -f
IFS='
'
for v in $image; do case \${v%%=*} in HOME|PWD|OLDPWD|SHLVL|TERM) ;; *) export "$v" ;; esac; done
unset IFS
set +f
exec ./.nexus/check </dev/null 2>&1`;

/**
 * A check run's state. `waiting` while its pylon boots. `void` when this run cannot give a verdict, because its pipe was
 * lost, its pylon was unfit, or this process holds no run for the thread, so the thread goes and a fresh one starts.
 * `unrunnable` when the pylon cannot run the repository's check: its boot or `.nexus/setup` failed, it has no
 * `.nexus/check`, or a command the check needs is missing. A fresh pylon would fail the same way.
 */
export type CheckState =
  | { kind: "waiting" | "running" | "void" }
  | { kind: "done"; passed: boolean; output: string }
  | { kind: "unrunnable"; output: string };

export interface CheckRuns {
  /** Starts a fresh check thread at `head` on the PR's branch, in the builder's project and node. */
  start(builder: Thread, branch: string, head: string): Promise<ThreadId>;
  poll(thread: ThreadId, head: string): CheckState;
  /** Deletes the check thread and its pylon. Safe to repeat. */
  discard(thread: ThreadId): void;
}

type Run = { kind: "waiting" | "running"; output: Buffer } | { kind: "void" } | Extract<CheckState, { kind: "done" | "unrunnable" }>;

export function checkRuns(options: {
  registry: Registry;
  probes: ReadonlyMap<NodeName, Pick<ProbeClient, "stream">>;
  startThread(request: StartRequest, caller: string): Promise<Thread>;
  wake(t: Thread): void;
}): CheckRuns {
  const { registry, probes, startThread, wake } = options;
  const runs = new Map<ThreadId, Run>();

  function open(t: Thread, head: string, probe: Pick<ProbeClient, "stream">) {
    const run: Run = { kind: "running", output: Buffer.alloc(0) };
    runs.set(t.id, run);
    const settle = (next: Run) => { if (runs.get(t.id) === run) runs.set(t.id, next); };
    void (async () => {
      let stream: ByteStream;
      try {
        stream = await probe.stream(t.pylonId, ["sh", "-c", checkScript, "nexus-check", head]);
      } catch (err) {
        // Nothing ran in a pylon that was not running, so the run may open its pipe again.
        if ((err as Partial<ProbeError>).code === "not-running") return settle({ kind: "waiting", output: Buffer.alloc(0) });
        return invalid(t.id, run);
      }
      try {
        await stream.close();
        for await (const chunk of stream) run.output = Buffer.concat([run.output, chunk]).subarray(-tailBytes);
        const end = await stream.done;
        const output = run.output.toString("utf8").trim();
        if (end.kind !== "exited" || end.code === unfit) invalid(t.id, run);
        else settle(missing.has(end.code) ? { kind: "unrunnable", output } : { kind: "done", passed: end.code === 0, output });
      } catch {
        // A pipe that failed partway, such as one closed before its EOF went out, may have run the check, so it says nothing.
        stream.abort();
        invalid(t.id, run);
      }
    })();
  }

  /** The run can give no verdict, so its pylon, which may have run something, goes at once. */
  function invalid(id: ThreadId, run: Run) {
    if (runs.get(id) !== run) return;
    runs.set(id, { kind: "void" });
    remove(id);
  }

  function remove(id: ThreadId) {
    const t = registry.thread(id);
    if (t === undefined || t.status === "deleted") return;
    registry.setThreadStatus(id, "deleted");
    wake(t);
  }

  return {
    async start(builder, branch, head) {
      const t = await startThread({ project: builder.project, title: `Check of ${branch} at ${head.slice(0, 12)}`, node: registry.pylon(builder.pylonId)!.node, branch, commit: head, bare: true }, checkCaller);
      runs.set(t.id, { kind: "waiting", output: Buffer.alloc(0) });
      return t.id;
    },
    poll(id, head) {
      const run = runs.get(id);
      const t = registry.thread(id);
      if (run === undefined || t === undefined || t.status !== "active") return { kind: "void" };
      if (run.kind === "done" || run.kind === "void" || run.kind === "unrunnable") return run;
      const pylon = registry.pylon(t.pylonId)!;
      if (pylon.failed !== null) return { kind: "unrunnable", output: `The check pylon did not boot: ${pylon.failed}` };
      // Agent activity keeps the pylon running while the check does.
      registry.recordActivity(id, { agent: Date.now() });
      wake(t);
      if (run.kind === "running") return { kind: "running" };
      const node = registry.node(pylon.node);
      const probe = probes.get(pylon.node);
      if (probe !== undefined && node?.state === "online" && node.observation?.pylons.some((p) => p.pylonId === t.pylonId && p.phase === "running") === true) open(t, head, probe);
      return { kind: runs.get(id)!.kind === "running" ? "running" : "waiting" };
    },
    discard(id) {
      runs.delete(id);
      remove(id);
    },
  };
}
