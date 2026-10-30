/**
 * The node store: each node, in `nodes`, the join tokens, in `join_tokens`, and the nodes that joined with one, in
 * `joined_nodes`.
 */
import { jsonOrNull, type Db, type Row } from "./db.ts";
import type { NodeName, TailnetNodeId } from "../ids.ts";
import {
  upgradeObservation, type NodeObservation, type OlderObservation, type ReportedCapacity,
} from "../protocol/observations.ts";

export interface NodeRecord {
  name: NodeName;
  tailnetHost: string;
  tailnetNodeId: TailnetNodeId;
  state: "online" | "offline";
  /** As the probe reported it, which the API sends. Null for a node never observed. */
  capacity: ReportedCapacity | null;
  /** The probe's latest observation. While the node is offline the dashboard shows it, marked stale. */
  observation: NodeObservation | null;
}

/** A node that joined with a token rather than being named in control.json. `deployKey` is the digest of its deployer's token. */
export interface JoinedNode extends Pick<NodeRecord, "name" | "tailnetHost" | "tailnetNodeId"> { deployKey: string; joinedAt: number }

function observationOf(value: unknown): NodeObservation | null {
  const o = jsonOrNull<OlderObservation>(value);
  return o === null ? null : upgradeObservation(o);
}

function nodeRow(r: Row): NodeRecord {
  return {
    name: r.name as NodeName,
    tailnetHost: r.tailnet_host as string,
    tailnetNodeId: r.tailnet_node_id as TailnetNodeId,
    state: r.state as NodeRecord["state"],
    capacity: jsonOrNull(r.capacity),
    observation: observationOf(r.observation),
  };
}

export type NodeStore = ReturnType<typeof nodeStore>;

export function nodeStore(db: Db) {
  const { transaction, sql } = db;
  function node(name: NodeName): NodeRecord | undefined {
    const row = sql("SELECT * FROM nodes WHERE name = ?").get(name);
    return row && nodeRow(row);
  }

  function upsertNode(node: Pick<NodeRecord, "name" | "tailnetHost" | "tailnetNodeId">) {
    sql(`INSERT INTO nodes (name, tailnet_host, tailnet_node_id, state) VALUES (?, ?, ?, 'offline')
      ON CONFLICT (name) DO UPDATE SET tailnet_host = excluded.tailnet_host, tailnet_node_id = excluded.tailnet_node_id`).run(node.name, node.tailnetHost, node.tailnetNodeId);
  }
  return {
    /** Nodes come from the config file or a join. Their state and capacity come from observations. */
    upsertNode,
    nodes: () => (sql("SELECT * FROM nodes ORDER BY name").all() as Row[]).map(nodeRow),
    node,
    /** For ingest, in its transaction. */
    saveObservation(observation: NodeObservation) { sql("UPDATE nodes SET observation = ? WHERE name = ?").run(JSON.stringify(observation), observation.node); },
    saveNodeState(name: NodeName, state: NodeRecord["state"], capacity: NodeObservation["capacity"]) { sql("UPDATE nodes SET state = ?, capacity = ? WHERE name = ?").run(state, JSON.stringify(capacity), name); },
    /** Each node's tailnet node ID, without reading its observation. */
    nodeIds: (): Map<NodeName, TailnetNodeId> => new Map(sql("SELECT name, tailnet_node_id FROM nodes").all().map((r) => [r.name as NodeName, r.tailnet_node_id as TailnetNodeId])),
    /** The node with this tailnet ID and the deploy key it joined with, null for a configured node, without reading its observation. */
    nodeByTailnetId(id: TailnetNodeId): { name: NodeName; deployKey: string | null } | undefined {
      const row = sql("SELECT name, deploy_key FROM nodes LEFT JOIN joined_nodes USING (name) WHERE tailnet_node_id = ?").get(id);
      return row === undefined ? undefined : { name: row.name as NodeName, deployKey: row.deploy_key as string | null };
    },
    /** The loop marks a node offline when its observe link stays down. Every other node fact comes through apply. */
    markOffline(name: NodeName) { sql("UPDATE nodes SET state = ? WHERE name = ?").run("offline", name); },
    addJoinToken(hash: string, expiresAt: number) { sql("INSERT INTO join_tokens (hash, expires_at) VALUES (?, ?)").run(hash, expiresAt); },
    joinToken(hash: string): { expiresAt: number; usedAt: number | null } | undefined {
      const row = sql("SELECT expires_at, used_at FROM join_tokens WHERE hash = ?").get(hash);
      return row === undefined ? undefined : { expiresAt: row.expires_at as number, usedAt: row.used_at as number | null };
    },
    /** Records the node and uses up its token, or does neither when the token was used or expired meanwhile. */
    joinNode(hash: string, node: Omit<JoinedNode, "joinedAt">, at: number): boolean {
      return transaction(() => {
        if (sql("UPDATE join_tokens SET used_at = ?, used_by = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?").run(at, node.tailnetNodeId, hash, at).changes === 0) return false;
        upsertNode(node);
        sql("INSERT INTO joined_nodes VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET deploy_key = excluded.deploy_key, joined_at = excluded.joined_at").run(node.name, node.deployKey, at);
        return true;
      });
    },
    joinedNodes: (): JoinedNode[] => sql("SELECT nodes.*, deploy_key, joined_at FROM joined_nodes JOIN nodes USING (name) ORDER BY name").all().map((r) => ({
      name: r.name as NodeName, tailnetHost: r.tailnet_host as string, tailnetNodeId: r.tailnet_node_id as TailnetNodeId, deployKey: r.deploy_key as string, joinedAt: r.joined_at as number,
    })),
  };
}
