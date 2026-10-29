# Person-only routes and cancelling a review

Verified in this task's pylon on 2026-10-29, on branch `fix/person-routes-review-cancel`, against main at 87d7e0d, with headless Chromium 138. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023/lib> FONTCONFIG_PATH=<its fonts> \
  docs/verification/person-routes-review-cancel/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`. Then it runs the branch's review, API, dashboard and CLI tests against each run's code, and keeps the failures and counts in `tests.txt`.

`stack.ts` is the [archive-landed](../archive-landed/README.md) stack: the real registry, API, dashboard, PR watch, inbox and review loop, with GitHub as a fetch handler, Claude workers with no Claude Code, and harness reviewers in the test's fake harness. Docker is not available in this pylon, so the verify-nexus stack could not run. Three things differ. The caller is the person's laptop, or the control node itself while `OUT/caller` names it, and both are allowed callers. A reviewer answers by its builder's title: "Hold in review" never answers, "Hold in fixing" requests changes the builder never answers, and others approve. The node reports a release healthy only once `OUT/healthy` exists, so a landing waits in its deploy.

`drive.mjs` uses only the Mac CLI and the dashboard, the same steps on both runs. It starts "Hold in review" and "Hold in fixing" in a project that reviews on its own, "Deploy slowly" in one that lands on its own, and "Bystander", which opens no PR. The person cancels the first review with `review --cancel`, tries to cancel the deploy, and cancels the second from the dashboard's Cancel review button. Then the control node calls every route that acts on a thread, on Bystander, and the person archives it.

## What was checked

| Step | main | branch |
|---|---|---|
| `review` on a running review, `08` | exit 5, `is reviewing` | exit 5, and says to cancel it with `nexus review --cancel` |
| `review --cancel` "Hold in review", `09` to `12` | exit 64, unknown option | exit 0, `cancelled by nLAPTOP`. Its reviewer is archived and its builder active. A second cancel exits 5, `already ended cancelled` |
| `review --cancel` "Deploy slowly" while deploying, `13`, `14` | exit 64 | exit 5, `a merge or deploy that has begun is seen through`. It lands once the node reports healthy |
| Dashboard, "Hold in fixing", `01`, `02` screenshots, `15`, `16` | no Cancel review button | the button, a confirmation naming the review and PR, then `cancelled by nLAPTOP`, reviewer archived, builder active, and no button |
| The control node on Bystander, `17` to `30` | each route acts or fails on its own terms. `archive`, `project edit` and `delete` exit 0 | every one exits 3, `caller may not <action>: only a person may`, attach included |
| The person archives Bystander, `31` | exit 5, the control node had deleted it | exit 0 |
| `tests.txt` | 9 of 404 fail: the new and changed tests, and the version test | 404 of 404 pass |
