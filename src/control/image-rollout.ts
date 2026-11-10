/**
 * Image builds and rollouts: one stored operation at a time, which a pass advances every 2 seconds and whenever the API
 * starts one. A build runs the recipe of the release the control plane runs on the image build node, then records the
 * manifest that node holds. A rollout copies a recorded image to every online node that lacks it, and makes it current
 * only once each holds it, since `--node auto` places a pylon only on a node that holds the current image. A rollback is
 * a rollout of the previous image.
 *
 * While no rollout runs, a pass also sends the current image to each online node that lacks it, as one that joined or
 * was offline when the last rollout began, so `auto` placement does not pass over it for good. A node gets
 * maxImageFetches jobs in a row, each after the backoff from the last failure, and then none until a rollout begins or
 * it goes offline and comes back.
 *
 * A pass derives each step from its node's observation and the probe's status of the step's job, never from what an
 * earlier pass meant to do, so a control plane that restarts mid-operation carries on from the stored operation.
 */
import { isDeepStrictEqual } from "node:util";
import { imageIdOf, type ImageManifest, type ImageRecipe } from "../protocol/images.ts";
import type { ImageId, NodeName, TailnetNodeId } from "../ids.ts";
import type { Job } from "../protocol/jobs.ts";
import type { ProbeError } from "../protocol/http.ts";
import type { ProbeClient } from "../protocol/client.ts";
import { singleFlight } from "../single-flight.ts";
import { backoffMs, failureMessage } from "./reconcile.ts";
import { jobOutcome, submitJob } from "./tick.ts";
import { Refusal } from "./refusal.ts";
import type { Registry } from "./registry.ts";
import type { NodeRecord } from "./node-store.ts";
import { maxImageFetches, type ImageFetch, type ImageOperation, type ImageStep, type Outcome, type RecordedImage } from "./image-store.ts";

type ImageRolloutRegistry = Pick<Registry, "images" | "nodes" | "now">;

/** A recorded image, and the registry nodes whose last observation lists it, online or not. */
export type ImageEntry = RecordedImage & { nodes: NodeName[] };
/**
 * `previous` is the image current before the last rollout, which rollback makes current again. `images` are newest
 * build first, and `operation` is the running operation, or the last one. `fetches` are the copies of the current image
 * the control plane sends outside a rollout, one per online node that lacks it.
 */
export interface ImagesView { current: ImageId | null; previous: ImageId | null; images: ImageEntry[]; operation: ImageOperation | null; fetches: ImageFetch[] }

export function imagesView(registry: ImageRolloutRegistry): ImagesView {
  const nodes = registry.nodes.nodes();
  const images = registry.images.images()
    .map((image): ImageEntry => ({ ...image, nodes: nodes.filter((n) => holds(n, image.id)).map((n) => n.name) }))
    .sort((a, b) => Date.parse(b.builtAt) - Date.parse(a.builtAt));
  return { current: registry.images.currentImage(), previous: registry.images.previousImage(), images, operation: registry.images.imageOperation(), fetches: registry.images.imageFetches() };
}

const holds = (node: NodeRecord, image: ImageId): boolean => node.observation?.artifacts.includes(image) === true;
const noSource = "no other online node holds it";

export interface ImageRollout {
  build(caller: TailnetNodeId): Promise<ImageOperation>;
  rollout(image: ImageId, caller: TailnetNodeId): ImageOperation;
  rollback(caller: TailnetNodeId): ImageOperation;
  /** Advances the operation. Resolves once a pass that began after this call has finished. */
  wake(): Promise<void>;
  readonly everyMs: number;
  poll(): Promise<void>;
  close(): Promise<void>;
}

export interface ImageRolloutOptions {
  registry: ImageRolloutRegistry;
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

  const rolloutRuns = (): boolean => {
    const operation = registry.images.imageOperation();
    return operation?.state === "running" && operation.kind === "rollout";
  };

  /** The running operation if it is this one, or null when none runs. Another one running is a conflict. */
  function running(kind: ImageOperation["kind"], image: ImageId): ImageOperation | null {
    const operation = registry.images.imageOperation();
    if (operation?.state !== "running") return null;
    if (operation.kind === kind && operation.image === image) return operation;
    throw new Refusal("conflict", `a ${operation.kind} of ${operation.image} is running. Wait for it to finish`);
  }

  function start(operation: ImageOperation): ImageOperation {
    registry.images.saveImageOperation(operation);
    void wake();
    return operation;
  }

  function rollout(image: ImageId, caller: TailnetNodeId): ImageOperation {
    if (registry.images.image(image) === undefined) throw new Refusal("missing", `no image ${image} is recorded`);
    const same = running("rollout", image);
    if (same !== null) return same;
    const nodes = registry.nodes.nodes();
    if (!nodes.some((n) => online(n) && holds(n, image))) throw new Refusal("conflict", `no online node holds ${image}, so no node could fetch it`);
    // Its steps cover every online node, and a node it skips or fails gets a fresh run of fetches once it ends.
    registry.images.saveImageFetches([]);
    return start({
      kind: "rollout", image, requestedBy: caller, requestedAt: Date.now(), state: "running",
      steps: nodes.map((n) => online(n)
        ? { node: n.name, state: "pending", job: null, reason: null }
        : { node: n.name, state: "skipped", job: null, reason: "offline when the rollout began; the control plane sends it the image once it is back online" }),
    });
  }

  /** The job that puts the image on `node`, or why none can. */
  async function jobFor(operation: ImageOperation, node: NodeName): Promise<Job | string> {
    if (operation.kind === "build") {
      const recipe = await options.recipe();
      const id = imageIdOf(recipe);
      return id === operation.image ? { kind: "build-image", image: id, recipe } : `the control plane now runs another release, whose recipe is ${id}`;
    }
    return fetchJob(operation.image, node) ?? "no online node holds it";
  }

  /** fetch-artifact of the image to `node` from another online node that holds it, the one that built it if it can, or null when none does. */
  function fetchJob(image: ImageId, node: NodeName): Job | null {
    const recorded = registry.images.image(image)!;
    const holders = registry.nodes.nodes().filter((n) => n.name !== node && online(n) && holds(n, image)).map((n) => n.name);
    const from = holders.find((n) => n === recorded.builtOn) ?? holders[0];
    return from === undefined ? null : { kind: "fetch-artifact", artifact: image, from, sha256: recorded.sha256 };
  }

  /** Moves the step on as far as its node allows now. Returns why the operation fails, or null. */
  async function advance(operation: ImageOperation, step: ImageStep, set: (next: Partial<ImageStep>) => void): Promise<string | null> {
    const node = registry.nodes.node(step.node);
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
        const recorded = registry.images.image(operation.image)!.sha256;
        if (held !== recorded) return failed(`it holds ${operation.image} with sha256 ${held ?? "unknown"}, not the recorded ${recorded}`);
      }
      set({ state: "done", job: null, reason: null });
      return null;
    }
    if (step.job !== null) {
      const status = await jobOutcome(probe, step.job.id, step.job.notAfter);
      if (status === "wait") return null;
      if (status === "expired") {
        set({ state: "pending", job: null });
        return null;
      }
      if (status.state === "failed") return failed(`${status.code}: ${failureMessage(status.message, status.logTail)}`);
      // A job that succeeded waits for the observation that lists the image.
      if (step.state !== "running") set({ state: "running" });
      return null;
    }
    const job = await jobFor(operation, step.node);
    if (typeof job === "string") return failed(job);
    const sent = await submitJob(probe, job, step.node, (env) => set({ job: { id: env.jobId, notAfter: env.notAfter } }));
    if (sent === "accepted") set({ state: "running" });
    else if (sent !== "retry") return failed(sent.invalid);
    // busy: another job on the image runs on the node, such as a pylon's fetch of it.
    else set({ job: null });
    return null;
  }

  /** Every step is done or skipped. Returns why the operation fails, or null. */
  async function finish(operation: ImageOperation): Promise<string | null> {
    if (operation.kind === "rollout") {
      registry.images.setCurrentImage(operation.image);
      return null;
    }
    const { node } = operation.steps[0]!;
    const manifest = await probes.get(node)!.manifest(operation.image);
    if (manifest === null) return `${node} lists ${operation.image} but serves no manifest of it, as a probe older than this control plane does. Upgrade it with nexus deploy, then build again, which finishes at once`;
    if (manifest.id !== operation.image) return `${node} answered the manifest of ${manifest.id} for ${operation.image}`;
    registry.images.saveImage(manifest as ImageManifest, operation.release);
    return null;
  }

  async function advanceOperation(operation: ImageOperation) {
    const steps = [...operation.steps];
    const { kind, image } = operation;
    const save = (outcome: Outcome) => registry.images.saveImageOperation({ ...operation, steps, ...outcome } as ImageOperation);
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

  /** Moves the node's fetch on as far as it allows now. */
  async function advanceFetch(fetch: ImageFetch, set: (next: Partial<ImageFetch>) => void) {
    if (fetch.state === "failed") return;
    const probe = probes.get(fetch.node)!;
    const failed = (reason: string, invalid = false) => {
      const failures = fetch.failures + 1;
      const state = invalid || failures >= maxImageFetches ? "failed" : "waiting";
      set({ state, job: null, failures, failedAt: registry.now(), reason });
      const what = invalid ? "was refused as invalid" : `failed ${failures} times in a row`;
      if (state === "failed") log(`image fetch of ${fetch.image} to ${fetch.node} ${what}, and none is sent again until a rollout begins or the node comes back online: ${reason}`);
    };
    if (fetch.job !== null) {
      const status = await jobOutcome(probe, fetch.job.id, fetch.job.notAfter);
      if (status === "wait") return;
      if (status === "expired") return set({ state: "waiting", job: null });
      if (status.state === "failed") return failed(`${status.code}: ${failureMessage(status.message, status.logTail)}`);
      // A job that succeeded waits for the observation that lists the image.
      if (fetch.state !== "running") set({ state: "running" });
      return;
    }
    if (fetch.failedAt !== null && registry.now() < fetch.failedAt + backoffMs(fetch.failures)) return;
    const job = fetchJob(fetch.image, fetch.node);
    if (job === null) {
      if (fetch.reason !== noSource) set({ reason: noSource });
      return;
    }
    const sent = await submitJob(probe, job, fetch.node, (env) => set({ job: { id: env.jobId, notAfter: env.notAfter } }));
    if (sent === "accepted") set({ state: "running", reason: fetch.reason === noSource ? null : fetch.reason });
    // busy: another job on the image runs on the node, such as a pylon's fetch of it.
    else if (sent === "retry") set({ job: null });
    else failed(sent.invalid, true);
  }

  /** The current image to each online node that lacks it, one record per node, derived again on every pass. */
  async function catchUp() {
    const stored = registry.images.imageFetches();
    const image = registry.images.currentImage();
    const fetches = image === null ? [] : registry.nodes.nodes().filter((n) => online(n) && !holds(n, image)).map((n): ImageFetch => {
      const was = stored.find((f) => f.node === n.name);
      return was?.image === image ? was : { node: n.name, image, state: "waiting", job: null, failures: 0, failedAt: null, reason: null };
    });
    // A rollout that began while this pass waited on a probe cleared the records, and its steps take over.
    const save = () => { if (!rolloutRuns()) registry.images.saveImageFetches(fetches); };
    if (!isDeepStrictEqual(fetches, stored)) save();
    for (let i = 0; i < fetches.length; i++) {
      if (rolloutRuns()) return;
      const set = (next: Partial<ImageFetch>) => {
        fetches[i] = { ...fetches[i]!, ...next };
        save();
      };
      try {
        await advanceFetch(fetches[i]!, set);
      } catch (err) {
        if ((err as ProbeError).code !== "unreachable") log(`image fetch of ${image} to ${fetches[i]!.node}: ${(err as Error).message}`);
      }
    }
  }

  /** The running operation first, then, unless a rollout still runs, the fetches of the current image. */
  async function pass() {
    const operation = registry.images.imageOperation();
    if (operation?.state === "running") {
      await advanceOperation(operation);
      if (rolloutRuns()) return;
    }
    await catchUp();
  }

  let closed = false;
  const passes = singleFlight(pass, () => closed);
  const wake = passes.rerun;

  return {
    async build(caller) {
      const image = imageIdOf(await options.recipe());
      const same = running("build", image);
      if (same !== null) return same;
      const node = options.buildNode;
      if (registry.images.image(image) !== undefined) {
        const now = Date.now();
        return start({ kind: "build", release: options.release, image, requestedBy: caller, requestedAt: now, steps: [{ node, state: "done", job: null, reason: "recorded already" }], state: "done", finishedAt: now });
      }
      const record = registry.nodes.node(node);
      if (record === undefined) throw new Refusal("conflict", `the image build node ${node} is not a node of this control plane`);
      if (!online(record)) throw new Refusal("conflict", `the image build node ${node} is offline`);
      return start({ kind: "build", release: options.release, image, requestedBy: caller, requestedAt: Date.now(), steps: [{ node, state: "pending", job: null, reason: null }], state: "running" });
    },
    rollout,
    rollback(caller) {
      const previous = registry.images.previousImage();
      if (previous === null) throw new Refusal("conflict", "no image was current before this one, so there is none to roll back to");
      return rollout(previous, caller);
    },
    wake,
    everyMs: options.intervalMs ?? 2_000,
    poll: wake,
    async close() {
      closed = true;
      await passes.settled();
    },
  };
}
