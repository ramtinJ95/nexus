# One schema per ID ([#129](https://github.com/ramtinJ95/nexus/issues/129))

`run.sh <ref>` checks out `<ref>` in a temporary worktree and runs three things from it:

- The probe's entry point, `node src/probe/main.ts probe.json`, and the control plane's, `node src/control/main.ts control.json`, once for each of four node names: `rj-firebat`, 63 characters, 64 characters and `auto`. `control.json` is `deploy/control.example.json` with the name swapped in. `probe.json` names the same node and a Docker backend. The script prints each exit code and the line that says why the process stopped.
- `garbage.ts`, which calls that checkout's `garbage()` on an artifact store holding a current image, an old image, an unknown template, a checkpoint and five malformed directory names. For each name `garbage()` drops, it hands the drop-artifact job to that checkout's `parseJobEnvelope`, which is how the probe reads a job.
- This branch's two regression tests, copied over that checkout's code.

`main.log` is `run.sh origin/main` at 137242d. `branch.log` is `run.sh fix/issue-129-one-id-schemas` at the fix commit. Both ran in this thread's pylon on 2026-10-27, on Node 24.22.1. The repository asks for Node 26, but Node 26's binary needs `libatomic.so.1`, which the pylon image lacks. `desktop-app` ran on Node 24 for the same reason.

Neither process starts fully in the pylon. The probe stops at `listen EADDRNOTAVAIL`, because the pylon has no tailnet address. The control plane stops at `the harness is not signed in to openai`. Both happen after the config has parsed, so either line means the config was accepted.

What the logs show:

- On main, the probe takes all four names. The control plane takes `rj-firebat` and the 63-character name, and refuses the 64-character name and `auto`. A probe can therefore be configured as a node the control plane can never list.
- On the branch, both processes take the first two names and refuse the last two with the same message, such as `must be a lowercase tailnet machine name of at most 63 characters` at `node` and at `nodes[0].name`.
- On main, `garbage()` drops all five malformed names, and the probe refuses each of those drop jobs with `job.artifact is not an image or template ID`. On the branch, `garbage()` keeps them, so it never emits a job the probe refuses. The valid old image and unknown template are dropped on both, and the current image and the checkpoint are kept on both.
- The regression tests fail on main's code and pass on the branch.

Nothing in production calls `garbage()` yet, and the probe's `ArtifactStore.list()` already skips any directory name `isPortableArtifactId` refuses. So no deployed node has hit the malformed-name case. The change makes `garbage()` agree with the store that feeds it and the job parser that reads its output.

Rerun it from the repository root after `npm ci`:

```sh
docs/verification/one-id-schemas/run.sh origin/main
docs/verification/one-id-schemas/run.sh fix/issue-129-one-id-schemas
```
