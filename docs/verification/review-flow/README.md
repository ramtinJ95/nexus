# Review loop verification

Verified in this task's pylon on 2026-10-26, on branch `review-flow`, with Claude Code 2.1.308 and Herdr 0.9.5. No live control plane, node, image, GitHub repository or other thread was touched.

## The stack

`stack.ts` runs the real registry, API, PR watch, inbox, review loop and check runner on `127.0.0.1:7470`, as `src/control/main.ts` wires them. The builder is a real Claude Code worker in a Herdr pane, started and steered by the real `sessions.ts` code, as in [the Claude streaming verification](../claude-thread-streaming/README.md). Only what a pylon cannot host is a stand-in:

- GitHub is a fetch handler over a local bare repository, `origin.git`, behind the real `githubClient`. A pushed `feature` branch opens PR #1, as `gh pr create` would, with a fixed description that says what could not be checked live. A merge squashes the branch into `main` and checks the head SHA it is given. `github.log` lists every request.
- The reviewer is a harness thread whose model is scripted. On each request it runs `greet.sh` from `origin.git` at the head the review recorded, and requests a change until `sh greet.sh Ada` prints `hello Ada`. So its verdict depends on what the real builder pushed.
- The probe's git facts are a branch output the stack records once `origin.git` has `feature`.
- The node's release worker reports each new desired release healthy after 3 seconds, or, with `FAIL_DEPLOY=1`, the merge commit rolled back.
- The reviewer pylon's exec runs on this machine in its own clone, so `.nexus/check` runs for real through `gate.ts`'s script.

`drive.mjs` drives it through the Mac CLI only (`node src/cli/nexus.ts` with `NEXUS_URL` and `NEXUS_SOCKS=none`), and saves each step's command, output and exit code. The PR comment is posted to the stand-in GitHub, as the repository's owner would.

Each run's folder holds the numbered CLI steps, `drive.log` and `timeline.txt`, and the stack's logs: `github.log`, `typed.log` (every message typed into Claude), `reviewer.log`, `check.log` and `release.log`. The runs were made after the fixes for the first review of this branch. The builder's choice to fix or reject a finding varies from run to run, so each run's task is given.

## A review that lands (`landed/`)

The task asked for a script that prints `hello`, and said a reviewer's findings would arrive as messages to fix.

- `01-start.txt`, `02-show-linked.txt`. `nexus start --claude` started the builder. It pushed `feature`, and the PR watch linked PR #1.
- `typed.log`, `03-conversation-after-comment.txt`. The owner's PR comment, with CRLF line ends, was typed into the Claude worker's session as one prompt starting with `[Nexus PR watch — automated, not a message from the person]`, and Claude answered it. Before this branch the PR watch dropped it.
- `04-review.txt`. `nexus review <builder> --land` started review `rv-6b055ce0` with a harness reviewer on `gpt-6-astra`, another model family than the builder's `claude-opus-5-5`.
- `reviewer.log`, `typed.log`, `09-conversation-builder.txt`, `10-conversation-reviewer.txt`. Round 1: the reviewer ran the pushed script, found that `sh greet.sh Ada` printed `hello`, and requested a change (F1, serious). Request `rv-6b055ce0:2` typed the findings into Claude with its own token. Claude fixed `greet.sh`, pushed `c5ae5fa`, and answered F1 as fixed in the block. Round 2, request `rv-6b055ce0:3`, sent the reviewer the new commits and the answer, under a new token, and it approved.
- `check.log`. `.nexus/check` started detached at `c5ae5fa` in the reviewer's clone, and the next exec read `done 0`.
- `github.log`, `release.log`. The landing merged with `sha` `c5ae5fa` and squashed it into `6a73de6`. It set `6a73de6` as the desired release, recorded as `nexus review rv-6b055ce0`, and ended `landed` once both roles reported it healthy.
- `05-show-ended.txt`, `07-events-review.txt`. `show` prints the review's line, and the event log has every `review.changed`, from `reviewing` round 1 through `checking` and `merging` to `landed`, in under 30 seconds.
- `14-land-again.txt`. A second `nexus land` exits 5: the review already merged.

## A builder that rejects a finding (`disagreed/`)

The task asked for a script that prints `hello` and said nothing about reviews. The builder rejected F1 with a reason, twice: greeting a name was outside its minimal task. The reviewer held its finding, so the loop never ran a check on the unchanged head. An earlier run with the same task had complied, and this one did not, so the choice is the model's.

- `09-conversation-builder.txt`. Both answers are `rejected`, each with a reason, in the request's block. Nothing was pushed after the first commit.
- `reviewer.log`, `07-events-review.txt`. Three rounds of `changes`, then `needs-person` with "The reviewer still requests changes after 3 rounds, the most this review allows."
- `05-show-ended.txt`. The builder's attention is `decision`, and `needs you:` gives the reason. Nothing merged.

## A deploy that fails rolls back (`rolled-back/`)

Run with `FAIL_DEPLOY=1`, and with a task that already asked for the name, so the reviewer approved in round 1.

- `check.log`, `github.log`. `.nexus/check` passed at the approved head, and the landing merged it.
- `release.log`. The merge commit became the desired release, the stand-in worker reported it rolled back, and the loop set the previous release, `b254b12`, back as desired, recorded as the review's rollback.
- `05-show-ended.txt`. The builder's attention is `decision`, with three `needs you:` lines: which components failed and why, which release it rolled back to, and that the merge commit is still on the default branch to revert.

## Nested virtualization (`nested-kvm.txt`)

For [the live check's open question](../../design.md#open-questions): this pylon's guest kernel ships the KVM modules, and once they were loaded `/dev/kvm` appeared and `kvm-probe.py` ran a real-mode guest on it. `insmod.py` loads a module without `kmod`, which the image lacks.

## What this does not prove

- A real model as the reviewer. The reviewer's verdicts are scripted, so the review prompt's quality and a real reviewer's blocks are unverified. The Claude builder's blocks are real.
- A Claude worker as the reviewer of a harness builder. The unit tests cover choosing it and its raw prompt, not a live run.
- Real GitHub: its merge permissions, branch protection, and a read-only token's answer. The client's handling of 403, 409 and rate limits is covered by `src/control/pr-watch.test.ts` with fetch fakes.
- A real deploy, and the control plane restarting itself mid-landing. `src/control/review.test.ts` restarts the loop on the same registry file during `deploying`, and it neither merges nor deploys again.
- Gondolin and the probe. Exec, send-claude and the transcript pipe ran on this machine, not through a probe into a pylon-vm.
