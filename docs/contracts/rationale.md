# Nexus contracts: rationale

Status: agreed on 2026-10-22. A first slice is implemented: the planner, the probe's job and observe routes, and the Docker test backend. For how callers use these contracts, see [usage.md](usage.md).

## Problem

Nexus needs three contracts before any code. The first says how lifecycle work reaches a node. The second says what a project declares and what Nexus stores. The third says how pylon images and project templates are built and moved. Amp's provider jobs are the model: `spawn`, `pause` and `delete`, each safe to repeat and done within 5 minutes. pi-sandbox already boots, checkpoints, prepares templates and supervises services. It also fixes network policy at create, passes no secrets, sets `PUBLIC_URL` to a localhost URL, and runs `.agents/*` as root from its workspace. Gondolin blocks all guest egress except allowed HTTP, TLS and SSH, so a pylon cannot dial anything the way an Amp orb dials Amp. A checkpoint is a qcow2 overlay on an image rootfs that must stay at a fixed path (S2). A preview needs a warm-up before it is reported (S4). A pylon's disk is the only copy of its uncommitted work.

## Shape

| Module | Owns | Side |
|---|---|---|
| [`src/ids.ts`](../../src/ids.ts) | The shared IDs: nodes, pylons, jobs, projects, artifacts and live hashes. It imports nothing | Both |
| [`src/protocol/`](../../src/protocol) | One file per message family, each with its types and its wire codec: the ID schemas and shared fields (`fields.ts`), the `Job` union, deadlines, the retry table and `JobFailure` (`jobs.ts`), observations (`observations.ts`), synchronous commands (`commands.ts`), streams (`streams.ts`), probe errors (`http.ts`), artifact copies (`artifacts.ts`), `routeAuth` (`routes.ts`) and `ProbeClient` (`client.ts`) | Both. Each family's wire encoding stays behind its own parse and encode functions, and the probe never loads `client.ts` |
| [`src/reconcile.ts`](../../src/reconcile.ts) | The desired phase, the planner, the derived actual state, and record writes from observations | Control plane, pure |
| [`src/probe/run.ts`](../../src/probe/run.ts) | `runJob`, `runCommand` and `commandPolicies` | Probe |
| [`src/backend.ts`](../../src/backend.ts) | `VmBackend`, `Guest`, `ArtifactStore`, and the pi-sandbox fork's mapping and changes | Probe |
| [`src/services-file.ts`](../../src/services-file.ts) | The `.nexus/services.yaml` schema and parser, the port rules, and `withPublicUrls` | Both. The pylon-vm controller loads it with type stripping |
| [`src/spawn.ts`](../../src/spawn.ts) | What a spawn carries: `BootInputs`, `LiveSpec` and its hash, `RepoInit`, `GitIdentity` and `PylonResources` | Both |
| [`src/secret-grants.ts`](../../src/secret-grants.ts) | `SecretGrant`, its name and host patterns, and the GitHub and ChatGPT grants | Both |
| [`src/shell.ts`](../../src/shell.ts) | `shellQuote` and `installFileCommand` | Both |
| [`src/project.ts`](../../src/project.ts) | `Project`, its effective allowlist, and the overlay with its PYLON.md guide | Control plane. No node code imports it |
| [`src/images.ts`](../../src/images.ts) | The image recipe and ID, template keys and build inputs, and the artifact manifests | Both |
| [`src/control/templates.ts`](../../src/control/templates.ts) | Template records, template choice, setup hashes, and garbage | Control plane |

A reconcile tick traces through three files. `src/reconcile.ts` plans, `src/protocol/` carries, and `src/probe/run.ts` executes against `src/backend.ts`'s `VmBackend`.

- **The control plane is the only writer.** Every record comes from `NodeObservation` facts. `Pylon.desiredState` and `actualState` become derived values, not stored fields.
- **A spawn converges to a spec.** `BootInputs` apply when the VM boots. `LiveSpec` (previews and overlay files) applies on every spawn and is hashed. After a probe restart its observations report `liveHash: null`, and the planner sends spawn again. The probe persists nothing of its own.
- **Stale jobs die by expiry.** One job per subject runs at a time, a repeated `jobId` returns the existing status, and an envelope expires 30 seconds after issue.
- **No job can lose a disk.** `drop-artifact` takes a `PortableArtifactId`, which excludes checkpoints. A checkpoint goes away only when its pylon is deleted, and the planner deletes only pylons the registry knows. A wiped registry knows none, so it deletes no disks. A pylon the registry does not know shows as an orphan for a human to decide.
- **Sessions live on the disk.** `pause` writes the open Herdr sessions to `~/.nexus/sessions.json` before the checkpoint, and every boot relaunches from that file into the prompt. The backend keeps a copy of what the pause recorded beside the checkpoint, so a paused pylon's observation still lists the sessions its wake brings back.
- **Streams have an end result.** A pipe runs at most once and ends `exited` or `lost`, which matches pi-durable's interrupted tools.
- **Everything in the guest runs as `user`.** pi-sandbox fixes the shell user per instance, and `user` has passwordless sudo.
- **Auth is tailnet node identity, with no tags.** The probe asks `tailscaled` who called and compares the stable node ID with its config. The home tailnet's policy stays as it is. Tags would make the nodes stop belonging to your user, so rules written for your user, such as Tailscale SSH on `rj-firebat`, would stop matching. Pylons cannot reach the tailnet, because Gondolin blocks internal addresses.
- **The backend is an in-process interface.** Amp's provider does only lifecycle because its orb dials out for everything else. A pylon cannot, so the probe carries exec, PTYs, the harness channel, services and previews. These do not fit one process per job with env-var inputs. pi-sandbox's detached per-instance controller already gives the crash boundary that a dispatch program would give.
- **Artifacts are immutable and content-named.** Images, templates and checkpoints share one store, at the same path on every node, so qcow2 backing files resolve after a copy.
- **Templates key on setup.** The key is the project, the image, and a hash of the `.agents/setup` blob, `preSetup` and the effective allowlist. The control plane reads it from its bare mirror without booting anything. Templates expire after 72 hours, as in Amp.
- **The repo files are Nexus's own.** `.nexus/setup`, `.nexus/resume` and `.nexus/services.yaml`. Nexus copies Amp's design, not its file names or environment variables. The services schema starts from pi-sandbox's, so the backend only rewrites paths. A separate directory also means pi-sandbox's habit of running `.agents/setup` as root cannot fire by accident.

## Compared with Amp and pi-sandbox

Amp is the design model. pi-sandbox is the closest working code. Nexus uses neither's services, and where it differs from both, the reason is given.

| Decision | Amp | pi-sandbox | Nexus |
|---|---|---|---|
| Who decides lifecycle | Amp's servers send `spawn`, `pause` and `delete` to a provider | The pi extension in one session | The control plane sends jobs to a probe on each node |
| Backend boundary | A dispatch program per job, done within 5 minutes | In-process, with a detached controller per instance | In-process, with pi-sandbox's controller model |
| Repo files | `.agents/setup`, `.agents/resume`, `.amp/services.yaml` | `.agents/setup` and `resume` run as root, and services live in `.sandbox.yaml` | `.nexus/setup`, `.nexus/resume` and `.nexus/services.yaml`, all run as `user` |
| Service schema | `portal`, `review` | Amp's, with `preview` and `health: process` | pi-sandbox's |
| Template reuse | 72 hours | Named templates from `prepare`, with no age limit | 72 hours, and a new key when setup changes |
| Network | The orb dials out to Amp | Allowlist fixed at create, no secrets | Allowlist and secret grants applied at every boot |
| Preview URL | `tunnel.ampcode.com` | A localhost URL | `https://<node>:<port>` through `tailscale serve` |

## Synthesis decision

Two candidates were sketched in parallel. Candidate A pushed jobs from a central planner. Candidate B sent one desired-state document per node and let each probe plan for itself. A cross-judge read both against the pi-sandbox source and scored them on six criteria.

| Criterion | A | B |
|---|---|---|
| Traceability | 4 | 3 |
| Idempotency and crash safety | 3 | 4 |
| Interface depth and boundaries | 3 | 4 |
| Fit with the spike evidence | 4 | 3 |
| v1 scope | 3 | 2 |
| Config ergonomics and secrets | 4 | 3 |

The judge recommended A as the base, and this proposal follows it. My own first lean was B, for crash safety. A's only serious hole was that its garbage collector could drop every checkpoint after a wiped registry. The `PortableArtifactId` type closes that hole more simply than B's three fences. Once B is cut to v1 scope (no moves, epochs or warm templates), little of it remains that A lacks, while A keeps Amp's job names and a single planner.

Grafts from B:

- Absence means keep, never delete. In A this is enforced by the type and by the planner ignoring unknown pylons, instead of by B's incarnation and freshness fences.
- The session list is kept on the pylon's disk, so the checkpoint carries it. A's relaunch list came from the last observation and missed sessions opened just before a pause.
- Streams end in `exited` or `lost`.
- B's one-writer file pair becomes the fallback for the in-pylon API if the host bridge is refused.

Fixes from the judge's check of pi-sandbox:

- pi-sandbox's package exports only its extension, so Nexus cannot import `run` as both sketches assumed. Nexus owns a hard fork instead, trimmed to what it uses. Its first changes are listed in [`src/backend.ts`](../../src/backend.ts).
- `create { template }` reuses the template's recorded config, so the fork makes network policy and resources inputs to every start.
- Exec timeouts call pi-sandbox's `exec-kill`, because exec only waits.
- Per-stream user switching is gone (see the user rule above).

Cuts from A, for v1 scope:

- The dotfiles artifact is gone. Every boot pulls the dotfiles repo, which the design already says, and the image bakes a fallback copy.
- The per-project image pin and `nexus image promote` are gone. A build that passes its smoke boot was to become current. Since 2026-10-26 a separate `nexus image rollout` makes it current, once every online node holds it, so the person decides when.
- The checkpoint-mismatch check is gone. Without moves, the local disk is the only disk, so there is nothing to compare it against.

## Tradeoffs accepted

- One extra spawn per running pylon after every probe restart, in exchange for a probe with no persisted state.
- A control-plane round trip, up to 30 s, before `nexus preview` returns a URL, in exchange for one owner of preview ports per node.
- A pylon on an offline node cannot wake, in exchange for no cross-node disk replication.
- Boot-time changes (allowlist, resources, image) wait for the next wake.
- Owning a hard fork of pi-sandbox, about 2,350 lines of core code, in exchange for full control of the only code that touches Gondolin. Fixes upstream are not picked up automatically.
- Stale dependencies inside a template for up to 72 hours when only lockfiles change.
- Dependence on NTP across nodes for the 30-second job expiry.
- While the control plane is down, nothing pauses idle pylons. They keep running and using memory until it returns. The harness lives on the control plane too, so autonomous agents are down then anyway.
- A wiped registry can drop templates and images it no longer knows. They can be rebuilt, and the store refuses to drop an image that a local checkpoint needs.

## Alternatives considered

- **Probes pull one desired-state document per node (candidate B).** It is stronger on offline tolerance, but it spreads planning across the control plane, the probe and a guest supervisor. Its move and epoch machinery serves a feature v1 does not have.
- **A dispatch-program backend with Amp's env vars.** It cannot carry PTYs, the harness channel or synchronous service results without a second channel beside it.
- **Generation counters to fence stale jobs.** They need durable storage on one side. Expiry plus one job per subject removes the same failure without state.
- **Amp's own `.amp/services.yaml` with `portal` keys.** A repo would work in Amp and Nexus unchanged, but it ties Nexus to Amp's file names, its `AMP_THREAD_ID` variable and its vocabulary. Nexus copies Amp's design and uses no part of Amp's stack.
- **Path-routed previews (`https://node/<pylon>/<service>/`).** These break apps that assume they own `/`.

## Open questions and risks

These need a spike or a source check:

- Why did streamed copies between nodes break in S7? The artifact route must verify every copy before a boot. S7 showed a checkpoint copied between the Intel and AMD nodes boots, from the same path or after `qemu-img rebase -u`.
- Does pi-env's remote daemon run over a raw stdio stream through pi-sandbox's SSH? S3 left this untested.
- Should lockfile hashes join the template key, through an opt-in list in the repo?

## Agreed on 2026-10-22

- Nexus copies Amp's design and uses no part of Amp's stack, including its file names and environment variables.
- pi-durable on the control plane runs every thread.
- pi-sandbox is the reference to compare against, and Nexus owns a hard fork of it.
- No tailnet tags or ACL changes. Probes check the caller's node ID.
- Images build on `infra-testbench`.

## Next implementation step

The first slice is done: `planPylon` with a table test, and a probe that runs spawn, pause and delete against the Docker backend end to end (`npm test`, `npm run test:slice`). The second slice is done too: `pylon-vm`, the pi-sandbox fork in `src/pylon-vm/`, passes the same slice test on `infra-testbench` with real Gondolin VMs. Next come the remaining fork changes listed in `src/backend.ts`.
