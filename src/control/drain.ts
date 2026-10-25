export class DeployDraining extends Error {
  constructor() { super("control plane is draining for deployment; retry after the release completes"); }
}

/** Shared by human requests and background PR-watch submissions. */
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
