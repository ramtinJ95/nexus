/**
 * The tailnet the two-person tests and the verify-nexus stack stand in for: two people, alice and bob, each on a
 * device of their own, and a node that carries a tag and no user. Each is the answer tailscaled's LocalAPI gives to
 * `GET /localapi/v0/whois`, in its shape, so a test reads the same fields Nexus reads from the real one. Nexus reads
 * only Node.StableID and Node.Name today. It imports only types, so stack.ts loads it as it is.
 */
import type { TailnetNodeId } from "../ids.ts";

/** LocalAPI whois's answer, the part of it Nexus may read. A person's device has a user. A tagged node has none. */
export interface WhoisAnswer {
  Node: { ID: number; StableID: TailnetNodeId; Name: string; User?: number; Tags?: readonly string[] };
  UserProfile?: { ID: number; LoginName: string; DisplayName: string; ProfilePicURL: string };
  CapMap: Record<string, unknown>;
}

const person = (id: number, host: string, login: string, display: string): WhoisAnswer => ({
  Node: { ID: id, StableID: `n${host.toUpperCase()}` as TailnetNodeId, Name: `${host}.tail.ts.net.`, User: id * 1000 },
  UserProfile: { ID: id * 1000, LoginName: login, DisplayName: display, ProfilePicURL: "" },
  CapMap: {},
});

export const tailnet = {
  alice: person(1, "alice", "alice@example.com", "Alice"),
  bob: person(2, "bob", "bob@example.com", "Bob"),
  node: { Node: { ID: 3, StableID: "nNEXUSNODE" as TailnetNodeId, Name: "nexus-node.tail.ts.net.", Tags: ["tag:nexus-node"] }, CapMap: {} },
} as const satisfies Record<string, WhoisAnswer>;
