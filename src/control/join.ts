/**
 * Adding a node with a join token. Root on the control plane's machine mints one (join-token.ts), and the new machine's
 * installer sends it to `POST /v1/join` with its deployer's key digest. The node is what tailscaled's whois says the
 * caller is, never what the request says, so a token admits the machine that sends it and no other.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { nodeNameSchema, type TailnetNodeId } from "../protocol.ts";
import { digestPattern } from "../deploy/model.ts";
import { HttpError } from "./http-error.ts";
import type { JoinedNode, Registry } from "./registry.ts";

export const joinTokenTtlMs = 60 * 60_000;
/** Not strict, so a name or node ID in the body is dropped rather than read. */
export const joinRequestSchema = z.object({ token: z.string().min(1).max(256), deployKey: z.string().regex(digestPattern, "must be the 64 lower-case hex characters of the deployer token's sha256") });

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const mint = "Mint another with sudo deploy/install.sh --join-token on the control plane's machine";

export function mintJoinToken(registry: Registry, now = Date.now()): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + joinTokenTtlMs;
  registry.addJoinToken(hashOf(token), expiresAt);
  return { token, expiresAt };
}

/**
 * Records the caller as a node, or refuses with nothing recorded. `admitted` is the control plane's machine and every
 * caller, which must stay a person or the control plane, so none of them may become a node. `configured` is the nodes
 * control.json names, which keep their keys there, even one that joined before it was added. A joined node may join
 * again with another token, which replaces its deploy key.
 */
export function joinNode(registry: Registry, admitted: ReadonlySet<TailnetNodeId>, configured: ReadonlySet<TailnetNodeId>, caller: { id: TailnetNodeId; host: string }, request: z.infer<typeof joinRequestSchema>, now = Date.now()): JoinedNode {
  const hash = hashOf(request.token);
  const token = registry.joinToken(hash);
  if (token === undefined) throw new HttpError(403, `this join token is not one this control plane minted. ${mint}`);
  if (token.usedAt !== null) throw new HttpError(403, `this join token was used at ${new Date(token.usedAt).toISOString()}, and each joins one node. ${mint}`);
  if (token.expiresAt <= now) throw new HttpError(403, `this join token expired at ${new Date(token.expiresAt).toISOString()}. ${mint}`);

  if (admitted.has(caller.id)) throw new HttpError(409, `${caller.host} is the control plane's machine or a caller in control.json, which never joins as a node`);
  if (configured.has(caller.id)) throw new HttpError(409, `${caller.host} is a node in control.json, which sets its deploy key`);
  const name = nodeNameSchema.safeParse(caller.host.split(".")[0]);
  if (!name.success) throw new HttpError(409, `tailscale names this machine ${caller.host}, whose first label is not a node name: ${name.error.issues[0]!.message}`);
  const named = registry.node(name.data);
  if (named !== undefined && named.tailnetNodeId !== caller.id) throw new HttpError(409, `a node named ${name.data} is already tailnet node ${named.tailnetNodeId}. Rename this machine in tailscale`);
  const same = registry.nodes().find((n) => n.tailnetNodeId === caller.id);
  if (same !== undefined && same.name !== name.data) throw new HttpError(409, `this machine is already the node ${same.name}, and tailscale now names it ${name.data}`);

  const node = { name: name.data, tailnetHost: caller.host, tailnetNodeId: caller.id, deployKey: request.deployKey };
  if (!registry.joinNode(hash, node, now)) throw new HttpError(403, `this join token was used or expired meanwhile. ${mint}`);
  return { ...node, joinedAt: now };
}
