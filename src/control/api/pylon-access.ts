/**
 * What a route runs in a thread's pylon, through its node's probe: a request a human makes, which wakes the pylon,
 * or a read a page makes by itself, which only runs while the pylon does.
 */
import type { CommandResult, PylonCommand } from "../../protocol/commands.ts";
import type { NodeName, PylonId } from "../../ids.ts";
import type { ProbeClient } from "../../protocol/client.ts";
import type { ProbeError } from "../../protocol/http.ts";
import type { Registry, StoredPylon, Thread } from "../registry.ts";
import { CheckoutRefused, type RefusalKind } from "../../checkout-files.ts";
import { HttpError } from "../http-error.ts";
import { listsRunning } from "../observed.ts";
import type { Access } from "./access.ts";

/** What each refusal of a checkout read answers. A missing base is a 422, not a 409, because waiting cannot change it. */
const refusalStatus: Readonly<Record<RefusalKind, number>> = { missing: 404, outside: 400, kind: 400, large: 413, "no-base": 422, slow: 504, busy: 503, long: 400 };

export function pylonAccess({ registry, probes, wake, guard, current }: {
  registry: Registry; probes: ReadonlyMap<NodeName, Pick<ProbeClient, "command" | "stream">>; wake(node: NodeName): void;
  guard: Access["guard"]; current: Access["current"];
}) {
  /**
   * Runs what a human asked for in the thread's pylon, such as a link, a session open or a checkout read. Asking is
   * human activity, as a message is, so a paused pylon is woken, but the request itself needs the pylon running and
   * is refused with a 409 until it is.
   */
  async function inPylon<T>(t: Thread, act: (probe: Pick<ProbeClient, "command" | "stream">, pylonId: PylonId) => Promise<T>, wakes = true): Promise<T> {
    guard(t, { status: "pylon" });
    const pylon = registry.pylon(t.pylonId)!;
    const probe = probes.get(pylon.node);
    if (probe === undefined) throw new HttpError(503, `no probe is configured for ${pylon.node}`);
    if (wakes) {
      registry.recordActivity(t.id, { human: Date.now() });
      wake(pylon.node);
    } else if (!running(pylon)) throw new HttpError(409, notRunning(pylon.pylonId, false), "not-running");
    let result: T;
    try {
      result = await act(probe, pylon.pylonId);
    } catch (err) {
      // A delete or archive that landed meanwhile stopped the pylon, so the thread's state answers, not the node's failure.
      guard(current(t), { status: "pylon" });
      if ((err as Partial<ProbeError>).code === "not-running") throw new HttpError(409, notRunning(pylon.pylonId, wakes), "not-running");
      if (err instanceof CheckoutRefused) throw new HttpError(refusalStatus[err.kind], err.message);
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
    return inPylon(t, act, false);
  }
  const notRunning = (pylonId: PylonId, wakes: boolean) => wakes ? `pylon ${pylonId} is not running yet. This request wakes it, so ask again once it runs`
    : `pylon ${pylonId} is not running, and this request does not wake it`;
  /** Whether the node, online, reports the pylon running, as a Claude transcript's reads ask. */
  function running(pylon: StoredPylon): boolean {
    const node = registry.node(pylon.node);
    return node?.state === "online" && listsRunning(node.observation, pylon.pylonId);
  }

  /** Runs `argv` in the thread's pylon as a command whose answer the API waits for, at most 15 s. */
  async function execInPylon(t: Thread, argv: readonly string[]): Promise<{ exitCode: number | null; output: string }> {
    const { exitCode, output } = await pylonCommand(t, { kind: "exec", argv: [...argv], cwd: "/", timeoutMs: 15_000 });
    return { exitCode, output };
  }

  async function pylonCommand<K extends "exec" | "link-port" | "unlink-port" | "open-session" | "close-session" | "drop-failed-session">(t: Thread, command: Extract<PylonCommand, { kind: K }>): Promise<Extract<CommandResult, { kind: K }>> {
    // The client checks that the result is the command's kind.
    return await inPylon(t, (probe, pylonId) => probe.command(pylonId, command)) as Extract<CommandResult, { kind: K }>;
  }

  return { inPylon, whileRunning, pylonCommand, execInPylon };
}
export type PylonAccess = ReturnType<typeof pylonAccess>;
