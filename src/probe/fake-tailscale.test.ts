import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fakeTailscale } from "./fake-tailscale.ts";

// What tailscale 1.102.3 printed for `serve status --json` in S6 (spikes/S6.md), after the steps it ran.
const captured = async (name: string) => JSON.parse(await readFile(new URL(`../../spikes/evidence/logs/s6-status-${name}-json.txt`, import.meta.url), "utf8")) as unknown;
const gateway = "http://127.0.0.1:18090";
const ports = [8443, 10000, 10001, 10002, 18443, 40000];

test("the fake prints what the real tailscale printed for the commands S6 ran", async () => {
  const { cli } = fakeTailscale();
  const status = async () => JSON.parse(await cli(["serve", "status", "--json"])) as unknown;
  assert.deepEqual(await status(), await captured("before"));

  for (const port of ports) await cli(["serve", "--bg", `--https=${port}`, gateway]);
  assert.deepEqual(await status(), await captured("all-active"));

  await cli(["serve", "--https=10001", "off"]);
  assert.deepEqual(await status(), await captured("one-removed"));

  for (const port of ports.filter((p) => p !== 10001)) await cli(["serve", `--https=${port}`, "off"]);
  assert.deepEqual(await status(), await captured("final"));
});
