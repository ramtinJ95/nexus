/**
 * What the API and the dashboard show of a thread: its row, its detail, its pylon's state and its conversation.
 */
import type { Preview, Registry, Thread } from "../registry.ts";
import type { ThreadAgents } from "../thread-agent.ts";
import type { ThreadDetail, ThreadRow } from "../wire.ts";
import { actualState, desiredPhase, retryRefusal } from "../../reconcile.ts";
import { agentView, type AgentView } from "../conversation-view.ts";
import { bootNetwork } from "../threads.ts";
import { herdrSession } from "../../sessions.ts";
import { judgmentView } from "../judgment.ts";
import { linkedName } from "../../services-file.ts";
import type { BootInputs } from "../../spawn.ts";
import type { Project } from "../../project.ts";
import { observedPylon } from "../observed.ts";
import { watchStopped } from "../pr-watch.ts";

function networkGrantsKey(network: BootInputs["network"]): string {
  const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
  const secrets = new Map<string, Set<string>>();
  for (const grant of network.secrets) {
    const hosts = secrets.get(grant.name) ?? new Set<string>();
    for (const host of grant.hosts) hosts.add(host);
    secrets.set(grant.name, hosts);
  }
  return JSON.stringify({
    allowedHosts: sorted(network.allowedHosts),
    secrets: sorted(secrets.keys()).map((name) => ({ name, hosts: sorted(secrets.get(name)!) })),
  });
}

export function threadViews(registry: Registry, agents: ThreadAgents, options: { prWatchEnabled?: boolean | undefined }) {
  /** The thread's pylon, its node, what that node last reported of it, and what it is doing, from one read of each. */
  function pylonState(t: Pick<Thread, "pylonId" | "status">) {
    const pylon = registry.pylon(t.pylonId)!;
    const node = registry.node(pylon.node)!;
    const observed = observedPylon({ node: () => node }, pylon) ?? "absent";
    // The planner deletes a failed pylon all the same, so a deleted thread's pylon shows the delete.
    const gaveUp = pylon.failed !== null && t.status !== "deleted";
    return { pylon, node, observed, actualState: actualState(observed, registry.job(pylon.pylonId) ?? null, node.state === "online", gaveUp) };
  }

  function pylonOf({ pylon, node, observed, actualState }: ReturnType<typeof pylonState>, project: Project): ThreadDetail["pylon"] {
    return {
      grantsOutdated: networkGrantsKey(pylon.boot.network) !== networkGrantsKey(bootNetwork(project, pylon.boot.dotfiles.repo)),
      id: pylon.pylonId, node: pylon.node, failed: pylon.failed, observedAt: node.observation?.observedAt ?? null, resources: pylon.boot.resources,
      actualState, retryRefused: retryRefusal(observed),
    };
  }

  function portsOf(observed: ReturnType<typeof pylonState>["observed"], previews: readonly Preview[]): ThreadDetail["ports"] {
    if (observed === "absent" || observed.phase !== "running") return [];
    if (observed.listening === null) return null;
    return observed.listening.map(({ port }) => {
      // A port linked a moment ago has its preview before the node's next read lists its service.
      const service = observed.services?.find((s) => s.port === port)?.name
        ?? (previews.some((p) => p.service === linkedName(port)) ? linkedName(port) : null);
      return { port, service, preview: previews.find((p) => p.service === service) ?? null };
    });
  }

  function row(t: Thread): ThreadRow {
    const { pylon, actualState } = pylonState(t);
    return { ...t, attention: registry.attention(t.id), desired: desiredPhase(t, Date.now()), pylon: { node: pylon.node, actualState, failed: pylon.failed } };
  }

  function detail(t: Thread): ThreadDetail {
    const state = pylonState(t);
    const previews = registry.previews(t.pylonId);
    const watch = registry.prWatch(t.id);
    const { claudeWorker, agent } = agents[registry.agent(t).kind].detail(t);
    return {
      thread: t,
      ...claudeWorker === undefined ? {} : { claudeWorker },
      attention: registry.attention(t.id), seenAt: t.seenAt, lastReplyAt: t.lastReplyAt,
      desired: desiredPhase(t, Date.now()),
      pylon: pylonOf(state, registry.project(t.project)!),
      sessions: registry.sessions(t.pylonId),
      previews,
      ports: portsOf(state.observed, previews),
      outputs: registry.outputs(t.id),
      prWatch: { enabled: options.prWatchEnabled ?? false, stopped: watchStopped(watch), error: watch?.error ?? null },
      pullRequests: watch?.links.map((l) => l.pr) ?? [],
      review: registry.review(t.id),
      questions: registry.questions(t.id),
      judgments: registry.judgments(t.id).map(judgmentView),
      planning: registry.planning(t.id) !== null,
      attach: `herdr --session ${herdrSession}`,
      agent,
    };
  }

  /** What a thread page shows: a Claude worker's transcript as last read, the harness conversation's view, or none. */
  async function conversation(t: Thread): Promise<AgentView | null> {
    const view = await agents[registry.agent(t).kind].view(t);
    return view === null ? null : agentView(view);
  }

  return { pylonState, row, detail, conversation };
}
export type ThreadViews = ReturnType<typeof threadViews>;
