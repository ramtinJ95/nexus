import { test } from "node:test";
import assert from "node:assert/strict";
import { chatgptTokenHandoff } from "./chatgpt-token.ts";
import type { NodeName } from "../protocol.ts";

const token = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJoYXJuZXNzIn0.c2ln";

/** Probes that record each value put to them, and fail while their node is in `down`. */
function probes(...nodes: string[]) {
  const put: [string, string, string][] = [];
  const down = new Set<string>();
  return {
    put, down,
    clients: nodes.map((node) => ({
      node: node as NodeName,
      async putSecret(name: string, value: string) {
        if (down.has(node)) throw new Error(`${node}: connect ECONNREFUSED 100.64.0.2:7480`);
        put.push([node, name, value]);
      },
    })),
  };
}

test("every poll puts the current token to every probe, so a probe that missed one gets the next", async () => {
  const p = probes("rj-firebat", "infra-testbench");
  let current = token;
  const handoff = chatgptTokenHandoff({ probes: p.clients, token: async () => current, log: () => {} });
  await handoff.poll();
  current = `${token}-refreshed`;
  await handoff.poll();
  assert.deepEqual(p.put, [
    ["rj-firebat", "NEXUS_CHATGPT_TOKEN", token], ["infra-testbench", "NEXUS_CHATGPT_TOKEN", token],
    ["rj-firebat", "NEXUS_CHATGPT_TOKEN", `${token}-refreshed`], ["infra-testbench", "NEXUS_CHATGPT_TOKEN", `${token}-refreshed`],
  ]);
});

test("without a ChatGPT login the handoff puts nothing", async () => {
  const p = probes("rj-firebat");
  const logged: string[] = [];
  await chatgptTokenHandoff({ probes: p.clients, token: async () => undefined, log: (line) => logged.push(line) }).poll();
  assert.deepEqual(p.put, []);
  assert.deepEqual(logged, []);
});

test("a probe that fails is logged by node and the others still get the token, and no log line carries it", async () => {
  const p = probes("rj-firebat", "infra-testbench");
  p.down.add("rj-firebat");
  const logged: string[] = [];
  const handoff = chatgptTokenHandoff({ probes: p.clients, token: async () => token, log: (line) => logged.push(line) });
  await handoff.poll();
  assert.deepEqual(p.put, [["infra-testbench", "NEXUS_CHATGPT_TOKEN", token]]);
  assert.deepEqual(logged, ["handing NEXUS_CHATGPT_TOKEN to rj-firebat failed: rj-firebat: connect ECONNREFUSED 100.64.0.2:7480"]);

  await chatgptTokenHandoff({ probes: p.clients, token: () => Promise.reject(new Error("OAuth refresh failed for openai")), log: (line) => logged.push(line) }).poll();
  assert.equal(logged.at(-1), "the harness's ChatGPT token could not be read: OAuth refresh failed for openai");
  assert.ok(logged.every((line) => !line.includes(token)));
});

test("a poll while one runs joins it instead of reading the token twice", async () => {
  const p = probes("rj-firebat");
  let reads = 0;
  const gate = Promise.withResolvers<void>();
  const handoff = chatgptTokenHandoff({ probes: p.clients, token: async () => { reads++; await gate.promise; return token; }, log: () => {} });
  const first = handoff.poll();
  const second = handoff.poll();
  gate.resolve();
  await Promise.all([first, second, handoff.close()]);
  assert.equal(reads, 1);
  assert.deepEqual(p.put, [["rj-firebat", "NEXUS_CHATGPT_TOKEN", token]]);
});

test("a probe that takes the token and has not got it, as one that just started, gets it at once", async () => {
  const p = probes("rj-firebat", "infra-testbench");
  const handoff = chatgptTokenHandoff({ probes: p.clients, token: async () => token, log: () => {} });
  const seen = (node: string, holds: readonly string[], takes?: readonly string[]) =>
    ({ node: node as NodeName, grants: { secrets: holds, gitSsh: false }, ...takes === undefined ? {} : { heldSecrets: takes } });
  handoff.observed(seen("rj-firebat", ["GH_TOKEN", "NEXUS_CHATGPT_TOKEN"], ["NEXUS_CHATGPT_TOKEN"]));
  handoff.observed(seen("rj-firebat", [], []));
  handoff.observed(seen("rj-firebat", []));
  await handoff.close();
  assert.deepEqual(p.put, [], "a probe that has it, or takes none, sets nothing off");

  handoff.observed(seen("infra-testbench", ["GH_TOKEN"], ["NEXUS_CHATGPT_TOKEN"]));
  await handoff.close();
  assert.deepEqual(p.put, [["rj-firebat", "NEXUS_CHATGPT_TOKEN", token], ["infra-testbench", "NEXUS_CHATGPT_TOKEN", token]]);
});

test("a probe that shows up without the token while a poll runs gets it from one more poll", async () => {
  const p = probes("rj-firebat", "infra-testbench");
  p.down.add("rj-firebat");
  const slow = Promise.withResolvers<void>();
  const clients = p.clients.map((c) => c.node === "infra-testbench" ? { ...c, putSecret: async (name: string, value: string) => { await slow.promise; return c.putSecret(name, value); } } : c);
  const handoff = chatgptTokenHandoff({ probes: clients, token: async () => token, log: () => {} });
  const first = handoff.poll();
  await new Promise((r) => setTimeout(r, 10));
  p.down.delete("rj-firebat");
  handoff.observed({ grants: { secrets: [], gitSsh: false }, heldSecrets: ["NEXUS_CHATGPT_TOKEN"] });
  slow.resolve();
  await first;
  await handoff.close();
  assert.ok(p.put.some(([node]) => node === "rj-firebat"), "the restarted probe got the token without waiting for the timer");
});
