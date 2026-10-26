/**
 * Runs the repository's `.nexus/check`, its typecheck and full test suite, at a commit in a thread's pylon, for the
 * merge policy's "the typecheck and the full test suite pass". The control plane runs it rather than trusting an
 * agent's report, in the reviewer's pylon rather than the builder's, so the agent under review cannot touch it.
 *
 * A probe exec lasts at most 60 seconds, and a suite runs longer, so one exec starts the job detached and later ones
 * read its state. The job lives in its own worktree under ~/.nexus-checks/<commit>, on the pylon's disk, and writes its
 * exit code last, so every exec judges it from what is on disk: a result, a live process, or neither. A pylon that
 * paused mid-run left neither, and the next exec starts it over. A result is kept, so a second land of the same head
 * reads it again rather than running it twice.
 */
import { checkoutDir } from "../sessions.ts";
import type { CommandResult, NodeName, ProbeClient, ProbeError } from "../protocol.ts";
import type { Registry, Thread } from "./registry.ts";
import type { CheckState } from "./review.ts";

const outputBytes = 6_000;

/** `$1` is the commit. It prints `done <exit code>` and the log's tail, `running`, or `started`. */
export const checkScript = `set -u
sha=$1
d="$HOME/.nexus-checks/$sha"
finish() { printf 'done %s\\n' "$(cat "$d/exit")"; tail -c ${outputBytes} "$d/log"; exit 0; }
[ -f "$d/exit" ] && finish
if [ -f "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null; then echo running; exit 0; fi
rm -rf "$d" && mkdir -p "$d"
git worktree prune
if ! { git cat-file -e "$sha^{commit}" 2>/dev/null || git fetch -q origin "$sha"; } >"$d/log" 2>&1 || ! git worktree add -q --detach "$d/tree" "$sha" >>"$d/log" 2>&1; then
  echo 1 >"$d/exit"; finish
fi
if [ ! -x "$d/tree/.nexus/check" ]; then
  echo "The repository has no executable .nexus/check at $sha." >>"$d/log"; echo 127 >"$d/exit"; finish
fi
cd "$d/tree" && setsid sh -c './.nexus/check >>../log 2>&1; echo $? >../exit.tmp && mv ../exit.tmp ../exit' </dev/null >/dev/null 2>&1 &
echo $! >"$d/pid"
echo started`;

export function parseCheck(result: Extract<CommandResult, { kind: "exec" }>): CheckState {
  if (result.exitCode !== 0) throw new Error(`the check's exec exited ${result.exitCode ?? "on its timeout"}`);
  const [first = "", ...rest] = result.output.split("\n");
  const done = /^done (\d+)$/.exec(first);
  if (done !== null) return { kind: "done", passed: done[1] === "0", output: rest.join("\n").trim() };
  if (first === "running" || first === "started") return { kind: "running" };
  throw new Error("the check's exec printed no state");
}

/** Keeps the pylon awake while its check runs, as agent activity, and reads `waiting` until the pylon runs. */
export function checkRunner(options: { registry: Registry; probes: ReadonlyMap<NodeName, Pick<ProbeClient, "command">>; wake(t: Thread): void }) {
  const { registry, probes, wake } = options;
  return async (t: Thread, head: string): Promise<CheckState> => {
    if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("a check runs at a full commit hash");
    registry.recordActivity(t.id, { agent: Date.now() });
    wake(t);
    const pylon = registry.pylon(t.pylonId)!;
    const node = registry.node(pylon.node);
    const probe = probes.get(pylon.node);
    const running = node?.state === "online" && node.observation?.pylons.some((p) => p.pylonId === t.pylonId && p.phase === "running") === true;
    if (!running || probe === undefined) return { kind: "waiting" };
    try {
      return parseCheck(await probe.command(t.pylonId, { kind: "exec", argv: ["sh", "-c", checkScript, "nexus-check", head], cwd: checkoutDir, timeoutMs: 55_000 }) as Extract<CommandResult, { kind: "exec" }>);
    } catch (err) {
      if ((err as Partial<ProbeError>).code === "not-running") return { kind: "waiting" };
      throw err;
    }
  };
}
