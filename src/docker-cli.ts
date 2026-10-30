/** How the Docker test double runs the docker CLI, and the labels it puts on what it creates. */
import { spawn } from "node:child_process";
import { exit, output } from "./exec.ts";

/** `sessions` on a checkpoint is what its pause recorded, as base64url JSON, or empty when it recorded none. */
export const label = { pylon: "nexus.pylon", image: "nexus.image", bootedFrom: "nexus.booted-from", checkpoint: "nexus.checkpoint", sessions: "nexus.sessions", templateBuild: "nexus.template-build" } as const;

const maxBuffer = 64 << 20;

/**
 * Resolves to docker's trimmed stdout, and rejects with `docker <args>: <stderr>`. `input` goes to its stdin. The
 * signal is checked before the call, never passed to the CLI: killing the CLI does not stop the daemon's
 * operation, so the job would end and free its subject while Docker was still stopping or committing.
 */
export async function docker(args: readonly string[], { signal, input }: { signal?: AbortSignal | undefined; input?: string } = {}): Promise<string> {
  signal?.throwIfAborted();
  if (input === undefined) return (await output("docker", args, { maxBuffer })).trim();
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  // A docker exec that exits before reading its input breaks the pipe, which its exit code then explains.
  let broken: Error | undefined;
  child.stdin.on("error", (err) => { broken = err; }).end(input);
  const code = await new Promise<number | null>((resolve, reject) => child.on("error", reject).on("close", resolve));
  if (code !== 0) throw new Error(`docker ${args.join(" ")}: ${stderr.trim() || `exited ${code}`}`);
  if (broken) throw new Error(`docker ${args.join(" ")}: its input broke off: ${broken.message}`);
  return stdout.trim();
}

/** Runs argv in the container as root. A nonzero exit is a result, and a timeout gives a null exit code, as a pylon's exec does. */
export async function dockerExec(container: string, argv: readonly string[], { cwd, timeoutMs }: { cwd?: string; timeoutMs?: number } = {}): Promise<{ exitCode: number | null; output: string }> {
  const { code, stdout, stderr } = await exit("docker", ["exec", ...(cwd === undefined ? [] : ["--workdir", cwd]), container, ...argv], { maxBuffer, ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) });
  return { exitCode: code, output: stdout + stderr };
}
