/**
 * The routes of what the control plane reports: the nodes, a node's health and metrics, the usage report and its
 * backfill, and the doctor's checks. The server registers its handlers against them, and the CLI and dashboard call
 * them. It imports nothing at run time, so a browser can bundle it. reports-parse.ts holds the request schemas.
 */
import type { z } from "zod";
import type { NodeHealth } from "../protocol/client.ts";
import type { NodeSummary } from "../control/wire.ts";
import type { NodeMetrics } from "../control/node-metrics.ts";
import type { BackfillPlanRow, UsageBackfill, UsageReport } from "../control/usage.ts";
import type { DoctorReport, HealthChange, HealthView } from "../control/doctor-model.ts";
import type { checksSeenSchema } from "./reports-parse.ts";
import { queryOf, route, type QueryCodec } from "./route.ts";

/** Milliseconds since the epoch. `to` is now by default. */
export interface MetricsQuery { from: number; to?: number | undefined }
const metricsQuery: QueryCodec<MetricsQuery, URLSearchParams> = {
  encode: ({ from, to }) => queryOf([["from", String(from)], ["to", to === undefined ? undefined : String(to)]]),
  decode: (params) => params,
};

/** `since` is today, 7d, 30d, all or a date such as 2026-10-01, and `by` the breakdowns, comma-separated. */
export interface UsageQuery { since?: string | undefined; project?: string | undefined; thread?: string | undefined; by?: string | undefined }
const usageQuery: QueryCodec<UsageQuery, URLSearchParams> = {
  encode: ({ since, project, thread, by }) => queryOf([["since", since], ["project", project], ["thread", thread], ["by", by]]),
  decode: (params) => params,
};

/** The backfill's state, and the archived threads a start would read. */
export interface BackfillView { backfill: UsageBackfill; plan: BackfillPlanRow[] }

export const nodeRoutes = {
  list: route<NodeSummary[]>()("GET", "/v1/nodes"),
  health: route<NodeHealth>()("GET", "/v1/nodes/{node}/health"),
  metrics: route<NodeMetrics>()("GET", "/v1/nodes/{node}/metrics", metricsQuery),
} as const;

export const usageRoutes = {
  report: route<UsageReport>()("GET", "/v1/usage", usageQuery),
  backfill: route<BackfillView>()("GET", "/v1/usage/backfill"),
  startBackfill: route<UsageBackfill>()("POST", "/v1/usage/backfill"),
  stopBackfill: route<UsageBackfill>()("DELETE", "/v1/usage/backfill"),
} as const;

export const doctorRoutes = {
  doctor: route<DoctorReport>()("GET", "/v1/doctor"),
  checks: route<HealthView>()("GET", "/v1/checks"),
  changes: route<HealthChange[]>()("GET", "/v1/checks/changes"),
  seen: route<null, z.input<typeof checksSeenSchema>>()("POST", "/v1/checks/seen"),
} as const;
