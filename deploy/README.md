# Deploy Nexus on the home-lab nodes

Each node runs a probe, which runs the pylon VMs. One machine, `rj-firebat`, also runs the control plane: the registry, the reconcile loop, the agent harness and the API. The first install uses a checkout and sudo. After the one-time setup below, `nexus deploy` requests upgrades without sudo or SSH. The manual scripts remain safe to rerun for bootstrapping and recovery.

Upgrade the control plane before the probes. A probe refuses a spawn from a control plane older than itself and says the control plane needs upgrading, while an older probe still runs projects that clone a repository for an upgraded control plane. A probe from before scratch projects cannot start one, so create scratch projects only after every probe is upgraded. A probe that reports a session its last wake failed to bring back, in no pane, stops a control plane from before session states from storing any observation from that node until the control plane is upgraded too.

CLI 0.11.0 adds `nexus changes <thread> --turn` and `nexus diff <thread> --turn`, also available as Latest turn in the dashboard. Upgrade the control plane to capture these start-of-reply snapshots; no image rebuild is needed. Existing pylons gain a snapshot on their next autonomous turn. Until then, Latest turn reports that no snapshot exists. See [the CLI contract](../docs/cli.md) for the JSON base and failures.

## Deploy a merged commit

From an allowed Mac or other tailnet caller with CLI 0.13.0:

```sh
nexus deploy main --wait
nexus deploy <full-40-character-commit> --json
nexus release
nexus release --json
```

`main` is resolved by the control plane to GitHub's current `refs/heads/main`. The registry records the full commit, authenticated caller and request time. Each root deployer independently fetches main and verifies the commit is an ancestor before building it. A requested unmerged commit is recorded but fails at the node without changing the running release. The dashboard's node list shows the desired release and each reported component.

`--wait` waits up to 30 minutes for fresh healthy reports from every configured node's probe and the control node's control plane, tolerating connection failures while control restarts. A rollback or failure ends the wait with the reason. An offline node remains pending; a report older than 90 seconds is stale. Failed commits are quarantined locally rather than retried every poll. Request a different merged commit to fix one. After a drain refusal, the person may clear `/opt/nexus/control-deploy-report.json` while the deployer service is stopped to retry the same commit when idle; a rolled-back install also has a terminal attempt in `control-deploy.json` (or `probe-deploy.json`). Manual recovery is preferable to clearing a rollback without fixing its cause.

### One-time setup, by the person after merge

1. Install the control plane first, then every probe, with the existing sudo scripts below. Use an edited service config, not an example. Each script installs the root `nexus-deployer.service` and its 15-second timer, records its role, and creates `/etc/nexus/deployer.json` **only if absent**. On the control node, run both scripts. No pylon image rebuild or Mac CLI installation is part of this flow.
2. The installer prints the node's stable tailnet ID and a SHA-256 token digest. Add each pair to `deployKeys` in `/etc/nexus/control.json`. The plaintext token remains only in that node's root-owned, mode-0600 `deployer.json`; never put it in a project's secrets or a pylon. The timer refuses access until its digest is configured. If the install was rerun and you missed the printed digest, read it as root with `node --input-type=module -e 'import{readFileSync}from"node:fs";import{createHash}from"node:crypto";console.log(createHash("sha256").update(JSON.parse(readFileSync("/etc/nexus/deployer.json")).token).digest("hex"))'`.
3. Add the allowed Mac/client stable IDs to both `callers` and `deployers` in control.json. `deployers` missing or empty disables release changes. Never list an infrastructure node as a deployer: the API rejects every configured node and `self` even if listed.
4. Verify `controlUrl` and `controlNodeId` in each deployer.json. The installer derives the control name from tailscale and assumes port 7470 on probe-only nodes; edit it for a nondefault port. The URL's hostname must be in the control plane's `listen.hostnames`. The worker verifies the endpoint with tailscaled **before sending its token**. Restart the control plane once after configuring the digest map and deployers. Check `nexus release` for fresh reports from every role.

For example, these additions to control.json grant the laptop release-setting rights and two nodes reporting rights:

```json
"deployers": ["nLaptopCNTRL"],
"deployKeys": {
  "nFirebatCNTRL": "<64-character SHA-256 digest printed on firebat>",
  "nTestbenchCNTRL": "<64-character SHA-256 digest printed on testbench>"
}
```

Node polling goes directly to the control plane, not through a probe. This keeps root credentials out of the probe and reuses the existing mutual tailnet identity check. Node routes additionally require the root-only token, so pylon egress through its host cannot forge health reports or drain control. Node credentials cannot set a release. The in-pylon CLI bridge accepts only its closed operation schema; it cannot forward an arbitrary API route. Tests cover the bridge, a pylon presenting its host's allowed/deployer identity, spoofed forwarding headers, missing node tokens, and the wrong control endpoint. Do not run an unauthenticated proxy on an allowed deployer: tailnet identity authorizes that machine, not individual programs on it.

### Order, drain, rollback and recovery

The pure planner in `src/deploy/plan.ts` upgrades control before probes. A probe rechecks control's fresh healthy report after preparation, before switching links. If readiness is lost or cannot be read, it returns to `waiting-for-control` and retries on the next poll without restarting or quarantining the release. Before upgrading control, its worker acquires a persistent 120-second drain lease, renewing it every 20 seconds during preparation. The API blocks start, send and retry while leased. A shared harness gate also blocks PR-watch submissions, counts submissions already entering, and lets their pending messages retry later. Idle is checked against committed harness live and queue documents, including parked runs, not the asynchronously updated registry activity flag. After the build, a final idle check seals the drain before the link moves: this hold does not expire until the worker reports success or finishes rollback. This prevents recovery after a hung worker from restarting over a turn that entered after lease expiry. Idle is checked again immediately before restart. An unsealed preparation lease expires if the worker dies; the fixed worker clears a sealed hold after recovery. If neither worker can run, the person must recover the service and use the [manual drain escape hatch](#manual-drain-escape-hatch) below.

`drainTimeoutMs` defaults to 300000 (maximum 600000). At the deadline a still-running or queued turn refuses the release, releases the drain and reports failure; it is **not** cut off. The harness resumes after restart, but `src/harness/slice.test.ts` shows that an in-flight tool is interrupted rather than replayed. That is why timeout does not force a restart.

The supervisor serializes both roles and manual installers with one root-owned lock. Git lives in `/opt/nexus/deployer/repo`, not a person's checkout. Build uses `deploy/release.sh`, producing `/opt/nexus/releases/<full commit>` with the dashboard client bundled into it and the whole image recipe, `images/pylon/`, which `nexus image build` reads from the release the control plane runs. Preparing a release already ran `npm ci` on the node, so the node reaches the npm registry as before. It now also installs the dev dependencies, esbuild's platform package among them, builds the client and prunes them, and any of these failing stops the release before it is published. Then the normal role installer performs its upgrade steps in preparation mode: no config or secret replacement, no independent link switch or restart. Control uses `control-current`; probe uses `current`. An atomic transaction records the old link before switching. The worker saves the service unit too, restarts, and requires both an active unit and the local API's `/v1/health` answering with the candidate process's commit. `healthTimeoutMs` defaults to 60000 and is bounded to 1000–60000; HTTP response bodies and service commands have deadlines.

On failure, or recovery of an interrupted transaction, it restores the old link and service unit, restarts, checks the old service's health, and reports `rolled-back` with the journal tail. Failed rollback is reported as `failed`, not success. The on-disk journal uses atomic rename for process-interruption recovery; it is not a filesystem/power-loss guarantee. Database and harness data are not reverted: releases must keep storage migrations backward-compatible with the previous release. Reverting data would discard accepted user work; an incompatible migration can require manual recovery even after the code link is restored.

GitHub reports this repository as **public**. HTTPS fetches need no credentials. Child commands receive a minimal environment with no inherited `GH_TOKEN`, root deployer token, npm config or git user config. If the repository becomes private, do not put credentials in its URL or run builds with GH_TOKEN: fetch-only credential support must be added before automatic upgrades will work.

### Manual drain escape hatch

Run these on the **control node**, as the person, not from a pylon. Clearing a hold allows new turns: never clear it while a deployer could still switch or roll back control. Run each step separately and stop on any error.

1. Stop automatic deployment, including an already-running worker, then inspect the persisted hold. This read works even when the control API is down and does not load or migrate the registry through release code:

   ```sh
   sudo systemctl stop nexus-deployer.timer nexus-deployer.service
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
   for unit in nexus-deployer.timer nexus-deployer.service nexus-control.service; do
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

   From an allowed client, check `nexus release` and normal API access. Leave the deployer timer stopped until the worker is repaired and the desired release is the one you intend to run; then use `sudo systemctl start nexus-deployer.timer`. Clearing a hold does **not** cancel the desired release or remove a failed-commit quarantine. Restarting the timer without addressing the original problem may acquire another hold.

### The deployer upgrading itself

`/opt/nexus/deployer/supervise.sh` and `deployer/bootstrap` are fixed recovery copies, refreshed only by the person's manual installer. Once a release passes service health, its worker must also complete `--check` (load its code and authenticate a read of desired state) before `deployer-current` selects it. Subsequent polls run that candidate worker under a 15-minute deadline. A crash or hang causes the fixed supervisor to reject that worker and immediately run the bootstrap worker, which recovers unfinished transactions before contacting control. The rejected worker is not promoted again; a later healthy commit can supply a fixed worker. The timer runs a single oneshot unit, and the shared lock also protects manual invocations. The systemd unit allows time for both the candidate and fallback.

This does not make arbitrary merged root code safe: merged release code and npm lifecycle scripts are trusted. The fixed supervisor protects against broken workers, not a release deliberately deleting its recovery copy.

The old scripts below remain the bootstrapping and recovery path. Before repairing a deployment manually, stop both `nexus-deployer.timer` and `nexus-deployer.service` (stopping a timer alone does not stop its running service), repair/install from a known-good checkout, then start the timer again. They preserve configs and secrets, and the manual path retains content-hash release directories. The pylon test environment cannot run node systemd, tailscaled or real VM hosts: rollback, polling and supervisor recovery are tested with temporary files, local HTTP/git servers and fake service commands. The actual one-time node installation and service restart must be verified by the person after merge.

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

`control.json` names every node's probe, the tailnet nodes that may call the API (`callers`), the common dotfiles layer every new pylon pulls (`dotfiles`), the model new threads start with (`harness.model`), and the https ports previews are allocated from on each node (`previewPorts`, 10200 to 10999 when omitted). A node's `tailnetHost` is its MagicDNS name, such as `infra-testbench.example.ts.net`, because preview URLs name it and its `tailscale serve` certificate is for that name. Each probe's `auth.controlPlane` must be the control plane's own stable node ID, `self.tailnetNodeId`. `"resumeAfterUsageLimit": true` makes the control plane type a continue into each Claude worker that stopped on its usage limit, three minutes after the limit resets, as [the CLI's usage-limit stops](../docs/cli.md#usage-limit-stops-0210) describe. It is off when omitted.

### HTTPS dashboard

The control plane terminates TLS itself at `https://<full control-node MagicDNS name>:7443/`, on the same tailnet address as `listen.host`. Port 7443 avoids privileged port binding or capabilities for `nexus-control`; preview allocation reserves it. The plain HTTP API on 7470 remains unchanged. There is **no dashboard Serve entry**: neither the installer nor the control plane changes the probe's Serve configuration.

After upgrading control, the person does this **once on the control node**, not from a pylon:

1. Enable MagicDNS and HTTPS certificates in the tailnet. Use a Tailscale version supporting the LocalAPI cert endpoint with `type=pair`, `min_validity` and `TS_PERMIT_CERT_UID` (see source references below).
2. Give the control-plane service user **cert-only** LocalAPI access. Run `sudo systemctl edit tailscaled` and add:

   ```ini
   [Service]
   Environment=TS_PERMIT_CERT_UID=nexus-control
   ```

   Restart tailscaled during a maintenance window: `sudo systemctl restart tailscaled`. This briefly affects tailnet connections. The setting accepts a username or numeric UID and lets that user fetch certificates for names this node can obtain; it grants neither Serve write access nor general operator rights. The probe stays the sole operator (`nexus`). Do not grant either service sudo access and do not transfer operator rights to control.
3. Add `"https": { "hostname": "rj-firebat.example.ts.net" }` to `/etc/nexus/control.json`, using the node's **actual full MagicDNS name**, and include that name in `listen.hostnames`. Keep `listen.host` bound to the control node's tailnet IP. The example enables HTTPS; existing configs opt in explicitly. Ensure TCP 7443 is available and allowed by any tailnet grants and host firewall, then restart control in the normal deployment window. HTTP starts first and stays available even if certificate access is denied, issuance times out or HTTPS cannot bind. HTTPS starts independently once a certificate arrives and its port can bind; there is no automatic redirect to HTTP.
4. Open `https://<full control-node MagicDNS name>:7443/` from a node in `callers`. Enable notifications with the dashboard's permission button; permission belongs to this HTTPS origin, not the old HTTP URL. Verify conversation streaming and terminal attach, and trigger a notification with the dashboard in the background. An unlisted node must receive 403 even if owned by the same Tailscale user. Also publish and withdraw a preview on the control node to verify that the probe still works as an operator without sudo.

After starting HTTP, control fetches the certificate/key pair over tailscaled's Unix socket in the background and refreshes it every 12 hours after a success, requesting at least seven days of remaining validity. Tailscaled handles issuance, its cache and renewal. Nexus validates the hostname, validity dates and key pair before installing a new TLS context without restarting or interrupting existing connections. The private key is held in process memory, not written to Nexus files or logs. Renewal requests have a 60-second deadline and a 128-KiB response limit. Every startup or renewal failure logs its error and retry delay, retaining any previously installed certificate. Attempts are serialized, with exponential backoff from one second to a maximum of 60 seconds between failures; success resets the backoff. HTTPS failures never stop the HTTP API. Persistent failures must be repaired before expiry; after expiry browsers reject new connections rather than bypass TLS validation. Watch `journalctl -u nexus-control` for startup/renewal failures. `GET /v1/health` on HTTP remains 200 and includes `https: { status, error, nextAttemptAt }` alongside the release commit. Status is `disabled` without HTTPS config, `waiting` until HTTPS starts, `ready` after a successful installation, or `degraded` when renewal failed but the previous TLS context remains installed. `error` is the latest failure (cleared on success); `nextAttemptAt` is the next scheduled attempt in epoch milliseconds, or null while fetching/disabled. Health is readable by an admitted tailnet caller, or via the existing same-address local health check. For example, from an allowed client:

```sh
curl -fsS http://rj-firebat:7470/v1/health
```

A healthy HTTP deployment report does not mean HTTPS is ready; check this state when enabling notifications.

Both HTTP and HTTPS authorize the **actual TCP peer** with tailscaled whois. All `X-Forwarded-*` and `Tailscale-User-*` headers are ignored for identity on both listeners. Stable-node-ID `callers`, self, `deployers`, infrastructure-node exclusion and root-token reporting rules are unchanged. WebSocket origins must match the real HTTPS host and port, so preview origins cannot attach. Do not put a proxy in front of either listener: an allowed proxy's identity would be the caller.

#### Why not Serve for the dashboard?

A Unix-socket Serve target requires local-admin rights for **every later write of the whole Serve config**, including the probe's unrelated preview adds and removals. Operator status alone is insufficient. The original private-socket design therefore blocked previews on the control node. A loopback TCP proxy would avoid that rule but let local users forge identity headers. Direct TLS avoids both problems and does not create, sweep or modify any Serve entry. Previews retain their loopback gateway and default 10200–10999 allocation range.

If the earlier, unmerged private-socket version was manually tried, remove `serveSocket` from control.json and have the person remove **only its confirmed dashboard entry** with `sudo tailscale serve --https=443 off` before using this version. Never run `serve reset`, which would also remove previews. No such migration or live check was performed from this pylon.

Source references at the reviewed upstream revision: [certificate endpoint](https://github.com/tailscale/tailscale/blob/b71e0f30a781894c9508d2903e939c5ca1a1361a/ipn/localapi/cert.go), [cert-only user permission](https://github.com/tailscale/tailscale/blob/b71e0f30a781894c9508d2903e939c5ca1a1361a/ipn/ipnserver/server.go) (`CanFetchCerts`), and [Serve local-admin requirement](https://github.com/tailscale/tailscale/blob/b71e0f30a781894c9508d2903e939c5ca1a1361a/ipn/localapi/serve.go). Tests use a fake LocalAPI and locally generated certificates; real tailscaled issuance/renewal, cert-only permission, preview operations and browser notifications cannot be verified from the development pylon and need the person's post-merge checks above.

The CLI, mod, pi-nexus, probes and root deployers keep using `http://<control>:7470`. Tailnet transport is already encrypted; these clients do not need a browser secure context, and retaining their direct path avoids changing endpoint identity checks or depending on certificate provisioning. No CLI contract changes are needed.

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

Then deploy the commit that carries the manifest with `nexus deploy main --wait`, because the control plane builds the recipe of the release it runs. From a Mac in the control plane's `deployers`, with CLI 0.22.0:

```sh
nexus image build --wait
nexus image rollout <image ID> --wait
```

`nexus image build` reads `images/pylon/` from the control plane's release and sends a `build-image` job to the probe on the image build node, `imageBuildNode` in `control.json` (`infra-testbench` when omitted). The probe builds with Docker, smoke-boots the result, and publishes it into its store, `/var/lib/nexus/artifacts`. The control plane then reads the image's manifest from the probe and records it, with the release it came from. The command prints the image ID at once, and `--wait` follows the build until it is recorded, about 8 minutes on `infra-testbench`. A recipe that did not change is the image already recorded, and the command reports it as built at once. A build changes nothing that pylons use.

`nexus image rollout <image>` copies the image to every other online node with a checksum-verified `fetch-artifact` job, and makes it current only once every online node reports holding it, so `--node auto` never meets a current image that a node lacks. A node that cannot fetch it stops the rollout, the error names the node and the probe's reason, and the current image stays as it was. A node that is offline when the rollout begins is skipped, and fetches the image the first time one of its pylons needs it. Copies between the nodes run at about 22 Mbit/s, so a rollout takes minutes. `--wait` follows it like `nexus deploy --wait` and survives a control plane restart.

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

### The review loop and landing

The review loop (`nexus review`) uses the same token file and is off without it. A review that stops at approval only reads, as the PR watch does. A landing (`nexus review --land` or `nexus land`) also merges, with `PUT /repos/<repo>/pulls/<n>/merge`, which needs write access to the repository's contents and pull requests. A classic token with the `repo` scope, as described above, has it. A fine-grained or otherwise read-only token does not, and a landing then holds for the person with GitHub's answer instead of merging. Widening the token is a credential change, which the [merge policy](../docs/merge-policy.md) reserves for the person: install the wider token in `/etc/nexus/github-token` as above and restart the control plane. Merges then appear on GitHub as the token's owner.

Landing a Nexus pull request deploys it, so the caller who asks for the landing must be in `deployers`, as for `nexus deploy`. The control plane then sets the desired release itself, recorded as requested by `nexus review <id>`, and rolls back to the previous desired release if the fleet does not report healthy within 30 minutes, then waits for the rollback to report healthy before saying so. `.nexus/check` runs in a short-lived check thread of the same project, and Nexus's own runs `npm ci`, so a project whose reviews land needs `registry.npmjs.org` among its allowed hosts.

## Git identity and editable projects

Set the optional top-level `gitIdentity` in `control.json` to the person's own commit name and email. There is no separate agent account. For example (placeholder values):

```json
"gitIdentity": { "name": "Example Person", "email": "person@example.com" }
```

The control plane reads this on startup. Every subsequent pylon boot, including an existing thread's checkpoint wake, sets both values globally for `user` after the common dotfiles install. All checkouts and agents inherit them unless they have their own local git overrides. A project's `gitIdentity` overrides the default; `nexus project edit <id> --git-name "Example Person" --git-email person@example.com` sets it, and `--clear-git-identity` returns to inheritance. If neither is configured, Nexus leaves git unchanged, including an old identity on disk. PYLON.md names the configured identity or tells agents not to invent one. Do not put tokens or other secrets in this setting or the guide.

Project edits can also replace logins, hosts and secret grants. To use Claude Code with a long-lived token, provision `CLAUDE_CODE_OAUTH_TOKEN` in the node's protected secrets file, grant it explicitly to `api.anthropic.com`, and include `claude` among the project's logins. See [project edit](../docs/cli.md#project-editing-0140) for replacement-list examples. Existing running and paused pylons retain their original network/grants; archive/unarchive uses the saved boot network and does not update grants. Start a new thread to apply them. `nexus show` warns when grants differ. No deployment or live configuration changes are performed by project editing.
