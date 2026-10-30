/**
 * What the probe reads from each running pylon's guest for an observation. Each kind of read has at most one
 * outstanding per pylon, and git's read is reused for gitPollMs.
 */
import type { BackendPylon, VmBackend } from "../backend.ts";
import type { LiveHash, PylonId } from "../ids.ts";
import type { Job } from "../protocol/jobs.ts";
import type { DeclaredOutput, GitFacts, ListeningFact, PylonObservation, ServiceFact, SessionFact } from "../protocol/observations.ts";
import type { ServiceName } from "../services-file.ts";
import { attachedTerminals, sessionFacts } from "../sessions.ts";
import { listOutputs } from "../outputs.ts";
import { listeningFacts } from "../listening.ts";
import { gitFacts, gitPollMs } from "../git-facts.ts";

/** Short, because snapshots are read one at a time and a stuck guest would hold up every observer. */
const sessionReadTimeoutMs = 3_000;
/** Longer, because a pylon's supervisor checks each service's health to answer. */
const serviceReadTimeoutMs = 5_000;

type FactKind = "sessions" | "attached" | "services" | "listening" | "outputs" | "git";

/** What the probe holds for one pylon, in memory only. A delete drops it all, and notRunning here and runEnded in startProbe each clear parts. */
export interface PylonState {
  /** Cleared, with `published` and `reportedListening`, when a pause starts. */
  liveHash?: LiveHash;
  /** The previews of the pylon's last successful spawn in this process, which published and warmed them. */
  published?: Extract<Job, { kind: "spawn" }>["live"]["previews"];
  /** The listening ports the pylon's last observation reported, so a poll can tell when they changed. */
  reportedListening?: string;
  /**
   * Bumped when the pylon's routes stop matching a spawn's live spec, so a spawn in flight across it does not count as
   * applied. It outlives a pause, so a services read that a withdraw and then a pause overlapped still sees a change.
   */
  diverged: number;
  /**
   * The services that were unlinked and not linked again. No spawn routes them: one that carries them was planned
   * before the unlink, whenever it reaches the probe. Only a delete forgets them.
   */
  unlinked: Set<ServiceName>;
  /** Whether the last snapshot saw the pylon running, which a listening poll reads instead of listing every pylon. */
  running: boolean;
  /** The last git read, which later snapshots reuse for gitPollMs while the pylon stays on the same boot. Cleared, with `logged`, once the pylon is seen not running. */
  git?: { bootedAt: string; at: number; facts: GitFacts | null };
  /** The fact kinds whose failure was logged since their last successful read. */
  logged: Set<FactKind>;
  /**
   * Reads still outstanding, timed out or not, so later snapshots cannot pile up RPCs behind one the controller has yet
   * to answer. Each removes itself when it settles, also across a pause.
   */
  reads: Map<FactKind, Promise<unknown>>;
}

/** Observed not running, or missing from the backend's list: the next boot's reads start fresh, and log a failure again. */
export function notRunning(state: PylonState) {
  state.running = false;
  delete state.git;
  state.logged.clear();
}

/** `pylon` creates a pylon's state, and `pylons` looks it up again without creating it, as a delete may have started. */
export interface FactDeps {
  backend: VmBackend;
  log: (message: string) => void;
  redacted: (text: string) => string;
  pylons: ReadonlyMap<PylonId, PylonState>;
  pylon(pylonId: PylonId): PylonState;
  relinked(pylonId: PylonId, service: ServiceName): unknown;
}

export function createFactReader({ backend, log, redacted, pylons, pylon, relinked }: FactDeps) {
  /**
   * A failed, late or still outstanding read answers `fallback`. `log.line` is logged once until a read succeeds, or on
   * every failure with `log.every`. Without `log` nothing is.
   */
  async function readFact<T>(pylonId: PylonId, kind: FactKind, timeoutMs: number, read: () => Promise<T>, options: {
    fallback: T; log?: { line: (reason: string) => string; every?: true };
  }): Promise<T> {
    const { reads, logged } = pylon(pylonId);
    let timer: NodeJS.Timeout | undefined;
    try {
      if (reads.has(kind)) throw new Error(`${kind} read is still outstanding`);
      const pending = Promise.resolve().then(read);
      reads.set(kind, pending);
      void pending.then(() => reads.delete(kind), () => reads.delete(kind));
      const facts = await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${kind} read exceeded ${timeoutMs} ms`)), timeoutMs);
      })]);
      logged.delete(kind);
      return facts;
    } catch (err) {
      if (options.log !== undefined && (options.log.every === true || !logged.has(kind))) log(options.log.line((err as Error).message));
      logged.add(kind);
      return options.fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Costs one guest exec (`herdr api snapshot`) per running pylon per snapshot, so a snapshot waits for the
   * slowest pylon, up to sessionReadTimeoutMs. A failed read reports null, never "no sessions".
   */
  const sessions = (pylonId: PylonId): Promise<readonly SessionFact[] | null> =>
    readFact(pylonId, "sessions", sessionReadTimeoutMs, () => sessionFacts(backend.guest(pylonId), sessionReadTimeoutMs), {
      fallback: null, log: { line: (reason) => `${pylonId} sessions: ${reason}. The control plane keeps the last list read until a read succeeds` },
    });

  /**
   * Terminals attached to the pylon's Herdr session. A count that fails reads as none, so it never keeps a pylon
   * awake nor fails the rest of the observation.
   */
  const attached = (pylonId: PylonId): Promise<number> =>
    readFact(pylonId, "attached", sessionReadTimeoutMs, () => attachedTerminals(backend.guest(pylonId), sessionReadTimeoutMs), {
      fallback: 0, log: { line: (reason) => `${pylonId} attached terminals: ${reason}. They count as none until a count succeeds` },
    });

  /** A failed or late read reports null, never "no services". */
  async function services(pylonId: PylonId): Promise<readonly ServiceFact[] | null> {
    const since = pylon(pylonId).diverged;
    const facts = await readFact(pylonId, "services", serviceReadTimeoutMs, async () => (await backend.guest(pylonId).services("list")).services, {
      fallback: null, log: { line: (reason) => `${pylonId} services: ${reason}`, every: true },
    });
    // A service that wants a preview under an unlinked name, linked again or declared, may be routed again. Not
    // from a read that a withdraw overlapped, which may predate the unlink.
    if (facts !== null && pylons.get(pylonId)?.diverged === since) for (const fact of facts) if (fact.wantsPreview) relinked(pylonId, fact.name);
    return facts;
  }

  /** A failed read reports null, never "nothing listens". */
  const listening = (pylonId: PylonId): Promise<readonly ListeningFact[] | null> =>
    readFact(pylonId, "listening", sessionReadTimeoutMs, () => listeningFacts(backend.guest(pylonId), sessionReadTimeoutMs), { fallback: null });

  /** Declared outputs only accumulate in the control plane, so a failed read reported as none loses nothing. `nexus output list` shows the failure. */
  const declaredOutputs = (pylonId: PylonId): Promise<readonly DeclaredOutput[]> =>
    readFact(pylonId, "outputs", sessionReadTimeoutMs, () => listOutputs(backend.guest(pylonId), sessionReadTimeoutMs), { fallback: [] });

  async function git(pylonId: PylonId, bootedAt: string): Promise<GitFacts | null> {
    const state = pylon(pylonId);
    const previous = state.git;
    const at = Date.now();
    if (previous?.bootedAt === bootedAt && at - previous.at < gitPollMs) return previous.facts;
    const facts = await readFact(pylonId, "git", sessionReadTimeoutMs, () => gitFacts(backend.guest(pylonId)), {
      fallback: null, log: { line: () => `${pylonId} git: checkout facts unavailable; retrying on the next git poll` },
    });
    state.git = { bootedAt, at, facts };
    return facts;
  }

  async function observation(p: BackendPylon): Promise<PylonObservation> {
    const { pylonId } = p;
    const state = pylon(pylonId);
    if (p.vm === "running") state.running = true;
    else notRunning(state);
    switch (p.vm) {
      case "booting": case "stopping": case "deleting": return { pylonId, phase: p.vm };
      case "stopped":
        return { pylonId, phase: "stopped", checkpoint: p.checkpoint, sessions: p.sessions };
      case "broken":
        return { pylonId, phase: "broken", detail: redacted(p.detail), cause: p.cause, logTail: redacted(p.logTail ?? "") };
      case "running": {
        const [ports, serviceFacts, sessionFacts, checkout, outputs, attachedClients] = await Promise.all([
          listening(pylonId), services(pylonId), sessions(pylonId), git(pylonId, p.bootedAt), declaredOutputs(pylonId), attached(pylonId),
        ]);
        // Looked up again, as a delete may have started while the guest was read.
        const current = pylons.get(pylonId);
        if (ports !== null && current !== undefined) current.reportedListening = JSON.stringify(ports);
        return {
          pylonId, phase: "running", liveHash: current?.liveHash ?? null, bootedAt: p.bootedAt,
          bootedFrom: { image: p.image, checkpoint: p.checkpoint },
          services: serviceFacts, listening: ports, previews: current?.published ?? [], sessions: sessionFacts, git: checkout, declaredOutputs: outputs,
          attachedClients,
        };
      }
    }
  }

  return { listening, observation };
}
