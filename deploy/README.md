# Deploy Nexus on the home-lab nodes

Each node runs a probe, which runs the pylon VMs. One machine, `rj-firebat`, also runs the control plane: the registry, the reconcile loop, the agent harness and the API. Both install from a checkout of this repository, as root, and both scripts are safe to rerun.

Upgrade the control plane before the probes. A probe refuses a spawn from a control plane older than itself and says the control plane needs upgrading, while an older probe still runs projects that clone a repository for an upgraded control plane. A probe from before scratch projects cannot start one, so create scratch projects only after every probe is upgraded. A probe that reports a session its last wake failed to bring back, in no pane, stops a control plane from before session states from storing any observation from that node until the control plane is upgraded too.

CLI 0.11.0 adds `nexus changes <thread> --turn` and `nexus diff <thread> --turn`, also available as Latest turn in the dashboard. Upgrade the control plane to capture these start-of-reply snapshots; no image rebuild is needed. Existing pylons gain a snapshot on their next autonomous turn. Until then, Latest turn reports that no snapshot exists. See [the CLI contract](../docs/cli.md) for the JSON base and failures.

## Install or upgrade a probe

1. Copy a checkout to the node and run `sudo deploy/install-probe.sh` from it.
2. On the first run, edit `/etc/nexus/probe.json` and `/etc/nexus/secrets.env`, then run the script again.

The first run installs both files from `probe.example.json` and `secrets.example.env`, and leaves `nexus-probe.service` stopped until `probe.json` differs from the example. Later runs never overwrite either file. Restart the probe yourself after you edit them: `sudo systemctl restart nexus-probe`.

The probe runs as the system user `nexus`. These are its paths:

| Path | What it holds |
| --- | --- |
| `/etc/nexus/probe.json` | The config. `src/probe/config.ts` parses it. |
| `/etc/nexus/secrets.env` | Secret values, `NAME=value` per line. Mode 0640, owner `root:nexus`. |
| `/var/lib/nexus/pylons` | Pylon instances, their disks and checkpoints. |
| `/var/lib/nexus/artifacts` | Images and templates, one directory per ID, which `backend.artifacts` in `probe.json` names. A `probe.json` from before the store, with a `backend.images` map of `<store>/<image ID>` directories, is read as that store. |
| `/var/lib/nexus/preview-routes.json` | Which pylon each published preview port belongs to. |
| `/opt/nexus/current` | The release the probe runs. |

### GitHub access for a project's agents

A project that grants `GH_TOKEN` to `api.github.com` and `github.com`, as `nexus project add --secret GH_TOKEN:api.github.com,github.com` and the dashboard's GitHub access do, lets its agents create GitHub repositories with `gh` and push to them over HTTPS. This is how a scratch project's work is kept. Add the token to `/etc/nexus/secrets.env` on every node that runs the project's threads, and restart the probe:

```sh
echo 'GH_TOKEN=github_pat_...' | sudo tee -a /etc/nexus/secrets.env
sudo systemctl restart nexus-probe
```

Use a fine-grained personal access token whose repository access is all repositories, because the repositories it pushes to do not exist yet, with two repository permissions: Administration read and write, to create repositories, and Contents read and write, to push. The token never enters a pylon. The pylon's `GH_TOKEN` is a placeholder that Gondolin swaps for the value only in requests to the granted hosts. A pylon whose project grants `GH_TOKEN` fails to boot with `secret-missing` on a node that lacks it. The pylon image ships `gh` as git's credential helper for github.com.

### Previews need the probe to be the tailscale operator

A preview is a `tailscale serve --https=<port>` entry that the probe adds and removes. Only root and the operator user may change serve entries, so the script runs `tailscale set --operator=nexus` on every run. tailscaled has a single operator, so this takes operator rights from any other user on the node. Run `tailscale` commands that change serve or prefs with `sudo` afterwards.

To turn previews on, keep the `previews` block of `probe.json`:

```json
"previews": { "gatewayPort": 7481 }
```

`gatewayPort` is the loopback port that every preview entry proxies to. Keep it fixed, because the probe recognizes its own serve entries by that port. Without the block, the probe publishes no previews, and a spawn that assigns one fails.

With the block, the probe reads the node's MagicDNS name from `tailscale status --json` at startup, and each preview's `PUBLIC_URL` is `https://<that name>:<port>`. The probe refuses to start when the tailnet has MagicDNS turned off.

### Clone over SSH

To let pylons clone and push SSH remotes, add the node's git key to the backend in `probe.json`:

```json
"gitSsh": { "privateKeyFile": "/etc/nexus/git_ed25519", "knownHostsFile": "/etc/nexus/git_known_hosts" }
```

Make the key readable by `nexus` only: `chown nexus:nexus /etc/nexus/git_ed25519 && chmod 0400 /etc/nexus/git_ed25519`. The key never enters a pylon. Without `gitSsh`, the node boots only pylons whose repository and dotfiles URLs are HTTPS.

### Attach goes through the control plane

`nexus attach <thread>` reaches the pylon's Herdr session through the control plane's attach route, and the control plane runs Herdr's client on a pty in the pylon through the node's probe (see `docs/cli.md`). The node needs nothing for it, and nobody needs ssh access to the node. Before CLI 0.9.0, attach ran ssh to the node and a helper, `nexus-attach`, through a sudo rule for the group `nexus-attach`. The script removes the helper, the rule and the group on every run, because a sudo grant would outlive the helper it names.

Upgrade the control plane before the CLI. An older control plane has no attach route, and `nexus attach` says to upgrade it. Any probe works, old or new.

## Install or upgrade the control plane

1. On `rj-firebat`, run `sudo deploy/install-control.sh` from a checkout.
2. On the first run, edit `/etc/nexus/control.json`.
3. Sign the harness in with ChatGPT, as described in the next section.
4. Run the script again. It starts `nexus-control.service`.

The control plane runs as the system user `nexus-control`, apart from the probe's `nexus`, because it holds the model login. These are its paths:

| Path | What it holds |
| --- | --- |
| `/etc/nexus/control.json` | The config. `src/control/main.ts` parses it. |
| `/var/lib/nexus-control/registry.db` | The registry. |
| `/var/lib/nexus-control/harness.sqlite` | The harness: every thread's conversation. |
| `/var/lib/nexus-control/harness-credentials.json` | The harness's model login and installation ID. Mode 0600. |
| `/opt/nexus/control-current` | The release the control plane runs, apart from the probe's link. |

`control.json` names every node's probe, the tailnet nodes that may call the API (`callers`), the common dotfiles layer every new pylon pulls (`dotfiles`), the model new threads start with (`harness.model`), and the https ports previews are allocated from on each node (`previewPorts`, 10200 to 10999 when omitted). A node's `tailnetHost` is its MagicDNS name, such as `infra-testbench.example.ts.net`, because preview URLs name it and its `tailscale serve` certificate is for that name. Each probe's `auth.controlPlane` must be the control plane's own stable node ID, `self.tailnetNodeId`.

### Sign the harness in

The harness has its own ChatGPT login, kept apart from any interactive pi on the machine. A ChatGPT login reaches only the models ChatGPT offers through Codex, such as `gpt-6-astra`, so `harness.model` in `control.json` must name one of them. The control plane refuses to start with any other model, such as `gpt-5.5`, or before the harness is signed in, and its error in `journalctl -u nexus-control` lists the models the login offers. Only one process may hold the credentials file, so stop the control plane first:

```sh
sudo systemctl stop nexus-control
sudo -u nexus-control env PATH=/usr/local/bin:/usr/bin node /opt/nexus/control-current/src/control/login.ts /etc/nexus/control.json
sudo systemctl start nexus-control
```

The login prints a URL to open in your browser. The browser's last step goes to port 1455 on `rj-firebat`, so on your laptop that page fails to load. Paste the address it ended on into the prompt. Alternatively, forward the port first with `ssh -L 1455:127.0.0.1:1455 rj-firebat`.

## Build the pylon image

The image bakes this Mac's Claude Code plugins, skills, pi packages and pi extensions, as `images/pylon/agent-setup/manifest.json` pins them. To refresh them, capture them on the Mac in the nexus checkout, then commit and push the manifest:

```sh
node src/agent-setup.ts --dry-run
node src/agent-setup.ts
git commit -m "chore(image): refresh the pylon agent setup" images/pylon/agent-setup/manifest.json && git push
```

The capture prints what ships and what it leaves out. When something cannot ship, such as a skill not committed and pushed in the dotfiles repo or a plugin older than its marketplace, it writes nothing and says how to fix each problem. `docs/contracts/usage.md` describes it.

Then build on `infra-testbench`, from a checkout at the pushed commit with `npm ci` done:

```sh
git pull && bash images/pylon/build.sh
```

The build needs Docker and KVM, and its Docker step reaches GitHub and npm. When the smoke boot passes, it writes the image to `~/nexus-spikes/images/<image ID>` and prints its manifest, whose `id` is the image ID. A recipe that did not change gives the same ID, and the build returns at once.

## Run a first thread

These steps check a fresh install with the real model. Run them on the control plane's machine, as a caller the API allows: the machine itself, `self.tailnetNodeId`. Set these first:

```sh
IP=<listen.host from control.json>
A="http://$IP:7470/v1"
IMG=<an image ID in the node's /var/lib/nexus/artifacts>
```

1. Sign the harness in, as the previous section describes, then start the control plane with `sudo systemctl start nexus-control`. `journalctl -u nexus-control -n 20` shows `nexus control plane: API on ...` and no `harness` errors.
2. Record the image and make it current. The image's manifest is `image.json` in its directory on the node that holds it, here `infra-testbench`:

   ```sh
   ssh infra-testbench sudo cat /var/lib/nexus/artifacts/$IMG/image.json > image.json
   curl -sS -H content-type:application/json --data @image.json $A/images
   curl -sS -X PUT -H content-type:application/json -d "{\"image\":\"$IMG\"}" $A/images/current
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

Install a separate file containing **only the token**, not `GH_TOKEN=` or shell quotes, owned by `root:nexus-control` with mode 0640. For example, on the node, an administrator can copy the existing single-line value without displaying it or putting it in shell history:

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

Add `"github": { "tokenFile": "/etc/nexus/github-token" }` to `/etc/nexus/control.json`, then restart the control plane during your normal deployment window. Rotation requires replacing the file and restarting. Never put the value in JSON, logs or a pylon. A configured unreadable/empty/malformed file fails startup rather than silently disabling watching. With `github` omitted, watching is off and `nexus show` and the dashboard say so once per detail view.

Discovery watches `origin/` branch outputs for projects with a github.com repository. It does not infer a scratch project's published repository or another remote's identity. Network/authentication failures remain visible as a PR-watch error on the thread detail and are retried. The watcher stops a thread after ten consecutive comment-only wakes; archive/unarchive preserves that stop and all cursors. There is no reset command in this version.
