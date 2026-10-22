# pylon-vm: a hard fork of pi-sandbox

This directory is a fork of pi-sandbox, MIT-licensed, by Igor Warzocha. Its licence is in [LICENSE](LICENSE).

- Upstream repository: https://github.com/IgorWarzocha/howaboua-pi-stuff
- Path: `packages/pi-sandbox/src`
- Commit: `187a70d621ccc99b119166e55fcd568e5b4f605e`

Nexus owns this code and does not track upstream. pi-sandbox stays the reference to compare designs against. The pi extension entry (`index.ts`) and the changelog tool (`changelog.ts`) were not copied.

Nexus calls it only through `run` in `client.ts`, from `src/pylon-vm-backend.ts`. Changes from upstream:

- The controller is started from `daemon.ts` with Node's type stripping, so there is no `dist/` build.
- `run` takes the state root as an argument instead of reading `PI_SANDBOX_HOME`.
- `create` and `prepare` take a typed config object, not a YAML path. The YAML config loader is gone. The guest's `.sandbox.yaml` services file is still read with `yaml`.
- `create` builds a new instance in a hidden staging directory and renames it into place, so a crash never leaves an instance directory without its record and intent.
- `destroy` renames the instance to a hidden tombstone before removing it, also sweeps a leftover staging directory, and succeeds when the instance is absent. `list` skips hidden directories, removes tombstones a dead destroy left behind, and drops an instance destroyed while it was listing.
- `stop` treats a failure anywhere before its checkpoint completes like a failed checkpoint: the VM is shut down and the instance is `interrupted`, instead of a controller left in `stopping`.
- Records carry `labels`, which `inspect` and `list` return, and the status carries `bootedAt`.
- The hooks that ran `.agents/setup` and `.agents/resume` as root from the workspace are gone.
- The pi extension's help text and input helpers in `contracts.ts` are gone.
