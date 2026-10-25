# Nexus data model

This reference lists the Nexus records, their fields, and their states. Field names follow [the contracts](contracts/rationale.md) and are not final. For the reasons behind each record, see [the Nexus design](design.md).

## Records

The control plane writes every record. Probes send facts in observations, and the control plane turns them into records. No probe writes to the registry.

| Record | Fields | Comes from |
|---|---|---|
| Node | `name`, `tailnetHost`, `tailnetNodeId`, `cpuVendor`, `memoryGiB`, `state` | You add a node. Capacity and `state` come from its probe's observations |
| Project | `repoUrl`, `defaultBranch`, `defaultNode`, `resources`, `allowedHosts`, `secrets`, `logins`, `preSetup`, optional `gitIdentity` | You |
| Image | `id`, `pins`, `builtOn`, `builtAt` | The results of `build-image` jobs |
| Template | `id`, `key`, `state`, `node`, `builtAt` | The results of `build-template` jobs |
| Thread | `id`, `title`, `project`, `status`, `conversationId`, `pylonId`, `startedBy`, `seenAt`, `lastReplyAt` | You, and the harness |
| Pylon | `id`, `thread`, `node`, `template` | Thread start |
| Session | `pylon`, `id`, `herdrPane`, `harness`, `harnessSessionId`, `status`, `title`, `state`, `message` | Observations. Panes opened by hand in Herdr are adopted. A paused pylon's sessions keep their records |
| Preview | `pylon`, `service`, `httpsPort` | The control plane allocates the port, never one its node's probe still routes. Observations report when it is ready |
| Output | `thread`, `kind`, `ref` | Observations, including outputs the agent declares with `nexus output add` |
| NexusEvent | `id`, `time`, `thread`, `project`, `kind`, `payload` | Accepted pylon lifecycle reports and control-plane changes |
| Orphan | `node`, `pylonId` | Observations of a pylon the registry does not know. Only you delete it |

One setting sits beside the records: `current`, the image every new pylon uses. A build that passes its smoke boot becomes current.

## Field values

- A pylon `id` is `pylon-<thread id>`, at most 40 characters.
- `Node.tailnetNodeId` is Tailscale's stable node ID. Probes compare callers against it.
- `Node.state` is `online` or `offline`. A node that is asleep or powered off is `offline`. That is not an error.
- `Project.repoUrl` is an SSH or HTTPS git URL, or null for a scratch project. A scratch project's pylons start from `git init` on the branch, fetch nothing, and keep nothing once the thread is deleted, so their agents publish what is worth keeping. A scratch project never has a template.
- A pylon's repository is fixed when its thread starts: a clone of `repoUrl` at the branch, or at `start --commit`, or an empty repository on the branch. Its boot records which, so a pylon keeps the repository it started with.
- `Project.secrets` holds names and the hosts each value may be sent to. The values live only in each node's secret file. A `GH_TOKEN` granted to `api.github.com` and `github.com`, which the dashboard's GitHub access sets, lets the project's agents create GitHub repositories with `gh` and push to them over HTTPS.
- `Project.logins` is a list of `claude` and `chatgpt`. Each adds the hosts its login needs to the allowlist.
- The allowlist also holds the host of an HTTPS `repoUrl`, so setup can clone the repo, and every host a secret is granted to. A pylon's allowlist adds the host of an HTTPS dotfiles repo, which every boot pulls. SSH remotes need no entry, because SSH reaches only the pylon's own remotes: its repo's and its dotfiles'. A repository created inside a pylon is never one of them, so it is pushed over HTTPS.
- `Template.key` is the project, the image, and a hash of `.nexus/setup`, `preSetup` and the allowlist. A template is reused for at most 72 hours.
- `Template.state` is `building`, `ready`, or `failed`.
- `Session.harness` is `claude-code`, `pi`, or `shell`.
- `Session.harnessSessionId` is the Claude Code session ID or the pi session file. Waking uses it to relaunch the session into its prompt. The pylon also keeps the list on its own disk, in `~/.nexus/sessions.json`. Herdr learns a Claude Code session's ID from Claude's SessionStart hook, which does not run while Claude waits at its login or trust screen. So Nexus starts every Claude Code session with `--session-id <uuid>`, and the record before a pause reads the ID from the pane's command line when Herdr has none. A session logged in with `/login` after it opened therefore resumes its conversation on wake.
- `Session.title` is the label of the session's Herdr workspace, which `nexus session open --title` sets. It is null for a session last observed by a probe from before titles were reported.
- `Session.status` is `working`, `idle`, `blocked`, `done`, or `unknown`, as Herdr last reported it while the session ran. A session never read running is `unknown`.
- `Session.state` is `running`, `paused`, or `failed`. A paused pylon's sessions are `paused`: its node reports what its pause recorded, under the IDs they ran under, from a copy the backend keeps beside the checkpoint, because the checkpoint cannot be read while paused. A pause that recorded nothing, such as with no Herdr server, keeps the sessions the pylon had and marks them `paused`. The first list read after a wake replaces them with the panes they came back in. A session the wake did not bring back is `failed`, with the reason in `Session.message`, which is null otherwise. The next wake tries it again.
- `Session.id` names a session, and is what closes it. It is the session's pane, `herdrPane`, except for a failed session left in no pane, whose `herdrPane` is null and whose `id` is `failed-` and a hash of its record. Closing that one drops it from the pylon's `~/.nexus/sessions.json`. A paused session cannot be closed until its pylon runs.
- A preview's URL is `https://<node tailnet name>:<httpsPort>/`. The API reports it as the preview's `url`, so clients never build it.
- A preview's service is a declared or ad hoc service, or `port-<port>` for a port linked with `nexus preview`, from inside the pylon or from the Mac. A linked port stays linked across pauses until `nexus unpreview` unlinks it, from inside the pylon or from the Mac, and its preview lasts as long. A declared or ad hoc service's preview lasts for the thread's life.
- A thread's listening ports are not a record. Each running pylon's observation carries them, and the API joins each with the service that owns its port and that service's preview.
- The checkout holds `refs/nexus/turn`, a parentless snapshot commit for the latest autonomous reply, and `.git/nexus-turn`, its attempted reply identity (`input:<first submission ID>`). These are pylon disk data, not registry records, and survive pause/wake. A snapshot includes uncommitted and non-ignored untracked files without changing HEAD or the real index. The harness attempts it before the first request and reads validate its identity against the active run's first input or the last attempted reply. The latest-only conversation document `nexus.turn-snapshot` holds `{ turn: string | null }` and records the attempt before capture, even on failure. Unlike a generation task and its memos, that document and the first input identity survive tool-round handoffs. Missing or failed snapshots are unavailable, never a fallback to the preceding turn. `Changes.base` and `Diff.base` have `{ kind: "start" | "head" | "turn", commit: string | null }`; a turn always names the snapshot commit, even in an empty repository.
- `Output.kind` is `branch`, `diff`, `preview`, `file`, or `pull-request`. A declared diff output's base is HEAD's commit, or the empty tree before the repository's first commit.

## Checkout Git observations and outputs

A running pylon's `git` observation is `GitFacts`: `head` is HEAD's object ID (the empty-tree object ID before the first commit), `branch` is its local name or null for detached HEAD, `dirty` includes staged, unstaged and non-ignored untracked changes, and `branches` lists each local branch's `name`, `head` and nullable `pushedAs`. An unborn branch has no ref yet and is absent from `branches`; its name remains in `branch`. Internal Nexus snapshot refs are not local branches and are excluded.

`pushedAs` uses an existing non-symbolic remote-tracking upstream first. Without one it uses a same-named remote-tracking ref, preferring `origin/<name>` or else a unique match on another configured remote. It is null for no match or ambiguous non-origin matches. This discovers pushes without an upstream, including `push.default=current` and agent PR workflows. It does not require local and remote-tracking tips to match, because a published branch can have unpushed local commits; shared commit IDs alone do not associate differently named branches. Tracking refs are local evidence, possibly fetched or stale, not a fresh remote query or proof of who pushed.

The probe reads only running pylons, at most once a minute per boot across snapshots; results, including failures, are cached. Reads use one guest exec, no network or index refresh, with a 2.5-second helper deadline, 3-second exec timeout, 1000-ref and reply-size limits. Failure or exceeding a limit yields null, never partial Git facts; other observations continue. The probe runs each pylon's fact reads in parallel and independently bounds their controller waits to three seconds (five for services), retaining timed-out reads until they settle to prevent duplicate outstanding RPCs. Late results are discarded. Git subprocess groups, including filter children, are killed on cleanup. Lazy fetching and Git transports are disabled for observations, so missing partial-clone objects can produce null, never a network fetch. Full branch refs avoid branch/tag ambiguity, and ref fields are NUL-delimited rather than split on Unicode line breaks. `branch` outputs use each non-null `pushedAs` as their `ref`; a dirty checkout produces a `diff` output keyed by `head`, including the empty tree for dirty scratch checkouts. Outputs accumulate even when a branch later disappears. These branch outputs feed PR discovery, which still asks GitHub for open PRs on the project's repository and uses only `origin/` outputs.

## Attention and seen

The registry stores each thread's nullable `seenAt` and `lastReplyAt` as Unix milliseconds, added by migration. A turn ending records `lastReplyAt`; streaming and parked tasks do not. Old rows start with null timestamps. If recovery finds a previously running turn ended, its reply is dated at recovery.

The API derives `attention` in order: failed pylon, parked tasks, unread reply (`lastReplyAt > seenAt`, with null seen treated as unread), running harness or session turn, waiting session, then null. Parked tasks are tracked for every conversation at harness recovery, independently of client watches. Both the thread list and detail report this value and both timestamps.

Each recorded reply timestamp is strictly greater than the preceding reply and seen marker, nudged forward by a millisecond if needed, so reply identities and unread ordering survive same-millisecond events and clock corrections.

Mark seen changes only `seenAt`. An optional `lastReplyAt` in the request caps the mark at the reply the client rendered; null marks nothing. Ordinary seen marks never move backward, so a stale page cannot undo another client's seen mark. Mark unread sets it one millisecond before the latest reply, or null without a reply. Neither is human activity, changes the pylon, nor wakes it, including on archived threads.

## Pylon states

A pylon's desired and actual states are computed on every reconcile tick and never stored.

The desired phase is `running`, `paused`, or `deleted`. It follows the thread:

| Thread state | Desired phase |
|---|---|
| `active` or `idle` | `running` while a harness or reported session turn runs, or the agent was active in the last 5 minutes, or a human in the last 20. Otherwise `paused` |
| `archived` | `paused` at once |
| `deleted` | `deleted` |

A message, an attached terminal, a dashboard visit or a preview hit counts as human activity, so each one wakes a paused pylon.

The actual state comes from the probe's last observation and the job in flight:

| State | Meaning |
|---|---|
| `spawning` | A `spawn` job is creating the pylon, or booting it from its checkpoint |
| `running` | The VM is up, services are started, and sessions are relaunched |
| `pausing` | A `pause` job is recording sessions, stopping services, and writing the checkpoint |
| `paused` | Only the checkpoint exists |
| `deleting` | A `delete` job is removing the disk and logs |
| `absent` | The node does not have the pylon. It is not created yet, it was deleted, or it was lost. The thread's status tells which. The dashboard shows it as "not on its node" |
| `failed` | The planner gave up after a job failure it cannot retry, or after 5 attempts. The reason names the last job's code, its message and the end of its log. A human retries with `POST /v1/threads/<id>/pylon/retry` or the dashboard's Retry button, which clears the reason and the attempts even after a failure the planner may not retry. A pylon whose setup failed before its first checkpoint holds no work, so its node removes it, and a retry boots it fresh and runs setup again. A broken pylon is paused onto its newest disk after a retry, which discards the broken VM, and then resumed. A pause never saves a disk whose setup failed: a VM with no checkpoint is removed, so it boots fresh and runs setup again. When the node reports that the disk already holds a failed setup, or has a checkpoint a pause would save it onto, every boot of that disk would repeat it, so the pylon is neither paused nor retried, and the thread must start again. So is a broken pylon whose node gives a cause this control plane does not know, or none. A deleted thread's pylon shows its delete instead |
| `unknown` | The node is offline. The dashboard shows the last observation, marked stale |

## Reconciling desired and actual state

On every observation and every 5 seconds, the control plane's planner compares each pylon's desired phase with what its probe reports. It sends the probe only the next job that closes the difference. Every job gives the same end state when it runs twice, or after an earlier run stopped partway. A deleted thread's pylon is gone once its node has neither the VM nor a preview routed to it, so a pylon whose VM was removed by hand still gets a `delete` that unpublishes its previews. A checkpoint is removed only by `delete` of a pylon the registry knows, so a wiped registry never deletes a pylon's disk.

## PR watch records

`pr_watches` stores one JSON record per thread in the control-plane registry. `links` holds each GitHub PR snapshot (`repo`, `number`, `title`, `url`, `state`, `checks`, `review`, `conflict`), the event IDs already consumed, and whether a reported failure still awaits recovery. `commentWakes` counts consecutive comment-only messages across that thread's PRs. Only feedback with GitHub `author_association` `OWNER`, `MEMBER` or `COLLABORATOR` enters the event cursor or this count; PR authors have no exemption. `pending` holds a durable request ID and message until the harness admits it; `error` holds a credential-free retry notice. These records survive archive and process restart. Rediscovery changes a reopened link from `closed` to `open` without resetting its event cursor, pending recovery or the thread's comment-wake count. ETags and response bodies are an in-memory, per-resource cache and need not survive restart.

A linked PR contributes an `Output` with `kind: "pull-request"` and `ref` equal to its GitHub URL. `ThreadDetail.pullRequests` supplies its structured metadata. GitHub, not a probe or checkout, owns that metadata. The optional control-plane GitHub token is an exception to the node-only tool-secret rule: it is read from a separate protected file and used only for GitHub reads, never sent to a pylon.

## Releases and deployment drain

The `settings` key `release` stores one desired release: the full commit, `requestedBy` stable tailnet node ID and `requestedAt` epoch milliseconds. A later request replaces it. The node validates main ancestry before building. No request history or pylon image is stored in this record.

`release_reports` stores a JSON `ReleaseReport` keyed by `(node, role)`. It records the currently linked `commit`, attempted `target`, state, nullable failure reason and control receipt time `observedAt`. Roles are control and probe. The API synthesizes pending rows for missing reports and marks reports older than 90 seconds stale. A role that rolled back still reports the previous running commit and failed target, so desired and observed cannot be confused. `src/deploy/model.ts` defines the client view and wait outcome.

The settings key `deploy-drain` holds `{commit, expiresAt, locked?}` or null. The control node alone acquires/renews/releases it with root-authenticated requests. It survives control process restart. Preparation leases expire without a live worker; the final idle fence sets `locked: true` before a link switch, holding admission through recovery until explicit release. The shared turn gate fences both API and background PR-watch submissions; idle additionally requires no entering submissions, committed live runs or queued inputs.

On each node, root owns `/opt/nexus/<role>-deploy.json`: `{commit, previous, target, state, reason}`, where previous/target are symlink targets and state is installing, healthy, rolled-back or failed. Installing is recorded before activation. A restart recovers it before contacting control. `<role>-deploy.unit` saves the previous unit and `<role>-deploy-report.json` retains terminal failures for later reporting and avoids automatic retries. Those files are separate from service-user-writable state and are not registry records.

## Project edits and boot identity

`Project.gitIdentity` is optional `{ name: string, email: string }` (null also means inherit). The optional control.json `gitIdentity` has the same shape without null. Project values override the control default. Only name and email are carried: no credentials. Before a fresh or checkpoint boot, reconciliation resolves the identity into `BootInputs.gitIdentity`. The boot hook applies it globally for `user` after common dotfiles. The saved value renders PYLON.md while the pylon runs. With neither configured, no git config is changed; an earlier identity on disk remains.

`PATCH /v1/projects/<id>` replaces supplied editable settings without changing the ID or repo URL. No schema migration is required: projects and boot inputs are JSON records and older records lack the optional field. Network settings, resources and repository initialization remain frozen in the existing thread's boot record. A checkpoint wake uses that saved network, even following archive/unarchive. New grants require a new thread. The derived `ThreadDetail.pylon.grantsOutdated` compares the saved network policy and secret grants with the project's current effective policy (including the pylon's dotfiles host); it does not compare node secret values. No edit changes a running VM's network or secrets.

## Nexus events and Claude workers

`NexusEvent` is defined in `src/events.ts`. It has `id` (a decimal string), `time`
(control-plane receipt time in Unix milliseconds), nullable `thread` and `project`,
`kind`, and a small JSON `payload`. IDs increase globally, not per thread. The
registry's `events` table retains the most recent 10,000 records across restarts.
A cursor means **strictly after this ID**. Reconnecting within retention replays
all matching events; an expired nonzero cursor is refused rather than silently
skipping a gap. No cursor, or `0`, reads the retained history, not all-time history.
Thread, project and kind filters run against indexed SQL columns before payload
JSON is decoded. Each stream batch carries a scanned watermark: an id-only SSE
keep-alive advances it past skipped events only after every matching record in
the batch has been sent. Quiet filtered followers therefore advance through
retention rollover without inventing a gap. Backed-up followers cannot advance
past matching records they have not consumed.

| Kind | Meaning and payload |
|---|---|
| `session.turn-started` | Claude submitted a prompt; optional `session` and `message` |
| `session.heartbeat` | A throttled PostToolUse hook confirms activity; optional `session` and `message` |
| `session.turn-ended` | Claude's Stop hook ran; optional `session` and `message` |
| `session.waiting` | Claude notified that input is needed; optional `session` and `message` |
| `session.ended` | Claude's SessionEnd hook ran; optional `session` and `message` |
| `thread.turn-ended` | The control-plane harness completed a turn |
| `thread.failed` | Pylon or worker launch failed; `message` |
| `thread.parked` | The harness has parked tasks |
| `attention.changed` | The new nullable `attention` |
| `pull-request.feedback` | New batched GitHub feedback; `requestId` |
| `release.changed` | Desired release (`desired`) or changed component report |

Only the five `session.*` kinds may come from a pylon. The strict boundary schema
rejects extra fields, including a thread or project supplied by the guest. Session
IDs are at most 200 characters and messages at most 2,048. The bridge supplies the
pylon identity; control maps it to its registered thread and verifies its node.
There is no arbitrary API forwarding. Never include credentials or full tool
output in a message.

The production probe journals its last 100 session reports in `events.sqlite`
under its state root. Observations replay that journal after a link or probe
restart; `event_receipts` deduplicates its sequence per node. This is a bounded
outage buffer, not an unbounded delivery guarantee. The hooks detach a CLI process
with a 1.5-second request deadline. A hook cannot block Claude on a disconnected
control plane; reports can be lost if the local probe itself is unavailable, or
an outage exceeds the probe's buffer. The registry cursor guarantee begins once
control has accepted an event.

`session_activity` holds at most 16 rows per thread, evicting the least recently
updated row (insertion order breaks ties). Turn end and SessionEnd remove the row;
reply identity stays in `lastReplyAt`. Working rows expire after 30 minutes
without a session report, using control receipt time, never a guest timestamp.
Waiting rows do not expire or refresh activity: an unanswered question stays
waiting until a later session event, archive or deletion. They still count toward
the 16-row cap.
Pruning runs on registry open, reconcile passes and event retention writes, and
publishes attention changes. Pre-migration working rows have no receipt time and
expire on upgrade rather than receiving an invented fresh lease.

A start gives a session a 30-minute working lease. A `session.heartbeat` only
renews an existing working lease; it cannot start one, resume waiting, or revive
an ended or expired turn.
PostToolUse hooks share a per-session five-minute throttle; no network call runs
in the hook process. Each real tool completion can renew the lease, so a turn can
run for hours without human activity. A killed, silent or fake one-shot turn start
expires. A single operation that produces no hook reports for 30 minutes has no
proof of continuing activity and also expires; no timer guesses that it is busy.
Herdr's cached Claude status cannot renew the lease. Other harness sessions retain
their existing observation-based activity rules.

`Thread.sessionTurnRunning` and `sessionWaiting` are optional current facts;
`sessionActiveUntil` lets the pure planner enforce expiry even on an older read.
After expiry or an ended/waiting turn, normal agent and human idle rules apply.
Expiry itself records no new activity. Session turn ends use the existing strictly
increasing `lastReplyAt` identity. Attention keeps its precedence: failed pylon or
worker launch, parked, unread reply, working, waiting, then null. Seen still changes
only `seenAt`. These rules also apply to Claude sessions opened by hand when they
use the image's hooks.

The hook captures `at`, the pylon's Unix-millisecond time, before throttling or
spawning its detached sender. `nexus event --at MS` preserves that timestamp;
manual event commands default to their own current time. The probe validates it
but never uses it for identity. Control ignores reports older than the last
applied report for that session. For equal timestamps, waiting or terminal state
wins over start/heartbeat. Old images without `at` fall back to probe receipt time.
Source time orders reports only; it cannot extend a receipt-time working lease.

Ordering survives activity-row deletion and control restart: `session_order`
keeps at most 32 per-session cursors per thread, including terminal cursors.
Evicting an old cursor advances a per-thread `session_order_floor`; reports for
sessions whose cursor is gone must be newer than that floor. This conservatively
rejects very delayed reports rather than allowing an old start to resurrect a
turn, without unbounded tombstones. Thread deletion removes both cursor tables;
archived/deleted threads ignore session reports.

`claude_workers` holds a thread's first prompt and launch state: `pending`,
`starting`, `started`, or `failed`. It is created atomically with the thread. A
Claude-worker thread has no control-plane harness conversation. Its pending
launch runs after its pylon is observed running. `starting` is written before the
non-idempotent open command: after an interrupted launch, Nexus reports failure
rather than risking a second submission. Inspect with `attach` before opening
another session. A launch that reaches Claude's login screen can be `started`
without running its task; `started` means the session opened, not task success.
`ThreadDetail.claudeWorker.state` exposes this state.
