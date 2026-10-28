# Checking probe payloads with zod

Issue #134 replaces the hand-written checks in `src/protocol.ts` and `src/sessions.ts` with zod schemas. A person, a
client or a node sees no difference, except two. A bad request's error text changes, with the same status. And a job
error code or a session harness named after a key that every JavaScript object has, such as `toString`, is now
refused.

## How to rerun

```sh
docs/verification/protocol-zod/run.sh origin/main <pins-commit> <branch-commit>
```

`run.sh` checks out main, the branch and the pins commit into worktrees, and removes them when it ends. The pins
commit is main's code with only the pin tests added. `run.sh` copies this directory's scripts into each worktree and
runs them there, so the runs differ only in the code under test.

- `cases.ts` holds a good payload of every shape each parser reads. It also makes every mutation of each payload: for
  every field at every depth, the field removed, the field replaced by each of `null`, `""`, `"x"`, `0`, `-1`, `1.5`,
  `true`, `[]` and `{}`, and an unknown field added beside it. Edge cases a mutation cannot reach come after them, such
  as each limit and the value one past it. The total is 13,700 cases.
- `capture.ts` feeds every case through the code a node or the control plane runs. That code is the probe's real HTTP
  routes (`PUT /v1/jobs`, `POST /v1/pylons/{id}/commands`, the stream upgrade), the control plane's probe client
  against a stub probe, the parsers, and the Herdr session reads with a fake guest. It also feeds the first snapshot
  of three real probes from `docs/verification/upgrade-observations`, and envelopes as the control plane's `envelope()`
  writes them. Each line holds the HTTP status and body, the error text, or a hash of the value handed on. The hash is
  taken over `util.inspect`, so it covers key order and keys set to `undefined`. It writes `main.txt` and
  `branch.txt`.
- `compare.ts` reads both captures and writes `compare.txt`. For each entry point it counts the cases that kept the
  same outcome and the cases that kept their verdict and status with new error text. It lists every case whose
  verdict, status or value changed. Then it gives one example of each of the 130 error answers main's probe routes
  gave, beside the branch's answer to the same request.
- The pin tests (`src/protocol.test.ts` and the pins in `src/sessions.test.ts`) ran on the pins commit and on the
  branch, then the full suite on each. `tests-pins.txt` and `tests-branch.txt` hold the results, and `tests.diff`
  holds the names of the tests that passed in each.

## What the captures show

`diff main.txt branch.txt` changes 16,442 lines. Every changed line is a rejection that keeps its verdict and status
with new text, except the seven cases below.

| case | main | branch |
|---|---|---|
| a failed job whose error code is `toString` or `constructor`, in a `job` event or from `GET /v1/jobs/{id}` | accepted, so the planner's `retryable[code]` is a function, which reads as retryable | refused, as is every code `JobErrorCode` does not name |
| a sessions file whose harness is `toString` or `constructor`, read by `pausedSessionsIn` and `sessionFacts` | accepted, so a wake looks up a function as the harness's agent | refused, as is every harness `SessionHarness` does not name |

Main checked both with `in`, which also finds the keys every object inherits. No probe or pylon writes these values.

The 16 accepted-value hashes of the real probe snapshots and the control plane's envelopes are equal on both. So are
the hashes of every other accepted case.

Some error texts, as `main.txt` and `branch.txt` hold them:

| request | main | branch |
|---|---|---|
| `PUT /v1/jobs`, spawn without `job.boot.repo.kind` | `job.boot.repo has no kind, so the control plane that sent it is older than this probe. Upgrade the control plane, then its probes` | `envelope.job.boot.repo.kind: missing, so the control plane that sent it is older than this probe. Upgrade the control plane, then its probes` |
| `PUT /v1/jobs`, `job.boot.image` is `"x"` | `job.boot.image is not an image ID` | `envelope.job.boot.image: expected an image ID` |
| `PUT /v1/jobs`, `job.kind` is `null` | `unknown job kind null` | `envelope.job.kind: Invalid discriminator value. Expected 'spawn' \| 'pause' \| 'delete' \| 'build-image' \| 'build-template' \| 'fetch-artifact' \| 'drop-artifact'` |
| `POST commands`, exec `timeoutMs` is `60001` | `command.timeoutMs is not an integer from 1 to 60000` | `command.timeoutMs: Too big: expected number to be <=60000` |
| `POST commands`, open-session for `pi` with a `model` | `invalid Claude model` | `command.model: only a Claude Code session takes it` |
| `POST commands`, `unlink-port` 22 | `command.port 22 is Nexus's own` | `command.port: is Nexus's own: sshd's 22, or the preview relay's 700 to 799` |
| `POST commands`, body `not json` | `Unexpected token 'o', "not json" is not valid JSON` | `command: Unexpected token 'o', "not json" is not valid JSON` |
| stream upgrade, `argv` is `[]` | `stream request argv is not a non-empty string array` | `request.argv: Too small: expected array to have >=1 items` |

## What changed per copy

| copy | how the copies differed | what the merged one does |
|---|---|---|
| the `record`, `string`, `array` and `nullableString` helpers in `sessions.ts`, which `protocol.ts` imported | each threw its own text, and the caller passed the field's name by hand | `parse` and `parseJson` in `src/parse.ts`, which name the field from the payload's root |
| `"claude-code"`, `"pi"`, `"shell"`: the `harnesses` set in `protocol.ts`, and `in agents` in `sessions.ts` | the set took only the three names, and `in` also took inherited keys | `sessionHarnessSchema` in `project.ts`, for both |
| `string()` as a non-empty-string check in both files | one function | `nonEmpty` in `src/parse.ts` |
| a job error code: `in retryable` | took inherited keys | `z.enum` of `retryable`'s own keys |
| the types beside each check, reached through `as unknown as` | the compiler did not tie a check to its type | each schema `satisfies z.ZodType<T>` for its declared type, and a field nothing checks is named with `unchecked<T>()` |

## Unknown fields

A newer control plane or probe may send a field an older peer does not know during a deploy. No parser refuses one.
A parser that hands its payload on hands the field on with it, as main did. That covers envelopes, commands, job
statuses, observations, command results and manifests. `asSent` in `src/parse.ts` hands on the value itself once its
schema accepts it, because zod would rebuild it with the schema's keys first. A parser that builds a value of its own
leaves the field out, as main did. That covers submit replies, stream requests, the sessions file and Herdr's replies.

The one exception is a reported session event, which `reportedEventSchema` and `pylonEventSchema` already checked
strictly with zod on main. This change leaves them as they were. Only a probe newer than its control plane could send
such a field, and deploys upgrade the control plane first (`deploy/README.md`).

## What this does not cover

The captures run each parser on loopback with a stub or fake peer, not a deployed node. The real probe frames come
from the earlier `upgrade-observations` run, not from a node running this branch.
