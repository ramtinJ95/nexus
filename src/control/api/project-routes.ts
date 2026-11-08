import type { ProjectId } from "../../ids.ts";
import type { Features } from "../features.ts";
import { HttpError } from "../http-error.ts";
import type { AutoReviewMode, Project } from "../project.ts";
import { editedRules } from "../standing-rules.ts";
import { ok, created, on, parse, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed, demand, landing } from "./access.ts";
import { projectRoutes as routes } from "../../contract/projects.ts";
import { projectAddSchema, projectEditSchema, projectSchema } from "../../contract/projects-parse.ts";


export function projectRoutes(kit: ApiKit, features: Features): readonly RouteEntry[] {
  const { registry } = kit;

  function refuseUnknownNode(project: Project) {
    if (project.defaultNode !== "auto" && registry.node(project.defaultNode) === undefined) throw new HttpError(400, `no node ${project.defaultNode}`);
  }

  function createProject(body: unknown): Project {
    const { standingRules, ...fields } = parse(projectAddSchema, body);
    const rules = standingRules === undefined ? undefined : editedRules(undefined, standingRules);
    const project: Project = { ...fields, ...rules === undefined ? {} : { standingRules: rules } };
    refuseUnknownNode(project);
    if (registry.project(project.id) !== undefined) throw new HttpError(409, `project ${project.id} exists`);
    registry.createProject(project);
    return project;
  }

  return [
    on(routes.edit, { role: "person", action: "edit a project" }, async ({ project: id }, r) => {
      const { autoReview, pipeline, standingRules, secondReview, ...patch } = parse(projectEditSchema, await r.body());
      // A CLI older than modes sends `land`.
      const mode: AutoReviewMode | null | undefined = autoReview == null ? autoReview : "mode" in autoReview ? autoReview.mode : autoReview.land ? "land" : "review";
      if (mode === "land" || mode === "yolo") demand(r.roles, landing);
      const project = registry.editProject(id as ProjectId, ({ autoReview: kept, pipeline: running, standingRules: standing, secondReview: second, ...previous }) => {
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
    on(routes.list, anyAllowed, () => ok(registry.projects())),
    on(routes.add, { role: "allowed", why: "adding a project changes no thread, pylon or project there is" }, async (_, r) => created(createProject(await r.body()))),
  ];
}
