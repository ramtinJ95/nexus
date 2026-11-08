/** The node's images and templates as the person's cleanup sees them: what each one takes on disk, and deleting the ones they agreed to. */
import type { VmBackend } from "../backends/backend.ts";
import type { PortableArtifactId } from "../ids.ts";
import type { ArtifactUsage, DeleteOutcome } from "../protocol/cleanup.ts";

export function artifactCleanup(artifacts: VmBackend["artifacts"], log: (message: string) => void) {
  // An artifact never changes once published, so its size is read once.
  const artifactBytes = new Map<PortableArtifactId, number>();
  // What each cleanup delete freed, so a resent delete whose first reply was lost, as to a timeout, still reports it,
  // and each delete in flight, which a resend that arrives meanwhile waits for.
  const deleted = new Map<PortableArtifactId, number>();
  const deleting = new Map<PortableArtifactId, Promise<DeleteOutcome>>();

  async function sizeOf(id: PortableArtifactId): Promise<number | null> {
    const known = artifactBytes.get(id);
    if (known !== undefined) return known;
    const bytes = await artifacts.bytes(id);
    if (bytes !== null) artifactBytes.set(id, bytes);
    return bytes;
  }

  async function dropOnce(id: PortableArtifactId): Promise<DeleteOutcome> {
    const run = (async (): Promise<DeleteOutcome> => {
      // Read as the delete starts, since another request may have deleted it while this one waited on an earlier item.
      // What the node lists is what its observation reported, and what the person was asked about.
      if (!(await artifacts.list()).includes(id)) {
        // A delete a crash cut short left what it set aside, which the backend's drop of an absent artifact removes.
        await artifacts.drop(id).catch(() => undefined);
        const freed = deleted.get(id);
        return freed === undefined ? { state: "gone" } : { state: "deleted", bytes: freed };
      }
      const bytes = await sizeOf(id) ?? 0;
      try {
        await artifacts.drop(id);
      } catch (err) {
        return { state: "skipped", reason: (err as Error).message };
      }
      artifactBytes.delete(id);
      deleted.set(id, bytes);
      log(`artifact ${id}: deleted by the person's cleanup, freeing ${bytes} bytes`);
      return { state: "deleted", bytes };
    })();
    deleting.set(id, run);
    try { return await run; } finally { deleting.delete(id); }
  }

  return {
    /** GET /v1/cleanup. */
    async usage(): Promise<ArtifactUsage> {
      const sized = await Promise.all((await artifacts.list()).map(async (id) => ({ id, bytes: await sizeOf(id) })));
      return { artifacts: sized.filter((a): a is { id: PortableArtifactId; bytes: number } => a.bytes !== null) };
    },
    /** POST /v1/cleanup. The backend refuses an artifact a pylon, a template or a create still needs, which leaves it skipped with the refusal. */
    async drop(ids: readonly PortableArtifactId[]): Promise<Record<string, DeleteOutcome>> {
      const outcomes: Record<string, DeleteOutcome> = {};
      for (const id of new Set(ids)) outcomes[id] = await (deleting.get(id) ?? dropOnce(id));
      return outcomes;
    },
  };
}
