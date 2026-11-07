/** What a start asks for, and the key it is stored under, which the thread starter, the queue and the pipeline share. */
import type { NodeName } from "../ids.ts";
import type { BootInputs } from "../protocol/spawn.ts";

/**
 * What starts a thread. `claude` makes it a Claude worker with that first prompt, which gets `/poteto-mode` in front
 * unless `raw`, as for the review loop's reviewers. A `bare` thread has neither agent, as a check thread needs only
 * its pylon. Only the control plane itself asks for `raw` or `bare`. `node` names a node, or is `auto` for the one
 * where the pylon fits best. `near` is a node to place the pylon on while it has room, which only the control plane asks
 * for, and with `ifRoom` a start no node has room for is refused rather than placed on `near` all the same.
 * `resources` overrides the project's size field by field. `planning` marks a planning thread, which gets no standing
 * rules.
 */
export interface StartRequest {
  project: string; title: string; node?: string | undefined; branch?: string | undefined; commit?: string | undefined; claude?: string | undefined; model?: string | undefined; raw?: boolean; bare?: boolean;
  planning?: true | undefined;
  near?: NodeName | undefined; ifRoom?: true; resources?: { [K in keyof BootInputs["resources"]]?: BootInputs["resources"][K] | undefined } | undefined;
}

/** A start's request ID and a hash of the body it came with, stored with the thread or queued record the start made. */
export interface StartKey { requestId: string; body: string }
