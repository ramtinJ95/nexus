# Fresh install

A new person's install of Nexus from nothing, on three fresh Debian 12 machines: `fresh-box`, the Linux machine that runs the control plane and a probe, `fresh-mac`, which stands in for their Mac, and `fresh-node`, a second Linux machine that joins as a node. It is I5 of [the install wave](../../explorations/install.md#build-order). [`transcript.txt`](transcript.txt) is a full green run.

## How to rerun

From a checkout, on a Debian 12 host with root:

```sh
sudo node docs/verification/fresh-install/run.ts
```

It installs the checkout's HEAD commit, so commit what you want tested. A run takes about two minutes, once it has the Debian root filesystem.

The host needs:

- `git`, `tar`, `unshare`, `nsenter`, `flock`, `runuser`, `python3` and `dpkg`;
- Node 26 with npm beside it, from Node's own tarball or NodeSource's package;
- the Debian packages `sudo`, `openssh-client`, `git`, `libstdc++6` and `libatomic1`, which it copies into the machines with their dependencies;
- the network to reach github.com and registry.npmjs.org.

It checks all of these before it changes anything, and names what is missing. Everything it makes lives in `/var/tmp/nexus-fresh-install`, three loopback addresses and processes whose root is in that directory. It removes all of them at its end, pass or fail, and again at the start of the next run, so a run that was killed leaves nothing behind for long. A second run refuses to start while one holds the `flock` on `/var/cache/nexus-fresh-install/lock`. That directory also keeps the Debian root filesystem, which a run downloads once.

In a Nexus pylon, the sandbox's proxy to the npm registry sometimes times out under `npm ci` even with the longer timeouts below, and the run fails with `ETIMEDOUT`. Run it again.

It lives here rather than beside `src/slice.test.ts` because it needs root, three machines and minutes, and tests no module: it drives `deploy/install.sh` and the CLI as a person types them, and its proof is the transcript. That is what this directory holds.

## What it does

Each machine is Debian's official bookworm root filesystem, from the commit of [debuerreotype's artifacts](https://github.com/debuerreotype/docker-debian-artifacts) the script pins and checks by SHA-256, in its own mount, PID, UTS and IPC namespaces. `fresh-box` starts with a sudoer named `person`, `sudo` and `openssh-client`, as a cloud image does. Every command runs as `person` in a login shell, as over SSH.

1. On `fresh-box`, the person installs git, clones Nexus, and runs `sudo deploy/install.sh --admit fresh-mac --dotfiles <URL>`. It reports five missing prerequisites and changes nothing.
2. They fix each one: Node 26, QEMU, `/dev/kvm`, then Tailscale, whose install starts tailscaled. The second run finds the one the first could not check, tailscaled's `TS_PERMIT_CERT_UID`. The test runs the three commands the installer printed for it, as they are.
3. The third run installs with the credentials as test values, from `NEXUS_*` variables with `--non-interactive`: an OpenAI API key for the harness, a Claude token and a GitHub token. It also makes the git SSH key, with github.com's host keys checked against GitHub's fingerprints. The test checks that `nexus-control` and `nexus-probe` run, the tokens are in `secrets.env`, and the key is in `probe.json`.
4. On `fresh-mac`, the person clones Nexus, runs `deploy/mac/install`, and runs the `nexus connect` the installer printed. It connects over HTTPS to the dashboard's port, and says this device may start and message threads and may deploy.
5. The first image is recorded and rolled out with `nexus image rollout --wait`, which waits until the probe reports it holds the image.
6. `nexus project add` and `nexus start --message` start a first thread, which is placed on `fresh-box`. The probe tries to boot its pylon, and Gondolin refuses the stand-in image, which has no guest kernel, as `nexus show` says.
7. The admin mints a join token on `fresh-box` with `sudo deploy/install.sh --join-token`, and runs the command it printed on `fresh-node`, with that node's Claude and GitHub tokens. The node joins, makes its own git key, and `nexus nodes` on `fresh-mac` lists it online, while the control plane on `fresh-box` runs on without a restart.
8. A rerun of the installer on `fresh-box` writes no config and restarts neither service.

## Stand-ins

| What | Stand-in | Why |
| --- | --- | --- |
| tailscale and tailscaled | [`standin/tailscale`](standin/tailscale) prints a made-up tailnet in `tailscale status --json`. A `tailscaled` unit runs, and [`tailnet.ts`](tailnet.ts) serves its LocalAPI socket from the host. Whois names the machine whose process holds the TCP peer's socket, found through `/proc`. Certificates are self-signed for each machine's MagicDNS name and handed to any caller | No real tailnet, as the person decided on 2026-10-29 |
| MagicDNS | Each machine's `/etc/hosts`, with each machine's short and full name on 100.77.0.1, .2 and .3, which [`loopback.py`](loopback.py) puts on this host's loopback interface | The machines share this host's network namespace, and the probe takes only tailnet addresses |
| A machine's own 127.0.0.1 | `fresh-node`'s `probe.json` starts with its preview gateway on port 7491, which the installer keeps and says so | Every probe's gateway binds 127.0.0.1:7481, which the machines share |
| The public CA that signs tailscaled's certificates | `fresh-mac` trusts `fresh-box`'s certificate through `NODE_EXTRA_CA_CERTS` | The certificate is the stand-in's |
| systemd | [`standin/systemctl`](standin/systemctl) and [`standin/journalctl`](standin/journalctl) run a unit's `ExecStart` as its `User` and `Group`, with its `WorkingDirectory`, `UMask` and `Environment`, drop-ins included, and log to a file. No sandboxing such as `ProtectSystem`, no restart policy, and the deployer's timer never fires | Neither machine can boot systemd here |
| KVM and QEMU | A `/dev/kvm` device node in the `kvm` group, and [`standin/qemu`](standin/qemu) as `qemu-system-x86_64` and `qemu-img`, which fail | This host has no KVM, so no pylon boots |
| `apt-get install` | [`standin/apt-get`](standin/apt-get) copies each Debian 12 package and its missing dependencies from this host's own install, with their dpkg records | This host reaches no Debian mirror |
| Node 26 from NodeSource, or from Homebrew on the Mac | This host's Node 26 and npm | This host reaches no NodeSource repository |
| `ssh-keyscan github.com` | [`standin/ssh-keyscan`](standin/ssh-keyscan) prints [the host keys GitHub published](standin/github-host-keys) at api.github.com/meta. The installer still checks them against its own list of GitHub's fingerprints | This host cannot reach github.com on port 22 |
| `nexus image build --wait` | An image's directory in `fresh-box`'s artifact store, with a manifest as a build writes it and no guest kernel, recorded with `POST /v1/images` | It needs Docker and builds for 8 minutes, and this host has no Docker |
| OpenAI and GitHub's API | `api.openai.com` and `api.github.com` resolve to an address where nothing listens, on `fresh-box` | The credentials are test values, which never leave this host |
| The network a pylon's egress goes through | When this runs in a Nexus pylon, npm in each machine trusts the sandbox's TLS proxy's CA and gives each connection 5 seconds and 6 retries | npm otherwise times out at the proxy under load |

## What it cannot check

- **A first thread that answers.** Before every model request, the harness renders the agent's sections in the thread's pylon, through `src/harness/pylon-env.ts`, which waits until the pylon runs. No pylon boots here, so the thread never reaches the model, and the run checks only that the start is placed and reaches the probe's VM backend. An answer needs a machine with KVM and a real image.
- A real tailnet: tailscaled's whois of real devices, MagicDNS, `tailscale serve`, and the certificates tailscaled fetches from Let's Encrypt.
- Real model logins. The harness's login is an API key nothing uses, and Sign in with ChatGPT needs a person in a terminal.
- A real Mac. `fresh-mac` is Debian, so `deploy/mac/install` and the CLI ran on Linux.
- Real systemd: the units' sandboxing, their restart policy and the deployer's timer.
- That each probe learns its new peer from the control plane, which only matters once an image is fetched between nodes.

## What it found

Nothing in the installer, the CLI or the services failed on the fresh machines. Two refusals are worth knowing, and both are correct:

- A project's default pylon asks for 6 GiB of memory, so on a machine with less, `nexus start` refuses with `no node can run this pylon`. The test's project asks for 3 GiB.
- A pylon VM needs at least 3 GiB. One of 2 GiB fails its boot job as `invalid`.
