/** What a start asks for, and the key it is stored under, which the thread starter, the queue and the pipeline share. */
import type { NodeName, ThreadId } from "../ids.ts";
import type { BootInputs } from "../protocol/spawn.ts";
import type { Role } from "./agent-protocol.ts";

/**
 * What starts a thread. `claude` makes it a Claude worker with that first prompt. `node` names a node, or is `auto`
 * for the one where the pylon fits best. `near` is a node to place the pylon on while it has room, which only the
 * control plane asks for, and with `ifRoom` a start no node has room for is refused rather than placed on `near` all
 * the same. `resources` overrides the project's size field by field.
 */
export interface StartRequest {
  project: string; title: string; node?: string | undefined; branch?: string | undefined; commit?: string | undefined; claude?: string | undefined; model?: string | undefined;
  near?: NodeName | undefined; ifRoom?: true; resources?: { [K in keyof BootInputs["resources"]]?: BootInputs["resources"][K] | undefined } | undefined;
}

/** A start's request ID and a hash of the body it came with, stored with the thread or queued record the start made. */
export interface StartKey { requestId: string; body: string }

/**
 * A start: the request, who asks, and the role the thread takes. A reviewer's Claude prompt goes as written, where any
 * other gets `/poteto-mode` in front. A check or verify thread has no agent, since it needs only its pylon. Only a
 * builder gets the project's standing rules. `queued` is the queued record the start starts, which gives the thread its
 * ID, `id` an ID the caller recorded the thread by before it started, and `key` is stored with the thread.
 */
export interface Start { request: StartRequest; caller: string; role: Role; queued?: ThreadId | undefined; id?: ThreadId | undefined; key?: StartKey | undefined }
