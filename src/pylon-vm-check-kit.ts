/**
 * What the pylon-vm checks run by hand share: pylon-vm-memory.check.ts, pylon-vm-stop-race.check.ts and
 * pylon-guest.check.ts. Each runs the backend in its own process, over an image directory in an artifact store.
 */
import { basename, dirname } from "node:path";
import type { BootInputs, LiveSpec } from "./spawn.ts";
import type { ImageId, PylonId } from "./ids.ts";
import { createPylonVmBackend, type PylonVmBackendOptions } from "./pylon-vm-backend.ts";

/** The backend over `imageDir`'s artifact store, holding no secrets, and the ID of the image in `imageDir`. */
export function checkBackend(imageDir: string, stateRoot: string, options: Partial<PylonVmBackendOptions> = {}) {
  const backend = createPylonVmBackend({ stateRoot, artifacts: dirname(imageDir), secrets: { value: () => undefined, names: () => [] }, ...options });
  return { backend, image: basename(imageDir) as ImageId };
}

/** A pylon with no previews and no overlay. */
export const emptyLive: LiveSpec = { previews: [], overlay: [] };

/** A pylon with 2 CPUs and an 8 GiB disk that clones a pinned commit of octocat/Hello-World. */
export function checkBoot(pylonId: PylonId, image: ImageId, source: BootInputs["source"], { memoryGiB, allowedHosts = ["github.com"], dotfiles = { repo: "https://github.com/octocat/Spoon-Knife.git", ref: "main" } }: {
  memoryGiB: number;
  allowedHosts?: readonly string[];
  dotfiles?: BootInputs["dotfiles"];
}): BootInputs {
  return {
    pylonId, image, source,
    resources: { cpus: 2, memoryGiB, diskGiB: 8 },
    network: { allowedHosts: [...allowedHosts], secrets: [] },
    repo: { kind: "clone", url: "https://github.com/octocat/Hello-World.git", checkout: { branch: "master", commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d" } },
    dotfiles,
  };
}
