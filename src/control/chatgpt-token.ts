/**
 * Hands the harness's ChatGPT token to every probe: the access token of the harness's own Sign in with ChatGPT, which
 * a pylon granted chatgptTokenGrant reaches api.openai.com with through its placeholder, so it never enters a pylon.
 * Every poll puts the current token to every probe. That is idempotent, so a pylon that booted while the token was
 * refreshed has the current one by the next poll. A probe that has none, as one that just started, sets a poll off.
 */
import { chatgptTokenGrant } from "../project.ts";
import type { NodeObservation, ProbeClient } from "../protocol.ts";
import { singleFlight } from "../single-flight.ts";

export function chatgptTokenHandoff(options: { probes(): readonly Pick<ProbeClient, "node" | "putSecret">[]; token(): Promise<string | undefined>; log?: (message: string) => void }) {
  const { probes, token, log = (message: string) => console.error(message) } = options;
  async function tick() {
    let value: string | undefined;
    try {
      value = await token();
    } catch (err) {
      log(`the harness's ChatGPT token could not be read: ${(err as Error).message}`);
      return;
    }
    if (value === undefined) return;
    await Promise.all(probes().map(async (probe) => {
      try {
        await probe.putSecret(chatgptTokenGrant.name, value);
      } catch (err) {
        log(`handing ${chatgptTokenGrant.name} to ${probe.node} failed: ${(err as Error).message}`);
      }
    }));
  }
  const ticks = singleFlight(tick);
  return {
    close: ticks.settled,
    poll: ticks.join,
    /** A probe without the token showed up, which a poll in flight may have failed to reach before it restarted. */
    observed(o: Pick<NodeObservation, "grants" | "heldSecrets">) {
      if (!o.heldSecrets.includes(chatgptTokenGrant.name) || o.grants.secrets.includes(chatgptTokenGrant.name)) return;
      void ticks.rerun();
    },
  };
}
