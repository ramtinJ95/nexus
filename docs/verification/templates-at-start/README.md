# Thread starts from templates verification

Verified in this task's pylon on 2026-10-26, on branch `templates-at-start`, CLI 0.21.0 (`version.txt`). The branch was later rebased onto a main that had taken 0.21.0 for usage-limit stops and 0.22.0 for image builds, so it ships as 0.23.0 with no change in behaviour. The captures are from the run before the rebases, and `drive.sh` now expects 0.23.0. No live control plane, node, image or other thread was touched.

## The stack

`stack.ts` runs one node, `local-node`, on this machine. It is a real probe (`startProbe`) over a real pylon-vm backend (`createPylonVmBackend`). The real control-plane loop follows it over the probe protocol, and the real API serves `127.0.0.1:7470` with the real `projectMirror` from `src/control/mirror.ts`, as `src/control/main.ts` wires them. `drive.sh` drives it with the real CLI (`node src/cli/nexus.ts` with `NEXUS_URL` and `NEXUS_SOCKS=none`), asserts each expectation, exits non-zero on the first mismatch, and writes every capture here.

The project's repository is a bare git repository that `drive.sh` makes in a temporary directory and adds with `nexus project add acme file://<dir>/origin.git`. Its config sets `uploadpack.allowFilter`, as GitHub does, so the mirror's blobless fetch works. Its first commit on `main` has a `.nexus/setup` that runs `npm ci`. `commits.txt` lists the three commits the run pushed.

This pylon has no KVM and no Docker, so no VM boots, and a template build cannot prepare one. One stand-in replaces the VM. The backend's `buildTemplate` publishes what a successful prepare and publish leave, through the real artifact store (`artifactDirectory` and `publish` in `src/artifacts.ts`). That is a manifest with the template's ID, key, `inputs.repo.commit` and `builtAt`, and a `disk.qcow2` that holds one line of placeholder text. The stand-in also writes each build's inputs to `builds.json`. Everything else in the build path is the shipped code. The loop sends the `build-template` job, the probe runs it, the next observation lists the template, and the loop marks the registry record ready.

`stack.ts` also records each spawn's boot source and checkout, as the probe handed them to the backend, in `spawns.json`, and then calls the real `ensureRunning`. The API does not expose a spawn's boot inputs. `show --json` carries the pylon's state and failure only, and the probe's job list carries each job's kind and state, not its inputs. So `spawns.json` is the only view of the spawn job here, and it is read at the backend, not through the API.

Every pylon then fails, so `show` reports `attention: failed` for each thread. The failure is not the missing KVM that node-capacity hit. pylon-vm refuses the spawn earlier, with `invalid: file:///... is neither an SSH nor an HTTPS git URL`, because its boot spec accepts only SSH and HTTPS remotes. That does not matter for what this run shows. The setup path is decided when the thread starts, before any spawn, and `show` reports that decision. For B and C, the refusal also shows that the backend found the template. pylon-vm opens the template's disk (`templateDisk`, which fails with `artifact-missing` when the template is absent or over another image) before it builds the boot spec, so the URL check is the first thing a template spawn here fails on. `drive.sh` asserts that B fails with the URL message.

## What it shows

- `show-a.txt`, `show-a.json` and `start-a.json` show thread A, the first thread of the setup. It boots fresh: `setup: fresh boot runs .nexus/setup, because no template of this setup is on local-node yet; tpl-d921661d4d81 builds for the next thread`. `drive.sh` then waits, reading the registry read-only, until the record of `tpl-d921661d4d81` is `ready`. No API lists templates, so the wait reads the registry. `builds.json` shows the build the probe ran, which checked out the first commit `63cf8f9c6036...`.
- `show-b.txt` and `show-b.json` show thread B, started after a push that changed only `README.md`. It boots from A's template: `setup: from template tpl-d921661d4d81, built 2s ago, then checked out abd2ab748291`. `thread.setup.commit` is `abd2ab748291c0c002d83c4b4db48b3c3b8c27ca`, which `drive.sh` checks against `git rev-parse main` on the bare repository. It is the new tip, not the template's build commit. B's entry in `spawns.json` has `source: { kind: "template", template: "tpl-d921661d4d81" }` and checks out the same full SHA.
- `show-c.txt` and `show-c.json` show thread C, started with `--commit` and the first commit's full SHA. It boots from the same template: `setup: from template tpl-d921661d4d81, built 1s ago, then checked out 63cf8f9c6036`. Its spawn checks out `63cf8f9c60367a74435c7067b9b29605dbfe2603`.
- `show-d.txt` and `show-d.json` show thread D, started with `--commit 63cf8f9`. It boots fresh and asks for no build: `setup: fresh boot runs .nexus/setup, because the start named commit 63cf8f9, and only a full commit ID or a branch tip can use a template`.
- `show-e.txt` and `show-e.json` show thread E, started after a push that changed `.nexus/setup` to `npm ci && npm run build`. It boots fresh and asks for a new build: `setup: fresh boot runs .nexus/setup, because no template of this setup is on local-node yet; tpl-ad1dacf48b98 builds for the next thread`. `builds.json` shows that build checked out the third commit `020122f684a5...` under a different setup hash.
- `templates.json` is the registry's template records at the end. Both templates are `ready` on `local-node`, each with the commit its build checked out. `artifacts.txt` lists both artifact directories and `tpl-d921661d4d81`'s published `template.json`.
- `threads.txt` lists the five threads, each with `pylon failed`, for the reason given above. `project-add.txt` is the project's add.

## Start time both ways

`measure-start.sh` times the work a first boot does in the guest on each path, with the commands `src/pylon-vm-backend.ts` runs, and `measure-start.txt` is its output from 5 alternating runs per side in this pylon (4 CPUs, ext4, load average under 2). The project is this repository with a `.nexus/setup` that runs `npm ci`, 162 packages, from an empty npm cache as a fresh disk has. The thread checks out a commit made after the template's. Every run checks that the checkout is at that commit, that `refs/nexus/base` is too, that no tracked file changed, and that `node_modules` is there.

| Path | Median | Range | What bounds it |
|---|---|---|---|
| Fresh: clone, check out, `.nexus/setup` | 6.5 s | 5.1 to 11.6 s | `npm ci` downloading and unpacking from registry.npmjs.org |
| Template: copy the disk, fetch, check out | 0.25 s | 0.24 to 0.31 s | the copy, 231 MB at about 1 GB/s. ext4 has no reflink, so `cp --reflink=auto` copies every byte. The checkout takes about 40 ms |
| The control plane's read of `.nexus/setup` at start, against github.com | 0.76 s | 0.66 to 1.11 s | the round trips of a one-commit fetch |

Every start of a remote project now pays the read, fresh ones included. So for this setup a thread on a template starts about 5.5 s sooner, and one that boots fresh starts about 0.8 s later than before. The saving grows with what setup does: `npm ci` here is small next to a setup that installs system packages or builds. The VM boot is the same on both paths and is not timed. The template's real disk is one qcow2 overlay, which a tar of the set-up checkout stands in for here. On a filesystem with reflinks, such as XFS or btrfs, the copy would take far less than 0.2 s.

## What was not verified

- A VM booting from a template disk, and the in-guest checkout over it. No VM ran, and `disk.qcow2` is a placeholder file, not a qcow2 image.
- A real template build. The stand-in replaces the prepare, the setup run and the disk copy. The real `buildTemplate` would also refuse this `file://` remote, as the spawns do.
- The mirror reading a private GitHub repository with the control plane's token. The stack read a local bare repository over `file://`, and the timing above read the public `ramtinJ95/nexus` over HTTPS with no token.
- A template on another node. Only one node ran, so the rule that only the thread's own node's templates count went untested here. `src/images.test.ts` covers it.

## Rerun

```sh
node docs/verification/templates-at-start/stack.ts &
sleep 5
sh docs/verification/templates-at-start/drive.sh
```

`stack.ts` starts from an empty `/tmp/nexus-templates` each time and resets `builds.json` and `spawns.json`, so the thread IDs, template IDs and commits change. `drive.sh` prints `all expectations held` when every assertion passes. Stop the stack with `kill %1` afterward.
