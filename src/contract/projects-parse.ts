/** These schemas need zod, so they stay out of projects.ts, which a browser can bundle. */
import { z } from "zod";
import type { NodeName, ProjectId } from "../ids.ts";
import { chatgptTokenGrant, secretHostPattern, secretNamePattern } from "../protocol/secret-grants.ts";
import { gitIdentitySchema } from "../protocol/spawn.ts";
import { defaultProjectResources, gitUrl } from "../control/project.ts";
import { standingRulesLimit } from "../control/standing-rules.ts";
import { briefSchema, itemRules, resourcesSchema, startFields } from "./threads-parse.ts";

const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const host = z.string().min(1);
/** A path inside the repository as git names it in a tree: relative, with no empty, `.` or `..` part. */
const repoPath = z.string().min(1).max(256)
  .refine((path) => !/[\0\n\r]/.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "a template input is a path inside the repository, such as package-lock.json, with no leading or trailing slash and no . or .. parts");
export const templateInputsLimit = 16;
export const projectSchema = z.strictObject({
  id: name.transform((id) => id as ProjectId),
  repoUrl: gitUrl.nullable(),
  defaultBranch: z.string().min(1),
  defaultNode: z.string().min(1).transform((node) => node as NodeName | "auto"),
  resources: resourcesSchema,
  allowedHosts: z.array(host),
  secrets: z.array(z.strictObject({ name: z.string().regex(secretNamePattern), hosts: z.array(z.string().regex(secretHostPattern)).min(1) }))
    .refine((grants) => new Set(grants.map((grant) => grant.name)).size === grants.length, "duplicate secret names: list all of a secret's hosts in one grant")
    .refine((grants) => !grants.some((grant) => grant.name === chatgptTokenGrant.name), `${chatgptTokenGrant.name} comes with the chatgpt login: add the login instead`),
  logins: z.array(z.enum(["claude", "chatgpt"])),
  preSetup: z.string().nullable(),
  gitIdentity: gitIdentitySchema.nullable().optional(),
  templateInputs: z.array(repoPath).max(templateInputsLimit)
    .refine((paths) => new Set(paths).size === paths.length, "a template input is listed twice").optional(),
});
const rulesText = z.string().trim().min(1).max(standingRulesLimit).refine((text) => !text.includes("\0"), "standing rules cannot hold a NUL character, which no Claude prompt can");
/** A caller gives standing rules as their text, and Nexus counts their revisions. */
export const projectAddSchema = projectSchema.extend({
  defaultBranch: projectSchema.shape.defaultBranch.default("main"),
  defaultNode: projectSchema.shape.defaultNode.default("auto"),
  resources: resourcesSchema.partial().optional().transform((size) => ({
    cpus: size?.cpus ?? defaultProjectResources.cpus, memoryGiB: size?.memoryGiB ?? defaultProjectResources.memoryGiB, diskGiB: size?.diskGiB ?? defaultProjectResources.diskGiB,
  })),
  allowedHosts: projectSchema.shape.allowedHosts.default([]),
  secrets: projectSchema.shape.secrets.default([]),
  logins: projectSchema.shape.logins.default([]),
  preSetup: projectSchema.shape.preSetup.default(null),
  standingRules: rulesText.optional(),
});
const secondReviewSchema = z.union([
  z.strictObject({ always: z.literal(true) }),
  z.strictObject({ always: z.literal(false), lines: z.int().positive().nullable(), reserved: z.boolean() }).refine((rule) => rule.lines !== null || rule.reserved, "a second reviewer's rule names a size of change, reserved paths, or always"),
]);
/** Only an edit sets `autoReview`, and the API records its caller in it, so a project's add cannot name someone else. */
export const projectEditSchema = projectSchema.omit({ id: true, repoUrl: true, preSetup: true })
  .extend({
    resources: resourcesSchema.partial(), autoReview: z.union([z.strictObject({ mode: z.enum(["review", "land", "yolo"]) }), z.strictObject({ land: z.boolean() })]).nullable(), pipeline: z.strictObject({ autoStart: z.boolean() }).nullable(),
    standingRules: rulesText.nullable(), secondReview: secondReviewSchema.nullable(),
  }).partial();

/** A pipeline item: what its queued thread starts with, after the items whose threads must merge first. */
export const itemSchema = briefSchema(startFields.omit({ after: true, requestId: true, planning: true }).extend({ after: z.array(z.string().min(1)).max(32).optional() }), itemRules);
