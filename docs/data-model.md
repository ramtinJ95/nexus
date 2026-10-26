# Nexus data model

This reference lists the Nexus records, their fields, and their states. Field names follow [the contracts](contracts/rationale.md) and are not final. For the reasons behind each record, see [the Nexus design](design.md).

## Records

The control plane writes every record. Probes send facts in observations, and the control plane turns them into records. No probe writes to the registry.

| Record | Fields | Comes from |
|---|---|---|
| Node | `name`, `tailnetHost`, `tailnetNodeId`, `cpuVendor`, `memoryGiB`, `state` | You add a node. Capacity and `state` come from its probe's observations |
| Project | `repoUrl`, `defaultBranch`, `defaultNode`, `resources`, `allowedHosts`, `secrets`, `logins`, `preSetup`, optional `gitIdentity` | You |
| Image | `id`, `pins`, `builtOn`, `builtAt`, `sha256`, `release` | `nexus image build`: the manifest the build node's probe wrote, and the control plane release whose recipe it built. `release` is null for an image recorded by hand |
| Template | `id`, `key`, `state`, `node`, `builtAt`, `commit` | Thread starts, which record a build, and the results of its `build-template` job |
| Thread | `id`, `title`, `project`, `status`, `conversationId`, `pylonId`, `startedBy`, `seenAt`, `lastReplyAt`, `placement`, `setup` | You, and the harness |
| Claude transcript | `thread`, `session`, `byte_offset`, `skipping`, `dropped`, `read_at`, and its entries | Reads of the Claude worker's transcript in the pylon |
| Pylon | `id`, `thread`, `node`, `template` | Thread start |
| Session | `pylon`, `id`, `herdrPane`, `harness`, `harnessSessionId`, `status`, `title`, `state`, `message` | Observations. Panes opened by hand in Herdr are adopted. A paused pylon's sessions keep their records |
| Preview | `pylon`, `service`, `httpsPort` | The control plane allocates the port, never one its node's probe still routes. Observations report when it is ready |
| Output | `thread`, `kind`, `ref` | Observations, including outputs the agent declares with `nexus output add` |
| NexusEvent | `id`, `time`, `thread`, `project`, `kind`, `payload` | Accepted pylon lifecycle reports and control-plane changes |
| Orphan | `node`, `pylonId` | Observations of a pylon the registry does not know. Only you delete it |

Three settings sit beside the records. `current` is the image every new pylon uses, and only `nexus image rollout` or `rollback` changes it, once every online node holds the image. `previous-image` is the image current before the last change, which `rollback` makes current again. `image-operation` is the running image build or rollout, or the last one, with each node's step and the probe job it last sent.

## Field values

- A pylon `id` is `pylon-<thread id>`, at most 40 characters.
- `Node.tailnetNodeId` is Tailscale's stable node ID. Probes compare callers against it.
- `Node.state` is `online` or `offline`. A node that is asleep or powered off is `offline`. That is not an error.
- A node's capacity is its CPUs and memory, its free disk, and what its pylons hold of them: `committedCpus`, `committedMemoryGiB` and `committedDiskGiB`. A pylon holds its CPUs and memory while its VM is up, from launch until it stops, and its disk size until it is deleted. A paused pylon therefore counts toward committed disk only. Its memory is free until it wakes, which is how pausing idle pylons frees a node. Docker's backend reserves nothing, so its pylons count for nothing.
- `Thread.placement` says which node the thread's pylon boots on and why: the project's default node, the node the start named, or the node `auto` chose, with the room each node would have had left after the pylon or why it could not run it. A thread started before placements were recorded has none.
- `Thread.setup` says whether the thread's pylon boots from a template, which one and the commit it checks out over it, or boots fresh and runs `.nexus/setup`, and why. A thread started before setups were recorded has none.
- `Project.repoUrl` is an SSH or HTTPS git URL, or null for a scratch project. A scratch project's pylons start from `git init` on the branch, fetch nothing, and keep nothing once the thread is deleted, so their agents publish what is worth keeping. A scratch project never has a template.
- A pylon's repository is fixed when its thread starts: a clone of `repoUrl` at the branch, or at `start --commit`, or an empty repository on the branch. Its boot records which, so a pylon keeps the repository it started with.
- `Project.secrets` holds names and the hosts each value may be sent to. The values live only in each node's secret file. A `GH_TOKEN` granted to `api.github.com` and `github.com`, which the dashboard's GitHub access sets, lets the project's agents create GitHub repositories with `gh` and push to them over HTTPS.
- `Project.logins` is a list of `claude` and `chatgpt`. Each adds the hosts its login needs to the allowlist.
- The allowlist also holds the host of an HTTPS `repoUrl`, so setup can clone the repo, and every host a secret is granted to. A pylon's allowlist adds the host of an HTTPS dotfiles repo, which every boot pulls. SSH remotes need no entry, because SSH reaches only the pylon's own remotes: its repo's and its dotfiles'. A repository created inside a pylon is never one of them, so it is pushed over HTTPS.
- `Template.key` is the project, the image, and a hash of `.nexus/setup`, `preSetup` and the allowlist. The control plane reads `.nexus/setup` at the thread's commit from the project's remote, with a shallow fetch that skips file contents. A template is reused for at most 72 hours, and only on the node it was built on and while that node reports holding it, because the registry records no template's sha256 to verify a copy against.
- `Template.state` is `building`, `ready`, or `failed`. A building template keeps its job's inputs and the envelope it last sent, so a control plane that restarts mid-build asks the probe about it instead of building again. A build that fails with a retryable code is forgotten, so the next start of its key builds again. One that fails setup stays `failed`, and the key's threads on that node boot fresh with its log until the key changes.
- `Template.commit` is the commit setup ran on. A thread booted from the template checks out its own.
- `Session.harness` is `claude-code`, `pi`, or `shell`.
- `Session.harnessSessionId` is the Claude Code session ID or the pi session file. Waking uses it to relaunch the session into its prompt. The pylon also keeps the list on its own disk, in `~/.nexus/sessions.json`. Herdr learns a Claude Code session's ID from Claude's SessionStart hook, which does not run while Claude waits at its login or trust screen. So Nexus starts every Claude Code session with `--session-id <uuid>`, and the record before a pause reads the ID from the pane's command line when Herdr has none. A session logged in with `/login` after it opened therefore resumes its conversation on wake.
- `Session.title` is the label of the session's Herdr workspace, which `nexus session open --title` sets. It is null for a session last observed by a probe from before titles were reported.
- `Session.status` is `working`, `idle`, `blocked`, `done`, or `unknown`, as Herdr last reported it while the session ran. A session never read running is `unknown`.
- `Session.state` is `running`, `paused`, or `failed`. A paused pylon's sessions are `paused`: its node reports what its pause recorded, under the IDs they ran under, from a copy the backend keeps beside the checkpoint, because the checkpoint cannot be read while paused. A pause that recorded nothing, such as with no Herdr server, keeps the sessions the pylon had and marks them `paused`. The first list read after a wake replaces them with the panes they came back in. A session the wake did not bring back is `failed`, with the reason in `Session.message`, which is null otherwise. The next wake tries it again.
- `Session.id` names a session, and is what closes it. It is the session's pane, `herdrPane`, except for a failed session left in no pane, whose `herdrPane` is null and whose `id` is `failed-` and a hash of its record. Closing that one drops it from the pylon's `~/.nexus/sessions.json`. A paused session cannot be closed until its pylon runs.
- A preview's URL is `https://<node tailnet name>:<httpsPort>/`. The API reports it as the preview's `url`, so clients never build it.
- A preview's service is a declared or ad hoc service, or `port-<port>` for a port linked with `nexus preview`, from inside the pylon or from the Mac. A linked port stays linked across pauses until `nexus unpreview` unlinks it, from inside the pylon or from the Mac, and its preview lasts as long. A declared or ad hoc service's preview lasts for the thread's life.
- A thread's listening ports are not a record. Each running pylon's observation carries them, and the API joins each with the service that owns its port and that service's preview.
- The checkout holds `refs/nexus/turn`, a parentless snapshot commit for the latest autonomous reply, and `.git/nexus-turn`, its attempted turn identity: `input:<first submission ID>` for a harness reply, or `claude:<session>:<at>` for a Claude Code turn. These are pylon disk data, not registry records, and survive pause/wake. A snapshot includes uncommitted and non-ignored untracked files without changing HEAD or the real index. The harness attempts it before the first request and reads validate its identity against the active run's first input or the last attempted reply. A Claude Code session's `UserPromptSubmit` hook attempts it before Claude acts on each prompt, and a Claude worker thread's reads validate it against the thread's newest recorded turn start. Every read also requires `.git/nexus-turn` to name the snapshot's turn, so a later attempt that failed leaves no snapshot to read, whatever turn the caller expected. The latest-only conversation document `nexus.turn-snapshot` holds `{ turn: string | null }` and records the attempt before capture, even on failure. Unlike a generation task and its memos, that document and the first input identity survive tool-round handoffs. Missing or failed snapshots are unavailable, never a fallback to the preceding turn. `Changes.base` and `Diff.base` have `{ kind: "start" | "head" | "turn", commit: string | null }`; a turn always names the snapshot commit, even in an empty repository.
- `Output.kind` is `branch`, `diff`, `preview`, `file`, or `pull-request`. A declared diff output's base is HEAD's commit, or the empty tree before the repository's first commit.

## Checkout Git observations and outputs

A running pylon's `git` observation is `GitFacts`: `head` is HEAD's object ID (the empty-tree object ID before the first commit), `branch` is its local name or null for detached HEAD, `dirty` includes staged, unstaged and non-ignored untracked changes, and `branches` lists each local branch's `name`, `head` and nullable `pushedAs`. An unborn branch has no ref yet and is absent from `branches`; its name remains in `branch`. Internal Nexus snapshot refs are not local branches and are excluded.

`pushedAs` uses an existing non-symbolic remote-tracking upstream first. Without one it uses a same-named remote-tracking ref, preferring `origin/<name>` or else a unique match on another configured remote. It is null for no match or ambiguous non-origin matches. This discovers pushes without an upstream, including `push.default=current` and agent PR workflows. It does not require local and remote-tracking tips to match, because a published branch can have unpushed local commits; shared commit IDs alone do not associate differently named branches. Tracking refs are local evidence, possibly fetched or stale, not a fresh remote query or proof of who pushed.

The probe reads only running pylons, at most once a minute per boot across snapshots; results, including failures, are cached. Reads use one guest exec, no network or index refresh, with a 2.5-second helper deadline, 3-second exec timeout, 1000-ref and reply-size limits. Failure or exceeding a limit yields null, never partial Git facts; other observations continue. The probe runs each pylon's fact reads in parallel and independently bounds their controller waits to three seconds (five for services), retaining timed-out reads until they settle to prevent duplicate outstanding RPCs. Late results are discarded. Git subprocess groups, including filter children, are killed on cleanup. Lazy fetching and Git transports are disabled for observations, so missing partial-clone objects can produce null, never a network fetch. Full branch refs avoid branch/tag ambiguity, and ref fields are NUL-delimited rather than split on Unicode line breaks. `branch` outputs use each non-null `pushedAs` as their `ref`; a dirty checkout produces a `diff` output keyed by `head`, including the empty tree for dirty scratch checkouts. Outputs accumulate even when a branch later disappears. These branch outputs feed PR discovery, which still asks GitHub for open PRs on the project's repository and uses only `origin/` outputs.

## Attention and seen

The registry stores each thread's nullable `seenAt` and `lastReplyAt` as Unix milliseconds, added by migration. A turn ending records `lastReplyAt`; streaming and parked tasks do not. Old rows start with null timestamps. If recovery finds a previously running turn ended, its reply is dated at recovery.

The API derives `attention` in order: failed pylon, `decision` (the thread's review ended for the person, as [review records](#review-records) say), parked tasks, `limited` (the Claude worker's session stopped on its usage limit, as [Claude worker conversations](#claude-worker-conversations) say), unread reply (`lastReplyAt > seenAt`, with null seen treated as unread), running harness or session turn, waiting session, then null. Parked tasks are tracked for every conversation at harness recovery, independently of client watches. Both the thread list and detail report this value and both timestamps.

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

`pr_watches` stores one JSON record per thread in the control-plane registry. `links` holds each GitHub PR snapshot (`repo`, `number`, `title`, `url`, `state`, `checks`, `review`, `conflict`), the event IDs already consumed, and whether a reported failure still awaits recovery. `commentWakes` counts consecutive comment-only messages across that thread's PRs. Only feedback with GitHub `author_association` `OWNER`, `MEMBER` or `COLLABORATOR` enters the event cursor or this count; PR authors have no exemption. `pending` holds a durable request ID and message until the harness admits it, or until it is typed into a Claude worker's session; `error` holds a credential-free retry notice. These records survive archive and process restart. Rediscovery changes a reopened link from `closed` to `open` without resetting its event cursor, pending recovery or the thread's comment-wake count. ETags and response bodies are an in-memory, per-resource cache and need not survive restart.

A linked PR contributes an `Output` with `kind: "pull-request"` and `ref` equal to its GitHub URL. `ThreadDetail.pullRequests` supplies its structured metadata. GitHub, not a probe or checkout, owns that metadata. The optional control-plane GitHub token is an exception to the node-only tool-secret rule: it is read from a separate protected file and used only for GitHub reads and a landing's merge, never sent to a pylon.

## Review records

`reviews` stores a builder thread's latest review, one JSON record per builder, with its reviewer thread in a unique column. The PR watch skips every thread started by `nexus-review`, so a reviewer stays skipped after a later review replaces the record that named it. `Review` in `src/control/review.ts` is the shape, and `ThreadDetail.review` serves it. A record is upgraded as it is read: a finding stored with `severity` reads `serious` as `P1` and `minor` as `P3`, and a `maxRounds` above 5 reads as 5.

- `id` is `rv-` and eight hex digits. It starts every token the agents echo and every request ID the loop sends under. `expect` is the token the awaited answer must echo, random per request, and `sent` counts the review's messages, numbering their request IDs `<id>:<n>`.
- `builder`, `reviewer`, `pr` (`repo`, `number`, `url`, `title`, `branch`) and `models` (`builder`, `reviewer`) say who reviews what. `reviewerKind` is `harness` or `claude`, and only a harness reviewer's approval can land. `maxRounds` is 1 to 5, 5 by default. A record stored with a higher cap reads as 5.
- `land` is null to stop at approval, or `{ requestedBy }`, the deployer who asked for the landing. `merged` is the merge commit once the PR merged, after which the review never lands again.
- `rounds` holds one entry per review of a head: `head`, the reviewer's parsed `verdict` (`verdict`, `findings` with `id`, `priority` (`P0` to `P3`), `where`, `summary`, `detail`, `reserved` cases, and `notCheckedLive`), the `check` at that head (`passed`, the output's tail), and the builder's `answers` (`id`, `action` fixed or rejected, `reason`).
- `phase` is one of `reviewing`, `fixing`, `checking` (`startedAt`, and `thread`, the check thread of the run in progress or null), `approved`, `merging` (`authorized`, the head the review is about to merge, saved before the merge call, or null), `deploying` (`commit`, `previous`, `requested`, `deadline`), `rolling-back` (`commit`, `previous`, `why`, `requested`, `deadline`), `landed` (`commit`), or `needs-person` (`reasons`, and `label`, the state of the `needs human review` label for a review whose rounds ran out: `adding`, `added`, or `failed` with `why`). `approved`, `landed` and `needs-person` have ended.
- `outbox` is the next message (`to`, `id`, `text`, and `attempted`, when its first send began, saved before that send), saved before it is sent. `since` is when the agent the loop waits on was last sent one, and `nudges` how many reminders in a row it has had.

A check thread is a bare thread, with no conversation and no Claude worker, whose `startedBy` is `nexus-check`. It lives only while its run does, and the review loop deletes any it does not hold.

`needs-person` makes the builder's attention `decision`. A new `nexus review` replaces an ended record, and `nexus land` moves an approved one, or one the policy held after its check passed, back to `checking`.

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
| `session.heartbeat` | A throttled PostToolUse hook, or a Stop hook while background tasks run, confirms activity; optional `session` and `message` |
| `session.turn-ended` | Claude's Stop hook ran with no background task running, or after one with only background shells running once they exit or 2 hours pass; optional `session` and `message` |
| `session.waiting` | Claude showed a permission or input prompt, or a background command still ran after 2 hours; optional `session` and `message` |
| `session.ended` | Claude's SessionEnd hook ran; optional `session` and `message` |
| `thread.turn-ended` | The control-plane harness completed a turn |
| `thread.failed` | Pylon or worker launch failed; `message` |
| `thread.parked` | The harness has parked tasks |
| `attention.changed` | The new nullable `attention` |
| `pull-request.feedback` | New batched GitHub feedback; `requestId` |
| `release.changed` | Desired release (`desired`) or changed component report |
| `review.changed` | A review started or changed phase or round; `review`, `reviewer`, `phase` and `round` |
| `usage-limit.continued` | The control plane typed its continue into a Claude worker whose usage limit reset; `session`, `stoppedAt`, `resetsAt` and `requestId` |

Only the five `session.*` kinds may come from a pylon. The strict boundary schema
rejects extra fields, including a thread or project supplied by the guest. Session
IDs are at most 200 characters and messages at most 2,048. The bridge supplies the
pylon identity; control maps it to its registered thread and verifies its node.
There is no arbitrary API forwarding. Never include credentials or full tool
output in a message.

A report crosses two hops, and each has its own buffer. From hook to probe, the
hook writes the event to `~/.nexus/outbox` in the pylon, one JSON file per event
named by its stamp, its process and a count of the events that process wrote, and starts a sender. The file name without `.json` is the
event's `id`, which the event carries to control. Every boot of the pylon, a wake
included, also starts a sender, because a pause stops one. The sender holds a lock
that dies with it, so one runs at a time. It lists the outbox before each delivery
and posts the oldest event until the probe answers, but first waits until the
event is two seconds old. A hook gets two seconds, so by then every hook stamped
earlier has written its event, and a turn end never goes out after a later
waiting event that control would then prefer. It deletes the event on a 200 or a
4xx, which no retry would change, and retries anything else after 0.5 seconds,
doubling to at most 10. It exits when the outbox is empty. The outbox holds at
most 1,000 events. A full one drops its oldest, so the newest state, such as the
latest turn end, is what survives. An event older than a day is dropped unsent,
and so is a temporary file a killed hook left for more than a minute. Neither
wait holds up Claude, whose hook only writes the file.

From probe to control, the production probe journals its last 100 session
reports in `events.sqlite` under its state root, and answers the hook only after
the journal commits. Observations replay that journal after a link or probe
restart; `event_receipts` deduplicates its sequence per node. This is a bounded
buffer for a control plane that is not following the probe, not an unbounded
delivery guarantee: more than 100 reports on a node while control is away loses
the oldest. A sender whose answer was lost posts the event again, and the probe
journals it under a new sequence. Control keeps the IDs of the reports it applied
at its session's latest stamp, and ignores a report that repeats one. A resend
at an older stamp already fails the stamp check. A report without an ID, such as
one from today's image or `nexus event`, is never taken for a resend, so two
different reports at the same stamp both apply. The registry cursor guarantee
begins once control has accepted an event.

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

A start gives a session a 30-minute working lease. A `session.heartbeat` renews
an existing working lease, or resumes an existing waiting session with a fresh
lease when stamped later than its waiting event. It cannot create a session or
revive an ended or expired turn.
PostToolUse hooks share a per-session five-minute throttle; no network call runs
in the hook process. Each real tool completion can renew the lease, so a turn can
run for hours without human activity. A killed, silent or fake one-shot turn start
expires. A single operation that produces no hook reports for 30 minutes has no
proof of continuing activity and also expires; no timer guesses that it is busy.
Herdr's cached Claude status cannot renew the lease. Other harness sessions retain
their existing observation-based activity rules.

A Stop hook whose `background_tasks` lists a `subagent` or `shell` with status
`running` reports `session.heartbeat` through the same throttle, so the turn is
not ended and records no reply. A subagent's tool hooks report under the main
session's ID and renew the same lease. The turn Claude starts when the last task
finishes ends it. There is no subagent record: a subagent that never finishes
lets the lease expire like any other silent turn. When only shells run, a detached
hold, owned by the session's newest Stop, sends `session.heartbeat` every five minutes while a process
group the commands lead, or a process writing to a shell's output file, lives. It
sends `session.turn-ended` 30 seconds after they stop. After 2 hours it sends
`session.turn-ended` and then `session.waiting`, both with the
message "A background command was still running after 2 hours". The hold writes its reports to the outbox as a hook does, and events one process writes at the same stamp go out in the order it wrote them. Each carries the Stop's time, so they
renew the lease by receipt time, and any later report for the session, such as the
turn a command's finish starts, makes the rest stale. A waiting session's latest
message is kept with it as `Thread.sessionWaitingMessage`, and the dashboard shows
it as the thread's state.

`Thread.sessionTurnRunning` and `sessionWaiting` are optional current facts;
`sessionActiveUntil` lets the pure planner enforce expiry even on an older read.
`Thread.workingSince` is the earliest known start, in Unix milliseconds, of the
running harness turn and the live working sessions, and is absent when none runs
or none has a known start. The harness turn's start, `agent_turn_started_at`, is
when its tracker saw the turn begin, or the retry that resumed a parked run. A working row's `started_at` is the receipt
time of its `session.turn-started`, or of the heartbeat that resumed it from
waiting; later heartbeats keep it. Turns running before the migration have no
start, and none is invented.
After expiry or an ended/waiting turn, normal agent and human idle rules apply.
Expiry itself records no new activity. Session turn ends use the existing strictly
increasing `lastReplyAt` identity. Attention keeps its precedence: failed pylon or
worker launch, decision, parked, limited, unread reply, working, waiting, then null. Seen still changes
only `seenAt`. These rules also apply to Claude sessions opened by hand when they
use the image's hooks. A Claude started inside another Claude session, or under a
HOME other than the pylon user's, reports nothing.

The hook captures `at`, the pylon's Unix-millisecond time, before throttling or
writing the event to the outbox, which delivers it unchanged. `nexus event --at MS` also preserves a timestamp;
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

`claude_workers` holds a thread's first prompt, trimmed and with `/poteto-mode`
added unless present, which Claude receives exactly, newlines and quotes included, and its launch state: `pending`,
`starting`, `started`, `stalled`, or `failed`, plus an optional failure message. It is created atomically with the thread. A
Claude-worker thread has no control-plane harness conversation. Its pending
launch runs after its pylon is observed running. `starting` is written before the
non-idempotent open command: after an interrupted launch, Nexus reports failure
rather than risking a second submission. Inspect with `attach` before opening
another session. `started` means the initial prompt reached a launch-specific UserPromptSubmit
hook, or a live Claude process is observed working, not task success. Without
either proof within 30 seconds after its launch command is typed, the launch is `stalled`; the pane remains open. `ThreadDetail.claudeWorker` exposes
`state`, nullable `model` and optional `message`, including the last 20 visible pane lines (at most
8 KiB). The same diagnostic appears in `thread.failed`; stalled and failed
workers both have `failed` attention. The worker's launch session ID is persisted
before the open command. A turn-started report from that session changes a
starting, stalled or failed worker to started and clears its current message, restoring normal
working/reply/seen attention. Another session cannot clear it. The diagnostic
remains in event history; no automatic submission is retried.

`claude_workers.turn_session` and `turn_at` hold the newest `session.turn-started`
the thread recorded, from any of its sessions, with the stamp the pylon's hook sent
as `at`. A report older than the stored stamp leaves them. Together they name the
latest turn's checkout snapshot, `claude:<session>:<at>`, which reads of the
thread's latest turn expect. Both are null until a turn starts.

Claude worker `model` is the requested model ID, persisted atomically with new
threads (default `claude-opus-5-5`). A nullable-column migration leaves old workers
unknown rather than claiming they ran Opus. Pending legacy launches use the new
default. Session checkpoint records optionally carry an explicit argv `model`
for relaunch; old records remain readable. The model is a request, not observed
provider routing. A local launch receipt or a running Claude with working status
can confirm startup despite Herdr readiness failure. No failed event is emitted
for an RPC error when the launch session already reported submission. Otherwise
the current stored failure message and `thread.failed.payload.message` agree.

## Claude worker conversations

A Claude worker thread's conversation is its session's transcript, which Claude Code
writes in the pylon as JSON lines at `~/.claude/projects/<cwd>/<session>.jsonl`. Each
character of the cwd that is not a letter or a digit becomes `-` in the folder's name,
and `claude --resume` appends to the same file. `src/claude-transcript.ts` parses each
record at the boundary into a `ClaudeEntry`, and the model only grows, so a later
record never changes an earlier entry:

| Kind | Fields | From |
|---|---|---|
| `prompt` | `text`, `from`: `person`, `command` or `other` | A prompt the person typed, a prompt Claude took from its queue mid-turn (`queued_command`), a slash command, or a prompt from a plugin |
| `reply` | `text` | An assistant text block |
| `tool` | `id`, `name`, `input` | An assistant `tool_use` block, or a `!` shell command (`shell`) |
| `result` | `toolUseId`, `output`, `isError` | A `tool_result`, or a `!` command's output. A background launch's metadata reads "Started in the background" |
| `task` | `toolUseId`, `status`, `summary`, `result` | A `<task-notification>`: a background subagent or shell finished. `result` is a subagent's answer |
| `queue` | `op`, `text` | A `queue-operation`: a message typed during a turn joined or left Claude's queue |
| `notice` | `tone`, `text`, optional `usageLimit` | An interruption, a compaction, a model error, a local command's output, or Claude Code's own `system/informational` message. `usageLimit` (`resetsAt`, Unix ms or null) marks the error an assistant record with `apiError: "usage_limit_reached"` gives, with `apiErrorParams.rate_limit_info.resetsAt` |
| `turn` | `durationMs` | `system/turn_duration` |
| `pull-request` | `number`, `url`, `repository` | A `pr-link`: Claude opened a pull request. Claude Code writes it again each time it saves the session's metadata, so clients show the first entry for each `url`. `url` is always an https URL |
| `record` | `type`, `summary` | Any record shape the parser does not know, a malformed line, or a record over 512 KiB, which is skipped |

Every entry has `at`, the record's time in Unix milliseconds. Records Claude Code keeps
for itself, such as API request copies, context attachments, file-history
snapshots and the session metadata it writes again on each save (its title, tag, mode,
agent, worktree and the like), give no entry. They are named in tables in the parser, so a new record type
shows as a `record` rather than disappearing. Prompts are cut at 32 KiB, replies at
64 KiB, tool inputs at 4 KiB per string and outputs at 8 KiB.

The registry keeps what was read. `claude_transcripts` holds per thread the session it
read, the cursor (`byte_offset` past the last complete line, `skipping` while a
record over 512 KiB is passed over, and `before_hash`, the SHA-256 of the up to 4 KiB
just before the offset), how many entries were `dropped`, and `read_at`.
`claude_entries` holds the newest 3,000 entries in order. A read appends only its new
entries and is applied only where the stored cursor stands, so a read applied twice
changes nothing. A new session ID, a file smaller than the cursor, or bytes before the
cursor that no longer match `before_hash` replace the stored entries. Archiving keeps them, and deleting the thread removes them.
`ClaudeConversation.working` is `Thread.sessionTurnRunning`.

A Claude worker's session stopped on its usage limit while the newest of the newest 16
stored entries that is not bookkeeping is a `notice` with `usageLimit`. Turn
durations, queue operations, pull requests, `record` entries and info notices are
bookkeeping. `Thread.usageLimit` and `ClaudeConversation.usageLimit` are that stop
(`stoppedAt`, the record's time, and `resetsAt`), derived on each read of the thread
rather than stored, and only while no session turn runs and no turn started after the
stop. The latest turn start is `claude_workers.turn_at`, the hook's time by the pylon's
clock, as the record's time is, so a turn's end that arrives before the read of its
prompt does not bring the stop back. Nothing else marks the stop,
so it holds whichever of the turn's end and the transcript's read comes first, and the
next prompt, turn start or Claude Code's own `auto-continuation` prompt ends it. Claude
Code reports the turn's end through its StopFailure hook, not Stop. With an image that
has no StopFailure hook, a read that ends on the stop ends the worker session's working
lease, as `session.turn-ended` would, when the session's last turn start or heartbeat is
no later than the stop, both by the pylon's clock. Such an end records no reply.

The control plane reads a transcript only while the node's last observation reports
the pylon running. The read is one raw pipe through the probe, taking at most 512 KiB
and 20 seconds, and a refresh takes at most 16 reads. It never wakes the pylon and is
not activity. A failed read keeps what is stored. Each retained `session.*` event for a
Claude worker thread triggers a read. While a turn runs and a dashboard watches the
thread, it is read every 2 seconds.

`claude_messages` records each send to a Claude worker by request ID: `sending` before
the probe is asked, then `sent` with a `ClaudeSent` (`session`, `outcome` of `sent` or
`queued`, `resumed`). A repeat of a `sent` ID answers the stored result. A send that
typed nothing, because the pylon was not running, Claude waited at a dialog or was not
ready yet, or its pane stopped running the session (`moved`), removes its row, so the same ID can be sent again. A row left `sending`
means the probe's answer never came, so a repeat asks the probe with
`send-claude-outcome` and stores what it answers, as for the first answer. If the probe
says the send failed partway, or no longer knows it, the row stays `sending` and the
repeat is refused with a 422. A thread keeps every request ID until the thread is
deleted. The control plane's continue after a usage limit uses `usage-limit:<session>:<stoppedAt>`, so each stop gets at most one.

