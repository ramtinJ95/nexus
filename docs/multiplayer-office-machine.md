# The office machine

This page records what [the office checks](multiplayer-office-checks.md) found on the machine that will host the shared install, and how far its setup has come. It is the record that `ops-1` of [the multiplayer plan](multiplayer-plan.md#ops-1-the-office-machine-can-run-pylons) asks for.

This repository is public, so this page names no machine, person, address, tag or company. The raw outputs of the checks stay with the operator, as the checks page says.

## What is decided

Decided by the operator on 2026-11-27.

- The office machine is an install of its own. It runs its own control plane, probe and deployer, and is never joined to the operator's own install as a node.
- It runs the `multiplayer` branch from its first install, as `ops-3` says.
- The software the installer needs goes on the machine now, ahead of `ops-3`. The installer itself is not run yet.
- The machine is not Nexus's alone. Other people have accounts on it, and one of them runs long-lived services there. The operator agreed with the team that the machine may be changed as Nexus needs.

## What the checks found

Checks 1 to 4 ran on 2026-11-27, the first three on the machine over SSH and the fourth from a laptop on the company tailnet. Every box of those four checks passed.

| Fact | Found |
|---|---|
| Operating system | Fedora Linux 44 Server, `x86_64`, booted with systemd |
| Processor | 16 threads, AMD, with the `svm` flag |
| Virtualization | Bare metal. `systemd-detect-virt` prints `none`, so pylons need no nested virtualization |
| KVM | `/dev/kvm` exists, owned by `root:kvm`, and every user may read and write it |
| Memory | 31.13 GiB (`MemTotal` 32640092 kB) |
| Disk | 873 GiB free on one filesystem, which holds `/`, `/var/lib` and `/opt` |
| Ports | 7470, 7443, 7480 and 7481 are free |
| Network | `github.com`, `api.github.com`, `api.anthropic.com`, `registry.npmjs.org` and `controlplane.tailscale.com` all answer. Each certificate comes from a public authority, so no company proxy replaces certificates. No proxy variable is set, in a login shell or outside one |
| Tailnet settings | MagicDNS is on, and HTTPS certificates are on |
| Whois | Every untagged device has a login with an `@`. Every tagged device has the placeholder login `tagged-devices`, and no real one. Every device has a stable ID |
| The machine on the tailnet | It is online and tagged, under a general tag and no person's login. It has no tag of its own yet, which `ops-2` adds |

The whois result is the first look at a tagged device on a real tailnet. It matches what `mp-01` assumed and what [the install exploration](explorations/install.md#what-this-page-could-not-check) could not check. The live box of `mp-01` stays open, because it needs a call to a running control plane.

Only the tests of the first three checks reached the machine's own network. No pylon ran, so a pylon's path to those hosts through Nexus's own interception is still untested there.

## The firewall, SELinux and swap

[Check 7](multiplayer-office-checks.md#7-the-host-firewall-selinux-and-swap) ran on 2026-11-27, before Docker was installed. The machine's firewall closes port 7443 to the tailnet today, so a laptop could not reach a control plane installed there.

| Fact | Found |
|---|---|
| firewalld | Active |
| Zones | The default zone is `FedoraServer`, and it holds the machine's LAN interface. `tailscale0` is in no zone, so the default zone's rules apply to it |
| What the default zone lets in | Not read. Listing a zone's services and ports needs `sudo` there |
| A laptop to port 7443 | Refused. With a server listening on the machine's tailnet address, the laptop's `curl` failed in 0.05 seconds with `http 000`. The same request from the machine to its own tailnet address answered `http 200` |
| SELinux | `Enforcing` |
| Swap | 8 GiB of zram, which is compressed memory and no disk |

What follows from it:

- The refusal came at once and not after the five-second timeout, which the checks page reads as the machine's firewall and not the tailnet policy. That is a reading of the timing. Nobody has read the rule that refused it.
- A refusal at once also means the request reached the machine, so the tailnet policy let the operator's laptop through to that port. That says nothing yet for the engineers' group, which `ops-2` grants.
- SSH over the tailnet works on the same interface. The firewall lets some ports in from the tailnet and not this one.
- The check 7 box of `ops-3` applies: open port 7443 on the tailnet interface before the install. The installer checks no firewall, so it would install and report nothing wrong while laptops are refused.
- The test covered port 7443 only. Previews are served through Tailscale and were not tested.
- SELinux enforces, so the first install on this machine is the first time Nexus runs under it. [The checks after the install](multiplayer-office-acceptance.md#1-the-install) look for denials.
- The swap is zram, so it takes its room from the same memory the pylons use and adds none.

## How many pylons fit

A running pylon holds its full memory and about 0.15 GiB more, and never gives it back. With the checks page's estimate of 4 GiB for the host and the control plane, 27.13 GiB is left for pylons.

| Pylon size | Pylons that fit at once | Arithmetic |
|---|---|---|
| 8 GiB | 3 | 27.13 / 8.15 = 3.33 |
| 4 GiB | 6 | 27.13 / 4.15 = 6.54 |
| 3 GiB, the smallest | 8 | 27.13 / 3.15 = 8.61 |

The plan assumed room for 16, two for each of eight engineers. This machine does not reach that at any size. What follows from it:

- The pilot, two engineers with the default cap of two each, needs four pylons at once. Four fit when a pylon is 6 GiB or smaller, since 27.13 / 4 - 0.15 = 6.63. Four pylons of 8 GiB do not fit.
- The cap of `mp-22` is per person and does not bound the machine. With eight engineers, memory runs out before the caps do, and a start that does not fit is refused by placement, not by the cap.
- The 4 GiB reserve is an estimate. Nobody has measured what the host and the control plane hold on this machine. Admission does not use the estimate. It refuses a start that would commit more than the machine's memory, or that would leave less than 1 GiB of the memory the machine reports free (`src/control/placement.ts:115`). So a wrong estimate changes the numbers in the table and cannot overfill the machine.
- A start that does not fit is refused today, and the engineer has to try again. With three to six pylons for eight engineers that happens daily. [`mp-23`](multiplayer-plan.md#mp-23-a-start-that-does-not-fit-waits-in-line) makes such a start wait in line, with the person who runs the fewest pylons first.
- No size is known for the company project's pylons. Its development stack runs about twenty containers, so 8 GiB is a guess and 4 GiB may be too small. `ops-3` measures it on the first pylon.
- A review by Nexus adds up to three pylons beside the builder's, and a CI job on Nexus is a pylon of its own. Neither fits on this machine beside eight engineers. `mp-17` and the second plan each need a second node, or a rule that runs their pylons one at a time.

- The table gives Nexus the whole machine but the reserve. The machine used about 1 GiB in all when the checks ran, other people's work included. If that grows, fewer pylons fit, and admission sees it in the memory the machine reports free.

The pylon size for the company project, and whether eight engineers need a second node or a larger machine, are the operator's to decide.

## The software the installer needs

What `deploy/install.sh --check` and the first check found on 2026-11-27. Nothing is installed yet: `sudo` on the machine asks for a password, so the operator runs the installs.

| Needed | Why | Found |
|---|---|---|
| QEMU, `qemu-system-x86_64` and `qemu-img` | Pylons are QEMU VMs. The installer stops without it | Missing |
| Node 26 or newer, as `node` in `/usr/local/bin` or `/usr/bin` | Every service runs on it. The installer stops without it | Node 22 |
| git | The deployer fetches releases with it | Present, 2.56 |
| Docker with buildx | The probe builds the pylon image with it. The installer does not check for it, and names it as a step left after the install | Missing |
| tailscaled lets `nexus-control` fetch the dashboard's certificate | The installer stops without it. The fix names a user the installer creates and restarts tailscaled, so it belongs to the install | Not set |

A look at the machine's packages on 2026-11-27, without `sudo`, found how each has to be installed there.

- **QEMU.** The installer's fix for a `dnf` machine is wrong on Fedora. It prints `sudo dnf install -y qemu-system-x86_64-core qemu-img` (`deploy/install.sh:182`), which builds the package name from the binary's name. Fedora has no such package. Its package is `qemu-system-x86-core`, which holds `/usr/bin/qemu-system-x86_64`. The same line is on `main`, so the fix belongs there first.
- **Node.** Fedora 44 offers Node 20, 22 and 24, and no 26. The machine's Node 22 is Fedora's, whose packages own `/usr/bin/node` and `/usr/bin/npm`. The installer suggests NodeSource's package, which ships the same two paths and names no Fedora package it replaces, so nobody has shown that it installs beside them. Node 26 goes on from the official tarball instead, checked against its published SHA-256, under `/usr/local` with `node`, `npm` and `npx` linked into `/usr/local/bin`. That is first in the units' path, and it leaves Fedora's Node 22 in `/usr/bin`. `dnf` will not update it.
- **Docker.** Podman is installed and not running, and nothing there stands in for Docker. Docker goes on from Docker's own Fedora repository, which has packages for Fedora 44, with its buildx plugin.

One script on the machine does the three installs, checks each, and ends with the installer's own check run as root. It waits for the operator to start it, because `sudo` there asks for a password.

## What is still open

- Installing QEMU, Node 26 and Docker, which waits for the operator to start the script. Docker adds firewall zones of its own, so the firewall facts above are from before it.
- The rule that opens port 7443 to the tailnet, which `ops-3` asks the operator to write down, and what the default zone lets in today. Three commands on the machine read the second: `sudo firewall-cmd --list-services`, `sudo firewall-cmd --list-ports` and `sudo firewall-cmd --zone=FedoraServer --list-all`.
- The installer's `dnf` line for QEMU, which names a package Fedora does not have. No slice has it yet.
- Check 5, GitHub: the organisation's rules for personal access tokens, the branch rules and their bypass lists, and an owner's answer on the App.
- Check 6: whether a Claude token from the team subscription works.
- Two facts for `ops-2`: which group in the tailnet policy holds the engineers, and who merges a change to that policy.
- Whether the probe's user joins the `docker` group, which image builds need and which is equal to root on the machine. The operator decides, as [the deploy README](../deploy/README.md#docker-access-for-the-image-build-nodes-probe) says.
- The pylon size and the capacity question above.
- Whether Nexus runs under SELinux in enforcing mode, which the first install shows. Neither of the operator's nodes has it, and the installer does not look at it.
- The install itself. [`mp-24`](multiplayer-plan.md#mp-24-the-installer-makes-a-shared-install) taught the installer to write `people`, so `ops-3` installs with `sudo deploy/install.sh --person <the operator's tailnet login>=admin --release-branch multiplayer`, as [the deploy README](../deploy/README.md#a-shared-install) says.
