/**
 * Probe contract, jobs. Amp's spawn, pause and delete, plus the artifact work Amp does on its own servers.
 *
 * Invariants:
 * - The probe writes no durable Nexus record. Its only durable state is what the backend keeps on disk
 *   (VMs, checkpoints, templates, images). Everything else is rebuilt from the next job.
 * - Every job converges. Running it twice, or after a run that stopped partway, gives the same end state.
 * - No job can drop a checkpoint. A checkpoint is the only copy of uncommitted work, so it is removed only
 *   by `delete` of its pylon, and the planner sends `delete` only for pylons the registry knows. A wiped
 *   registry therefore knows no pylons and deletes nothing.
 * - The wire encoding (JSON bodies) is private to this module. Callers see the domain types below. The control plane
 *   reads through `parseSubmitReply`, and the probe through `parseJobEnvelope` and `encodeSubmitReply`.
 */
import { z } from "zod";
import type { BootInputs, LiveSpec } from "../spawn.ts";
import type { ImageRecipe, TemplateBuildInputs } from "../images.ts";
import { asSent, named, nonEmpty, parseJson, unchecked } from "../parse.ts";
import {
  isPortableArtifactId, type ArtifactId, type CheckpointId, type ImageId, type JobId, type LiveHash, type NodeName,
  type PortableArtifactId, type PylonId, type TemplateId,
} from "../ids.ts";
import { imageId, objectAs, pylonIdField, sha256, templateId } from "./fields.ts";

export type Job =
  | { kind: "spawn"; pylonId: PylonId; boot: BootInputs; live: LiveSpec; liveHash: LiveHash; relaunch?: false }
  | { kind: "pause"; pylonId: PylonId; checkpoint: CheckpointId }
  | { kind: "delete"; pylonId: PylonId }
  | { kind: "build-image"; image: ImageId; recipe: ImageRecipe }
  | { kind: "build-template"; template: TemplateId; inputs: TemplateBuildInputs }
  | { kind: "fetch-artifact"; artifact: ArtifactId; from: NodeName; sha256: string }
  | { kind: "drop-artifact"; artifact: PortableArtifactId };

/**
 * spawn means "make this pylon run and look like `live`". It is Amp's spawn plus wake plus "re-apply the
 * live spec". If the VM already runs, `boot` is ignored and only `live` is applied (previews published,
 * overlay files written). That is how a probe restart heals: its observations report `liveHash: null`,
 * so the planner sends spawn again. Unlinking a port withdraws its preview route at once and heals the same way.
 * `relaunch: false` boots without bringing back the pylon's sessions, and leaves them for the next spawn to bring back.
 *
 * pause records the open Herdr sessions in /home/user/.nexus/sessions.json, stops services, writes the
 * disk checkpoint and stops the VM. The session list is on the disk, so the checkpoint carries it and a
 * session opened a second before the pause is still relaunched. The backend keeps a copy of the list beside the
 * checkpoint, which the stopped pylon's observation reports. delete removes the VM, its checkpoint,
 * and its previews. Deleting an absent pylon succeeds.
 */
export const jobDeadlineMs: { readonly [K in Job["kind"]]: number } = {
  spawn: 5 * 60_000,
  pause: 5 * 60_000,
  delete: 5 * 60_000,
  "build-image": 30 * 60_000,
  "build-template": 30 * 60_000, // 20 min setup, plus clone and checkpoint
  "fetch-artifact": 30 * 60_000,
  "drop-artifact": 60_000,
};

/** The probe refuses an envelope after `notAfter`, so a delayed retry of an old pause cannot land after a newer wake. */
export interface JobEnvelope {
  jobId: JobId;
  node: NodeName;
  issuedAt: string;
  notAfter: string; // issuedAt + 30 s. Nodes run NTP
  job: Job;
}

export type Subject = PylonId | ArtifactId;
export function jobSubject(job: Job): Subject {
  switch (job.kind) {
    case "spawn": case "pause": case "delete": return job.pylonId;
    case "build-image": return job.image;
    case "build-template": return job.template;
    case "fetch-artifact": case "drop-artifact": return job.artifact;
  }
}

export type JobErrorCode =
  | "deadline" | "backend" | "checkpoint-failed" | "artifact-missing" | "capacity"
  | "setup-failed" | "secret-missing" | "invalid";

/** The only retry table. It is never sent on the wire, so the probe cannot disagree with it. */
export const retryable: { readonly [C in JobErrorCode]: boolean } = {
  deadline: true, backend: true, "checkpoint-failed": true, "artifact-missing": true, capacity: true,
  "setup-failed": false, "secret-missing": false, invalid: false,
};

export class JobFailure extends Error {
  readonly code: JobErrorCode;
  readonly logTail: string;
  constructor(code: JobErrorCode, message: string, logTail = "") {
    super(message);
    this.code = code;
    this.logTail = logTail;
  }
}

export type JobStatus =
  | { jobId: JobId; subject: Subject; kind: Job["kind"]; state: "running"; startedAt: string }
  | { jobId: JobId; subject: Subject; kind: Job["kind"]; state: "succeeded"; finishedAt: string }
  | { jobId: JobId; subject: Subject; kind: Job["kind"]; state: "failed"; finishedAt: string; code: JobErrorCode; message: string; logTail: string };

/**
 * `draining`: the node is shutting down, and its probe, which pauses every running pylon before it exits, starts no
 * other job until then. The probe of the node's next boot takes jobs again.
 */
export type SubmitReply =
  | { accepted: JobStatus } // also returned for a repeated jobId, with its current status
  | { rejected: "busy"; inFlight: JobId }
  | { rejected: "expired" }
  | { rejected: "draining" }
  | { rejected: "invalid"; message: string };

const submitStatus = { accepted: 200, busy: 409, expired: 410, draining: 503, invalid: 400 } as const;

export function encodeSubmitReply(reply: SubmitReply): { status: number; body: string } {
  return { status: "accepted" in reply ? submitStatus.accepted : submitStatus[reply.rejected], body: JSON.stringify(reply) };
}

const checkpointId = z.string().startsWith("ckpt-", "expected a checkpoint ID").pipe(z.custom<CheckpointId>());

const jobStatusFields = { jobId: named<JobId>(), subject: named<Subject>(), kind: named<Job["kind"]>() };
export const jobStatusSchema = z.discriminatedUnion("state", [
  z.looseObject({ ...jobStatusFields, state: z.literal("running"), startedAt: unchecked<string>() }),
  z.looseObject({ ...jobStatusFields, state: z.literal("succeeded"), finishedAt: unchecked<string>() }),
  z.looseObject({
    ...jobStatusFields, state: z.literal("failed"), finishedAt: unchecked<string>(),
    code: z.enum(Object.keys(retryable) as JobErrorCode[]), message: unchecked<string>(), logTail: unchecked<string>(),
  }),
]) satisfies z.ZodType<JobStatus>;

const submitReplySchemas: Partial<Record<number, z.ZodType<SubmitReply>>> = {
  [submitStatus.accepted]: z.object({ accepted: asSent(jobStatusSchema) }),
  [submitStatus.busy]: z.object({ rejected: z.literal("busy"), inFlight: named<JobId>() }),
  [submitStatus.expired]: z.object({ rejected: z.literal("expired") }),
  [submitStatus.draining]: z.object({ rejected: z.literal("draining") }),
  [submitStatus.invalid]: z.object({ rejected: z.literal("invalid"), message: nonEmpty }),
};

export function parseSubmitReply(status: number, body: string): SubmitReply {
  const schema = submitReplySchemas[status];
  if (schema === undefined) throw new Error(`unexpected submit reply, HTTP ${status}: ${body}`);
  return parseJson(schema, body, "reply");
}

const fresh = z.looseObject({ kind: z.literal("fresh"), preSetup: nonEmpty.nullable() });
const bootSchema = z.looseObject({
  gitIdentity: unchecked<BootInputs["gitIdentity"]>(),
  pylonId: pylonIdField,
  image: imageId,
  source: z.discriminatedUnion("kind", [
    z.looseObject({ kind: z.literal("template"), template: templateId }),
    z.looseObject({ kind: z.literal("resume"), checkpoint: unchecked<CheckpointId>() }),
    fresh,
  ]),
  resources: unchecked<BootInputs["resources"]>(),
  network: unchecked<BootInputs["network"]>(),
  repo: z.discriminatedUnion("kind", [
    z.looseObject({ kind: z.literal("clone"), url: nonEmpty, checkout: z.looseObject({ branch: nonEmpty, commit: nonEmpty }) }),
    z.looseObject({ kind: z.literal("empty"), branch: nonEmpty }),
  ], {
    error: (issue) => issue.code === "invalid_union" && (issue.input as { kind?: unknown }).kind === undefined
      ? "missing, so the control plane that sent it is older than this probe. Upgrade the control plane, then its probes" : undefined,
  }),
  dotfiles: unchecked<BootInputs["dotfiles"]>(),
}) satisfies z.ZodType<BootInputs>;

const jobSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("spawn"), pylonId: pylonIdField, boot: bootSchema,
    live: z.looseObject({ previews: z.array(unchecked<LiveSpec["previews"][number]>()), overlay: z.array(unchecked<LiveSpec["overlay"][number]>()) }),
    liveHash: named<LiveHash>(), relaunch: z.literal(false).exactOptional(),
  }).refine((job) => job.boot.pylonId === job.pylonId, { path: ["boot", "pylonId"], message: "differs from job.pylonId" }),
  z.looseObject({ kind: z.literal("pause"), pylonId: pylonIdField, checkpoint: checkpointId }),
  z.looseObject({ kind: z.literal("delete"), pylonId: pylonIdField }),
  z.looseObject({ kind: z.literal("build-image"), image: imageId, recipe: objectAs<ImageRecipe>() }),
  z.looseObject({ kind: z.literal("build-template"), template: templateId, inputs: objectAs<TemplateBuildInputs>() }),
  z.looseObject({
    kind: z.literal("fetch-artifact"),
    // A checkpoint passes, for runJob to refuse with its reason.
    artifact: z.string().refine((id) => isPortableArtifactId(id) || id.startsWith("ckpt-"), "expected an artifact ID").pipe(z.custom<ArtifactId>()),
    from: named<NodeName>(), sha256,
  }),
  z.looseObject({ kind: z.literal("drop-artifact"), artifact: z.string().pipe(z.custom<PortableArtifactId>(isPortableArtifactId, "expected an image or template ID, and no job drops a checkpoint")) }),
]) satisfies z.ZodType<Job>;

const timestamp = z.string().min(1).refine((t) => !Number.isNaN(Date.parse(t)), "expected a timestamp");
const jobEnvelopeSchema = z.looseObject({
  jobId: named<JobId>(), node: named<NodeName>(), issuedAt: timestamp, notAfter: timestamp, job: jobSchema,
}) satisfies z.ZodType<JobEnvelope>;

/** The probe's side of PUT /v1/jobs/{jobId}. Throws with a message for the `invalid` reply. */
export function parseJobEnvelope(body: string): JobEnvelope {
  return parseJson(asSent(jobEnvelopeSchema), body, "envelope");
}
