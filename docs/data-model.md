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
| Thread | `id`, `title`, `project`, `status`, `conversationId`, `pylonId`, `startedBy` | You, and the harness |
| Pylon | `id`, `thread`, `node`, `template` | Thread start |
| Session | `pylon`, `herdrPane`, `harness`, `harnessSessionId`, `status` | Observations. Panes opened by hand in Herdr are adopted |
| Preview | `pylon`, `service`, `httpsPort` | The control plane allocates the port. Observations report when it is ready |
| Output | `thread`, `kind`, `ref` | Observations, including outputs the agent declares with `nexus output add` |
| Orphan | `node`, `pylonId` | Observations of a pylon the registry does not know. Only you delete it |

One setting sits beside the records: `current`, the image every new pylon uses. A build that passes its smoke boot becomes current.

## Field values

- A pylon `id` is `pylon-<thread id>`, at most 40 characters.
- `Node.tailnetNodeId` is Tailscale's stable node ID. Probes compare callers against it.
- `Node.state` is `online` or `offline`. A node that is asleep or powered off is `offline`. That is not an error.
- `Project.secrets` holds names and the hosts each value may be sent to. The values live only in each node's secret file.
- `Project.logins` is a list of `claude` and `chatgpt`. Each adds the hosts its login needs to the allowlist.
- `Template.key` is the project, the image, and a hash of `.nexus/setup`, `preSetup` and the allowlist. A template is reused for at most 72 hours.
- `Template.state` is `building`, `ready`, or `failed`.
- `Session.harness` is `claude-code`, `pi`, or `shell`.
- `Session.harnessSessionId` is the Claude Code session ID or the pi session file. Waking uses it to relaunch the session into its prompt. The pylon also keeps the list on its own disk, in `~/.nexus/sessions.json`.
- `Session.status` is `working`, `idle`, `blocked`, or `done`.
- A preview's URL is `https://<node tailnet name>:<httpsPort>/`.
- `Output.kind` is `branch`, `diff`, `preview`, or `file`.

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
| `failed` | The planner gave up after a job failure it cannot retry, or after 5 attempts. The probe keeps the logs, and a human retries |
| `unknown` | The node is offline. The dashboard shows the last observation, marked stale |

## Reconciling desired and actual state

On every observation and every 5 seconds, the control plane's planner compares each pylon's desired phase with what its probe reports. It sends the probe only the next job that closes the difference. Every job gives the same end state when it runs twice, or after an earlier run stopped partway. A checkpoint is removed only by `delete` of a pylon the registry knows, so a wiped registry never deletes a pylon's disk.
