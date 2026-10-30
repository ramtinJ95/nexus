/**
 * Project templates for the pylon VM backend. A build is the fork's `prepare` under the template's ID in
 * <stateRoot>/templates (boot the image, run setup, checkpoint the disk, stop), then a publish of that disk
 * into the artifact store, then a destroy of the fork's copy. Each step starts from what is on disk, so a
 * build that stopped anywhere converges on its next run. A template is a qcow2 overlay on its image's rootfs,
 * and a pylon booted from it gets a copy of the disk, so nothing on the node depends on a published template.
 */
import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { JobFailure } from "./backend.ts";
import type { ArtifactDirectory } from "./artifacts.ts";
import type { ImageId, TemplateId, TemplateManifest } from "./images.ts";
import { run } from "./pylon-vm/client.ts";
import { imageLabel, inspectionSchema, settled, type BootSpec, type Inspection, type SandboxConfig } from "./pylon-vm/contracts.ts";
import { directory, readLogTail } from "./pylon-vm/storage.ts";

const diskFile = "disk.qcow2";

export interface TemplatePrepare {
  /** The fork's config for the build: the image, the disk size, and setup as the clone, preSetup and `.nexus/setup`. */
  config: SandboxConfig;
  boot: BootSpec;
  manifest: Omit<TemplateManifest, "builtAt" | "sha256">;
}

/** A failed setup, the 20-minute limit included, is setup-failed with the controller log's tail, and publishes nothing. */
export async function buildTemplate(stateRoot: string, store: ArtifactDirectory, prepare: TemplatePrepare, signal: AbortSignal): Promise<void> {
  const name = prepare.manifest.id;
  const dir = directory(stateRoot, "templates", name);
  const destroy = () => run(stateRoot, { action: "destroy", kind: "templates", name, confirm: name });
  let failure: unknown = null;
  for (let attempts = 0; ; attempts++) {
    if (await store.manifest(name) !== null) {
      // Also sweeps the prepared copy that a build which died after publishing left behind.
      await destroy();
      return;
    }
    const found = await settled(async () => (await builds(stateRoot)).find((b) => b.name === name) ?? null, ["starting", "unavailable"], signal);
    if (found?.status.state === "prepared") {
      await store.publish({ ...prepare.manifest, builtAt: new Date().toISOString() }, (into) => copyFile(join(dir, diskFile), join(into, diskFile), constants.COPYFILE_FICLONE), signal);
      continue;
    }
    if (found !== null) {
      const log = await controllerLogTail(dir);
      await destroy();
      const { state, startupError, startupFailures } = found.status;
      if (state === "failed" && startupFailures?.some((f) => f.kind === "setup")) throw new JobFailure("setup-failed", `the setup of template ${name} failed: ${startupError}`, log);
      // What an earlier, interrupted build left is started over. This build's own attempt is not.
      if (attempts > 0) throw new JobFailure("backend", `template ${name} did not prepare, and its build is ${state}`, log);
    } else if (attempts > 0) {
      throw failure ?? new Error(`template ${name} did not prepare, and its build left nothing`);
    }
    signal.throwIfAborted();
    try {
      await run(stateRoot, { action: "prepare", name, config: prepare.config, boot: prepare.boot, labels: { [imageLabel]: prepare.manifest.key.image } }, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      failure = err; // the build's state on disk says what happened, on the next pass
    }
  }
}

/** The end of a build's or an instance's controller log, for a JobFailure's or a broken pylon's logTail. */
export async function controllerLogTail(dir: string): Promise<string> {
  return (await readLogTail(join(dir, "controller.log"), 60)).output.slice(-8192);
}

/** The disk a pylon booted from `template` copies in. The template must be over the pylon's image. */
export async function templateDisk(store: ArtifactDirectory, template: TemplateId, image: ImageId): Promise<string> {
  const manifest = await store.manifest(template);
  if (manifest === null) throw new JobFailure("artifact-missing", `template ${template} is not on this node`);
  if (manifest.key.image !== image) throw new JobFailure("invalid", `template ${template} is a disk over ${manifest.key.image}, and the pylon boots ${image}`);
  return join(store.path(template), diskFile);
}

/** Template builds that are booted from `image` and not yet published or destroyed. */
export async function buildsFrom(stateRoot: string, image: ImageId): Promise<string[]> {
  return (await builds(stateRoot)).filter((b) => b.labels[imageLabel] === image).map((b) => `template build ${b.name}`);
}

const builds = async (stateRoot: string): Promise<Inspection[]> => z.array(inspectionSchema).parse(await run(stateRoot, { action: "list", kind: "templates" }));
