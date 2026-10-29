# Installing Nexus

This page explores [the roadmap's install wave](../roadmap.md#the-install-wave): how another person, or a company, installs Nexus on their own machines and starts running remote threads fast, with the agents' credentials easy to set up. It walks through what a new person does today, from a bare Linux machine and a Mac to a first thread that answers, describes the target, weighs how a first device is admitted, how agent credentials are shared or kept per person, and how an admin adds machines, and proposes an order to build it.

The person decided on 2026-10-28 that this is Nexus's next focus. The install wave is for alternate setups on other people's machines. The person's own install on `rj-firebat` and `infra-testbench` keeps working as it does and needs no migration to anything here. SSH into a machine during setup is fine and expected, so nothing here tries to avoid it.

Written on 2026-10-28 against Nexus at `70b5358`. The facts the brief gathered were from `ba88ff5`. Between the two, [nexus#190](https://github.com/ramtinJ95/nexus/pull/190) landed the one-command install and [nexus#189](https://github.com/ramtinJ95/nexus/pull/189) landed `nexus connect`, which are steps I1 and I2 below, so this page describes them as landed and the walkthrough is of `70b5358`. I3 landed on 2026-10-29 in [nexus#196](https://github.com/ramtinJ95/nexus/pull/196), with the shared mode only, as the person decided that day. I4, node join tokens, landed after it in [nexus#197](https://github.com/ramtinJ95/nexus/pull/197).

## Recommendation

- **Admitting the first device: the installer flag, `--admit <tailnet name>`, as landed.** The person who runs the installer over SSH names their own device, and the installer resolves it with `tailscale status`. A pairing code or trusting the tailnet's owner would add a secret to hand over, or an identity Nexus does not read today, and buy nothing a person at the machine's shell doesn't already have.
- **Agent credentials: a shared credential set by default, entered on the machine.** The installer asks for each credential over SSH and stores it the way Nexus stores secrets today: the harness's login in `harness-credentials.json`, tokens in `secrets.env`, the git key in `/etc/nexus/git_ed25519`. A per-person mode, where each employee's threads spend their own subscription, needs Nexus to tell people apart, which it cannot today. That makes Nexus multi-user, which [the roadmap's Not planned](../roadmap.md#not-planned) and the design's single-person rules stand against, so it is a decision for the person, and this page sketches the smallest shape that would work.
- **Credential routes stay person-only.** Every credential change happens on the machine as root, or through a route that only a person may call and whose code the merge policy already reserves. No pylon and no node can call such a route. An agent running on an admitted person's device has that device's identity, so keeping agents off these routes is the merge policy's rule rather than something the control plane can enforce, as [its known limits of waivers](../merge-policy.md#known-limits-of-waivers) already say.
- **Adding machines: a one-time join token the admin creates on the control plane's machine.** The new machine's installer takes the token and registers itself, so the admin no longer runs `--add-node` with a pasted digest and the control plane no longer restarts. Landed in I4.

## What a new person does today

The person has a Linux machine they can SSH into as a sudoer, a Mac, and a Tailscale account. Each step names its source.

1. **Join both machines to one tailnet** and turn on MagicDNS and HTTPS certificates in the Tailscale admin console. Nothing in Nexus does this. The installer checks it and prints the console's address when it is off (`deploy/install.sh` lines 89 to 97).
2. **Install the prerequisites the installer asks for.** On the Linux machine, `sudo deploy/install.sh --admit <Mac's tailnet name> --dotfiles <URL>` from a clone first checks, without changing anything, for systemd and root, Node 26, QEMU, `/dev/kvm` in the `kvm` group, tailscale running and logged in, MagicDNS and certificates, the `TS_PERMIT_CERT_UID=nexus-control` drop-in for tailscaled, and `--dotfiles` on a first install. It prints the fix for each miss and exits (`deploy/install.sh` lines 54 to 109, [deploy/README.md](../../deploy/README.md#install-on-a-new-machine) lines 28 to 36). The person runs each fix and reruns. Restarting tailscaled for the drop-in drops tailnet connections for a moment, the SSH session among them if it runs over the tailnet.
3. **Rerun the installer.** It writes `control.json`, `probe.json` and `deployer.json` from `tailscale status --json`, the Mac as `callers` and `deployers` included, installs the three roles and starts the probe and the deployer (README lines 38 to 48, `src/deploy/setup.ts`). The control plane is left stopped, because it refuses to start before the harness is signed in. The installer ends with a numbered list of what is left (`left()` in `src/deploy/setup.ts` line 304).
4. **Sign the harness in to ChatGPT.** A command the list prints runs the login as `nexus-control`. Its browser step ends on port 1455 of the Linux machine, so on the Mac that page fails to load, and the person pastes the address it ended on, or forwards the port with `ssh -L` first (README lines 295 to 305). Then `sudo systemctl start nexus-control`.
5. **Install Docker with buildx, and add `nexus` to the `docker` group** for image builds, which is root-equivalent, so the list leaves it to the person (README lines 362 to 371, `src/deploy/setup.ts` lines 360 to 382).
6. **Give pylons a Claude token**: `claude setup-token` wherever Claude Code runs with a browser, then append `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `/etc/nexus/secrets.env` and restart the probe (`src/deploy/setup.ts` lines 340 to 344).
7. **Give pylons a GitHub token**: make a fine-grained token with Administration and Contents read and write on all repositories, append it to `secrets.env` and restart the probe (README lines 192 to 201).
8. **Make a git SSH key**: `ssh-keygen` into `/etc/nexus/git_ed25519`, chown and chmod it, `ssh-keyscan github.com` into `/etc/nexus/git_known_hosts`, add the public key to GitHub, and rerun the installer, which adds `gitSsh` to `probe.json` (README lines 217 to 232).
9. **Install the CLI on the Mac**: `deploy/mac/install` from a clone, which runs `npm ci` and links `~/.local/bin/nexus`, then `nexus connect <Linux machine's tailnet name>`, which finds the control plane, saves its URL and says what the Mac may do ([docs/cli.md](../cli.md) lines 9 to 51). The installer's list still prints the older steps here, a hand-made symlink and a hand-written `cli.json` with the control plane's URL (`src/deploy/setup.ts` lines 331 to 339). Both work, because #189 and #190 landed in parallel, but the list should say `deploy/mac/install` and `nexus connect`.
10. **Build the first image from the Mac**: `nexus image build --wait`, about 8 minutes, then `nexus image rollout <image ID> --wait` (README lines 345 to 352).
11. **Create a project and start a thread.** `nexus project add` and `nexus start`, or the dashboard at `https://<full MagicDNS name>:7443/`. A project's secrets are grants by name, whose values come from the node's `secrets.env`. Its `chatgpt` login comes from the control plane's handoff and cannot be set there, and its `claude` login is a `/login` inside the pylon (README lines 377 to 410, [docs/cli.md](../cli.md#project-editing-0140)).

Each further machine runs `sudo deploy/install.sh --node <control>` from the start, fixing what its prerequisite check reports and rerunning, as in step 2. Without `--node`, a run that passes its checks installs a second control plane. Once the checks pass, it installs a probe and the deployer and prints its deploy key digest and the command to run on the control plane's machine, `sudo deploy/install.sh --add-node <name>=<digest>`. That edits `control.json` and restarts the control plane. Every other probe-only node then reruns with `--peer <new node>`, and the new node with a `--peer` for each of them (README lines 54 to 62). Steps 6 to 8 repeat on every node that runs threads needing those secrets, because `secrets.env` and the git key are per node.

Since I4, a further machine joins with `sudo deploy/install.sh --join <token> --node <control>`, with a token that `sudo deploy/install.sh --join-token` minted on the control plane's machine. Nothing is pasted, the control plane does not restart, and no node reruns with `--peer`.

Before #190, at `ba88ff5`, steps 2 and 3 were about ten steps by hand: `install-control.sh` and `install-probe.sh` each ran twice with a hand edit of `control.json` or `probe.json` between, for the tailnet IP, the node IDs, every node, the callers and the deployers, and each node's deploy key digest was pasted into `control.json` with a restart. The prerequisites were checked only in part: both role installers checked root, and the probe's installer `/dev/kvm`, the `kvm` group and the tailscale binary, each stopping at the first miss with no fix to run (`deploy/install-probe.sh` lines 20 to 24 at `ba88ff5`). QEMU, MagicDNS, certificates and the `TS_PERMIT_CERT_UID` drop-in were not checked.

So I1 and I2 took the config writing, the prerequisite checks and the CLI's URL out of the person's hands. What is left is mostly credentials (steps 4 and 6 to 8, repeated per node for 6 to 8), Docker (step 5), and registering extra nodes.

Since I3, steps 4 and 6 to 8 are prompts in the installer's own run in step 3, on each machine, and the list at its end points to `deploy/mac/install` and `nexus connect` for step 9.

## The target

On the first machine, over SSH:

```sh
git clone https://github.com/ramtinJ95/nexus.git && cd nexus
sudo deploy/install.sh --admit <your Mac's tailnet name> --dotfiles <URL>
```

The installer checks the prerequisites as it does now. Once they pass, it installs the control plane, a probe and the deployer, then asks for the agents' credentials in the same run, in the order the control plane needs them: the harness's model login by device code, a Claude token, a GitHub token, and whether to make a git SSH key, which it generates on the machine, trusting github.com's host keys and printing the public key to add to GitHub. Each prompt can be skipped and filled in by a rerun. It starts the control plane once the harness is signed in. It ends with what is still left, which on a machine with Docker is the first image build.

On the Mac:

```sh
git clone https://github.com/ramtinJ95/nexus.git && nexus/deploy/mac/install
nexus connect <the machine's tailnet name>
nexus image build --wait && nexus image rollout <image ID> --wait
```

An admin adding a machine creates a token on the control plane's machine, `sudo deploy/install.sh --join-token`, and runs `sudo deploy/install.sh --join <token>` on the new one. The control plane learns the node without a restart, and every probe learns its new peer on its next poll.

A first thread then answers from `nexus start` or the dashboard.

## Admitting the first device

Nexus admits a device by its tailnet stable node ID: `callers` in `control.json` (`src/control/main.ts` lines 69 to 70 and 237), checked against tailscaled's whois of the TCP peer, which Nexus reads only `Node.StableID` from (`src/tailscale.ts` lines 17 to 46). A person is an allowed caller that is neither the control plane's machine nor a node (`isPerson` in `src/control/releases.ts` line 25). Three ways a new install could admit the first device:

| Shape | What the person does | Costs | Risks |
|---|---|---|---|
| An installer flag naming a tailnet device | `--admit macbook` on the install command, or a rerun with it | Landed in #190. A rerun restarts the control plane to pick up `callers`. `nexus connect` from an unadmitted device still says to edit `callers` in `control.json` and restart the control plane (`src/cli/nexus.ts` lines 957 to 965) rather than to rerun the installer with `--admit` | Admits a device, not a person, so anyone at that Mac is the person, as today |
| A one-time pairing code | The installer prints a code, and `nexus connect --pair <code>` sends it, and the control plane adds the caller | A code store with expiry and a single use, a route open to unadmitted nodes that writes `callers`, and `callers` moving from the config file into the registry, or the control plane rewriting its own config | A new unauthenticated route that changes auth. A code in a shell's history or a chat admits whoever replays it before it expires |
| The tailnet's owner | Any device of the tailnet user who owns the control plane's machine is admitted | Reading `UserProfile` from whois, and a rule for tagged machines, which have no owning user | Every device the owner adds later is admitted with no step, phones included. The design chose stable node IDs over tailnet identity on 2026-10-22 ("No tailnet tags or ACL changes") |

Recommend the flag, as landed. The person installing is already root on the machine over SSH, so a code they read off the same terminal proves nothing more than naming the device does, and the flag adds no route and no new state. Owner-based admission would make the person's identity a tailnet user rather than a device, which is the same change per-person credentials need, and is better weighed there. The cost left is the control plane restart on a rerun with a new `--admit`. I4 moved joined nodes into the registry but left callers in `control.json`, so that restart remains.

## Agent credentials

What an install needs, and where each lives today:

| Credential | Used by | Lives in | Set by |
|---|---|---|---|
| The harness's model login, ChatGPT or an OpenAI API key | Every Nexus agent thread, judgments and reviews, and pi in pylons whose project has the `chatgpt` login | `/var/lib/nexus-control/harness-credentials.json`, mode 0600, one per control plane. Probes get only a short-lived access token in memory (README lines 307 to 327) | `src/control/login.ts`, run by hand as `nexus-control`, for ChatGPT. It offers no API key |
| A Claude token, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | Claude workers and Claude reviewers, in projects that grant it | `/etc/nexus/secrets.env` on each node, `root:nexus` 0640. A pylon gets a placeholder that Gondolin swaps for the value only in requests to `api.anthropic.com` | Appended by hand, probe restart |
| A GitHub token, `GH_TOKEN` | `gh` and git over HTTPS in pylons, in projects that grant it | `secrets.env` on each node | Appended by hand, probe restart |
| The control plane's GitHub token, `github.tokenFile` | The PR watch and the review loop's merges | A file `control.json` names | By hand |
| A git SSH key | Clone and push over SSH, terminated on the host | `/etc/nexus/git_ed25519` and `git_known_hosts` on each node, named by `gitSsh` in `probe.json` | By hand, then an installer rerun |
| A Claude or Codex login inside a pylon | One interactive session | The pylon's own disk, gone with the thread | `/login` in the pylon ([design](../design.md#network-and-credentials) line 93) |

A project grants secrets by name and host. Values never sit in the registry or in a pylon ([design](../design.md#network-and-credentials) lines 89 to 91). Changing a project's grants is person-only (`nexus project edit`), and the merge policy reserves changes to secrets, login or auth for the person ([merge-policy.md](../merge-policy.md#always-needs-the-person) line 25), with every path under `deploy/`, `src/deploy/`, `src/control/login.ts` and `src/control/api.ts` reserved for Nexus's own pull requests.

### Shared credentials for the whole install

Landed in I3, as below. The person chose this mode on 2026-10-29 as the default for every install. The installer asks for each credential over SSH and writes it where Nexus keeps it today. One credential of each kind serves every thread, as on the person's own install. [deploy/README.md](../../deploy/README.md#the-agents-credentials) has what it asks and its variables for a run without a terminal.

- **The harness's login.** The installer runs `login.ts` itself, by device code where pi-ai's ChatGPT login offers it, so no port 1455 is involved. `login.ts` already prints a device code when the login sends one (`src/control/login.ts` line 28). It never sends one to this client: the harness's `openai` provider signs in with pi-ai 1.4.0's `openai-chatgpt` flow, which offers only the browser and a pasted redirect address, and only the older `openai-codex` flow, the Codex CLI's client, has a device code (`node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js` and `openai-codex.js`). So the installer keeps today's paste of the address the browser ended on. An OpenAI API key is the other choice. The harness's credentials accept one (`src/harness/credentials.ts` line 40), but `login.ts` only signs in with ChatGPT, so the installer would write the key itself. A harness on an API key hands pylons nothing, so pi in a pylon then needs its own key.
- **The Claude token.** The installer prompts with the input hidden and writes `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` to `secrets.env`, then restarts the probe if it runs.
- **The GitHub token.** The same, into `secrets.env` as `GH_TOKEN`, with the scopes README line 201 names. It could offer to write the same token to `github.tokenFile` for the PR watch.
- **The git SSH key.** The installer generates `/etc/nexus/git_ed25519` on the machine if it is missing, runs `ssh-keyscan github.com` into `git_known_hosts` and checks the keys against GitHub's published fingerprints, adds `gitSsh` to `probe.json`, and prints the public key with the address of GitHub's SSH key page. The key never leaves the node.
- **On each further node,** the Claude token, the GitHub token and the git key are needed too. The installer asks for them on that node. A join (I4) could offer to copy the shared ones from the control plane's machine over the tailnet, but copying a key between machines widens where it lives, and the person decided on 2026-10-29 that each node asks for its own, for now.

The dashboard and the Mac set none of these. A route that writes a credential is a route that changes auth, reserved for the person, and setup already runs as root on the machine. The roadmap's [agent asking for a secret](../roadmap.md#the-dashboard-wave) is a separate, later flow.

### Per-person credentials

Here each employee's threads spend that employee's own subscription or company login, so usage is theirs. What Nexus knows today:

- **One person.** Every allowed caller that is not a node is the person (`isPerson`). Two employees' Macs in `callers` are both "the person". Each sees and can message every thread, land under the merge policy if a deployer, and change any project's secrets.
- **A thread's starter, as a node ID.** `Thread.startedBy` is the caller's node ID for a person's start, or a role name for the control plane's own (`src/control/queue.ts` line 209, `src/control/usage.ts` line 17).
- **Credentials per node and per install.** `secrets.env` is per node, and the harness's login is per control plane. Nothing is per person.
- **Logins inside a pylon.** A Claude worker's session can `/login` in its own pylon. That already makes its usage someone's own, but it costs a sign-in per thread, which the person rejected for pi ([design](../design.md#pis-chatgpt-login-in-a-pylon) line 109), and the tokens sit where any agent in the pylon can copy them.

Telling employees apart takes an identity above the device. Tailscale's whois answers with a `UserProfile` beside the node, the tailnet user who owns the device, such as `alice@example.com`. Nexus would read that, and map a tagged device, which has no user, to nobody. Then:

- **Where each person's credential lives.** On the control plane's machine, in a per-person store beside `harness-credentials.json`, one file per tailnet user, `nexus-control` mode 0600. The control plane would hand a person's token to the probe that runs their thread, in memory, the way it hands the ChatGPT access token today (README line 325), so no node keeps per-person values on disk.
- **Which threads use it.** A thread uses its starter's credential, fixed when it starts, as grants already are. A thread the control plane starts, a reviewer, a check or a queued thread, uses the credential of the person whose action led to it: the deployer who asked for the review, or the person who added the pipeline item. With no credential for that person, the start fails with a reason that names the missing login, not falls back to a shared one, unless the install allows a fallback.
- **How a person sets theirs.** The harness's ChatGPT login and a Claude token both come from an OAuth flow in a browser. A person-only route takes a device-code login started from `nexus login claude` or the dashboard, and the control plane completes it and stores the result under the caller's tailnet user. Only that user's devices may set or remove their own credential, and no pylon or node may call the route.
- **The harness.** pi-durable runs every Nexus agent thread on one set of credentials for the control plane (`openHarnessHost` in `src/control/main.ts`). Per-person harness logins need pi-durable to take credentials per conversation, which this page did not check.

That is Nexus becoming multi-user, and it reaches well past credentials:

- **Not planned.** The roadmap rejects remote access machinery, OAuth and guest links because "the tailnet and its whois check already cover a single user" ([roadmap](../roadmap.md#not-planned)). Reading the tailnet user keeps the tailnet as the only door, but it does make Nexus serve more than one user.
- **The design's single-person rules.** "The person" decides merges, waivers, image builds and reserved cases. With several people, someone must say who is an admin (deployers today are devices), whether one employee may see, message or archive another's thread, whose project a project is, and whose credential a shared project's reviewer spends. The merge policy names one person who approves reserved cases, and a waiver records a device.
- **Usage.** `nexus usage` reports tokens per thread. Per person needs a column and a rollup by starter.

The shared mode needs none of this. A company that wants usage per person but not the rest could run one install per person, or give each person their own project and node, whose `secrets.env` holds their token. That works today with no code change for the credentials a node holds, the Claude and GitHub tokens and the git key, at the price of a node per person and an admin who edits each node's secrets. It does not split the harness's ChatGPT login, which one control plane holds for every thread and every pylon's pi (`src/harness/credentials.ts` lines 64 to 71), so separate harness logins need separate installs.

This page recommends shipping the shared mode in I3 and leaving the per-person mode as a decision for the person. The person decided on 2026-10-29: shared credentials by default, with the option to switch to per-person credentials later, and I3 built only the shared mode.

The place a per-person mode would start is `stores` in [`src/deploy/credentials.ts`](../../src/deploy/credentials.ts), the one table that says where each kind of credential lives, which machines keep one and whom it serves. Every entry's scope is `install` today. A per-person mode would add a store of scope `person` for a kind beside its shared one, such as a per-person file on the control plane's machine for the Claude token, so a shared install keeps its files where they are and needs no migration, and an install could fall back to the shared credential. The identity, routes and storage that mode needs, above, are not built.

## Adding machines

Today a new node is registered by `--add-node` on the control plane's machine with the digest the new node printed, which edits `control.json` and restarts the control plane, then a `--peer` rerun on every other probe-only node and on the new node (README lines 54 to 62). The control plane reads its nodes only from `control.json` at startup and upserts them into the registry (`src/control/main.ts` lines 127 to 129), and each probe checks the probes it fetches from against `auth.peers` (`src/probe/config.ts` line 43).

With a join token, the admin runs `sudo deploy/install.sh --join-token` on the control plane's machine, which stores a random token's digest in the registry with a 1-hour expiry and a single use, and prints `sudo deploy/install.sh --join <token> --node <control>`. On the new machine, over SSH, that installer checks the prerequisites, writes `probe.json` and `deployer.json` as `--node` does now, and sends the token with its deploy key digest to a join route on the control plane over the tailnet. The control plane checks the token, records the node from the caller's whois (its node ID and MagicDNS name, never from the request's body), and stores the deploy key digest. It then connects to the new probe without restarting. Each probe learns its peers from the control plane rather than from `auth.peers` alone, so no `--peer` rerun is needed.

The costs:

- Nodes, deploy keys and callers move from `control.json` into the registry, with `control.json`'s lists kept as seeds so the person's own install changes nothing. That is a registry migration, which the merge policy holds for the person, and the control plane must add and drop probes at runtime, which its wiring in `src/control/main.ts` does once at startup today.
- The join route is open to any tailnet node that holds a valid token, so it must be the only route an unadmitted node can call besides `/v1/whoami` (`src/control/api.ts` lines 1231 to 1236, where `/v1/health` skips admission only for a request from the control plane's own address), and it changes auth, which holds its pull request for the person.
- Probes need a peer list they refresh from the control plane, which changes the probe's auth and the image fetch path between probes.

A token, rather than admitting any tailnet node that asks, keeps the rule that a node is registered only by someone who is root on the control plane's machine.

### As landed in I4

I4 built the join as above, with these choices:

- **The token.** `--join-token` runs `src/control/join-token.ts` from the control plane's release as root. It stores the sha256 of 32 random bytes in the registry's `join_tokens` with a 1-hour expiry, and prints the command for the new machine. The registry's directory is `nexus-control`'s, mode 0700, so only root or the control plane can mint one.
- **The join.** `--join` runs after the role installers and before the credentials' prompts, so a refused token stops the run before the person answers them. `src/deploy/setup.ts` checks the control plane's identity with tailscaled, as the deployer does, before it sends anything. The route reads the caller's `Node.StableID` and `Node.Name` from whois, and drops any name or ID in the body. It refuses the control plane's machine, every device in `callers`, a node `control.json` names, and a name another node has. A joined node may join again with a new token, which replaces its deploy key.
- **What moved into the registry.** Joined nodes and their deploy key digests, in `joined_nodes`. `control.json`'s nodes are upserted at each start as before, and its `deployKeys`, `callers` and `deployers` are still read from the file. This page proposed moving callers into the registry too, but nothing adds a caller at runtime yet, so a registry copy would only be rewritten from the file at every start. A runtime `--admit` would be the reason to move them.
- **Peers.** The control plane puts each probe's list on `PUT /v1/peers` on every snapshot, about once a minute, and to every probe when a node joins. A probe keeps `auth.peers` from `probe.json` until then, and a probe from before I4 answers 404, which the control plane logs once, and keeps it.
- **Removing a node** is not built. The control plane's loop can follow a probe at runtime but not let one go. Removal would need a route or host command, dropping the node's link and probe client, and a rule for the pylons and checkpoints still on it, which is more than dropping a probe.

## How credential routes stay person-only

Every route that changes a credential, a caller, a node or a deployer must answer only a person, and the merge policy keeps changes to them for the person:

- Setup credentials are written on the machine by root over SSH, so no route exists for the shared mode.
- What the control plane can enforce is that a pylon, a node or the control plane's own machine never passes `isPerson`. It cannot tell the person from an agent on the person's device, which shares that device's tailnet identity. Keeping agents off these routes rests on the merge policy, as it already does for waivers.
- A per-person login route, if built, answers only `isPerson` callers, and only for the caller's own tailnet user. Its response carries no credential, and nothing reads a stored credential back out.
- The join route takes a token only root on the control plane's machine can mint, and records only what whois says about the caller.
- A pylon's host bridge stays a closed list with none of these (`src/project.ts` lines 510 to 518, [design](../design.md#who-starts-a-thread)). Gondolin passes no request from a pylon to the control plane unless a person adds it to a project's hosts.
- Every pull request that builds these touches `deploy/`, `src/deploy/`, `src/control/api.ts` or `src/control/main.ts`, so it holds for the person under [the reserved paths](../merge-policy.md#paths-that-hold-a-nexus-pull-request).

## Build order

Each step delivers something on its own. I1 and I2 have landed.

1. **I1: one-command install with prerequisite checks that writes its own config.** Landed in [nexus#190](https://github.com/ramtinJ95/nexus/pull/190): `deploy/install.sh` checks every prerequisite before changing anything, writes `control.json`, `probe.json` and `deployer.json` from `tailscale status`, installs the roles, and lists what is left. A rerun keeps existing values and secrets.
2. **I2: `nexus connect` and no hardcoded default URL.** Landed in [nexus#189](https://github.com/ramtinJ95/nexus/pull/189): `deploy/mac/install` installs the CLI, `nexus connect <host>` finds the control plane and saves its URL, and `GET /v1/whoami` tells a device what it may do. The CLI has no built-in URL. Two loose ends, since #189 and #190 landed in parallel: the installer's list of what is left still prints the hand-made symlink and `cli.json` rather than `deploy/mac/install` and `nexus connect` (`src/deploy/setup.ts` lines 331 to 339), and `nexus connect` from an unadmitted device says to edit `control.json` and restart the control plane rather than to rerun the installer with `--admit` (`src/cli/nexus.ts` lines 957 to 965). Both were tied off in I3.
3. **I3: agent credentials for an install.** Landed in [nexus#196](https://github.com/ramtinJ95/nexus/pull/196): the installer asks for the shared credentials over SSH, as [Shared credentials](#shared-credentials-for-the-whole-install) describes, and starts the control plane once the harness is signed in. It generates the git key, checks github.com's host keys against GitHub's published fingerprints for `known_hosts`, and prints the public key. Without a terminal it reads the credentials from `NEXUS_*` variables or files, and never prompts. The per-person mode is not built, as the person decided on 2026-10-29. Its tests fake the prompts and the machine (`src/deploy/credentials.test.ts`, `src/deploy/prerequisites.test.ts`), and prove that the deployer's preparation reads no input and changes no credential (`src/deploy/install.test.ts`).
4. **I4: node join tokens.** Landed in [nexus#197](https://github.com/ramtinJ95/nexus/pull/197): a token the admin mints on the control plane's machine, a join route that records the node from whois only, joined nodes and their deploy keys in the registry beside `control.json`'s, a control plane that follows a joined probe without a restart, and probes that learn their peers from it. API tests cover the token's single use and expiry, a forged name in the body, and an unadmitted caller refused everywhere but `/v1/whoami` and the join. `src/control/main.test.ts` starts a control plane on a registry and `control.json` shaped like the person's and shows the same nodes, callers, deployers and peers. A second probe joined a local stack without a restart, and a thread started on it, with an in-memory backend in place of Docker.
5. **I5: a fresh-install end-to-end test and a quickstart README.** A test that runs the installer on a fresh VM, the Mac side from a second tailnet device, and a first thread that answers, plus a short quickstart at the top of the repository's README that a new person follows from nothing. It needs a tailnet the test can join and leave, which this page did not settle.

## Decisions for the person

- **Whether Nexus becomes multi-user** for the per-person credential mode. It would change the Not planned entry on remote access machinery, the design's single-person rules, who counts as an admin and who sees whose threads. The alternative is the shared mode only, with one install or one node per person for a company that wants usage per person. Decided on 2026-10-29: shared credentials for the whole install by default, with the option to switch to per-person credentials later. I3 built only the shared mode, shaped so a per-person mode can be added without migrating a shared install. Multi-user itself is not scoped yet.
- **Whether a join may copy the shared credentials** from the control plane's machine to the new node, or each node always asks for its own. Decided on 2026-10-29: each node asks for its own, for now.
- **Whether the installer may add `nexus` to the `docker` group** on its own when the person says yes, or keeps leaving that root-equivalent step to a command the person runs.
- **Which tailnet the fresh-install test (I5) runs in,** and whether an ephemeral auth key for it is acceptable, since a key that joins devices to the tailnet is a credential the merge policy reserves.

## What this page could not check

- Whether pi-ai's ChatGPT login offers a device-code flow to the harness's client. Settled by I3 from pi-ai's code: it does not. Nobody ran a real login from the installer.
- Whether pi-durable can run conversations on different credentials, which a per-person harness login needs.
- What tailscaled's whois returns for a tagged device's `UserProfile` on a current Tailscale. This page relies on Tailscale's documented behaviour and did not call whois.
- A fresh install end to end. Nothing on this page was run on a new machine.
