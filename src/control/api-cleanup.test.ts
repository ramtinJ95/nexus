/** The cleanup question on the node's page and in Needs you, its answer, and the deployer's releases route. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupPass, type CleanupPass } from "./cleanup.ts";
import { cleanupQuestion } from "./cleanup-model.ts";
import { observeNode } from "../test-support/registry-kit.ts";
import { testImage } from "../test-support/kit.ts";
import { deployment, laptop, node, reporterHeaders, testApi } from "../test-support/api-kit.ts";
import type { DeleteOutcome } from "../protocol/cleanup.ts";
import type { ImageId, NodeName, PortableArtifactId, TailnetNodeId } from "../ids.ts";

const [older, current] = ["img-000000000001", "img-000000000003"] as [ImageId, ImageId];
const [r1, r2] = ["1".repeat(40), "2".repeat(40)];
const inventory = {
  releases: [{ name: r1, commit: r1, bytes: 300 * 1024 ** 2, installedAt: 1 }, { name: r2, commit: r2, bytes: 300 * 1024 ** 2, installedAt: 2 }, { name: "3".repeat(40), commit: null, bytes: 1, installedAt: 3 }],
  links: { current: "3".repeat(40), "control-current": "3".repeat(40), "deployer-current": null },
  replaced: { probe: r2, control: r2 },
  running: {},
};
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const cleanupLine = (page: string) => /<p class="cleanup-line[^"]*">[\s\S]*?<\/p>/.exec(page)?.[0] ?? "";
const needsCount = (page: string) => /<span class="side-count" id="needs-count" data-live>([^<]*)<\/span>/.exec(page)![1];

test("the node's cleanup is a card on its page and in Needs you, and Delete deletes through its probe and its deployer", async (t) => {
  let pass: CleanupPass | undefined;
  const cleanup: CleanupPass = { poll: () => pass!.poll(), close: () => pass!.close(), releases: (...args) => pass!.releases(...args) };
  const s = await testApi(t, { deployment, cleanup });
  const dropped: PortableArtifactId[][] = [];
  pass = cleanupPass({
    registry: s.registry, log: () => {},
    probes: new Map([[node, {
      artifactUsage: async () => ({ artifacts: [{ id: older, bytes: 2 * 1024 ** 3 }, { id: current, bytes: 2 * 1024 ** 3 }] }),
      dropArtifacts: async (ids: readonly PortableArtifactId[]) => {
        dropped.push([...ids]);
        return { outcomes: Object.fromEntries(ids.map((id): [string, DeleteOutcome] => [id, { state: "deleted", bytes: 2 * 1024 ** 3 }])) };
      },
    }]]),
  });
  for (const id of [older, "img-000000000002", current] as ImageId[]) { s.registry.saveImage(testImage({ id }), null); s.registry.setCurrentImage(id); }
  observeNode(s.registry, { node, artifacts: [older, current] });
  s.callAs("nFIREBAT" as TailnetNodeId);
  const html = async (path: string) => (await s.raw(path)).body.toString();
  const report = (body: unknown) => s.call("POST", "/v1/deployer/releases", body, reporterHeaders);
  assert.deepEqual((await report({ inventory })).body, { delete: [] });
  assert.equal((await report({ inventory: { ...inventory, links: { ...inventory.links, current: "../x" } } })).status, 400);
  s.callAs(laptop);
  await pass.poll();

  const [q] = s.registry.questions.openNodeQuestions();
  assert.ok(q !== undefined);
  const page = (await html(`/nodes/${node}`));
  const card = page.split('id="node-cleanup"')[1]!.split('id="node-health"')[0]!;
  assert.match(textOf(card), new RegExp(`Delete what ${node} no longer needs\\? frees 2\\.3 GiB What Space image ${older} 2\\.0 GiB release ${r1} 300\\.0 MiB Total 2\\.3 GiB`));
  assert.match(card, new RegExp(`<button type="button" class="btn" data-action="answer" data-question="${q.id}" data-option="Delete" data-confirm="Delete these 2 items from ${node}\\? It cannot be undone\\.">Delete</button>`));
  assert.match(card, new RegExp(`data-question="${q.id}" data-option="Keep">Keep</button>`));
  const home = (await html("/"));
  assert.equal(needsCount(home), "1", "the sidebar counts it");
  const need = /<article class="need need-cleanup"[\s\S]*?<\/article>/.exec(home)?.[0] ?? "";
  assert.match(need, new RegExp(`<a class="need-thread" href="/nodes/${node}">`), "the card links its node");
  assert.match(need, new RegExp(`data-question="${q.id}" data-option="Delete"`));

  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("POST", `/v1/questions/${q.id}/answer`, { option: "Delete" })).status, 403, "a node may not answer");
  s.callAs(laptop);
  const answered = await s.call("POST", `/v1/questions/${q.id}/answer`, { option: "Delete" });
  assert.equal(answered.status, 200);
  await pass.poll();
  assert.deepEqual(dropped, [[older]]);
  const pending = (await html(`/nodes/${node}`));
  assert.equal(textOf(cleanupLine(pending)), `Last cleanup: 2.0 GiB freed on ${node} just now (1 item still to go)`, "the release the deployer has not deleted yet");
  assert.doesNotMatch(pending, /waits to be deleted/, "and the section does not say nothing waits");
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.deepEqual((await report({ inventory })).body, { delete: [r1] });
  assert.deepEqual((await report({ inventory: { ...inventory, releases: inventory.releases.slice(1) }, outcomes: { [r1]: { state: "deleted", bytes: 300 * 1024 ** 2 } } })).body, { delete: [] });
  s.callAs(laptop);

  const after = (await html(`/nodes/${node}`));
  const section = after.split('id="node-cleanup"')[1]!.split('id="node-health"')[0]!;
  assert.match(textOf(section), /^data-live> Cleanup No cleanup question waits on you\. <div/, "the answered question is no card on the node's section");
  assert.doesNotMatch(after, /cleanup-items/, "nor a table anywhere on the page");
  assert.equal(textOf(cleanupLine(after)), `Last cleanup: 2.3 GiB freed on ${node} just now`);
  assert.equal(needsCount((await html("/"))), "", "an answered cleanup waits on no one");
});

test("the Cluster page says in one line what each node's latest cleanup freed and when, and what it could not delete", async (t) => {
  const s = await testApi(t, { deployment });
  const testbench = "infra-testbench" as NodeName;
  observeNode(s.registry, { node });
  s.registry.upsertNode({ name: testbench, tailnetHost: `${testbench}.tail.ts.net`, tailnetNodeId: "nINFRA" as TailnetNodeId });
  observeNode(s.registry, { node: testbench });
  const hour = 3_600_000;
  const now = Date.now();
  const deleted = (bytes: number): DeleteOutcome => ({ state: "deleted", bytes });
  const ask = (on: NodeName, askedAt: number, items: Parameters<typeof cleanupQuestion>[1]) => s.registry.questions.askQuestion(cleanupQuestion(on, items, askedAt));
  const answer = (id: string, option: "Delete" | "Keep", at: number, outcomes: Record<string, DeleteOutcome> = {}) => {
    s.registry.questions.answerQuestion(s.registry.questions.question(id)!, { option, by: laptop, at });
    if (Object.keys(outcomes).length > 0) s.registry.questions.recordCleanup(id, outcomes);
  };
  const old = ask(testbench, now - 50 * hour, [{ kind: "image", id: older, bytes: 9 * 1024 ** 3 }]);
  answer(old.id, "Delete", now - 49 * hour, { [older]: deleted(9 * 1024 ** 3) });
  const latest = ask(testbench, now - 14 * hour, [{ kind: "image", id: current, bytes: 2 * 1024 ** 3 }, { kind: "release", name: r1, commit: r1, bytes: 300 * 1024 ** 2 }, { kind: "release", name: r2, commit: r2, bytes: 1 }]);
  answer(latest.id, "Delete", now - 13 * hour, { [current]: deleted(1.5 * 1024 ** 3), [`release-${r1}`]: { state: "skipped", reason: "a controller runs from it" } });
  const firebat = ask(node, now - 31 * hour, [{ kind: "image", id: older, bytes: 1.2 * 1024 ** 3 }]);
  answer(firebat.id, "Delete", now - 30 * hour, { [older]: deleted(1.2 * 1024 ** 3) });
  answer(ask(node, now - 3 * hour, [{ kind: "image", id: current, bytes: 1 }]).id, "Keep", now - 2 * hour);
  const open = ask(node, now - hour, [{ kind: "image", id: "img-000000000002" as ImageId, bytes: 1024 ** 3 }]);

  const page = (await s.raw(`/nodes/${node}`)).body.toString();
  assert.equal(textOf(cleanupLine(page)), `Last cleanup: 1.5 GiB freed on ${testbench} 13 h ago (1 item could not be deleted, 1 item still to go) and 1.2 GiB on ${node} 30 h ago`,
    "the newest Delete per node, not an older one nor a Keep, with what it left");
  assert.ok(page.indexOf(cleanupLine(page)) < page.indexOf('class="node-cards"'), "the line sits with the Nodes heading");
  const section = page.split('id="node-cleanup"')[1]!.split('id="node-health"')[0]!;
  assert.match(section, new RegExp(`data-question="${open.id}" data-option="Delete"`), "the open question is still its card");
  assert.equal([...section.matchAll(/class="landing question cleanup/g)].length, 1, "and no answered question has one");
  assert.doesNotMatch(page, /Outcome|deleted, freed/);
});
