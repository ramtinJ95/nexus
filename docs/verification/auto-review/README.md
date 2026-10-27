# Reviews that start on their own and finish what they start

Verified in this task's pylon on 2026-10-27, on branch `feat/auto-review-and-rebase`, against main at 918e471, with headless Chromium 138. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same two files, so the captures differ only by the code under test.

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023/lib> FONTCONFIG_PATH=/tmp/fonts \
  docs/verification/auto-review/run.sh origin/main HEAD
```

`stack.ts` runs the real registry, API, dashboard, PR watch, inbox and review loop, wired as `src/control/main.ts` wires them, with the real `githubClient`. The API listens on 127.0.0.1:7470 for `nLAPTOP`, a deployer, and on 7471 for `nPHONE`, who is not one. Docker is not available in this pylon, so the verify-nexus stack could not run. What a pylon would host is a stand-in, as the stack's header says. GitHub is a fetch handler that keeps the PRs. Builders are Claude workers with no Claude Code: each pushes the branch its prompt names, and on a `CONFLICT` finding pushes a rebased head and answers it fixed. Reviewers are harness threads in the test's fake harness that approve every head. `.nexus/check` passes after a second, and the node reports each desired release healthy. The PR watch polls every 2 s and the loop every second, instead of every 2 minutes and 15 s.

`drive.mjs` uses only the Mac CLI and the dashboard, the same steps on both runs:

1. `project edit nexus --auto-review land` as the deployer, and `project edit nexus-manual --auto-review land` as `nPHONE`.
2. Three builders push: "Greet by name" in `nexus`, "Greet loudly" in `nexus`, whose branch conflicts with main, and "Greet in French" in `nexus-manual`. No one runs `nexus review`.
3. "Greet quietly", in `nexus-manual`, pushes a branch that conflicts with main, and the person runs `nexus review <thread> --land` by hand.
4. Two builders in `nexus-manual` push changes under `images/`, which the merge policy holds for the person, and the person runs `nexus review --land` on each. Once both are held, the person closes the first PR on GitHub and archives the second builder.

## What was checked

| Step | main | branch |
|---|---|---|
| `02-auto-review-land.txt` | exit 64, no `--auto-review` | exit 0: `Updated project nexus, auto review and land, for nLAPTOP` |
| `03-auto-review-land-not-deployer.txt` | exit 64, no `--auto-review` | exit 3: `caller may not land a pull request: landing deploys, and only deployers may` |
| `04-projects.txt` | no setting shown | `nexus  ... auto review and land, for nLAPTOP`, `nexus-manual  ... auto review off` |
| "Greet by name", `08-show-byName.txt`, `01-by-name.png` | PR #1 open, no review | `review ... of PR #1, started on its own: landed as eeee0005..., round 1 of 5`, and deployed: `release.log` |
| "Greet in French", `09-show-french.txt`, `02-in-french.png` | PR #2 open, no review | the same: PR #2 open, no review |
| "Greet loudly", `10-show-loudly.txt`, `03-loudly.png` | PR #3 open, no review | `started on its own: landed as eeee0007..., round 2 of 5`, after the builder rebased |
| "Greet quietly", `13-show-quietly.txt`, `04-quietly.png` | `needs-person`, `needs you: The branch conflicts with its base.`, attention `decision` | `landed as eeee0010..., round 2 of 5` |
| held PR closed, `22-show-closes-after.txt`, `05-closed-held.png` | still `needs-person`, attention `decision` | review `closed`, attention `reply` |
| held builder archived, `23-show-archives-after.txt`, `06-archived-held.png` | still `needs-person`, attention `decision` | review `cancelled`, `the builder thread ... was archived` |

On the branch, `github.log` shows each landing and each rebase, with no merge attempt of a conflicting head:

```
th-6eb3278737a2 pushed greet-loud at cccc0004..., opening PR #3, which conflicts with main
PUT /repos/ramtinJ95/nexus/pulls/1/merge {"sha":"cccc0002...","merge_method":"squash"}
merged PR #1 at cccc0002... as eeee0005...
th-6eb3278737a2 pushed greet-loud rebased onto main at bbbb0006...
PUT /repos/ramtinJ95/nexus/pulls/3/merge {"sha":"bbbb0006...","merge_method":"squash"}
merged PR #3 at bbbb0006... as eeee0007...
```

Main's `github.log` has no merge at all. On the branch, `typed.log` holds the request typed into each conflicting builder: `the reviewer approved, but the branch conflicts with main, so it cannot merge`, then `CONFLICT (P0) origin/main` with the rebase, resolve, rerun and `git push --force-with-lease` steps. `24-events-review.txt` has each review's phases: `reviewing`, `checking`, `merging`, `fixing` for the rebase, `reviewing` round 2, `checking`, `merging`, `deploying`, `landed`. `release.log` shows each merge commit becoming the desired release by `nexus review <id>` and reported healthy.

Main, "Greet quietly":

![main, the conflicting PR held for the person](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/auto-review-and-rebase/docs/verification/auto-review/main/04-quietly.png)

Branch, "Greet quietly":

![branch, the builder rebased and the PR landed](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/auto-review-and-rebase/docs/verification/auto-review/branch/04-quietly.png)

`tests-main.txt` runs this branch's eleven new tests against main's code: all eleven fail. `tests-branch.txt` runs them on the branch: all pass.

## Not verified

- A real builder resolving a real conflict. The builders are scripted, so whether a model rebases well, keeps both sides' intent, or says when it cannot, is unverified. The loop's handling of a builder that cannot is covered by `src/control/review.test.ts`.
- Real GitHub: that it reports a conflict as `mergeable_state` `dirty` and refuses such a merge with 405, and that it may report `unknown` until asked to merge. The stand-in follows GitHub's documentation.
- `src/control/main.ts`'s wiring. The stack wires the same options itself, and the unit tests drive the loop and the watch directly.
- The real check thread, deploy and probe. The review-flow capture covers those, and this branch does not change them.
- Two landings deploying at once. The captures land one at a time. A landing whose release is replaced before it reports healthy still goes to the person as `superseded`, which reviews that start on their own may make more common.
