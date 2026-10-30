# Nexus data model

This reference lists the Nexus records, their fields, and their states. Field names follow [the contracts](contracts/rationale.md) and are not final. For the reasons behind each record, see [the Nexus design](design.md).

## Records

The control plane writes every record. Probes send facts in observations, and the control plane turns them into records. No probe writes to the registry.

| Record | Fields | Comes from |
|---|---|---|
| Node | `name`, `tailnetHost`, `tailnetNodeId`, `cpuVendor`, `memoryGiB`, `state` | You add a node. Capacity and `state` come from its probe's observations |
| Project | `repoUrl`, `defaultBranch`, `defaultNode`, `resources`, `allowedHosts`, `secrets`, `logins`, `preSetup`, optional `gitIdentity`, `autoReview` and `pipeline` | You |
| Image | `id`, `pins`, `builtOn`, `builtAt`, `sha256`, `release` | `nexus image build`: the manifest the build node's probe wrote, and the control plane release whose recipe it built. `release` is null for an image recorded by hand |
| Template | `id`, `key`, `state`, `node`, `builtAt`, `commit` | Thread starts, which record a build, and the results of its `build-template` job |
| Thread | `id`, `title`, `project`, `status`, `conversationId`, `pylonId`, `startedBy`, `seenAt`, `lastReplyAt`, `placement`, `setup` | You, and the harness |
| Queued thread | `id`, `title`, `project`, `startedBy`, `createdAt`, `after`, `request`, `message`, `status`, `startNow`, `lastError`, `startedAt`, `firstMessage` | `nexus start --after`, until the thread starts. [Queued thread records](#queued-thread-records) describes it |
| Claude transcript | `thread`, `session`, `byte_offset`, `skipping`, `dropped`, `read_at`, and its entries | Reads of the Claude worker's transcript in the pylon |
| Pylon | `id`, `thread`, `node`, `template` | Thread start |
| Session | `pylon`, `id`, `herdrPane`, `harness`, `harnessSessionId`, `status`, `title`, `state`, `message` | Observations. Panes opened by hand in Herdr are adopted. A paused pylon's sessions keep their records |
| Preview | `pylon`, `service`, `httpsPort` | The control plane allocates the port, never one its node's probe still routes. Observations list it once its node has published it and warmed its URL |
| Output | `thread`, `kind`, `ref` | Observations, including outputs the agent declares with `nexus output add` |
| NexusEvent | `id`, `time`, `thread`, `project`, `kind`, `payload` | Accepted pylon lifecycle reports and control-plane changes |
| Question | `id`, `thread`, `text`, `options`, `reserved`, `answerer`, `askedAt`, optional `proposal` and `ask`, `answer` | A failure judgment that leaves its failure to the person, one item a planning thread proposed, or a Claude worker's AskUserQuestion call while its dialog waits, and the person's answer. [Question records](#question-records) describes it |
| Judgment | `failure`, `thread`, `node`, `failed`, `startedAt`, `request`, `conversation`, `reply`, `phase` | The judgment pass, for a builder's failed pylon. [Judgment records](#judgment-records) describes it |
| Aborted conversation | `conversation` | The harness, once it aborts a deleted thread's conversation at a delete or at open. Open aborts only the deleted threads' conversations without one, which a delete that crashed partway left running |
| Usage record | `id`, `thread`, `project`, `role`, `agent`, `model`, `at`, `input`, `output`, `cacheWrite`, `cacheRead` | Reads of the harness and of the agents' transcripts in each pylon. [Token usage records](#token-usage-records) describes it |

Three settings sit beside the records. `current` is the image every new pylon uses, and only `nexus image rollout` or `rollback` changes it, once every online node holds the image. `previous-image` is the image current before the last change, which `rollback` makes current again. `image-operation` is the running image build or rollout, or the last one, with each node's step and the probe job it last sent.

## Field values

- A pylon `id` is `pylon-<thread id>`, at most 40 characters.
- A thread's agent is a harness conversation, a Claude worker, or none, as a check thread has. The registry stores no kind: a harness thread has a `conversationId`, a Claude worker thread has a row in `claude_workers`, and a start gives a thread one or the other, never both. `Registry.agent` derives the kind from those two facts and is the only code that reads them for it. The API, the dashboard, the inbox and the review loop take what each kind does from it, through `src/control/thread-agent.ts`. The wire still carries each kind's own shapes: `conversationId`, `ThreadDetail.claudeWorker`, a `ConversationView` or a `ClaudeConversation`, and `/events` or `/claude/events`.
- `Node.name` is the node's tailnet machine name: lowercase letters, digits and hyphens, starting with a letter or digit, at most 63 characters, and never `auto`. `control.json` and each node's `probe.json` take a name by the same rule.
- `Node.tailnetNodeId` is Tailscale's stable node ID. Probes compare callers against it.
- `Node.state` is `online` or `offline`. A node that is asleep or powered off is `offline`. That is not an error.
- A node's capacity is its CPUs and memory, its free disk, and what its pylons hold of them: `committedCpus`, `committedMemoryGiB` and `committedDiskGiB`. A pylon holds its CPUs and memory while its VM is up, from launch until it stops, and its disk size until it is deleted. A paused pylon therefore counts toward committed disk only. Its memory is free until it wakes, which is how pausing idle pylons frees a node. Docker's backend reserves nothing, so its pylons count for nothing. Committed CPUs and memory count every VM whose controller is alive, check and reviewer threads and orphaned VMs among them.
- `Project.defaultNode` names a node, or is `auto`, so each thread that names no node boots where its pylon fits best. New projects default to `auto`.
- `NodeSummary.overcommitted` is true when a node's committed memory exceeds its memory. `NodeSummary.pylons` sorts the pylons in its latest observation into `up`, `paused`, `archived` and `crashed`, each with a count and the CPUs and memory their boots asked for, and `orphaned`, the IDs of VMs the registry has not placed on the node. It is null for a node never observed.
- `Thread.placement` says which node the thread's pylon boots on and why: the project's default node, the node the start named, or the node `auto` chose, with the room each node would have had left after the pylon or why it could not run it. A thread started before placements were recorded has none.
- `Thread.setup` says whether the thread's pylon boots from a template, which one and the commit it checks out over it, or boots fresh and runs `.nexus/setup`, and why. A thread started before setups were recorded has none.
- `Project.repoUrl` is an SSH or HTTPS git URL, or null for a scratch project. A scratch project's pylons start from `git init` on the branch, fetch nothing, and keep nothing once the thread is deleted, so their agents publish what is worth keeping. A scratch project never has a template.
- A thread's size is its project's `resources`, with any field `POST /v1/threads` gives in its own `resources` taking that field's place. It is fixed in the pylon's `boot.resources` when the thread starts, so every wake, unarchive and retry boots the same size, and a later edit of the project's resources changes only new threads. `ThreadDetail.pylon.resources` reports it.
- A pylon's repository is fixed when its thread starts: a clone of `repoUrl` at the branch, or at `start --commit`, or an empty repository on the branch. Its boot records which, so a pylon keeps the repository it started with.
- `Project.secrets` holds names and the hosts each value may be sent to. The values live only in each node's secret file. A `GH_TOKEN` granted to `api.github.com` and `github.com`, which the dashboard's GitHub access sets, lets the project's agents create GitHub repositories with `gh` and push to them over HTTPS.
- `Project.logins` is a list of `claude` and `chatgpt`. Each adds the hosts its login needs to the allowlist.
- The allowlist also holds the host of an HTTPS `repoUrl`, so setup can clone the repo, and every host a secret is granted to. A pylon's allowlist adds the host of an HTTPS dotfiles repo, which every boot pulls. SSH remotes need no entry, because SSH reaches only the pylon's own remotes: its repo's and its dotfiles'. A repository created inside a pylon is never one of them, so it is pushed over HTTPS.
- `Template.key` is the project, the image, and a hash of `.nexus/setup`, `preSetup`, the allowlist and the project's disk size, which is the template's disk. The control plane reads `.nexus/setup` at the thread's commit from the project's remote, with a shallow fetch that skips file contents. A template is reused for at most 72 hours, and only on the node it was built on and while that node reports holding it, because the registry records no template's sha256 to verify a copy against.
- `Template.state` is `building`, `ready`, or `failed`. A building template keeps its job's inputs and the envelope it last sent, so a control plane that restarts mid-build asks the probe about it instead of building again. A build that fails with a retryable code is forgotten, so the next start of its key builds again. One that fails setup stays `failed`, and the key's threads on that node boot fresh with its log until the key changes.
- `Template.commit` is the commit setup ran on. A thread booted from the template checks out its own.
- `Session.harness` is `claude-code`, `pi`, or `shell`.
- `Session.harnessSessionId` is the Claude Code session ID or the pi session file. Waking uses it to relaunch the session into its prompt. The pylon also keeps the list on its own disk, in `~/.nexus/sessions.json`. Herdr learns a Claude Code session's ID from Claude's SessionStart hook, which does not run while Claude waits at its login or trust screen. So Nexus starts every Claude Code session with `--session-id <uuid>`, and the record before a pause reads the ID from the pane's command line when Herdr has none. A session logged in with `/login` after it opened therefore resumes its conversation on wake.
- `Session.title` is the label of the session's Herdr workspace, which `nexus session open --title` sets. It is null for a session last observed by a probe from before titles were reported.
- `Session.status` is `working`, `idle`, `blocked`, `done`, or `unknown`, as Herdr last reported it while the session ran. A session never read running is `unknown`.
- `Session.state` is `running`, `paused`, or `failed`. A paused pylon's sessions are `paused`: its node reports what its pause recorded, under the IDs they ran under, from a copy the backend keeps beside the checkpoint, because the checkpoint cannot be read while paused. A pause that recorded nothing, such as with no Herdr server, keeps the sessions the pylon had and marks them `paused`. Once the pylon runs again they are no longer `paused`, whether or not its node has read them yet: each runs in the pane it had, with status `unknown`, and one in no pane, which its last wake failed to bring back, is `failed` until a read says otherwise. The first list read after the wake replaces them with the panes they came back in and the status Herdr reports. A session the wake did not bring back is `failed`, with the reason in `Session.message`, which is null otherwise. The next wake tries it again.
- `Session.id` names a session, and is what closes it. It is the session's pane, `herdrPane`, except for a failed session left in no pane, whose `herdrPane` is null and whose `id` is `failed-` and a hash of its record. Closing that one drops it from the pylon's `~/.nexus/sessions.json`. A paused session cannot be closed until its pylon runs.
- A preview's URL is `https://<node tailnet name>:<httpsPort>/`. The API reports it as the preview's `url`, so clients never build it.
- A preview's service is a declared or ad hoc service, or `port-<port>` for a port linked with `nexus preview`, from inside the pylon or from the Mac. A linked port stays linked across pauses until `nexus unpreview` unlinks it, from inside the pylon or from the Mac, and its preview lasts as long. A declared or ad hoc service's preview lasts for the thread's life.
- A thread's listening ports are not a record. Each running pylon's observation carries them, and the API joins each with the service that owns its port and that service's preview.
- The checkout holds `refs/nexus/turn`, a parentless snapshot commit for the latest autonomous reply, and `.git/nexus-turn`, its attempted turn identity: `input:<first submission ID>` for a harness reply, or `claude:<session>:<at>` for a Claude Code turn. These are pylon disk data, not registry records, and survive pause/wake. A snapshot includes uncommitted and non-ignored untracked files without changing HEAD or the real index. The harness attempts it before the first request and reads validate its identity against the active run's first input or the last attempted reply. A Claude Code session's `UserPromptSubmit` hook attempts it before Claude acts on each prompt, and a Claude worker thread's reads validate it against the thread's newest recorded turn start. Every read also requires `.git/nexus-turn` to name the snapshot's turn, so a later attempt that failed leaves no snapshot to read, whatever turn the caller expected. The latest-only conversation document `nexus.turn-snapshot` holds `{ turn: string | null }` and records the attempt before capture, even on failure. Unlike a generation task and its memos, that document and the first input identity survive tool-round handoffs. Missing or failed snapshots are unavailable, never a fallback to the preceding turn. `Changes.base` and `Diff.base` have `{ kind: "start" | "head" | "turn", commit: string | null }`; a turn always names the snapshot commit, even in an empty repository.
- `Output.kind` is `branch`, `diff`, `preview`, `file`, or `pull-request`. A declared diff output holds the changes since HEAD as the Changes view reads them, in a binary diff that `git apply` takes, with renames as renames and an ignored file the agent force-added included. Its base is HEAD's commit, or the empty tree before the repository's first commit.

## Checkout Git observations and outputs

A running pylon's `git` observation is `GitFacts`: `head` is HEAD's object ID (the empty-tree object ID before the first commit), `branch` is its local name or null for detached HEAD, `dirty` includes staged, unstaged and non-ignored untracked changes, and `branches` lists each local branch's `name`, `head` and nullable `pushedAs`. An unborn branch has no ref yet and is absent from `branches`; its name remains in `branch`. Internal Nexus snapshot refs are not local branches and are excluded.

`pushedAs` counts only remote-tracking refs whose reflog records a push from this checkout (`update by push`), so a branch the checkout cloned, fetched or checked out is null until the checkout pushes it. Among those, it uses a non-symbolic remote-tracking upstream first. Without one it uses a same-named ref, preferring `origin/<name>` or else a unique match on another configured remote. It is null for no match or ambiguous non-origin matches. This discovers pushes without an upstream, including `push.default=current`, force-pushes and agent PR workflows. It does not require local and remote-tracking tips to match, because a published branch can have unpushed local commits; shared commit IDs alone do not associate differently named branches. Tracking refs are local evidence, possibly stale, not a fresh remote query.

The probe reads only running pylons, at most once a minute per boot across snapshots; results, including failures, are cached. Reads use one guest exec, no network or index refresh, with a 2.5-second helper deadline, 3-second exec timeout, 1000-ref and reply-size limits. Failure or exceeding a limit yields null, never partial Git facts; other observations continue. The probe runs each pylon's fact reads in parallel and independently bounds their controller waits to three seconds (five for services), retaining timed-out reads until they settle to prevent duplicate outstanding RPCs. Late results are discarded. Git subprocess groups, including filter children, are killed on cleanup. Lazy fetching and Git transports are disabled for observations, so missing partial-clone objects can produce null, never a network fetch. Full branch refs avoid branch/tag ambiguity, and ref fields are NUL-delimited rather than split on Unicode line breaks. `branch` outputs use each non-null `pushedAs` as their `ref`; a dirty checkout produces a `diff` output keyed by `head`, including the empty tree for dirty scratch checkouts. Outputs accumulate even when a branch later disappears. These branch outputs feed PR discovery, which still asks GitHub for open PRs on the project's repository and uses only `origin/` outputs.

## Attention and seen

The registry stores each thread's nullable `seenAt` and `lastReplyAt` as Unix milliseconds, added by migration. A turn ending records `lastReplyAt`; streaming and parked tasks do not. Old rows start with null timestamps. If recovery finds a previously running turn ended, its reply is dated at recovery.

The registry derives `attention` in order: failed pylon, `decision` (the thread's review ended for the person, as [review records](#review-records) say, or one of its questions has no answer, as [question records](#question-records) say, or the builder stopped short of a pull request after two nudges, as [nudge records](#nudge-records) say), parked tasks, `limited` (the Claude worker's session stopped on its usage limit, as [Claude worker conversations](#claude-worker-conversations) say), unread reply (`lastReplyAt > seenAt`, with null seen treated as unread), running harness or session turn, waiting session, then null. Parked tasks are tracked for every conversation at harness recovery, independently of client watches, and the harness reports each change to the registry's parked flag. Deleting a thread clears its flag, because the delete aborts its run, and opening the registry clears it for threads deleted before that. The registry recomputes attention whenever one of its inputs changes, stores it, and appends `attention.changed` when it differs, and opening the registry recomputes every thread's. Both the thread list and detail report the stored value and both timestamps, so they match the thread's latest `attention.changed` event.

Each recorded reply timestamp is strictly greater than the preceding reply and seen marker, nudged forward by a millisecond if needed, so reply identities and unread ordering survive same-millisecond events and clock corrections.

Mark seen changes only `seenAt`. An optional `lastReplyAt` in the request caps the mark at the reply the client rendered; null marks nothing. Ordinary seen marks never move backward, so a stale page cannot undo another client's seen mark. Mark unread sets it one millisecond before the latest reply, or null without a reply. Neither is human activity, changes the pylon, nor wakes it, including on archived threads.

## Pylon states

A pylon's desired and actual states are computed on every reconcile tick and never stored.

The desired phase is `running`, `reading`, `paused`, or `deleted`. It follows the thread:

| Thread state | Desired phase |
|---|---|
| `active` or `idle` | `running` while a harness or reported session turn runs, or the agent was active in the last 5 minutes, or a human in the last 20. Otherwise `paused` |
| `archived` | `reading` while the usage backfill reads its pylon (`Thread.readingUsage`), and `paused` otherwise, at once |
| `deleted` | `deleted` |

A message, an attached terminal, a dashboard visit or a preview hit counts as human activity, so each one wakes a paused pylon.

`reading` runs the pylon without its sessions, so no agent starts. The planner sends its `spawn` with `relaunch: false`, which boots the disk and leaves the sessions for the next spawn to bring back: the pylon VM backend keeps `relaunch` set beside the checkpoint, with the session list the last pause recorded, and the Docker backend keeps its relaunch mark. A pause before that spawn records no sessions, since Herdr would list none of them, and keeps the list it had, on the disk and beside the checkpoint. The probe reports no `liveHash` for a pylon such a spawn booted, so once a person unarchives the thread, the planner sends a normal spawn, which brings the sessions back. A running pylon is done for `reading` whatever its `liveHash`. A failed wake for `reading` is never tried again and never fails the pylon: the backfill skips the thread and clears the attempt, and the pylon pauses. Every job the planner submits while the desired phase is `reading`, the spawn or a fetch of its image from another node, is saved marked `reading`, and its failure is kept apart from the pylon's count of attempts and its last failure, as the attempts' `readFailure`. The planner reads `readFailure` only while the desired phase is `reading`, so a job that fails after the backfill let go of the pylon, as after a stop, neither fails the pylon nor holds back its pause, and is not one of its next wake's tries. A step the planner gives up on while the desired phase is `reading`, such as an image no online node holds or a broken VM, fails no pylon either: it is the `readFailure`, with the planner's code, such as `artifact-missing` or `backend`, and its reason, which the backfill skips the thread for. A probe that takes `relaunch: false` says `spawnsWithoutRelaunch` in its snapshot, and the backfill wakes no pylon on a node whose probe does not. Placement counts a pylon woken for `reading` as about to boot, as it does one wanted `running`.

The actual state comes from the probe's last observation and the job in flight:

| State | Meaning |
|---|---|
| `spawning` | A `spawn` job is creating the pylon, or booting it from its checkpoint |
| `running` | The VM is up and services are started. A wake may still be relaunching its sessions |
| `pausing` | A `pause` job is recording sessions, stopping services, and writing the checkpoint |
| `paused` | Only the checkpoint exists |
| `deleting` | A `delete` job is removing the disk and logs |
| `absent` | The node does not have the pylon. It is not created yet, it was deleted, or it was lost. The thread's status tells which. The dashboard shows it as "not on its node" |
| `failed` | The planner gave up after a job failure it cannot retry, or after 5 attempts. The reason names the last job's code, its message and the end of its log, or, for a pylon its node reports broken, the node's detail and the last lines of its controller log, at most 60 lines and 8 KiB, which the node redacts before they leave it. The registry keeps the reason, so it stays after the node goes offline. A human retries with `POST /v1/threads/<id>/pylon/retry` or the dashboard's Retry button, which clears the reason and the attempts even after a failure the planner may not retry. A pylon whose setup failed before its first checkpoint holds no work, so its node removes it, and a retry boots it fresh and runs setup again. A broken pylon is paused onto its newest disk after a retry, which discards the broken VM, and then resumed. A pause never saves a disk whose setup failed: a VM with no checkpoint is removed, so it boots fresh and runs setup again. When the node reports that the disk already holds a failed setup, or has a checkpoint a pause would save it onto, every boot of that disk would repeat it, so the pylon is neither paused nor retried, and the thread must start again. So is a broken pylon whose node gives a cause this control plane does not know, or none. A deleted thread's pylon shows its delete instead |
| `unknown` | The node is offline. The dashboard shows the last observation, marked stale |

## Reconciling desired and actual state

On every observation and every 5 seconds, the control plane's planner compares each pylon's desired phase with what its probe reports. It sends the probe only the next job that closes the difference. Every job gives the same end state when it runs twice, or after an earlier run stopped partway. A deleted thread's pylon is gone once its node has neither the VM nor a preview routed to it, so a pylon whose VM was removed by hand still gets a `delete` that unpublishes its previews. Once it is gone, with no job, preview port, retry or Claude launch left to settle, the planner skips it, until its node lists or routes it again. A checkpoint is removed only by `delete` of a pylon the registry knows, so a wiped registry never deletes a pylon's disk.

## PR watch records

`pr_watches` stores one JSON record per thread in the control-plane registry. `links` holds each GitHub PR snapshot (`repo`, `number`, `title`, `url`, `state`, `checks`, `review`, `conflict`, and from each read of an open PR its `head` and `summary`, the description's first paragraph; a link the watch has not read yet has an empty `url`, so its first read baselines the comments the PR already has), the event IDs already consumed, and whether a reported failure still awaits recovery. `commentWakes` counts consecutive comment-only messages across that thread's PRs. Only feedback with GitHub `author_association` `OWNER`, `MEMBER` or `COLLABORATOR` enters the event cursor or this count; PR authors have no exemption. `pending` holds a durable request ID and message until the harness admits it, or until it is typed into a Claude worker's session; `error` holds a credential-free retry notice. These records survive archive and process restart. Rediscovery changes a reopened link from `closed` to `open` without resetting its event cursor, pending recovery or the thread's comment-wake count. ETags and response bodies are an in-memory, per-resource cache and need not survive restart.

The save that first stores a PR read from GitHub appends a `pull-request.linked` event in the same transaction, so a follower hears of each PR once, and a crash cannot keep one without the other. A placeholder the watch has not read yet, with an empty `url`, fires nothing, and neither does a later change of state, a reopen or new feedback.

A linked PR contributes an `Output` with `kind: "pull-request"` and `ref` equal to its GitHub URL. `ThreadDetail.pullRequests` supplies its structured metadata. GitHub, not a probe or checkout, owns that metadata. The optional control-plane GitHub token is an exception to the node-only tool-secret rule: it is read from a separate protected file and used only for GitHub reads and a landing's merge, never sent to a pylon.

## Review records

`reviews` stores a builder thread's latest review, one JSON record per builder, with its reviewer thread in a unique column. The PR watch skips every thread started by `nexus-review`, so a reviewer stays skipped after a later review replaces the record that named it. `Review` in `src/control/review.ts` is the shape, and `ThreadDetail.review` serves it. A record is upgraded as it is read: a finding stored with `severity` reads `serious` as `P1` and `minor` as `P3`, and a `maxRounds` above 5 reads as 5.

- `id` is `rv-` and eight hex digits. It starts every token the agents echo and every request ID the loop sends under. `expect` is the token the awaited answer must echo, random per request, and `sent` counts the review's messages, numbering their request IDs `<id>:<n>`.
- `builder`, `reviewer`, `pr` (`repo`, `number`, `url`, `title`, `branch`) and `models` (`builder`, `reviewer`) say who reviews what. `reviewerKind` is `harness` or `claude`, and only a harness reviewer's approval can land. `maxRounds` is 1 to 5, 5 by default. A record stored with a higher cap reads as 5.
- `land` is null to stop at approval, or `{ requestedBy }`, the deployer who asked for the landing, with `fromProject: true` when the project's `autoReview` asked for it, so each landing reads that setting again. `auto` is true for a review the loop started on its own. A record stored before it reads as false. `merged` is the merge commit once the PR merged, after which the review never lands again.
- `rounds` holds one entry per review of a head: `head`, the reviewer's parsed `verdict` (`verdict`, `findings` with `id`, `priority` (`P0` to `P3`), `where`, `summary`, `detail`, `reserved` cases, and `notCheckedLive`), the `check` at that head (`passed`, the output's tail), the `live` check at that head once its checks passed, `absent` when the head has no `.nexus/verify` or `ran` (`thread`, the verify pylon's, `passed`, the output's tail), and unset until it gave a verdict, the builder's `answers` (`id`, `action` fixed or rejected, `reason`), and `conflict` (`base`) once the landing found that head conflicting with its base, which makes it a `CONFLICT` finding for the builder to rebase.
- `phase` is one of `reviewing`, `fixing`, `checking` (`startedAt`, and `thread`, the check thread of the run in progress or null), `verifying` (`startedAt`, `thread`, the verify pylon's thread of the live check in progress or null, and `refused`, why no node could take its verify pylon yet), `approved`, `merging` (`authorized`, the head the review is about to merge, saved before the merge call, or null, and `waiting`, why a landing that deploys has not authorized its merge yet, while another landing that deploys is under way, a deploy drains the control plane, or not every service reports the desired release healthy), `deploying` (`commit`, `previous`, `requested`, `deadline`), `rolling-back` (`commit`, `previous`, `why`, `requested`, `deadline`), `landed` (`commit`), or `needs-person` (`cause`, which part of the loop held it: `rounds` ran out, a `gate` failed again or the builder answered it without a push, the check or live check gave `no-verdict`, an `agent` gave no answer the loop could read, the merge `policy` held it or GitHub would not merge, the PR closed or merged `outside` the review, a `thread` is not active, or the `deploy` or its rollback failed, and `unrecorded` for a hold saved before causes without a label; `reasons`; and `label`, the state of the `needs human review` label for a review whose rounds ran out: `adding`, `added`, or `failed` with `why`). `approved`, `landed` and `needs-person` have ended.
- `outbox` is the next message (`to`, `id`, `text`, and `attempted`, when its first send began, saved before that send), saved before it is sent. `since` is when the agent the loop waits on was last sent one, and `nudges` how many reminders in a row it has had.

A check thread is a bare thread, with no conversation and no Claude worker, whose `startedBy` is `nexus-check`. It lives only while its run does, and the review loop deletes any it does not hold. A verify pylon's thread is a bare thread whose `startedBy` is `nexus-verify` and whose pylon's `boot.resources` has `nestedVirtualization: true`. The review loop archives it after its run, and any that no review holds and no person has been to since it started.

A node's latest observation has `nestedVirtualization: true` from a probe whose backend can give a pylon KVM of its own. Placement puts a pylon whose boot asks for nested virtualization only on such a node.

`needs-person` makes the builder's attention `decision`. A new `nexus review` replaces an ended record, and `nexus land` moves an approved one, or one the policy held after its check passed, back to `checking`.

## Question records

`questions` stores each question a thread asked the person, one JSON record per question, keyed by the ID its asker chose, with its thread in a column. `Question` in `src/control/questions.ts` is the shape, and `ThreadDetail.questions` serves a thread's, ordered by `askedAt` and then ID. Asking again with an ID that exists keeps the stored record. `answer` is null until the person answers, then `{ option, by, at }`, which is never replaced, so a second answer reads the first. An unanswered question makes its thread's attention `decision`, recomputed in the transaction that asks or answers it. `answerer` is `person` or `deployer`, and [the answer route](cli.md#questions-0350) checks it against the caller.

A Claude worker's AskUserQuestion call is the question `ask-<call ID>`, whose `ask` holds the call's session, ID and questions, and whose answer adds `choices`, one per asked question. The registry asks and withdraws these itself, from what the pylon's hook reports waiting, as [the design](design.md#questions-for-the-person) describes. An unanswered one that no longer waits is deleted. `waiting_asks` stores each thread's latest report, keyed by the thread, as a JSON array of `WaitingAsk` from `src/control/questions.ts`: an `ask` and the `at` when its hook started waiting. Each report replaces the one before. An answer that finds no hook waiting drops its ask from the stored report, and archiving or deleting the thread deletes the row. The transcript cannot open an ask, since Claude may write the call to it only once the dialog is answered, but its result entry for the call closes one.

## Start request IDs

`start_requests` stores each request ID a `POST /v1/threads` came with, keyed by the ID. `thread` is the thread it started, or the ID a queued start's record keeps, and `body` is the SHA-256 of the rest of the start's body as the API parsed it. The row is written in the transaction that inserts the thread's row or the queued record, so a start that failed stores none, and a repeat of the ID finds the thread exactly when one exists. A repeat with another `body` is refused.

## Nudge records

`nudges` stores what the nudge pass in `src/control/nudge.ts` knows of a builder that stopped short of a pull request, one JSON record per thread. `{ "state": "nudged", "turn", "count" }` says the latest nudge answered the turn that ended at `turn` (the thread's `lastReplyAt` then), and `count` nudges went out in a row. `{ "state": "sending", "turn", "count" }` is that nudge saved before it is sent, so a pass after a crash sends it again under its own request ID before it judges a later turn, and a crash never costs the count. `{ "state": "person", "turn" }` says the turn after the second nudge stalled too, which makes the thread's attention `decision`. `{ "state": "opened", "turn" }` says GitHub found a pull request on the thread's branches after that turn, which the PR watch had not linked, as it does not one that merged or closed before it saw it open, so the pass does not search again until another turn ends. `{ "state": "left-alone" }` says the person sent the thread a message after its first reply, and is kept for good, since the transcript that showed the message may later drop it. The pass deletes any other record once the thread has a pull request or a review, or is archived or deleted. [Nudging a builder that stopped short](design.md#nudging-a-builder-that-stopped-short) has the rule.

## Judgment records

`judgments` stores one JSON record per judged failure, keyed by `failure`, the ID of the `thread.failed` event that the pylon's failure appended, with its thread in a column. `Judgment` in `src/control/judgment.ts` is the shape, and `JudgmentView` is the API's view, which `ThreadDetail.judgments` serves oldest failure first.

- `node` is where the pylon failed, `failed` the failure's reason as the registry held it, and `startedAt` when the judgment started.
- `request` is the brief and the token its answer echoes, saved before the brief is sent, or null when the control plane decided without a judgment because the thread's retries were spent.
- `conversation` is the judgment's harness conversation, null until it is created. `reply` is the judgment's reply, its last 8,000 characters, once read.
- `phase` is `{ "kind": "judging", "deadline" }`, with `deadline` null until the brief is sent and then when the answer is due, `{ "kind": "acting", "verdict" }`, saved before the control plane acts, `{ "kind": "asked", "verdict" }`, while question `judgment:<failure>` waits for the person, or `{ "kind": "done", "verdict", "outcome" }`.
- A `verdict` is `{ answer, why, by }`: the answer `retry`, `retry-elsewhere` or `person`, why, and `by` `judgment` or `control plane`, for the control plane's own rule.
- An `outcome` is `{ "kind": "retried", node, on }`, `{ "kind": "moved", from, to, on }`, with `on` `verdict` or `answer`, the person's, or `{ "kind": "left", why }`. A retry or a move on the verdict counts against the thread's two retries.

A save replaces the stored record only when it is still the record the pass read, in the transaction that runs the action it records. `judgment_since` holds one row, the newest event's ID when the migration that adds `judgments` ran, and no failure at or below it is judged.

## Queued thread records

`queued_threads` stores one JSON record per thread queued with `nexus start --after`, keyed by the ID the thread gets when it starts. `QueuedRecord` in `src/control/queue.ts` is the shape, and `QueuedThread` is the API's view of one that has not started.

- `id`, `title`, `project`, `startedBy` (who queued it, the thread's `startedBy` once it starts) and `createdAt` (when it was queued).
- `after` holds the predecessor thread IDs, without repeats, each a thread or another queued record when it was queued.
- `request` is the `StartRequest` the start runs, frozen when it was queued: `node` is the start's, or absent for the project's default when it starts, and `resources` is the start's size filled field by field from the project's then.
- `message` is a Nexus agent thread's first message, and null for a Claude worker, whose prompt is `request.claude`.
- `status` is `queued`, `archived` (cancelled; unarchive makes it `queued` again), `deleted`, or `started`. Only the transaction that inserts the thread's row sets `started`, together with `startedAt`, the thread's `createdAt`, and `firstMessage`, which is `pending` until the message is sent and `sent` after it, or null with no message. That transaction refuses a record that is not `queued`, so a thread starts at most once.
- `startNow` is who asked `start-queued` and when, or null. `lastError` is why the latest start attempt failed, cleared by the start.

What blocks a queued thread is not stored. Each pass and each view derives every predecessor's `Wait` from its thread, its `reviews` record and its `pr_watches` links.

## Pipeline item records

`pipeline_items` stores one JSON record per pipeline item, keyed by its ID, `it-` and 12 hex digits, in the order they were added. `ItemRecord` in `src/control/pipeline.ts` is the shape, and `PipelineItem` is the API's view.

- `id`, `project`, `title`, `addedBy` (who added it, its thread's `startedBy`) and `addedAt`.
- `request` is the `StartRequest` its queued thread starts with, as checked when it was added, and `message` a Nexus agent thread's first message, null for a Claude worker, whose brief is `request.claude`.
- `after` holds the IDs of items of the same project, each added before this one.
- `approved` is who approved it and when, or null. `cancelled` is who cancelled it before it had a thread, or null. `lastError` is why the pass could not queue it last time, cleared once it is queued.

An item's thread is not stored. It is the thread the start request ID `pipeline:<item>` made in `start_requests`, which the transaction that writes the queued record stores. Its phase is not stored either: each view derives it from that thread's `queued_threads` record, row, `reviews` record, `pr_watches` links and `thread_attention`.

## Token usage records

`usage_records` holds one row per model call an agent made, keyed by `id`, the call's own ID in the agent's record. A row is an `AgentCall` from `src/agent-usage.ts` with the `thread` it was read from, and that thread's `project` and `role`.

| Source | `id` | `agent` | Read from |
|---|---|---|---|
| A Claude Code session in a pylon, such as a Claude worker, its subagents and a Claude reviewer | `claude:<message.id>` | `claude` | Each `assistant` record's `message.usage` in every `*.jsonl` under `~/.claude/projects` |
| A pi session in a pylon, such as a harness reviewer | `pi:<responseId>`, or `pi:<entry id>@<entry timestamp>` for an entry without one, which a fork copies unchanged | `pi` | Each assistant `message` entry and each `usage` entry under `~/.pi/agent/sessions` |
| The Nexus agent | `harness:<conversation>/<entry>` | `pi` | Each assistant message in the conversation's pi-durable entries |

- `input`, `output`, `cacheWrite` and `cacheRead` are token counts. For Claude Code they are `input_tokens`, `output_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`. A call's total is their sum.
- `model` is the model the record names. `at` is the call's time in Unix milliseconds.
- `thread` is the thread the call was read under, and `project` its project. `role` is `reviewer`, `check` or `verify` for a thread the review loop started, `builder` for one a person started from a tailnet node, and `other` for any other starter. Calls of verify pylons recorded before `verify` existed stay under `other`.
- A call already recorded keeps its `thread`, `project`, `role` and `at`, and each count keeps the larger of the stored value and the new one. A read under another thread changes nothing, so a session copied into another pylon stays with the thread that first recorded it. Claude Code writes one record per content block, and each record carries the call's whole usage, so a call read again, read by two reads, or copied into another file by a resume or a fork counts once.
- A call with no tokens, and Claude Code's own `<synthetic>` messages, give no record. A pylon's read is refused whole when a call's ID does not start with its own agent's prefix, `claude:` or `pi:`, or a count is over 10⁹, so a pylon cannot write a harness call or a sum SQLite cannot hold.

`usage_days` holds the sums of the calls per UTC day, project, role, agent and model, with how many calls each sum holds, and changes in the same transaction as the calls. `GET /v1/usage` reads it, so a report costs the same however many calls there are. A report for one thread reads that thread's calls instead.

`usage_cursors` holds how far each source was read: per pylon, the byte offset past the last whole line of each transcript with `before`, the SHA-256 of the up to 4 KiB before it, and for the harness, the last entry read of each conversation. A file shorter than its offset, or whose bytes before it no longer match `before`, was replaced and is read again from the start. `usage_since` holds when the migration ran, which is when counting started. Deleting or archiving a thread keeps its records.

Counting reads a pylon only while its node's last observation reports it running, so a read never wakes a pylon. Only the usage backfill, below, wakes one to read it. `src/agent-usage.py` runs in the guest over one raw pipe, prints at most about 1 MiB of calls a read, and a pylon with more is read again, at most 16 times in a row. A read follows each `session.turn-ended` and `session.ended` event, a harness read follows each `thread.turn-ended`, a deleted thread's too, and every thread but a deleted one is read when the control plane starts and every 10 minutes. The harness keeps a deleted thread's conversation, so its reads cover the Nexus agent's calls of every thread since the first. A pylon's transcripts go with the pylon, so a thread deleted before this was deployed, or a call made after the last read of a pylon that was then deleted, is not counted. An archived thread's pylon is paused, so its calls from before counting started, or after its last read, are counted once the backfill reads it.

pi-durable records two kinds of spend only in its running total, the `pi.usage` document, and not per call: the summaries a compaction writes, and model calls a tool makes. Neither is counted.

`GET /v1/usage` answers a `UsageReport`: the start of the period's first UTC day (`since`), `countingSince`, the `total`, rows `by` model, project, kind, role and UTC day, and the `backfill`.

### Usage backfill

The backfill reads every Claude Code transcript and pi session on archived threads' pylons from the start, one pylon at a time. `usage_backfill` holds its run, one row at most, and `usage_backfill_threads` a row for each thread a run listed. `UsageBackfill`, `BackfillThread` and `BackfillPlanRow` in `src/control/usage.ts` are the shapes, and `src/control/usage-backfill.ts` is the job.

| `usage_backfill` | Meaning |
|---|---|
| `state` | `running`, `stopped` or `done` |
| `started_at`, `finished_at` | When the run started, and when it stopped or finished. `finished_at` is null while it runs |
| `thread`, `phase`, `since` | The pylon the run holds, all null when it holds none. `phase` is `reading`, woken to be read, or `pausing`, read or given up on and waiting for its pause, since `since` |
| `waiting` | Why the run waits before it wakes the next pylon, or null |

| `usage_backfill_threads` | Meaning |
|---|---|
| `thread` | The thread |
| `state` | `pending`, `done` or `skipped` |
| `reason` | Why a skipped thread was not read. Null otherwise |
| `calls`, `tokens` | What reading it recovered: the calls no read had counted, and the tokens they added. Each read adds to them in the transaction that records its calls, so a read cut short, by a failure, a stop or a restart, keeps what it recorded, and a later read adds the rest |
| `at` | When it was done or skipped. Null while pending |

A start, `POST /v1/usage/backfill` from a deployer, lists every archived thread with a pylon that has no `done` row, gives each a `pending` row, makes a `skipped` one `pending` again, and sets the run `running`. A start while one runs changes nothing, and a `done` thread is never read again. A stop, `DELETE /v1/usage/backfill`, sets a running run `stopped` and lets go of its pylon, whose desired phase is `paused` again. A thread whose read the stop cut short stays `pending`.

Every 2 seconds, and at once after a start or a stop, a step reads the run and does what is left of it, so a control plane that restarts or deploys mid-run goes on with the pylon it held:

1. A run that is not `running` does nothing.
2. With no pylon held, it takes the oldest thread still `pending`. A thread no longer archived, deleted, with no pylon record, whose pylon failed, whose node holds no disk for its pylon, or whose stopped pylon's image no online node holds is skipped with that reason, and the step takes the next. The run then waits, with `waiting` set, while the pylon's node is offline, its probe does not report `spawnsWithoutRelaunch`, the node runs a job or a registry pylon there has one submitted, its pylon is neither stopped nor running, or the node's memory left with the pylon up would be less than the largest project's `resources.memoryGiB`, so a start always fits. Placement's own arithmetic counts the room. Otherwise it clears the pylon's attempts, since a failure from before the thread was archived would hold the wake back, and holds it `reading`, which makes its desired phase `reading`. With none left `pending`, the run is `done`.
3. A pylon held `reading` is skipped when its thread was unarchived or deleted, when its wake failed, whose attempts the step clears, or when it has not run 10 minutes after the hold. Once its node reports it running, the step reads it from the start of every file, as many reads as it takes, through `recordUsage` and the cursors as counting does, and counting starts no read of that pylon until it is done. The thread is then `done`, or `skipped` with the read's error, keeping what its reads recovered, and the pylon is held `pausing`.
4. A pylon held `pausing` is let go once its node reports it stopped or absent, its thread is no longer archived, or 10 minutes have passed. Only then is the next pylon woken, so one is up at a time across every node.

`GET /v1/usage/backfill` answers `{ backfill: UsageBackfill, plan: BackfillPlanRow[] }`, the run and the threads a start would read, with the node of each and why a run skipped it before.

## Releases and deployment drain

The `settings` key `release` stores one desired release: the full commit, `requestedBy` stable tailnet node ID and `requestedAt` epoch milliseconds. A later request replaces it. The node validates main ancestry before building. No request history or pylon image is stored in this record.

`release_reports` stores a JSON `ReleaseReport` keyed by `(node, role)`. It records the currently linked `commit`, attempted `target`, state, nullable failure reason and control receipt time `observedAt`. Roles are control and probe. The API synthesizes pending rows for missing reports and marks reports older than 90 seconds stale. A role that rolled back still reports the previous running commit and failed target, so desired and observed cannot be confused. `src/deploy/model.ts` is the deployer's wire contract: the report, the release view, and the drain request and reply.

The settings key `deploy-drain` holds `{commit, expiresAt, locked?}` or null. The control node alone acquires/renews/releases it with root-authenticated requests. It survives control process restart. Preparation leases expire without a live worker; the final idle fence sets `locked: true` before a link switch, holding admission through recovery until explicit release. One turn gate fences the API's turn-starting routes, the harness methods the control plane wraps and the queue's starts; idle additionally requires no entering submissions, committed live runs or queued inputs.

On each node, root owns `/opt/nexus/<role>-deploy.json`: `{commit, previous, target, state, reason}`, where previous/target are symlink targets and state is installing, healthy, rolled-back or failed. Installing is recorded before activation. A restart recovers it before contacting control. `<role>-deploy.unit` saves the previous unit and `<role>-deploy-report.json` retains terminal failures for later reporting. A failed or rolled-back attempt at the desired commit, in the report or the journal, stops automatic retries of it. The journal and the report are each written as indented JSON with mode 0600, to a temporary file that is then renamed over it. The worker rewrites the report only when its role, commit, target, state or reason changes, and sends it to control on every poll. Those files are separate from service-user-writable state and are not registry records.

## Project edits and boot identity

`Project.autoReview` is optional `{ land: boolean, enabledBy: string }`, absent when off. `enabledBy` is the caller who turned it on, which only a project edit sets, and a landing it asks for merges and deploys for that caller.

`Project.pipeline` is optional `{ autoStart: boolean }`, absent or null when off. Turning it off stores null, so the migration that turned it on for project `nexus` skips it when a registry rewound past that migration applies it again.

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
| `session.waiting` | Claude showed a permission or input prompt, its AskUserQuestion hook began waiting for an answer, or a background command still ran after 2 hours; optional `session` and `message` |
| `session.ended` | Claude's SessionEnd hook ran; optional `session` and `message` |
| `thread.turn-ended` | The control-plane harness completed a turn |
| `thread.failed` | Pylon or worker launch failed; `message` |
| `thread.parked` | The harness has parked tasks |
| `attention.changed` | The new nullable `attention` |
| `pull-request.feedback` | New batched GitHub feedback; `requestId` |
| `pull-request.linked` | The PR watch linked a pull request to the thread, written once per pull request when the watch first saves it read from GitHub; `repo`, `number`, `url`, `title` and `state` |
| `pull-request.error` | The thread's PR watch failed a read or a delivery, written when its `error` goes from none to set and not again while it stays set; `error`, the retry notice |
| `pull-request.error-cleared` | The thread's PR watch read GitHub again after a failure, written when its `error` goes back to none |
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
and so is a temporary file a killed hook left for more than a minute. The hook writes only in a pylon a thread
owns, one with the overlay's `~/.nexus/pylon.json`, and the image build starts no agent, so no image or template
disk carries events that every pylon booted from it would send. Neither
wait holds up Claude, whose hook only writes the file.

From probe to control, the production probe journals its last 100 session
reports in `events.sqlite` under its state root, and answers the hook only after
the journal commits. Every snapshot carries that journal, so it replays the
reports a link or probe restart cut off; `event_receipts` deduplicates its
sequence per node, and control reads the receipt once per snapshot and skips the
reports at or below it without parsing them again. This is a bounded
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
`Thread.working` is true while the harness turn or a live session turn runs, so a
Claude worker's turn counts as a harness turn does wherever a thread reads as working.
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
| `prompt` | `text`, `from`: `person`, `command` or `other`, optional `images` | A prompt the person typed, a prompt Claude took from its queue mid-turn (`queued_command`), a slash command, or a prompt from a plugin |
| `reply` | `text` | An assistant text block |
| `tool` | `id`, `name`, `input` | An assistant `tool_use` block, or a `!` shell command (`shell`) |
| `result` | `toolUseId`, `output`, `isError`, optional `images` | A `tool_result`, or a `!` command's output. A background launch's metadata reads "Started in the background" |
| `task` | `toolUseId`, `status`, `summary`, `result` | A `<task-notification>`: a background subagent or shell finished. `result` is a subagent's answer |
| `queue` | `op`, `text` | A `queue-operation`: a message typed during a turn joined or left Claude's queue |
| `notice` | `tone`, `text`, optional `usageLimit` | An interruption, a compaction, a model error, a local command's output, or Claude Code's own `system/informational` message. `usageLimit` (`resetsAt`, Unix ms or null) marks the error an assistant record with `apiError: "usage_limit_reached"` gives, with `apiErrorParams.rate_limit_info.resetsAt` |
| `turn` | `durationMs` | `system/turn_duration` |
| `pull-request` | `number`, `url`, `repository` | A `pr-link`: Claude opened a pull request. Claude Code writes it again each time it saves the session's metadata, so clients show the first entry for each `url`. `url` is always an https URL |
| `record` | `type`, `summary` | Any record shape the parser does not know, a malformed line, or a record over 4 MiB, which is skipped |

Every entry has `at`, the record's time in Unix milliseconds. Records Claude Code keeps
for itself, such as API request copies, context attachments, file-history
snapshots and the session metadata it writes again on each save (its title, tag, mode,
agent, worktree and the like), give no entry. They are named in tables in the parser, so a new record type
shows as a `record` rather than disappearing. Prompts are cut at 32 KiB, replies at
64 KiB, tool inputs at 4 KiB per string and outputs at 8 KiB. A prompt's or result's `images` (`offset`, `bytes`, `sha256`, `index`) name each image block by the transcript line that holds it and its place among that line's image blocks: each top-level `image` item, then each `image` part of a `tool_result`'s list content, in order, up to 32 a line. The image route reads that line again and checks its hash, so it never serves another line's bytes. A Read of an image holds its base64 twice, so its record is about 2.7 times the image, which is why a read takes up to 4 MiB.

The registry keeps what was read. `claude_transcripts` holds per thread the session it
read, the cursor (`byte_offset` past the last complete line, `skipping` while a
record over 4 MiB is passed over, and `before_hash`, the SHA-256 of the up to 4 KiB
just before the offset), how many entries were `dropped`, and `read_at`, when the
last read that reached the transcript's end started.
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
the pylon running. The read is one raw pipe through the probe, taking at most 4 MiB
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

`claude_senders` records, per thread and request ID of `claude_messages`, who typed the message (`sender`: `person`
for a send through the API, or the Nexus sender `pr-watch`, `review`, `usage-limit` or `nudge`) and a SHA-256 of its
text as typed (`text_sha256`). It is written with the `sending` row and removed with it. Nexus types its messages
into the session as the person would, so the transcript records them as the person's prompts. A prompt is Nexus's
only when the thread has a row of a Nexus sender with that text's hash, which the nudger and the dashboard read
through `promptSenders` in `src/control/inbox.ts`. A `claude_messages` row with no `claude_senders` row was recorded
before the table, and its sender is unknown. Only on a thread with one does a prompt that matches no row read as
Nexus's by its sender's prefix, such as `[Nexus review`.

