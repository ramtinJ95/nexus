/**
 * Probe contract, probe-to-probe artifact copies. GET /v1/artifacts/{id} answers with the manifest in a header and the
 * archive as the body.
 *
 * The wire encoding is private to this module. The probe answers through `artifactHeaders`, and reads through
 * `fetchArtifact` and `parseArtifactManifest`.
 */
import { request } from "node:http";
import type { Readable } from "node:stream";
import { z } from "zod";
import { PeerRefused, verifyPeer, type Whois } from "../tailscale.ts";
import type { ArtifactManifest, ImageManifest, ImageRecipe, TemplateManifest } from "../images.ts";
import { asSent, named, nonEmpty, parse } from "../parse.ts";
import { isImageId, isTemplateId, type NodeName, type PortableArtifactId, type ProjectId, type TailnetNodeId } from "../ids.ts";
import { imageId, objectAs, sha256, templateId } from "./fields.ts";
import { probeError, ProbeHttpError, text } from "./http.ts";

const manifestHeader = "x-nexus-manifest";
/** A copy that sends nothing for this long has broken off. tar can be slow to start on a large sparse file. */
const artifactIdleMs = 60_000;

/** The probe's side of GET /v1/artifacts/{id}: the headers ahead of the archive. */
export function artifactHeaders(manifest: ArtifactManifest): Record<string, string> {
  return { "content-type": "application/octet-stream", [manifestHeader]: Buffer.from(JSON.stringify(manifest)).toString("base64url") };
}

/** A peer's copy of an artifact, or why the peer refused it: it holds another sha256 under that ID. */
export type ArtifactCopy = { manifest: ArtifactManifest; stream: Readable } | { refused: string };

/**
 * fetch-artifact's side: GET /v1/artifacts/{id}?sha256= from a peer probe, which whois must name as one of
 * `peers`. A peer that holds other bytes under the ID refuses before it sends any. The stream is unverified:
 * ArtifactStore.import checks it against the manifest's sha256 before anything uses it.
 */
export function fetchArtifact(peer: { host: string; port: number }, artifact: PortableArtifactId, sha256: string, check: { whois: Whois; peers: readonly TailnetNodeId[] }, signal: AbortSignal): Promise<ArtifactCopy> {
  const path = `/v1/artifacts/${encodeURIComponent(artifact)}?sha256=${encodeURIComponent(sha256)}`;
  const where = `${peer.host}:${peer.port}`;
  return new Promise((resolve, reject) => {
    const req = request({ host: peer.host, port: peer.port, method: "GET", path, agent: false, timeout: artifactIdleMs, signal }, (res) => {
      verifyPeer(res.socket, check.whois, (id) => check.peers.includes(id)).then(() => {
        if (res.statusCode === 409) return text(res).then((refused) => resolve({ refused }), reject);
        if (res.statusCode !== 200) return text(res).then((body) => reject(new ProbeHttpError(`${where}: GET ${path}: HTTP ${res.statusCode}: ${body}`, res.statusCode ?? 0)), reject);
        let manifest: ArtifactManifest;
        try {
          manifest = parseArtifactManifest(JSON.parse(Buffer.from(String(res.headers[manifestHeader]), "base64url").toString("utf8")));
        } catch (err) {
          res.destroy();
          return reject(new Error(`${where}: GET ${path} sent no readable manifest: ${(err as Error).message}`));
        }
        resolve({ manifest, stream: res });
      }, (err: Error) => {
        res.destroy();
        if (!(err instanceof PeerRefused)) return reject(err);
        reject(err.peer === null ? probeError("unreachable", `${where}: the connection closed before whois`) : probeError("forbidden", `${where} is tailnet node ${err.peer.id ?? "unknown"}, which is not a configured peer`));
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${where} sent nothing for ${artifactIdleMs} ms`)));
    req.on("error", (err) => reject(signal.aborted ? err : probeError("unreachable", `${where}: ${err.message}`)));
    req.end();
  });
}

const imageManifestSchema = z.looseObject({
  id: imageId, gondolinBuildId: nonEmpty, pins: objectAs<ImageRecipe["pins"]>(), builtOn: named<NodeName>(), builtAt: nonEmpty, sha256,
}) satisfies z.ZodType<ImageManifest>;
const templateManifestSchema = z.looseObject({
  id: templateId, key: z.looseObject({ project: named<ProjectId>(), image: imageId, setupHash: nonEmpty }), commit: nonEmpty, builtAt: nonEmpty, sha256,
}) satisfies z.ZodType<TemplateManifest>;

/** A manifest from a peer's header or from an artifact directory. */
export function parseArtifactManifest(value: unknown): ArtifactManifest {
  const { id } = parse(z.looseObject({ id: nonEmpty }), value, "manifest");
  if (isImageId(id)) return parse(asSent(imageManifestSchema), value, "manifest");
  if (isTemplateId(id)) return parse(asSent(templateManifestSchema), value, "manifest");
  throw new Error(`manifest.id: ${id} is neither an image nor a template ID`);
}
