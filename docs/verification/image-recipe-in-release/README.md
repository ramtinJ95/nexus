# The image recipe in a release

`run.sh` ran in this thread's pylon on 2026-10-26, at commit 4f545fa, once with main's `deploy/release.sh` (bf84ee5) and once with this branch's. Each run sources the script and calls `install_release` on this checkout into a scratch prefix, with real `npm ci`, `npm run build` and `npm prune`. Only `install` and `chown` are stubbed, because the run is not root. Then `sudo` makes the release root-owned and not writable by others, as a deployer leaves it. As the unprivileged user, the script imports the release's own `src/image-build.ts`, as the control plane does, calls `loadImageRecipe()` with its default directory, and compares the result with the checkout's recipe.

`01-main-release.txt` shows the live failure. The release holds only `agent-setup/manifest.ts` and `nexus-turn.ts` under `images/pylon`, and loading fails on `pins.json` with the ENOENT that `nexus image build` printed on the fleet.

`02-branch-release.txt` shows the release holding all of `images/pylon`. All 13 recipe files load from the read-only release, each byte for byte the checkout's. The recipe is `img-051b22b601e4`, the checkout's ID and the image that `docs/verification/image-rollout` built, so the recipe hash covers the same files as before, and an image recorded from a checkout still answers an unchanged recipe at once.

Not verified: a build on the fleet. Building and rolling out images is the person's to do after the deploy.
