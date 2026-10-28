# Thread agent kind verification

Issue #131 models a thread's agent once. `Registry.agent` derives it from the two facts the registry already stores: a
harness thread has a `conversationId`, a Claude worker thread has a row in `claude_workers`, and a bare thread has
neither. `src/control/thread-agent.ts` holds each kind's view, watch, latest turn and delete. The API, the dashboard,
`nexus conversation`, the inbox, the review loop, the harness boot and the usage counter dispatch on it. The wire is
unchanged: both event routes and both view types stay as they are. The change is meant to preserve behaviour: nothing
a person, a client or a node observes changes.

## How to rerun

```sh
docs/verification/thread-agent-kind/run.sh origin/main HEAD
```

`run.sh` checks out each ref into a temporary worktree, links `node_modules`, builds the dashboard, copies
`capture-api.ts` and `normalise.ts` in and runs the capture there, so each ref's imports resolve to its own code. It
writes `main/api.txt`, `branch/api.txt` and `diff.txt`. A capture that throws on a ref leaves its error at the end of
that ref's file, so `diff.txt` shows the failure. It then runs the pin tests at the pins commit, found by
`git log --grep '^test(control): pin what each agent kind answers'`, into `tests-pins.txt`, and on the branch into
`tests-branch.txt`. The pins commit is main's code with only the pin tests added. Later `test(` commits are applied to
it before its tests run. The test files run whole: `api`, `dashboard`, `review`, `usage-limit`, `pr-watch`,
`claude-conversation`, `usage` and `nudge` under `src/control`, and `src/cli/nexus.test.ts`. The worktrees are removed on exit.
`run.sh` checks out commits, so it does not see uncommitted changes. One run takes about 20 minutes in a pylon.

The capture starts the real `startApi` on loopback with a real registry, the tests' fake harness, and a fake probe. The
probe answers `send-claude` and runs each pipe locally against a folder that stands in for the pylon's
`~/.claude/projects`, so Claude transcript reads are real reads of `src/fixtures/claude-transcript.jsonl`. Four threads
start a second apart on a clock that moves only when the script moves it:

- a harness thread, started with a first message;
- a Claude worker thread with a model, whose worker is started with a session;
- a pending Claude worker thread with no session yet;
- a bare thread, started with `bare` as the review loop starts a check thread.

Every pylon is observed running. For each thread, active, then archived, then deleted, it records the following:

- The status, content type and body of `GET /v1/threads/<id>` and `GET /v1/threads/<id>/conversation`.
- The status, headers and first event's bytes of `GET /v1/threads/<id>/events`, `GET /v1/threads/<id>/claude/events`
  and `GET /threads/<id>/stream`.
- The whole thread page.
- `POST` of a message and of an empty message, `abort` and `retry`, with what the probe and the harness got.
- As a process, `nexus show`, `nexus conversation` with and without `--json`, `nexus send` (not once deleted), and
  `nexus watch` with and without `--json` until it is quiet for a second. Each records its exit code, stdout, stderr,
  and what the probe and harness got.

It also records the start replies, `GET /v1/threads` while active and once deleted, and what the harness got from each
`DELETE`. It records each stream's next event after a change: a harness commit, and the Claude transcript growing by
the rest of the fixture.

Thread IDs and pylon IDs become names, UUIDs and ISO times become numbered placeholders (`normalise.ts`), and the CLI's
"N ago" becomes `<ago>`, since the CLI runs on the real clock. Replies and pages are kept whole. A request body, probe
command or harness call's string over 160 characters becomes its length and a hash. Two runs of one commit print the same bytes. A first version started the threads within one
millisecond, so they listed by their random IDs, and two runs of main's code differed in order only. That is why they
now start a second apart.

## What the captures show

See `main/commit.txt` and `branch/commit.txt` for the refs. Both ran in this thread's pylon on 2026-10-28, on Node
24.22.1. The repository asks for Node 26, which the pylon cannot run.

`diff.txt` is empty: every one of the 4164 lines matches.

## What the capture leaves out

- The Changes view's `base=turn`, which asks the agent for its latest turn. Every kind answers null in the capture (the
  fake harness has no turns, and no Claude turn started), and the pylon read needs a checkout. `src/control/api.test.ts`
  covers a Claude worker's turn, and the harness path is moved unchanged.
- Drain, which reads only harness conversations. A pin in `src/control/api.test.ts` covers it.
- The inbox and the review loop's reply reads, which are not on the wire. A pin in `src/control/review.test.ts` covers
  them for each kind.
