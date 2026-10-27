# Land button waives verification

Verified in this task's pylon on 2026-10-27, on branch `feat/land-button-waives`, against main at 7cdf2bf, with headless Chromium 143. No live control plane, node, image, GitHub repository or other thread was touched. This replaces `passkey-land`, whose passkey flow the branch removes.

## How to rerun

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt` and the stack's own output in `stack.out`. Both runs use the same two files, so the captures differ only by the code under test.

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<its fonts.conf dir> \
  docs/verification/land-button-waives/run.sh origin/main HEAD
```

`stack.ts` runs the real registry, API, dashboard and review loop as `src/control/main.ts` wires them: plain HTTP on 127.0.0.1:7470 for the CLI, and HTTPS on 7443 as `rj-firebat.example.ts.net`, the dashboard's address, with a self-signed certificate that Chromium trusts by its key. The deployers are one laptop, and the API also allows a phone that is not a deployer. Docker is not available in this pylon, so the verify-nexus stack could not run. As in `dashboard-land-button`, only what a pylon cannot host is a stand-in:

- GitHub is a fetch handler behind the real `githubClient`. Each PR is open at its head, its checks pass unless the table says otherwise, and a merge checks the head SHA it is given (`github.log`).
- A check thread's run passes 4 seconds after it starts (`check.log`).
- The node's release worker reports a new desired release healthy 6 seconds later (`release.log`).
- whois answers the laptop until the driver posts another node to `/verify/caller` on port 7489.

Five builders' reviews start at the merge step, so the stack's first pass runs the real merge policy and holds each one:

| Thread | PR | Held because |
|---|---|---|
| Cache the thread list | #42 | It adds a registry migration, which the policy reserves for the person as irreversible. Nothing else holds it. |
| Document the merge token | #47 | It changes `deploy/README.md`, a secrets path, and its GitHub checks fail. |
| Log more | #48 | It changes `deploy/control.json`, and `.nexus/check` failed at its head. |
| Name the caller | #45 | A Claude reviewer approved it, and it changes `src/control/api.ts`. |
| Pin Node 26 | #46 | It changes `images/pylon/Dockerfile`, an image rebuild. `/verify/advance` moves it to a new commit the reviewer approved again. |

A browser's confirmation dialog is not part of a screenshot, so where the driver accepted one it adds a dashed yellow box, marked as its own, that quotes it.

## What was checked

| | main | branch |
|---|---|---|
| The Passkeys page | `main/01-passkeys-page.png`: the page, answered 200. | `branch/01-passkeys-page.png`: answered 404, and the side bar has no Passkeys link. |
| #42, held only for a reserved path | `main/02-held-reserved.png`: "you may waive", and "Land #42 with a passkey" disabled because none is enrolled. | `branch/02-held-reserved.png`: "you may waive", and Land #42. |
| `nexus land` on #42 | `main/03-cli-land-*`: checking, then `needs-person` with the same hold. | `branch/03-cli-land-*`: the same. The CLI never waives. |
| Pressing Land on #42 | `main/04-press-0-needs-passkey.png`: the button is disabled. `04-press-waive-without-passkey.txt`: the branch's request answers `400 Unrecognized key: "waive"`. | `branch/04-press-0-pressed.png` quotes the confirmation, which names the PR, the commit and the waived hold. `-1-checking`, `-2-deploying`, `-3-landed`. `github.log` merged #42 at 4444… as 8888…, and `release.log` reports 8888… healthy. |
| What records it | `main/05-show.txt` is still `needs-person`, and `06-events-waived.txt` is empty. | `branch/05-show.txt` and `06-events-waived.txt`, quoted below. `06-events-review.txt`: held, checking, held again after `nexus land`, then checking, merging, deploying and landed. |
| #47, a waived landing that meets failing GitHub checks | `main/07-failing-checks-held.png`: Land #47 with a passkey, disabled. | `branch/07-failing-checks-0-pressed.png`, `-1-checking`, `-2-needs-person.png`: held again with both holds. `07-failing-checks-show.txt` prints both and the waiver. |
| #48, a failed `.nexus/check` | `main/08-failed-check.png`: no Land button. `.txt`: 400 for `waive`. | `branch/08-failed-check.png`: no Land button. `.txt`: 409, not approved with its checks passing. |
| #45, a Claude reviewer's approval | `main/09-claude-approved.png`: "holds again", no button. `.txt`: 400. | `branch/09-claude-approved.png`: the same. `.txt`: `409 "A Claude reviewer approved it. …" cannot be waived`. |
| #46, a waiver for a commit the PR moved past | `main/10-moved-head.txt`: 400. | `branch/10-moved-head.txt`: `409 review rv-46000000 … is at 7777…, not 6666…, so it was not landed`. |
| A caller that is not a deployer | `main/11-not-deployer.png`: Land #46 with a passkey, disabled. `.txt`: 400. | `branch/11-not-deployer.png`: Land #46 disabled, with why. `.txt`: `403 caller may not land a pull request`. |

What `nexus show` and the event stream record of the landing from the dashboard, `branch/05-show.txt` and `branch/06-events-waived.txt`:

```
review rv-42000000 of PR #42: landed as 8888888888888888888888888888888888888888, round 1 of 5, reviewer th-… on gpt-6-astra, landing when approved
waived by nLAPTOP at 4444444444444444444444444444444444444444, 2026-10-27T…Z:
  Always needs the person: anything irreversible, as it changes src/control/registry.ts.

… review.waived {"review":"rv-42000000","repo":"ramtinJ95/nexus","pr":42,"head":"4444444444444444444444444444444444444444","holds":["Always needs the person: anything irreversible, as it changes src/control/registry.ts."],"by":"nLAPTOP","at":…}
```

## What this does not prove

- Real GitHub, a real check pylon, a real deploy and a real tailnet's whois, as in `dashboard-land-button`.
- The migration that drops the passkey tables on the live registry. `src/control/registry.test.ts` runs it against a registry that has both tables.
