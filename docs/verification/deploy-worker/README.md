# The root deployer's poll

`run.sh` ran in this thread's pylon on 2026-10-29, on Node 26.12.1, against main at 284305f and this branch at afc9887, the last commit that changes code.

`capture.ts` runs each checkout's real worker, `reconcileRole` on main and `reconcileRoles` on the branch, against that checkout's real control-plane API on loopback, through the worker's own `jsonRequest`. The node's services are stand-ins that answer `/v1/health` with the commit they last restarted on, and tailscaled's whois names every caller as the control node. After each deployer request it logs the drain the registry holds. `bootstrap.sh` runs each checkout's `deploy/install-deployer.sh` as root, in a private mount namespace with a tmpfs on `/opt/nexus` and a copy of `/etc`, over a bootstrap that still holds an earlier install's tests. Then it runs the bootstrap's worker as root with no `node_modules`.

| Capture | main | branch |
| --- | --- | --- |
| A control release rolled back at the desired commit, its report file cleared (#228) | Runs `systemctl is-active`, takes a drain lease that blocks starts and sends, reports `installing`, then `rolled-back` | Reports `rolled-back` with the journal's reason, then releases the drain. It holds no lease and runs no command |
| A drain refusal held in the report file alone | Reports `failed` and releases the drain | The same |
| Two idle polls of a machine with both roles | Each poll reads the release view twice and rewrites both report files | The second poll reads the view once and leaves both files untouched. The first reads it again because it writes the files for the first time |
| One poll of a machine with both roles a release behind | Control upgrades, then the probe, in one poll, with four reads of the view | The same |
| `install-deployer.sh` over an old bootstrap (#234) | The bootstrap keeps all seven `src/deploy/*.test.ts` | The bootstrap holds only runtime sources. On both, the worker loads and stops at the network, `ECONNREFUSED 127.0.0.1:9` |

`diff.txt` holds the differences. `tests-main.txt` runs the branch's deploy tests on main's code, where 8 of 47 fail, and `tests-branch.txt` runs them on the branch, where all pass. One of main's 8 fails only because `recover()` now resolves null when no install is unfinished.

```sh
docs/verification/deploy-worker/run.sh            # main is the merge base with origin/main
```

Not checked here: systemd, tailscaled, a real build and restart, and a real node running the bootstrap through `supervise.sh`. The role installers' preparation and manual paths ran only under the stand-ins in `src/deploy/install.test.ts`.
