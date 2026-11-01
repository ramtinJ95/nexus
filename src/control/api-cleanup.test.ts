/** The cleanup question on the node's page and in Needs you, its answer, and the deployer's releases route. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupPass, type CleanupPass } from "./cleanup.ts";
import { observeNode } from "./test-kit.ts";
import { testImage } from "../test-kit.ts";
import { deployment, laptop, node, reporterHeaders, testApi } from "./api-test-kit.ts";
import type { DeleteOutcome } from "../protocol/cleanup.ts";
import type { ImageId, PortableArtifactId, TailnetNodeId } from "../ids.ts";

const [older, current] = ["img-000000000001", "img-000000000003"] as [ImageId, ImageId];
const [r1, r2] = ["1".repeat(40), "2".repeat(40)];
const inventory = {
  releases: [{ name: r1, commit: r1, bytes: 300 * 1024 ** 2, installedAt: 1 }, { name: r2, commit: r2, bytes: 300 * 1024 ** 2, installedAt: 2 }, { name: "3".repeat(40), commit: null, bytes: 1, installedAt: 3 }],
  links: { current: "3".repeat(40), "control-current": "3".repeat(40), "deployer-current": null },
  replaced: { probe: r2, control: r2 },
  running: {},
};
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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

  const [q] = s.registry.openNodeQuestions();
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
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.deepEqual((await report({ inventory })).body, { delete: [r1] });
  assert.deepEqual((await report({ inventory: { ...inventory, releases: inventory.releases.slice(1) }, outcomes: { [r1]: { state: "deleted", bytes: 300 * 1024 ** 2 } } })).body, { delete: [] });
  s.callAs(laptop);

  const after = (await html(`/nodes/${node}`));
  const done = textOf(after.split('id="node-cleanup"')[1]!.split('id="node-health"')[0]!);
  assert.match(done, new RegExp(`Cleanup on ${node} answered "Delete" from ${laptop}`));
  assert.match(done, new RegExp(`image ${older} 2\\.0 GiB deleted, freed 2\\.0 GiB release ${r1} 300\\.0 MiB deleted, freed 300\\.0 MiB`));
  assert.match(done, /Freed 2\.3 GiB\./);
  assert.equal(needsCount((await html("/"))), "", "an answered cleanup waits on no one");
});
