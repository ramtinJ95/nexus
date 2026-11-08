/**
 * The routes of projects and pipeline items: adding, listing and editing projects, and the items a person adds,
 * approves and cancels. The server registers its handlers against them, and the CLI and dashboard call them. It
 * imports nothing at run time, so a browser can bundle it. projects-parse.ts holds the request schemas.
 */
import type { z } from "zod";
import type { Project } from "../control/project.ts";
import type { PipelineItem } from "../control/pipeline.ts";
import type { itemSchema, projectAddSchema, projectEditSchema } from "./projects-parse.ts";
import { queryOf, route, type QueryCodec } from "./route.ts";

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
