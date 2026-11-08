/** The probe's job table: each job's status until jobRetentionMs after it finished, and the job running on each subject. */
import type { JobId, NodeName } from "../ids.ts";
import {
  encodeSubmitReply, JobFailure, jobSubject, parseJobEnvelope, type Job, type JobEnvelope, type JobStatus, type Subject,
} from "../protocol/jobs.ts";
import type { ProbeEvent } from "../protocol/observations.ts";
import { jobHooks, runJob, type JobEffects, type JobHooks, type ProbeDeps } from "./run.ts";

const jobRetentionMs = 10 * 60_000;

export interface JobTableDeps {
  node: NodeName;
  deadlines: { readonly [K in Job["kind"]]: number };
  deps: ProbeDeps;
  effects: JobEffects;
  /** Aborted when the probe closes, which aborts every job. */
  closed: AbortSignal;
  /** Aborted once the node's shutdown drains the probe, which then starts no job but the drain's own pauses. */
  draining: AbortSignal;
  emit(event: ProbeEvent): void;
  redacted(text: string): string;
  publishSnapshot(): Promise<void>;
}

export function createJobTable({ node, deadlines, deps, effects, closed, draining, emit, redacted, publishSnapshot }: JobTableDeps) {
  const jobs = new Map<JobId, { status: JobStatus; finishedAt: number | null }>();
  const busy = new Map<Subject, JobId>();
  /** Each running job's run, which settles once its result is published. */
  const running = new Map<Promise<JobStatus>, Job>();

  function setStatus(status: JobStatus, finishedAt: number | null) {
    jobs.set(status.jobId, { status, finishedAt });
    emit({ type: "job", status });
  }

  /** `ended` settles with the job's result once it is published. */
  function start(env: JobEnvelope, subject: Subject, deadlineMs = deadlines[env.job.kind]): { running: JobStatus; ended: Promise<JobStatus> } {
    const { job, jobId } = env;
    const base = { jobId, subject, kind: job.kind };
    const status: JobStatus = { ...base, state: "running", startedAt: new Date().toISOString() };
    busy.set(subject, jobId);
    setStatus(status, null);
    // Each kind's hooks take its own kind of job, which job.kind picks.
    const hooks = jobHooks[job.kind] as JobHooks<Job["kind"]>;
    const succeeded = hooks.started(job, effects);
    const signal = AbortSignal.any([AbortSignal.timeout(deadlineMs), closed, ...hooks.drainAborts ? [draining] : []]);
    const end = (status: JobStatus): JobStatus => {
      setStatus(status, Date.now());
      return status;
    };
    const run = runJob(job, deps, signal).then(
      () => {
        succeeded();
        return end({ ...base, state: "succeeded", finishedAt: new Date().toISOString() });
      },
      (err: unknown) => {
        if (!(err instanceof JobFailure)) throw err;
        return end({ ...base, state: "failed", finishedAt: new Date().toISOString(), code: err.code, message: redacted(err.message), logTail: redacted(err.logTail) });
      },
    ).finally(() => {
      busy.delete(subject);
      running.delete(run);
    }).then(async (status) => {
      await publishSnapshot();
      return status;
    });
    running.set(run, job);
    return { running: status, ended: run };
  }

  function submit(jobId: JobId, body: string) {
    const known = jobs.get(jobId);
    if (known) return encodeSubmitReply({ accepted: known.status });
    if (draining.aborted) return encodeSubmitReply({ rejected: "draining" });
    let env: JobEnvelope;
    try {
      env = parseJobEnvelope(body);
    } catch (err) {
      return encodeSubmitReply({ rejected: "invalid", message: (err as Error).message });
    }
    if (env.jobId !== jobId) return encodeSubmitReply({ rejected: "invalid", message: `envelope jobId ${env.jobId} differs from the path` });
    if (env.node !== node) return encodeSubmitReply({ rejected: "invalid", message: `envelope is for ${env.node}, this probe is ${node}` });
    if (Date.now() > Date.parse(env.notAfter)) return encodeSubmitReply({ rejected: "expired" });
    const subject = jobSubject(env.job);
    const inFlight = busy.get(subject);
    if (inFlight !== undefined) return encodeSubmitReply({ rejected: "busy", inFlight });
    return encodeSubmitReply({ accepted: start(env, subject).running });
  }

  return {
    submit,
    start,
    status: (jobId: JobId): JobStatus | undefined => jobs.get(jobId)?.status,
    retained(): JobStatus[] {
      const cutoff = Date.now() - jobRetentionMs;
      for (const [id, job] of jobs) if (job.finishedAt !== null && job.finishedAt < cutoff) jobs.delete(id);
      return [...jobs.values()].map((job) => job.status);
    },
    busy: (subject: Subject): boolean => busy.has(subject),
    running: running as ReadonlyMap<Promise<JobStatus>, Job>,
  };
}
