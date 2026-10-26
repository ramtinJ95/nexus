/**
 * Image builds and rollouts: one stored operation at a time, which a pass advances every 2 seconds and whenever the API
 * starts one. A build runs the recipe of the release the control plane runs on the image build node, then records the
 * manifest that node holds. A rollout copies a recorded image to every online node that lacks it, and makes it current
 * only once each holds it, since `--node auto` places a pylon only on a node that holds the current image. A rollback is
 * a rollout of the previous image.
 *
 * A pass derives each step from its node's observation and the probe's status of the step's job, never from what an
 * earlier pass meant to do, so a control plane that restarts mid-operation carries on from the stored operation.
 */
import { imageIdOf, type ImageId, type ImageManifest, type ImageRecipe } from "../images.ts";
import type { Job, JobId, NodeName, ProbeClient, ProbeError, TailnetNodeId } from "../protocol.ts";
import { envelope } from "../reconcile.ts";
import { failureMessage } from "../tick.ts";
import { HttpError } from "./http-error.ts";
import type { NodeRecord, RecordedImage, Registry } from "./registry.ts";

/** One node's part of an image operation. */
export interface ImageStep {
  node: NodeName;
  /**
   * done: the node's observation lists the image. skipped: the node was offline when the rollout began, so it fetches
   * the image on first use (planPylon's missing-artifact rule).
   */
  state: "pending" | "running" | "done" | "failed" | "skipped";
  /** The job last sent for this step, saved before it is sent, so a restarted control plane asks the probe about it. */
  job: { id: JobId; notAfter: string } | null;
  reason: string | null;
}

type Outcome = { state: "running" } | { state: "done"; finishedAt: number } | { state: "failed"; finishedAt: number; reason: string };

/** A build has one step, on the image build node. A rollout has one step per registry node. */
export type ImageOperation = {
  kind: "build" | "rollout";
  image: ImageId;
  requestedBy: TailnetNodeId;
  requestedAt: number;
  steps: readonly ImageStep[];
} & Outcome;

/** A recorded image, and the registry nodes whose last observation lists it, online or not. */
export type ImageEntry = RecordedImage & { nodes: NodeName[] };
export interface ImagesView { current: ImageId | null; previous: ImageId | null; images: ImageEntry[]; operation: ImageOperation | null }

/** The images newest build first. */
export function imagesView(registry: Registry): ImagesView {
  const nodes = registry.nodes();
  const images = registry.images()
    .map((image): ImageEntry => ({ ...image, nodes: nodes.filter((n) => holds(n, image.id)).map((n) => n.name) }))
    .sort((a, b) => Date.parse(b.builtAt) - Date.parse(a.builtAt));
  return { current: registry.currentImage(), previous: registry.previousImage(), images, operation: registry.imageOperation() };
}

const holds = (node: NodeRecord, image: ImageId): boolean => node.observation?.artifacts.includes(image) === true;

export interface ImageRollout {
  build(caller: TailnetNodeId): Promise<ImageOperation>;
  rollout(image: ImageId, caller: TailnetNodeId): ImageOperation;
  rollback(caller: TailnetNodeId): ImageOperation;
  /** Advances the operation. Resolves once a pass that began after this call has finished. */
  wake(): Promise<void>;
  close(): Promise<void>;
}

export interface ImageRolloutOptions {
  registry: Registry;
  /** One client per registry node. */
  probes: ReadonlyMap<NodeName, Pick<ProbeClient, "submit" | "job" | "manifest">>;
  buildNode: NodeName;
  /** The recipe of the release the control plane runs. */
  recipe(): Promise<ImageRecipe>;
  /** That release's full commit, which a build records, or null when it is unknown. */
  release: string | null;
  intervalMs?: number;
  log?: (message: string) => void;
}

export function startImageRollout(options: ImageRolloutOptions): ImageRollout {
  const { registry, probes } = options;
  const log = options.log ?? ((message: string) => console.error(message));
  const online = (node: NodeRecord): boolean => node.state === "online" && probes.has(node.name);

  /** The running operation if it is this one, or null when none runs. Another one running is a conflict. */
  function running(kind: ImageOperation["kind"], image: ImageId): ImageOperation | null {
    const operation = registry.imageOperation();
    if (operation?.state !== "running") return null;
    if (operation.kind === kind && operation.image === image) return operation;
    throw new HttpError(409, `a ${operation.kind} of ${operation.image} is running. Wait for it to finish`);
  }

  function start(operation: ImageOperation): ImageOperation {
    registry.saveImageOperation(operation);
    void wake();
    return operation;
  }

  function rollout(image: ImageId, caller: TailnetNodeId): ImageOperation {
    if (registry.image(image) === undefined) throw new HttpError(404, `no image ${image} is recorded`);
    const same = running("rollout", image);
    if (same !== null) return same;
    const nodes = registry.nodes();
    if (!nodes.some((n) => online(n) && holds(n, image))) throw new HttpError(409, `no online node holds ${image}, so no node could fetch it`);
    return start({
      kind: "rollout", image, requestedBy: caller, requestedAt: Date.now(), state: "running",
      steps: nodes.map((n) => online(n)
        ? { node: n.name, state: "pending", job: null, reason: null }
        : { node: n.name, state: "skipped", job: null, reason: "offline when the rollout began; it fetches the image on first use" }),
    });
  }

  /** The job that puts the image on `node`, or why none can. */
  async function jobFor(operation: ImageOperation, node: NodeName): Promise<Job | string> {
    if (operation.kind === "build") {
      const recipe = await options.recipe();
      const id = imageIdOf(recipe);
      return id === operation.image ? { kind: "build-image", image: id, recipe } : `the control plane now runs another release, whose recipe is ${id}`;
    }
    const recorded = registry.image(operation.image)!;
    const holders = registry.nodes().filter((n) => n.name !== node && online(n) && holds(n, operation.image)).map((n) => n.name);
    const from = holders.find((n) => n === recorded.builtOn) ?? holders[0];
    return from === undefined ? "no online node holds it" : { kind: "fetch-artifact", artifact: operation.image, from, sha256: recorded.sha256 };
  }

  /** Moves the step on as far as its node allows now. Returns why the operation fails, or null. */
  async function advance(operation: ImageOperation, step: ImageStep, set: (next: Partial<ImageStep>) => void): Promise<string | null> {
    const node = registry.node(step.node);
    const failed = (reason: string) => {
      set({ state: "failed", reason });
      return `${step.node} could not ${operation.kind === "build" ? "build" : "fetch"} ${operation.image}: ${reason}`;
    };
    if (node === undefined || !online(node)) {
      set({ state: "failed", reason: "went offline" });
      return `${step.node} went offline before it held ${operation.image}`;
    }
    const probe = probes.get(step.node)!;
    if (holds(node, operation.image)) {
      // A copy from before this rollout, such as one made by hand, may hold other bytes under the same ID.
      if (operation.kind === "rollout") {
        const held = (await probe.manifest(operation.image))?.sha256;
        const recorded = registry.image(operation.image)!.sha256;
        if (held !== recorded) return failed(`it holds ${operation.image} with sha256 ${held ?? "unknown"}, not the recorded ${recorded}`);
      }
      set({ state: "done", job: null, reason: null });
      return null;
    }
    if (step.job !== null) {
      // Only a lookup that began after notAfter proves the probe can no longer accept the envelope.
      const askedAt = Date.now();
      const status = await probe.job(step.job.id);
      if (status === "unknown") {
        if (askedAt > Date.parse(step.job.notAfter)) set({ state: "pending", job: null });
        return null;
      }
      if (status.state === "failed") return failed(`${status.code}: ${failureMessage(status.message, status.logTail)}`);
      // A job that succeeded waits for the observation that lists the image.
      if (step.state !== "running") set({ state: "running" });
      return null;
    }
    const job = await jobFor(operation, step.node);
    if (typeof job === "string") return failed(job);
    const env = envelope(job, step.node, Date.now());
    set({ job: { id: env.jobId, notAfter: env.notAfter } });
    const reply = await probe.submit(env);
    if ("accepted" in reply) set({ state: "running" });
    else if (reply.rejected === "invalid") return failed(reply.message);
    // busy: another job on the image runs on the node, such as a pylon's fetch of it. expired: the send outlived its
    // envelope. Either way the next pass sends again.
    else set({ job: null });
    return null;
  }

  /** Every step is done or skipped. Returns why the operation fails, or null. */
  async function finish(operation: ImageOperation): Promise<string | null> {
    if (operation.kind === "rollout") {
      registry.setCurrentImage(operation.image);
      return null;
    }
    const { node } = operation.steps[0]!;
    const manifest = await probes.get(node)!.manifest(operation.image);
    if (manifest === null) return `${node} lists ${operation.image} but serves no manifest of it, as a probe older than this control plane does. Upgrade it with nexus deploy, then build again, which finishes at once`;
    if (manifest.id !== operation.image) return `${node} answered the manifest of ${manifest.id} for ${operation.image}`;
    registry.saveImage(manifest as ImageManifest, options.release);
    return null;
  }

  async function pass() {
    const operation = registry.imageOperation();
    if (operation?.state !== "running") return;
    const steps = [...operation.steps];
    const { kind, image, requestedBy, requestedAt } = operation;
    const save = (outcome: Outcome) => registry.saveImageOperation({ kind, image, requestedBy, requestedAt, steps, ...outcome });
    const what = `image ${kind} of ${image}`;
    const unexpected = (err: unknown) => { if ((err as ProbeError).code !== "unreachable") log(`${what}: ${(err as Error).message}`); };
    const end = (reason: string | null) => {
      save(reason === null ? { state: "done", finishedAt: Date.now() } : { state: "failed", finishedAt: Date.now(), reason });
      log(reason === null ? `${what} is done` : `${what} failed: ${reason}`);
    };
    for (let i = 0; i < steps.length; i++) {
      if (steps[i]!.state !== "pending" && steps[i]!.state !== "running") continue;
      const set = (next: Partial<ImageStep>) => {
        steps[i] = { ...steps[i]!, ...next };
        save({ state: "running" });
      };
      try {
        const reason = await advance(operation, steps[i]!, set);
        if (reason !== null) return end(reason);
      } catch (err) {
        unexpected(err);
      }
    }
    if (!steps.every((s) => s.state === "done" || s.state === "skipped")) return;
    try {
      end(await finish(operation));
    } catch (err) {
      unexpected(err);
    }
  }

  let passing: Promise<void> | null = null;
  let again = false;
  let closed = false;
  function wake(): Promise<void> {
    if (closed) return Promise.resolve();
    again = true;
    passing ??= (async () => {
      try {
        while (again && !closed) {
          again = false;
          await pass();
        }
      } finally {
        passing = null;
      }
    })();
    return passing;
  }
  const timer = setInterval(() => void wake(), options.intervalMs ?? 2_000);

  return {
    async build(caller) {
      const image = imageIdOf(await options.recipe());
      const same = running("build", image);
      if (same !== null) return same;
      const node = options.buildNode;
      if (registry.image(image) !== undefined) {
        const now = Date.now();
        return start({ kind: "build", image, requestedBy: caller, requestedAt: now, steps: [{ node, state: "done", job: null, reason: "recorded already" }], state: "done", finishedAt: now });
      }
      const record = registry.node(node);
      if (record === undefined) throw new HttpError(409, `the image build node ${node} is not a node of this control plane`);
      if (!online(record)) throw new HttpError(409, `the image build node ${node} is offline`);
      return start({ kind: "build", image, requestedBy: caller, requestedAt: Date.now(), steps: [{ node, state: "pending", job: null, reason: null }], state: "running" });
    },
    rollout,
    rollback(caller) {
      const previous = registry.previousImage();
      if (previous === null) throw new HttpError(409, "no image was current before this one, so there is none to roll back to");
      return rollout(previous, caller);
    },
    wake,
    async close() {
      closed = true;
      clearInterval(timer);
      await passing;
    },
  };
}
