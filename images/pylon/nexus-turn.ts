import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The image's copy of src/checkout-files.py, which the control plane reads the snapshot back with. */
export const checkoutHelper = "/usr/local/lib/nexus/checkout-files.py";

/** The control plane expects this ID for the latest session.turn-started it recorded, so the hook stamps both with `at`. */
export const claudeTurn = (session: string, at: number): string => `claude:${session}:${at}`;

/**
 * Snapshots the checkout into refs/nexus/turn before Claude acts on the prompt. Claude kills a hook after two seconds,
 * and a capture finishing after that could include Claude's first edits, so the helper's process group, git and any
 * filter it runs included, is killed sooner. Once the helper says it captured, the hook lets it update the ref, since a
 * ref update killed midway leaves a lock that fails every later snapshot. A killed or failed snapshot leaves no snapshot
 * under this turn's ID, which reads refuse. The helper's temporary index goes in a directory removed whichever way it ends.
 */
export async function snapshotTurn(checkout: string, turn: string, deadlineMs = 1_500, helper = checkoutHelper): Promise<boolean> {
  const scratch = await mkdtemp(join(tmpdir(), "nexus-turn-"));
  try {
    return await new Promise((resolve) => {
      const child = spawn("python3", [helper, checkout, "snapshot", turn, "handshake"], { stdio: ["pipe", "pipe", "ignore"], detached: true, env: { ...process.env, TMPDIR: scratch } });
      let output = "";
      let captured = false;
      const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, deadlineMs);
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (!captured && output.startsWith("captured\n")) {
          captured = true;
          clearTimeout(timer);
          child.stdin.end("go\n");
        }
      });
      child.on("error", () => { clearTimeout(timer); resolve(false); });
      child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 && captured); });
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
