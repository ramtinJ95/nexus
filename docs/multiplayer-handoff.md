# Multiplayer arc: handoff of 2026-11-27

This page lets the work on [the plan](multiplayer-plan.md) continue from another machine. It records where every slice stands, what runs right now, what waits for the operator, and how a slice goes from a brief to a merge. The plan stays the source for what each slice is. Delete this page when the pilot is done.

## Where things stand

| What | Commit |
| --- | --- |
| `multiplayer` | 5b49b259, which contains `main` |
| `main` | 92146ab2 |
| The release the one-person install runs | 92146ab2, healthy on all three roles |

Merged into `multiplayer`: `mp-00` to `mp-11`, `mp-14`, `mp-15`, `mp-16`, `mp-18`, `mp-21`, `mp-22` and `mp-24`. That is 19 slices. `main-1` and the installer's Fedora fixes are on `main` and deployed. `ops-1` is done.

The pilot's code is complete, with one exception: `mp-25`, which the pilot needs only when work in a pylon downloads a release from `github.com`.

One pull request of a slice is open: #730, `mp-25`.

## What runs now

Both threads are in the project `nexus-mp`. Nothing watches them once the old machine is off, so look with `nexus show <thread>`.

| Slice | Thread | Branch | State | Before a merge |
| --- | --- | --- | --- | --- |
| `mp-25`, the guard lets downloads through | `th-1f7854ab0652` | `mp/25-guard-downloads` | #730, approved by the Nexus review in round 1 at c6520042, live check passed, merges cleanly with `multiplayer` | The trial below, then the operator's own review |
| `mp-17`, a review runs on the asker's login | `th-5cb1991ac300` | `mp/17-review-on-asker` | Building, no pull request yet | The operator's own review |

#730 passed the trial at c65200420a460df8fc9c4a12316819e48462f956 on `multiplayer` 5b49b259, with tree 38d9c378: the type check is clean, the tests fail only the three this machine fails at every base, and the landing model holds. It waits only for the operator's yes. If `multiplayer` moves first, run the trial again. Its thread lists a holds question that offers Land. Leave it unanswered.

It adds read rows for release assets, source archives and raw files on `github.com`, with `GET` and `HEAD` only, and it refuses Git LFS by name. GitHub redirects each of those reads to another host, and the slice adds no host to an allowlist. So a download works only in a project whose hosts include `release-assets.githubusercontent.com`, `codeload.github.com` or `raw.githubusercontent.com`, whichever the download needs.

What each builder was told beyond the plan:

- **`mp-25`** changes only `github-guard.ts`, its test and `interrogate/guard-github/probes.mjs`. Git LFS stays refused and the pull request names it. It adds no host to an allowlist.
- **`mp-17`** stops and reports before it writes code when the cap of two pylons a person keeps a review from running. `mp-22` counts every running pylon the person owns, and a review adds a reviewer, a check and a verify pylon. It also says whether a review's pylons can run one after another, because the office machine fits three pylons of 8 GiB. Reviews that start on their own stay off on a shared install, since they have no asker.
- `mp-17` changes `review.ts`, which the landing model covers. After its merge, confirm the model as [after a merge](#after-a-merge) describes.

## What has not started

| Slice | Waits for | Note for its brief |
| --- | --- | --- |
| `mp-12`, GitHub App tokens | An organisation owner's approval of the App | A rotated token reaches a running pylon only after its probe restarts. An App token lasts 8 hours, so this slice adds the push on change, for a person's own secrets too |
| `mp-13`, Codex inside a pylon | Nothing | Prototype first, as the plan says. The image has no Codex CLI yet |
| `mp-19`, `nexus setup sync` | Nothing | Own review |
| `mp-20`, plugins and skills | `mp-19` | Own review |
| `mp-23`, a start waits in line | Nothing | Own review. In the pilot only when pylons are larger than 6 GiB |
| `ops-2`, `ops-3`, pilot | The operator | See below |

Found on the way, with no slice in the plan yet:

- **A local account may pass as the control plane.** The probe takes a caller for the control plane by the tailnet identity of the connection alone. On a one-machine install the control plane is that machine, so an account on it that connects from the machine's own tailnet address may pass. This comes from reading the code and nobody has reproduced it. Test, as an ordinary user on the control plane's machine: `curl -s -o /dev/null -w '%{http_code}\n' "http://$(tailscale ip -4):7480/v1/node-health"`. A 200 confirms it, and then a slice that adds a key to those calls belongs in the pilot set, because the office machine has other people's accounts. A 403 retires the finding.
- **The daily backup skips `people/`.** A restore loses every stored login, host and secret.
- **The `api` probe gives two different medians**, about 3.5 ms and about 7 ms, for a cause nobody has found. The perf box of `mp-00` stays open, and an `api` box of a later slice is weak proof.
- **A template build still uses the project's grants and the node's key.** Only an engineer's pylon runs on its owner's credentials.
- **A project edit may still name a grant that only an owner gives.** It is ignored at boot. Refusing it at the edit is not built.
- **A removed person's running pylons keep their tokens** until an admin archives the threads. The installer says so and does nothing more.
- **The second half of `main-1`'s live box** has not run: a landing into `main` queued behind a landing into another branch is not held.

## What waits for the operator

- The test for the local account finding above.
- On the office machine: QEMU, Node 26 and Docker, the firewall rule for ports 7470, 7443 and 7480, and the SELinux check. `sudo deploy/install.sh --check` from `multiplayer` prints the firewall lines. The [office checks](multiplayer-office-checks.md) and the [office machine page](multiplayer-office-machine.md) have the rest.
- Then `ops-3`: `sudo deploy/install.sh --person <your tailnet login>=admin --release-branch multiplayer`, and the [acceptance checks](multiplayer-office-acceptance.md), which run every live box that a pylon could not.
- Office checks 5 and 6: the GitHub token policy, the branch rules, the App question, and the Claude team token.
- On the company repository, before the pilot: read whether an approval survives a later push, and turn on the rule that asks for approval of the most recent push. The guard lets an agent push to any branch that is not the default one.
- `ops-2`: the engineers' group on the company tailnet and who merges its policy.
- Two decisions: the cap of pylons a person on the office machine, and whether the probe's user joins the `docker` group.

## How a slice goes from a brief to a merge

### Start

The project `nexus-mp` is pinned to one node, follows `multiplayer`, reviews every pull request and never lands one. Its standing rules carry the branch name, the base, the perf rule and the pull request form. `nexus project show nexus-mp` prints them.

A brief names the slice and its section of the plan, the branch `mp/<id>-<slug>`, the facts of merged slices it builds on, the files that slices in flight own, and a rule to stop and report instead of widening the slice. Start it with:

```sh
nexus start --project nexus-mp --title "<title>" --claude "$(cat <brief file>)" --model claude-opus-5-5
```

A builder takes 8 GiB. The pinned node fits about three pylons of that size, and the reviews need room too. A reviewer that waits 30 minutes for room holds its review for the person. `scripts/mp/start-when-room.sh` starts a thread only when a review's pylon still fits afterwards.

The plan says that two slices never change the same file at once. Where that rule was bent, each brief named the other slice's lines and the second to merge rebased.

### Watch

`scripts/mp/watch.sh <thread>...` returns when a review ends, a builder stops to ask, or a thread stops. It gives up after 90 minutes, and then it is started again.

- A review has five rounds. Granting more is the person's word alone: `nexus review <thread> --rounds <n>`. An assistant never runs that.
- A thread may list a holds question that offers Land. Never answer it. A slice of this arc merges on GitHub.
- Never archive or pause a thread of another project to make room.

### Test, then merge

When the Nexus review approves a head:

1. `NEXUS_REPO=<clone> scripts/mp/trial.sh trial-<pr> <full head sha>` merges the head onto `origin/multiplayer` in a worktree and runs the type check, the tests and the landing model. Run it once with no head on a new machine, because the tests that fail at the base differ by machine. On the old machine three failed at every base: the Docker backend's boot services, the Mac installer's profile hint, and the connect command's port discovery.
2. Read the pull request and the diff. For a rebased head, read the diff against the head approved before and check that it holds only the reconcile.
3. A slice the plan lists under "What waits for the operator" merges on the operator's yes for that pull request. So do `mp-23`, `mp-24` and `mp-25`. The operator gave a standing yes for the other slices, for syncs of `main` and for confirmations of the model, and that yes belongs to the session it was given in. A new session asks again.
4. `NEXUS_REPO=<clone> scripts/mp/merge.sh <pr> <full head sha> trial-<pr>` squashes at exactly the tested head and compares the merged tree with the tested one. A sync of `main` takes `--merge` as a fourth argument, so that `main` stays an ancestor of `multiplayer`.

Never use `nexus land` for a pull request of this arc.

### After a merge

- For every other open pull request, run `git merge-tree --write-tree origin/multiplayer <head>`. On a conflict, send the builder a note with `nexus send <thread> --file <note>`: rebase once, regenerate `src/control/api/auth-matrix.txt` and `src/contracts.snapshot.json` instead of merging them by hand, put its migration after the ones already merged, push once, then stop. Each new head costs a review round, so hold other merges while a pull request is on its last round.
- When the landing model exits 3, its rules hold and a file it covers changed. Read that the model still describes the code. Then, on a branch off `multiplayer`, run `node .claude/skills/verify-landing-model/scripts/check.mjs --confirm`, and open a pull request with the new `coverage.json`. The check needs Java, which a pylon lacks, so it runs on a developer machine.
- After a landing into `main` that the arc needs, merge `main` into `multiplayer` in a branch `mp/sync-<date>`, test it, and merge it with a merge commit.

## Scripts

They are in `scripts/mp/`. They were adapted from the ones used through 2026-11-27 so that they take the clone, the CLI and the nodes from the environment. `trial.sh` ran in this form once, for #730. The other three have not run in this form.

| Script | What it does |
| --- | --- |
| `trial.sh` | Trial-merges heads onto `multiplayer` and runs the checks |
| `merge.sh` | Merges at the tested head and compares the trees |
| `watch.sh` | Waits on threads and says why it stopped |
| `start-when-room.sh` | Starts a thread once it leaves room for a review |

`NEXUS_REPO` is the clone. `NEXUS_CLI` names the CLI when `nexus` is not on the path. `NEXUS_MP_NODE` and `NEXUS_MP_SPILL` name the two nodes.

## What the new machine needs

- A clone with `gh` signed in, Node 26, `jq`, and Java for the landing model.
- The `nexus` CLI, on a device the one-person install admits as a caller.
- For an assistant: hand it this page and the plan, and say again which merges it may do.

## What stays on the old machine

- A test rig for the runner plan, the second plan. It is not in this repository because it names workflows of the company. Copy it by hand if the runner plan should start from it.
- The scratch repository for the guard's probes stays on GitHub, private. The live boxes of `mp-10`, `mp-14` and `mp-15` use it.
