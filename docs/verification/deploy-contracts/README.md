# One copy of each deploy contract

`run.sh` ran in this thread's pylon on 2026-10-30, on Node 26.12.1, against main at b636ea9 and this branch at 934ab03, the last commit that changes code.

`capture.ts` runs each checkout's real control-plane API on loopback. The deployer's own `jsonRequest` posts the control node's healthy reports for both roles. Then the checkout's real `nexus deploy main --wait` runs with its `Date.now` 120 seconds ahead of the control plane's, as a Mac's clock can be. Only tailscaled's whois is a stand-in. The capture stops a wait that has not ended after 20 seconds.

| Capture | main | branch |
| --- | --- | --- |
| `nexus deploy main --wait` from a clock 120 s ahead, both roles healthy and fresh by the control plane's clock (#227) | Still waiting when stopped after 20 s. It would run to its 30-minute timeout | Exits 0 at once with both roles healthy |

`diff.txt` holds the difference. `tests-main.txt` runs the branch's tests of the changed contracts on main's code, and `tests-branch.txt` runs them on the branch, where all 265 pass. On main, four test files fail to load because main lacks `DeployHttpError`, `harnessSignedIn`, `reportStates` and the model.ts exports that main.test.ts imports. Three of the four `saveJson` tests, the control installer test and the wait outcome test fail on their assertions. The fourth, that a failed save leaves no temp file, passes on main, whose saves share one temp name.

```sh
docs/verification/deploy-contracts/run.sh            # main is the merge base with origin/main
```

Not checked here: a real control plane refusing a join with more than 1000 characters, which no refusal it sends today reaches. `src/deploy/http.test.ts` drives that through `joinControlPlane` against a local server. A node's worker with a clock ahead of the control machine's ran only in `src/deploy/worker.test.ts`. `install-control.sh` ran its `signed-in` check only under the stand-ins of `src/deploy/install.test.ts`, never with systemd.
