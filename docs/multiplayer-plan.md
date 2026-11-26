# Multiplayer plan

This plan turns Nexus from an install for one person into a shared install for about eight engineers on a company tailnet. It is a checklist. An owner runs it box by box, and the operator audits it from the evidence each box names. The plan holds no code.

Written on 2026-11-26 against `main` at `0f7834d6`. It scopes the decision that [the install exploration](explorations/install.md#per-person-credentials) left open, whether Nexus serves more than one person.

## What changes

On a shared install:

- A caller is a person, known by their tailnet user, with the role admin or engineer. A tagged device or a registered node is never a person.
- A thread belongs to the engineer who started it. Only the owner acts on it. Teammates may read it, and a read never wakes its pylon.
- Each engineer's Claude Code, Codex, and GitHub credentials live on the control plane. Nexus swaps them in at the network edge of that engineer's own pylons. A pull request is authored by the engineer whose thread opened it.
- Nexus never merges. A guard at the pylon's network edge also refuses a merge or an approving review sent with an engineer's token.
- An engineer's threads run Claude Code or Codex inside the pylon. The control plane's own agent loop, the harness, runs no engineer thread.
- An engineer copies their own Claude and Codex setup to their pylons with one CLI command.
- Admins alone create and edit projects.

An install without a `people` list in `control.json` behaves as it does today.

## Not in this plan

- Running CI jobs on Nexus. The review of this design found four network-path problems that block it: containers inside a pylon cannot make HTTPS requests, a request body over 64 MiB is refused, an upload with `Expect: 100-continue` fails, and a 1 GiB download costs about 66 host CPU-seconds. A second plan covers them.
- A harness login for each engineer.
- Scheduling beyond a per-person cap, and any Kubernetes backend.
- Merging `multiplayer` into `main`. See [the branch](#the-branch).

One limit matters for the pilot. A container inside a pylon cannot make an HTTPS request, because only the guest trusts the interception certificate. If the company project's daily work builds images inside the pylon, pull that fix forward from the second plan before the pilot.

## The branch

All work in this plan lands on the long-lived branch `multiplayer`. The operator's own install keeps running from `main` and is not touched.

- [ ] Open every pull request of this plan against `multiplayer`. Name each branch `mp/<id>-<slug>`, for example `mp/03-owner-only`. Do not create a branch whose name starts with `multiplayer/`, because git cannot hold both.
- [ ] Never force-push `multiplayer`.
- [ ] Bring `main` in at least once a week, and before you cut each slice branch. Merge `origin/main` into a branch `mp/sync-<date>`, run `.nexus/check`, and merge that branch into `multiplayer` with a merge commit, not a squash.
- [ ] After each sync, regenerate `src/control/api/auth-matrix.txt` with `NEXUS_AUTH_MATRIX_UPDATE=1` and rerun `node scripts/docs-gen.ts`.
- [ ] Fix a bug that the operator's install also has on `main` first. The fix reaches `multiplayer` through the next sync.
- [ ] Keep the tests of the single-person install green on `multiplayer`. A slice that breaks them is not done.

Two facts about the current code shape the rules above and the first two slices.

- A landing sets the desired release whenever the pull request is in Nexus's own repository, whatever its base branch (`src/control/landing.ts:35`). The deployer then refuses the commit because it is not on `main` (`src/deploy/install.ts:24-34`). So a landing into `multiplayer` on the operator's install starts a deploy that fails and holds other landings. This is read from the code, not run. Slice `main-1` removes it.
- Registry migrations are one numbered list that is never edited once shipped (`src/control/schema.ts:1-10`). Two branches that both append to it collide at every sync. Slice `mp-00` gives the arc its own list.

### How slices get built

- [ ] Until `main-1` is deployed on the operator's install, build each slice by hand and let the operator merge it.
- [ ] After that, a second project on the operator's install may point at the same repository with `defaultBranch` set to `multiplayer`. Two projects may share a repository URL, because only the project ID is unique (`src/control/api/project-routes.ts:25`). Its standing rules must tell builders to open pull requests against `multiplayer`, because the agent chooses the base.

## What was measured before writing

- **Push size.** The pack for each of the last 300 merged changes of the company monorepo has a median of 7.7 KB, a 99th percentile of 0.6 MB, and a maximum of 3.9 MB. None exceeds Gondolin's 64 MiB body limit. This is one run. It measures the squashed change as a full pack, so it overstates a normal push and understates the first push of a long branch. Pushes over HTTPS are therefore not blocked by the limit.
- **The guard against the real GitHub API.** A throwaway guard in Gondolin's request hook ran 77 probes from inside a real VM against a private scratch repository, with real `git`, `gh`, and `curl`. A guard that lists what is allowed refused every merge, approval, and direct landing. A guard that lists what is forbidden let three landings through. Neither broke a push, a pull request, a comment, or a read. [mp-15](#mp-15-the-network-guard-refuses-merge-and-approve) has the details.
- **What depends on the harness.** A Claude worker thread already starts with no harness conversation (`src/control/threads.ts:177`). These features need the harness and are off for engineers until a slice says otherwise: planning threads, `message` briefs, harness `retry`, and the reviewer of a Claude builder (`src/control/review.ts:161-165`). Checks, verify runs, failure judgments, and the pull request watch do not need an engineer's harness thread.

## Decisions this plan takes

The operator decided the items in [What changes](#what-changes). The plan adds these defaults. Each is a judgment, and the operator may overrule it before the slice that builds it starts.

1. An admin may abort, archive, and delete any thread. An admin may not message, attach to, or run commands in another engineer's pylon.
2. Attach and exec are acting, not reading. Only the owner may use them.
3. A pipeline item becomes the thread of the engineer who approves it.
4. Reviews by Nexus are off on a shared install until `mp-17`. From then, one Claude reviewer runs on the login of the engineer who asked for the review.
5. Planning threads stay off on a shared install in this plan.
6. An engineer may run two pylons at once by default. An admin changes the number.
7. The pilot may start with Claude Code alone. Codex follows in `mp-13`.
8. The base image keeps the setup that the repository pins. An engineer's own setup is applied over it at boot.

## Shared tools for proof

Slice `mp-00` builds two tools. Every later slice uses them.

- **The two-person stack.** The local stack of the `verify-nexus` skill, with a fake whois that knows two people, `alice` and `bob`, and one node. Today that stack names every caller as one laptop, so nothing about two people can be shown live.
- **The probe.** `node scripts/mp-probe.ts <name>` prints one of three numbers.
	- `api`: the median and the 95th percentile of 200 `GET /v1/threads` requests against the two-person stack holding 50 threads.
	- `boot`: the time from `POST /v1/threads` to a running pylon booted from its template whose `resume` has exited, for a template boot. The time from `running` to a session's first prompt is not measured on the verify stack, because that stack starts no terminal session, so a slice that changes how a session starts needs its own measure.
	- `check`: the wall time of `.nexus/check`.

For every perf box, measure the base commit first, and alternate base and head. Run `api` and `boot` five times on each side. Run `check` twice on each side. One `check` run takes about 15 minutes in a pylon with 2 CPUs, so five on each side takes about 2.5 hours, which `main-1` spent on a change to one function. A slice fails its perf box when the head's median is above the limit the box names and outside the base's run-to-run range. Two runs give a narrow range, so a `check` result above its limit is run a third time on each side before it fails the box.

A rebase onto a base that moved does not restart the runs, unless it conflicts in code the box measures. Keep the runs in the pull request as a linked file that names the commit each number is from.

A slice is verified only when its unit, live, and perf boxes are all checked. Tests alone do not verify a slice.

### The review's tests

The scripts that the review of this design wrote are in [`interrogate/`](../interrogate/README.md). No check runs that folder. Seven slices start from eight of its tests. Four of those tests fail today and pass when the slice is done. The other four pass today because they assert the fault, and the slice turns each one round. A slice moves its test into `src/` and deletes it from `interrogate/`.

## Slices in landing order

| ID | Change | Waits for | Main files |
|---|---|---|---|
| `main-1` | A landing deploys only when its base is the release branch | nothing, lands on `main` | `src/control/landing.ts` |
| `mp-00` | Two-person stack, probe, the arc's own migration list | nothing | `.claude/skills/verify-nexus/`, `src/test-support/api-kit.ts`, `scripts/mp-probe.ts`, `src/control/schema.ts` |
| `mp-01` | Whois keeps the tailnet user and the tags | `mp-00` | `src/node-base/tailscaled.ts`, `src/control/api/server.ts` |
| `mp-02` | People, roles, and a thread's owner | `mp-01` | `src/control/main.ts`, `src/control/api/access.ts`, `src/control/thread-store.ts`, `src/control/threads.ts` |
| `mp-03` | Only the owner acts on a thread | `mp-02` | `src/control/api/thread-routes.ts`, `pylon-routes.ts`, `question-routes.ts`, `src/control/pipeline.ts` |
| `mp-04` | A read never wakes a pylon | `mp-03` | `src/control/api/pylon-access.ts`, `thread-routes.ts`, `src/control/reconcile.ts` |
| `mp-05` | Admins alone edit projects | `mp-02` | `src/control/api/project-routes.ts` |
| `mp-06` | The CLI and the dashboard show the owner | `mp-02` | `src/control/dashboard/`, `src/cli/commands/` |
| `mp-07` | A secret value can belong to one pylon | `mp-00` | `src/probe/config.ts`, `src/probe/server.ts`, `src/protocol/routes.ts`, `src/backends/pylon-vm/pylon-vm-backend.ts` |
| `mp-08` | Each person stores their own credentials | `mp-02` | `src/deploy/credentials.ts`, new routes, `src/cli/commands/` |
| `mp-09` | A pylon boots with its owner's credentials and git identity | `mp-07`, `mp-08` | `src/control/threads.ts`, `src/control/project.ts`, `src/control/placement.ts`, `src/backends/pylon-boot.ts` |
| `mp-10` | Git goes over HTTPS only | `mp-09` | `src/pylon-vm/network.ts`, `src/backends/pylon-vm/pylon-vm-backend.ts`, `src/control/api/project-routes.ts` |
| `mp-11` | An engineer adds hosts and secrets for their own pylons | `mp-09` | `src/control/threads.ts`, new routes, `src/cli/commands/` |
| `mp-12` | GitHub App tokens for each engineer | `mp-09`, the App's approval | `src/control/github.ts`, new login flow |
| `mp-13` | Codex inside a pylon | `mp-09`, a prototype | `images/pylon/Dockerfile`, `src/protocol/agent-kinds.ts`, `src/probe/guest/launchers.ts` |
| `mp-14` | Nexus never merges | `mp-02` | `src/control/review.ts`, `src/control/github.ts`, `src/control/api/review-routes.ts` |
| `mp-15` | The network guard refuses merge and approve | `mp-10` | `src/pylon-vm/network.ts`, a new guard module |
| `mp-16` | An engineer's thread is a pylon agent | `mp-09` | `src/contract/threads-parse.ts`, `src/control/threads.ts`, `src/control/planning.ts` |
| `mp-17` | A review runs on the asker's login | `mp-16` | `src/control/review.ts` |
| `mp-18` | A template is built from the default branch only | `mp-00` | `src/control/templates.ts`, `src/control/threads.ts` |
| `mp-19` | `nexus setup sync` copies an engineer's config files | `mp-08` | `src/image/agent-setup.ts`, `src/control/overlay.ts`, `src/cli/commands/` |
| `mp-20` | The setup carries plugins and skills | `mp-19` | `src/ids.ts`, `src/protocol/artifacts.ts`, `src/backends/pylon-boot.ts` |
| `mp-21` | The deployer follows a configured release branch | nothing | `src/deploy/install.ts`, `deploy/` |
| `mp-22` | A cap on running pylons for each person | `mp-02` | `src/control/placement.ts` |
| `ops-1` | The office machine can run pylons | nothing | none |
| `ops-2` | The company tailnet tags the node and admits the engineers | nothing | the company infrastructure repository |
| `ops-3` | The shared install runs from `multiplayer` | `mp-21`, `ops-1`, `ops-2` | none |
| `pilot` | Two engineers work on the shared install | see the section | none |

### What may run at the same time

- `mp-00`, `mp-21`, `ops-1`, and `ops-2` start at once. `main-1` is separate because it lands on `main`.
- After `mp-00`: `mp-01`, `mp-07`, and `mp-18` are independent of each other.
- After `mp-02`: `mp-03`, `mp-05`, `mp-06`, `mp-08`, `mp-14`, and `mp-22` branch from `multiplayer` independently. `mp-04` follows `mp-03` because both edit `thread-routes.ts`.
- After `mp-09`: `mp-10`, `mp-11`, `mp-12`, `mp-13`, and `mp-16` are independent. `mp-10` and `mp-15` both edit `src/pylon-vm/network.ts`, so `mp-15` follows `mp-10`.
- Two slices that name the same file never run at the same time.

### What waits for the operator

- Every slice that changes what a person sees or types waits for the operator's review before merge: `mp-03`, `mp-06`, `mp-08`, `mp-11`, `mp-12`, `mp-14`, `mp-15`, `mp-16`, `mp-17`, `mp-19`, `mp-20`, and `mp-22`.
- Every slice that touches a path [the merge policy](merge-policy.md) reserves is held for the operator as that policy says. That covers auth, login, whois, `src/control/review.ts`, `src/control/main.ts`, and `deploy/`, so it covers most of this plan.
- `mp-12` waits for an owner of the company's GitHub organisation to approve the App.

## The slices

### main-1: a landing deploys only when its base is the release branch

- [ ] **Base.** `main`, not `multiplayer`.
- [ ] **Files.** `src/control/landing.ts`, its test.
- [ ] **Change.** A landing sets the desired release only when the pull request's base is the branch the deployer releases from.
- [ ] **Result.** A pull request merged into another branch of the Nexus repository lands and starts no deploy.
- [ ] **Unit.** A landing whose base is `multiplayer` leaves the desired release unchanged. A landing whose base is `main` sets it as before.
- [ ] **Live.** On the operator's install, land a no-op pull request into a scratch branch. Pass when `nexus deploy --wait` reports the release unchanged and a landing into `main` queued behind it is not held.
- [ ] **Perf.** `check`. Fail above 10% over base.

### mp-00: the two-person stack, the probe, and the arc's own migration list

- [x] **Depends on.** Nothing.
- [ ] **Files.** `.claude/skills/verify-nexus/`, `src/test-support/api-kit.ts`, `scripts/mp-probe.ts`, `src/control/schema.ts`, `src/control/schema.test.ts`.
- [x] **Change.** Build the two tools in [Shared tools for proof](#shared-tools-for-proof). Add a second ordered migration list that this arc appends to, with its own counter, applied after the main list.
- [x] **Result.** The stack answers as `alice` and as `bob`. The probe prints the three numbers. No behaviour of Nexus changes.
- [x] **Unit.** A registry that applied an arc migration accepts a later main migration, and the reverse. The existing re-apply rule in `schema.test.ts` holds for both lists.
- [x] **Live.** Start the stack. Pass when `nexus threads` as `alice` and as `bob` both answer, and the whois stand-in reports two different users.
- [ ] **Perf.** Record the `api`, `boot`, and `check` baselines on `multiplayer` and commit them as the file later slices compare against. Fail when five runs of `api` differ by more than 20% from each other, because the probe is then too noisy to use.

### mp-01: whois keeps the tailnet user and the tags

- [x] **Depends on.** `mp-00`.
- [x] **Files.** `src/node-base/tailscaled.ts`, `src/control/api/server.ts`, their tests.
- [x] **Change.** The whois client keeps `UserProfile.LoginName` and the node's tags beside `Node.StableID`. `admitted` passes them on. No policy reads them yet.
- [x] **Result.** A request's caller carries a user and tags. Every decision is the same as before.
- [x] **Unit.** A whois answer for a user-owned device yields the user. A whois answer for a tagged device yields tags and no user.
- [ ] **Live.** On the company tailnet, call the control plane from a personal device and from a tagged device. Pass when the log names the user for the first and no user for the second. This also settles what the install exploration could not check, the whois answer for a tagged device.
- [x] **Perf.** `api`. Fail above 15% over base.

### mp-02: people, roles, and a thread's owner

- [x] **Depends on.** `mp-01`.
- [x] **Files.** `src/control/main.ts`, `src/control/api/access.ts`, `src/control/thread-store.ts`, `src/control/threads.ts`, `src/control/queue.ts`, the arc's migration list.
- [x] **Change.** `control.json` gains `people`, a map from tailnet user to `admin` or `engineer`. With `people` set, a caller is admitted by user, a device with tags or in the node registry is never a person, and `callers` and `deployers` must be absent. An admin holds what a deployer holds today. Each thread gets an `owner`. `startedBy` keeps its meaning, a device or a role name. One value built at startup says whether the install is shared, and modules read that value, not the config.
- [x] **Result.** On a shared install every thread has an owning person. On an install without `people`, the one person owns every thread and nothing else changes.
- [x] **Unit.** `interrogate/node-is-not-person.test.ts` asserts the fault. Turn it round, so that it shows a tagged device refused on person routes. A config with both `people` and `callers` fails to load. The migration gives every existing thread the single person as owner.
- [x] **Live.** On the two-person stack, `alice` starts a thread. Pass when `nexus show` as `bob` names `alice` as its owner, and a call from the node's identity to a person route gets 403.
- [x] **Perf.** `api`. Fail above 15% over base.

### mp-03: only the owner acts on a thread

- [ ] **Depends on.** `mp-02`.
- [ ] **Files.** `src/control/api/thread-routes.ts`, `src/control/api/pylon-routes.ts`, `src/control/api/question-routes.ts`, `src/control/questions.ts`, `src/control/api/server.ts`, `src/control/pipeline.ts`, `src/control/api/auth-matrix.txt`.
- [ ] **Change.** A new route policy, owner. It guards message, abort, retry, pylon retry, unarchive, previews, sessions, attach, exec, review start and cancel, and question answers. Archive, abort, and delete also admit an admin. `seen` becomes one mark for each person, not one for the thread. A pipeline item becomes the thread of the person who approves it.
- [ ] **Result.** A teammate who tries to act on another engineer's thread gets 403 with a message that names the owner.
- [ ] **Unit.** `interrogate/03-another-user-starts-your-thread.test.ts` passes. Each guarded route refuses a non-owner and admits the owner. The auth matrix snapshot lists the owner policy.
- [ ] **Live.** As `bob`, run `nexus send`, `nexus attach`, and `nexus archive` on a thread of `alice`. Pass when all three are refused and the thread's conversation shows no new message. As an admin, `nexus archive` succeeds.
- [ ] **Perf.** `api`. Fail above 15% over base.

### mp-04: a read never wakes a pylon

- [ ] **Depends on.** `mp-03`.
- [ ] **Files.** `src/control/api/pylon-access.ts`, `src/control/api/pylon-routes.ts`, `src/control/api/thread-routes.ts`, `src/control/reconcile.ts`, `src/probe/gateway.ts`, `src/control/dashboard/page.js`.
- [ ] **Change.** The activity route admits the owner only. Files, file content, changes, and diff record human activity and wake the pylon only for the owner. For anyone else they answer from a running pylon, and say the pylon is paused when it is not. A preview hit counts as activity only when its tailnet user is the owner.
- [ ] **Result.** A teammate browsing a thread leaves its pylon's state and idle clock as they were.
- [ ] **Unit.** `interrogate/read-wakes.test.ts` passes. `interrogate/reader-wakes-owner-pylon.test.ts` asserts the fault. Turn it round, so that it shows a reader's visit leaving the pylon paused.
- [ ] **Live.** Pause a pylon of `alice`. As `bob`, open the thread in the dashboard and its diff. Pass when the pylon is still paused after 60 seconds and `lastHumanActivityAt` has not moved.
- [ ] **Perf.** `api`. Fail above 15% over base.

### mp-05: admins alone edit projects

- [ ] **Depends on.** `mp-02`.
- [ ] **Files.** `src/control/api/project-routes.ts`, `src/control/api/auth-matrix.txt`.
- [ ] **Change.** On a shared install, project add, edit, and remove admit an admin only.
- [ ] **Result.** An engineer can read a project and cannot change it.
- [ ] **Unit.** An engineer's `PATCH /v1/projects/<id>` gets 403. An admin's succeeds.
- [ ] **Live.** As `bob`, an engineer, run `nexus project edit` on the stack's project. Pass when it is refused and `nexus project show` is unchanged.
- [ ] **Perf.** `check`. Fail above 10% over base.

### mp-06: the CLI and the dashboard show the owner

- [ ] **Depends on.** `mp-02`.
- [ ] **Files.** `src/control/dashboard/timeline.ts`, `src/control/dashboard/flight.ts`, `src/control/dashboard/home.ts`, `src/control/api/thread-view.ts`, `src/cli/commands/`, `src/control/usage.ts`.
- [ ] **Change.** Thread lists and thread pages show the owner's name where they show a raw node ID today. On a shared install the lists open on the caller's own threads, with a way to see everyone's. `nexus usage` adds a total for each owner.
- [ ] **Result.** An engineer sees their own work first and can tell whose thread any other one is.
- [ ] **Unit.** A thread view carries the owner. The usage rollup sums by owner.
- [ ] **Live.** With threads of both people on the stack, open the dashboard as `bob`. Pass when the home table shows only `bob`'s threads by default, the switch shows both, and each row names its owner. Attach screenshots.
- [ ] **Perf.** `api`. Fail above 15% over base.

### mp-07: a secret value can belong to one pylon

- [x] **Depends on.** `mp-00`.
- [x] **Files.** `src/probe/config.ts`, `src/probe/server.ts`, `src/protocol/routes.ts`, `src/backends/pylon-vm/pylon-vm-backend.ts`, `src/backends/docker-backend.ts`.
- [x] **Change.** Today a node holds one value for each secret name, so two engineers' tokens cannot both exist on a node. The control plane can now hand a probe a value for one pylon, kept in memory only. A boot reads the pylon's value before the node's. A changed value reaches that running pylon and no other.
- [ ] **Result.** Two pylons on one node can hold different values under one secret name.
- [x] **Unit.** Two pylons with different values for one name each send their own value. Updating one leaves the other unchanged. A probe restart loses the values and the control plane hands them over again.
- [ ] **Live.** On a VM node, boot two pylons with different values for a test secret granted to a recording host. Pass when the recorder sees each pylon's own value and neither guest can read its value from the environment or disk.
- [x] **Perf.** `boot`. Fail above 10% over base.

### mp-08: each person stores their own credentials

- [ ] **Depends on.** `mp-02`.
- [ ] **Files.** `src/deploy/credentials.ts`, a new route module, `src/cli/commands/`, the arc's migration list.
- [ ] **Change.** The `stores` table gains a per-person store on the control plane's machine, one file for each person, mode 0600, as [the install exploration](explorations/install.md#per-person-credentials) sketched. A person sets or removes only their own credential. No route returns a stored value. `nexus login claude` and `nexus login github` read a token from standard input and store it. `nexus logins` says which kinds the caller has set. `deploy/README.md` says which permissions an engineer's GitHub token needs: contents and pull requests, read and write. It must not hold the workflows or the administration permission, for the reasons in [mp-15](#mp-15-the-network-guard-refuses-merge-and-approve).
- [ ] **Result.** An engineer runs two commands once, and the control plane holds their Claude token and GitHub token.
- [ ] **Unit.** `alice` cannot set or remove a credential of `bob`. A node or a pylon cannot call the routes. No response body contains a stored value.
- [ ] **Live.** As `alice`, pipe a token into `nexus login claude`. Pass when `nexus logins` shows Claude as set for `alice` and not for `bob`, and the store file is mode 0600 and owned by the control plane's user.
- [ ] **Perf.** `check`. Fail above 10% over base.

### mp-09: a pylon boots with its owner's credentials and git identity

- [ ] **Depends on.** `mp-07`, `mp-08`.
- [ ] **Files.** `src/control/threads.ts`, `src/control/project.ts`, `src/control/placement.ts`, `src/backends/pylon-boot.ts`, `src/protocol/secret-grants.ts`.
- [ ] **Change.** On a shared install a thread's Claude token and `GH_TOKEN` come from its owner's store, fixed when the thread starts and delivered as values for that one pylon. A start with a missing login fails and names the login. There is no fallback to a shared value. A project can no longer grant those names. The git author is the owner's, read from their GitHub login when they sign in. The project's and the install's `gitIdentity` are ignored. A thread the control plane starts for a person, such as a check, uses the credentials of the person whose action led to it.
- [ ] **Result.** Whatever an agent does with a token in a pylon, it does as that pylon's owner.
- [ ] **Unit.** `interrogate/project-edit-redirects-token.test.ts` asserts the fault. Turn it round, so that it shows a project edit by one person changing no host that receives another person's token and no commit author. A start without a Claude login fails with a reason that names it.
- [ ] **Live.** `alice` and `bob` each start a thread on one project on one VM node. Pass when a recording host sees `alice`'s token only from `alice`'s pylon, and a commit made in each pylon has that owner's name and address.
- [ ] **Perf.** `boot`. Fail above 10% over base.

### mp-10: git goes over HTTPS only

- [ ] **Depends on.** `mp-09`.
- [ ] **Files.** `src/pylon-vm/network.ts`, `src/backends/pylon-vm/pylon-vm-backend.ts`, `src/control/api/project-routes.ts`, `src/contract/projects-parse.ts`.
- [ ] **Change.** Today git over SSH uses one key for the whole node, so every engineer would push as the same identity and no HTTP guard would see the push. On a shared install a project's `repoUrl` must be HTTPS, a boot carries no SSH key and no SSH remote, and git authenticates with the owner's `GH_TOKEN` placeholder.
- [ ] **Result.** Every push from a pylon carries its owner's token and passes through the HTTP hook.
- [ ] **Unit.** `interrogate/ssh-node-key-shared.test.ts` asserts the fault. Turn it round, so that it shows a boot with no SSH key and no SSH remote. Adding a project with an SSH URL is refused on a shared install.
- [ ] **Live.** In `alice`'s pylon, push a branch to the scratch repository. Pass when GitHub shows the push as hers and `ssh -T git@github.com` from the pylon is refused.
- [ ] **Perf.** Time a push of a 5 MiB commit from a VM pylon. The review measured 0.9 seconds for that push through Gondolin. Fail above 3 seconds.

### mp-11: an engineer adds hosts and secrets for their own pylons

- [ ] **Depends on.** `mp-09`.
- [ ] **Files.** `src/control/threads.ts`, `src/control/project.ts`, a route module, `src/cli/commands/`.
- [ ] **Change.** A person keeps a list of allowed hosts and of named secrets with the hosts that receive them. A pylon's allowlist and grants are its project's plus its owner's, fixed at start. An admin can list everyone's hosts and secret names, never the values.
- [ ] **Result.** An engineer's own MCP servers and tools work in their pylons without an admin editing the project.
- [ ] **Unit.** `alice`'s host is reachable from her pylon and refused from `bob`'s. A person cannot grant one of the names `mp-09` reserves.
- [ ] **Live.** As `alice`, add a host and a secret, then start a thread. Pass when her pylon reaches the host with the secret swapped in, `bob`'s new pylon gets 403 for the same host, and `nexus people` as an admin lists the host.
- [ ] **Perf.** `boot`. Fail above 10% over base.

### mp-12: GitHub App tokens for each engineer

- [ ] **Gate.** An owner of the company's GitHub organisation approves the App. Until then engineers use fine-grained personal access tokens through `mp-08`, and no other slice waits for this one.
- [ ] **Depends on.** `mp-09`.
- [ ] **Files.** A new login flow, `src/control/github.ts`, `src/cli/commands/`, `deploy/README.md`.
- [ ] **Change.** `nexus login github` runs the App's device flow. The control plane keeps the refresh token, renews the eight-hour user token before it expires, and hands each new value to that person's running pylons through the path `mp-07` built. The control plane's own GitHub credential becomes the App's installation token with read access and the write access that labels need, and no access that can merge.
- [ ] **Result.** An engineer signs in once in a browser. Their pull requests are authored by them, and no long-lived GitHub token is stored.
- [ ] **Unit.** A token within ten minutes of expiry is renewed and pushed to the owner's pylons only. A failed renewal marks the login as broken and names it in `nexus logins`.
- [ ] **Live.** Sign in as a real engineer, open a pull request from a pylon, and wait past one renewal. Pass when the pull request's author is the engineer and a push after the renewal succeeds.
- [ ] **Perf.** `api`. Fail above 15% over base.

### mp-13: Codex inside a pylon

- [ ] **Prototype first.** Nexus has no Codex agent kind and the image does not install the Codex CLI. Show, in a throwaway VM, that the Codex CLI works when its access token is a placeholder swapped at the network edge, and that the control plane can own the rotating refresh token for one person. If either fails, stop and report. Do not build the slice on a guess.
- [ ] **Depends on.** `mp-09`.
- [ ] **Files.** `images/pylon/Dockerfile`, `src/protocol/agent-kinds.ts`, `src/probe/guest/launchers.ts`, `src/control/chatgpt-token.ts`.
- [ ] **Change.** The image installs the Codex CLI. A new agent kind signs it in from the owner's stored login. The control plane refreshes each person's login and pushes the access token to their pylons.
- [ ] **Result.** An engineer opens a Codex session in their pylon and it runs on their own subscription.
- [ ] **Unit.** Two people's pylons receive different tokens. A refresh for one person never races another refresh of the same login.
- [ ] **Live.** As a real engineer, open a Codex session in a pylon and ask it one question. Pass when it answers, and the token readable inside the guest is the placeholder.
- [ ] **Perf.** `boot`. Fail above 10% over base.

### mp-14: Nexus never merges

- [ ] **Depends on.** `mp-02`.
- [ ] **Files.** `src/control/review.ts`, `src/control/github.ts`, `src/control/api/review-routes.ts`, `src/control/api/question-routes.ts`, `src/control/api/project-routes.ts`, `src/control/main.ts`.
- [ ] **Change.** Every merge goes through one call, `github.merge` at `src/control/review.ts:836`. On a shared install the control plane builds its GitHub client without `merge` and without the branch update, so no code path can call them. The five ways to ask for a landing are refused with one reason, `landing-off`: a review start with `land`, `POST /land`, the Land answer to a holds question, a project's `land` or `yolo` mode, and the automatic answer in `yolo` mode. An approved review ends by telling the owner that an engineer merges on GitHub.
- [ ] **Result.** No action by any person or agent makes Nexus merge a pull request.
- [ ] **Unit.** Each of the five paths is refused. The two existing tests that prove a landing merges still pass on an install without `people`.
- [ ] **Live.** On the two-person stack with the scratch repository, run `nexus land` as an admin on an approved review. Pass when it is refused with `landing-off` and the pull request is still open on GitHub.
- [ ] **Perf.** `check`. Fail above 10% over base.

### mp-15: the network guard refuses merge and approve

A prototype settled the shape of this guard before the plan was written. It ran three times, 77 probes each, from a real VM against a private scratch repository. The prototype is in `interrogate/guard-github/`, and the pull request that adds this plan carries the full table as a comment.

- A guard that lists forbidden operations let three landings through: the GraphQL mutations `mergeBranch` and `createCommitOnBranch` on the default branch, and a REST change of the repository's default branch. GitHub has more ways to land a change than a list of known ones will hold.
- A guard that lists allowed operations refused all of them and broke none of the twelve operations that must work.
- Matching on the text of a GraphQL body is not enough. GitHub accepted a JSON-escaped mutation name, and read a review's event from a variable and from a variable's default value. What caught every shape was parsing the JSON, parsing the document with a GraphQL parser, resolving variables and defaults, expanding fragments, and checking every operation in the document.
- GitHub also accepts `/repositories/<id>/…` in place of `/repos/<owner>/<name>/…`.
- Gondolin 0.13.0 answers 502 to any request with `Expect: 100-continue`, with or without a guard. `curl` adds that header to a body over 1 MiB. A hook that drops the header fixes it.

The slice:

- [ ] **Depends on.** `mp-10`, so that no push travels over SSH past the hook.
- [ ] **Files.** A new guard module beside `src/pylon-vm/network.ts`, `src/pylon-vm/network.ts`, `src/pylon-vm/host-bridge.ts`, `package.json` for the GraphQL parser.
- [ ] **Change.** On a shared install every pylon's request hook applies an allow-list to `api.github.com` and to git over HTTPS on `github.com`. One table in the guard module names the REST method and route pairs and the GraphQL operations that pass. Everything else is refused with a 403 whose body names the guard and the reason, and the refusal goes to the pylon's log. The guard parses bodies as the prototype did. It treats a review whose event resolves to approve as refused in every form. It refuses a write to the default branch through the API and a push to it through git. It reads the default branch from the project, not from a constant. It drops the `Expect` header.
- [ ] **Result.** An agent holding an engineer's token can push a branch, open and update a pull request, comment, and read. It cannot merge, approve, or land a change by another route.
- [ ] **Unit.** The prototype's probes become a table of recorded requests, each with the decision the guard must make. No test needs the network.
- [ ] **Live.** Rerun the probe list from a VM pylon against the scratch repository with the built guard. Pass when no probe that must be refused reaches GitHub and every probe that must pass succeeds. Then, with a second GitHub account, try to approve the first account's pull request from a pylon. Pass when the guard refuses it. The prototype had one account, so GitHub's own rule against approving your own pull request hid this case.
- [ ] **Perf.** The median of 20 runs of `gh pr view` from a pylon, with and without the guard. Fail above 10% over the run without it.

Three limits of this guard, each handled elsewhere:

- The allow-list refuses every operation it does not name. The prototype did not probe closing a pull request, creating an issue, labels, or releases. The operator reviews the table before merge, and each later addition is a reviewed change.
- A token that holds the workflows permission can push a workflow file, and that workflow then runs on GitHub outside the hook. Engineers' tokens must not hold it. `mp-08` says so for personal access tokens, and the App in `mp-12` does not request it.
- The guard does not replace the repository's own rule. The company monorepo requires a pull request and one approving review on its default branch. That rule stops a direct landing even without the guard. The guard is what stops an agent that holds one engineer's token from approving another engineer's pull request. The second half of that sentence is reasoned, not run.

### mp-16: an engineer's thread is a pylon agent

- [ ] **Depends on.** `mp-09`.
- [ ] **Files.** `src/contract/threads-parse.ts`, `src/control/threads.ts`, `src/control/api/thread-routes.ts`, `src/control/planning.ts`, `src/control/pipeline.ts`, `src/control/review.ts`, `src/control/dashboard/`.
- [ ] **Change.** On a shared install a person's thread start must name a pylon agent, and no harness conversation is created for it. Routes that only a harness thread has are refused with a reason: a `message` brief, harness `retry`, and planning. A pipeline item must name a pylon agent. A review start is refused until `mp-17`. Failure judgments keep running on the install's one login.
- [ ] **Result.** No engineer's work spends the install's shared model login. The dashboard and the CLI do not offer what is off.
- [ ] **Unit.** `interrogate/02-harness-login-is-one.test.ts` passes in this form: on a shared install two people's thread starts make no model request from the control plane. Each refused route names its reason.
- [ ] **Live.** As `alice`, start a thread with no agent named. Pass when the start is refused with a message that says which agents are available, and a start with Claude Code runs a turn on her token.
- [ ] **Perf.** `boot`. Fail above 10% over base.

### mp-17: a review runs on the asker's login

- [ ] **Depends on.** `mp-16`. Not needed for the pilot.
- [ ] **Files.** `src/control/review.ts`, its tests.
- [ ] **Change.** Today the reviewer of a Claude builder is a harness thread, and the second reviewer needs the project's Claude grant. On a shared install the reviewer is one Claude worker whose owner is the engineer who asked for the review. There is no second reviewer.
- [ ] **Result.** An engineer can ask Nexus to review their thread before a colleague does, and the review runs on their own subscription.
- [ ] **Unit.** A review that `alice` starts creates a reviewer thread owned by `alice` and makes no model request from the control plane.
- [ ] **Live.** As `alice`, start a review of a thread with an open pull request. Pass when a verdict arrives, the reviewer's pylon carried her token, and nothing was merged or approved on GitHub.
- [ ] **Perf.** Time from review start to the first verdict on a fixed small change. Fail above 20% over the same review on an install without `people`.

### mp-18: a template is built from the default branch only

- [ ] **Depends on.** `mp-00`.
- [ ] **Files.** `src/control/templates.ts`, `src/control/threads.ts`, `src/control/template-builds.ts`, `src/protocol/images.ts`.
- [ ] **Change.** A template's key holds no branch, commit, or owner, and a build checks out the starting thread's commit. So one engineer's branch can leave code on the disk another engineer's pylon boots from. On a shared install a build always runs at the default branch's head. A thread whose setup inputs differ from the default branch's boots fresh.
- [ ] **Result.** The only code that ran on a shared boot disk is code that was merged after review.
- [ ] **Unit.** `interrogate/01-template-crosses-principals.test.ts` passes.
- [ ] **Live.** On the two-person stack, `alice` starts a thread on a branch that changes a script that setup runs. Then `bob` starts a thread on the default branch. Pass when `bob`'s checkout holds no file that `alice`'s branch wrote.
- [ ] **Perf.** `boot` for a template boot on the default branch. Fail above 10% over base. Record the fresh-boot time for a branch that changes setup inputs, so the cost of the rule is known.

### mp-19: `nexus setup sync` copies an engineer's config files

- [ ] **Depends on.** `mp-08`.
- [ ] **Files.** `src/image/agent-setup.ts`, `src/control/overlay.ts`, `src/control/live.ts`, a route module, `src/cli/commands/`.
- [ ] **Change.** `nexus setup sync` runs on the engineer's own machine, macOS or Linux. It reads a fixed list of text files: Claude Code's settings, rules, and `CLAUDE.md`, and Codex's config and `AGENTS.md`. It uploads them to the control plane under the caller. It never reads a credentials file, and it replaces a secret value in a config with the name of a secret from `mp-11`. Every boot of that person's pylons writes the files through the existing overlay path, after the common dotfiles. `nexus setup show` lists what is stored.
- [ ] **Result.** An engineer runs one command, and their next pylon has their settings and rules.
- [ ] **Unit.** The capture reads only the listed files. A file over the overlay's 1 MiB limit is refused by name. `bob`'s pylon never receives `alice`'s files.
- [ ] **Live.** As `alice`, run `nexus setup sync` on a machine with a distinctive line in `CLAUDE.md`, then start a thread. Pass when Claude Code in her pylon shows that line in its loaded memory and `bob`'s pylon does not.
- [ ] **Perf.** `boot`. Fail above 10% over base.

### mp-20: the setup carries plugins and skills

- [ ] **Depends on.** `mp-19`.
- [ ] **Files.** `src/image/agent-setup.ts`, `images/pylon/agent-setup/`, `src/ids.ts`, `src/protocol/artifacts.ts`, `src/backends/pylon-boot.ts`, `src/control/placement.ts`.
- [ ] **Change.** Plugins and skills cannot be installed at boot, because a pylon reaches only allowed hosts and a boot hook has 120 seconds. So `nexus setup sync` also resolves the engineer's plugins and skills with the planner that captures the image's setup today, packs the files into one bundle named by its hash, and uploads it. Bundles become a third kind of artifact beside images and templates, so nodes copy them the same way. A boot unpacks the owner's bundle over the image's baked setup.
- [ ] **Result.** An engineer's pylon has the plugins and skills of their own machine, without an image for each person.
- [ ] **Unit.** The same setup yields the same bundle ID. A boot with a missing bundle fails with a reason that names it. The leave-out rules that apply to the image apply to a bundle.
- [ ] **Live.** As `alice`, sync a setup with a plugin the base image lacks, then start a thread. Pass when Claude Code in her pylon lists the plugin as installed and Claude Code in `bob`'s pylon does not.
- [ ] **Perf.** `boot` with a bundle made from the operator's own setup. Fail when the median boot grows by more than 20 seconds, or when the unpack step alone exceeds 60 seconds, half the hook's limit.

### mp-21: the deployer follows a configured release branch

- [ ] **Depends on.** Nothing.
- [ ] **Files.** `src/deploy/install.ts`, `src/control/api/release-routes.ts`, `deploy/install.sh`, `deploy/README.md`.
- [ ] **Change.** The deployer installs only a commit that is an ancestor of `origin/main`. A setting names the release branch, with `main` as the default. The installer takes the first admin's tailnet user and writes `people`.
- [ ] **Result.** A shared install releases from `multiplayer`. Every other install is unchanged.
- [x] **Unit.** With the setting at `multiplayer`, a commit on `multiplayer` installs and a commit only on `main` is refused. With no setting, today's tests pass.
- [ ] **Live.** On a fresh machine, install with the release branch set to `multiplayer` and run `nexus deploy`. Pass when the running release is the head of `multiplayer` and every service reports healthy.
- [ ] **Perf.** Wall time of one `nexus deploy --wait`. Fail above 10% over base.

### mp-22: a cap on running pylons for each person

- [ ] **Depends on.** `mp-02`.
- [ ] **Files.** `src/control/placement.ts`, `src/control/main.ts`.
- [ ] **Change.** A pylon's QEMU process never returns memory, so each running pylon holds its full size plus about 0.15 GiB on the host. Admission refuses a start or a wake when the owner already runs their cap, two by default, set for each person in `people`.
- [ ] **Result.** One engineer cannot take the whole machine.
- [ ] **Unit.** A third start is refused with a reason that names the cap and the owner's running threads. An admin's higher cap for one person applies to that person only.
- [ ] **Live.** As `alice`, start three threads. Pass when the third is held with the reason shown by `nexus show`, and starts once she pauses one.
- [ ] **Perf.** `api`. Fail above 15% over base.

### ops-1: the office machine can run pylons

The machine is reachable only from the company network, so the operator runs this.

- [ ] Run `ls -l /dev/kvm`, `nproc`, `free -g`, and `df -h` on the machine. Pass when `/dev/kvm` exists and the control plane's user can open it.
- [ ] Work out how many pylons fit: usable memory divided by the project's pylon size plus 0.15 GiB. The smallest pylon is 3 GiB. Write the number here, because it sets the cap in `mp-22`.
- [ ] Record the machine's CPU count, memory, disk, and operating system in the pilot's notes.

### ops-2: the company tailnet tags the node and admits the engineers

This change lives in the company's infrastructure repository, not here.

- [ ] Give the Nexus machine its own tag. A tagged device has no user, so Nexus never treats it as a person.
- [ ] Add a grant from the engineers' group to that tag on the control plane's port and the preview ports.
- [ ] Turn on MagicDNS and HTTPS certificates if they are off, as the installer requires.
- [ ] Pass when an engineer's laptop reaches the control plane's address and a device outside the group does not.

### ops-3: the shared install runs from `multiplayer`

- [ ] **Depends on.** `mp-21`, `ops-1`, `ops-2`, and the pilot set below.
- [ ] Install on the office machine with the release branch `multiplayer` and the operator as the first admin.
- [ ] Sign the install's one model login in, for failure judgments only.
- [ ] Build and roll out the image.
- [ ] Add the company project with an HTTPS repository URL.
- [ ] Pass when `nexus doctor` reports no failed check.

### pilot: two engineers work on the shared install

The pilot set is `mp-00` to `mp-05`, `mp-07` to `mp-10`, `mp-14`, `mp-15`, `mp-16`, `mp-18`, `mp-21`, and `mp-22`. The pilot needs neither `mp-12` nor `mp-13`.

Two engineers, A and B, each do the following on real work for one week. Every line is a pass predicate.

- [ ] A and B each sign in with `nexus login claude` and `nexus login github`.
- [ ] Each starts a thread on the company project. Each pull request's author on GitHub is the engineer who started the thread.
- [ ] B cannot message, attach to, or archive A's thread. B can read it, and A's paused pylon stays paused.
- [ ] From inside A's pylon, `gh pr merge` and `gh pr review --approve` on B's pull request are refused by the guard, and the refusal is in the pylon's log.
- [ ] `nexus land` is refused with `landing-off`.
- [ ] Revoke A's Claude token. A's next turn fails with a reason that names the login, and B's threads keep working.
- [ ] B's pylon does not boot from a disk that A's branch ran code on.
- [ ] A third start by one engineer is held by the cap.
- [ ] The operator's own install on `main` ran the whole week with no change from this work.

## What stays unproven

- Whether the office machine has `/dev/kvm`. `ops-1` settles it.
- Whether the Codex CLI works with a token swapped at the network edge. `mp-13` starts with that prototype.
- Whether the company approves the GitHub App. `mp-12` waits for it, and nothing else does.
- Whether the guard refuses an approval of another person's pull request. The prototype had one GitHub account. The live box of `mp-15` settles it.
- Whether the guard holds with the company repository's rules in place. The scratch repository could not carry a ruleset.
- What whois returns for a tagged device on the company tailnet. `mp-01` settles it live.
- Whether a Claude token from a team subscription behaves like the personal one that Nexus uses today. The first sign-in of the pilot shows it.
- How large a setup bundle is and how long it takes to unpack. `mp-20` measures it and has a limit.
- Whether the arc's own migration list is enough to keep syncs from `main` clean. `mp-00` tests it, and the first sync that carries a migration from `main` proves it.
- How `multiplayer` returns to `main`. This plan does not decide it. Every arc migration must be correct for an install with one person, so that the choice stays open.

## Found during the review, fixed elsewhere

- A pylon controller that dies leaves its QEMU process running, and the next start boots a second one. The operator's install has this today. Fix it on `main`.
- The four network-path problems under [Not in this plan](#not-in-this-plan).
