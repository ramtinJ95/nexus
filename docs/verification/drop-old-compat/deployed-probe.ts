/**
 * Parses each stream request URL the branch's control plane sent in capture.ts with the probe parser of the given
 * checkout, the release every node runs, as its server does before it upgrades the connection.
 *
 *   node docs/verification/drop-old-compat/deployed-probe.ts <deployed checkout> <stream-url-file>
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2]!);
const { parseStreamRequest } = await import(join(root, "src/protocol.ts"));
for (const url of (await readFile(process.argv[3]!, "utf8")).split("\n").filter(Boolean)) {
  console.log(`${decodeURIComponent(url)}\n  ${JSON.stringify(parseStreamRequest("nexus-stream", new URL(url, "http://probe")))}`);
}
