import { requestIds, type ProjectId } from "../../ids.ts";
import type { Features } from "../features.ts";
import { HttpError } from "../http-error.ts";
import type { AutoReviewMode, Project } from "../project.ts";
import { editedRules } from "../standing-rules.ts";
import { ok, created, on, parse, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed, demand, landing } from "./access.ts";
import { projectRoutes as routes } from "../../contract/projects.ts";
import { projectAddSchema, projectEditSchema, projectSchema } from "../../contract/projects-parse.ts";
import { openStatuses } from "../reconcile.ts";


export function projectRoutes(kit: ApiKit, features: Features): readonly RouteEntry[] {
  const { registry } = kit;

  function refuseUnknownNode(project: Project) {
    if (project.defaultNode !== "auto" && registry.nodes.node(project.defaultNode) === undefined) throw new HttpError(400, `no node ${project.defaultNode}`);
  }

  function createProject(body: unknown): Project {
    const { standingRules, ...fields } = parse(projectAddSchema, body);
    const rules = standingRules === undefined ? undefined : editedRules(undefined, standingRules);
    const project: Project = { ...fields, ...rules === undefined ? {} : { standingRules: rules } };
    refuseUnknownNode(project);
    if (registry.projects.project(project.id) !== undefined) throw new HttpError(409, `project ${project.id} exists`);
    registry.projects.createProject(project);
    return project;
  }

  return [
    on(routes.edit, { role: "person", action: "edit a project" }, async ({ project: id }, r) => {
      const { autoReview, pipeline, standingRules, secondReview, ...patch } = parse(projectEditSchema, await r.body());
      // A CLI older than modes sends `land`.
      const mode: AutoReviewMode | null | undefined = autoReview == null ? autoReview : "mode" in autoReview ? autoReview.mode : autoReview.land ? "land" : "review";
      if (mode === "land" || mode === "yolo") demand(r.roles, landing, r.caller);
      const project = registry.projects.editProject(id as ProjectId, ({ autoReview: kept, pipeline: running, standingRules: standing, secondReview: second, ...previous }) => {
        if (previous.removed !== undefined) throw new HttpError(409, `project ${id} is removed; its history is read-only`);
        const updated: Project = parse(projectSchema, { ...previous, ...patch, resources: { ...previous.resources, ...patch.resources } });
        refuseUnknownNode(updated);
        const review = mode === undefined ? kept : mode === null ? null : { mode, enabledBy: r.caller };
        // An off pipeline stays null, so the migration that turns it on for project nexus never turns it back on.
        const items = pipeline === undefined ? running : pipeline;
        const rules = standingRules === undefined ? standing : editedRules(standing, standingRules);
        const reviewers = secondReview === undefined ? second : secondReview;
        return { ...updated, ...review == null ? {} : { autoReview: review }, ...items === undefined ? {} : { pipeline: items }, ...rules == null ? {} : { standingRules: rules }, ...reviewers == null ? {} : { secondReview: reviewers } };
      });
      if (pipeline !== undefined) void features.pipeline?.poll();
      if (project === undefined) throw new HttpError(404, `no project ${id}`);
      return ok(project);
    }),
    on(routes.remove, { role: "person", action: "remove a project" }, ({ project: id }, r) => {
      // Check and mark in the same transaction. No await may let a start or an unarchive slip between them.
      const project = registry.projects.editProject(id as ProjectId, (stored) => {
        if (stored.removed !== undefined) return stored;
        if (registry.projects.starting(stored.id)) throw new HttpError(409, `project ${id} has a thread starting; wait for it to finish`);
        const open = registry.threads.threads({ project: stored.id, status: openStatuses });
        const queued = registry.queue.queuedThreads().filter((q) => q.project === id && q.status === "queued");
        const items = registry.pipeline.items().filter((i) => i.project === id && i.cancelled === null && registry.threads.startRequest(requestIds.pipeline(i.id)) === undefined);
        if (open.length || queued.length || items.length) throw new HttpError(409,
          `project ${id} has open work: ${[...open.map((t) => t.id), ...queued.map((q) => q.id), ...items.map((i) => i.id)].join(", ")}. Archive its threads and cancel its unstarted pipeline items first`);
        const prs = registry.prWatches.withOpenPr().filter((thread) => registry.threads.thread(thread)?.project === id);
        if (prs.length) throw new HttpError(409, `project ${id} has open pull requests linked to ${prs.join(", ")}; settle them before removing it`);
        return { ...stored, removed: { at: registry.now(), by: r.caller }, autoReview: null, pipeline: null };
      });
      if (project === undefined) throw new HttpError(404, `no project ${id}`);
      return ok(project);
    }),
    on(routes.list, anyAllowed, (_, r) => ok(registry.projects.projects(r.query))),
    on(routes.add, { role: "allowed", why: "adding a project changes no thread, pylon or project there is" }, async (_, r) => created(createProject(await r.body()))),
  ];
}
