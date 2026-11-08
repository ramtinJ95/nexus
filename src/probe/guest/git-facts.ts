import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Guest } from "../../backends/backend.ts";
import { parseJson } from "../../parse.ts";
import type { GitFacts } from "../../protocol/observations.ts";
import { checkoutDir } from "../../../images/pylon/nexus-contract.ts";
import { execOutputMaxBytes } from "../../guest-contract.ts";

let helper: string | undefined;
/** The helper refuses a longer reply, so its reply, with the newline print adds, fits a guest exec untruncated. */
const replyLimitBytes = execOutputMaxBytes - 4 * 1024;
const hash = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const schema = z.strictObject({
  head: hash,
  branch: z.string().min(1).nullable(),
  dirty: z.boolean(),
  branches: z.array(z.strictObject({ name: z.string().min(1), head: hash, pushedAs: z.string().min(1).nullable() })).max(1000),
});

/**
 * One local read, with no fetch or index refresh. Ref and reply limits fail whole, never report a partial list.
 * The guest timeout bounds the process, not its controller RPC; the probe separately bounds and tracks that wait.
 */
export async function gitFacts(guest: Guest): Promise<GitFacts> {
  helper ??= readFileSync(new URL("./git-facts.py", import.meta.url), "utf8");
  const read = await guest.exec(["python3", "-c", helper, String(replyLimitBytes)], { cwd: checkoutDir, timeoutMs: 3000 });
  if (read.exitCode !== 0 || read.truncated || Buffer.byteLength(read.output) > replyLimitBytes + 1) throw new Error("checkout git facts could not be read within their limits");
  return parseJson(schema, read.output, "checkout git facts");
}
