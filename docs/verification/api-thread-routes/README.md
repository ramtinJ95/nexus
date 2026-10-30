# API thread routes verification

Issues #278, #279, #283, #292 and #266 reshape how the API serves a thread. The route looks the thread up once and checks
what it needs in one place. Each agent kind's work goes through `src/control/thread-agent.ts`. A thread's pylon and
its node are read once per call. The boot network and the image part hash each have one copy. One thread page's
streams share one render. The change is meant to preserve behaviour: every status, message and body the API answers
stays the same.

## How to rerun

```sh
docs/verification/api-thread-routes/run.sh origin/main HEAD
```

`run.sh` checks out each ref into a temporary worktree, links `node_modules` and builds the dashboard. It copies this
directory's `capture-api.ts` and `normalise.ts` into the worktree and runs the capture there, so each ref's imports
resolve to its own code. It writes `main/api.txt`, `branch/api.txt` and `diff.txt`, and removes the worktrees on exit.
It checks out commits, so it does not see uncommitted changes. One run takes about 5 minutes in a pylon.

The capture is `docs/verification/thread-agent-kind/capture-api.ts` with two changes. The API gets a deployment
configuration, because only a person may start a thread since #317. A start that the API refuses stops the capture
with its reply. The capture starts the real `startApi` with a real registry, the tests' fake harness and a fake probe.
It starts a harness thread, a Claude worker, a pending Claude worker and a bare thread. For each one, while active,
then archived, then deleted, it records the following:

- Thread detail and the conversation read.
- The first event of `/events`, `/claude/events` and the thread page's stream.
- The whole thread page.
- A message, an empty message, an abort and a retry, with what the probe and the harness got.
- `nexus show`, `nexus conversation`, `nexus send` and `nexus watch`, run as processes.

See `thread-agent-kind/README.md` for what the capture normalises.

## What the captures show

`main/commit.txt` and `branch/commit.txt` name the refs. Both ran in this thread's pylon on 2026-10-30, on Node 26.12.1.

`diff.txt` is empty: all 4328 lines match.

## What the capture leaves out

- The attach route and `door().look()`. The attach tests in `src/control/api.test.ts` match each refusal's message.
- Outdated grants. A new pin starts a thread with HTTPS dotfiles, whose host is in its allowlist, and checks that its
  grants stay current until the project's hosts change.
- A harness image link. A new pin in `src/control/dashboard.test.ts` serves the link that a thread page renders.
- How often a page's stream renders. A new test in `src/control/api.test.ts` opens two page streams of one Claude
  worker and counts the renders of one new view. It is 2 on main and 1 on the branch.
