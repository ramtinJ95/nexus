# Land button verification

Verified in this task's pylon on 2026-10-27, on branch `feat/dashboard-land-button`, against main at 918e471, with headless Chromium 143. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same two files, so the captures differ only by the code under test.

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<its fonts.conf dir> \
  docs/verification/dashboard-land-button/run.sh origin/main HEAD
```

`stack.ts` runs the real registry, API, dashboard and review loop on 127.0.0.1:7470, wired as `src/control/main.ts` wires them, with the deployers set to one laptop. The API also allows a phone, which is not a deployer. Docker is not available in this pylon, so the verify-nexus stack could not run. As in `review-flow`, only what a pylon cannot host is a stand-in:

- GitHub is a fetch handler behind the real `githubClient`. Each PR is open at its approved head, its checks pass, and a merge checks the head SHA it is given (`github.log`).
- A check thread's run passes 6 seconds after it starts (`check.log`). `review-flow` covers the real check pylon.
- The node's release worker reports a new desired release healthy 8 seconds later, or PR #43's merge commit rolled back (`release.log`).
- whois answers the laptop until the driver posts another node to `/verify/caller` on port 7489.

Four builders have a review waiting for the person:

| Thread | PR | Why it waits |
|---|---|---|
| Cache the thread list | #41 | Held because its GitHub checks were pending. They have passed since. |
| Rename the deploy flag | #42 | Held because the reviewer named a breaking CLI change and the PR changes `src/control/api.ts`. |
| Raise the stream timeout | #43 | Approved by a review started without `--land`. Its deploy fails. |
| Show node load | #44 | Approved, for the device that is not a deployer. |

`drive.mjs` reads each page as the laptop, on a 1280-wide and a 390-wide window, and as the phone. Then it lands #41 and #43: with the page's Land button where the page has one, and with `nexus land` where it has none. It screenshots the page every time the review's phase changes, once the page's 5-second poll shows the change. A browser's confirmation dialog is not part of a screenshot, so the driver puts what the dialog said in a dashed yellow box marked as its own. Last it runs the CLI: `show`, `events`, `land` as the phone, and `land` on #42.

## What was checked

| | main | branch |
|---|---|---|
| A held review's page | `main/01-held.png`. The main column has no review at all. | `branch/01-held.png`. "Held for you", PR #41's link, the head, the reviewer and round, why, the findings, the check, and Land #41. |
| Where main shows it | `main/01-held-pylon-tab.png`. One line and the reason in the inspector's Pylon tab, and no way to land. | `branch/01-held-pylon-tab.png`. The same line stays. |
| On a phone | `main/03-held-phone.png`. Nothing. | `branch/03-held-phone.png`. The same card above the composer. |
| Reserved holds | `main/02-reserved.png`. Nothing. | `branch/02-reserved.png`. Both reasons marked "holds again", and no Land button: only the person merging it gets past them. |
| A device that is not a deployer | `main/04-not-deployer.png`. Nothing. | `branch/04-not-deployer.png`. A disabled Land #44 and why: "This device cannot land: landing deploys, so only the control plane's deployers may, and this device (tailnet node nPHONE) is not one." |
| Pressed anyway | No button. | `branch/05-not-deployer-pressed.png`. A page loaded as the laptop, pressed after whois turned to the phone: the API's 403 shows above the card, and `drive.log` says the review is still `approved`. |
| The confirmation | No button. | `branch/07-land-0-confirm.png`. The dialog said `Land pull request #41, "Cache the thread list between polls", at commit 444444444444? Nexus checks the merge policy again, merges that commit and deploys the merge commit.` Cancel left the review `needs-person`. |
| Landing to landed | `main/07-land-0-nexus-land.txt`, then `main/07-land-*.png`. The page shows no progress in its main column. | `branch/07-land-1-checking.png`, `-2-deploying.png`, `-3-landed.png`. Check, merge, deploy and landed, with the merge commit. |
| Landing that rolls back | `main/08-rollback-*.png`. | `branch/08-rollback-3-rolling-back.png` shows the deploy failed, why, and the rollback target. `-4-needs-person.png` shows "Merged, not deployed" with the rollback's reasons. |

The CLI and the logs are the same on both, since the route and the loop did not change:

```
$ nexus land th-fb82b66a9926          # as the phone, branch/06-nexus-land-not-deployer.txt
nexus: caller may not land a pull request: landing deploys, and only deployers may, never infrastructure nodes or pylons
exit 3
```

`branch/10-events-landed.txt` has #41's `review.changed` events, `needs-person`, then `checking`, `merging`, `deploying` and `landed`, 15 seconds from the press to landed. `github.log` shows one merge, `merged PR #41 at 4444… as 8888…`, and `release.log` shows `8888…` desired by `nexus review rv-41000000` and reported healthy. For #43, `release.log` shows `aaaa…` rolled back, `8888…` desired again by the rollback, and healthy.

`12-nexus-land-reserved.txt` and `13-show-reserved-after-land.txt` show why reserved holds get no button. `nexus land` on #42 starts a landing, and it ends in `needs-person` with the same two reasons. That is so on main too.

## Unit tests

`unit-main.txt` is the branch's `src/control/dashboard.test.ts` run against main's code, and `unit-branch.txt` the same file on the branch. Its three landing tests fail on main, where the page has no landing region, and pass on the branch.

## What this does not prove

- Real GitHub, a real check pylon and a real deploy. `review-flow` covers those paths with a real check script and merge on a local repository.
- A real tailnet's whois. The stack's whois is a function, as in the API tests. The page asks the same `canDeploy` the land route asks, with the caller the API admitted.
- A real phone's browser. The 390-wide window is Chromium's mobile emulation.
