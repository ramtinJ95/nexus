/** The probe's job runner, with each job kind's hooks, and command runner: they turn protocol jobs and commands into VmBackend and session calls. */
import { isPortableArtifactId, type NodeName, type PortableArtifactId, type PylonId } from "../ids.ts";
import { JobFailure, type Job } from "../protocol/jobs.ts";
import type { CommandResult, PylonCommand } from "../protocol/commands.ts";
import type { ArtifactCopy } from "../protocol/artifacts.ts";
import { type PreviewAssignment } from "../protocol/spawn.ts";
import type { ServiceName } from "../services-file.ts";
import { closeSession, dropFailedSession, interruptClaude, LaunchStalled, openSession, sendToClaude } from "./guest/sessions.ts";
import { type SecretSource, type VmBackend } from "../backends/backend.ts";
import { refuseShortDisk } from "../disk-space.ts";
import { checkoutDir } from "../../images/pylon/nexus-contract.ts";
import type { PylonStates } from "./pylon-facts.ts";

/** Linking or unlinking a pylon's port together with its preview route, so no snapshot read overlaps either. */
export interface PortLinks {
  link(pylonId: PylonId, port: number, title?: string): Promise<ServiceName>;
  /** The guest's refusal, or null once the port is unlinked and its route withdrawn. */
  unlink(pylonId: PylonId, port: number): Promise<string | null>;
}

export interface ProbeDeps {
  node: NodeName;
  backend: VmBackend;
  secrets: SecretSource;
  serve: TailscaleServe;
  ports: PortLinks;
  /** GET /v1/artifacts/{id} on the peer probe. The stream is unverified until ArtifactStore.import checks it. */
  fetchPeer(from: NodeName, artifact: PortableArtifactId, sha256: string, signal: AbortSignal): Promise<ArtifactCopy>;
}

/** Owns `tailscale serve --bg --https=<port>` entries. One gateway port on loopback routes by the Host header's port. */
export interface TailscaleServe {
  /** Publish exactly these for this pylon and remove its others, then GET each until it answers (S4: the first TLS request can hang). */
  converge(pylonId: PylonId, previews: readonly PreviewAssignment[], signal: AbortSignal): Promise<void>;
  /** Stops routing the service's https port now, so it answers 404 until a converge removes its serve entry. */
  withdraw(pylonId: PylonId, service: ServiceName): Promise<void>;
}

/**
 * One switch, and no other logic: what a job changes in the probe's memory is its kind's jobHooks entry. Backend
 * errors become JobFailure with the closest code, and deadline aborts "deadline".
 */
export async function runJob(job: Job, deps: ProbeDeps, signal: AbortSignal): Promise<void> {
  try {
    switch (job.kind) {
      case "spawn":
        for (const grant of job.boot.network.secrets) {
          if (deps.secrets.value(grant.name) === undefined) throw new JobFailure("secret-missing", `secret ${grant.name} is not in this node's secret file`);
        }
        // A pylon that is up already holds its overlay.
        if (deps.backend.storage !== undefined && ["absent", "stopped"].includes(await deps.backend.state(job.pylonId))) await refuseShortDisk(deps.backend.storage, job.boot.resources.diskGiB);
        await deps.backend.ensureRunning(job.boot, job.live, signal, job.relaunch ?? true);
        await deps.serve.converge(job.pylonId, job.live.previews, signal);
        return;
      case "pause":
        // Previews stay published, so a hit on a paused pylon reaches the gateway, which reports it and shows a waking page.
        await deps.backend.ensurePaused(job.pylonId, job.checkpoint, signal, job.retry);
        return;
      case "delete":
        await deps.serve.converge(job.pylonId, [], signal);
        await deps.backend.ensureDeleted(job.pylonId, signal);
        return;
      case "build-image":
        await deps.backend.buildImage(job.image, job.recipe, deps.node, signal);
        return;
      case "build-template":
        await deps.backend.buildTemplate(job.template, job.inputs, signal);
        return;
      case "fetch-artifact": {
        const artifact = job.artifact;
        if (!isPortableArtifactId(artifact)) throw new JobFailure("invalid", `${artifact} is a checkpoint, and a checkpoint never leaves its node`);
        const held = await deps.backend.artifacts.manifest(artifact);
        if (held !== null) {
          if (held.sha256 !== job.sha256) throw new JobFailure("invalid", `this node holds ${artifact} with sha256 ${held.sha256}, and the job asks for ${job.sha256}`);
          return;
        }
        const copy = await deps.fetchPeer(job.from, artifact, job.sha256, signal);
        if ("refused" in copy) throw new JobFailure("invalid", `${job.from} refuses the copy: ${copy.refused}`);
        if (copy.manifest.id !== artifact || copy.manifest.sha256 !== job.sha256) {
          copy.stream.destroy();
          throw new JobFailure("invalid", `${job.from} offers ${copy.manifest.id} with sha256 ${copy.manifest.sha256}, and the job asks for ${artifact} with ${job.sha256}`);
        }
        await deps.backend.artifacts.import(copy.manifest, copy.stream, signal);
        return;
      }
      case "drop-artifact":
        await deps.backend.artifacts.drop(job.artifact);
        return;
    }
  } catch (err) {
    if (err instanceof JobFailure) throw err;
    if (signal.aborted && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") {
      throw new JobFailure("deadline", `${job.kind} passed its deadline`);
    }
    throw new JobFailure("backend", err instanceof Error ? err.message : String(err));
  }
}

/** What a successful job changes beyond the backend, besides the snapshot the probe then publishes. */
export interface JobEffects {
  pylons: PylonStates;
  /** The pylon API's published previews changed. */
  republished(): void;
  /** The pylon no longer needs the wake the node's last shutdown marked it for. */
  forgetShutdown(pylonId: PylonId): void;
}

type JobKind = Job["kind"];

/** What the probe does around runJob for one kind of job. */
export interface JobHooks<K extends JobKind> {
  /** A drain aborts it rather than wait for it. */
  drainAborts: boolean;
  /** Runs as the job starts, and returns what runs once it succeeds. */
  started(job: Extract<Job, { kind: K }>, effects: JobEffects): () => void;
}

const noEffects = { drainAborts: false, started: () => () => {} };

export const jobHooks: { readonly [K in JobKind]: JobHooks<K> } = {
  // A drain stops a boot rather than wait for it, as it pauses the pylon next.
  "spawn": {
    drainAborts: true,
    started(job, { pylons, republished, forgetShutdown }) {
      const seen = pylons.spawnStarted(job.pylonId);
      return () => {
        if (pylons.spawnSucceeded(job, seen)) republished();
        forgetShutdown(job.pylonId);
      };
    },
  },
  "pause": {
    drainAborts: false,
    started(job, { pylons }) {
      pylons.runEnded(job.pylonId);
      return () => {};
    },
  },
  "delete": {
    drainAborts: false,
    started(job, { pylons, forgetShutdown }) {
      pylons.forget(job.pylonId);
      return () => forgetShutdown(job.pylonId);
    },
  },
  "build-image": noEffects,
  "build-template": noEffects,
  "fetch-artifact": noEffects,
  "drop-artifact": noEffects,
};

type CommandKind = PylonCommand["kind"];

/** How the probe runs one kind of command. */
export interface CommandPolicy<K extends CommandKind> {
  /**
   * What it waits for. A function names the Claude session it waits on, if any, so the sends, launches and interrupts
   * of one session run one at a time.
   */
  lock: ((command: Extract<PylonCommand, { kind: K }>) => string | undefined) | null;
  /** Held under its requestId, so a send-claude-outcome answers for it. */
  remembered: boolean;
  /** Whether its answer changes what the next snapshot lists, so the probe publishes one at once. */
  publishes: boolean | ((result: Extract<CommandResult, { kind: K }>) => boolean);
}

export const commandPolicies: { readonly [K in CommandKind]: CommandPolicy<K> } = {
  "exec": { lock: null, remembered: false, publishes: false },
  "open-session": { lock: (c) => c.prompt === undefined ? undefined : c.resume, remembered: false, publishes: true },
  "close-session": { lock: null, remembered: false, publishes: true },
  "drop-failed-session": { lock: null, remembered: false, publishes: false },
  "send-claude": { lock: (c) => c.session, remembered: true, publishes: (r) => r.resumed },
  "send-claude-outcome": { lock: null, remembered: false, publishes: false },
  "interrupt-claude": { lock: (c) => c.session, remembered: false, publishes: false },
  "service": { lock: null, remembered: false, publishes: false },
  "link-port": { lock: null, remembered: false, publishes: true },
  "unlink-port": { lock: null, remembered: false, publishes: true },
};

/**
 * The caller has checked that the pylon runs. Sessions open in the checkout. A send-claude-outcome never comes here,
 * since the probe answers it from its own record of its sends.
 */
export async function runCommand(pylonId: PylonId, command: Exclude<PylonCommand, { kind: "send-claude-outcome" }>, deps: ProbeDeps): Promise<CommandResult> {
  const guest = deps.backend.guest(pylonId);
  switch (command.kind) {
    case "exec":
      return { kind: "exec", ...await guest.exec(command.argv, { cwd: command.cwd, timeoutMs: command.timeoutMs }) };
    case "open-session": {
      const { harness, title, resume, prompt, model } = command;
      try {
        return { kind: "open-session", herdrPane: await openSession(guest, { harness, title, cwd: checkoutDir, ...(model === undefined ? {} : { model }), ...(prompt === undefined ? {} : { prompt }), ...(resume === undefined ? {} : { resume }) }) };
      } catch (err) {
        // An unprompted open's caller reads only the pane, so it would take a stall for a session that started.
        if (!(err instanceof LaunchStalled) || prompt === undefined) throw err;
        return { kind: "open-session", herdrPane: err.herdrPane, stalled: err.message };
      }
    }
    case "close-session":
      return { kind: "close-session", outcome: await closeSession(guest, command.herdrPane, command.session) };
    case "drop-failed-session":
      return { kind: "drop-failed-session", dropped: await dropFailedSession(guest, command.id) };
    case "send-claude": {
      const { session, text, model } = command;
      return { kind: "send-claude", ...await sendToClaude(guest, { session, text, ...(model === undefined ? {} : { model }) }) };
    }
    case "interrupt-claude":
      return { kind: "interrupt-claude", outcome: await interruptClaude(guest, command.session) };
    case "service": {
      const { services, logs } = await guest.services(command.op, command.name, command.lines);
      return { kind: "service", services, ...(logs === undefined ? {} : { logs }) };
    }
    case "link-port":
      return { kind: "link-port", service: await deps.ports.link(pylonId, command.port) };
    case "unlink-port":
      return { kind: "unlink-port", refused: await deps.ports.unlink(pylonId, command.port) };
  }
}
