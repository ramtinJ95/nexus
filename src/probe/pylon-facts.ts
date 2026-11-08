/**
 * What the probe holds for each pylon, and what it reads from each running pylon's guest for an observation. Each kind
 * of read has at most one outstanding per pylon, and git's read is reused for gitPollMs.
 */
import type { BackendPylon, VmBackend } from "../backends/backend.ts";
import type { LiveHash, PylonId } from "../ids.ts";
import type { Job } from "../protocol/jobs.ts";
import type { PreviewAssignment } from "../protocol/spawn.ts";
import { gitPollMs, type DeclaredOutput, type GitFacts, type ListeningFact, type PylonObservation, type ServiceFact, type SessionFact } from "../protocol/observations.ts";
import type { ServiceName } from "../services-file.ts";
import { attachedTerminals, sessionFacts } from "./guest/sessions.ts";
import { listOutputs } from "./guest/outputs.ts";
import { listeningFacts } from "./guest/listening.ts";
import { gitFacts } from "./guest/git-facts.ts";

/** Short, because snapshots are read one at a time and a stuck guest would hold up every observer. */
const sessionReadTimeoutMs = 3_000;
/** Longer, because a pylon's supervisor checks each service's health to answer. */
const serviceReadTimeoutMs = 5_000;

type FactKind = "sessions" | "attached" | "services" | "listening" | "outputs" | "git";

/** What the probe holds for one pylon, in memory only. Only createPylonStates writes it, and a delete drops it all. */
interface PylonState {
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
function notRunning(state: PylonState) {
  state.running = false;
  delete state.git;
  state.logged.clear();
}

export interface FactDeps {
  backend: VmBackend;
  log: (message: string) => void;
  redacted: (text: string) => string;
}

export type PylonStates = ReturnType<typeof createPylonStates>;

/**
 * The probe's memory of each pylon, with the guest reads that fill it. `pylon` creates a pylon's state, and `pylons`
 * looks it up again without creating it, as a delete may have started.
 */
export function createPylonStates({ backend, log, redacted }: FactDeps) {
  const pylons = new Map<PylonId, PylonState>();
  function pylon(pylonId: PylonId): PylonState {
    let state = pylons.get(pylonId);
    if (state === undefined) pylons.set(pylonId, state = { diverged: 0, unlinked: new Set(), running: false, logged: new Set(), reads: new Map() });
    return state;
  }
  const relinked = (pylonId: PylonId, service: ServiceName) => { pylons.get(pylonId)?.unlinked.delete(service); };

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
          attachedClients, ...(p.notAnswering ? { notAnswering: p.notAnswering } : {}),
        };
      }
    }
  }

  /**
   * The ports of every pylon the last snapshot saw running, read again: an app that starts or stops listening gives
   * the probe no event. Whether any changed since that pylon's last observation.
   */
  async function listeningChanged(): Promise<boolean> {
    const changed = await Promise.all([...pylons].filter(([, state]) => state.running).map(async ([pylonId, state]) => {
      const ports = await listening(pylonId);
      return ports !== null && JSON.stringify(ports) !== state.reportedListening;
    }));
    return changed.some(Boolean);
  }

  return {
    observation,
    listeningChanged,
    relinked,
    published: (pylonId: PylonId) => pylons.get(pylonId)?.published ?? [],
    /** Not dropped: a spawn in flight compares `diverged` at its start and its end, and a list can miss its pylon. */
    missing(present: ReadonlySet<PylonId>) {
      for (const [id, state] of pylons) if (!present.has(id)) notRunning(state);
    },
    /** Every snapshot after this reads the pylon's git again. */
    dropGit(pylonId: PylonId) { delete pylons.get(pylonId)?.git; },
    /** A pause ends the pylon's run, so nothing it applied or reported still holds. */
    runEnded(pylonId: PylonId) {
      const state = pylon(pylonId);
      delete state.liveHash;
      delete state.published;
      delete state.reportedListening;
    },
    forget(pylonId: PylonId) { pylons.delete(pylonId); },
    /** What a converge may route: none of the services unlinked since, which leaves the pylon diverged. */
    routed(pylonId: PylonId, assigned: readonly PreviewAssignment[]): readonly PreviewAssignment[] {
      const gone = pylons.get(pylonId)?.unlinked;
      const routed = assigned.filter((p) => !gone?.has(p.service));
      if (routed.length < assigned.length) pylon(pylonId).diverged++;
      return routed;
    },
    /**
     * The pylon no longer has what its last spawn applied, so the planner spawns again. A port linked again before a
     * snapshot saw it unlinked gets its route back that way, as its registry row and live hash did not change.
     * Recorded before `withdrawRoute`, so a converge that starts while the route is withdrawn leaves the service out.
     */
    async withdraw(pylonId: PylonId, service: ServiceName, withdrawRoute: () => Promise<void>) {
      const state = pylon(pylonId);
      state.unlinked.add(service);
      state.diverged++;
      await withdrawRoute();
      const current = pylons.get(pylonId);
      if (current === undefined) return;
      delete current.liveHash;
      if (current.published !== undefined) current.published = current.published.filter((p) => p.service !== service);
    },
    /** What a spawn compares at its end, to tell whether a withdraw came while it ran. */
    spawnStarted: (pylonId: PylonId): number => pylon(pylonId).diverged,
    /** Whether the spawn counts as applied, which a withdraw while it ran, maybe after its converge, prevents, so the planner spawns again. */
    spawnSucceeded(job: Extract<Job, { kind: "spawn" }>, seen: number): boolean {
      const state = pylon(job.pylonId);
      if (state.diverged !== seen) return false;
      // A pylon whose sessions this spawn left out does not yet look like `live`, so the next spawn brings them back.
      if (job.relaunch !== false) state.liveHash = job.liveHash;
      state.published = job.live.previews;
      return true;
    },
  };
}
