import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readdir, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { artifactArchive, artifactDirectory, fileCodec, sha256Of, tarCodec, type ArtifactDirectory } from "./artifacts.ts";
import { JobFailure } from "./protocol/jobs.ts";
import type { ImageId, ImageManifest, TemplateId, TemplateManifest } from "./images.ts";
import { tempDir } from "./test-kit.ts";

const gnuTar = spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout?.includes("GNU tar") === true;
const template: TemplateId = "tpl-0123456789ab";
const image: ImageId = "img-0123456789ab";
const unhashed: Omit<TemplateManifest, "id" | "sha256"> = {
  key: { project: "p" as TemplateManifest["key"]["project"], image, setupHash: "s".repeat(64) },
  commit: "c0ffee",
  builtAt: "2027-01-01T00:00:00.000Z",
};

async function scratch(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await tempDir("nexus-artifacts-", t);
  return dir;
}

/** A store holding one template whose archive is a single file, as the Docker double's is. */
async function published(t: { after(fn: () => Promise<void>): void }, content = "saved image bytes") {
  const root = await scratch(t);
  const store = artifactDirectory(join(root, "a"), fileCodec("image.tar"));
  const manifest = await store.publish(template, async (dir) => { await writeFile(join(dir, "image.tar"), content); return unhashed; }, AbortSignal.timeout(5_000));
  return { root, store, manifest };
}

const leftovers = async (store: ArtifactDirectory) => (await readdir(store.root)).filter((name) => name.includes("partial"));

test("a published template is listed with the sha256 of the archive it exports", async (t) => {
  const { store, manifest } = await published(t);
  assert.deepEqual(await store.list(), [template]);
  assert.deepEqual(await store.manifest(template), manifest);
  assert.equal(manifest.sha256, createHash("sha256").update("saved image bytes").digest("hex"));
  const exported = await store.export(template);
  assert.deepEqual(exported.manifest, manifest);
  assert.equal(await sha256Of(exported.stream), manifest.sha256);
  await assert.rejects(store.export("tpl-000000000000"), (err) => err instanceof JobFailure && err.code === "artifact-missing");
});

test("a manifest file that is not a manifest fails, even one that says null, and only a missing one is no artifact", async (t) => {
  const { store } = await published(t);
  for (const text of ["null", "{}", "not JSON"]) {
    await writeFile(join(store.path(template), "template.json"), text);
    await assert.rejects(store.manifest(template));
  }
  await rm(join(store.path(template), "template.json"));
  assert.equal(await store.manifest(template), null);
});

test("an import verifies the copy, then holds the same artifact as the exporter", async (t) => {
  const { root, store, manifest } = await published(t);
  const peer = artifactDirectory(join(root, "b"), fileCodec("image.tar"));
  const { stream } = await store.export(template);
  await peer.import(manifest, stream, AbortSignal.timeout(5_000));
  assert.deepEqual(await peer.list(), [template]);
  assert.deepEqual(await peer.manifest(template), manifest);
  assert.equal(await sha256Of((await peer.export(template)).stream), manifest.sha256);
  assert.deepEqual(await leftovers(peer), []);
});

test("a copy that differs by one byte or breaks off is thrown away, and nothing of it is left", async (t) => {
  const { root, manifest } = await published(t);
  const peer = artifactDirectory(join(root, "b"), fileCodec("image.tar"));
  await assert.rejects(
    peer.import(manifest, Readable.from([Buffer.from("saved image bytez")]), AbortSignal.timeout(5_000)),
    (err) => err instanceof JobFailure && err.code === "backend" && /hashes to [0-9a-f]{64}, not [0-9a-f]{64}, so it was thrown away/.test(err.message),
  );
  const broken = new Readable({ read() {} });
  broken.push("saved ");
  setImmediate(() => broken.destroy(new Error("socket hang up")));
  await assert.rejects(peer.import(manifest, broken, AbortSignal.timeout(5_000)), /socket hang up/);
  assert.deepEqual(await peer.list(), []);
  assert.deepEqual(await leftovers(peer), []);
});

test("an import of an artifact already held is a no-op, unless the sha256 disagrees", async (t) => {
  const { store, manifest } = await published(t);
  await store.import(manifest, Readable.from([Buffer.from("never read")]), AbortSignal.timeout(5_000));
  assert.equal(await sha256Of((await store.export(template)).stream), manifest.sha256);
  await assert.rejects(
    store.import({ ...manifest, sha256: "0".repeat(64) }, Readable.from([]), AbortSignal.timeout(5_000)),
    (err) => err instanceof JobFailure && err.code === "invalid",
  );
});

test("an import that a crash cut short is cleaned up by the next one", async (t) => {
  const { root, store, manifest } = await published(t);
  const peerRoot = join(root, "b");
  await mkdir(join(peerRoot, `${template}.partial`), { recursive: true });
  await writeFile(join(peerRoot, `${template}.partial`, "image.tar"), "half");
  await writeFile(join(peerRoot, `${template}.partial.archive`), "half");
  const peer = artifactDirectory(peerRoot, fileCodec("image.tar"));
  assert.deepEqual(await peer.list(), [], "a partial import is not held");
  await peer.import(manifest, (await store.export(template)).stream, AbortSignal.timeout(5_000));
  assert.deepEqual(await peer.list(), [template]);
  assert.deepEqual(await leftovers(peer), []);
});

test("a drop or a publish that a crash cut short is cleaned up by its retry", async (t) => {
  const root = await scratch(t);
  const store = artifactDirectory(join(root, "a"), fileCodec("image.tar"));
  await mkdir(join(store.root, `.${template}.dropping`), { recursive: true });
  await writeFile(join(store.root, `.${template}.dropping`, "image.tar"), "half removed");
  await store.drop(template, []);
  assert.deepEqual(await readdir(store.root), []);
  await mkdir(join(store.root, `${template}.partial`));
  await writeFile(join(store.root, `${template}.partial`, "stale"), "from the build before");
  await store.publish(template, async (dir) => { await writeFile(join(dir, "image.tar"), "saved image bytes"); return unhashed; }, AbortSignal.timeout(5_000));
  assert.deepEqual(await readdir(store.root), [template]);
  assert.deepEqual((await readdir(store.path(template))).sort(), ["image.tar", "template.json"]);
});

test("a published image gets image.json with the sha256 of an archive that leaves it out, and is listed", async (t) => {
  const store = artifactDirectory(join(await scratch(t), "a"), fileCodec("rootfs.ext4"));
  const built: Omit<ImageManifest, "id" | "sha256"> = { gondolinBuildId: "gb-1", pins: {} as ImageManifest["pins"], builtOn: "infra-testbench" as ImageManifest["builtOn"], builtAt: "2027-01-01T00:00:00.000Z" };
  const manifest = await store.publish(image, async (dir) => { await writeFile(join(dir, "rootfs.ext4"), "rootfs bytes"); return built; }, AbortSignal.timeout(5_000));
  assert.deepEqual(manifest, { ...built, id: image, sha256: createHash("sha256").update("rootfs bytes").digest("hex") });
  assert.deepEqual((await readdir(store.path(image))).sort(), ["image.json", "rootfs.ext4"]);
  assert.deepEqual(await store.list(), [image]);
});

test("a publish whose fill fails leaves no .partial and publishes nothing", async (t) => {
  const store = artifactDirectory(join(await scratch(t), "a"), fileCodec("image.tar"));
  await assert.rejects(store.publish(template, async (dir) => { await writeFile(join(dir, "image.tar"), "half"); throw new Error("docker save failed"); }, AbortSignal.timeout(5_000)), /docker save failed/);
  assert.deepEqual(await readdir(store.root), []);
});

test("an ID that is not an image or template ID names no path", async (t) => {
  const root = await scratch(t);
  await mkdir(join(root, "pylons"));
  const store = artifactDirectory(join(root, "store"), fileCodec("image.tar"));
  const invalid = (err: unknown) => err instanceof JobFailure && err.code === "invalid";
  assert.throws(() => store.path("tpl-x/../../pylons" as TemplateId), invalid);
  await assert.rejects(store.drop("tpl-x/../../pylons" as TemplateId, []), invalid);
  await assert.rejects(store.import({ ...unhashed, id: "tpl-.." as TemplateId, sha256: "0".repeat(64) }, Readable.from([]), AbortSignal.timeout(5_000)), invalid);
  assert.deepEqual(await readdir(root), ["pylons"]);
});

test("drop refuses while something depends on the artifact, and is a no-op once it is gone", async (t) => {
  const { store } = await published(t);
  await assert.rejects(store.drop(template, ["pylon pylon-a"]), (err) => err instanceof JobFailure && err.code === "invalid" && /needed by pylon pylon-a/.test(err.message));
  assert.deepEqual(await store.list(), [template]);
  await store.drop(template, []);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await readdir(store.root), []);
  await store.drop(template, []);
});

test("the archive is byte-stable across copies and leaves the manifest out", { skip: !gnuTar && "needs GNU tar" }, async (t) => {
  const dirWith = async (files: Record<string, string>) => {
    const dir = await scratch(t);
    for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content);
    return dir;
  };
  const a = await dirWith({ "manifest.json": "{}", "rootfs.ext4": "root", "image.json": "first" });
  const b = await dirWith({ "rootfs.ext4": "root", "image.json": "second", "manifest.json": "{}" });
  const earlier = new Date("2020-01-01T00:00:00Z");
  for (const path of ["rootfs.ext4", "image.json", "manifest.json", "."]) await utimes(join(b, path), earlier, earlier);
  assert.equal(await sha256Of(artifactArchive(a, "image.json")), await sha256Of(artifactArchive(b, "image.json")));
  await writeFile(join(b, "rootfs.ext4"), "changed");
  assert.notEqual(await sha256Of(artifactArchive(a, "image.json")), await sha256Of(artifactArchive(b, "image.json")));
});

test("the archive does not depend on the permissions the store gave the directory or its files, only on what is executable", { skip: !gnuTar && "needs GNU tar" }, async (t) => {
  const dirWith = async (dirMode: number, fileMode: number) => {
    const dir = await scratch(t);
    await writeFile(join(dir, "rootfs.ext4"), "root", { mode: fileMode });
    await chmod(join(dir, "rootfs.ext4"), fileMode);
    await chmod(dir, dirMode);
    return dir;
  };
  const built = await sha256Of(artifactArchive(await dirWith(0o755, 0o644), "image.json"));
  assert.equal(await sha256Of(artifactArchive(await dirWith(0o700, 0o600), "image.json")), built);
  assert.notEqual(await sha256Of(artifactArchive(await dirWith(0o755, 0o755), "image.json")), built);
});

test("the archive stream errors when tar fails", async () => {
  await assert.rejects(async () => {
    for await (const _ of artifactArchive(join(tmpdir(), "nexus-no-such-image"), "image.json")) { /* drain */ }
  }, /tar exited/);
});

test("a tar copy of a sparse image keeps its holes and archives again to the manifest's sha256", { skip: !gnuTar && "needs GNU tar" }, async (t) => {
  const root = await scratch(t);
  const store = artifactDirectory(join(root, "a"), tarCodec);
  const dir = store.path(image);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "manifest.json"), "{}");
  await writeFile(join(dir, "rootfs.ext4"), "data at the start");
  await truncate(join(dir, "rootfs.ext4"), 1 << 30);
  const manifest: ImageManifest = {
    id: image, gondolinBuildId: "b", builtOn: "n" as ImageManifest["builtOn"], builtAt: "2027-01-01T00:00:00.000Z",
    pins: {} as ImageManifest["pins"], sha256: await sha256Of(artifactArchive(dir, "image.json")),
  };
  await writeFile(join(dir, "image.json"), JSON.stringify(manifest));
  const peer = artifactDirectory(join(root, "b"), tarCodec);
  await peer.import(manifest, (await store.export(image)).stream, AbortSignal.timeout(30_000));
  assert.equal(await sha256Of((await peer.export(image)).stream), manifest.sha256);
  const du = spawnSync("du", ["-k", join(peer.path(image), "rootfs.ext4")], { encoding: "utf8" }).stdout;
  assert.ok(Number(du.split("\t")[0]) < 1024, `the 1 GiB sparse rootfs takes ${du.trim()} after the copy`);
  const file = await open(join(peer.path(image), "rootfs.ext4"));
  t.after(() => file.close());
  assert.equal((await file.read(Buffer.alloc(17), 0, 17, 0)).buffer.toString(), "data at the start");
});
