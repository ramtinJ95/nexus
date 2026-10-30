import type { Drain } from "../deploy/model.ts";

export class DeployDraining extends Error {
  constructor() { super("control plane is draining for deployment; retry after the release completes"); }
}

export const isDraining = (drain: Drain | null) => drain?.locked === true || (drain?.expiresAt ?? 0) > Date.now();

/**
 * One per control plane, shared by the API's turn-starting routes, the harness methods main wraps and the queue's
 * starts, so a deploy's drain refuses them all and `busy` counts every turn still entering.
 */
export type TurnGate = ReturnType<typeof turnGate>;
export function turnGate(draining: () => boolean) {
  let entering = 0;
  return {
    busy: () => entering > 0,
    async run<T>(action: () => Promise<T>): Promise<T> {
      if (draining()) throw new DeployDraining();
      entering++;
      try { return await action(); }
      finally { entering--; }
    },
  };
}
