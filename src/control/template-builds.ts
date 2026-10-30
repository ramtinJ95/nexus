/**
 * The template build lane. A building record says its template should be built on its node, and each loop pass over
 * that node moves the record one step from what the record and the node's latest observation show. It keeps no state
 * of its own, so a control plane that restarts anywhere picks up where the record stands: the envelope is saved before
 * it is sent, as tick.ts saves a pylon's, and a build sent again converges on what its node's disk already holds.
 */
import { failureMessage } from "../reconcile.ts";
import { jobOutcome, submitJob } from "../tick.ts";
import { retryable, type JobErrorCode } from "../protocol/jobs.ts";
import type { NodeObservation } from "../protocol/observations.ts";
import type { ProbeClient } from "../protocol/client.ts";
import type { BuildingTemplate } from "./templates.ts";
import type { Registry } from "./registry.ts";

export interface BuildContext {
  probe: ProbeClient;
  /** The node's latest observation, or null while its probe is unreachable. */
  observation: NodeObservation | null;
  registry: Pick<Registry, "saveTemplate" | "deleteTemplate">;
  log(message: string): void;
}

/**
 * - Not sent yet: send it. A busy or expired refusal is sent again on the next pass.
 * - Sent, and unknown to the probe once its envelope has expired: never accepted, or lost in a probe restart, so the
 *   next pass sends it again.
 * - Succeeded: ready once the observation lists the template, so a start in between never finds a ready template its
 *   node does not list and builds the key again.
 * - Failed with a code a retry cannot help: failed with its log, which every later start of its key on the node boots
 *   fresh with.
 * - Failed with a retryable code: the record goes, so the next start of its key builds again instead of an outage
 *   holding the key fresh for good.
 */
export async function tickTemplateBuild(record: BuildingTemplate, ctx: BuildContext): Promise<void> {
  const { probe, observation, registry } = ctx;
  if (observation === null) return;
  if (record.submitted === null) {
    const sent = await submitJob(probe, { kind: "build-template", template: record.id, inputs: record.inputs }, record.on, (submitted) => registry.saveTemplate({ ...record, submitted }));
    if (sent === "accepted") return;
    if (sent !== "retry") return failed(record, "invalid", failureMessage(sent.invalid, ""), ctx);
    registry.saveTemplate({ ...record, submitted: null });
    return;
  }
  const { jobId, notAfter } = record.submitted;
  const status = await jobOutcome(probe, jobId, notAfter, observation.jobs.find((j) => j.jobId === jobId));
  if (status === "wait") return;
  if (status === "expired") {
    registry.saveTemplate({ ...record, submitted: null });
    return;
  }
  switch (status.state) {
    case "running": return;
    case "succeeded":
      if (observation.artifacts.includes(record.id)) registry.saveTemplate({ id: record.id, key: record.key, state: "ready", builtOn: record.on, builtAt: Date.now(), commit: record.inputs.repo.commit });
      return;
    case "failed": return failed(record, status.code, failureMessage(status.message, status.logTail), ctx);
  }
}

function failed(record: BuildingTemplate, code: JobErrorCode, message: string, { registry, log }: BuildContext) {
  if (retryable[code]) {
    registry.deleteTemplate(record.id);
    log(`${record.id}: the template build on ${record.on} failed with ${code}, so the next thread of its setup builds it again: ${message}`);
    return;
  }
  registry.saveTemplate({ id: record.id, key: record.key, state: "failed", on: record.on, failedAt: Date.now(), logTail: message });
  log(`${record.id}: the template build on ${record.on} failed with ${code}, so threads of its setup there boot fresh: ${message}`);
}
