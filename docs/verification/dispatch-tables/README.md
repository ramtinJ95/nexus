# Dispatch tables verification

Issue #140 moves three sets of scattered conditionals into tables:

- the API's health, release, deployer and event routes, and its thread streams, into `routes`, with one SSE writer,
- the probe's per-command handling into `commandPolicies` in `src/backend.ts`,
- and the probe entrypoint's backend-kind checks into optional `VmBackend` members.

Nothing a person, client or node sees changes, except one deliberate difference. A request with the wrong method on
`/v1/health`, `/v1/release`, `/v1/deployer/*` or `/v1/events` answers 405 instead of 404.

## How to rerun

```sh
docs/verification/dispatch-tables/run.sh origin/main <pins-commit> HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies this directory's scripts into each and runs them
there, so the two runs differ only by the code under test. It writes `main/`, `branch/` and `diff.txt`. It then runs
`src/control/api.test.ts` and `src/probe/server.test.ts` at the pins commit, which is main's code with only the pin
tests added, into `tests-pins.txt`, and on the branch into `tests-branch.txt`.

- `capture-api.ts` starts the real `startApi` on loopback with a real registry and the tests' fake harness. It records
  status, `content-type`, `cache-control` and body for 37 requests from each of 10 callers. It also records the raw
  bytes of event followers and thread streams through a deploy drain, a slow client, a stalled client, the 16-stream
  limit and a thread delete. The clock is frozen, so both runs print the same times. Runs of pings between two events
  depend on timing, so the normalised streams keep only each stream's last ping. The first frames are kept raw.
- `capture-probe-main.ts` runs `src/probe/main.ts` as a child process for a pylon-vm config with and without a git SSH
  key, and for a Docker config. It records stdout, stderr and the exit code on SIGTERM. It also records the first
  snapshot's grants, an answer through the host bridge, and the state root's files and modes while the probe runs and
  after it exits. `stub-tailnet.ts` changes only the listen address to loopback and makes whois name the control plane.

## What the captures show

`diff.txt` holds 82 changed lines, and every one is a request with the wrong method:

| request | main | branch |
|---|---|---|
| `POST /v1/health`, `HEAD /v1/health?…`, `POST` or `DELETE /v1/release`, `DELETE /v1/events`, from every admitted caller | 404 `no route <path>` | 405 `<METHOD> is not allowed on <path>` |
| `GET /v1/deployer/report`, `GET /v1/deployer/drain`, `POST /v1/deployer/release`, from a node with its deployer key | 404 `no deployer route <path>` | 405 `<METHOD> is not allowed on <path>` |

Everything else is byte-identical. That covers every 200, 400, 403, 409 and 415 answer and its body, the 404 text for
an unknown `/v1/deployer/` path, and the event follower's framing (`id:` and `data:` per event, then `id: <watermark>`
and `: ping` each second). It also covers a follower open across a deploy drain, a slow follower that gets every event
once and in order, a stalled follower dropped after the stall limit, both 503 texts at 16 streams, and a thread's
streams ending on its delete while the followers stay open. The probe entrypoint's output is identical too: its log
lines, its exit code 0, `grants.gitSsh` true and false, `state/events.sqlite`, `state/host-bridge.sock` at mode 600,
and no journal or bridge for Docker.

## Pin tests

These pin tests came first, in their own commits, and pass on main's code (`tests-pins.txt`, 177 of 177) and on the
branch (`tests-branch.txt`, 178 of 178): A later test-only commit fixed a race in the probe pin, which counted a
snapshot read as published by the next command when the read queue was busy. It now reads the count between two
sentinel links, which run in the read queue after every read queued before them. `run.sh` applies such later `test(`
commits on top of the pins commit, so `tests-pins.txt` runs the fixed pin on main's code.

- `src/control/api.test.ts` lists the answer of each of 9 callers to 21 requests on the health, release, deployer and
  event routes. The callers include an allowed caller who is not a deployer and a laptop holding the control node's
  key. The refactor commit changes its 405 lines, and only those, which is the deliberate difference above.
- It also pins the follower's raw frames, a follower across a deploy drain, slow and stalled followers, the shared
  limit with each 503 text, and the 409 for an expired cursor.
- `src/probe/server.test.ts` sends every command kind to a real probe and observes three things. The first is which
  kinds answer nothing while a read is held or while a send to the same Claude session is held. The second is which
  kinds start a snapshot read for observers. The third is whether a send is answered by `send-claude-outcome`. A
  mutant that made `service` wait for the reads failed it.

The branch adds a test that lists `commandPolicies` for each kind. It also adds a test that the pylon-vm backend reports
its key, journal and bridge. Typecheck and the full suite pass on the branch, 1273 of 1273 (`tests-full-branch.txt`).

## How the merged copies differed

Event followers and thread streams each had their own SSE writer. `eventStream` in `src/control/api.ts` is now the one
writer:

| | thread streams (`stream`) | `/v1/events?follow=true` | merged |
|---|---|---|---|
| limit | 503 `16 streams are open, …` | 503 `too many streams` | each caller passes its own text, so both stay |
| place in `open` | the thread's ID, taken before the watch opens | `"" as ThreadId`, which no delete matches | the thread's ID, or `null` for a follower |
| stall | timer on a write that returns false, cleared on `drain` | the same | the same, once |
| backed up | `res.writableNeedDrain` | its own `blocked` flag, set when a write returns false, cleared on `drain` | `res.writableNeedDrain`, which Node sets and clears at the same two points |
| on `drain` | renders the latest view at once | waits for the next tick | each source says what to do: render, or nothing |
| timer | every 15 s, a ping when the view has not changed | every second, the next batch and then `id: <watermark>` with `: ping` | each source gives its period and tick |
| end | stops the watch, the timer and the place, ends the response, and arms the stall | `end` only ended the response, and nothing called it. Closing cleared the timer, the stall and the place. | one `end` for both. A follower's runs only when its client leaves |

Routes had three dispatchers. The if-chain answered a matching path and method, and a request that did not match fell
through to 404. The `streams` table answered 405 to a method other than GET. `routes` answered 404 for an unknown path
and 405 for a known path with another method. Now one table does all of it with the `routes` rules. A path under
`/v1/deployer/` that matches nothing keeps the `no deployer route <path>` text. The if-chain ran before the dashboard's
`page()`, and its routes now run after it. `page()` matches no `/v1` path (`src/control/dashboard.ts` `pages`), so that
order changes nothing.

The probe's command handling was four conditionals in `src/probe/server.ts`. Each is now a field of `commandPolicies`:

| conditional on main | kinds | field |
|---|---|---|
| `links ? betweenReads(run)` | `link-port`, `unlink-port` | `lock: "reads"` |
| `sendClaude` and `launch !== undefined ? onePerClaudeSession(...)` | `send-claude` on its `session`, and `open-session` on its `resume` when it has a `prompt` | `lock` as a function that names the session |
| `sendClaude` keeping the send under `requestId` | `send-claude` | `remembered: true` |
| `links \|\| open-session \|\| close-session \|\| (send-claude && resumed)` then `publishSnapshot()` | those | `publishes`, a function for `send-claude` |
| the early return for `send-claude-outcome` | `send-claude-outcome` | a row with no lock and no publishing, whose run is `outcomeOf` |

Retry safety was in comments in `src/protocol.ts`. It is now `retrySafe`. `exec` and `send-claude` are false, as the
comments said. `open-session` is safe only for a prompted launch with a resume ID, to a probe that says
`claudeLaunchRepeatable`. `link-port` and `unlink-port` are true ("Safe to repeat"). `send-claude-outcome` is true,
because it only reads. No comment covered `close-session`, `drop-failed-session` or `service`, so they are false. The
probe client still retries no command on its own, and nothing reads `retrySafe` at run time.

`src/probe/main.ts` chose `gitSsh`, `eventJournal` and `hostBridge` with `config.backend.kind === "pylon-vm"`. The
pylon-vm backend now reports all three with the same values. The Docker backend reports a bridge only when it is given
`hostBridgePort`, which `main.ts` never gives it, so a Docker probe still leaves NEXUS_API unanswered. The slice test
gives a port and used to pass the same bridge to the probe itself.

## Not verified

- A live control plane, deployer, node or pylon. The captures run the real API and the real probe entrypoint on
  loopback, with a fake harness, a fake probe client, and no tailscaled, VM or Docker daemon.
- `npm run test:slice`, which needs Docker or KVM. It typechecks with its fixtures changed.
- The HTTPS listener. It runs the same `handle` as HTTP, and only HTTP was captured.
- Node 26, which `package.json` asks for. Everything ran on Node 24.22.1, the Node this pylon has.
