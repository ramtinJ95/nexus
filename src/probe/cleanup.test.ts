/** The probe's cleanup route: the space each artifact takes, and deleting those the person agreed to. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startProbe } from "./server.ts";
import { nodeSecrets } from "./config.ts";
import { artifactDirectory, fileCodec } from "../artifacts.ts";
import { connectProbe } from "../protocol/client.ts";
import { JobFailure } from "../protocol/jobs.ts";
import { tempDir } from "../test-kit.ts";
import { diskBytes } from "../disk-space.ts";
import type { VmBackend } from "../backend.ts";
import type { ImageId, NodeName, PortableArtifactId, TailnetNodeId, TemplateId } from "../ids.ts";

const controlPlane = "nCONTROL" as TailnetNodeId;
const image: ImageId = "img-000000000001";
const used: ImageId = "img-000000000002";
const template: TemplateId = "tpl-000000000001";

test("the probe sizes each artifact in its directory, deletes those it is sent unless the backend finds one in use, and a second delete finds them gone", async (t) => {
  const root = await tempDir("nexus-probe-cleanup-", t);
  const store = artifactDirectory(root, fileCodec("disk"));
  for (const [id, manifest] of [[image, "image.json"], [used, "image.json"], [template, "template.json"]] as const) {
    await mkdir(join(root, id));
    await writeFile(join(root, id, manifest), "{}");
    await writeFile(join(root, id, "disk"), "x".repeat(64 * 1024));
  }
  const fail = (): never => { throw new Error("no pylon here"); };
  let slow = Promise.resolve();
  const backend: VmBackend = {
    ensureRunning: fail, ensurePaused: fail, ensureDeleted: fail, buildTemplate: fail, buildImage: fail, guest: fail,
    list: async () => [], state: async () => "absent", updateSecret: async () => [],
    artifacts: {
      list: () => store.list(), has: fail, manifest: async () => null, export: fail, import: fail,
      bytes: async (id) => existsSync(store.path(id)) ? diskBytes(store.path(id)) : null,
      drop: async (id) => {
        if (id === used) throw new JobFailure("invalid", `${id} is still needed by pylon pylon-th-1`);
        // As the store's drop does, the artifact is set aside first, so a listing no longer holds it while it goes.
        if (existsSync(store.path(id))) await rename(store.path(id), join(root, `.${id}.dropping`));
        await slow;
        await store.drop(id, []);
      },
    },
  };
  const probe = await startProbe({
    node: "test-node" as NodeName, host: "127.0.0.1", port: 0, auth: { controlPlane, peers: [] }, whois: async () => controlPlane,
    backend, secrets: nodeSecrets({ value: () => undefined, names: () => [] }),
  });
  t.after(() => probe.close());
  const client = connectProbe("test-node" as NodeName, "127.0.0.1", "nPROBE" as TailnetNodeId, { port: probe.port, whois: async () => "nPROBE" as TailnetNodeId });

  const usage = await client.artifactUsage!();
  assert.deepEqual(usage.artifacts.map((a) => a.id), [image, used, template]);
  assert.ok(usage.artifacts.every((a) => a.bytes >= 64 * 1024), "each counts the bytes its files take");
  const bytes = usage.artifacts.find((a) => a.id === template)!.bytes;

  const first = await client.dropArtifacts!([template, used, "img-00000000000f" as PortableArtifactId]);
  assert.deepEqual(first.outcomes, {
    [template]: { state: "deleted", bytes },
    [used]: { state: "skipped", reason: `${used} is still needed by pylon pylon-th-1` },
    "img-00000000000f": { state: "gone" },
  });
  assert.equal(existsSync(join(root, template)), false);
  assert.deepEqual((await client.dropArtifacts!([template])).outcomes, { [template]: { state: "deleted", bytes } },
    "the same delete again, as after a reply lost to a timeout, deletes nothing more and reports what the first freed");
  await mkdir(join(root, `.${template}.dropping`));
  assert.deepEqual((await client.dropArtifacts!([image])).outcomes[image]!.state, "deleted");
  await mkdir(join(root, `.${image}.dropping`));
  assert.deepEqual((await client.dropArtifacts!(["img-00000000000f" as PortableArtifactId])).outcomes, { "img-00000000000f": { state: "gone" } });
  assert.deepEqual((await client.dropArtifacts!([image])).outcomes[image]!.state, "deleted");
  assert.equal(existsSync(join(root, `.${image}.dropping`)), false, "what a delete a crash cut short set aside goes");

  const fresh: ImageId = "img-000000000003";
  await mkdir(join(root, fresh));
  await writeFile(join(root, fresh, "image.json"), "{}");
  const gate = Promise.withResolvers<void>();
  slow = gate.promise;
  const original = client.dropArtifacts!([fresh]);
  await new Promise((r) => setTimeout(r, 50));
  const resent = client.dropArtifacts!([fresh]);
  await new Promise((r) => setTimeout(r, 50));
  gate.resolve();
  const [once, again] = await Promise.all([original, resent]);
  assert.equal(once.outcomes[fresh]!.state, "deleted");
  assert.deepEqual(again.outcomes[fresh], once.outcomes[fresh], "a resend while the first delete runs waits for it and reports what it freed");

  const checkpoint = await fetch(`http://127.0.0.1:${probe.port}/v1/cleanup`, { method: "POST", body: JSON.stringify({ drop: ["ckpt-th-1-1"] }) });
  assert.equal(checkpoint.status, 400, "no cleanup deletes a checkpoint");
});
