/**
 * Adding, listing and editing projects.
 */
import { z } from "zod";
import type { NodeName, ProjectId } from "../../ids.ts";
import type { Pipeline } from "../pipeline.ts";
import { HttpError } from "../http-error.ts";
import { chatgptTokenGrant, secretHostPattern, secretNamePattern } from "../../secret-grants.ts";
import { gitIdentitySchema } from "../../spawn.ts";
import { gitUrl, type Project } from "../project.ts";
import { editedRules, standingRulesLimit } from "../standing-rules.ts";
import { ok, created, parse, type RouteEntry, type ApiKit } from "./kit.ts";

const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const host = z.string().min(1);
export const projectSchema = z.strictObject({
  id: name.transform((id) => id as ProjectId),
  repoUrl: gitUrl.nullable(),
  defaultBranch: z.string().min(1),
  defaultNode: z.string().min(1).transform((node) => node as NodeName | "auto"),
  resources: z.strictObject({ cpus: z.int().positive(), memoryGiB: z.int().positive(), diskGiB: z.int().positive() }),
  allowedHosts: z.array(host),
  secrets: z.array(z.strictObject({ name: z.string().regex(secretNamePattern), hosts: z.array(z.string().regex(secretHostPattern)).min(1) }))
    .refine((grants) => new Set(grants.map((grant) => grant.name)).size === grants.length, "duplicate secret names: list all of a secret's hosts in one grant")
    .refine((grants) => !grants.some((grant) => grant.name === chatgptTokenGrant.name), `${chatgptTokenGrant.name} comes with the chatgpt login: add the login instead`),
  logins: z.array(z.enum(["claude", "chatgpt"])),
  preSetup: z.string().nullable(),
  gitIdentity: gitIdentitySchema.nullable().optional(),
});
const rulesText = z.string().trim().min(1).max(standingRulesLimit).refine((text) => !text.includes("\0"), "standing rules cannot hold a NUL character, which no Claude prompt can");
/** A caller gives standing rules as their text, and Nexus counts their revisions. */
const projectAddSchema = projectSchema.extend({ standingRules: rulesText.optional() });
const secondReviewSchema = z.union([
  z.strictObject({ always: z.literal(true) }),
  z.strictObject({ always: z.literal(false), lines: z.int().positive().nullable(), reserved: z.boolean() }).refine((rule) => rule.lines !== null || rule.reserved, "a second reviewer's rule names a size of change, reserved paths, or always"),
]);
/** Only an edit sets `autoReview`, and the API records its caller in it, so a project's add cannot name someone else. */
const projectEditSchema = projectSchema.omit({ id: true, repoUrl: true, preSetup: true })
  .extend({
    resources: projectSchema.shape.resources.partial(), autoReview: z.strictObject({ land: z.boolean() }).nullable(), pipeline: z.strictObject({ autoStart: z.boolean() }).nullable(),
    standingRules: rulesText.nullable(), secondReview: secondReviewSchema.nullable(),
  }).partial();

export function projectRoutes(kit: ApiKit, options: { pipeline?: Pipeline | null | undefined }): readonly RouteEntry[] {
  const { mayLand, registry } = kit;

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
    ["PATCH", /^\/v1\/projects\/([^/]+)$/, { person: "edit a project" }, async ([, id], r) => {
      const { autoReview, pipeline, standingRules, secondReview, ...patch } = parse(projectEditSchema, await r.body());
      if (autoReview?.land) mayLand(r.caller);
      const project = registry.editProject(id as ProjectId, ({ autoReview: kept, pipeline: running, standingRules: standing, secondReview: second, ...previous }) => {
        const updated: Project = parse(projectSchema, { ...previous, ...patch, resources: { ...previous.resources, ...patch.resources } });
        refuseUnknownNode(updated);
        const review = autoReview === undefined ? kept : autoReview === null ? null : { land: autoReview.land, enabledBy: r.caller };
        // An off pipeline stays null, so the migration that turns it on for project nexus never turns it back on.
        const items = pipeline === undefined ? running : pipeline;
        const rules = standingRules === undefined ? standing : editedRules(standing, standingRules);
        const reviewers = secondReview === undefined ? second : secondReview;
        return { ...updated, ...review == null ? {} : { autoReview: review }, ...items === undefined ? {} : { pipeline: items }, ...rules == null ? {} : { standingRules: rules }, ...reviewers == null ? {} : { secondReview: reviewers } };
      });
      if (pipeline !== undefined) void options.pipeline?.poll();
      if (project === undefined) throw new HttpError(404, `no project ${id}`);
      return ok(project);
    }],
    ["GET", /^\/v1\/projects$/, () => ok(registry.projects())],
    ["POST", /^\/v1\/projects$/, { open: "adding a project changes no thread, pylon or project there is" }, async (_, r) => created(createProject(await r.body()))],
  ];
}
