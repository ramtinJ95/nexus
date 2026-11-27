# The review's repro scripts

An adversarial review of the multiplayer design wrote these scripts on 2026-11-25 and 2026-11-26. Each one proves a problem by a run against `main` at `0f7834d6`. [The multiplayer plan](../docs/multiplayer-plan.md) cites them.

They are throwaway. `npm test` and `npm run typecheck` do not cover this folder. A slice that cites a test moves it into `src/`, beside the code it tests, and deletes it here. The pilot deletes whatever is left.

## Tests

Run one with `node --test interrogate/<file>` from the repository root.

Some tests fail today and pass when their slice is done. Others pass today, because they assert the fault. The slice turns such a test round.

| File | Today | Slice | What it shows |
|---|---|---|---|
| `review-mode-label-write.test.ts` | passes, asserts the fault | none | The label write uses the control plane's token. The review dropped this as harmless. |

## Scripts

- `whois-shape.ts` and `tailnet-users.mjs` print what this machine's tailscaled says about its peers, without names.
- `gondolin-git-push.mjs`, `gondolin-guard-sees-body.mjs`, and `gondolin-http-limits.mjs` measure Gondolin's HTTP path without a VM.
- `gondolin-facts.py` prints public facts about the Gondolin package.

## The guard prototype

`guard-github/` holds the prototype behind `mp-15`. `guard.mjs` has both guard shapes, `probes.mjs` has the 77 probes, and `table.md` has the results. `mp-25` added seven probes of downloads from `github.com`, which the prototype never ran.

`guard-github/run.sh` reruns it against a private scratch repository, which `seed.sh` names. Before you run it, know that the `off` mode merges about 14 pull requests in that repository.

`mp-15` built the guard in `src/pylon-vm/github-guard.ts`, and `src/pylon-vm/github-guard.test.ts` holds the 84 probes as recorded requests. `probes.mjs` also reruns the list from inside a real pylon behind the built guard. Run it from the owner's device, with the owner's thread on the scratch project and a `gh` login there that may administer the scratch repository:

```sh
export SCRATCH_REPO=<owner>/<scratch> NEXUS_THREAD=<thread>
WANT=14 interrogate/guard-github/seed.sh
gh auth token | PYLON_LOG_CMD="ssh <node> sudo cat /var/lib/nexus/pylons/instances/pylon-$NEXUS_THREAD/controller.log" node interrogate/guard-github/probes.mjs | tee guard-pylon.txt
```

Each probe prints `[ok]`, `[SLIPPED]` or `[BROKEN]`, the guard's refusals that the pylon's log gained, and any slip the runner saw on GitHub.

## The VM rigs

`vm/` holds two rigs that boot real Gondolin VMs. Both need `/dev/kvm`.

- `vm/run.sh <script.mjs>` runs one script in a container that has QEMU. It builds the container image from `vm/Dockerfile` when the image is missing. The `.mjs` scripts cover pushes over HTTPS, uploads, Docker inside the guest, and download cost. The second plan, for CI jobs on Nexus, starts from them.
- `vm/kit.ts` drives Nexus's own `src/pylon-vm/` with QEMU on the host. `vm/step4-crash.ts` shows that a killed controller leaves its QEMU running. It needs `/tmp/nx-a1f` to be a symbolic link to a directory with mode 700.

Both rigs write caches and outputs into this folder. `.gitignore` here keeps them out of git.
