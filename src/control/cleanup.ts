/**
 * The cleanup pass: for each node, what it could delete (cleanup-model.ts), asked as one question once that set holds
 * an item the node's last question did not, so neither the same set nor a smaller one is asked again, whether the
 * person kept it or not. Once the person answers Delete, the node's probe deletes the images and templates, which this
 * pass sends it, and the node's deployer the releases, which it asks for when it next reports them (`releases`). Each
 * item is read again before its delete, and one now in use stays, with why, in the answered question.
 */
import type { NodeName, PortableArtifactId } from "../ids.ts";
import type { ProbeClient } from "../protocol/client.ts";
import { ProbeHttpError } from "../protocol/http.ts";
import { maxDrops, type ArtifactUsage, type DeleteOutcome } from "../protocol/cleanup.ts";
import { releaseKeeps, type ReleaseInventory } from "../deploy/release-cleanup.ts";
import { singleFlight } from "../single-flight.ts";
import type { Registry } from "./registry.ts";
import type { NodeQuestion } from "./questions.ts";
import { artifactKept, bytesText, cleanupCandidates, cleanupQuestion, grew, itemKey, undeleted, type CleanupItem, type NodeFacts } from "./cleanup-model.ts";

type CleanupRegistry = Pick<Registry, "askQuestion" | "currentImage" | "imageOperation" | "node" | "nodeQuestions" | "nodes" | "previousImage" | "projects" | "pylonsWithThreadsOn"
  | "recordCleanup" | "releaseInventory" | "saveReleaseInventory" | "templates" | "withdrawNodeQuestion">;

export const cleanupEveryMs = 60_000;

export function cleanupPass({ registry, probes, log, now = Date.now }: {
  registry: CleanupRegistry; probes: ReadonlyMap<NodeName, Pick<ProbeClient, "artifactUsage" | "dropArtifacts">>; log: (message: string) => void; now?: () => number;
}) {
  function factsOf(node: NodeName): NodeFacts {
    const record = registry.node(node);
    return {
      held: record?.state === "online" ? record.observation?.artifacts ?? null : null,
      templates: registry.projects().flatMap((p) => registry.templates(p.id)).filter((t) => (t.state === "ready" ? t.builtOn : t.on) === node),
      current: registry.currentImage(),
      previous: registry.previousImage(),
      operated: registry.imageOperation()?.image ?? null,
      boots: registry.pylonsWithThreadsOn(node).flatMap(({ pylon, thread }) => {
        const listed = record?.observation?.pylons.some((p) => p.pylonId === pylon.pylonId) ?? false;
        const starting = !listed && (thread.status === "active" || thread.status === "idle");
        if (!listed && !starting) return [];
        return [{ pylon: pylon.pylonId, image: pylon.boot.image, template: starting && pylon.firstBoot.kind === "template" ? pylon.firstBoot.template : null }];
      }),
      releases: registry.releaseInventory(node),
    };
  }

  /** What the probe says each artifact takes. A probe from before the cleanup route sizes none, so no artifact is asked about. */
  async function usageOn(node: NodeName): Promise<ArtifactUsage> {
    const probe = probes.get(node);
    if (probe?.artifactUsage === undefined) return { artifacts: [] };
    return probe.artifactUsage().catch((err: unknown) => {
      if (err instanceof ProbeHttpError && err.status === 404) return { artifacts: [] };
      throw err;
    });
  }

  async function ask(node: NodeName) {
    const facts = factsOf(node);
    const asked = registry.nodeQuestions(node);
    const latest = asked.at(-1);
    const deleting = new Set(asked.flatMap((q) => undeleted(q).map(itemKey)));
    const candidates = cleanupCandidates(node, facts, now()).filter((c) => !deleting.has(itemKey(c)));
    if (!grew(candidates, latest)) return;
    const usage = candidates.some((c) => c.kind !== "release") ? await usageOn(node) : { artifacts: [] };
    // An artifact the probe does not size is outside its artifact directory, such as a Docker image a node configures.
    const items = candidates.flatMap((c): CleanupItem[] => {
      const bytes = c.kind === "release" ? facts.releases!.releases.find((r) => r.name === c.name)!.bytes : usage.artifacts.find((a) => a.id === c.id)?.bytes;
      return bytes === undefined ? [] : [{ ...c, bytes }];
    });
    if (!grew(items, latest)) return;
    if (latest !== undefined && latest.answer === null) registry.withdrawNodeQuestion(latest.id);
    const question = registry.askQuestion(cleanupQuestion(node, items, now()));
    log(`${node}: asked ${question.id}, whether to delete ${items.length} items that take ${bytesText(items.reduce((sum, i) => sum + i.bytes, 0))}`);
  }

  /**
   * Sends the probe the images and templates the person agreed to delete that nothing uses now, a batch at a time, each
   * checked again just before its batch, and records what each delete did. One the node no longer lists goes too, so
   * the probe reports it gone and removes what a delete a crash cut short left of it.
   */
  async function deleteArtifacts(node: NodeName, q: NodeQuestion) {
    const probe = probes.get(node);
    if (probe?.dropArtifacts === undefined) return;
    const ids = undeleted(q).flatMap((i) => i.kind === "release" ? [] : [i.id]);
    for (let at = 0; at < ids.length; at += maxDrops) {
      const facts = factsOf(node);
      if (facts.held === null) return;
      const settled: Record<string, DeleteOutcome> = {};
      const drop: PortableArtifactId[] = [];
      for (const id of ids.slice(at, at + maxDrops)) {
        const kept = artifactKept(node, facts, id, now());
        if (kept !== null) settled[id] = { state: "skipped", reason: kept };
        else drop.push(id);
      }
      if (Object.keys(settled).length > 0) registry.recordCleanup(q.id, settled);
      if (drop.length === 0) continue;
      const { outcomes } = await probe.dropArtifacts(drop);
      registry.recordCleanup(q.id, outcomes);
      log(`${node}: ${q.id}: ${drop.map((id) => `${id} ${outcomes[id]?.state ?? "unreported"}`).join(", ")}`);
    }
  }

  async function pass() {
    for (const { name } of registry.nodes()) {
      try {
        for (const q of registry.nodeQuestions(name)) await deleteArtifacts(name, q);
        await ask(name);
      } catch (err) {
        log(`${name}: cleanup: ${(err as Error).message}`);
      }
    }
  }
  const passes = singleFlight(pass);

  return {
    poll: passes.rerun,
    close: passes.settled,
    /**
     * The node's deployer reports the releases it holds, and what its last deletes did. Stores the releases, records
     * each delete's outcome, and answers the releases the person agreed to delete that nothing keeps now. One gone from
     * the node since is gone, and one a link or a process now keeps is skipped, with why.
     */
    releases(node: NodeName, inventory: ReleaseInventory, outcomes: Readonly<Record<string, DeleteOutcome>> = {}): string[] {
      registry.saveReleaseInventory(node, inventory);
      const keeps = releaseKeeps(inventory);
      const wanted = new Set<string>();
      for (const q of registry.nodeQuestions(node)) {
        const settled: Record<string, DeleteOutcome> = {};
        for (const item of undeleted(q)) {
          if (item.kind !== "release") continue;
          const kept = keeps.get(item.name);
          const reported = outcomes[item.name];
          if (reported !== undefined) settled[itemKey(item)] = reported;
          else if (!inventory.releases.some((r) => r.name === item.name)) settled[itemKey(item)] = { state: "gone" };
          else if (kept !== undefined) settled[itemKey(item)] = { state: "skipped", reason: kept };
          else wanted.add(item.name);
        }
        if (Object.keys(settled).length > 0) registry.recordCleanup(q.id, settled);
      }
      return [...wanted];
    },
  };
}

export type CleanupPass = ReturnType<typeof cleanupPass>;
