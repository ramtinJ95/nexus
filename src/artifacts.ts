/**
 * A node's store of images and templates: one immutable directory <root>/<id>/ per artifact, holding the files
 * its archive carries and its manifest. The root is the same path on every node, so a template's qcow2 backing
 * file, its image's rootfs, resolves after a copy. Gondolin also rebases a disk whose image moved when it boots
 * it (S7). Checkpoints are not here: each lives in its pylon's instance and never leaves its node.
 *
 * Streamed copies between the nodes broke off in S7, so a copy is verified before anything uses it. import
 * stages the whole stream in a file, checks its sha256 against the manifest, and only then unpacks it and
 * renames it in. A crash leaves only <id>.partial, <id>.partial.archive or .<id>.dropping, and only while
 * the ID is not held, so the job's retry runs again and its publish, import or drop removes them.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { JobFailure } from "./backend.ts";
import type { ArtifactManifest, ImageId, ImageManifest, PortableArtifactId, TemplateManifest } from "./images.ts";
import { isPortableArtifactId, parseArtifactManifest } from "./protocol.ts";

const execFileAsync = promisify(execFile);

/** Each kind's manifest file. It stays out of the archive, because it holds the archive's sha256. */
export const manifestFiles = { image: "image.json", template: "template.json" } as const;
const manifestFileOf = (id: PortableArtifactId) => id.startsWith("img-") ? manifestFiles.image : manifestFiles.template;

/**
 * The sparse archive peers fetch: every file of an artifact directory except its manifest, as a byte-stable
 * GNU tar. The manifest's sha256 is the digest of this stream, so an image's archive must stay byte for byte
 * what buildImage hashed. Modes are normalized, so a directory moved into the store with other permissions
 * still archives to its hash: everything is readable by all and writable by its owner, and only directories and
 * files that were executable by anyone are executable. Setuid, setgid and sticky bits pass through as they are.
 * The stream errors if tar fails, and destroying it stops tar.
 */
export function artifactArchive(dir: string, manifest: string, signal?: AbortSignal): Readable {
  const args = ["--create", "--file=-", "--sparse", "--format=gnu", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--mode=u+rwX,go+rX,go-w", `--exclude=./${manifest}`, "-C", dir, "."];
  const tar = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"], ...(signal === undefined ? {} : { signal }) });
  const archive = new PassThrough();
  let stderr = "";
  tar.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  tar.stdout.pipe(archive, { end: false });
  tar.on("error", (err) => archive.destroy(err));
  tar.on("close", (code) => code === 0 ? archive.end() : archive.destroy(new Error(`tar exited ${code} archiving ${dir}: ${stderr.trim()}`)));
  // A reader that gives up would otherwise leave tar blocked on a full pipe.
  archive.on("close", () => { if (tar.exitCode === null) tar.kill(); });
  return archive;
}

/** How an artifact directory becomes the stream a peer fetches, and how a verified copy of it becomes the directory again. */
export interface ArtifactCodec {
  pack(dir: string, manifest: string, signal?: AbortSignal): Readable;
  /** Moves or extracts the verified archive file into an empty directory. */
  unpack(archive: string, dir: string): Promise<void>;
}

/** GNU tar, for Gondolin images and templates. The archived modes are extracted as they are, so a node that imported an artifact archives it to the same bytes. */
export const tarCodec: ArtifactCodec = {
  pack: artifactArchive,
  async unpack(archive, dir) {
    try {
      await execFileAsync("tar", ["--extract", `--file=${archive}`, "--preserve-permissions", "--no-same-owner", "-C", dir]);
    } catch (err) {
      throw new JobFailure("backend", `tar could not extract a verified copy into ${dir}: ${(err as { stderr?: string }).stderr?.trim() || (err as Error).message}`);
    }
  },
};

/** One file that is its own archive, such as the Docker test double's `docker save` output. */
export function fileCodec(name: string): ArtifactCodec {
  return {
    pack: (dir) => createReadStream(join(dir, name)),
    unpack: (archive, dir) => rename(archive, join(dir, name)),
  };
}

type ManifestOf<I extends PortableArtifactId> = I extends ImageId ? ImageManifest : TemplateManifest;

export interface ArtifactDirectory {
  readonly root: string;
  path(id: PortableArtifactId): string;
  /** Published artifacts only: a directory that has its manifest. */
  list(): Promise<PortableArtifactId[]>;
  manifest<I extends PortableArtifactId>(id: I): Promise<ManifestOf<I> | null>;
  /** `fill` writes the template's files into an empty directory, which is then hashed, given its manifest and renamed in. */
  publish(manifest: Omit<TemplateManifest, "sha256">, fill: (dir: string) => Promise<void>, signal: AbortSignal): Promise<TemplateManifest>;
  export(id: PortableArtifactId): Promise<{ manifest: ArtifactManifest; stream: Readable }>;
  /** Holding the artifact already is a no-op, as long as the sha256 agrees. */
  import(manifest: ArtifactManifest, stream: Readable, signal: AbortSignal): Promise<void>;
  /** Refuses while anything in `dependents` is named. Absent: no-op. */
  drop(id: PortableArtifactId, dependents: readonly string[]): Promise<void>;
}

export function artifactDirectory(root: string, codec: ArtifactCodec): ArtifactDirectory {
  const checked = (id: PortableArtifactId) => {
    if (!isPortableArtifactId(id)) throw new JobFailure("invalid", `${JSON.stringify(id)} is not an image or template ID`);
    return id;
  };
  const path = (id: PortableArtifactId) => join(root, checked(id));
  const partialOf = (id: PortableArtifactId) => `${path(id)}.partial`;
  const archiveOf = (id: PortableArtifactId) => `${partialOf(id)}.archive`;
  const doomedOf = (id: PortableArtifactId) => join(root, `.${checked(id)}.dropping`);
  /** What a crash in a publish, an import or a drop of `id` left. */
  const sweep = async (id: PortableArtifactId) => {
    await rm(partialOf(id), { recursive: true, force: true });
    await rm(archiveOf(id), { force: true });
    await rm(doomedOf(id), { recursive: true, force: true });
  };
  const writeManifest = (dir: string, manifest: ArtifactManifest) =>
    writeFile(join(dir, manifestFileOf(manifest.id)), `${JSON.stringify(manifest, null, 2)}\n`);

  async function manifest<I extends PortableArtifactId>(id: I): Promise<ManifestOf<I> | null> {
    let text: string;
    try {
      text = await readFile(join(path(id), manifestFileOf(id)), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const parsed = parseArtifactManifest(JSON.parse(text));
    if (parsed.id !== id) throw new Error(`${path(id)} holds the manifest of ${parsed.id}`);
    return parsed as ManifestOf<I>;
  }

  return {
    root,
    path,
    manifest,

    async list() {
      let names: string[];
      try {
        names = await readdir(root);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      return names.filter(isPortableArtifactId).filter((id) => existsSync(join(path(id), manifestFileOf(id)))).sort();
    },

    async publish(unhashed, fill, signal) {
      const partial = partialOf(unhashed.id);
      await sweep(unhashed.id);
      await mkdir(partial, { recursive: true, mode: 0o700 });
      await fill(partial);
      const published: TemplateManifest = { ...unhashed, sha256: await sha256Of(codec.pack(partial, manifestFiles.template, signal)) };
      await writeManifest(partial, published);
      await rename(partial, path(unhashed.id));
      return published;
    },

    async export(id) {
      const held = await manifest(id);
      if (held === null) throw new JobFailure("artifact-missing", `this node holds no ${id}`);
      return { manifest: held, stream: codec.pack(path(id), manifestFileOf(id)) };
    },

    async import(incoming, stream, signal) {
      // A peer's stream can break off before the pipeline below listens, and would throw out of the probe. The pipeline still sees the error.
      stream.on("error", () => undefined);
      const { id } = incoming;
      await sweep(id);
      const held = await manifest(id);
      if (held !== null) {
        stream.destroy();
        if (held.sha256 !== incoming.sha256) throw new JobFailure("invalid", `this node holds ${id} with sha256 ${held.sha256}, not ${incoming.sha256}`);
        return;
      }
      const partial = partialOf(id);
      const archive = archiveOf(id);
      await mkdir(root, { recursive: true, mode: 0o700 });
      try {
        const hash = createHash("sha256");
        const hashing = new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); done(null, chunk); } });
        await pipeline(stream, hashing, createWriteStream(archive, { flags: "wx", mode: 0o600 }), { signal });
        const sha256 = hash.digest("hex");
        if (sha256 !== incoming.sha256) throw new JobFailure("backend", `the copy of ${id} hashes to ${sha256}, not ${incoming.sha256}, so it was thrown away`);
        await mkdir(partial, { mode: 0o700 });
        await codec.unpack(archive, partial);
        // Gone before the rename, so a crash never strands an archive beside a held artifact, whose retried fetch never imports.
        await rm(archive, { force: true });
        await writeManifest(partial, incoming);
        await rename(partial, path(id));
      } finally {
        await rm(archive, { force: true });
        await rm(partial, { recursive: true, force: true });
      }
    },

    async drop(id, dependents) {
      if (dependents.length > 0) throw new JobFailure("invalid", `${id} is still needed by ${dependents.join(", ")}`);
      // Renamed aside first, so a crash midway never leaves a published directory with part of its files.
      await sweep(id);
      if (existsSync(path(id))) await rename(path(id), doomedOf(id));
      await sweep(id);
    },
  };
}

export async function sha256Of(stream: Readable): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
