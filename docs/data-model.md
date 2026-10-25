# Nexus data model

This reference lists the Nexus records, their fields, and their states. Field names follow [the contracts](contracts/rationale.md) and are not final. For the reasons behind each record, see [the Nexus design](design.md).

## Records

The control plane writes every record. Probes send facts in observations, and the control plane turns them into records. No probe writes to the registry.

| Record | Fields | Comes from |
|---|---|---|
| Node | `name`, `tailnetHost`, `tailnetNodeId`, `cpuVendor`, `memoryGiB`, `state` | You add a node. Capacity and `state` come from its probe's observations |
| Project | `repoUrl`, `defaultBranch`, `defaultNode`, `resources`, `allowedHosts`, `secrets`, `logins`, `preSetup` | You |
| Image | `id`, `pins`, `builtOn`, `builtAt` | The results of `build-image` jobs |
| Template | `id`, `key`, `state`, `node`, `builtAt` | The results of `build-template` jobs |
| Thread | `id`, `title`, `project`, `status`, `conversationId`, `pylonId`, `startedBy`, `seenAt`, `lastReplyAt` | You, and the harness |
| Pylon | `id`, `thread`, `node`, `template` | Thread start |
| Session | `pylon`, `id`, `herdrPane`, `harness`, `harnessSessionId`, `status`, `title`, `state`, `message` | Observations. Panes opened by hand in Herdr are adopted. A paused pylon's sessions keep their records |
| Preview | `pylon`, `service`, `httpsPort` | The control plane allocates the port, never one its node's probe still routes. Observations report when it is ready |
| Output | `thread`, `kind`, `ref` | Observations, including outputs the agent declares with `nexus output add` |
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

## Attention and seen

The registry stores each thread's nullable `seenAt` and `lastReplyAt` as Unix milliseconds, added by migration. A turn ending records `lastReplyAt`; streaming and parked tasks do not. Old rows start with null timestamps. If recovery finds a previously running turn ended, its reply is dated at recovery.

The API derives `attention` in order: failed pylon, parked tasks, unread reply (`lastReplyAt > seenAt`, with null seen treated as unread), running turn, then null. Parked tasks are tracked for every conversation at harness recovery, independently of client watches. Both the thread list and detail report this value and both timestamps.

Each recorded reply timestamp is strictly greater than the preceding reply and seen marker, nudged forward by a millisecond if needed, so reply identities and unread ordering survive same-millisecond events and clock corrections.

Mark seen changes only `seenAt`. An optional `lastReplyAt` in the request caps the mark at the reply the client rendered; null marks nothing. Ordinary seen marks never move backward, so a stale page cannot undo another client's seen mark. Mark unread sets it one millisecond before the latest reply, or null without a reply. Neither is human activity, changes the pylon, nor wakes it, including on archived threads.

## Pylon states

A pylon's desired and actual states are computed on every reconcile tick and never stored.

The desired phase is `running`, `paused`, or `deleted`. It follows the thread:

| Thread state | Desired phase |
|---|---|
| `active` or `idle` | `running` while an agent turn runs, or the agent was active in the last 5 minutes, or a human in the last 20. Otherwise `paused` |
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

`pr_watches` stores one JSON record per thread in the control-plane registry. `links` holds each GitHub PR snapshot (`repo`, `number`, `title`, `url`, `state`, `checks`, `review`, `conflict`), the event IDs already consumed, and whether a reported failure still awaits recovery. `commentWakes` counts consecutive comment-only messages across that thread's PRs. `pending` holds a durable request ID and message until the harness admits it; `error` holds a credential-free retry notice. These records survive archive and process restart. ETags and response bodies are an in-memory, per-resource cache and need not survive restart.

A linked PR contributes an `Output` with `kind: "pull-request"` and `ref` equal to its GitHub URL. `ThreadDetail.pullRequests` supplies its structured metadata. GitHub, not a probe or checkout, owns that metadata. The optional control-plane GitHub token is an exception to the node-only tool-secret rule: it is read from a separate protected file and used only for GitHub reads, never sent to a pylon.
