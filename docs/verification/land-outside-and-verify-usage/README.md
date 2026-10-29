# Land outside and verify usage verification

Verified in this thread's pylon on 2026-10-29, on branch `simplify/w1-review-roles-land` against main at `c5168d6`. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

```sh
docs/verification/land-outside-and-verify-usage/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` into each, builds the dashboard and runs it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same file, so the captures differ only by the code under test.

## The stack

`stack.ts` runs the real registry, API, dashboard, inbox and review loop as `src/control/main.ts` wires them, on plain HTTP at 127.0.0.1:7471 for a deployer, and drives them with the checkout's own `nexus` CLI. Three reviews stopped at approval, with no landing asked for. The PR watch last read #301 as closed, #302 as merged at the approved head, and #303 as open. A thread started by the review loop's verify caller, `nexus-verify`, has one recorded model call. Only what a pylon cannot host is a stand-in: GitHub is a fetch handler behind the real `githubClient` that agrees with the PR watch, the check passes at once, and the one node reports each desired release healthy at once.

The run reads each builder's dashboard page (`dashboard.txt`), runs `nexus land` on each builder (`cli-land.txt`), polls the review loop six times (`timeline.txt`), then runs `nexus show` on each (`cli-show.txt`) and `nexus usage --since all --by role` (`cli-usage.txt`).

## What was checked

| Step | main | branch |
|---|---|---|
| The dashboard, `dashboard.txt` | No Land for #301 or #302, Land for #303 | The same |
| `nexus land` on #301, closed outside its review | Exit 0, `Landing review rv-00000301`. The next pass ends it `closed` | Exit 5: `pull request #301 is closed on GitHub outside this review, so there is nothing to land`. It stays `approved` |
| `nexus land` on #302, merged outside its review | Exit 0. The landing checks, reads the merge at the approved head, and deploys the merge commit: `landed as 302c…`, with `release.log`'s desired release set to it | Exit 5: `pull request #302 is merged on GitHub outside this review, so there is nothing to land`. It stays `approved`, and nothing is deployed |
| `nexus land` on #303, open | Lands | Lands |
| `nexus usage --by role` | The verify thread's call is under `other` | Under `verify` |
