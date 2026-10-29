# Serial landings verification

Verified in this task's pylon on 2026-10-29, on branch `fix/serial-landings-precise-holds`, against main at 87d7e0d. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`. The loop takes reviews in the order of their builders' random IDs, so which PR lands first differs between runs, and the README names none, with the commit in `commit.txt`. Both runs use the same two files, so the captures differ only by the code under test. Then it runs the branch's `src/control/review.test.ts` against each run's code, into `tests.txt`.

```sh
docs/verification/serial-landings/run.sh origin/main HEAD
```

`stack.ts` runs the real registry, API, inbox and review loop as `src/control/main.ts` wires them, on plain HTTP at 127.0.0.1:7470 for a deployer. It replays 2026-10-28. The reviews of PRs #189 and #190 were approved, their checks passed, and PR #199 added only docs and test stand-ins, with the same files as the real #199. All three reviews start at the merge step at once. Only what a pylon cannot host is a stand-in:

- GitHub is a fetch handler behind the real `githubClient` (`github.log`).
- The fleet is one node whose control and probe report each desired release installing, then healthy 4 seconds after it became desired. `release.log` records each release the review loop sets and when the fleet reports it healthy.

`drive.mjs` reads each review from the API as it changes, saves `nexus show` of each builder then (`show-<pr>.txt`), and saves the `review.changed` events once all three have ended (`events-review.txt`).

## What was checked

| Step | main | branch |
|---|---|---|
| #199, docs and test stand-ins only | `needs-person`: held for the tailnets, as it changes `docs/verification/fresh-install/standin/tailscale` and `tailnet.ts`. | Lands. |
| Two landings at once | The first review the pass reaches merges and deploys from `aaaa…`. A second merges in the same pass and deploys with the first's merge commit as `previous`, which was never healthy. | One deploys at a time. `nexus show` says what each waits for, such as `waiting while rv-00000199 deploys`. |
| How they end | The first ends `needs-person`: "Another release, …, replaced … before every service reported healthy." The second lands. | All three land. Each records the release before it as `previous`, every one reported healthy in `release.log`. |
| Review tests | `tests.txt`: the three landing tests and the `docs/` path test fail. | `tests.txt`: all pass. |
