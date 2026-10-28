# Archive what landed

Verified in this task's pylon on 2026-10-28, on branch `feat/archive-landed` at 22b13f5 (code and docs; the capture's own commit follows it), against main at 76522f5, with headless Chromium 138. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023/lib> FONTCONFIG_PATH=<its fonts> \
  docs/verification/archive-landed/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same two files, so the captures differ only by the code under test. Then it runs the branch's `src/control/review.test.ts` against each run's code, into `tests.txt`.

`stack.ts` runs the real registry, API, dashboard, PR watch, inbox and review loop, wired as `src/control/main.ts` wires them, with the real `githubClient`. It is the [auto-review](../auto-review/README.md) stack without its conflicts. Docker is not available in this pylon, so the verify-nexus stack could not run. GitHub is a fetch handler that keeps the PRs. Builders are Claude workers with no Claude Code that push the branch their prompt names. Reviewers are harness threads in the test's fake harness that approve every head. `.nexus/check` passes after a second, and the node reports each desired release healthy. No planner runs, so the review loop's wake of it is written to `wake.log`, and every pylon reports `running`. The PR watch polls every 2 s and the loop every second, instead of every 2 minutes and 15 s.

`drive.mjs` uses only the Mac CLI and the dashboard, the same steps on both runs:

1. `project edit nexus --auto-review land` and `project edit nexus-review --auto-review review`.
2. Three builders push, and no one runs `nexus review`. "Greet by name" in `nexus` lands and deploys. "Rebuild the image" in `nexus` changes a file under `images/`, which the merge policy holds for the person. "Greet in French" in `nexus-review` is reviewed and stops at approval.
3. Once every review has ended: `threads --all`, `show` on each builder and reviewer, `events --kind review.changed`, and screenshots.
4. The person unarchives "Greet by name", and five seconds later `show` and `threads --all` run again.

## What was checked

| Thread | main | branch |
|---|---|---|
| "Greet by name", review `landed`, `07-threads.txt`, `08-show-byName.txt` | `active`, and its reviewer `active` | `archived`, and its reviewer `archived`. `wake.log` has one planner wake for each, written after the archive. The dashboard folds both under "2 archived" with desired state `paused` |
| "Rebuild the image", review `needs-person`, `09-show-image.txt` | `active`, attention `decision` | `active`, attention `decision`, its reviewer `active`, and the Land card still offered |
| "Greet in French", review `approved`, `10-show-french.txt` | `active` | `active`, and its reviewer `active` |
| `unarchive` of "Greet by name", `15-unarchive-byName.txt`, `17-threads-after-unarchive.txt` | exit 5: `thread ... is active, not archived` | exit 0, and five seconds of passes later it is still `active`: the loop archives a landed review's threads once, as it lands |
| `tests.txt` | 62 of 64 pass. The two new archive tests fail | 64 of 64 pass |

`wake.log` on the branch:

```
08:15:16.091Z the review loop woke the planner for th-e370fae35ac2 (Greet by name), now archived
08:15:16.093Z the review loop woke the planner for th-46a62661fcde (Review of #1: Greet by name), now archived
```

The tests in `tests.txt` that name the step's own Verify sentence are "a review that lands archives its builder and reviewer, once, whether its PR deploys or not" and "a review held for the person, or one that stops at approval, archives nothing". The second passes on main too, since main archives nothing at all. A third, "a thread in a turn as its review lands stays open, and the other is archived", covers the one exception.

Main, "Greet by name" after it landed:

![main, the landed builder still open](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/archive-landed/docs/verification/archive-landed/main/02-by-name.png)

Branch, "Greet by name" after it landed, archived with Unarchive offered:

![branch, the landed builder archived](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/archive-landed/docs/verification/archive-landed/branch/02-by-name.png)

Branch, the thread list, with the landed builder and its reviewer folded under "2 archived" and the held one still open:

![branch, the thread list](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/archive-landed/docs/verification/archive-landed/branch/01-home.png)

## Not verified

- A pylon actually pausing. No planner or probe runs here, so the capture shows the desired state `paused` and the wake, not a paused VM. The planner already pauses an archived thread's pylon when `nexus archive` archives it, and the loop archives through the same registry call and wake.
- A builder in a turn as its review lands, on the stack. The scripted builders never run a turn. `review.test.ts` covers it.
- A landing in a repository other than the one releases come from. `review.test.ts` covers it.
- `src/control/main.ts`'s wiring of `wake`. The stack wires the same option itself, and the typecheck checks the call.
