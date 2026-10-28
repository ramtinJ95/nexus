# Harness registry verification

Issue #132 grows the `agents` table in `src/sessions.ts` into one registry of session harnesses (`claude-code`, `pi`,
`shell`). The `harness === "claude-code"` branches in `src/sessions.ts`, `src/protocol.ts`, `src/reconcile.ts`,
`src/control/api.ts`, `src/control/dashboard.ts`, `src/pylon-vm-backend.ts`, `src/cli/nexus.ts` and
`src/session-wake.ts` now read from it. The change is meant to preserve behaviour: nothing a person, a client or a node
observes changes.

## How to rerun

```sh
docs/verification/harness-registry/run.sh origin/main HEAD
```

`run.sh` checks out each ref into a temporary worktree, links `node_modules`, builds the dashboard, copies this
directory's scripts in and runs them there. Each ref's imports then resolve to its own code. It writes `main/`, `branch/`
and `diff.txt`. A capture that throws on a ref leaves its error at the end of that ref's file, so `diff.txt` shows the
failure. `run.sh` then runs the pin tests at the pins commit, found by `git log --grep '^test(sessions): pin each
harness'`, into `tests-pins.txt`, and on the branch into `tests-branch.txt`. The pins commit is main's code with only
the pin tests added. The pin tests are `src/sessions.test.ts`, `src/protocol.test.ts`, `src/reconcile.test.ts` and
`src/cli/nexus.test.ts`. Any later `test(` commit is applied to the pins commit before its tests run. The worktrees are
removed on exit. `run.sh` checks out commits, so it does not see uncommitted changes.

The scripts import only the runtime exports that exist on both sides. They leave out `sessionHarnessSchema`,
`SessionHarness` and `harnessLabel`, which move. Every random UUID, Herdr agent name (`nx-xxxxxxxx`) and ISO timestamp
becomes a numbered placeholder, numbered within each case (`normalise.ts`). Long strings become their length and a
hash. The API capture freezes `Date.now`. Two runs of one commit print the same bytes.

- `capture-protocol.ts` writes `protocol.txt`. It parses `open-session` commands with `parsePylonCommand` for each
  harness, and for each of `resume`, `prompt` and `model` it tries the field present, empty, too long, a number and
  null. It also tries fields together, harnesses Nexus does not name (`codex`, `toString`, `__proto__`, missing, null,
  a number, an array), and `close-session` with a `session` of each harness and bad ones. Each line shows the accepted
  command or the refusal message. It parses observations with sessions of each harness, older ones without states, and
  `codex`, through `parseProbeEvent`. It also records the writes `ingest` makes: activity for each harness (and
  `codex`) in each Herdr status, running and failed, from several sessions at once, and the session rows of running,
  failed and paused lists.
- `capture-sessions.ts` writes `sessions.txt`. It drives `src/sessions.ts` on a fake guest whose Herdr panes and files
  change as the calls act on them. It records every guest exec in order, with its cwd and timeout, every file written
  with its mode, owner and content, and what each call returns or why it rejects.
  - `openSession` for each harness: fresh, with no Herdr server, with a server that fails to start, resumed with and
    without a Claude transcript, a failed agent start with and without the agent in the pane, a pane that cannot be
    inspected, a failed rollback, an agent blocked at startup, and a busy pane.
  - Claude with a model, and prompted Claude launches: under a given ID with a model, under no ID, under an ID whose
    transcript exists, under an ID Nexus refuses, and one whose Claude already runs. A prompted launch types its
    command: the fake guest runs `pane run`, starts Claude in the pane and writes the submission receipt.
  - `recordSessions` over Claude, pi, a shell and `codex`, with and without Herdr's session IDs, with `--model` and
    `--session-id` on command lines, a Claude pane that closed or cannot be read, no server, and failed records.
    Each records the exact `sessions.json` written.
  - `sessionFacts`.
  - `relaunchSessions` over eleven pylons. These include duplicate Claude and pi records, shells that share a title,
    records with models, panes restored as shells, panes that run only their shell, agents run by node, records
    whose panes cannot be inspected, failed starts, a Herdr that will not start, and failed records from the last
    wake. Each lists the IDs passed to `exclusive`, the outcomes, the rewritten file, the panes left behind, and what a
    following `recordSessions` reads back.
  - The `sessions:` log lines `relaunchAfterWake` and `recordBeforePause` from `src/session-wake.ts` write for the same
    pylons. The formatter is not exported, so the script drives these two functions with a log callback.
  - `closeSession` of each harness's pane against its own identity, every other harness, another or no session ID, and
    another or no title.
  - `pausedSessionsIn` for each harness and for bad harnesses.
  - What `createPylonVmBackend(...).list()` reports for a stopped instance whose `nexus-checkpoint.json` holds paused
    sessions of each harness, none, a `codex` session, one with no harness, and one with an extra field.
- `capture-api.ts` writes `api.txt`. It starts the real `startApi` on loopback with a real registry, the tests' fake
  harness and a fake probe for the thread's node. It records:
  - The status and reply of `POST /v1/threads/<id>/sessions` for 23 bodies, with the command the probe got, and for
    each harness when the pylon is not running.
  - `DELETE` of each listed session, with the probe answering closed, moved and not-open.
  - With sessions of every harness running in each Herdr status, paused, failed in no pane and failed in a pane: the
    JSON sessions list of `GET /v1/threads/<id>`, and the sessions section of `GET /threads/<id>`. The section is
    recorded as a reader's text per session and as its raw HTML, both before and after the thread is archived.
  - `node src/cli/nexus.ts` as a process: `--help`, `session open --help` and `session close --help`, the `session:`
    lines of `show`, and `session open` with each harness, a title, `--json`, `codex`, an empty harness, a long title
    and no thread. Each records the exit code, stdout, stderr and the command the probe got.

## What the captures show

<!-- Filled in after the final run of run.sh origin/main HEAD. -->

## Pin tests

<!-- tests-pins.txt and tests-branch.txt: counts after the final run. -->

## Not verified

- A live control plane, node, probe or pylon. The guest is a fake that answers like Herdr 0.9.5's CLI, and the probe is
  a fake behind the real API.
- `openSession` for pi with a prompt or a model, and for a shell with a resume. The protocol refuses them, so no probe
  receives them. `capture-sessions.ts` records pi with both once, to show what would reach the guest.
- The pylon VM backend's pause and wake through a controller. `recordBeforePause` and `relaunchAfterWake` are driven
  directly, and the sidecar is read back by `list()`.
