import { test } from "node:test";
import assert from "node:assert/strict";
import { callOf, type ApiRoute } from "./route.ts";
import { matchedParams, pathPattern } from "../util/route-path.ts";
import { imageRoutes, releaseRoutes } from "./release.ts";
import { doctorRoutes, nodeRoutes, usageRoutes } from "./reports.ts";
import { itemRoutes, projectRoutes } from "./projects.ts";
import { questionRoutes, reviewRoutes } from "./reviews.ts";

/** Each route's method and RegExp as the route modules declared them before the contract. */
const before: readonly (readonly [string, RegExp, ApiRoute, readonly string[]])[] = [
  ["GET", /^\/v1\/release$/, releaseRoutes.release, []],
  ["PUT", /^\/v1\/release$/, releaseRoutes.deploy, []],
  ["GET", /^\/v1\/deployer\/release$/, releaseRoutes.deployerRelease, []],
  ["POST", /^\/v1\/deployer\/report$/, releaseRoutes.report, []],
  ["POST", /^\/v1\/deployer\/releases$/, releaseRoutes.releases, []],
  ["POST", /^\/v1\/deployer\/drain$/, releaseRoutes.drain, []],
  ["GET", /^\/v1\/images$/, imageRoutes.list, []],
  ["POST", /^\/v1\/images$/, imageRoutes.record, []],
  ["GET", /^\/v1\/images\/current$/, imageRoutes.current, []],
  ["POST", /^\/v1\/images\/build$/, imageRoutes.build, []],
  ["POST", /^\/v1\/images\/rollout$/, imageRoutes.rollout, []],
  ["POST", /^\/v1\/images\/rollback$/, imageRoutes.rollback, []],
  ["GET", /^\/v1\/nodes$/, nodeRoutes.list, []],
  ["GET", /^\/v1\/nodes\/([^/]+)\/health$/, nodeRoutes.health, ["node"]],
  ["GET", /^\/v1\/nodes\/([^/]+)\/metrics$/, nodeRoutes.metrics, ["node"]],
  ["GET", /^\/v1\/usage$/, usageRoutes.report, []],
  ["GET", /^\/v1\/usage\/backfill$/, usageRoutes.backfill, []],
  ["POST", /^\/v1\/usage\/backfill$/, usageRoutes.startBackfill, []],
  ["DELETE", /^\/v1\/usage\/backfill$/, usageRoutes.stopBackfill, []],
  ["GET", /^\/v1\/doctor$/, doctorRoutes.doctor, []],
  ["GET", /^\/v1\/checks$/, doctorRoutes.checks, []],
  ["GET", /^\/v1\/checks\/changes$/, doctorRoutes.changes, []],
  ["POST", /^\/v1\/checks\/seen$/, doctorRoutes.seen, []],
  ["PATCH", /^\/v1\/projects\/([^/]+)$/, projectRoutes.edit, ["project"]],
  ["GET", /^\/v1\/projects$/, projectRoutes.list, []],
  ["POST", /^\/v1\/projects$/, projectRoutes.add, []],
  ["GET", /^\/v1\/items$/, itemRoutes.list, []],
  ["POST", /^\/v1\/items$/, itemRoutes.add, []],
  ["GET", /^\/v1\/items\/([^/]+)$/, itemRoutes.show, ["item"]],
  ["POST", /^\/v1\/items\/([^/]+)\/cancel$/, itemRoutes.cancel, ["item"]],
  ["POST", /^\/v1\/items\/([^/]+)\/approve$/, itemRoutes.approve, ["item"]],
  ["POST", /^\/v1\/threads\/([^/]+)\/review$/, reviewRoutes.start, ["thread"]],
  ["POST", /^\/v1\/threads\/([^/]+)\/review\/cancel$/, reviewRoutes.cancel, ["thread"]],
  ["POST", /^\/v1\/threads\/([^/]+)\/land$/, reviewRoutes.land, ["thread"]],
  ["POST", /^\/v1\/questions\/([^/]+)\/answer$/, questionRoutes.answer, ["question"]],
];

const families = [releaseRoutes, imageRoutes, nodeRoutes, usageRoutes, doctorRoutes, projectRoutes, itemRoutes, reviewRoutes, questionRoutes];
const roots = ["release", "deployer/release", "deployer/report", "deployer/releases", "deployer/drain", "deployer", "images", "images/current", "images/build", "images/rollout",
  "images/rollback", "images/x/build", "nodes", "usage", "usage/backfill", "usage/backfill/x", "doctor", "checks", "checks/changes", "checks/seen", "projects", "items"];
const segments = ["n-1", "a%2Fb", "", "x:y"];
const tails = ["", "/health", "/metrics", "/metrics/x", "/cancel", "/approve", "/review", "/review/cancel", "/land", "/answer", "/answer/x"];
const corpus = [...roots.flatMap((root) => [`/v1/${root}`, `/v1/${root}/`, `/v2/${root}`]),
  ...["nodes", "projects", "items", "threads", "questions"].flatMap((root) => segments.flatMap((id) => tails.map((tail) => `/v1/${root}/${id}${tail}`)))];

test("each route's path template matches the paths its old RegExp did, with the same parameters captured", () => {
  assert.equal(new Set(before.map(([, , route]) => route)).size, families.reduce((n, family) => n + Object.keys(family).length, 0));
  for (const [method, old, route, names] of before) {
    assert.equal(route.method, method, route.path);
    for (const path of corpus) {
      const was = old.exec(path);
      const now = pathPattern(route.path).exec(path);
      assert.equal(now === null, was === null, `${route.path} ${path}`);
      if (was === null || now === null) continue;
      assert.deepEqual(matchedParams(route.path, now), Object.fromEntries(names.map((name, i) => [name, was[i + 1]])), `${route.path} ${path}`);
    }
  }
});

test("each query is the one the CLI and the dashboard built by hand", () => {
  assert.equal(callOf(usageRoutes.report, { query: { since: "7d" } }).path, "/v1/usage?since=7d");
  assert.equal(callOf(usageRoutes.report, { query: { since: "2026-10-01", project: "nexus", by: "model,day" } }).path, `/v1/usage?${new URLSearchParams({ since: "2026-10-01", project: "nexus", by: "model,day" })}`);
  assert.equal(callOf(nodeRoutes.metrics, { node: "rj-firebat", query: { from: 1000, to: 2000 } }).path, "/v1/nodes/rj-firebat/metrics?from=1000&to=2000");
  assert.equal(callOf(itemRoutes.list, { query: {} }).path, "/v1/items");
  assert.equal(callOf(itemRoutes.list, { query: { project: "nexus" } }).path, "/v1/items?project=nexus");
  assert.deepEqual(itemRoutes.list.query!.decode(new URLSearchParams("project=nexus")), { project: "nexus" });
  assert.deepEqual(itemRoutes.list.query!.decode(new URLSearchParams("")), {});
  assert.equal(callOf(questionRoutes.answer, { question: "q/1", body: { option: "Land" } }).path, "/v1/questions/q%2F1/answer");
});
