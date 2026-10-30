import { JobFailure } from "./protocol/jobs.ts";
import type { PreviewAssignment } from "./spawn.ts";
import type { ServiceName } from "./services-file.ts";
import type { PylonId } from "./ids.ts";

/**
 * Each previewed service's PUBLIC_URL: the https address `tailscale serve` publishes its assigned port at,
 * on `host`, the node's tailnet DNS name. The guest only ever sees plain HTTP from the gateway (S4), so the
 * address cannot come from the request. A service without a preview gets no PUBLIC_URL.
 */
export function publicUrls(pylonId: PylonId, previews: readonly PreviewAssignment[], host: string | undefined): Record<ServiceName, string> {
  if (previews.length === 0) return {};
  if (host === undefined) throw new JobFailure("invalid", `${pylonId} has previews, and this node has no previewHost to build their PUBLIC_URL from`);
  return Object.fromEntries(previews.map((p) => [p.service, `https://${host}:${p.httpsPort}`]));
}
