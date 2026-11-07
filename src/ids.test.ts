import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkpointId, isArtifactId, isCheckpointId, isItemId, isNodeName, isPipelineRequestId, isPortableArtifactId, isPylonId,
  itemIdFrom, newItemId, newThreadId, pylonIdOf, requestIds, shutdownCheckpointId, threadOfPylon, type ItemId, type ThreadId,
} from "./ids.ts";
import { nodeNameSchema, pylonIdSchema } from "./protocol/fields.ts";

/** The checks each ID had before src/ids.ts owned it, copied from where they were written. */
const old = {
  item: (id: string) => /^it-[0-9a-f]{12}$/.test(id),
  pipelineRequest: (id: string) => id.startsWith("pipeline:"),
  checkpoint: (id: string) => id.startsWith("ckpt-"),
  artifact: (id: string) => isPortableArtifactId(id) || id.startsWith("ckpt-"),
  nodeName: (name: string) => nodeNameSchema.safeParse(name).success,
  pylon: (id: string) => pylonIdSchema.safeParse(id).success,
};

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(new URL(dir, import.meta.url), { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

const sources = [
  ...await filesUnder("./golden/"), ...await filesUnder("./test-support/"), ...await filesUnder("./fixtures/"),
  new URL("./control/dashboard/demo-fixtures.ts", import.meta.url), new URL("./control/harness/test-fixture.ts", import.meta.url),
];
const text = (await Promise.all(sources.map((f) => readFile(f, "utf8")))).join("\n");
const found = (pattern: RegExp) => [...new Set([...text.matchAll(pattern)].map((m) => m[1]!))];
/** Each ID as written, and near misses of it, so a parser that accepts too much or too little shows. */
const withNearMisses = (ids: string[]) => ids.flatMap((id) => [id, `${id}x`, id.slice(0, -1), id.toUpperCase(), ` ${id}`, `${id}.`]);

const corpus = {
  item: withNearMisses(found(/\b(it-[A-Za-z0-9-]*)/g)),
  request: withNearMisses(found(/\b((?:pipeline|brief|queued|nudge|resume|msg):[^\s"'`),]*)/g)),
  artifact: withNearMisses(found(/\b((?:ckpt|img|tpl)-[A-Za-z0-9-]*)/g)),
  nodeName: withNearMisses([...found(/"([^"\n]{1,80})" as NodeName/g), ...found(/"node":\s*"([^"\n]{1,80})"/g), "auto"]),
  pylon: withNearMisses(found(/\b(pylon-[A-Za-z0-9-]*)/g)),
};

test("the corpus holds the IDs the fixtures and goldens use", () => {
  for (const [kind, ids] of Object.entries(corpus)) assert.ok(ids.length >= 30, `${kind} has ${ids.length} IDs`);
});

test("every ID in the fixtures and goldens gets the verdict the old checks gave it", () => {
  const differ = (kind: string, ids: string[], before: (id: string) => boolean, after: (id: string) => boolean) =>
    ids.filter((id) => before(id) !== after(id)).map((id) => `${kind} ${JSON.stringify(id)}`);
  assert.deepEqual([
    ...differ("item", corpus.item, old.item, isItemId),
    ...differ("pipeline request", corpus.request, old.pipelineRequest, isPipelineRequestId),
    ...differ("checkpoint", corpus.artifact, old.checkpoint, isCheckpointId),
    ...differ("artifact", corpus.artifact, old.artifact, isArtifactId),
    ...differ("node name", corpus.nodeName, old.nodeName, isNodeName),
    ...differ("pylon", corpus.pylon, old.pylon, isPylonId),
  ], []);
});

test("minted IDs are the strings their callers used to build", () => {
  const thread = "th-0123456789ab" as ThreadId;
  const item = "it-0123456789ab" as ItemId;
  assert.match(newThreadId(), /^th-[0-9a-f]{12}$/);
  assert.ok(old.item(newItemId()));
  assert.equal(pylonIdOf(thread), `pylon-${thread}`);
  assert.ok(old.pylon(pylonIdOf(thread)));
  assert.equal(threadOfPylon(pylonIdOf(thread)), thread);
  assert.equal(itemIdFrom("plan:th-1:abc:01"), `it-${createHash("sha256").update("plan:th-1:abc:01").digest("hex").slice(0, 12)}`);
  assert.equal(checkpointId(thread, 3), `ckpt-${thread}-3`);
  assert.equal(shutdownCheckpointId(pylonIdOf(thread), 1700), `ckpt-${pylonIdOf(thread).replace(/^pylon-/, "")}-shutdown-1700`);
  assert.deepEqual(
    [requestIds.pipeline(item), requestIds.brief(thread), requestIds.queued(thread), requestIds.nudge(thread, 7), requestIds.resume(thread, 7)],
    [`pipeline:${item}`, `brief:${thread}`, `queued:${thread}`, `nudge:${thread}:7`, `resume:${thread}:7`],
  );
});
