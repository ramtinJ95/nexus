/**
 * What a route runs in a thread's pylon, through its node's probe: a request its owner makes, which wakes the pylon,
 * or a read a page makes by itself or a reader makes, which only runs while the pylon does.
 */
import type { CommandResult, PylonCommand } from "../../protocol/commands.ts";
import type { NodeName, Person, PylonId } from "../../ids.ts";
import type { ProbeClient } from "../../protocol/client.ts";
import type { ProbeError } from "../../protocol/http.ts";
import type { Registry } from "../registry.ts";
import type { StoredPylon, Thread } from "../thread-store.ts";
import { CheckoutRefused, type RefusalKind as CheckoutRefusalKind } from "../../checkout-files.ts";
import { Refusal, type RefusalKind } from "../refusal.ts";
import { runningNode, runsSealed } from "../locator.ts";
import type { Access } from "./access.ts";

/** What each refusal of a checkout read is. A missing base is unprocessable, not a conflict, because waiting cannot change it. */
const checkoutRefusal: Readonly<Record<CheckoutRefusalKind, RefusalKind>> = {
  missing: "missing", outside: "invalid", kind: "invalid", large: "too-large", "no-base": "unprocessable", slow: "timeout", busy: "unavailable", long: "invalid",
};

/** Who asks for a request in a pylon: the thread's owner, a page by itself, or a reader who does not own the thread. */
type Asker = "owner" | "page" | "reader";
const notRunning: Readonly<Record<Asker, (pylonId: PylonId, owner: Person) => Refusal>> = {
  owner: (pylonId) => new Refusal("conflict", `pylon ${pylonId} is not running yet. This request wakes it, so ask again once it runs`, "not-running"),
  page: (pylonId) => new Refusal("conflict", `pylon ${pylonId} is not running, and this request does not wake it`, "not-running"),
  reader: (pylonId, owner) => new Refusal("conflict", `pylon ${pylonId} is not running, and only ${owner}'s requests wake it`),
};

export function pylonAccess({ registry, probes, wake, guard, current }: {
  registry: Registry; probes: ReadonlyMap<NodeName, Pick<ProbeClient, "command" | "stream">>; wake(node: NodeName): void;
  guard: Access["guard"]; current: Access["current"];
}) {
  /**
   * Runs what a human asked for in the thread's pylon, such as a link, a session open or a checkout read. The owner's
   * asking is human activity, as a message is, so a paused pylon is woken, but the request itself needs the pylon
   * running and is refused as a conflict until it is. A page's own read and a reader's run only while the pylon runs.
   */
  async function inPylon<T>(t: Thread, act: (probe: Pick<ProbeClient, "command" | "stream">, pylonId: PylonId) => Promise<T>, asker: Asker = "owner"): Promise<T> {
    guard(t, { status: "pylon" });
    const pylon = registry.threads.pylon(t.pylonId)!;
    const probe = probes.get(pylon.node);
    if (probe === undefined) throw new Refusal("unavailable", `no probe is configured for ${pylon.node}`);
    const refused = () => notRunning[asker](pylon.pylonId, t.owner);
    if (asker === "owner") {
      registry.threads.recordActivity(t.id, { human: Date.now() });
      wake(pylon.node);
    } else if (!running(pylon)) throw refused();
    // A sealed boot runs no work, and the wake pauses it for the next.
    if (runsSealed(registry, pylon)) throw refused();
    let result: T;
    try {
      result = await act(probe, pylon.pylonId);
    } catch (err) {
      // A delete or archive that landed meanwhile stopped the pylon, so the thread's state answers, not the node's failure.
      guard(current(t), { status: "pylon" });
      if ((err as Partial<ProbeError>).code === "not-running") throw refused();
      if (err instanceof CheckoutRefused) throw new Refusal(checkoutRefusal[err.kind], err.message);
      throw err;
    }
    // A delete that landed meanwhile may have released the pylon's ports already.
    guard(current(t), { status: "kept" });
    return result;
  }

  /**
   * A read a page makes by itself, such as an image's load, runs only while the pylon runs: it never wakes the pylon
   * or counts as the person's activity, so a page left open lets the pylon sleep.
   */
  function whileRunning<T>(t: Thread, act: (probe: Pick<ProbeClient, "command" | "stream">, pylonId: PylonId) => Promise<T>) {
    return inPylon(t, act, "page");
  }
  /**
   * A read by someone who does not own the thread, such as a teammate browsing it, leaves its pylon and idle clock as
   * they were. It is refused outright while the pylon does not run, since asking again wakes nothing.
   */
  function asReader<T>(t: Thread, act: (probe: Pick<ProbeClient, "command" | "stream">, pylonId: PylonId) => Promise<T>) {
    return inPylon(t, act, "reader");
  }
  /** Whether the node, online, reports the pylon running, as a Claude transcript's reads ask. */
  const running = (pylon: StoredPylon): boolean => runningNode(registry, pylon.pylonId, "work") !== null;

  async function execInPylon(t: Thread, argv: readonly string[]): Promise<{ exitCode: number | null; output: string }> {
    const { exitCode, output } = await pylonCommand(t, { kind: "exec", argv: [...argv], cwd: "/", timeoutMs: 15_000 });
    return { exitCode, output };
  }

  async function pylonCommand<K extends "exec" | "link-port" | "unlink-port" | "open-session" | "close-session" | "drop-failed-session">(t: Thread, command: Extract<PylonCommand, { kind: K }>): Promise<Extract<CommandResult, { kind: K }>> {
    // The client checks that the result is the command's kind.
    return await inPylon(t, (probe, pylonId) => probe.command(pylonId, command)) as Extract<CommandResult, { kind: K }>;
  }

  return { inPylon, whileRunning, asReader, pylonCommand, execInPylon };
}
export type PylonAccess = ReturnType<typeof pylonAccess>;
