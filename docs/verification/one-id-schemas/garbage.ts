/**
 * node garbage.ts <checkout>: what that checkout's garbage() makes of an artifact store holding malformed
 * directory names, and whether its probe takes the drop-artifact job that each dropped name becomes.
 */
import { pathToFileURL } from "node:url";

const checkout = process.argv[2]!;
const { garbage } = await import(pathToFileURL(`${checkout}/src/images.ts`).href);
const { parseJobEnvelope } = await import(pathToFileURL(`${checkout}/src/protocol.ts`).href);

const current = "img-0123456789ab";
const held = [current, "img-00000000aaaa", "tpl-00000000bbbb", "ckpt-pylon-t1-1", "img-Old.partial", "img-", "tpl-..", "tpl-UPPER", `img-${"0".repeat(41)}`];
const dropped: string[] = garbage(held, [], { imageBuildNode: "verify-node", current }, Date.now());

function dropJob(artifact: string): string {
  const issuedAt = new Date().toISOString();
  const envelope = { jobId: "j1", node: "verify-node", issuedAt, notAfter: issuedAt, job: { kind: "drop-artifact", artifact } };
  try {
    parseJobEnvelope(JSON.stringify(envelope));
    return "the probe takes its drop job";
  } catch (err) {
    return `the probe refuses its drop job: ${(err as Error).message}`;
  }
}

for (const id of held) {
  console.log(`${JSON.stringify(id).padEnd(50)} ${dropped.includes(id) ? `dropped, and ${dropJob(id)}` : "kept"}`);
}
