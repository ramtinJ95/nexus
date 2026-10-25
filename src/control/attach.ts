/**
 * One attached terminal's life on the control plane, after the attach route's 101: it waits for the thread's pylon,
 * opens Herdr's client on a pty in it, and pumps bytes until one side ends. attach-wire.ts is the protocol.
 *
 * Waiting, each try records human activity and wakes the node, as a CLI command that needs the pylon running does,
 * so a paused pylon wakes on attach. Attached, the probe's count of Herdr clients keeps the human present. Every end
 * hangs the terminal up, which detaches Herdr's client and keeps its session, and waits for the guest's process to
 * exit, so nothing is left running in the pylon once serveAttach resolves.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { WebSocket } from "ws";
import { encodeMessage, parseClientMessage, type AttachErrorKind, type AttachRequest, type ServerMessage } from "../attach-wire.ts";
import type { Terminal } from "../guest-terminal.ts";
import type { ProbeError } from "../protocol.ts";
import type { ActualState } from "../reconcile.ts";

export interface AttachError { kind: AttachErrorKind; message: string }

/** The thread now: its pylon's state, or why no terminal can open on it. */
export type Look = { kind: "pylon"; state: ActualState } | { kind: "over"; error: AttachError };

/** What serveAttach asks of the thread's pylon. api.ts makes one per attach from the registry and the node's probe. */
export interface PylonDoor {
  readonly thread: string;
  look(): Look;
  /** Records human activity, wakes the node and opens the terminal. Rejects with ProbeError, `not-running` until the pylon runs. */
  open(request: AttachRequest): Promise<Terminal>;
}

/** Why the control plane ends an attach itself, as the reason of serveAttach's signal. */
export type Ending = "deleted" | "stopping";

export interface AttachTiming {
  /** A ping this often, and a socket that did not answer the last one is dropped. Under the CLI's 30 s idle timeout. */
  pingMs: number;
  /** How long the pylon has to run. */
  waitMs: number;
  pollMs: number;
}
export const attachTiming: AttachTiming = { pingMs: 15_000, waitMs: 120_000, pollMs: 1_000 };

/**
 * Serves one attach until it ends, and never rejects. Each end is one final message and a close, unless the client
 * is the one that left. `signal` aborts with an Ending.
 */
export async function serveAttach(ws: WebSocket, door: PylonDoor, opening: AttachRequest, signal: AbortSignal, timing = attachTiming): Promise<void> {
  let request = opening;
  let terminal: Terminal | null = null;
  /** Keys and resizes in the order they came. A write fails only once the relay is gone, which `done` reports. */
  let input = Promise.resolve();
  const left = new AbortController();
  const ended = AbortSignal.any([signal, left.signal]);
  // ws closes the link after an error, and the close hangs up.
  ws.on("error", () => undefined);
  ws.on("close", () => left.abort());
  let answered = true;
  ws.on("pong", () => { answered = true; });
  const ping = setInterval(() => {
    if (!answered) return void ws.terminate();
    answered = false;
    ws.ping();
  }, timing.pingMs);
  ws.on("message", (data, binary) => {
    if (ended.aborted) return;
    if (binary) {
      // Keys before `attached` have no terminal to go to. ws hands binary over as one Buffer.
      const keys = data as Buffer;
      if (terminal !== null) input = input.then(() => terminal!.write(keys)).catch(() => undefined);
      return;
    }
    let message: ReturnType<typeof parseClientMessage>;
    try {
      message = parseClientMessage(data.toString());
    } catch {
      ws.close(1008, "not an attach message");
      left.abort();
      return;
    }
    if (message === null) return;
    const { size } = message;
    if (terminal === null) request = { ...request, size };
    else input = input.then(() => terminal!.resize(size)).catch(() => undefined);
  });

  const send = (message: ServerMessage) => new Promise<void>((resolve) => { ws.send(encodeMessage(message), () => resolve()); });
  const finish = async (final: ServerMessage | null, code = 1000) => {
    if (!left.signal.aborted && final !== null) await send(final);
    if (ws.readyState === ws.OPEN) ws.close(code);
  };
  const endedBy = (): AttachError => signal.reason === "deleted"
    ? { kind: "conflict", message: `thread ${door.thread} is deleted` }
    : { kind: "unreachable", message: "the control plane is stopping. Herdr keeps the session, so attach again once it is back" };
  const closeCode = () => signal.aborted && signal.reason === "stopping" ? 1001 : 1000;

  try {
    const waited = await waitForTerminal();
    if (waited.kind === "ended") return await finish(left.signal.aborted ? null : { type: "error", ...endedBy() }, closeCode());
    if (waited.kind === "refused") return await finish({ type: "error", ...waited.error });
    const opened = waited.terminal;
    terminal = opened;
    // A resize that came while the terminal opened.
    const latest = request;
    if (latest !== waited.asked) input = input.then(() => opened.resize(latest.size)).catch(() => undefined);
    await send({ type: "attached" });
    const output = (async () => {
      // Read to the end even once nobody listens, because the relay blocks on a full stdout.
      for await (const chunk of opened) {
        if (!ended.aborted && ws.readyState === ws.OPEN) await new Promise<void>((resolve) => { ws.send(chunk, { binary: true }, () => resolve()); });
      }
    })();
    await Promise.race([opened.done, aborted(ended)]);
    const endedFirst = ended.aborted;
    if (endedFirst) await hangUp(opened);
    await output;
    const end = await opened.done;
    await input;
    if (endedFirst) return await finish(left.signal.aborted ? null : { type: "error", ...endedBy() }, closeCode());
    if (end.kind === "exited" && end.code === 0) return await finish({ type: "exit", code: 0 });
    // An archive pauses the pylon under the terminal, which a pylon VM's ssh reports as its own exit 255.
    const look = door.look();
    if (look.kind !== "over" && end.kind === "exited") return await finish({ type: "exit", code: end.code });
    await finish({
      type: "error",
      ...look.kind === "over" ? look.error : {
        kind: "unreachable",
        message: `the link to the pylon of ${door.thread} was lost, as a pause or a restart of its node's probe does. Herdr keeps the session, so attach again`,
      },
    });
  } catch (err) {
    // Nothing above throws on purpose, so the terminal is only hung up here, not waited for.
    if (terminal !== null) await hangUp(terminal);
    await finish({ type: "error", kind: "failed", message: (err as Error).message });
  } finally {
    clearInterval(ping);
  }

  async function waitForTerminal(): Promise<Waited> {
    const deadline = Date.now() + timing.waitMs;
    let shown: ActualState | null = null;
    for (;;) {
      if (ended.aborted) return { kind: "ended" };
      const look = door.look();
      if (look.kind === "over") return { kind: "refused", error: look.error };
      if (look.state !== "running" && look.state !== shown) {
        shown = look.state;
        await send({ type: "waiting", pylon: look.state });
      }
      const asked = request;
      try {
        const opened = await door.open(asked);
        if (!ended.aborted) return { kind: "opened", terminal: opened, asked };
        // The client left, or the thread was deleted, while it opened.
        await hangUp(opened);
        for await (const _ of opened) { /* drained, so the relay can exit */ }
        await opened.done;
        return { kind: "ended" };
      } catch (err) {
        const code = (err as Partial<ProbeError>).code;
        const message = (err as Error).message;
        if (code === "unreachable") return { kind: "refused", error: { kind: "unreachable", message } };
        if (code !== "not-running") return { kind: "refused", error: { kind: "failed", message } };
      }
      if (Date.now() >= deadline) {
        const where = shown === null ? "Its node does not run it yet" : `It is ${shown}`;
        return { kind: "refused", error: { kind: "failed", message: `the pylon of ${door.thread} did not run within ${timing.waitMs / 1000} s. ${where}` } };
      }
      await sleep(timing.pollMs, undefined, { signal: ended }).catch(() => undefined);
    }
  }
}

/** How the wait for a terminal ended: with one, opened at `asked`, with why none opens, or with the attach itself. */
type Waited = { kind: "opened"; terminal: Terminal; asked: AttachRequest } | { kind: "refused"; error: AttachError } | { kind: "ended" };

/** A relay already gone needs no hang-up, and `done` says how it ended. */
const hangUp = (terminal: Terminal) => terminal.hangUp().catch(() => undefined);

const aborted = (signal: AbortSignal) => signal.aborted ? Promise.resolve()
  : new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
