/**
 * Runs the nexus CLI once for each line of `{ args }` JSON on stdin, in this one process, and answers each on fd 3 with
 * `{ code, stdout, stderr }`. src/cli/nexus.ts runs `main` on process.argv when it is evaluated, so each run imports it
 * again under a new query, which evaluates it alone: the modules it imports load once, which a process per command
 * would pay for each time. golden.test.ts starts it with frozen.ts preloaded. A command that reads stdin runs as a
 * process of its own instead.
 */
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const cli = new URL("../cli/nexus.ts", import.meta.url);
const answers = createWriteStream("", { fd: 3 });
const writes = { stdout: process.stdout.write, stderr: process.stderr.write };

let run = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const { args } = JSON.parse(line) as { args: string[] };
  const out = { stdout: "", stderr: "" };
  process.argv = [process.argv[0]!, fileURLToPath(cli), ...args];
  process.exitCode = 0;
  process.stdout.write = ((chunk: string) => { out.stdout += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { out.stderr += chunk; return true; }) as typeof process.stderr.write;
  let code: number;
  try {
    await import(`${cli.href}?run=${run++}`);
    code = Number(process.exitCode ?? 0);
  } catch (err) {
    out.stderr += `${(err as Error).stack ?? err}\n`;
    code = 1;
  } finally {
    process.stdout.write = writes.stdout;
    process.stderr.write = writes.stderr;
  }
  process.exitCode = 0;
  answers.write(`${JSON.stringify({ code, ...out })}\n`);
}
