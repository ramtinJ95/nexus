import { test } from "node:test";
import assert from "node:assert/strict";
import { linkTarget, serviceState, unlinkRefusal, type PreviewService } from "./preview-links.ts";

const config = "/workspace/repo/.nexus/services.yaml";
const services: PreviewService[] = [
  { name: "web", port: 3000, previewed: true, declared: true },
  { name: "worker", port: 3001, previewed: false, declared: true },
  { name: "scratch", port: 3002, previewed: true, declared: false },
  { name: "port-3100", port: 3003, previewed: true, declared: true },
];

test("a link is refused for a reserved port, an owner with no preview and a linked name a service holds, previews an owner's port under its name, and links any other port", () => {
  const cases: [number, ReturnType<typeof linkTarget>][] = [
    [22, { refused: "Port 22 is Nexus's own, so it cannot be previewed" }],
    [700, { refused: "Port 700 is Nexus's own, so it cannot be previewed" }],
    [3000, { service: "web" }],
    [3001, { refused: `Port 3001 belongs to service worker, which has no preview. Declare one in ${config}` }],
    [3002, { service: "scratch" }],
    [3100, { refused: "Service port-3100 runs on another port, so port 3100 cannot be previewed under that name. Rename the service" }],
    [4000, "link"],
  ];
  for (const [port, expected] of cases) assert.deepEqual(linkTarget(port, services, config), expected, `port ${port}`);
});

test("an unlink of a port that is not linked is refused for a service's preview and a linked name a service holds, and is no refusal otherwise", () => {
  const cases: [number, string | null][] = [
    [3000, `Port 3000 is the preview of service web, not a linked port. Remove the preview from ${config} to unpublish it`],
    [3002, "Port 3002 is the preview of service scratch, not a linked port. An ad hoc service keeps its preview"],
    [3100, "Service port-3100 is not a linked port, so port 3100 has no linked preview to unpublish. Rename the service"],
    [3001, null],
    [4000, null],
  ];
  for (const [port, expected] of cases) assert.equal(unlinkRefusal(port, services, config), expected, `port ${port}`);
});

test("a service is ready while it runs healthy, then failed once a failure is recorded, so also while it still runs, then starting while it runs or a watch holds it after it exits, and otherwise stopped", () => {
  // running, healthy, failed, watched
  const table: [boolean, boolean, boolean, boolean, ReturnType<typeof serviceState>][] = [
    [false, false, false, false, "stopped"],
    [false, false, false, true, "starting"],
    [false, false, true, false, "failed"],
    [false, false, true, true, "failed"],
    [false, true, false, false, "stopped"],
    [false, true, false, true, "starting"],
    [false, true, true, false, "failed"],
    [false, true, true, true, "failed"],
    [true, false, false, false, "starting"],
    [true, false, false, true, "starting"],
    [true, false, true, false, "failed"],
    [true, false, true, true, "failed"],
    [true, true, false, false, "ready"],
    [true, true, false, true, "ready"],
    [true, true, true, false, "ready"],
    [true, true, true, true, "ready"],
  ];
  for (const [running, healthy, failed, watched, expected] of table)
    assert.equal(serviceState({ running, healthy, failed, watched }), expected, JSON.stringify({ running, healthy, failed, watched }));
});
