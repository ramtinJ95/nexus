/** It imports only route.ts at run time, so a browser can bundle it. */
import type { z } from "zod";
import type { Project, SecondReview } from "../control/project.ts";
import type { PipelineItem } from "../control/pipeline.ts";
import type { itemSchema, projectAddSchema, projectEditSchema } from "./projects-parse.ts";
import { queryOf, route, type QueryCodec } from "./route.ts";

export type { LoginKind, Project, SecondReview } from "../control/project.ts";
export type { PipelineItem } from "../control/pipeline.ts";

/**
 * What `--second-reviewer on` sets. On 2026-11-04 a second model found a serious bug in three pull requests Nexus's
 * reviewer had passed or was reading, of 158, 220 and 249 changed lines, and only one of them had a reserved path hold.
 */
export const defaultSecondReview: SecondReview = { always: false, lines: 150, reserved: true };

/** `cancelled: false` leaves out the items whose phase is cancelled. */
export interface ItemsQuery { project?: string | undefined; cancelled?: false }
const itemsQuery: QueryCodec<ItemsQuery> = {
  encode: ({ project, cancelled }) => queryOf([["project", project], ["cancelled", cancelled === false ? "false" : undefined]]),
  decode: (params) => ({ ...params.has("project") ? { project: params.get("project")! } : {}, ...params.get("cancelled") === "false" ? { cancelled: false } : {} }),
};

export const projectRoutes = {
  list: route<Project[]>()("GET", "/v1/projects"),
  add: route<Project, z.input<typeof projectAddSchema>>()("POST", "/v1/projects"),
  edit: route<Project, z.input<typeof projectEditSchema>>()("PATCH", "/v1/projects/{project}"),
} as const;

export const itemRoutes = {
  list: route<PipelineItem[]>()("GET", "/v1/items", itemsQuery),
  add: route<PipelineItem, z.input<typeof itemSchema>>()("POST", "/v1/items"),
  show: route<PipelineItem>()("GET", "/v1/items/{item}"),
  cancel: route<PipelineItem>()("POST", "/v1/items/{item}/cancel"),
  approve: route<PipelineItem>()("POST", "/v1/items/{item}/approve"),
} as const;
