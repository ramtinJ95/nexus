/**
 * Hands the harness's ChatGPT token to every probe: the access token of the harness's own Sign in with ChatGPT, which
 * a pylon granted chatgptTokenGrant reaches api.openai.com with through its placeholder, so it never enters a pylon.
 * Every poll puts the current token to every probe. That is idempotent, so a pylon that booted while the token was
 * refreshed has the current one by the next poll. A probe that has none, as one that just started, sets a poll off.
 */
import { chatgptTokenGrant } from "../project.ts";
import type { NodeObservation, ProbeClient } from "../protocol.ts";

export function chatgptTokenHandoff(options: { probes: readonly Pick<ProbeClient, "node" | "putSecret">[]; token(): Promise<string | undefined>; log?: (message: string) => void }) {
  const { probes, token, log = (message: string) => console.error(message) } = options;
  let running: Promise<void> | null = null;
  /** A probe without the token showed up while a poll ran, which may have failed to reach it before it restarted. */
  let again = false;
  async function tick() {
    let value: string | undefined;
    try {
      value = await token();
    } catch (err) {
      log(`the harness's ChatGPT token could not be read: ${(err as Error).message}`);
      return;
    }
    if (value === undefined) return;
    await Promise.all(probes.map(async (probe) => {
      try {
        await probe.putSecret(chatgptTokenGrant.name, value);
      } catch (err) {
        log(`handing ${chatgptTokenGrant.name} to ${probe.node} failed: ${(err as Error).message}`);
      }
    }));
  }
  function poll(): Promise<void> {
    running ??= (async () => {
      do {
        again = false;
        await tick();
      } while (again);
    })().finally(() => { running = null; });
    return running;
  }
  return {
    async close() { await running; },
    poll,
    observed(o: Pick<NodeObservation, "grants" | "heldSecrets">) {
      if (!o.heldSecrets?.includes(chatgptTokenGrant.name) || o.grants?.secrets.includes(chatgptTokenGrant.name)) return;
      if (running !== null) again = true;
      else void poll();
    },
  };
}
