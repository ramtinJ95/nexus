import { spawn } from "node:child_process";

/** The image's copy of src/checkout-files.py, which the control plane reads the snapshot back with. */
export const checkoutHelper = "/usr/local/lib/nexus/checkout-files.py";

/** The control plane expects this ID for the latest session.turn-started it recorded, so the hook stamps both with `at`. */
export const claudeTurn = (session: string, at: number): string => `claude:${session}:${at}`;

/**
 * Snapshots the checkout into refs/nexus/turn before Claude acts on the prompt. Claude kills a hook after two seconds,
 * and a snapshot finishing after that could include Claude's first edits, so the helper is killed sooner. A killed or
 * failed snapshot leaves no snapshot under this turn's ID, which reads refuse.
 */
export function snapshotTurn(checkout: string, turn: string, deadlineMs = 1_500, helper = checkoutHelper): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("python3", [helper, checkout, "snapshot", turn], { stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), deadlineMs);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}
