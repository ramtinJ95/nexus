# Nexus feasibility spikes

Run: 2026-10-22. Target: **infra-testbench only**, user `ramtinj`, Arch Linux, Intel x86-64, KVM. No Firebat access. These are throwaway experiments, not production adapters.

## Summary

| Spike | Verdict | Key evidence | Timings |
|---|---|---|---|
| S1 Debian/glibc image | **PASS with a documented-config workaround** | Debian 12/glibc 2.36; non-root Python, Bash, Node 24, Claude Code and headless Herdr verified. Unmodified default OCI build crashes copying a kernel symlink; `postBuild.copy` of unchanged matching modules avoids it. | Successful build **35.131 s**; cold boot to first exec **3.902 s**; non-root Herdr ready **127 ms**. |
| S2 Claude TLS / checkpoint | **PASS for unauthenticated checks; CA-path caveat** | Curl gets **401** and Claude gets **Not logged in** with/without the requested extra-CA setting. That setting also warns that the CA file is unreadable. Stopped checkpoint and tested interactive SSH shell retained. | Curl **375/329 ms**; Claude **2133/1272 ms** (without/with extra CA). Resume-to-first-exec in shell smoke **5.383 s**. |
| S3 pi-durable → Gondolin tool | **PASS — narrow integration smoke** | Scripted model → built-in `bash` tool → guest `uname` / Alpine release / vm.fs marker → stored `pi.tool-result` → scripted final answer. | Cold boot with cached assets **3.892 s**; harness round **63 ms**; tool entry duration **15 ms**. |
| S6 many preview ports ([S6.md](S6.md)) | **PASS with caveats** | Six `tailscale serve` HTTPS ports (8443 to 40000) coexist through one loopback gateway. The gateway saw the right port in `Host` on 95/95 requests. Removing one entry left the others serving. Serve config restored. | 72 Mac requests, **0 timeouts**, median about **0.14 s**. A host warm-up showed no measurable benefit. S4's hang did not recur. |
| S7 checkpoint move ([S7.md](S7.md)) | **PASS with caveats** | A fresh, login-free checkpoint went Intel to AMD and back, and both markers survived. Moving the assets to another path and running `qemu-img rebase -u` also worked. Streaming copies through the Mac broke twice, so the copy was staged and checked with SHA-256. The user installed QEMU 11.1.1 and Node 26.8.1 on `rj-firebat`. | Resume on AMD **2.365 s**, back on Intel **3.877 s**, after a rebase **2.086 s**. Single observations. |
| S4 tailnet preview | **PASS, with initial transient failure** | Mac SOCKS fetch returned **HTTP/2 200**, valid certificate; guest received `Tailscale-User-*`. Original Serve config restored byte-for-byte. | Final boot **3.590 s**; local ingress ready **4.931 s**; Mac HTTPS **0.399 s**. First probe timed out after **15.005 s**. |

S1/S2 were rerun after the user fixed Docker group membership. No Gondolin patch or host permission change was made by the spike. S2 does not establish authenticated Claude/Remote Control behavior; S3 is not full environment conformance or crash-recovery certification.

## Scope, versions, and reproduction

Local `git init` completed the existing `.git`. No commits or remotes were created. Local scripts live beside this file. Remote scripts, dependencies, logs, assets, and temporary files remain in `~/nexus-spikes`.

Installed packages, pinned by `evidence/package-lock.json`:

- `@earendil-works/gondolin@0.13.0`
- `@earendil-works/pi-durable@1.4.0`
- `@earendil-works/pi-env@1.4.0`
- Transitive `@earendil-works/pi-ai@1.4.0`
- Host Node `v26.8.1`, npm `12.0.2`; install took npm-reported **11 s**.

All remote invocations used this SSH route, never edited SSH config, and never used the Mac work-tailnet CLI:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=15 \
  -o ProxyCommand='nc -X 5 -x localhost:1055 %h %p' infra-testbench
```

Every remote command exported:

```sh
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache"
export PI_SANDBOX_HOME="$HOME/nexus-spikes/state"
export npm_config_cache="$HOME/nexus-spikes/npm-cache"
export TMPDIR="$HOME/nexus-spikes/tmp"
cd "$HOME/nexus-spikes"
```

`TMPDIR` additionally confines Gondolin temporary disks/sockets/build directories. Use the same SSH ProxyCommand for `scp` of these scripts. No sudo, host package installation, k3s/kubectl, existing-container modification, API keys, real model calls, or logins occurred.

Evidence: `evidence/logs/`, `evidence/logs-setup.txt`, and the two `s4-fetch*-output.txt` files. The original inspection log includes installed README/type extracts. npm reported two high-severity advisories and blocked four dependency install scripts; no audit fix or install-script approval was attempted. The tested paths worked despite those blocks.

## S1 — Debian pylon image

**Question:** Can Gondolin's supported OCI builder produce and boot Debian, then support a non-root development user, Node 24+, Claude Code, Python, and headless Herdr?

### Docker access and the new builder failure

The first run failed on Docker socket permissions (cached recheck 1.049 s). After the user's out-of-band group change, a new SOCKS-routed SSH connection verified:

```text
id -nG: ramtinj docker video wheel
docker version --format '{{.Server.Version}}': 29.7.2
IMAGES_BEFORE=18 CONTAINERS_BEFORE=1
```

`s1-rebuild.sh` pulled only `debian:bookworm-slim` and used Gondolin's transient create/export/remove workflow. Export worked, but the build then aborted. `s1-node24-rebuild.sh` downloaded a checksum-verified official Node 24.22.1 tarball **under scratch only**, and reproduced the same failure without changing the host Node installation.

```text
Copying all kernel modules for 6.18.58-0-virt into rootfs
terminate called after throwing an instance of 'std::filesystem::__cxx11::filesystem_error'
  what(): filesystem error: status: Permission denied [/boot/vmlinuz-virt]
```

The Node 26 build failed after **19.658 s**, including OCI pull; Node 24's cached attempt after **8.025 s**. No sudo, library patch, or host permission change was used. Host `cpio`, `lz4`, `mke2fs`, and `debugfs` were already installed.

### Read-only investigation and supported variations

The user authorized a 30-minute investigation and the three additional OCI images below. `s1-investigate.sh`, `s1-cp-repro.mjs`, `s1-cp-isolated.mjs`, and `s1-supported-variants.mjs` preserve the investigation/reproduction. Only documented configuration changes were tried in Gondolin.

| Variation | Result | Attempt duration |
|---|---|---|
| `debian:bookworm-slim`, explicit `oci.platform=linux/amd64` | SIGABRT, `/boot/vmlinuz-virt` | 7.277 s |
| `debian:bookworm`, same explicit platform | Same | 15.779 s |
| `debian:trixie-slim`, same explicit platform | Same | 12.855 s |
| `ubuntu:24.04`, same explicit platform | Same | 13.509 s |
| `debian:bookworm-slim`, `kernelPackage=linux-lts`, `kernelImage=vmlinuz-lts` | SIGABRT, `/boot/vmlinuz-lts` | 41.472 s |

**Root cause, with published 0.13.0 artifact line numbers:**

- `dist/src/alpine/kernel-modules.js:45–50` calls `fs.cpSync(srcDir, dstDir, {recursive: true, dereference: false})` without `verbatimSymlinks`.
- The **Alpine initramfs source** contains `lib/modules/6.18.58-0-virt/vmlinuz -> /boot/vmlinuz-virt`. The extracted Debian rootfs instead has an empty `boot/`, relative `lib -> usr/lib`, and no top-level `vmlinuz*`. This is not a Debian symlink escaping its rootfs.
- Node v24.22.1 `src/node_file.cc:3946–3947` canonicalizes `absolute(src / symlink_target)`; an absolute target discards the source prefix and resolves against the **host** root. The subsequent directory check at `:3954` also follows the target. The error is an uncaught C++ exception from this copy path. Exact throwing syscall was not traced.
- Host `/boot` is root-owned mode **0700**; looking up `/boot/vmlinuz-virt` returns permission denied. Its existence cannot be determined without more privileges, and none were sought.
- The destination remains inside the scratch rootfs (`rootfs/usr/lib/modules`); `rootfs.js:37–91` enforces destination containment. **Observed: host-root metadata lookup. Not established: host-root write.** `strace` is not installed and was not added.
- An isolated Node-only fixture reproduces SIGABRT on both Node versions. Setting `verbatimSymlinks: true` in that standalone fixture succeeds. A second fixture uses a scratch-only mode-000 directory, reproducing the crash without depending on host `/boot`. Neither test changes Gondolin.

The complete analysis, minimal reproduction and **unfiled** upstream issue draft are in [UPSTREAM-ISSUE-DRAFT.md](UPSTREAM-ISSUE-DRAFT.md).

### Successful configuration-only workaround

The documented `postBuild.copy` stage runs at `dist/src/build/alpine.js:71–72`, before module synchronization at `:109`. Its own symlink-preserving traversal can copy the **unchanged, matching Alpine module tree** into `/lib/modules`. The later sync sees the matching version already present and avoids the failing bulk copy.

`s1-module-seed.sh` stages the original `6.18.58-0-virt` module directory, preserving every file and the absolute link text, in `state/kernel-module-seed`. `s1-module-seed.json` uses:

```json
"postBuild": {
  "copy": [{ "src": "state/kernel-module-seed", "dest": "/lib/modules" }]
}
```

No `postBuild.commands`, privileged chroot, library mutation, custom kernel, or image-content patch was used. This input is **kernel-version-coupled**: if the selected Alpine kernel changes, a matching module seed is required. Empty placeholder module directories were not used.

```text
[postBuild.copy] .../state/kernel-module-seed -> /lib/modules
Build complete!
Build ID: 836cdc05-a609-5162-8f18-320834da7d20
BUILD_SECONDS=35.131
DEBIAN_COLD_BOOT_FIRST_EXEC_MS=3902
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
```

The config still uses `distro: alpine` for boot artifacts, a Debian OCI userspace, and a **6144 MiB** rootfs. QEMU/KVM, two vCPUs, and 3 GiB guest RAM were used. The base image is retained at `state/debian-assets`; **do not overwrite it while the checkpoint depends on it**.

### Guest provisioning and non-root verification

`s1-provision.mjs` runs `s1-guest-provision.sh` as **guest root**. `apt-get` installs tools inside the VM only. Official Node 24.22.1 is installed from its checksum-verified tarball. Claude Code is installed from `@anthropic-ai/claude-code` into `/home/user/nexus-spikes/node_modules`, with a `/usr/local/bin/claude` link. Herdr's official `https://herdr.dev/install.sh` installer runs with `HERDR_INSTALL_DIR=/usr/local/bin`; its release download checksum is verified by the installer.

The non-root account has UID/GID 1000, home `/home/user`, shell Bash, and workspace `/home/user/workspace/repo`:

```text
uid=1000(user) gid=1000(user) groups=1000(user)
/home/user/workspace/repo
Python 3.11.2
GNU bash, version 5.2.15(1)-release
v24.22.1
2.1.308 (Claude Code)
herdr 0.9.5
glibc 2.36
```

`s2-check.mjs` then starts `herdr --session nexus-spike server` as `user`, gets `status: running` and compatible protocol 22 in **127 ms**, and stops that server before checkpointing. Its optional `herdr.dev` update request was denied under S2's narrower allowlist; server operation still succeeded.

Provisioning surprises preserved in logs:

- Gondolin's default exec PATH did not include `/usr/local/bin`; the first npm invocation failed until the VM/guest PATH was made explicit.
- The specified `/etc/gondolin/mitm/ca.crt` path is unreadable by non-root through FUSE, despite 0644 mode bits. npm failed with `SELF_SIGNED_CERT_IN_CHAIN`. Using Gondolin's documented readable **`/run/gondolin/ca-certificates.crt`** merged bundle fixed npm without disabling verification. This is not hidden in S2: the exact requested path is still tested there.
- `enableSsh()` needs a real guest `sshd`, not merely `openssh-client`/the sandbox helper. `s2-install-ssh.mjs` installed `openssh-server` inside the guest, then the tested SSH shell worked. The guest's existing policy prevented package installation from auto-starting a service.

Provisioning attempts took 59.017 s (PATH failure), 85.121 s (npm CA failure/retries), and 24.215 s (successful continuation), excluding the later small SSH-server install. Resume-to-first-exec during the S2 multi-command version check was 5.537 s; the dedicated shell-smoke first `id` completed in **5.383 s**.

### Network allowlists

Provisioning allowed the six S2 hosts plus:

| Extra host | Purpose / observation |
|---|---|
| `deb.debian.org` | Debian packages and Debian security repository; observed |
| `security.debian.org` | Allowed as requested, not needed by this image's repository URLs |
| `nodejs.org` | Official Node tarball and SHA-256 manifest; observed |
| `herdr.dev` | Official installer and release manifest; observed |
| `github.com` | Herdr release URL; observed |
| `release-assets.githubusercontent.com` | Herdr release redirect/download; observed |

`registry.npmjs.org` served Claude's npm and platform-native packages. The native installer was not used, so no additional Claude storage host was needed. No wildcard hosts were allowed. Host-side build downloads used Docker Hub for the approved images, Alpine's CDN, and GitHub's libkrunfw assets; they are separate from the VM egress allowlist.

Supported documentation:

- https://earendil-works.github.io/gondolin/custom-images/
- https://github.com/earendil-works/gondolin/blob/main/docs/custom-images.md
- https://herdr.dev/docs/install/

**Verdict: PASS with the documented-copy workaround, not a clean pass for the default OCI build.**

## S2 — Claude Code through TLS interception

**Question:** In the S1 Debian VM, do unauthenticated Anthropic requests traverse Gondolin TLS interception, and does Claude fail on authentication rather than TLS/network, with and without `NODE_EXTRA_CA_CERTS`?

**Ran:** `node s2-check.mjs`, as non-root `user`, with exactly this HTTP allowlist:

```text
api.anthropic.com
claude.ai
claude.com
platform.claude.com
downloads.claude.ai
registry.npmjs.org
```

The script checks for absence of API-key/token environment variables and the Claude credentials file without printing their values. No login or real model call was made.

| Environment | `curl https://api.anthropic.com/v1/models` | `claude -p hi` |
|---|---|---|
| `NODE_EXTRA_CA_CERTS` unset | HTTP 401, exit 0, **375 ms** | `Not logged in · Please run /login`, exit 1, **2133 ms** |
| `NODE_EXTRA_CA_CERTS=/etc/gondolin/mitm/ca.crt` | HTTP 401, exit 0, **329 ms** | Same authentication error, exit 1, **1272 ms**; additionally warns `Ignoring extra certs ... Permission denied` |

Anthropic's response body says `authentication_error` / `x-api-key header is required`, proving the request reached Anthropic rather than merely a local proxy. Curl's successful TLS handshake establishes interception/allowlist/trust for curl. Claude rejects before authenticated inference, so **its auth error alone does not establish authenticated model-call TLS compatibility**.

### Non-root trust caveat

`s2-ca-permissions.mjs` confirmed:

```text
/etc/gondolin/mitm/ca.crt: mode 0644, owner user
sandboxfs /etc/gondolin/mitm fuse.sandboxfs ... user_id=0,group_id=0,default_permissions
MITM_CA_USER_READ_EXIT=1
RUNTIME_CA_USER_READ_EXIT=0
```

The FUSE mount has no `allow_other`; mode bits alone do not grant the non-root user access. The merged runtime bundle `/run/gondolin/ca-certificates.crt` is a readable root-owned regular file. The manual resume shell deliberately uses that bundle for `NODE_EXTRA_CA_CERTS`, never disables certificate verification, and leaves the six-host allowlist unchanged. Authenticated native-Claude and Remote Control still require the user's manual test.

### Stopped checkpoint and exact manual commands

Retained **stopped** disk checkpoint: `~/nexus-spikes/state/s2-debian.qcow2` (853 MiB allocated, 6 GiB virtual). It depends on `~/nexus-spikes/state/debian-assets/rootfs.ext4`; retain the full `debian-assets` directory. Build ID: `836cdc05-a609-5162-8f18-320834da7d20`.

`s2-resume-login.mjs` uses `VmCheckpoint.load(...).resume(...)`, then supported `vm.enableSsh({user: "user", listenHost: "127.0.0.1", listenPort: 0})`. SSH is host-local only, with a temporary identity and scratch-local known-hosts file. It starts an interactive PTY shell as `user` in the workspace. On shell exit, it closes SSH and stops/saves the VM back to the same checkpoint; Gondolin safely collapses checkpoint ancestry to the original base image.

**Tested no-login smoke command, from the Mac:**

```sh
ssh -o BatchMode=yes -o ConnectTimeout=15 \
  -o ProxyCommand='nc -X 5 -x localhost:1055 %h %p' infra-testbench \
  'export XDG_CACHE_HOME=$HOME/nexus-spikes/cache PI_SANDBOX_HOME=$HOME/nexus-spikes/state npm_config_cache=$HOME/nexus-spikes/npm-cache TMPDIR=$HOME/nexus-spikes/tmp; cd ~/nexus-spikes; node s2-resume-login.mjs --smoke'
```

It reached a real interactive Bash prompt over SSH/PTY, verified UID 1000, workspace, Python, Node, Claude version, and a curl 401, then exited and stopped the VM:

```text
RESUME_FIRST_EXEC_MS=5383
SSH_READY_USER=user LISTEN=127.0.0.1:<ephemeral-port>
SHELL_HTTP_STATUS=401
NEXUS_S2_INTERACTIVE_USER_SHELL_OK
S2_RESUME_INTERACTIVE_SHELL_SMOKE_PASS
STOPPED_AND_SAVED=.../state/s2-debian.qcow2
```

**For the user's manual login/Remote Control test, run from an interactive Mac terminal:**

```sh
ssh -t -o BatchMode=yes -o ConnectTimeout=15 \
  -o ProxyCommand='nc -X 5 -x localhost:1055 %h %p' infra-testbench \
  'export XDG_CACHE_HOME=$HOME/nexus-spikes/cache PI_SANDBOX_HOME=$HOME/nexus-spikes/state npm_config_cache=$HOME/nexus-spikes/npm-cache TMPDIR=$HOME/nexus-spikes/tmp; cd ~/nexus-spikes; node s2-resume-login.mjs'
```

Inside the guest's `user` shell:

1. Run `claude` and enter `/login`; the user completes interactive authorization.
2. Exit Claude, then run `claude --remote-control` from the same workspace.
3. If egress is blocked, record the hostname shown by the host-side hook; do not silently broaden policy. No telemetry/feature-flag-disable variable is baked into the manual shell.
4. Exit the shell when finished. The script stops and checkpoints the VM. **After login that checkpoint contains credentials**; protect it and do not publish it as a base image. It already contains normal generated guest SSH host keys.

The same shell path was smoke-tested, but `/login` and `--remote-control` were **not** executed by the spike. Checkpoints restore disk state, not Herdr/Claude processes or RAM.

**Verdict: PASS for the requested unauthenticated probes and resumable shell, with the explicit non-root CA-path limitation.**

## S3 — pi-durable tool execution inside Gondolin

**Question:** Can the durable harness stay on the host while a tool runs inside a Gondolin VM, without a real model?

**Ran:** `timeout 300 node s3-boot.mjs`, then `timeout 150 node s3-harness.mjs`. The latter imports `s3-env.mjs`, explicitly selects QEMU/KVM, and uses only supported `VM.create`, `vm.exec`, and `vm.fs` APIs. Guest networking was not needed for the tool. An empty `createModels()` collection is overridden with a two-turn scripted stream; no provider, credential, or network model client is configured.

The first cold asset-download-plus-boot probe took **13.854 s**. Default guest: Alpine **3.23.7**, kernel **6.18.58-0-virt**; Python **3.12.15** is present. `bash` and `curl` were absent in the default image. The built-in tool named `bash` ran this probe through Gondolin's default shell, not a verified Bash binary.

The adapter writes and reads a guest marker through `vm.fs`. The real pi-durable built-in `bash` tool executes:

```sh
uname -a; cat /etc/os-release; cat marker.txt; printf "guest-stderr\n" >&2
```

**Observed excerpts:**

```text
CACHED_ASSETS_COLD_BOOT_FIRST_EXEC_MS=3892
FAKE_MODEL_RECEIVED_GUEST_TOOL_RESULT=true
SUBMISSION {"conversationId":1,"type":"input","status":"done",...}
"kind": "pi.tool-result"
"toolName": "bash"
"isError": false
"durationMs": 15
Linux (none) 6.18.58-0-virt ... x86_64 Linux
NAME="Alpine Linux"
nexus-marker-via-vm-fs
guest-stderr
HARNESS_TOOL_ROUND_MS=63
S3_PASS
```

The second scripted turn asserts that it received the guest OS and marker. Assertions also verify a completed submission and a committed tool-result entry. Full transcript is in `evidence/logs/s3-harness.txt`.

### Interface shape and pain points

The interface is exported by **`@earendil-works/pi-durable/env`**, not defined by pi-env:

```ts
interface ExecutionEnv extends FileSystem, Shell {}
// FileSystem: id, cwd, path resolution; text/binary reads; line/binary/dir readers;
// write/append/truncate/flush/rename; metadata/listing; watch; temp files/dirs; cleanup.
// listFiles is optional.
exec(command: string | readonly string[], options, chordContext)
  -> Promise<Result<{exitCode: number; spillPath?: string}, ExecutionError>>
// options: cwd, env, inheritEnv, timeout (seconds), onOutput, spill, window.
// onOutput(text, context, {stream: "stdout"|"stderr", skipped?})
```

- Expected failures are **Result values**, with normalized `FileError` / `ExecutionError` codes. Gondolin generally throws and returns its own `ExecResult`; this needs translation.
- Chord cancellation uses `context.abortSignal`; Gondolin takes `signal`. String vs argv execution, timeout cancellation, byte/line spill semantics, UTF-8 decoding, and stream provenance all need deliberate mapping.
- Stable `id` must name the same filesystem namespace across environment instances, independent of `cwd`. This one-instance smoke uses an instance UUID; production must use a stable pylon identity.
- Gondolin `vm.fs` has convenient whole-file and directory operations but does not directly supply the durable interface's opened-handle/range readers, watchers, and all mutation semantics. The minimal adapter explicitly rejects unsupported operations. It buffers spill output and is **not bounded-memory/production-safe** for large commands. No full conformance claim is made.
- `registerEnvConformance(runner, name, withEnv, options?)` and runner-independent `createEnvConformance()` are exported from **`@earendil-works/pi-durable/testing`**. The factory receives a fresh writable environment per case. This spike chose the permitted scripted-Harness route, **not** the conformance suite.
- No bundled fake-model helper was located in the published package surface. The first stub failed because Harness wraps the full Models interface and binds `getAuth`; spreading `createModels()` also failed because its methods live on the prototype. `Object.assign(createModels(), overrides)` worked. Those failed attempts are preserved.
- `pi-env` already ships a Rust remote daemon and `RemoteExecutionEnv` over `Connection`, plus SSH deployment and terminal APIs. Reusing that implementation may avoid reimplementing the large interface, but daemon transport through Gondolin was **not tested** here.
- Storage was `MemoryStorage`. Crash restart, durable disk persistence, parallel tools, arbitrary filesystem semantics, long-output behavior, and abort correctness were not tested.

**Verdict: PASS for the requested no-real-model tool round trip.**

## S4 — preview through Tailscale Serve

**Question:** Can a guest HTTP server be exposed through loopback Gondolin ingress and a tailnet-only HTTPS Serve endpoint, with user identity reaching the guest?

**Ran:** `s4-status.sh`; `node s4-preview.mjs` (bounded); `s4-serve.sh`; Mac `s4-fetch.sh`; one diagnostic retry using Mac `s4-fetch-diagnostic.sh` and host `s4-diagnose.sh`; finally `s4-cleanup.sh`.

The guest runs the requested stdlib server, `python3 -u -m http.server 8080 --bind 127.0.0.1`. `s4-sitecustomize.py` logs only identity/forwarding headers. Gondolin maps `/` to guest port 8080 and listens on **127.0.0.1:18080**, never a public host interface.

**Original Serve status, verbatim:**

```text
No serve config
```

Original JSON was `{}`. The tested command was:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:18080
```

It succeeded without sudo/operator changes:

```text
Available within your tailnet:

https://infra-testbench.example.ts.net:8443/
|-- proxy http://127.0.0.1:18080

Serve started and running in the background.
To disable the proxy, run: tailscale serve --https=8443 off
```

The first header logger imported `http.server`, which `python -m` re-executed; it failed to log headers. That fixture was replaced with a shared `http.client.parse_headers` wrapper, then rerun. This was fixture debugging, not a Gondolin patch.

The first Mac fetch then timed out in TLS after **15.005 s**, HTTP status `000`, with no guest request. Its Serve entry was removed and restoration verified. One bounded retry, including a host-side HTTPS request for diagnosis, succeeded from both places. **Cause of the first TLS timeout is unknown**; do not assume Serve's configuration success means immediate HTTPS readiness.

**Final Mac output:**

```text
SSL certificate verify ok.
HTTP/2 200
server: SimpleHTTP/0.6 Python/3.12.15
nexus-preview-from-gondolin
HTTP_STATUS=200 TOTAL_SECONDS=0.398966
```

Host diagnostic HTTPS: **200 in 0.316993 s**, valid Let's Encrypt certificate. Final VM cold boot to Python exec: **3590 ms**; verified local ingress: **4931 ms**. These are single observations, not benchmarks.

**Headers seen by the guest on the Mac request:**

```text
host: infra-testbench.example.ts.net:8443
tailscale-user-login: <redacted>
tailscale-user-name: <redacted>
tailscale-user-profile-pic: <Google profile image URL; exact value in raw log>
x-forwarded-for: 100.64.0.12, 127.0.0.1
x-forwarded-proto: http
```

All three identity headers reached the guest. The final forwarded scheme was **`http` despite external HTTPS**, so applications needing secure-cookie/redirect/origin semantics must account for this proxy chain. This run did not test header-spoofing resistance or other users' authorization; don't treat a forwarded identity header as authenticated outside a trusted ingress path.

Cleanup ran **only** `tailscale serve --https=8443 off`, never reset. Both text and JSON status were compared with the originals using `diff`, with no differences. The final status remains `No serve config`. Each preview VM was closed and its disposable overlay removed.

**Verdict: PASS**, with an explicit readiness/retry caveat.

## Cleanup and remaining artifacts

The original S3/S4 cleanup remains valid; Serve was not changed during this follow-up. S1/S2 cleanup used `s12-cleanup.mjs` and `s12-final-audit.mjs`, not the first-run `s9-cleanup.mjs`.

```text
IMAGES_BEFORE_AFTER=18/18
CONTAINERS_BEFORE_AFTER=1/1
CREATED_CONTAINERS=12
REMAINING_CREATED_CONTAINERS=0
SCRATCH_QEMU=0
SESSIONS=0
TMP=[]
```

Docker image IDs and container IDs after cleanup exactly match the pre-run inventories, not just their counts. The run's 12 transient container IDs were obtained from Docker events and individually checked with filtered `docker ps -a`; none remained. An initial events-template mistake (`.ID` instead of Docker 29's `.Actor.ID`) was corrected and those events recovered. No existing container was operated on.

All four images pulled under the user's expanded authorization were removed, without force or pruning:

- `docker rmi debian:bookworm-slim`
- `docker rmi debian:bookworm`
- `docker rmi debian:trixie-slim`
- `docker rmi ubuntu:24.04`

All VMs are stopped. Only the **S2 disk checkpoint** remains, with its base assets and matching module-seed input. Failed build directories and copy-reproduction fixtures were deleted. A temporary SSH-key directory left by the failed pre-sshd `enableSsh()` attempt was removed without printing its contents. No stray scratch-owned QEMU process required killing.

`du -sh ~/nexus-spikes`: **3.2G**, left in place:

- `state/`: **1.2G** — stopped checkpoint (853 MiB allocated), base Debian assets, kernel seed, public known-hosts and audit metadata.
- `cache/`: **1.6G** — Gondolin build/package/base-image downloads, including the tested kernel variants; not live VMs.
- `tools/`: **235M** — isolated official Node 24 distribution/archive used during diagnosis.
- `node_modules/`: **160M**.
- `npm-cache/`: **91M**.
- `tmp/`: **empty**.

Evidence: `evidence/logs/s1-*.txt`, `s2-*.txt`, `s12-cleanup.txt`, and `s12-final-audit.txt`. Runtime behavior was tested on the intended testbench VM; local syntax validation is only a supplementary check. No commit, remote, model call, login, or upstream issue filing was performed.

## S5 pi + ChatGPT login (manual)

**Verdict: preparation and unauthenticated shell smoke PASS; manual login and model transport remain untested.** Target: `infra-testbench` only, through the same SOCKS SSH route and scratch-local environment as S1/S2. The existing checkpoint now contains the user's Claude login: no guest credential files were read, printed, copied, or deleted, and `/home/user/.claude` was left untouched. No login or model call was performed.

### Changes and installation

- Added `s5-pi-login.mjs`, reusing S2's resume → `enableSsh({user: 'user'})` → interactive SSH/PTY → stop/checkpoint flow. S2's script is unchanged. The shell starts in `/home/user/workspace/repo` with `/home/user/.local/bin` first on PATH and `NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt`.
- Shared S5 configuration is in `s5-vm-options.mjs`. Its exact HTTP allowlist is `api.anthropic.com`, `claude.ai`, `claude.com`, `platform.claude.com`, `downloads.claude.ai`, `registry.npmjs.org`, `auth.openai.com`, and `chatgpt.com`. There are eight unique hosts: npm's registry was already one of S2's six. No wildcard or internal-IP allowance was added.
- Installed latest pi using `s5-install-pi.mjs` / `s5-guest-install-pi.sh`, with guest execution as UID 1000 `user`: `npm install -g --prefix /home/user/.local @earendil-works/pi-coding-agent@latest`. Result: **pi 1.4.0**, guest **Node v24.22.1**, **npm 11.19.1**, host Gondolin **0.13.0**. No root package installation was used.
- Added an idempotent PATH export to the user's active Bash login profile. A fresh `bash --login`, starting without `.local/bin` in inherited PATH, verified `LOGIN_PI_PATH=/home/user/.local/bin/pi` and `PI_VERSION=1.4.0` as `user`.
- npm added 119 packages in its reported 22 s. It warned about deprecated `node-domexception` and unapproved install scripts for `@google/genai` and `protobufjs`; no scripts were separately approved. Pi's version check passed despite those warnings.
- The installed Gondolin `createHttpHooks` options/types and implementation expose **no dedicated deny callback**. Consequently no `~/nexus-spikes/state/s5-blocked-hosts.log` is created. S2's existing `isIpAllowed` wrapper still reports hostname-only `EGRESS_ALLOW` / `EGRESS_DENY` on host stdout; S5 explicitly announces the missing callback. URLs, headers, and tokens are not logged by these hooks. No denied host was observed during install or smoke.

| Phase | Resume to first exec | Operation | Stop/save | Total |
|---|---:|---:|---:|---:|
| Install | 5.275 s | Install + login-PATH verification 23.651 s | 1.501 s | 30.428 s |
| SSH/PTY smoke | 5.357 s | User shell, versions, unauthenticated curl | 1.604 s | 9.709 s |

### Smoke and stopped-state evidence

Ran `node s5-pi-login.mjs --smoke` on the testbench. Selected output (terminal echo and ephemeral SSH port omitted):

```text
RESUME_FIRST_EXEC_MS=5357
uid=1000(user) gid=1000(user) groups=1000(user)
/home/user/workspace/repo
v24.22.1
11.19.1
PI_VERSION=1.4.0
EGRESS_ALLOW chatgpt.com
CHATGPT_HTTP_STATUS=404
NEXUS_S5_INTERACTIVE_USER_SHELL_OK
S5_RESUME_INTERACTIVE_SHELL_SMOKE_PASS
CHECKPOINT_MS=1604
STOPPED_AND_SAVED=/home/ramtinj/nexus-spikes/state/s2-debian.qcow2
TOTAL_MS=9709
```

The curl probe was `curl --max-time 20 -sS -o /dev/null -w "CHATGPT_HTTP_STATUS=%{http_code}\n" https://chatgpt.com/backend-api/`. HTTP **404** with curl exit 0 proves this endpoint passed the allowlist and TLS verification; it does not prove authenticated Codex inference. The smoke rejects curl failure/HTTP 000 and checks pi's version and the completed-shell marker.

`s5-audit-stopped.mjs` then verified `CHECKPOINT_PRESENT; SCRATCH_QEMU=0; SESSIONS=0` without opening the checkpoint. Final state: **stopped and saved** at `~/nexus-spikes/state/s2-debian.qcow2`, still dependent on the existing Debian base assets. Protect this credential-bearing checkpoint; do not distribute it as a base image.

Evidence: `evidence/logs/s5-install-pi.txt`, `s5-resume-smoke.txt`, and `s5-audit-stopped.txt`. All new JS files passed `node --check`; the guest installer passed `bash -n`. No host package, Docker, SSH configuration, or Tailscale changes were made. No commit was created.

### Exact manual command (from an interactive Mac terminal)

```sh
ssh -t -o BatchMode=yes -o ConnectTimeout=15 \
  -o ProxyCommand='nc -X 5 -x localhost:1055 %h %p' infra-testbench \
  'export XDG_CACHE_HOME=$HOME/nexus-spikes/cache PI_SANDBOX_HOME=$HOME/nexus-spikes/state npm_config_cache=$HOME/nexus-spikes/npm-cache TMPDIR=$HOME/nexus-spikes/tmp; cd ~/nexus-spikes && node s5-pi-login.mjs'
```

Inside the guest, run `pi`, enter `/login`, and choose **OpenAI (ChatGPT Plus/Pro)** (`openai-codex`), then **Device code login (headless)**. Pi offers the verification URL **https://auth.openai.com/codex/device**; this method avoids the browser-login **localhost:1455** callback. Complete authorization yourself in your browser. Exit pi and then the guest shell to stop/save the checkpoint.

Pi's Codex transport defaults to trying **WebSocket**, then falls back to **SSE** on eligible transport failure before streaming starts (not after partial output, on abort, or for every application error). These are client capabilities, not authenticated behavior demonstrated by this smoke. Device authorization and actual Codex transport through Gondolin still require the manual test; do not silently broaden the allowlist if another hostname is denied.

### Manual result (user, 2026-10-22)

**Verdict: PASS.** The user ran `s5-pi-login.mjs`, logged in to pi with a ChatGPT account, and reached a model from inside the pylon.

- The first attempt used pi's browser login. OpenAI redirected the browser on the Mac to the `1455` callback port, which only listens inside the guest, so the page failed with `ERR_CONNECTION_REFUSED`. Pasting the redirect URL into pi, or choosing **Device code login (headless)**, avoids this.
- After login, pi 1.4.0 selected `gpt-5.5` and the first request failed with `403 blocked by policy: api.openai.com`. pi 1.4.0 sends ChatGPT-login traffic to `api.openai.com`, not only to `chatgpt.com`. The model catalog refresh failed for the same reason.
- After adding `api.openai.com` to `s5Hosts` in `s5-vm-options.mjs` and resuming the checkpoint, the model request succeeded with no `EGRESS_DENY` lines.
- The working allowlist for pi with a ChatGPT login is `auth.openai.com`, `chatgpt.com`, and `api.openai.com`.
- Not observed: whether the Codex transport used WebSocket or fell back to SSE.
- The checkpoint at `~/nexus-spikes/state/s2-debian.qcow2` now holds the user's pi ChatGPT credentials in `/home/user/.pi/agent/auth.json`. Treat it as private.
