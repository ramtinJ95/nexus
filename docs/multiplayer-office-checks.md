# Checks to run in the office

These are the checks of [the multiplayer plan](multiplayer-plan.md) that need the company network, the company tailnet, or a person with rights in the company's GitHub organisation. Nothing here installs Nexus or changes a setting. Every command only reads.

This repository is public. Do not commit any output of these checks, and do not paste it into a pull request or an issue. Outputs name machines, people, and the company. Keep them in a private note, and give them to the agent that runs the plan in its session. What the checks found, with every name left out, is in [The office machine](multiplayer-office-machine.md).

## What each check settles

| Check | Where to run it | What it settles in the plan | Time |
|---|---|---|---|
| [1. The office machine](#1-the-office-machine) | The office machine, over SSH | `ops-1`, and the cap that `mp-22` sets | 10 minutes |
| [2. The installer's own check](#2-the-installers-own-check) | The office machine | Every prerequisite of `ops-3`, without installing | 5 minutes |
| [3. Network from the office machine](#3-network-from-the-office-machine) | The office machine | Whether pylons can reach GitHub, Anthropic, and npm from there | 5 minutes |
| [4. The company tailnet](#4-the-company-tailnet) | Any device on the company tailnet | The live box of `mp-01`, and what `ops-2` has to change | 10 minutes |
| [5. GitHub](#5-github) | A browser and a laptop with `gh` | The gate of `mp-12`, and the token engineers use until then | 20 minutes |
| [6. A Claude token from the team subscription](#6-a-claude-token-from-the-team-subscription) | A laptop signed in to the team subscription | An item under "What stays unproven" | 5 minutes |
| [7. The host firewall, SELinux, and swap](#7-the-host-firewall-selinux-and-swap) | The office machine, and a laptop on the tailnet | Whether laptops can reach the control plane after `ops-3`, and two items under "What stays unproven" | 10 minutes |

Checks 1, 4, and 5 matter most. If time is short, do those.

## 1. The office machine

Run this block on the machine that will host the shared install. It prints the facts `ops-1` asks for.

```sh
{
  echo "== os";       . /etc/os-release && echo "$PRETTY_NAME"; uname -rm
  echo "== systemd";  systemctl --version | head -1
  echo "== cpu";      nproc; grep -m1 'model name' /proc/cpuinfo
  echo "== virt";     grep -Eo 'vmx|svm' /proc/cpuinfo | head -1 | grep . || echo "no vmx or svm flag"
  echo "== kvm";      ls -l /dev/kvm 2>&1; getent group kvm || echo "no kvm group"
  echo "== memory";   free -g | sed -n 1,2p; grep MemTotal /proc/meminfo
  echo "== disk";     df -h / /var/lib /opt 2>/dev/null
  echo "== qemu";     qemu-system-x86_64 --version 2>&1 | head -1; qemu-img --version 2>&1 | head -1
  echo "== node";     node --version 2>&1; npm --version 2>&1; git --version
  echo "== docker";   docker --version 2>&1; docker buildx version 2>&1 | head -1
  echo "== ports";    ss -ltnH 2>/dev/null | grep -E ':(7470|7443|7480|7481)\s' || echo "7470, 7443, 7480 and 7481 are free"
  echo "== hypervisor"; systemd-detect-virt 2>&1
} 2>&1 | tee ~/nexus-office-machine.txt
```

Pass when all of these hold.

- [ ] `/dev/kvm` exists and its group is `kvm`. The probe's user joins that group to run QEMU. If `/dev/kvm` is missing and `virt` printed `vmx` or `svm`, virtualization is off in the firmware or the module is not loaded. Try `sudo modprobe kvm_intel || sudo modprobe kvm_amd` and look again.
- [ ] `hypervisor` prints `none`. Any other answer means the machine is itself a virtual machine, and pylons then need nested virtualization, which the first host candidate did not allow. Say which hypervisor it printed.
- [ ] The architecture is `x86_64`, and the machine boots with systemd.
- [ ] Memory is at least 8 GiB. Each filesystem that will hold `/var/lib/nexus` or `/opt/nexus` has 20 GiB free.

Missing QEMU, Node 26, Docker, or git is not a failure. Each is an install step. Write down which are missing.

Then work out how many pylons fit. A running pylon holds its full memory and about 0.15 GiB more, and never gives it back.

```
pylons that fit = (total memory in GiB - 4 for the host and the control plane) / (pylon size in GiB + 0.15)
```

The project on the personal install uses 8 GiB pylons. The smallest pylon is 3 GiB. The 4 GiB for the host is an estimate, not a measurement. With two pylons for each engineer and eight engineers, the machine would need room for 16 at once, so this number decides the cap.

- [ ] Write down the number for 8 GiB pylons and for 4 GiB pylons.

## 2. The installer's own check

The installer can check every prerequisite and change nothing. It needs a checkout and no Node.

```sh
git clone --branch multiplayer https://github.com/ramtinJ95/nexus.git ~/nexus-check
cd ~/nexus-check
deploy/install.sh --check 2>&1 | tee ~/nexus-install-check.txt
```

Without `sudo` it checks only the prerequisites, which is what is wanted today. It lists each one that is missing with the command that fixes it, and exits 1 when any is. Without `sudo` it always lists "The installer changes the system, so it runs as root", which is expected. Do not run the fixes yet. The list is the result.

- [ ] Keep `~/nexus-install-check.txt`.

Do not run `deploy/install.sh` without `--check`. The install is `ops-3`, and it waits for slices that are not merged yet.

## 3. Network from the office machine

A pylon reaches the internet through its host, and Nexus puts its own certificate between a pylon and each allowed host. A company proxy that also replaces certificates would sit between Nexus and the real host. This block shows who signed each host's certificate as the office machine sees it.

```sh
for host in github.com api.github.com api.anthropic.com registry.npmjs.org controlplane.tailscale.com; do
  printf '%s  ' "$host"
  curl -sS -o /dev/null -m 15 -w 'http %{http_code}  ' "https://$host/" 2>&1
  echo | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null || echo "no certificate read"
done 2>&1 | tee ~/nexus-office-network.txt
env | grep -i -E '^(https?|no)_proxy=' | sed 's/=.*/=<set>/' | tee -a ~/nexus-office-network.txt
```

- [ ] Every host answers with an HTTP status. A 403 or a 404 from a root path still counts, since the host answered.
- [ ] Each issuer is a public certificate authority, not the company's own. If one is the company's, say which hosts, because that changes how pylons must trust certificates.
- [ ] No proxy variable is set. If one is, say so. Do not paste its value.

## 4. The company tailnet

Run these on any device that is signed in to the company tailnet. A laptop works. `jq` is needed for the second block.

First, the two settings the installer requires.

```sh
tailscale status --json | jq '{magicDNS: .CurrentTailnet.MagicDNSEnabled, certDomains: (.CertDomains | length), selfTags: (.Self.Tags // [])}'
```

- [ ] `magicDNS` is `true`.
- [ ] `certDomains` is 1 or more. Zero means HTTPS certificates are off for the tailnet.

Second, what whois says about a person's device and about a tagged device. Nexus decides who a caller is from this answer, and the plan could not check a tagged device before. This prints the shape of each answer and no name.

```sh
tailscale status --json | jq -r '[.Self] + [.Peer[]] | .[].TailscaleIPs[0]' | while read -r ip; do
  tailscale whois --json "$ip" 2>/dev/null | jq -c '{
    tagged: ((.Node.Tags // []) | length > 0),
    tagCount: ((.Node.Tags // []) | length),
    loginIsPlaceholder: (.UserProfile.LoginName == "tagged-devices"),
    loginHasAt: ((.UserProfile.LoginName // "") | contains("@")),
    hasStableID: ((.Node.StableID // "") != ""),
    capMapKeys: ((.CapMap // {}) | length)
  }'
done | sort | uniq -c | tee ~/nexus-tailnet-whois.txt
```

Nexus reads a device as a person when it has no tags and its login holds an `@`. It reads a device as a machine when it has tags.

- [ ] Every line with `"tagged":false` has `"loginHasAt":true`.
- [ ] Every line with `"tagged":true` has `"loginIsPlaceholder":true`. If a tagged device shows a real login, say so, because `mp-01` assumed it never does.
- [ ] Every line has `"hasStableID":true`.
- [ ] If no line has `"tagged":true`, the tailnet has no tagged device this laptop can see, and the tagged case stays unproven until `ops-2` tags the office machine.

Third, three facts for `ops-2`. These need no command.

- [ ] Is the office machine on the tailnet today, and under whose login or which tag?
- [ ] Which group in the tailnet policy holds the engineers who will use Nexus?
- [ ] Who merges a change to the tailnet policy, and how long does that take?

`ops-2` then gives the office machine its own tag and grants the engineers' group access to that tag on port 7443 and on the preview ports. A tagged machine has no user, so Nexus never treats it as a person.

## 5. GitHub

### Personal access tokens, which engineers use until the App exists

An organisation can refuse fine-grained personal access tokens or hold each one for approval. An owner reads this in the organisation's settings, under "Personal access tokens".

- [ ] Are fine-grained tokens allowed to reach the organisation's repositories?
- [ ] Does each token need an owner's approval? If so, who approves, and how fast?
- [ ] Is there a limit on a token's lifetime?

Then one engineer makes a real token and checks it. On GitHub, under Developer settings, make a fine-grained token with the organisation as resource owner, only the company monorepo selected, and these repository permissions and no others.

- Contents, read and write.
- Pull requests, read and write.
- Metadata, read, which GitHub adds.

It must not hold Workflows or Administration. Then, with the token in the clipboard on a Mac.

```sh
export T="$(pbpaste)"
curl -sS -H "authorization: Bearer $T" -H 'accept: application/vnd.github+json' https://api.github.com/user | jq '{login, name: (.name != null), publicEmail: (.email != null)}'
git ls-remote "https://x-access-token:$T@github.com/<org>/<repo>.git" HEAD | cut -c1-12
unset T
```

- [ ] The first command names the engineer's login. `publicEmail` says whether their commits will carry their public address or GitHub's no-reply address.
- [ ] The second prints the start of a commit hash, which shows the token reads the repository over HTTPS.

### Branch rules, as the plan measured them

The plan rests on these rules of the company monorepo: `main` takes changes only by pull request, with one approving review and a code owner's review. Confirm they still hold.

```sh
gh api "repos/<org>/<repo>/rules/branches/main" | jq -c '.[] | {type, parameters}'
gh api "repos/<org>/<repo>/rulesets" | jq -c '.[] | {name, enforcement, id}'
```

- [ ] A `pull_request` rule is present with `required_approving_review_count` of 1 or more and `require_code_owner_review` true.
- [ ] For each ruleset, open it in the browser and write down its bypass list. An actor on a bypass list can merge without review, so a token of such a person inside a pylon could too.

### The GitHub App, which an owner of the organisation approves

This is the gate of `mp-12`. Nothing else waits for it. Bring this description to an owner and ask whether they would approve it.

- **What it is for.** Each engineer signs in to Nexus once in a browser. Nexus then holds a token that acts as that engineer and expires after eight hours, and renews it. Pull requests are authored by the engineer. No long-lived personal token is stored.
- **Where it is installed.** On the company monorepo only.
- **Repository permissions.** Contents, read and write. Pull requests, read and write. Metadata, read.
- **Not requested.** Workflows, Administration, Actions, Secrets, Members, and every organisation permission.
- **Settings.** Device flow on. Expiring user tokens on. No webhook.
- **What a user token can do.** Only what both the engineer and the App may do. It cannot do more than the engineer already can.

One point is open, and the owner may raise it. An App with write access to pull requests also has an installation token of its own, which acts as the App and not as a person. The plan says the control plane asks for that token with read access and label writes only. Whether a review by the App could count as the one approving review has not been tested. `mp-12` must test it before the App is installed on the real repository.

- [ ] The owner's answer: yes, no, or what they need first.
- [ ] Who registers the App: the organisation, or a person whose App the organisation then installs?

## 6. A Claude token from the team subscription

Nexus gives each pylon its owner's Claude token, made with `claude setup-token`. The personal install uses a token from a personal subscription. The plan has not seen one from a team subscription.

On a laptop where Claude Code is signed in to the team subscription.

```sh
claude setup-token
```

Copy the token it prints. Do not paste it anywhere but the next command.

```sh
CLAUDE_CODE_OAUTH_TOKEN="$(pbpaste)" claude -p "Answer with the single word ok."
```

- [ ] `claude setup-token` prints a token on the team subscription.
- [ ] The second command answers. A refusal that names the plan or the organisation is the finding. Copy its words, without the token.

Keep the token. The pilot's first step is `pbpaste | nexus login claude`.

## 7. The host firewall, SELinux, and swap

This check was added after checks 1 to 4 ran. They found that the office machine runs Fedora Server, which the operator's own nodes do not. Fedora Server turns on a firewall and SELinux by default, and the installer looks at neither. Run this block on the office machine. `sudo` asks for a password there, and the commands only read.

```sh
{
  echo "== firewalld";    systemctl is-active firewalld 2>&1
  echo "== default zone"; sudo firewall-cmd --get-default-zone 2>&1
  echo "== active zones"; sudo firewall-cmd --get-active-zones 2>&1
  echo "== tailscale0";   sudo firewall-cmd --get-zone-of-interface=tailscale0 2>&1
  echo "== what the default zone lets in"; sudo firewall-cmd --list-services 2>&1; sudo firewall-cmd --list-ports 2>&1
  echo "== selinux";      getenforce 2>&1
  echo "== swap";         swapon --show=NAME,TYPE,SIZE 2>&1
} 2>&1 | tee ~/nexus-office-host.txt
```

- [ ] `firewalld` prints `active` or `inactive`. If it is inactive, the firewall questions below do not apply.
- [ ] If it is active, say which zone holds `tailscale0`, or that none does, and whether that zone or the default zone lists port 7443.
- [ ] `selinux` prints `Enforcing`, `Permissive`, or `Disabled`. None of them is a failure. `Enforcing` means the first install watches for denials, which [the checks after the install](multiplayer-office-acceptance.md) do.
- [ ] Write down the swap type. Nexus never commits more memory than a machine has, so swap adds no pylons. The type only says how the machine behaves when something else fills its memory.

The control plane listens on the machine's tailnet address, and engineers' laptops call it on port 7443. A firewall whose zone for `tailscale0` does not let that port in would refuse them, even though SSH works. That is read from the code and from Fedora's defaults. The next test shows it either way, without installing anything.

On the office machine, serve an empty directory on that port for a minute. This opens the port while the command runs and changes no setting. It is the one command on this page that does more than read. The probe's ports need no test, because the probe is called from the same machine. Previews are served through Tailscale, which this test does not cover, and the checks after the install open the dashboard and a thread for real.

```sh
python3 -m http.server 7443 --bind "$(tailscale ip -4)" --directory "$(mktemp -d)"
```

On a laptop on the company tailnet, with the machine's tailnet name in place of `<machine>`.

```sh
curl -sS -m 5 -o /dev/null -w 'http %{http_code}\n' "http://<machine>:7443/"
```

Stop the server on the office machine with Ctrl-C afterwards.

- [ ] The laptop prints `http 200`. Then the firewall and the tailnet policy both let the port through today.
- [ ] If it does not, copy the error. An answer at once that says the host is unreachable or the connection was refused points at the machine's firewall. A timeout after five seconds points at the tailnet policy, which `ops-2` changes. The firewall block above says which rule is missing.

## What to bring back

- [ ] `~/nexus-office-machine.txt`, `~/nexus-install-check.txt`, and `~/nexus-office-network.txt` from the office machine.
- [ ] `~/nexus-tailnet-whois.txt` and the three answers for `ops-2`.
- [ ] The three answers about personal access tokens, and what the two token commands printed.
- [ ] The branch rules and each ruleset's bypass list.
- [ ] The owner's answer on the App.
- [ ] Whether the team token worked.
- [ ] The number of pylons that fit.
- [ ] `~/nexus-office-host.txt`, and what the laptop printed in check 7.

## Not for today

- Installing on the office machine. That is `ops-3`, and it waits for `mp-10`, `mp-15`, `mp-16`, and `mp-24`.
- Changing the tailnet policy. That is `ops-2`, a change in the company's infrastructure repository.
- The live boxes that need a pylon on a VM node or two real people. They run on the office machine after `ops-3`, from [the checks after the install](multiplayer-office-acceptance.md).
