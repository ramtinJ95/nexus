# Checks after the install on the office machine

These checks run once, on the office machine, after the install of `ops-3` in [the multiplayer plan](multiplayer-plan.md#ops-3-the-shared-install-runs-from-multiplayer) and before a second engineer signs in. The office machine is the first node that runs the `multiplayer` branch on real hardware with two real people. So it is the first place where the plan's open live boxes can be met. Until now those boxes stayed open because a slice is built inside a pylon, and a pylon cannot run a pylon.

This repository is public. Keep every output in a private note, as [the office checks](multiplayer-office-checks.md) say. Tick a box in the plan with a sentence that names no machine, person, or company.

This page was written before `mp-11`, `mp-16`, `mp-24`, and `mp-25` merged. Where one of them ships a command that differs from the one here, its pull request says so, and that command wins. `mp-10` and `mp-15` have merged, and checks 5 and 6 use their commands.

## What you need

- Two people on the company tailnet. A is the operator and an admin. B is an engineer in `people`. Each has a laptop with the `nexus` CLI connected to the office install.
- A scratch repository that both can push to, with a rule that `main` takes changes only by pull request with one approving review. Never point the guard's probes at the company monorepo.
- A GitHub token for each person that reaches the scratch repository, with contents and pull requests, read and write, and nothing else. Each person stores it with `nexus login github` for these checks and replaces it with their real one afterwards.
- A Claude token for each person, stored with `nexus login claude`.
- A project on the install, added by A, whose repository is the scratch repository over HTTPS. The checks call it `scratch`.

## What each check settles

| Check | Plan boxes it meets |
|---|---|
| [1. The install](#1-the-install) | Live of `mp-21` and `mp-24`, the last box of `ops-3`, SELinux under "What stays unproven" |
| [2. Who the control plane says you are](#2-who-the-control-plane-says-you-are) | Live of `mp-01`, the last box of `ops-2` |
| [3. The first pylon](#3-the-first-pylon) | The pylon size in `ops-3`, a pylon's path to its hosts |
| [4. Each pylon acts as its owner](#4-each-pylon-acts-as-its-owner) | Live of `mp-07` and `mp-09` |
| [5. Git over HTTPS](#5-git-over-https) | Live and Perf of `mp-10` |
| [6. The guard](#6-the-guard) | Live of `mp-15`, its item under "What stays unproven", and Live of `mp-25` if it has merged |
| [7. Nexus never merges](#7-nexus-never-merges) | Live of `mp-14` |
| [8. A thread is a pylon agent](#8-a-thread-is-a-pylon-agent) | Live of `mp-16` |
| [9. A colleague's thread](#9-a-colleagues-thread) | Live of `mp-04`, and `mp-03` on a real install |
| [10. The cap and a full machine](#10-the-cap-and-a-full-machine) | `mp-22` on a real install, Live of `mp-23` if it has merged |
| [11. An engineer's own host and secret](#11-an-engineers-own-host-and-secret) | Live of `mp-11`, if it has merged |

## 1. The install

On the office machine.

```sh
sudo deploy/install.sh --check
sudo ausearch -m avc -ts today 2>&1 | tail -40
```

On A's laptop.

```sh
nexus doctor
nexus release
nexus nodes
```

- [ ] The installer's check reports that every prerequisite holds and the installed roles run as they should. It names no port that firewalld closes on the tailnet interface. This is the first run of that part of the check on a Fedora host.
- [ ] `nexus doctor` reports no failed check.
- [ ] `nexus release` shows the running release as the head of `multiplayer` on every role.
- [ ] `ausearch` shows no denial that names a Nexus service, `node`, QEMU, or tailscaled. If `getenforce` printed `Disabled` in check 7 of the office checks, skip this box and say so.
- [ ] From a device of a tailnet user who is not in `people`, `nexus threads` is refused with 403. After A reruns the installer with that user as an engineer, the same call answers, with no other step.

## 2. Who the control plane says you are

A calls the control plane from a laptop.

```sh
nexus threads
```

Then A makes a call from a tagged device. The office machine itself is one. On it, with the control plane's tailnet name in place of `<name>`, make the call and read what the control plane logged for both.

```sh
curl -sS -o /dev/null -w 'http %{http_code}\n' "https://<name>:7443/v1/threads"
sudo journalctl -u nexus-control --since '-5 min' | tail -40
```

- [ ] The log names A's tailnet login for the call from the laptop.
- [ ] The log names no user for the call from the tagged device, and that call is refused as not a person.
- [ ] A's laptop opens the dashboard at the control plane's HTTPS address. A device outside the engineers' group does not reach it.

## 3. The first pylon

A starts a thread on the company project. Before its agent begins, A starts a sampler in a second terminal, which prints the guest's available memory in kB every five seconds.

```sh
nexus exec <thread> 'while sleep 5; do awk "/MemAvailable/ {print \$2}" /proc/meminfo; done' | tee ~/pylon-memory.txt
```

Then the agent does a usual piece of work. It installs, builds, starts the services an engineer's agent starts, and runs the tests an engineer would ask for. When it is done, stop the sampler with Ctrl-C and read the lowest number. Then, while the pylon still runs.

```sh
sort -n ~/pylon-memory.txt | head -1
nexus exec <thread> 'for h in github.com api.github.com api.anthropic.com registry.npmjs.org; do curl -sS -o /dev/null -m 15 -w "$h %{http_code}\n" "https://$h/"; done'
nexus nodes
```

- [ ] The pylon reached `running`, and the agent answered a turn.
- [ ] Each host answers with an HTTP status from inside the pylon. The office checks tested these hosts from the machine and never from a pylon.
- [ ] The pylon's size less the lowest available memory is what the work needed at its peak. Write that down, and the size the project should have, with about a quarter to spare. Then write how many pylons of that size fit, from the arithmetic in [The office machine](multiplayer-office-machine.md#how-many-pylons-fit). If the lowest number is near zero, the pylon was too small to tell, so raise its size and run the work again.
- [ ] `nexus nodes` shows the memory the machine has free with one pylon up. Total memory less that number less the pylon's size is what the host and the control plane hold, which the 4 GiB estimate stood in for.

## 4. Each pylon acts as its owner

A and B each start a thread on `scratch`, so that both pylons run at once on the one node. Each runs these in their own thread.

```sh
nexus exec <thread> 'gh api user --jq .login'
nexus exec <thread> 'printenv GH_TOKEN CLAUDE_CODE_OAUTH_TOKEN | cut -c1-12'
nexus exec <thread> 'git commit --allow-empty -m "owner check" && git log -1 --format="%an <%ae>"'
```

Run the third from the thread's checkout.

- [ ] In A's pylon GitHub names A, and in B's pylon it names B. Two pylons on one node then hold different values under one secret name.
- [ ] What `printenv` shows is not the start of either person's real token.
- [ ] Each commit carries its owner's name and address.

The plan's boxes ask for a recording host. Here GitHub's own answer is the record, which shows the same thing for the GitHub token and sends no token anywhere new. It does not show which Claude token a pylon sent. Check 8 covers that as far as an answer on the owner's subscription can.

## 5. Git over HTTPS

In A's pylon on `scratch`.

```sh
nexus exec <thread> 'git remote -v; ssh -T -o BatchMode=yes -o ConnectTimeout=10 git@github.com; echo "ssh exit $?"'
nexus exec <thread> 'git switch -c check/https-push && head -c 5242880 /dev/urandom > blob.bin && git add blob.bin && git commit -qm "5 MiB" && time git push -u origin check/https-push'
```

- [ ] The remote is an HTTPS URL, and the SSH attempt fails.
- [ ] GitHub shows the branch as pushed by A.
- [ ] The push takes 3 seconds or less. The review measured 0.9 seconds for this push. Write the number down.

## 6. The guard

Rerun the probe list of [`interrogate/guard-github/`](../interrogate/README.md) from A's pylon against the scratch repository, with the guard that `mp-15` built in place of the prototype's. Run it from A's laptop, where `gh` is signed in as someone who may administer the scratch repository. `<node>` is the office machine.

```sh
export SCRATCH_REPO=<owner>/<scratch> NEXUS_THREAD=<A's thread>
WANT=14 interrogate/guard-github/seed.sh
gh auth token | PYLON_LOG_CMD="ssh <node> sudo cat /var/lib/nexus/pylons/instances/pylon-$NEXUS_THREAD/controller.log" node interrogate/guard-github/probes.mjs | tee ~/guard-pylon.txt
```

- [ ] Every probe prints `[ok]`. None prints `[SLIPPED]`, which is a request that must be refused and reached GitHub, or `[BROKEN]`, which is a request that must pass and did not.

Then a download, from A's pylon.

```sh
nexus exec <thread> 'curl -sSL -o /dev/null -m 60 -w "%{http_code}\n" https://github.com/cli/cli/releases/download/v2.60.0/gh_2.60.0_checksums.txt'
```

- [ ] Write down what it printed. Before `mp-25` the guard refuses it with 403. With `mp-25` it prints 200. If it fails with another status, the host the download redirects to is missing from the pylon's allowlist, so say which.

Then B opens a pull request from B's thread, and A tries to act on it from inside A's pylon.

```sh
nexus exec <thread> 'gh pr review <B's pull request> --approve; echo "approve exit $?"'
nexus exec <thread> 'gh pr merge <B's pull request> --squash; echo "merge exit $?"'
```

- [ ] Both are refused, the refusals are in the pylon's log, and the pull request on GitHub has no review and is still open. The prototype had one GitHub account, so this is the first time the approval of another person's pull request is tried.
- [ ] The scratch repository's rule was in place during the probes. If a probe behaved differently from the prototype's table because of the rule, say which.

## 7. Nexus never merges

As A, on a thread of `scratch` with an open pull request.

```sh
nexus land <thread>
```

- [ ] It is refused with `landing-off`, and the pull request is still open on GitHub.

## 8. A thread is a pylon agent

As B.

```sh
nexus start --project scratch --title "no agent named"
nexus start --project scratch --title "one turn" --claude "Answer with the single word ok."
```

- [ ] The first is refused, and the refusal says which agents are available.
- [ ] The second runs a turn and answers, and the usage page of B's Claude account shows it. Nothing on the install shows which token a turn spent, so that page is the evidence.

## 9. A colleague's thread

A's thread from check 4 goes idle and its pylon pauses. Wait for `nexus show` to say so. Then B, from B's laptop.

```sh
nexus send <A's thread> "hello"
nexus attach <A's thread>
nexus archive <A's thread>
nexus show <A's thread>
```

B also opens A's thread in the dashboard, and its diff, and leaves the page open for a minute.

- [ ] The first three are refused, and A's conversation shows no new message.
- [ ] `nexus show` answers for B and names A as the owner.
- [ ] After 60 seconds A's pylon is still paused, and `lastHumanActivityAt` in `nexus show --json` has not moved.

## 10. The cap and a full machine

As B, start one thread more than B's cap allows.

- [ ] The last start is held, and `nexus show` gives the cap as the reason. It boots once B archives one of the others.

Then A and B together start threads until the machine has no room for one more.

- [ ] Write down how many pylons ran at once, and their size. It should match the number from check 3.
- [ ] Write down what the next start did. Without `mp-23` it is refused with the memory short as its reason. With `mp-23` it is held, and when a pylon is archived the waiting start of the person with fewer running pylons boots first.
- [ ] With the machine full, `nexus doctor` reports no failed check, and the machine's free memory in `nexus nodes` is still above zero.

## 11. An engineer's own host and secret

Skip this check if `mp-11` has not merged. B adds a host and a secret. The value is made up, because the check sends it to a public service that echoes a request's headers.

```sh
nexus host add postman-echo.com
printf 'made-up-value-123' | nexus secret set CHECK_TOKEN postman-echo.com
nexus own
```

A pylon's hosts and secrets are fixed when it starts. So A and B each start a new thread on `scratch`, and each runs these in it.

```sh
nexus exec <thread> 'printenv CHECK_TOKEN'
nexus exec <thread> 'curl -sS -m 20 -H "authorization: Bearer $CHECK_TOKEN" https://postman-echo.com/headers'
```

Then A, who is an admin, and B, who is not.

```sh
nexus people
```

- [ ] In B's pylon `printenv` prints a placeholder, not the value, and the service echoes `Bearer made-up-value-123`. The value was put in at the network edge.
- [ ] In A's pylon the variable is empty and the request to the host is refused. A person's host and secret reach only their own pylons.
- [ ] `nexus own` and A's `nexus people` list B's host and the secret's name, and neither prints the value. B's `nexus people` is refused.
- [ ] B removes both with `nexus host remove postman-echo.com` and `nexus secret remove CHECK_TOKEN`. Write down whether B's running pylon still reaches the host afterwards. The pull request of `mp-11` says a running pylon keeps what it started with.

## Afterwards

- [ ] Each person replaces the scratch token with their real one, with `nexus login github`.
- [ ] A removes the `scratch` project, or keeps it for the pilot's guard line and says so.
- [ ] Tick each plan box that a check met, in one pull request against `multiplayer`, with one sentence of evidence for each and no name in it.
- [ ] For each box that failed, write what happened in the same pull request. A failed box is a finding for the slice it belongs to, and the pilot waits for it.

The pilot's own lines in the plan, a revoked Claude token, a boot disk that another person's branch never ran on, and a week of real work, are not repeated here.
