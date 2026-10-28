# Question cards verification

Verified in this thread's pylon on 2026-10-28, on branch `feat/question-cards` against main at `4cf067d`, with Node 24.22.1 and headless Chromium from `@sparticuz/chromium`. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<its fonts.conf dir> \
  docs/verification/question-cards/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same two files, so the captures differ only by the code under test. Then it runs the branch's question tests from `api.test.ts`, `registry.test.ts`, `dashboard.test.ts` and `nexus.test.ts` against each checkout's code, into `tests-main.txt` and `tests-branch.txt`.

## The stack

Docker is not available in this pylon, so the verify-nexus stack could not run. Its whois also names every caller as the control plane's own node, which may not answer a question. `stack.ts` runs the real registry, API and dashboard as `src/control/main.ts` wires them, on 127.0.0.1:7470, as in `land-button-waives`. Only what a pylon cannot host is a stand-in:

- whois answers the laptop, a deployer, until the driver names another caller: the phone, a person the API allows who is not a deployer, or `verify-node`, the control plane's own node, whose identity a pylon's traffic carries.
- The node is observed online with its pylons running, as a probe would report it.
- The agent is the fake harness from the API tests.

Nothing asks a question yet, so the stack asks three through the registry, as `land-button-waives` seeds reviews:

| Thread | Question | Reserved case | Who answers |
|---|---|---|---|
| Pin the pylon's Node to 26 | `qn-image-rebuild`: rebuild the pylon image? | pylon image rebuilds | a deployer |
| Rotate the merge token | `qn-merge-token`: rotate it now? | secrets | a deployer |
| Plan the pipeline items | `qn-brief`: start a builder with this brief? | none | any person |

Main's registry has no questions, so on main the stack asks none and logs that in `main/stack.log`.

## What was checked

| | main, 4cf067d | this branch |
|---|---|---|
| `01-home.png`, `02-threads.txt` | Three threads, none needing the person. | All three red in the sidebar, as threads that need the person. |
| `03-show-image-before.txt` | `attention: none`, no question lines. | `attention: decision`, then the question, its options, `reserved: pylon image rebuilds` and `needs a deployer`. |
| `04-image-card.png`, as the laptop | No card. | The card: the question, the reserved case, "A deployer answers", and a button per option. |
| `05-image-press-*`, pressing "Rebuild and roll out" | No button to press. | The confirmation `Answer "Rebuild and roll out"? The answer cannot be changed.`, then `Answered "Rebuild and roll out" from nLAPTOP`. |
| `06-*`, after the answer | No questions in `ThreadDetail`. | `attention: none`, and `answered "Rebuild and roll out" by nLAPTOP at …`. |
| `07-secret-as-phone.*`, a deployer question as the phone | No card. `404 no route`. | The buttons are disabled, and the card says why. `403 caller may not answer this question: its answer may deploy, so only deployers may`. Attention stays `decision`. |
| `08-brief-as-node.txt`, as the control plane's node | `404 no route`. | `403 caller may not answer this question: only a person's device may, never infrastructure nodes or pylons`. |
| `09`, `10`, `11`, the person question as the phone | No card or button. | The buttons are enabled for a person who is not a deployer. Pressing "Start it" answers it, and `show` prints `answered "Start it" by nPHONE`. |
| `12-answers-again.txt` | Four `404 no route`. | The same answer again is 200 with the first record. Another option is 409 `was answered "Rebuild and roll out" by nLAPTOP`. An unknown question is 404, and an option the question does not offer is 400. |
| `14-home-after.png` | Unchanged. | Only "Rotate the merge token" still needs a decision. |
| `tests-*.txt`, the 5 question tests | All 5 fail. | All 5 pass. |

The card before and after the laptop answered it, and the deployer question as the phone sees it:

![The image question's card](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/question-cards/docs/verification/question-cards/branch/04-image-card.png)

![The card once answered](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/question-cards/docs/verification/question-cards/branch/05-image-press-1-answered.png)

![The deployer question as the phone](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/question-cards/docs/verification/question-cards/branch/07-secret-as-phone.png)

Main's thread page for the same thread has no card: [`main/04-image-card.png`](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/question-cards/docs/verification/question-cards/main/04-image-card.png).

## Not verified here

- A real tailnet's whois, which tells the laptop, the phone and a node apart here only because the stand-in says so.
- Anything that asks a question. No asker exists yet, so the stack writes the questions to the registry itself.
- The verify-nexus Docker stack. Docker is not available in this pylon.
