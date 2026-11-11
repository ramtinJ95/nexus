# Deploy Nexus on the home-lab nodes

Each node runs a probe, which runs the pylon VMs. One machine, `rj-firebat`, also runs the control plane: the registry, the reconcile loop, the agent harness and the API. The first install is `sudo deploy/install.sh` from a checkout, as [Install on a new machine](#install-on-a-new-machine) describes. After it, `nexus deploy` requests upgrades without sudo or SSH. The installer stays safe to rerun for recovery.

Upgrade the control plane before the probes. `nexus deploy` does this on its own. Every snapshot carries the probe's contract, and the control plane refuses a snapshot below `minProbeContract` in `src/protocol/observations.ts`, logging `<node>: observe failed: <node> runs a probe of contract N (or of no contract), older than the M this control plane reads`. That node shows offline until its probe is upgraded, and its pylons keep running. A release raises `minProbeContract` only after every probe runs one that sends it, so a deploy in this order never meets such a probe. Contract 2 is the exception: it renamed a session's `herdrPane` to `terminal`, so it raised both at once, and in the seconds between the control plane's upgrade and a probe's, that node shows offline. A probe refuses a spawn from a control plane older than itself, while an older probe still runs projects that clone a repository for an upgraded control plane. A boot that needs a secret the control plane hands over, such as `NEXUS_CHATGPT_TOKEN`, goes only to a probe whose snapshot says it takes that secret from the control plane. A probe from before the secret would look for it in its own secret file and fail the thread for good. So in the seconds between the control plane's upgrade and the probe's, such a boot waits, and it goes ahead on the upgraded probe's first snapshot. A probe from before scratch projects cannot start one, so create scratch projects only after every probe is upgraded. A probe that reports a session its last wake failed to bring back, in no terminal, stops a control plane from before session states from storing any observation from that node until the control plane is upgraded too.

CLI 0.11.0 adds `nexus changes <thread> --turn` and `nexus diff <thread> --turn`, also available as Latest turn in the dashboard. Upgrade the control plane to capture these start-of-reply snapshots; no image rebuild is needed. Existing pylons gain a snapshot on their next autonomous turn. Until then, Latest turn reports that no snapshot exists. See [the CLI contract](../docs/cli.md) for the JSON base and failures.

## Install on a new machine

The installer sets Nexus up on your own machines, for a person or a team starting from nothing. An existing install, such as the home lab's, needs no migration: it keeps running, and `nexus deploy` keeps upgrading it.

On a Linux machine that boots with systemd, from a checkout of this repository:

```sh
git clone https://github.com/ramtinJ95/nexus.git && cd nexus
sudo deploy/install.sh --admit <your Mac's tailnet name> [--dotfiles <dotfiles git URL>]
```

This installs the control plane, a probe and the deployer on one machine. On each further machine, install only a probe and the deployer, and name the control plane's machine and a join token minted there, as [Add a node](#add-a-node) describes:

```sh
sudo deploy/install.sh --join <token> --node <control plane's tailnet name>
```

A tailnet name is a device's MagicDNS name, short (`macbook`) or full (`macbook.tail1234.ts.net`), as `tailscale status` lists it.

The installer checks every prerequisite first. It reports each one that is missing, with the command that fixes it, and stops before it changes anything:

- a Linux booted with systemd, and root;
- an x86_64 machine with at least 8 GiB of memory, read from `MemTotal`, which may be up to 512 MiB under 8 GiB for what the firmware and kernel keep;
- Node 26 or newer in `/usr/local/bin` or `/usr/bin`, the units' `PATH`, with its npm, which builds each release, and git, which the deployer fetches releases with;
- QEMU, `qemu-system-<arch>` and `qemu-img`, because pylons are QEMU VMs;
- `/dev/kvm`, owned by the `kvm` group;
- 20 GiB free on each filesystem that holds `/var/lib/nexus` or `/opt/nexus`, the mark under which `nexus nodes` calls a disk low;
- ports 7480 and 7481 free, and on the control plane's machine 7470 and 7443 too, or held by Nexus's own `nexus-probe` and `nexus-control`, as `ss` names every listener on each. A machine without `ss` gets a warning that the ports were not checked;
- no `nexus` or `nexus-control` user with another home than Nexus gives it, and no `/opt/nexus` with files but no `releases` directory, as other software of the same name leaves;
- tailscale, installed, running and logged in;
- MagicDNS and HTTPS certificates turned on for the tailnet. The installer reads them from `tailscale status --json` in the shell, so a machine without Node has them checked on the first run too;
- on the control plane's machine, tailscaled started with `TS_PERMIT_CERT_UID=nexus-control`, so the control plane can fetch the dashboard's certificate (see [HTTPS dashboard](#https-dashboard)).

On a machine that already holds `/opt/nexus/releases`, too little memory or disk is a warning, not a miss, so a rerun or `--upgrade` that recovers the install still runs. A node key that expires is a warning, not a miss. The installer names when it expires and goes on, since the machine works until then. When it expires the machine leaves the tailnet until someone logs it in again, so turn key expiry off for the machine in Tailscale's admin console.

`sudo deploy/install.sh --check` runs the same checks and changes nothing, even when every prerequisite holds. On an installed machine it also checks the install: each unit of the installed roles running, or for `nexus-deployer.service` and `nexus-backup.service` not failed; each of `current`, `control-current` and `deployer-current` naming a release in `/opt/nexus/releases` that holds the desired release the control plane names, as the deployer reads it; `control-plane.json` and `deployer.json`; and `control.json`, `probe.json` and `secrets.env`, each parsed by the installed release that reads it. It lists every problem with its fix and exits 1, or says that everything holds and exits 0. Without root it checks only the prerequisites, since the install's files are root's. An installed machine without the control role is checked as a node. `src/deploy/installed.ts` makes the install's checks, and loads from the checkout before `npm ci`.

`--dotfiles` is optional. Without it, control.json names no dotfiles repository and every pylon keeps the layer the image bakes. With it, the installer runs `git ls-remote` first on the branch control.json names for it, `main` in a new control.json, and writes nothing when git cannot reach it. A rerun with the URL control.json holds checks it again, so once the git SSH key is on GitHub, rerunning with the same `--dotfiles` checks an SSH URL. A rerun with another URL checks nothing and says control.json keeps its own. The config write the installer makes after the credentials step leaves `--dotfiles` out, so it never checks with a key GitHub does not know yet. It checks an HTTPS URL without credentials, so give a private repository's SSH URL. It checks an SSH URL with the machine's git SSH key, which the credentials step makes, so on a first install it says the URL is not checked yet. Unchecked, a wrong URL shows as a failed pull in the pylon boot's log. A probe from before optional dotfiles cannot boot a pylon without them, so take `dotfiles` out of an existing control.json only after every probe is upgraded.

Then `src/deploy/setup.ts` writes the configs from `tailscale status --json`:

| File | What the installer puts in it |
| --- | --- |
| `/etc/nexus/control.json` | This machine as `self`, the first of `nodes` and `imageBuildNode`; its tailnet IP, short and full MagicDNS names in `listen`; its full name as `https.hostname`; the `--admit` devices as `callers` and `deployers`; and this machine's deploy key digest in `deployKeys`. |
| `/etc/nexus/control-plane.json` | The control plane this machine follows: its stable tailnet node ID as `tailnetNodeId`, and its API's URL as `url`. The probe admits the control plane's calls by that ID, and the deployer asks that URL for the desired release after checking that ID. Root, mode 0644. See [The control plane's identity](#the-control-planes-identity). |
| `/etc/nexus/probe.json` | This machine's name and tailnet IP, and previews on gateway port 7481. `gitSsh` is added once `/etc/nexus/git_ed25519` exists. |
| `/etc/nexus/deployer.json` | The deployer's token and timeouts. Root, mode 0600. Only the token's SHA-256 digest leaves this file. |

Then it installs the release and the units with `deploy/install-control.sh`, `deploy/install-probe.sh` and `deploy/install-deployer.sh`, and starts the probe and the deployer's timer. The control plane refuses to start before its harness is signed in, so on a first install its unit is left stopped until the next step signs it in.

### The agents' credentials

Next the installer asks for each credential the machine lacks, over SSH, and keeps it where Nexus keeps it. One credential of each kind serves every thread of the install. Every prompt can be skipped, and a rerun asks again for what is still missing.

| Credential | What the installer asks | Where it goes |
| --- | --- | --- |
| The harness's login, on the control plane's machine | Sign in with ChatGPT, an OpenAI API key, or skip. ChatGPT runs `src/control/login.ts` as `nexus-control`, as [Sign the harness in](#sign-the-harness-in) describes | `harness.credentials` in `control.json`, `/var/lib/nexus-control/harness-credentials.json` by default, `nexus-control`, mode 0600 |
| A Claude token, from `claude setup-token`, or an Anthropic API key | Pasted with the input hidden | `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` for a key that starts `sk-ant-api`, in `/etc/nexus/secrets.env` |
| A GitHub token, as [GitHub access](#github-access-for-a-projects-agents) describes | Pasted with the input hidden | `GH_TOKEN` in `/etc/nexus/secrets.env` |
| The control plane's GitHub token, on its machine | Whether to give it the GitHub token in `secrets.env`, for the [PR watch](#control-plane-github-pr-watch) and the review loop, on every run while `control.json` names no `github.tokenFile` | `/etc/nexus/github-token`, `root:nexus-control`, mode 0640, then named as `github.tokenFile` in `control.json` under the deployer's lock |
| A git SSH key | Whether to make one | `/etc/nexus/git_ed25519`, made on the machine, as [Clone over SSH](#clone-over-ssh) describes |

Each further machine, installed with `--node`, asks for its own Claude token, GitHub token and git key, and copies nothing from the control plane's machine. A credential that is already in place is left as it is: the installer never asks for it, never rewrites or moves it, and never changes its mode or owner, and it says what it left alone. Only `--rotate`, as [Replace a token](#replace-a-token) describes, replaces one. Where `control.json` names its own `harness.credentials` or `github.tokenFile`, or `probe.json` its own `secretsFile` or `gitSsh` key, the installer looks there rather than at the paths above. A failed ChatGPT login offers the choice again. Then it restarts the probe if it runs and `secrets.env` changed, installs the probe again with `gitSsh` once it made a git key, and installs the control plane again once the harness is signed in, which starts it.

The installer asks GitHub about the GitHub token before it keeps it, with one `GET https://api.github.com/user`. It refuses a token GitHub answers 401, as a mistyped, expired or revoked one gets, and at a terminal asks again. Otherwise it prints the account GitHub names and the expiry GitHub's `github-authentication-token-expiration` header gives, or that the token has none. A token GitHub accepts may still lack a permission, which this does not check. When GitHub cannot be reached or answers anything else, the installer warns and keeps the token. It prints no token.

Without a terminal, or with `--non-interactive`, the installer never prompts. It reads each answer from a variable, or from the file that the variable's name with `_FILE` appended names, and skips what is not given. A value that is not a token fails the run.

| Variable | Answer |
| --- | --- |
| `NEXUS_HARNESS_LOGIN` | `api-key`, the default without a terminal, or `skip`. Sign in with ChatGPT needs a person in a terminal |
| `NEXUS_OPENAI_API_KEY` | The harness's OpenAI API key |
| `NEXUS_CLAUDE_TOKEN` | The Claude token or Anthropic API key |
| `NEXUS_GH_TOKEN` | The GitHub token. One GitHub answers 401 fails the run |
| `NEXUS_GITHUB_WATCH` | `yes` or `no`. The default is `yes` for a GitHub token the run was given, and `no` for one already in `secrets.env` |
| `NEXUS_GIT_KEY` | `yes`, the default, or `no` |

```sh
sudo env NEXUS_CLAUDE_TOKEN_FILE=/root/claude-token NEXUS_GH_TOKEN_FILE=/root/gh-token deploy/install.sh --node <control> --non-interactive
```

#### Replace a token

`sudo deploy/install.sh --rotate claude` or `--rotate github` replaces the Claude or GitHub token this machine keeps. It asks for the new one with the input hidden, checks it as an install does, and without a terminal, or with `--non-interactive`, reads `NEXUS_CLAUDE_TOKEN` or `NEXUS_GH_TOKEN`, or the file the name with `_FILE` names. Enter, or no variable, changes nothing.

- `claude` replaces the `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` line in `secrets.env`. It refuses a token of a kind the file does not hold, such as an Anthropic API key where it holds `CLAUDE_CODE_OAUTH_TOKEN`, because the projects grant the name.
- `github` replaces the `GH_TOKEN` line in `secrets.env`. On the control plane's machine it also replaces the file `github.tokenFile` names when that held the same token, or when `secrets.env` has no `GH_TOKEN`. A token file that holds another token, such as a wider classic token for landings, is left alone and named.

The installer writes the new file beside the old one, opened without following a link, as `root:nexus` mode 0640 for `secrets.env` and `root:nexus-control` mode 0640 for the token file, and renames it over the old one. Every other line of `secrets.env` stays byte for byte, and a `secrets.env` or token file that changed while the installer asked, as by another rotation, is refused, and neither file is written. Then it restarts the probe, and the control plane when the token file changed, each only if it runs. A restart that fails is named with its command, and the run fails after it tries the other one. A control-plane restart ends each busy pylon's harness bridge, so tool calls running then report interrupted, and a rotation on the control plane's machine suits a quiet moment. A machine that holds no such token is refused, since an install asks for one. The installer then lists what still holds the old value:

- Each running pylon granted the secret. The probe reads `secrets.env` when it starts and hands a pylon its secrets only in its boot spec, and the pylon's controller, which a probe restart leaves running, keeps them in memory. So a running pylon keeps the old value until it boots again, on a wake after a pause or after `nexus archive` and `nexus unarchive`. A pylon booted after the restart gets the new one. If the old token is revoked first, the running pylons' requests with it fail until then.
- Every other node, which keeps its own copy. `nexus nodes` lists them. Run `--rotate` on each.
- On a node, the control plane's `github.tokenFile`, which only `--rotate github` on the control plane's machine replaces.
- GitHub itself, which accepts the old GitHub token until it is revoked at https://github.com/settings/tokens.

The deployer never runs this step. `nexus deploy` runs only the role installers, in preparation mode, which read no input and leave every credential alone.

The installer ends with what is left and the command for each, in the order to do them. First come the rest of the setup: admitting your Mac or joining the node, the `nexus` CLI on the Mac with `deploy/mac/install` and `nexus connect`, and Docker with buildx for image builds and the probe's access to it. Next comes a rerun for any credential that was skipped. Last comes the first image, which needs the control plane running. A rerun lists only what is still missing, and says `Nothing is left to do.` once that is nothing. The control plane's machine lists the CLI until it holds an image, since the first image is built from the Mac with it, and a node's list leaves the CLI out, as the control plane's names it.

### Rerun to upgrade, admit or recover

Every run checks the prerequisites. A rerun keeps each existing config and secret. It adds only what is missing, such as a new `--admit` device, and says what it left alone, such as a `listen.host` that differs from this machine's address. It never replaces the deployer's token. On the control plane's machine it refreshes what follows from that token and the control plane's address: this machine's digest in `deployKeys`, and `tailnetNodeId` and `url` in `control-plane.json`. A service restarts only when its release, unit file or config changed. The installer then waits up to 60 s, as the deployer does, until systemd calls the unit active and it answers `/v1/health` on its listen address with its release's commit, so a service that crashes after starting fails the run with its journal's tail.

A rerun installs no release over one a role already runs, such as one `nexus deploy` installed at `/opt/nexus/control-current` or `/opt/nexus/current`. Such a rerun, such as `--admit <device>` from the install-day checkout, writes the configs, gives the credentials, and starts the release the link points at again on them. It moves neither link, installs no release and no unit file, and prints which commit runs and which the checkout holds, such as `control-current runs <commit>, and this checkout holds <commit>`. This holds for a checkout at the running commit too, since the deployer names its release by the commit and a checkout's release is named by its content, so installing it would build a second copy and restart the role without a drain. A role with no link yet is installed as on a first install.

Each role installer reads its link under the deployer's lock, so a deploy that lands during a rerun is kept too. To install the checkout's release over the one a role runs, rerun with `--upgrade`. This path has none of the deployer's drain, backup or rollback, so use it for recovery, when `nexus deploy` cannot reach a control plane that answers. An install of the control plane refuses, after the configs are written and before its link moves, when the registry's schema version is newer than the migrations the checkout's `src/control/schema.ts` applies, since that control plane would refuse to start, as [A failed deploy past a registry migration](#a-failed-deploy-past-a-registry-migration) describes. A release cut from a checkout with uncommitted changes records no commit in its `release-commit`, so the deployer installs the desired commit over it on its next poll rather than report it healthy at `HEAD`.

### Uninstall

`sudo deploy/uninstall.sh` from a checkout prints what it would remove and changes nothing. `--yes` removes it. Stopping the probe leaves every pylon's controller running, by design (`KillMode=process` in `nexus-probe.service`), so the uninstall refuses while one runs, and changes nothing. Delete the machine's threads first, or pass `--stop-pylons`. A controller saves its VM's disk on SIGTERM, as a pause does, only once it listens on its `control.sock`, so `--stop-pylons` waits for each controller still booting, then sends each SIGTERM and waits for them to stop, within 180 s in all. A controller that starts after the check stops the run unless `--stop-pylons` was given. In this order, it:

1. Stops, disables and removes the 7 units: `nexus-deployer.path`, `.timer` and `.service` first, so the deployer starts nothing again, then `nexus-backup.timer` and `.service`, `nexus-control.service` and `nexus-probe.service`.
2. Stops the pylons' controllers, with `--stop-pylons`.
3. Removes each `tailscale serve` entry whose only handler proxies `/` to the probe's preview gateway, the `previews.gatewayPort` in `/etc/nexus/probe.json`, and leaves every other entry. It unsets tailscaled's operator when that is `nexus`. It reads the entries only once the units and the controllers have stopped, so an entry the probe adds while it stops goes too.
4. Removes `/etc/systemd/system/tailscaled.service.d/nexus-cert.conf`. tailscaled keeps letting `nexus-control` fetch certificates until it next restarts, which the uninstall leaves to you, since a restart drops tailnet connections for a moment.
5. Removes `/opt/nexus`, the users and groups `nexus` and `nexus-control`, and with them `nexus`'s membership of `kvm` and `docker`, then `/etc/nexus`, `/var/lib/nexus`, `/var/lib/nexus-control` and `/var/lib/nexus-backup`.

`--keep-state` keeps `/etc/nexus`, the three state directories and the two users. The state's files carry the users' numeric IDs, so a reinstall finds its registry, credentials and pylon disks as they were. The backups in `/var/backups/nexus` go only with `--remove-backups`. Their owners are numeric too, as [Restore a backup](#restore-a-backup) says, so a restore suits a reinstall that kept the users.

A tailscaled that does not answer leaves the serve entries, the operator and `/etc/nexus`, whose `probe.json` names the gateway, and the rest goes. A rerun once it answers removes them. The uninstall is safe to rerun, and removes only what is still there. It ends with what remains of Nexus, such as the backups. Node, QEMU, Docker and Tailscale stay installed, and the machine stays on the tailnet. Pylons of the `docker` backend, which only local development uses, are containers the uninstall does not look for.

### Add a node

Mint a join token on the control plane's machine:

```sh
sudo deploy/install.sh --join-token
```

It prints the command to run on the new machine, from a checkout, which joins one machine within the hour:

```sh
sudo deploy/install.sh --join <token> --node <control>
```

That run checks the prerequisites, writes `control-plane.json`, `probe.json` and `deployer.json` and installs a probe and the deployer, as `--node` does. Then it sends the token and its deployer's key digest to the control plane's `POST /v1/join`, after checking the control plane's tailnet identity with tailscaled, and only then asks for the node's own credentials. The control plane records the node as tailscaled's whois names the caller, its stable node ID and MagicDNS name, never as the request says. It keeps the node and its digest in the registry and follows its probe without a restart. Every probe learns its peers from the control plane within a minute, so no node needs a `--peer` rerun.

Only root on the control plane's machine can mint a token, because the token's digest goes straight into the registry, which only the control plane's user can write. The join route is the only route besides `/v1/whoami` that a machine the control plane does not know may call. A used, expired or unknown token is refused, and so are the control plane's machine, a device in `callers` and a node `control.json` names, and the refusal records nothing. A node that joined may join again with a new token, which replaces its deploy key, for instance after its `deployer.json` was lost.

### The control plane's identity

Each machine names its control plane in one file, `/etc/nexus/control-plane.json`:

```json
{ "tailnetNodeId": "nAbCdEf1CNTRL", "url": "http://rj-firebat.tail1234.ts.net:7470/" }
```

The probe reads it at start and admits the control plane's calls from that tailnet node only. The deployer reads it on every poll, asks `url` for the desired release, and checks with tailscaled that `url` is that node before it sends its token. Neither keeps a copy, so pointing a machine at another control plane changes this file and nothing else. The deployer refuses the file unless root owns it and only root may write it, because it decides whom the root deployer trusts, and an upgrade that finds such a file fails its install rather than leaving the deployer to fail every poll. The control plane itself does not read it: on its own machine the file names the control plane's own `self`.

To point a machine at another control plane, run as root from a checkout or a release:

```sh
sudo deploy/set-control-plane.sh <tailnet node ID> <url>
```

It takes the deployer's lock, writes the file atomically, and restarts the probe whenever this machine has its unit, enabled or not, starting it if a failed restart left it down, which then refuses the old control plane's calls. The deployer reads the file on its next poll. A failed restart puts the file back, so it always names the control plane the running probe trusts, and a rerun finishes the change. A rerun that names what the file already holds changes nothing and restarts nothing. It moves no control plane: the machine must already be a node the new control plane knows, with its deploy key.

Before this file, the identity sat in `probe.json` as `auth.controlPlane` and in `deployer.json` as `controlUrl` and `controlNodeId`. Both nodes were moved to the file and those keys removed on 2026-11-09, so the probe now refuses a `probe.json` that still has `auth.controlPlane`, and nothing reads or writes the `deployer.json` keys. A machine still on that form needs its `control-plane.json` written by hand, or a rerun of `deploy/install.sh`, and the old keys removed.

Nodes in `control.json` stay as they are. At each start the control plane follows those nodes and every node that joined, and reads `deployKeys`, `callers` and `deployers` from the file as before. `auth.peers` in `probe.json` holds until the control plane puts its list, and a probe from before join tokens keeps it. The older way also still works: `sudo deploy/install.sh --add-node <name>=<digest>` on the control plane's machine edits `control.json` and restarts the control plane, and probe-only nodes then need `--peer` reruns. Removing a node, joined or listed, is not built.

## Deploy a merged commit

From an allowed Mac or other tailnet caller with CLI 0.13.0:

```sh
nexus deploy main --wait
nexus deploy <full-40-character-commit> --json
nexus release
nexus release --json
```

`main` is resolved by the control plane to GitHub's current `refs/heads/main`. The registry records the full commit, authenticated caller and request time. Each root deployer independently fetches main and verifies the commit is an ancestor before building it. A requested unmerged commit is recorded but fails at the node without changing the running release. The dashboard's node list shows the desired release and each reported component.

`--wait` waits up to 30 minutes for healthy reports from every configured node's probe and the control node's control plane, tolerating connection failures while control restarts. A rollback or failure ends the wait with the reason. An offline node remains pending. The control plane alone judges a report stale: its release view shows a report 90 seconds old or older as pending, by its own clock, so a Mac or node whose clock runs ahead still sees a fresh report as healthy. A failure before the link switch leaves the running release as it was, so the worker tries the same request again. That covers a `git fetch` or `npm ci` that fails or times out, a drain refusal, a failed backup and a lost call to the control plane. It reports `pending`, with a reason that names the try, the error and when the next try runs. The wait is 1 minute after the first failure and doubles after each, and the fifth failure reports `failed`. A failure past the switch, a rollback or a failed rollback, and a release the registry refuses fail at once. A failed request is quarantined locally rather than retried every poll. Running `nexus deploy <commit>` again makes a new request, which clears the quarantine for that commit and starts its count again. Requesting a different merged commit works too. A poll stops at the desired request, before it checks health or drains control, when either of two records holds a failure there. Each record names the request by the desired release's `requestedAt`. The report, `/opt/nexus/<role>-deploy-report.json`, holds every failure the worker reported, and the count and time of the next try. The journal, `<role>-deploy.json`, holds only installs that switched the link. A record from before `requestedAt` counts as made for the request desired when the worker reads it. A rolled-back install stays quarantined by its journal, and reports `rolled-back` again with the journal's reason. Manual recovery is preferable to deploying a rollback again without fixing its cause. `nexus deploy --wait` counts a failure only when the control plane received it after the request, so a new request for a failed commit waits for its own reports.

### The deployer's identity

`deploy/install.sh` installs the root `nexus-deployer.service`, its 15-second timer and `nexus-deployer.path` on every machine, records the machine's roles, and puts the SHA-256 digest of the deployer's token in the control plane's `deployKeys`. On the control plane's machine it does this itself. A node's digest arrives with its join, or with `--add-node`. The plaintext token remains only in that node's root-owned, mode-0600 `deployer.json`; never put it in a project's secrets or a pylon. To read a node's digest again, run as root `node --input-type=module -e 'import{readFileSync}from"node:fs";import{createHash}from"node:crypto";console.log(createHash("sha256").update(JSON.parse(readFileSync("/etc/nexus/deployer.json")).token).digest("hex"))'`.

Only the `deployers` in control.json, which `--admit` sets, may change the release. `deployers` missing or empty disables release changes. Never list an infrastructure node as a deployer: the API rejects every configured node and `self` even if listed, and the installer refuses to admit one. The `url` in `control-plane.json` names the control plane's tailnet IP on its own machine and its MagicDNS name on port 7470 elsewhere; that name must be in the control plane's `listen.hostnames`. The worker verifies the endpoint with tailscaled **before sending its token**. Check `nexus release` for fresh reports from every role.

The deployer also starts as soon as the node's probe writes `/var/lib/nexus/deployer-wake`, which `nexus-deployer.path` watches. The control plane asks every probe to write it when the desired release changes and when the control role reports healthy at it, which each probe role waits for, so a deploy does not wait for the next tick of each timer. The probe passes on nothing but the wake: the deployer reads and checks the desired release itself, as on a tick. A start while the deployer runs joins that run, and the timer stays the fallback. A node whose deployer was installed before the path unit has only the timer until `deploy/install.sh` runs on it again.

Node polling goes directly to the control plane, not through a probe. This keeps root credentials out of the probe and reuses the existing mutual tailnet identity check. Node routes additionally require the root-only token, so pylon egress through its host cannot forge health reports or drain control. Node credentials cannot set a release. The in-pylon CLI bridge accepts only its closed operation schema; it cannot forward an arbitrary API route. Tests cover the bridge, a pylon presenting its host's allowed/deployer identity, spoofed forwarding headers, missing node tokens, and the wrong control endpoint. Do not run an unauthenticated proxy on an allowed deployer: tailnet identity authorizes that machine, not individual programs on it.

### Order, drain, rollback and recovery

The pure planner in `src/deploy/plan.ts` upgrades control before probes. A machine with both roles reads the release view once per poll, and again when control posts a report the view would show differently, a new commit or a change in health, so its probe plans from control's new report in the same poll. A probe reads the view again after preparation, and switches links only while control's report there is healthy on the desired release. If readiness is lost or cannot be read, it returns to `waiting-for-control` and retries on the next poll without restarting or quarantining the release. Before upgrading control, its worker acquires a persistent 120-second drain lease, renewing it every 20 seconds during preparation. The API blocks start, send and retry while leased. A shared harness gate also blocks PR-watch submissions, counts submissions already entering, and lets their pending messages retry later. Idle is checked against committed harness live and queue documents, including parked runs, not the asynchronously updated registry activity flag. After the build, a final idle check seals the drain before the link moves: this hold does not expire until the worker reports success or finishes rollback. This prevents recovery after a hung worker from restarting over a turn that entered after lease expiry. Idle is checked again immediately before restart. An unsealed preparation lease expires if the worker dies; the fixed worker clears a sealed hold after recovery. If neither worker can run, the person must recover the service and use the [manual drain escape hatch](#manual-drain-escape-hatch) below.

`drainTimeoutMs` defaults to 300000 (maximum 600000). At the deadline a still-running or queued turn refuses the release, releases the drain and reports failure; it is **not** cut off. The harness resumes after restart, but `src/control/harness/slice.test.ts` shows that an in-flight tool is interrupted rather than replayed. That is why timeout does not force a restart.

The supervisor serializes both roles and manual installers with one root-owned lock. Git lives in `/opt/nexus/deployer/repo`, not a person's checkout. Build uses `deploy/release.sh`, producing `/opt/nexus/releases/<full commit>` with the dashboard client bundled into it and the whole image recipe, `images/pylon/`, which `nexus image build` reads from the release the control plane runs. Preparing a release already ran `npm ci` on the node, so the node reaches the npm registry as before. It now also installs the dev dependencies, esbuild's platform package among them, builds the client and prunes them, and any of these failing stops the release before it is published. Then the normal role installer performs its upgrade steps in preparation mode: no config or secret replacement, no independent link switch or restart. Control uses `control-current`; probe uses `current`. An atomic transaction records the old link before switching. The worker saves the service unit too, restarts, and requires both an active unit and the local API's `/v1/health` answering with the candidate process's commit. `healthTimeoutMs` defaults to 60000 and is bounded to 1000–60000; HTTP response bodies and service commands have deadlines.

On failure, or recovery of an interrupted transaction, it restores the old link and service unit, restarts, checks the old service's health, and reports `rolled-back` with the journal tail. Failed rollback is reported as `failed`, not success. The on-disk journal uses atomic rename for process-interruption recovery; it is not a filesystem/power-loss guarantee. Database and harness data are not reverted automatically, since that would discard accepted user work. A rollback past a registry migration cannot work at all, so the deployer refuses it, as the next section says.

### A failed deploy past a registry migration

The control plane refuses to open a registry whose schema version, its `user_version`, is newer than the migrations its code applies (`src/control/db.ts`). Every migration raises that version, so a release from before a migration cannot start on the registry after it. Moving the link back after such a deploy fails would only crash-loop the previous release: its control plane exits on start, and systemd starts it again every 5 seconds.

The control role's deployer now compares the registry's version, read through a read-only connection, with the migrations in each release's `src/control/schema.ts`:

- A release that migrates the registry gets a backup first. Once the drain is sealed, so no turn starts or receives a message, the deployer runs `nexus-backup.service`, the [daily backup](#daily-backup)'s unit, and waits for a run that began after the seal. It names the backup in the journal, `/opt/nexus/control-deploy.json`, as `backup`. A backup that fails, or takes longer than 240 seconds, stops the install before the link moves, and the request is tried again as above. The 240 seconds keep a migrating deploy inside the 900 seconds `supervise-deployer.sh` gives one poll, alongside the build, up to 60 seconds of drain and up to 60 seconds of health check. A control plane whose backup takes longer cannot take a migrating release automatically: run `sudo systemctl start nexus-backup` yourself, then install the release with `deploy/install.sh --upgrade` from its checkout.
- When that release then fails its health check, the deployer stops it, so no migration still running or restart by systemd can change the registry, and reads the registry's version. If the previous release cannot open it, or the version cannot be read, the deployer starts the failed release again and does not move the link back; a start that fails is added to the reason. Control stays on the migrated release, the only one that can open the registry, and the deployer reports `failed` with the journal tail, then `not rolled back:`, the versions, and the backup's name. It releases the drain, so a control plane that answers takes work again. The release is quarantined like any failed one.
- A release older than the registry, such as the previous release a landing rolls back to, is refused after its build and before the link moves or anything restarts, and reports `failed` with the versions. A landing then says the rollback failed too, with that reason, and hands the fleet to the person.

The failed release may answer, or it may crash-loop or never bind, which is likelier after a migration. When it answers, `nexus deploy --wait`, `nexus release` and a landing show the reason. When it does not, nothing does: the worker can post its report only to the control plane it failed to start, `nexus deploy --wait` waits out its 30 minutes and times out showing `installing`, and the reason is only on the control node, in `sudo jq -r .reason /opt/nexus/control-deploy-report.json`, with the backup in `sudo jq -r .backup /opt/nexus/control-deploy.json` and the crash in `journalctl -u nexus-control`.

The person picks one of two ways on. Deploying a fixed commit, which needs a control plane that answers, since `nexus deploy` goes through it, keeps everything the control plane recorded since the migration, and its own rollback goes to the migrated release, which can start. With a control plane that does not answer, install the fixed commit by hand with `deploy/install.sh --upgrade` from its checkout, or restore. Restoring the backup goes back to the previous release and discards everything recorded after the backup: threads, messages, reviews, and the conversations in the harness's storage. The drain held from the backup until the failed health check, at most `healthTimeoutMs`, so only what control did in that window, and whatever it took in after the deployer released the drain, is lost. To restore, on the control node, with the backup and the previous release the report names:

```sh
sudo systemctl stop nexus-deployer.timer nexus-deployer.path nexus-deployer.service nexus-backup.timer nexus-backup.service nexus-control.service
sudo node /opt/nexus/control-current/src/control/backup.ts restore <backup>
sudo ln -sfn releases/<previous commit> /opt/nexus/control-current
sudo install -o root -g root -m 0644 /opt/nexus/releases/<previous commit>/deploy/nexus-control.service /etc/systemd/system/nexus-control.service
sudo systemctl daemon-reload
# A refused rollback's report would hold the previous commit back as failed.
sudo rm -f /opt/nexus/control-deploy-report.json
sudo systemctl start nexus-control.service nexus-deployer.timer nexus-deployer.path nexus-backup.timer
nexus deploy <previous commit> --wait
```

The backup counts among the 7 the daily backup keeps, so it is gone after a week of daily runs. A registry the control plane has not made yet takes no backup and refuses no release. A release from before `src/control/schema.ts`, which came on 2026-10-30, cannot say which migrations it applies, so on an existing registry the deployer refuses to install it and refuses to roll back to it; install such a commit by hand.

GitHub reports this repository as **public**. HTTPS fetches need no credentials. Child commands receive a minimal environment with no inherited `GH_TOKEN`, root deployer token, npm config or git user config. If the repository becomes private, do not put credentials in its URL or run builds with GH_TOKEN: fetch-only credential support must be added before automatic upgrades will work.

### Manual drain escape hatch

Run these on the **control node**, as the person, not from a pylon. Clearing a hold allows new turns: never clear it while a deployer could still switch or roll back control. Run each step separately and stop on any error.

1. Stop automatic deployment, including an already-running worker, then inspect the persisted hold. This read works even when the control API is down and does not load or migrate the registry through release code:

   ```sh
   sudo systemctl stop nexus-deployer.timer nexus-deployer.path nexus-deployer.service
   sudo -u nexus-control env PATH=/usr/local/bin:/usr/bin node --input-type=module <<'JS'
   import { readFileSync } from 'node:fs';
   import { DatabaseSync } from 'node:sqlite';
   const config = JSON.parse(readFileSync('/etc/nexus/control.json', 'utf8'));
   const db = new DatabaseSync(config.db, { readOnly: true });
   const row = db.prepare("SELECT value FROM settings WHERE key = 'deploy-drain'").get();
   console.log(JSON.stringify(row ? JSON.parse(row.value) : null, null, 2));
   db.close();
   JS
   sudo sh -c 'if [ -f /opt/nexus/control-deploy.json ]; then cat /opt/nexus/control-deploy.json; fi'
   ```

   `null` means no hold. Otherwise `commit` identifies its release, `expiresAt` is epoch milliseconds, and `locked: true` means it will not expire. If the local transaction is still `installing`, **do not clear the hold or delete the transaction**. Restore a working bootstrap/worker and finish its recovery first: an unfinished rollback could otherwise restart control over a new turn. The clear command below refuses that case.

2. Confirm control's code link and service unit have been recovered to a known-good release and no further restart/rollback is pending. If control is running, use `nexus threads --json` from an allowed client to check `agentTurnRunning` and wait for any active turns to finish; do not stop a running turn just to clear a hold. Stop control before editing its registry, so it cannot race the edit or admit work midway through recovery:

   ```sh
   sudo systemctl stop nexus-control.service
   ```

3. Clear only the drain setting under the deployment lock. This verifies that control, the worker and its timer are stopped and that no install transaction needs recovery, then writes as the registry's service user, not root. It prints the previous hold for the recovery record:

   ```sh
   sudo flock -x /opt/nexus/deployer/lock bash -s <<'SH'
   set -euo pipefail
   for unit in nexus-deployer.timer nexus-deployer.path nexus-deployer.service nexus-control.service; do
     case "$(systemctl show --property=ActiveState --value "$unit")" in
       inactive|failed) ;;
       *) echo "Refusing: $unit is not stopped" >&2; exit 1 ;;
     esac
   done
   /usr/bin/env PATH=/usr/local/bin:/usr/bin node --input-type=module <<'JS'
   import { readFileSync } from 'node:fs';
   let transaction = null;
   try { transaction = JSON.parse(readFileSync('/opt/nexus/control-deploy.json', 'utf8')); }
   catch (error) { if (error.code !== 'ENOENT') throw error; }
   if (transaction?.state === 'installing') throw new Error('Finish deployment recovery before clearing the drain');
   JS
   /usr/sbin/runuser -u nexus-control -- env PATH=/usr/local/bin:/usr/bin node --input-type=module <<'JS'
   import { readFileSync } from 'node:fs';
   import { DatabaseSync } from 'node:sqlite';
   const config = JSON.parse(readFileSync('/etc/nexus/control.json', 'utf8'));
   const db = new DatabaseSync(config.db);
   db.exec('BEGIN IMMEDIATE');
   const row = db.prepare("SELECT value FROM settings WHERE key = 'deploy-drain'").get();
   console.log('Previous hold:', row?.value ?? 'null');
   db.prepare("UPDATE settings SET value = 'null' WHERE key = 'deploy-drain'").run();
   db.exec('COMMIT');
   db.close();
   JS
   SH
   ```

4. Start control and check it before allowing deployment again:

   ```sh
   sudo systemctl start nexus-control.service
   sudo systemctl is-active nexus-control.service
   ```

   From an allowed client, check `nexus release` and normal API access. Leave the deployer timer and path stopped until the worker is repaired and the desired release is the one you intend to run; then use `sudo systemctl start nexus-deployer.timer nexus-deployer.path`. Clearing a hold does **not** cancel the desired release or remove a failed-commit quarantine. Restarting the timer without addressing the original problem may acquire another hold.

### Old releases go once the person agrees

Each release stays under `/opt/nexus/releases` after the links move on, because a pylon's controller keeps running the release it started from. On a node with the probe role, each poll the deployer reports the node's releases to the control plane's `POST /v1/deployer/releases`: each release's name, commit and the bytes it takes, which it reads once and keeps in `/opt/nexus/deployer/release-bytes.json`, the release each link names, the release each role's last install replaced, from its journal, and the releases a process runs from, from `/proc`. The control plane asks the person whether to delete the ones nothing keeps, as [the design's cleanup](../docs/design.md#cleanup-the-person-confirms) describes, and it keeps the release before each role's current one for a rollback. Once the person agrees, the answer to the next report names them. The deployer checks each again under its lock, skips one a link or a process took up since, renames the rest to `.deleting.<name>` and removes them, and reports what each delete did. A crash midway leaves only a `.deleting.` directory, which the next delete removes. A bootstrap worker from before cleanup reports nothing, so its node's releases are never asked about.

### The deployer upgrading itself

`/opt/nexus/deployer/supervise.sh` and `deployer/bootstrap` are fixed recovery copies, refreshed only by the person's manual installer. The bootstrap holds only the worker's runtime sources that `install-deployer.sh` lists, `src/deploy/*.ts` and `src/node-base/*.ts` without their tests, and `src/protocol/deploy.ts`, with no `node_modules`, so the worker imports nothing else at runtime; `src/deploy/worker.test.ts` loads it from such a copy. A rerun also removes test files an earlier install left there. Once a release passes service health, its worker must also complete `--check` (load its code and authenticate a read of desired state) before `deployer-current` selects it. Subsequent polls run that candidate worker under a 15-minute deadline. A crash, a load failure or a hang causes the fixed supervisor to reject that worker and immediately run the bootstrap worker, which recovers unfinished transactions before contacting control. The rejected worker is not promoted again; a later healthy commit can supply a fixed worker. A poll whose call to the control plane fails, because control is unreachable, restarting or refusing the call, exits 75 instead of 1, and the supervisor keeps the worker and waits for the next poll, since the bootstrap would fail the same way. A supervisor from before that change rejects on 75 too, so a node keeps its candidate worker through a control plane outage only once `sudo deploy/install.sh` has refreshed the supervisor. Each report names the worker that sent it, `bootstrap` or the release commit it was promoted from, and `nexus release` shows it as `(worker …)` after the state. The timer runs a single oneshot unit, and the shared lock also protects manual invocations. The systemd unit allows time for both the candidate and fallback.

This does not make arbitrary merged root code safe: merged release code and npm lifecycle scripts are trusted. The fixed supervisor protects against broken workers, not a release deliberately deleting its recovery copy.

`deploy/install.sh` remains the bootstrapping and recovery path. Before repairing a deployment manually, stop `nexus-deployer.timer`, `nexus-deployer.path` and `nexus-deployer.service` (stopping a timer alone does not stop its running service), rerun the installer with `--upgrade` from a known-good checkout, then start the timer and the path again. It preserves configs and secrets, and the manual path retains content-hash release directories. The pylon test environment cannot run node systemd, tailscaled or real VM hosts: rollback, polling and supervisor recovery are tested with temporary files, local HTTP/git servers and fake service commands. The actual one-time node installation and service restart must be verified by the person after merge.

## The probe

`deploy/install.sh` writes `/etc/nexus/probe.json`, and installs `/etc/nexus/secrets.env` from `secrets.example.env` on the first run. Later runs never overwrite secrets.env or change its owner or mode, except `--rotate`, which [replaces a token](#replace-a-token) and restarts the probe. Restart the probe yourself after you edit it: `sudo systemctl restart nexus-probe`.

The probe runs as the system user `nexus`. These are its paths:

| Path | What it holds |
| --- | --- |
| `/etc/nexus/probe.json` | The config. `src/probe/config.ts` parses it. |
| `/etc/nexus/control-plane.json` | The control plane the probe admits, as [The control plane's identity](#the-control-planes-identity) describes. |
| `/etc/nexus/secrets.env` | Secret values, `NAME=value` per line. Mode 0640, owner `root:nexus`. |
| `/var/lib/nexus/pylons` | Pylon instances, their disks and checkpoints, and each instance's `controller.log`, which its controller rotates at 10 MiB into `controller.log.1` and `controller.log.2`. |
| `/var/lib/nexus/artifacts` | Images and templates, one directory per ID, which `backend.artifacts` in `probe.json` names. |
| `/var/lib/nexus/preview-routes.json` | Which pylon each published preview port belongs to. Mode 0600. |
| `/var/lib/nexus/shutdown.json` | The pylons the node's last shutdown found running, which the next boot wakes, and why a pause did not finish. Mode 0600. `shutdownFile` in `probe.json` moves it. |
| `/var/lib/nexus/deployer-wake` | The time of the control plane's last ask to start the node's deployer, which `nexus-deployer.path` watches. `deployerWakeFile` in `probe.json` moves it, and the path unit must then name the same file. |
| `/opt/nexus/current` | The release the probe runs. |

Images and templates the node no longer needs stay in `/var/lib/nexus/artifacts` until the person agrees to delete them on the node's cleanup card. The control plane then sends the probe `POST /v1/cleanup`, and the probe deletes each unless a pylon, a template or a create in progress still needs it. `GET /v1/cleanup` gives the bytes each one takes.

The probe reports the free space of each filesystem that holds one of these paths, `/var/lib/nexus` with its Docker and Gondolin caches, `/var/lib/nexus-control` and `/opt/nexus/releases`. `nexus nodes` marks a node with a filesystem under 10% or 20 GiB free, whichever is larger, and `nexus node <name>` lists each one. No start, wake or template build goes to a node whose pylons' filesystem would keep less than max(10 GiB, 5%) free after the pylon's disk, as [the design's placement](../docs/design.md#placement) describes.

### A shutdown or reboot pauses the pylons

A clean `sudo reboot` or `sudo poweroff` of a node pauses its running pylons first, as an archive does, so each keeps its disk, services and sessions. systemd stops `nexus-probe` with SIGTERM. The probe asks `systemctl is-system-running`, and only when that prints `stopping` does it refuse new jobs and pause every running pylon. It writes them to `/var/lib/nexus/shutdown.json` before the first pause. The probe of the next boot reports them, and the control plane wakes each one whose thread is not archived. Restarting the probe alone, with `sudo systemctl restart nexus-probe` or a deploy, still leaves every pylon running.

The unit's `TimeoutStopSec=180` bounds the wait, and the probe gives the pauses 150 s of it. A pylon whose pause fails or runs out of time comes back failed, and `nexus show` gives the reason the shutdown recorded. Retry it with `nexus retry-pylon`. The journal lists each pylon the stop paused, with its time:

```sh
journalctl -b -1 -u nexus-probe | grep -E 'SIGTERM|paused in|not paused'
```

A power cut pauses nothing, as before. A crash in the middle of a shutdown leaves the file in place, so a pylon whose pause had not finished comes back failed, and one that had paused wakes as after a clean reboot.

A node whose encrypted root waits for its unlock over SSH, such as `infra-testbench`, does nothing special. Its pylons stay paused until someone unlocks it, and wake once its probe reports in.

The next deploy installs the new unit file, as it does every release, so this needs no step by hand.

### Debug a pylon's guest commands

Gondolin's host side logs what it does with a pylon's guest when `GONDOLIN_DEBUG` is set. The probe passes its own `GONDOLIN_DEBUG` to each controller it starts, and the lines land in that instance's `controller.log`. The value is a comma-separated list of flags, or `all`:

| Flag | What it logs |
| --- | --- |
| `exec` | `exec start` when an exec is sent to the guest, after any wait behind a file operation, and `exec done` with its exit code when the guest answers. Nothing while an exec waits, and nothing for file operations. |
| `protocol` | Every frame the host receives from the guest (`virtio rx t=... id=...`), file_read_done, file_write_done, file_delete_done and exec_response among them, every request the host takes from its callers (`client rx type=...`), and the guest's serial console (`[qemu] stdout: ...`). The pylon image sends sandboxd's stdout and stderr to `/dev/null`, so the console shows only the guest kernel's and init's messages, not sandboxd's log. |
| `vfs` | Operations on the host's virtio-fs mounts. |
| `net` | The host's network stack for the guest. |

For a guest that stops answering, as in #415, use `exec,protocol`: it still logs every exec and file operation on the host side, so the frames tell a stuck file operation from a stuck exec, and the console shows any guest kernel problem. Set it in a drop-in and restart the probe:

```sh
sudo mkdir -p /etc/systemd/system/nexus-probe.service.d
printf '[Service]\nEnvironment=GONDOLIN_DEBUG=exec,protocol\n' | sudo tee /etc/systemd/system/nexus-probe.service.d/gondolin-debug.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl restart nexus-probe
```

Only controllers started after the restart log. A running pylon keeps its old controller until its next boot, such as a wake after a pause. `protocol` logs a line per output frame, so a chatty command fills the log fast, and the controller's rotation at 10 MiB keeps only the most recent ~30 MiB per instance in `controller.log`, `controller.log.1` and `controller.log.2`. Copy `controller.log*` off the node soon after a stall. To turn it off, remove the drop-in, run `sudo systemctl daemon-reload` and restart the probe. Controllers started while it was on keep logging until their pylon's next boot.

### GitHub access for a project's agents

A project that grants `GH_TOKEN` to `api.github.com` and `github.com`, as `nexus project add --secret GH_TOKEN:api.github.com,github.com` and the dashboard's GitHub access do, lets its agents create GitHub repositories with `gh` and push to them over HTTPS. This is how a scratch project's work is kept. The installer asks for the token on every machine. To add it by hand on a node that runs the project's threads, append it to `/etc/nexus/secrets.env` and restart the probe:

```sh
echo 'GH_TOKEN=github_pat_...' | sudo tee -a /etc/nexus/secrets.env
sudo systemctl restart nexus-probe
```

Use a fine-grained personal access token whose repository access is all repositories, because the repositories it pushes to do not exist yet, with two repository permissions: Administration read and write, to create repositories, and Contents read and write, to push. The token never enters a pylon. The pylon's `GH_TOKEN` is a placeholder that Gondolin swaps for the value only in requests to the granted hosts. A pylon whose project grants `GH_TOKEN` fails to boot with `secret-missing` on a node that lacks it. The pylon image ships `gh` as git's credential helper for github.com.

### Previews need the probe to be the tailscale operator

A preview is a `tailscale serve --https=<port>` entry that the probe adds and removes. Only root and the operator user may change serve entries, so the installer runs `tailscale set --operator=nexus` on every run. tailscaled has a single operator, so this takes operator rights from any other user on the node. Run `tailscale` commands that change serve or prefs with `sudo` afterwards.

The installer turns previews on with the `previews` block of `probe.json`:

```json
"previews": { "gatewayPort": 7481 }
```

`gatewayPort` is the loopback port that every preview entry proxies to. Keep it fixed, because the probe recognizes its own serve entries by that port. Without the block, the probe publishes no previews, and a spawn that assigns one fails.

With the block, the probe reads the node's MagicDNS name from `tailscale status --json` at startup, and each preview's `PUBLIC_URL` is `https://<that name>:<port>`. The probe refuses to start when the tailnet has MagicDNS turned off, which the installer checks first.

### Clone over SSH

To let pylons clone and push SSH remotes, give the node a git key. The installer offers to make one when `/etc/nexus/git_ed25519` is missing. It writes github.com's host keys to `/etc/nexus/git_known_hosts` only after checking each against [GitHub's published fingerprints](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints), makes the key, adds it to the backend in `probe.json`, and prints the public key with the address of GitHub's page for adding it, https://github.com/settings/ssh/new. By hand, the same is:

```sh
sudo ssh-keygen -t ed25519 -N '' -C nexus@<node> -f /etc/nexus/git_ed25519
sudo chown nexus:nexus /etc/nexus/git_ed25519 && sudo chmod 0400 /etc/nexus/git_ed25519
ssh-keyscan github.com | sudo tee /etc/nexus/git_known_hosts >/dev/null
sudo deploy/install.sh    # with --node <control> on a probe-only node
```

```json
"gitSsh": { "privateKeyFile": "/etc/nexus/git_ed25519", "knownHostsFile": "/etc/nexus/git_known_hosts" }
```

Add `/etc/nexus/git_ed25519.pub` to the GitHub account the pylons push as. The key is readable by `nexus` only and never enters a pylon. Without `gitSsh`, the node boots only pylons whose repository and dotfiles URLs are HTTPS.

### Attach goes through the control plane

`nexus attach <thread>` reaches the pylon's Herdr Core through the control plane's attach route, and the control plane runs Core's client on a pty in the pylon through the node's probe (see `docs/cli.md`). The node needs nothing for it, and nobody needs ssh access to the node. Before CLI 0.9.0, attach ran ssh to the node and a helper, `nexus-attach`, through a sudo rule for the group `nexus-attach`. Earlier installers removed the helper, the rule and the group on every run, so neither node has them. On a machine that never ran one, remove them by hand: `sudo rm -f /usr/local/bin/nexus-attach /etc/sudoers.d/nexus-attach && sudo groupdel nexus-attach`.

Upgrade the control plane before the CLI. An older control plane has no attach route, and `nexus attach` says to upgrade it. Any probe works, old or new.

## The control plane

`deploy/install.sh` without `--node` installs the control plane and writes `/etc/nexus/control.json`. It leaves `nexus-control.service` stopped until the harness is signed in with ChatGPT, as [Sign the harness in](#sign-the-harness-in) describes, and the next run, or `sudo systemctl start nexus-control`, starts it.

The control plane runs as the system user `nexus-control`, apart from the probe's `nexus`, because it holds the model login. These are its paths:

| Path | What it holds |
| --- | --- |
| `/etc/nexus/control.json` | The config. `src/control/main.ts` parses it. |
| `/var/lib/nexus-control/registry.db` | The registry. It also keeps each node's health samples for 31 days: about 6 MB per node read once a minute, and 9 MB for one whose page was open all month. |
| `/var/lib/nexus-control/harness.sqlite` | The harness: every thread's conversation. |
| `/var/lib/nexus-control/harness-credentials.json` | The harness's model login and installation ID. Mode 0600. |
| `/opt/nexus/control-current` | The release the control plane runs, apart from the probe's link. |
| `/var/backups/nexus` | The daily backups, as [Daily backup](#daily-backup) describes. Root, mode 0700. |
| `/var/lib/nexus-backup/status.json` | What the last backup run found, which `nexus doctor` reads, as [Daily backup](#daily-backup) describes. Root's, mode 0644, and it holds no credentials. |

`control.json` names every node's probe, the tailnet nodes that may call the API (`callers`), the common dotfiles layer every new pylon pulls (`dotfiles`, optional: without it pylons keep the image's baked layer), the model new threads start with (`harness.model`), and the https ports previews are allocated from on each node (`previewPorts`, 10200 to 10999 when omitted). A node's `tailnetHost` is its MagicDNS name, such as `infra-testbench.example.ts.net`, because preview URLs name it and its `tailscale serve` certificate is for that name. Each machine's `control-plane.json` must name the control plane's own stable node ID, `self.tailnetNodeId`. The control plane's machine must also be one of its nodes, with a probe: the release view lists the control role under the node whose ID is `self`, and only that node's deployer, authenticated by its deploy key like any node's, may report the control plane's health or drain it. `"resumeAfterUsageLimit": true` makes the control plane type a continue into each Claude worker that stopped on its usage limit, three minutes after the limit resets, as [the CLI's usage-limit stops](../docs/cli.md#usage-limit-stops) describe. It is off when omitted.

### HTTPS dashboard

The control plane terminates TLS itself at `https://<full control-node MagicDNS name>:7443/`, on the same tailnet address as `listen.host`. Port 7443 avoids privileged port binding or capabilities for `nexus-control`; preview allocation reserves it. The plain HTTP API on 7470 remains unchanged. There is **no dashboard Serve entry**: neither the installer nor the control plane changes the probe's Serve configuration.

The installer checks the three things this needs before it changes anything, and prints the fix for each that is missing:

1. MagicDNS and HTTPS certificates turned on in the tailnet, at https://login.tailscale.com/admin/dns. Use a Tailscale version supporting the LocalAPI cert endpoint with `type=pair`, `min_validity` and `TS_PERMIT_CERT_UID` (see source references below).
2. The control-plane service user's **cert-only** LocalAPI access, a tailscaled drop-in that tailscaled was restarted with:

   ```ini
   [Service]
   Environment=TS_PERMIT_CERT_UID=nexus-control
   ```

   Restarting tailscaled briefly affects tailnet connections. The setting accepts a username or numeric UID and lets that user fetch certificates for names this node can obtain; it grants neither Serve write access nor general operator rights. The probe stays the sole operator (`nexus`). Do not grant either service sudo access and do not transfer operator rights to control.
3. `"https": { "hostname": "<full MagicDNS name>" }` in `/etc/nexus/control.json`, with that name in `listen.hostnames`, which the installer writes. Keep `listen.host` bound to the control node's tailnet IP. An existing config without `https` gains it on the next run. Ensure TCP 7443 is available and allowed by any tailnet grants and host firewall. HTTP starts first and stays available even if certificate access is denied, issuance times out or HTTPS cannot bind. HTTPS starts independently once a certificate arrives and its port can bind; there is no automatic redirect to HTTP.

4. Open `https://<full control-node MagicDNS name>:7443/` from a node in `callers`. Enable notifications with the dashboard's permission button; permission belongs to this HTTPS origin, not the old HTTP URL. Verify conversation streaming and terminal attach, and trigger a notification with the dashboard in the background. An unlisted node must receive 403 even if owned by the same Tailscale user. Also publish and withdraw a preview on the control node to verify that the probe still works as an operator without sudo.

After starting HTTP, control fetches the certificate/key pair over tailscaled's Unix socket in the background and refreshes it every 12 hours after a success, requesting at least seven days of remaining validity. Tailscaled handles issuance, its cache and renewal. Nexus validates the hostname, validity dates and key pair before installing a new TLS context without restarting or interrupting existing connections. The private key is held in process memory, not written to Nexus files or logs. Renewal requests have a 60-second deadline and a 128-KiB response limit. Every startup or renewal failure logs its error and retry delay, retaining any previously installed certificate. Attempts are serialized, with exponential backoff from one second to a maximum of 60 seconds between failures; success resets the backoff. HTTPS failures never stop the HTTP API. Persistent failures must be repaired before expiry; after expiry browsers reject new connections rather than bypass TLS validation. Watch `journalctl -u nexus-control` for startup/renewal failures. `GET /v1/health` on HTTP remains 200 and includes `https: { status, error, nextAttemptAt }` alongside the release commit and `version`, the version of the API contract, which the Mac CLI checks against the oldest it reads. Status is `disabled` without HTTPS config, `waiting` until HTTPS starts, `ready` after a successful installation, or `degraded` when renewal failed but the previous TLS context remains installed. `error` is the latest failure (cleared on success); `nextAttemptAt` is the next scheduled attempt in epoch milliseconds, or null while fetching/disabled. Health is readable by an admitted tailnet caller, or via the existing same-address local health check. For example, from an allowed client:

```sh
curl -fsS http://rj-firebat:7470/v1/health
```

A healthy HTTP deployment report does not mean HTTPS is ready; check this state when enabling notifications.

Both HTTP and HTTPS authorize the **actual TCP peer** with tailscaled whois. All `X-Forwarded-*` and `Tailscale-User-*` headers are ignored for identity on both listeners. Stable-node-ID `callers`, self, `deployers`, infrastructure-node exclusion and root-token reporting rules are unchanged. WebSocket origins must match the real HTTPS host and port, so preview origins cannot attach. Do not put a proxy in front of either listener: an allowed proxy's identity would be the caller.

#### Why not Serve for the dashboard?

A Unix-socket Serve target requires local-admin rights for **every later write of the whole Serve config**, including the probe's unrelated preview adds and removals. Operator status alone is insufficient. The original private-socket design therefore blocked previews on the control node. A loopback TCP proxy would avoid that rule but let local users forge identity headers. Direct TLS avoids both problems and does not create, sweep or modify any Serve entry. Previews retain their loopback gateway and default 10200–10999 allocation range.

If the earlier, unmerged private-socket version was manually tried, remove `serveSocket` from control.json and have the person remove **only its confirmed dashboard entry** with `sudo tailscale serve --https=443 off` before using this version. Never run `serve reset`, which would also remove previews. No such migration or live check was performed from this pylon.

Source references at the reviewed upstream revision: [certificate endpoint](https://github.com/tailscale/tailscale/blob/b71e0f30a781894c9508d2903e939c5ca1a1361a/ipn/localapi/cert.go), [cert-only user permission](https://github.com/tailscale/tailscale/blob/b71e0f30a781894c9508d2903e939c5ca1a1361a/ipn/ipnserver/server.go) (`CanFetchCerts`), and [Serve local-admin requirement](https://github.com/tailscale/tailscale/blob/b71e0f30a781894c9508d2903e939c5ca1a1361a/ipn/localapi/serve.go). Tests use a fake LocalAPI and locally generated certificates; real tailscaled issuance/renewal, cert-only permission, preview operations and browser notifications cannot be verified from the development pylon and need the person's post-merge checks above.

Probes and root deployers keep using `http://<control>:7470`. Tailnet transport is already encrypted; these clients do not need a browser secure context, and retaining their direct path avoids changing endpoint identity checks or depending on certificate provisioning. The Mac CLI, and the mod and pi-nexus, which shell out to it, use the URL `nexus connect` saved, which tries this HTTPS port first and then 7470, as [docs/cli.md](../docs/cli.md#connecting-a-device) describes.

### Sign the harness in

The installer offers this login when the harness has none, and starts the control plane once it succeeds. To sign in again by hand, use the commands below. The harness has its own ChatGPT login, kept apart from any interactive pi on the machine. A ChatGPT login reaches only the models ChatGPT offers through Codex, such as `gpt-6-astra`, so `harness.model` in `control.json` must name one of them. The control plane refuses to start with any other model, such as `gpt-5.5`, or before the harness is signed in, and its error in `journalctl -u nexus-control` lists the models the login offers. Only one process may hold the credentials file, so stop the control plane first:

```sh
sudo systemctl stop nexus-control
sudo -u nexus-control env PATH=/usr/local/bin:/usr/bin node /opt/nexus/control-current/src/control/login.ts /etc/nexus/control.json
sudo systemctl start nexus-control
```

The login prints a URL to open in your browser. The browser's last step goes to port 1455 on `rj-firebat`, so on your laptop that page fails to load. Paste the address it ended on into the prompt. Alternatively, forward the port first with `ssh -L 1455:127.0.0.1:1455 rj-firebat`. pi-ai's Sign in with ChatGPT, which the harness uses, offers no device code, unlike its older Codex login.

### pi's ChatGPT login in pylons

A project with the `chatgpt` login gives the pi in each new pylon the harness's ChatGPT login, so nobody signs pi in per thread. [The design](../docs/design.md#pis-chatgpt-login-in-a-pylon) describes how. Nothing needs configuring beyond signing the harness in with ChatGPT, as above. A harness on an API key hands out nothing, and a pylon's pi then answers 401.

For each project whose pylons should have it, allow the login. `--login` replaces the list, so name every login the project keeps:

```sh
nexus project edit <project> --login claude --login chatgpt
```

That grants `NEXUS_CHATGPT_TOKEN` for `api.openai.com` and adds `auth.openai.com`, `chatgpt.com` and `api.openai.com` to the allowlist. Threads started after the edit get it. An existing thread keeps the grants it booted with, even across an archive and an unarchive. A project may not grant `NEXUS_CHATGPT_TOKEN` itself, and a node's `secrets.env` may not set it.

A thread with the login boots only on a probe that holds `NEXUS_CHATGPT_TOKEN` from the control plane. A probe that just started gets it within a second or so of its first snapshot, and the start is accepted meanwhile. On a probe from before the login, its pylon waits until that probe is upgraded.

In the pylon, pi's `openai` provider is signed in, so a model reference names `openai/<model>`, such as `openai/gpt-6-astra`. `openai-codex` is not signed in. Each boot rewrites the `openai` entry of `~/.pi/agent/auth.json`, so a `/login` to OpenAI inside a pylon lasts only until the next wake.

What each place holds:

- The control plane holds the access and refresh tokens in `harness-credentials.json`, as before. It refreshes them when less than 10 minutes remain and sends the access token to every probe every 60 seconds over the tailnet, and at once to a probe that reports it has none. It asks tailscaled who answered on the connection before it sends any byte, so a node that took over a probe's name gets nothing. `journalctl -u nexus-control` names a probe it could not reach, never the token.
- Each probe holds the current access token in memory, and so does the controller of each running pylon. Root on a node can read it there, as it can read `secrets.env`, and use it until it expires. Neither process writes it to disk or to a log, and it never reaches the registry, the events or the observation.
- A pylon holds only a placeholder, which changes on every boot. Its agents can spend the ChatGPT subscription through `api.openai.com`, but cannot read the token.

### Daily backup

The control role installs `nexus-backup.timer`, which runs `nexus-backup.service` as root once a day, at a random time in the hour after midnight, and on the next boot after a missed day. The control plane's unit wants the timer, so the start that follows a deploy starts it too. Each run writes one directory, `/var/backups/nexus/<UTC time>`, such as `2026-10-31T00-23-41Z`, on the control plane's machine only. It holds credentials, so `/var/backups/nexus` and each backup are `root:root`, mode 0700, and every file in them is mode 0600. A `/var/backups/nexus` that is a link or not root's is refused. A backup holds:

| File in the backup | Copied from | How |
| --- | --- | --- |
| `registry.db` | `db` in `control.json`, `/var/lib/nexus-control/registry.db` | SQLite's `VACUUM INTO` from a read-only connection, so the copy is one consistent snapshot of the live database |
| `harness.sqlite` | `harness.storage`, `/var/lib/nexus-control/harness.sqlite` | the same |
| `harness-credentials.json` | `harness.credentials`, `/var/lib/nexus-control/harness-credentials.json` | its bytes as they are |
| `github-token` | `github.tokenFile`, only when it lies outside `/etc/nexus` | its bytes as they are |
| `etc/<path>` | every file under `/etc/nexus`: `control.json`, `control-plane.json`, `probe.json`, `deployer.json` with the deployer's token, `secrets.env`, `github-token`, `git_ed25519`, `git_known_hosts` | its bytes as they are |

After the copies, the run checks each copied database with `PRAGMA integrity_check`, and then writes `manifest.json` last: each file's source path, size, SHA-256, and the source's mode and owner. A directory without a manifest is incomplete, and nothing counts it as a backup. Only once the new backup verifies does the run delete older ones, keeping the newest 7, along with any incomplete directory a crashed run left. A run that fails removes its own directory, leaves the earlier backups as they were, and fails the unit, so `systemctl status nexus-backup` and `journalctl -u nexus-backup` say why. A missing source fails the run, so a control plane that has not started yet, with no registry, has no backup. So does a source that is a link or not a regular file. A service user owns most sources and could swap one for a link to a file only root may read, so each is opened without following a link and read from that open file, and SQLite must hold the same file it was opened as. Copies and their SHA-256 are streamed, so a database past 2 GiB is backed up like any other.

The unit is sandboxed. It writes only `/var/backups/nexus`, `/var/lib/nexus-backup`, and `/var/lib/nexus-control`, where a read-only SQLite connection leaves each database's `-wal` and `-shm`. It has no network, no `/home`, its own `/tmp` and no devices beyond the basic ones, and it keeps two capabilities: `CAP_DAC_OVERRIDE` to read the control plane's files and write those beside its databases, and `CAP_CHOWN` to give them to the database's owner, without which the control plane could not open its own registry after a backup of it stopped.

After each run, success or failure, the backup writes `/var/lib/nexus-backup/status.json`, which `nexus doctor` and the health passes read, every 5 minutes, since `nexus-control` may not read `/var/backups/nexus`. The control plane also reads it every minute for when the newest verified backup began, since an archived pylon's disk goes only after a backup that began after its token usage was read. It holds only the run's time, whether it succeeded, and the newest complete backup's name, whether it verified and when it was made, such as `{"ranAt":"2026-11-01T00:23:41.000Z","succeeded":true,"newest":{"name":"2026-11-01T00-23-41Z","verified":true,"createdAt":"2026-11-01T00:23:41.000Z"}}`. It holds no path's content, no credential and no error's text, so it is mode 0644, in a directory only root writes, mode 0755, and a directory there that is a link or not root's is refused. A status that cannot be written is logged, and the run still exits by its backup's result, so the unit never fails a good backup over its status. After a failed run it verifies the newest backup that remains. A backup that stops verifying between runs shows in `nexus doctor` only after the next run, and at once in the check below.

To see the newest complete backup, how old it is and whether it still verifies now, run the check. It prints one JSON line and exits 1 when there is no complete backup or the newest does not verify:

```sh
sudo node /opt/nexus/control-current/src/control/backup.ts check
```

To run a backup now, `sudo systemctl start nexus-backup`.

### Restore a backup

A restore puts every file of a chosen backup back where the manifest says it came from, with its recorded mode and owner, and replaces each database whole, removing its stale `-wal` and `-shm` first. It writes every file beside its target before it replaces any, so a restore that fails there changes nothing. Files that are not in the backup stay as they are. It refuses a backup that does not verify, and refuses to run while the control plane, the deployer or the backup runs, in their services or their timers, because the deployer can restart the control plane and a backup can prune the one being restored:

```sh
sudo systemctl stop nexus-deployer.timer nexus-deployer.path nexus-deployer.service nexus-backup.timer nexus-backup.service nexus-control.service
sudo ls /var/backups/nexus
sudo node /opt/nexus/control-current/src/control/backup.ts restore 2026-10-31T00-23-41Z
sudo systemctl start nexus-control.service
sudo systemctl start nexus-deployer.timer nexus-deployer.path nexus-backup.timer
```

The registry and the conversations come back as they were at the backup, so what the control plane recorded after it is lost. A restored `/etc/nexus/probe.json` or `secrets.env` takes effect once the probe restarts. Owners are numeric, so a restore suits the machine the backup was taken on.

## Build the pylon image

The image bakes this Mac's Claude Code plugins, skills, pi packages and pi extensions, as `images/pylon/agent-setup/manifest.json` pins them. To refresh them, capture them on the Mac in the nexus checkout, then commit and push the manifest:

```sh
node src/image/agent-setup.ts --dry-run
node src/image/agent-setup.ts
git commit -m "chore(image): refresh the pylon agent setup" images/pylon/agent-setup/manifest.json && git push
```

The capture also takes pi-shepherdr's agent profiles from `~/.pi/agent/shepherdr/profiles/`, so a pylon's shepherdr `reviewer` is the one on this Mac. Like skills, each profile ships from the dotfiles repo, so it must be committed and pushed there. A profile whose `prompt` or `prepare` names a file outside its directory, whose `pi_args` names a path on this Mac, whose `prepare` file, or a module it imports, imports anything but `node:` modules and files in its directory, or that holds a link leading anywhere but a file in its directory cannot ship either. The image build copies a link from the dotfiles checkout, not what it reaches on this Mac.

The capture prints what ships and what it leaves out. When something cannot ship, such as a skill not committed and pushed in the dotfiles repo or a plugin older than its marketplace, it writes nothing and says how to fix each problem. `docs/contracts/usage.md` describes it.

The capture leaves the Claude Code and pi pins in `images/pylon/pins.json` alone. When the Mac runs another version, its notes say so, and moving a pin is a separate commit that edits `pins.json`.

Then deploy the commit that carries the manifest with `nexus deploy main --wait`, because the control plane builds the recipe of the release it runs. From a Mac in the control plane's `deployers`, with CLI 0.22.0:

```sh
nexus image build --wait
nexus image rollout <image ID> --wait
```

`nexus image build` reads `images/pylon/` from the control plane's release and sends a `build-image` job to the probe on the image build node, `imageBuildNode` in `control.json` (`infra-testbench` when omitted). The probe builds with Docker, smoke-boots the result, and publishes it into its store, `/var/lib/nexus/artifacts`. The control plane then reads the image's manifest from the probe and records it, with the release it came from. The command prints the image ID at once, and `--wait` follows the build until it is recorded, about 8 minutes on `infra-testbench`. A recipe that did not change is the image already recorded, and the command reports it as built at once. A build changes nothing that pylons use.

`nexus image rollout <image>` copies the image to every other online node with a checksum-verified `fetch-artifact` job, and makes it current only once every online node reports holding it, so `--node auto` never meets a current image that a node lacks. A node that cannot fetch it stops the rollout, the error names the node and the probe's reason, and the current image stays as it was. A node that is offline when the rollout begins is skipped, and the control plane sends it the image once it is back online, as it does to a node that joins. Three failed fetches in a row stop it, `nexus doctor`'s `image` check and `nexus image list` say so, and `nexus image rollout <current>` tries again. Copies between the nodes run at about 22 Mbit/s, so a rollout takes minutes. `--wait` follows it like `nexus deploy --wait` and survives a control plane restart.

The image that was current stays recorded, and the nodes keep it. `nexus image rollback` makes it current again, through the same rollout, so it checks that every online node still holds it. A second rollback goes forward again. `nexus image list` and `nexus image current` show every recorded image, the nodes that hold it, the release it was built from, when it was built, and which image is current and which is previous.

Only callers in `deployers` may build, roll out or roll back, as with `nexus deploy`. Under [the merge policy](../docs/merge-policy.md), a pylon image rebuild always needs the person, so an agent never runs these commands. The commands exist so the person runs one line instead of a runbook.

Running and paused pylons keep the image they booted from, because their disks are overlays on its root filesystem, and nothing removes an image from a node. Only a pylon that boots fresh, from a new thread, uses the new current image. Archive and unarchive does not move a pylon to the new image, because the wake resumes its own disk.

### Docker access for the image build node's probe

The build runs inside the probe, as the system user `nexus`, which has only the `kvm` group. The Docker step needs the Docker daemon, and membership of the `docker` group is equivalent to root on that node, so a compromised probe would control the node. This is the person's decision. To allow builds, run once on the image build node:

```sh
sudo usermod --append --groups docker nexus
sudo systemctl restart nexus-probe
```

Without it, `nexus image build` fails with Docker's permission error in its reason. The build also reaches GitHub and npm, and keeps Docker and Gondolin caches under `/var/lib/nexus`, the probe user's home.

### Build by hand

`bash images/pylon/build.sh` on the image build node still builds and smoke-boots the recipe of a checkout into `~/nexus-spikes/images/<image ID>` and prints its manifest. Use it to debug a build. An image built this way is not in the probe's store and not recorded, so roll out only images that `nexus image build` recorded.

## Run a first thread

These steps check a fresh install with the real model. Run them on the control plane's machine, as a caller the API allows: the machine itself, `self.tailnetNodeId`. Set these first:

```sh
IP=<listen.host from control.json>
A="http://$IP:7470/v1"
```

1. Sign the harness in, as the previous section describes, then start the control plane with `sudo systemctl start nexus-control`. `journalctl -u nexus-control -n 20` shows `nexus control plane: API on ...` and no `harness` errors.
2. From a Mac in `deployers`, build the image and make it current, as [Build the pylon image](#build-the-pylon-image) describes. The control plane's own machine cannot, because `deployers` never includes it:

   ```sh
   nexus image build --wait
   nexus image rollout <image ID it printed> --wait
   ```

3. Create a project and start a thread:

   ```sh
   curl -sS -H content-type:application/json -d '{"id":"spoon","repoUrl":"https://github.com/octocat/Spoon-Knife.git","defaultBranch":"main","defaultNode":"infra-testbench","resources":{"cpus":2,"memoryGiB":4,"diskGiB":10},"allowedHosts":[],"secrets":[],"logins":[],"preSetup":null}' $A/projects
   T=$(curl -sS -H content-type:application/json -d '{"project":"spoon","title":"first thread"}' $A/threads | jq -r .id)
   ```

   Repeat `curl -sS $A/threads/$T | jq .pylon.actualState` until it prints `"running"`. A fresh boot clones and runs setup, which takes a few minutes.
4. Prompt the agent and read its answer:

   ```sh
   curl -sS -H content-type:application/json -d '{"text":"Use the bash tool to run: uname -s; pwd; ls. Then report the output.","requestId":"msg:first-1"}' $A/threads/$T/messages
   curl -sS $A/threads/$T/conversation | jq '.entries[] | select(.kind=="pi.tool-result")'
   ```

   The tool result contains `Linux`, `/home/user/workspace/repo` and `README.md`. When the answer is done, `curl -sS $A/threads/$T | jq .thread.agentTurnRunning` prints `false`.
5. To remove the thread and its pylon, run `curl -sS -X DELETE -H content-type:application/json $A/threads/$T`.

### Control-plane GitHub PR watch

This optional reader uses the approved classic GitHub token already held as `GH_TOKEN` on rj-firebat. It needs access to the project's private repositories, pull requests, checks, commit statuses and contents (the classic token's `repo` scope). The node's grant to agents is unchanged. Do not grant the control-plane user access to the whole node secrets file.

The installer offers to write the GitHub token it asks for to this file and to name it in `control.json`, when `control.json` names no token file yet. By hand, install a separate file containing **only the token**, not `GH_TOKEN=` or shell quotes, owned by `root:nexus-control` with mode 0640. For example, on the node, an administrator can copy the existing single-line value without displaying it or putting it in shell history:

```sh
sudo install -o root -g nexus-control -m 0640 /dev/null /etc/nexus/github-token
sudo python3 - <<'PY'
from pathlib import Path
values = [line.removeprefix('GH_TOKEN=') for line in Path('/etc/nexus/secrets.env').read_text().splitlines() if line.startswith('GH_TOKEN=')]
if len(values) != 1 or not values[0] or not all(c.isalnum() or c == '_' for c in values[0]):
    raise SystemExit('Expected exactly one unquoted GH_TOKEN value; install the token file manually instead')
Path('/etc/nexus/github-token').write_text(values[0] + '\n')
PY
```

Add `"github": { "tokenFile": "/etc/nexus/github-token" }` to `/etc/nexus/control.json`, then restart the control plane during your normal deployment window. `sudo deploy/install.sh --rotate github` replaces the file and restarts the control plane when it holds the same token as `GH_TOKEN`, as [Replace a token](#replace-a-token) describes. Otherwise rotation requires replacing the file and restarting. `nexus doctor`'s `github-token` check warns 14 days before this token expires and fails once GitHub refuses it. It cannot read the `GH_TOKEN` copy in each node's `/etc/nexus/secrets.env`, so renew that copy at the same time. Never put the value in JSON, logs or a pylon. A configured unreadable/empty/malformed file fails startup rather than silently disabling watching. With `github` omitted, watching is off and `nexus show` and the dashboard say so once per detail view.

Discovery watches `origin/` branch outputs for projects with a github.com repository. It does not infer a scratch project's published repository or another remote's identity. Network/authentication failures remain visible as a PR-watch error on the thread detail and are retried. The watcher stops a thread after ten consecutive comment-only wakes; archive/unarchive preserves that stop and all cursors. There is no reset command in this version.

### The review loop and landing

The review loop (`nexus review`) uses the same token file and is off without it. A review that stops at approval only reads, as the PR watch does. A landing (`nexus review --land` or `nexus land`) also merges, with `PUT /repos/<repo>/pulls/<n>/merge`, which needs write access to the repository's contents and pull requests. A classic token with the `repo` scope, as described above, has it. A fine-grained or otherwise read-only token does not, and a landing then holds for the person with GitHub's answer instead of merging. Widening the token is a credential change, which the [merge policy](../docs/merge-policy.md) reserves for the person: install the wider token in `/etc/nexus/github-token` as above and restart the control plane. Merges then appear on GitHub as the token's owner.

Landing a Nexus pull request deploys it, so the caller who asks for the landing must be in `deployers`, as for `nexus deploy`. The control plane then sets the desired release itself, recorded as requested by `nexus review <id>`, and rolls back to the previous desired release if the fleet does not report healthy within 30 minutes, then waits for the rollback to report healthy before saying so. A deploy that migrated the registry is not rolled back, as [A failed deploy past a registry migration](#a-failed-deploy-past-a-registry-migration) says, so its landing hands the fleet to the person. `.nexus/check` runs in a short-lived check thread of the same project, and Nexus's own runs `npm ci`, so a project whose reviews land needs `registry.npmjs.org` among its allowed hosts.

### A Claude worker's shepherdr reviewer

A Claude worker has a shepherdr `reviewer` check its diff before each pull request, as PYLON.md tells it. The reviewer is pi, so it runs only in a pylon whose project has the `chatgpt` login, as [pi's ChatGPT login in pylons](#pis-chatgpt-login-in-pylons) describes. Nobody signs in per thread. Without the login, Claude says the review was skipped and why. Your `reviewer` profile names `openai-codex/gpt-6-astra`, which the image installs as `openai/gpt-6-astra`, the provider that login signs in.

Once, after the change that ships shepherdr merges, on the Mac:

1. Commit the profiles to the dotfiles repo. If `git status` in that repo lists `common-config/common-dotfiles/pi/.pi/agent/shepherdr/` as untracked, `~/.pi/agent` already links into the repo, so add only its `profiles` directory. Otherwise move the profiles into the repo and restow:

	```sh
	cd <the dotfiles repo>
	mkdir -p common-config/common-dotfiles/pi/.pi/agent/shepherdr
	mv ~/.pi/agent/shepherdr/profiles common-config/common-dotfiles/pi/.pi/agent/shepherdr/
	scripts/dotfiles restow mac
	git add common-config/common-dotfiles/pi/.pi/agent/shepherdr/profiles
	git commit -m "chore(pi): track the shepherdr profiles" && git push
	```

	Leave `~/.pi/agent/shepherdr/.profiles-initialized` out. It is pi-shepherdr's own marker, and the image writes its own.
2. Capture, deploy, build and roll out the image, as [Build the pylon image](#build-the-pylon-image) says. The dry run should list `shepherdr@claude-mods` among the Claude plugins and count the profiles in its `pi` line.

## Git identity and editable projects

Set the optional top-level `gitIdentity` in `control.json` to the person's own commit name and email. There is no separate agent account. For example (placeholder values):

```json
"gitIdentity": { "name": "Example Person", "email": "person@example.com" }
```

The control plane reads this on startup. Every subsequent pylon boot, including an existing thread's checkpoint wake, sets both values globally for `user` after the common dotfiles install. All checkouts and agents inherit them unless they have their own local git overrides. A project's `gitIdentity` overrides the default; `nexus project edit <id> --git-name "Example Person" --git-email person@example.com` sets it, and `--clear-git-identity` returns to inheritance. If neither is configured, Nexus leaves git unchanged, including an old identity on disk. PYLON.md names the configured identity or tells agents not to invent one. Do not put tokens or other secrets in this setting or the guide.

Project edits can also replace logins, hosts and secret grants. To use Claude Code with a long-lived token, provision `CLAUDE_CODE_OAUTH_TOKEN` in the node's protected secrets file, grant it explicitly to `api.anthropic.com`, and include `claude` among the project's logins. See [project edit](../docs/cli.md#project-editing) for replacement-list examples. Existing running and paused pylons retain their original network/grants; archive/unarchive uses the saved boot network and does not update grants. Start a new thread to apply them. `nexus show` warns when grants differ. No deployment or live configuration changes are performed by project editing.
