# Land with a passkey verification

Verified in this task's pylon on 2026-10-27, on branch `feat/passkey-land`, against main at 0e55dea, with headless Chromium 143 and its WebAuthn virtual authenticator. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same two files, so the captures differ only by the code under test. `unit.sh` runs the branch's passkey tests against main's code and the branch's, into `unit-main.txt` and `unit-branch.txt`.

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<its fonts.conf dir> \
  docs/verification/passkey-land/run.sh origin/main HEAD
docs/verification/passkey-land/unit.sh origin/main HEAD
```

`stack.ts` runs the real registry, API, dashboard and review loop as `src/control/main.ts` wires them: plain HTTP on 127.0.0.1:7470 for the CLI, and HTTPS on 7443 as `rj-firebat.example.ts.net`, the dashboard's address, with a self-signed certificate that Chromium trusts by its key. The deployers are one laptop, and the API also allows a phone that is not a deployer. It writes a `control.json` naming its registry, so the real host command runs against it with `sudo -n`, as root on `rj-firebat` would. Docker is not available in this pylon, so the verify-nexus stack could not run. As in `dashboard-land-button`, only what a pylon cannot host is a stand-in:

- GitHub is a fetch handler behind the real `githubClient`. Each PR is open at its head, its checks pass, and a merge checks the head SHA it is given (`github.log`).
- A check thread's run passes 4 seconds after it starts (`check.log`).
- The node's release worker reports a new desired release healthy 6 seconds later (`release.log`).
- whois answers the laptop until the driver posts another node to `/verify/caller` on port 7489.

Three builders' reviews start at the merge step, so the stack's first pass runs the real merge policy and holds each one:

| Thread | PR | Held because |
|---|---|---|
| Cache the thread list | #42 | It adds a registry migration: "Always needs the person: anything irreversible, as it changes src/control/registry.ts." |
| Name the caller | #45 | A Claude reviewer approved it, and it changes `src/control/api.ts`. |
| Pin Node 26 | #46 | It changes `images/pylon/Dockerfile`, an image rebuild. `/verify/advance` moves it to a new commit the reviewer approved again. |

The virtual authenticator verifies the person whenever it is asked, as a passkey does after a fingerprint, and shows nothing on screen, and a confirmation dialog is not part of a screenshot either. Where a step used them, the driver adds a dashed yellow box, marked as its own, that says what they did.

## What was checked

| | main | branch |
|---|---|---|
| The Passkeys page | `main/01-passkeys-page.png`: `{"error":"no route /passkeys"}`. | `branch/01-passkeys-page.png`: the page, the host command and the enrol form. |
| Enrolling without a code from the host | `main/02-enrol-without-code.txt`: `404 no route /v1/passkeys/enrolment`. | `branch/02-enrol-without-code.png` and `.txt`: `403 that enrolment code is not one the control plane's host made, or it was used or has expired.` |
| The host command, not as root | `main/03`: no such file. | `branch/03-host-code-not-root.txt`: `passkeys: run this as root on the control plane's host`, exit 77. |
| The host command as root | `main/04`: no such file. | `branch/04-host-code.txt`: an address with a code valid for 10 minutes. |
| Enrolling with it | Nothing to enrol. | `branch/05-enrol-0-with-code.png`, the address filled in the code. `05-enrol-1-enrolled.png`, MacBook Touch ID enrolled. `07-host-list.txt` lists it. |
| The same code again | Nothing to enrol. | `branch/06-code-used-twice.png` and `.txt`: 403, the code is used. |
| The held review's card | `main/08-held-reserved.png`: the hold is marked "holds again", and no button. | `branch/08-held-reserved.png`: marked "you may waive", with why, and Land #42 with a passkey. |
| `nexus land` on it | `main/09-land-*.png` and `09-land-show.txt`: checking, then `needs-person` with the same hold. | `branch/09-land-*.png` and `09-land-show.txt`: the same. A landing without a passkey still holds. |
| Landing with a passkey | `main/10-passkey-0-no-button.png`: no such button. `11-show-landed.txt` is still `needs-person`. | `branch/10-passkey-0-pressed.png`, the confirmation named the PR, the commit and the hold. `-1-checking`, `-2-deploying`, `-3-landed`. `github.log` merged #42 at 4444… as 8888…, and `release.log` reports 8888… healthy. |
| What records it | `main/12-events-waived.txt`: `nexus: unknown event kind`. | `branch/11-show-landed.txt` and `12-events-waived.txt`, quoted below. |
| A replayed assertion | `main/13-replay.txt`: `400 Unrecognized key: "waiver"`. | `branch/13-replay.txt`: the page's own request sent again answers `403 the passkey's confirmation was used already or has expired`. |
| A hold no passkey waives | `main/14-not-waivable.png`, "holds again". `.txt`: 404 for the challenge route. | `branch/14-not-waivable.png`: the Claude reviewer's approval marked "holds again" with why a passkey cannot stand in for it, and no button. `.txt`: `409 a passkey cannot waive "A Claude reviewer approved it. …"`. |
| An assertion for another commit | `main/15-other-commit.txt`: 404, then 400. | `branch/15-other-commit.txt`: an assertion signed for 6666… sent to land 7777… after the PR moved answers `403 the passkey confirmed landing commit 6666…, not 7777…`, and the review stays held. |
| A caller that is not a deployer | `main/16-not-deployer.txt`: 404, then 400. | `branch/16-not-deployer.png`: Land #46 with a passkey disabled, with why. `.txt`: an assertion the laptop got signed, sent as the phone, answers `403 caller may not land a pull request`. |
| Revoking | Nothing to revoke. | `branch/17-two-passkeys.png`, a second authenticator enrolled as Spare YubiKey with a new code. `18-revoked-from-dashboard.png`, MacBook Touch ID revoked with the spare's confirmation. `18-revoke-without-passkey.txt`: 400 without one. `20-host-revoke.txt` and `21-host-list-empty.txt`: the host command revokes the spare. |

What `nexus show` and the event stream record of the passkey landing, `branch/11-show-landed.txt` and `branch/12-events-waived.txt`:

```
review rv-42000000 of PR #42: landed as 8888888888888888888888888888888888888888, round 1 of 5, reviewer th-ae00af258228 on gpt-6-astra, landing when approved
waived by nLAPTOP with the passkey "MacBook Touch ID" (pk-3c6f7795) at 4444444444444444444444444444444444444444, 2026-10-27T15:31:06.601Z:
  Always needs the person: anything irreversible, as it changes src/control/registry.ts.

20 2026-10-27T15:31:06.601Z th-07abfb29be09 review.waived {"review":"rv-42000000","repo":"ramtinJ95/nexus","pr":42,"head":"4444444444444444444444444444444444444444","holds":["Always needs the person: anything irreversible, as it changes src/control/registry.ts."],"passkey":{"id":"pk-3c6f7795","name":"MacBook Touch ID"},"by":"nLAPTOP","at":1793115066601}
```

`branch/12-events-review.txt` shows #42's phases: held, `checking` after `nexus land`, held again 5 seconds later, then `checking`, `merging`, `deploying` and `landed` after the passkey, 12 seconds from the press. `branch/22-events-passkeys.txt` shows both enrolments and both revocations, the first `by nLAPTOP with Spare YubiKey` and the second `by root on the control plane's host`.

## Unit tests

`unit-main.txt` is the branch's passkey tests run against main's code: `passkeys.test.ts`, `review.test.ts` and `api.test.ts` fail to load, since the modules they test do not exist on main, and the dashboard and CLI tests fail. `unit-branch.txt` is the same 15 tests on the branch, all passing.

## What this does not prove

- A real person's authenticator. The virtual authenticator answers as a platform authenticator that always verifies the person. The server's refusals of an authenticator that did not verify the person, of another origin and relying party, and of a counter that went back are in `src/control/passkeys.test.ts`, with a software authenticator that can send what a real one should not.
- Real GitHub, a real check pylon, a real deploy and a real tailnet's whois, as in `dashboard-land-button`.
- The host command on `rj-firebat` itself. It ran as root in this pylon against the stack's registry and left the registry's files owned by their owner.
