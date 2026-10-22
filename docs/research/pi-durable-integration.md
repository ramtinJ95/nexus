# pi-durable integration

This note answers how Nexus hosts one pi-durable harness on the control plane and how that harness runs tools inside a thread's pylon. Read [the Nexus design](../design.md) and the S3 section of [`spikes/RESULTS.md`](../../spikes/RESULTS.md) first.

In short:

- The harness runs inside the control-plane process on `rj-firebat`, over one SQLite file that only that process opens.
- Each thread is one ownerless pi-durable conversation. A Nexus document inside the conversation names the thread's pylon.
- Tools run through pi-env's `RemoteExecutionEnv`. Its `Connection` can only spawn a local program, so Nexus gives it a small bridge program that opens a raw pipe on the probe and runs the daemon in the guest.
- The daemon is a static binary, so the image needs no particular glibc. Bake it into the pylon image and pin its version.
- The probe protocol needs three small changes: raw pipes carry stdout only, raw pipes do not count as attached clients, and a lost pipe is an error result rather than an interrupted tool.
- The riskiest unknown was the guest half of the pipe inside Gondolin. Spike S13 settled it on `infra-testbench`: over SSH to the guest, the daemon passed pi-durable's 29 environment conformance cases with the native watcher, so Nexus uses the SSH route.

## Sources

The packages are `@earendil-works/pi-durable@1.4.0`, `@earendil-works/pi-env@1.4.0` and `@earendil-works/pi-ai@1.4.0`, unpacked with `npm pack`. The tarballs contain only `dist/`, so citations point at the published JavaScript and declaration files. A path such as `pi-durable/dist/harness/types.d.ts:566` is relative to the `package/` directory of that tarball. Nexus paths are relative to the repository root.

Numbers in this note are labelled as measured, inferred, or a guess. Measurements come from `spikes/s13-pi-env.mjs` run on the Mac inside the agent sandbox, not on a node.

## Hosting the harness

### One process owns the storage

`Harness.open(storage, options, context)` opens a harness over one storage (`pi-durable/dist/harness/harness.d.ts:16-19`). One process may own a storage at a time, and pi-durable has no cross-process locking (`pi-durable/README.md:790`). The harness therefore lives in exactly one process. Run it inside the control-plane process rather than beside it. Three things need it there:

- The activity facts the planner reads are "known locally" (`src/reconcile.ts:24`).
- The environment factory needs the probe clients the control plane already holds.
- A second process would need its own RPC for submit, abort and the conversation views the dashboard streams.

Use SQLite through `openNodeSqliteStorage(path)` (`pi-durable/dist/storage/sqlite/node.d.ts:7`). It uses Node's built-in `node:sqlite`, so it adds no native dependency. It runs in WAL mode with `synchronous = NORMAL`, so commits survive a process crash, and the newest commit may be lost on a power failure (`pi-durable/README.md:765`). Keep it in its own file, for example `/var/lib/nexus/harness.sqlite`, next to the registry database rather than inside it. A shared file would need one adapter for both the registry and pi-durable, or the two would run separate transaction queues against one database (`pi-durable/README.md:779-781`). The registry has no reason to share a transaction with the transcript.

JSONL storage keeps the whole history in memory (`pi-durable/README.md:766`), so it does not suit a harness that serves every thread.

### A thread is an ownerless conversation

`harness.root()` returns one reserved conversation, so it cannot serve many threads. Create one conversation per thread with `harness.createConversation({ ownership: { kind: "ownerless" }, agent, init })` (`pi-durable/dist/harness/types.d.ts:421-426`, `:743`). A `ConversationId` is a number (`pi-durable/dist/types.d.ts:13-19`), and `Thread.conversationId` in [the data model](../data-model.md) stores it.

The `init` callback runs in the creating commit (`pi-durable/dist/harness/types.d.ts:416-420`). It writes a Nexus document, for example `nexus.thread` with `{ threadId, pylonId }`. The environment factory reads that document to find the pylon, which is the pattern of pi-durable's example 29, "an environment per conversation, looked up from an app document" (`pi-durable/README.md:861`). The `agent` change sets the model and `cwd: "/home/user/workspace/repo"`.

Creating a thread is two writes, the registry row and the conversation. Write the conversation first, then the registry row with its ID. A crash between the two leaves an empty conversation nothing points to, which costs a few rows and is otherwise harmless.

### Turns start, stream, and resume from storage

A message from the dashboard becomes `conversation.submit({ type: "input", content, requestId }, context)` (`pi-durable/dist/harness/types.d.ts:683`). Use a request ID that the dashboard mints per message, such as `msg:<uuid>`. A retried submit with the same ID returns the existing submission instead of a second one (`pi-durable/README.md:129-137`). That makes the dashboard's send button safe to retry. A message to a busy conversation is queued as a follow-up by default. `whenBusy: "steer"` places it after the current tool round instead (`pi-durable/README.md:506-515`).

Streaming to the dashboard comes from committed state. `conversation.watch(context)` delivers the conversation view and the exact Chord operations of each commit (`pi-durable/dist/harness/types.d.ts:719`). The running answer and tool output sit in `docs["pi.live"]`, committed at most every 100 ms (`pi-durable/README.md:502`). A browser that joins late gets the current view, and nothing is replayed (`pi-durable/README.md:500`). `watchEvents()` gives coding-agent style events, but the README marks it experimental, so start with `watch()`.

After a crash, reopen the storage and call `harness.resume()` (`pi-durable/README.md:115-127`). Open moves tasks that were running back to pending (`pi-durable/dist/harness/harness.js:176-178`), and `resume()` starts the scheduler. A tool call that was in flight is not rerun unless the tool is marked `replay: "safe"`. The model gets an `interrupted` error result instead (`pi-durable/README.md:277`, `pi-durable/dist/harness/tool.js:119-131`). The built-in `bash` is not replay-safe, which is what the design relies on. A task cut off five times is parked as `restart_limit` and needs `harness.retryTask(id)` (`pi-durable/README.md:216`), so the dashboard has to show parked tasks.

A Node process keeps the default timers, so Nexus does not need `onWake`. That option exists for hosts that can be evicted, such as Durable Objects (`pi-durable/dist/harness/types.d.ts:587-594`).

### Model access uses Sign in with ChatGPT through pi-ai

The harness takes a pi-ai `Models` (`pi-durable/dist/harness/types.d.ts:554`). The `openai` provider carries a ChatGPT subscription login as its OAuth method (`pi-ai/dist/providers/openai.js:7-19`). Three facts shape how Nexus uses it:

- pi-ai ships only an in-memory credential store (`pi-ai/dist/auth/credential-store.d.ts:2-7`). Nexus writes a file-backed `CredentialStore` with `read`, `list`, `modify` and `delete`, mode 0600, written to a temporary file and renamed. pi-ai refreshes tokens inside `modify`, so the store must serialize writes per provider (`pi-ai/README.md:468`).
- The login needs a stable installation ID from `LoginOptions.getDeviceId` (`pi-ai/dist/auth/types.d.ts:197-210`, `pi-ai/dist/auth/oauth/openai-chatgpt.js:186-192`). Mint a UUID once and keep it beside the credentials.
- The login listens for the browser callback on port 1455 of the machine that runs it (`pi-ai/dist/auth/oauth/openai-chatgpt.js:20`). That machine is `rj-firebat`, not your laptop, so the redirect fails in your browser. The flow also accepts the pasted redirect URL through a `manual_code` prompt (`pi-ai/dist/auth/oauth/openai-chatgpt.js:218-231`). The dashboard shows the `auth_url` notification and a box for the pasted URL. S5 used the same paste path for pi inside a pylon.

Give the harness its own login. Do not point it at `~/.pi/agent/auth.json` of an interactive pi on the same machine, because two processes refreshing one rotating refresh token would lock each other out (inferred from the refresh-in-`modify` contract). This also matches the decision that credentials for pi-durable threads stay on the control plane and never enter a pylon.

### What the control plane passes in

`HarnessOptions` (`pi-durable/dist/harness/types.d.ts:547-602`) gets these values:

- `models`: a `createModels({ credentials })` collection with the `openai` provider.
- `registry`: `CodingTools` from `@earendil-works/pi-durable/tools`, plus a Nexus extension with a pylon section (repository path, preview URLs, how to declare outputs). Keep that section free of environment reads, because the harness also builds an environment for section rendering (`pi-durable/README.md:429`), and a read there would wait for a paused pylon before the first model request.
- `env`: the factory described in the next section.
- `settings`: compaction, retries and `restartLimit`. Settings are read at every use and never stored.
- `onReport`: logs, plus `task_parked` and `task_faulted` reports for the dashboard and for activity.
- `identity`: Nexus attribution instead of pi's.

Per thread, the control plane passes the conversation's creation options and then the user's messages, aborts (`conversation.abort`), and resets.

## Reaching the pylon

### The Connection runs a program, so Nexus supplies a bridge

`Connection` takes a `command`, either an argv or a function that returns one at each start (`pi-env/dist/connection.d.ts:36-45`). At every start it calls that function, then spawns the program with `serve --token <hex>` appended and talks frames over its stdin and stdout (`pi-env/dist/connection.js:192-208`). There is no option for a transport stream. `Connection` has private fields, so another class does not type-check as one.

The program does not have to be the daemon. It only has to carry bytes to a daemon and pass the arguments through. Nexus gives `Connection` a bridge:

1. The `command` function waits until the thread's pylon is running, then returns `[process.execPath, "src/harness/bridge.ts", node, pylonId]`.
2. `Connection` spawns the bridge with `serve --token <hex>` appended.
3. The bridge calls `ProbeClient.stream(pylonId, { pty: null, argv: [daemon, "serve", "--token", hex] })` (`src/protocol.ts:168-198`) and pumps stdin and stdout through the `ByteStream`.

The rest of pi-env works unchanged. The client discards any output before the `PI-ENV <token>` sync line, so a login shell's noise is harmless (`pi-env/docs/protocol.md:8-10`, `pi-env/dist/connection.js:266-282`). Each side pings every 5 seconds, and 30 seconds of silence counts as a lost link (`pi-env/dist/connection.js:223-229`). When the daemon's stdin ends, it kills every process group it started and exits (`pi-env/docs/protocol.md:62-67`).

Spike S13 measured this shape on the Mac. `spikes/s13-bridge.mjs` stood in for the Nexus bridge and pumped bytes through its own process to the macOS daemon:

- Durable's own environment conformance suite passed 29 of 29 cases with the daemon's polling watcher (measured).
- With the native watcher, 4 of the 9 watch cases saw no change events (measured). `NodeExecutionEnv` passed all 9 watch cases in the same sandbox. The cause is not established. The pylon runs the Linux daemon on inotify, so the node run decides this.
- Killing the bridge mid-command failed that `exec` with code `unknown`, "pi-env connection lost", 5 ms later. The killed command's process was gone, and the next request started a new daemon session (measured).
- `exec(["true"])` took a 4.6 ms median through the bridge (measured, local process spawn dominates). This says nothing about Gondolin.
- A bare Node process with `net` and `http` loaded used 54 MB of RSS (measured). One bridge runs per pylon with a live connection, so ten busy pylons cost about half a gigabyte on `rj-firebat` (inferred).

The bridge's memory is the price of not forking pi-env. If it matters, ask upstream for a `ConnectionOptions` transport that accepts a duplex stream. Until then, keep the bridge.

### Keep one Connection per pylon, and a fresh environment per call

The harness calls `env` at each tool call and section rendering, with the conversation's ID and `cwd` (`pi-durable/dist/harness/types.d.ts:541-546`, `:566`, `pi-durable/dist/harness/harness.js:168-174`). It never calls `cleanup()` on the result. A fresh environment object per call is fine, provided equal `id` values mean the same files (`pi-durable/README.md:441`).

The factory reads `nexus.thread`, takes the cached `Connection` for that pylon or creates one, and returns `new RemoteExecutionEnv({ connection, id: "pi-env:<pylonId>", cwd })`. The `Connection` starts lazily on the first request and starts again after a lost link (`pi-env/dist/connection.d.ts:68-72`). It needs no explicit close when the pylon pauses. Close it when the thread is deleted.

### What a lost pipe and a crash look like to the model

A pipe that drops mid-command fails the `exec` with `ExecutionError("unknown", "pi-env connection lost")` (`pi-env/dist/connection.js:244-258`, `pi-env/dist/remote-env.js:819-831`). The built-in `bash` throws that error, which becomes an error result (`pi-durable/dist/tools/bash.js:72-78`). The `interrupted` result only appears when the harness process itself died mid-call. The comment on `StreamEnd` at `src/protocol.ts:173-177` says the opposite and should change.

When the harness process dies, its bridges die with it, the probe's pipes close, and each daemon sees the end of stdin and kills its commands. After restart, the tool call reports `interrupted`. The command is not left running in the guest (inferred from the local S13 run and `pi-env/docs/protocol.md:64-65`).

### Waking a paused pylon for a tool call

A run makes `pi.live.run` present (see the activity section), so the planner wants the pylon running and sends `spawn`. The tool call that needs the pylon waits inside the `Connection`'s `command` function until the probe reports the pylon running. pi-env's own 60-second start timeout starts only after the bridge spawns (`pi-env/dist/connection.js:15`, `:208-216`), so Nexus bounds the wait itself with the spawn job's 5-minute deadline (`src/protocol.ts:55-58`). The first model request usually overlaps most of the 2.4 to 5.4 s resume that S2 and S7 measured.

### The daemon is a static binary, so bake it into the image

pi-env ships `bin/pi-env-linux-x64/pi-env` (2.4 MB) and `bin/pi-env-linux-arm64/pi-env` (2.1 MB). `file` reports the x64 build as a static-pie executable and the arm64 build as statically linked, and neither references a `GLIBC_` symbol version (measured). It therefore runs on the Debian pylon image and on Alpine alike. Both nodes are x86-64, so the image needs only the x64 build. The local Docker test double on an arm64 Mac needs the arm64 build.

pi-env's SSH path uploads the daemon to `~/.pi/mobile/tools/pi-env-<sha256 prefix>` and checks its SHA-256 before every start (`pi-env/dist/ssh.js:315-321`, `:372-388`). Nexus skips SSH deployment and bakes the daemon instead:

- Copy the binary from the control plane's installed `@earendil-works/pi-env` into the image at `/usr/local/libexec/nexus/pi-env`, root-owned and mode 0755.
- Add `piEnv: "1.4.0"` to `ImageRecipe.pins` (`src/images.ts:40-51`) and check `--version` in the smoke boot.
- Start it through a login shell so tool commands see the image's `/etc/profile.d` PATH and `NODE_EXTRA_CA_CERTS`, as pi-env's `loginShell` option does (`pi-env/dist/ssh.js:392-401`): `bash -lc 'exec /usr/local/libexec/nexus/pi-env "$@"' pi-env serve --token <hex>`.

A baked daemon cannot change under a running pylon, needs no write into the guest at boot, and ties the daemon to an image ID the registry already tracks. The cost is that a pylon on an older image keeps its older daemon after the control plane upgrades pi-env. The client only requires protocol 1 (`pi-env/dist/connection.js:231-233`), and newer operations are gated by `hello.features` (`pi-env/docs/protocol.md:71-77`). The bridge should log `hello.version` when it differs from the control plane's package version, so a mismatch is visible.

### Two ways to reach the daemon inside Gondolin

The probe implements `Guest.stream` (`src/backend.ts:46-48`), which the pylon-vm backend does not have yet (`src/pylon-vm-backend.ts:281-303`). Two Gondolin routes exist:

- **SSH through the controller's `shell` action.** The fork's controller already runs `vm.enableSsh` for `user` and returns a ready `ssh -p <port> -i <key> user@127.0.0.1` command (`src/pylon-vm/runtime.ts:254-283`). The probe spawns that command with the daemon as its remote command. stderr arrives on its own pipe by construction. The image already needs `openssh-server` and `sandboxssh` for terminals (`src/backend.ts:156`).
- **`vm.exec` with `stdin: true` and `stdout: "pipe"`.** Gondolin's `ExecProcess` has `write`, `end` and a `stdout` stream with a backpressure window (`node_modules/@earendil-works/gondolin/dist/src/exec.d.ts:40-63`, `:146-164`). It needs no sshd, but the VM object lives in the detached controller, so the controller's `control.sock` would need a new streaming endpoint.

Prefer SSH. It reuses an action that exists, and only the probe changes. S13 runs both so the choice rests on conformance and latency on the node, not on this argument.

The Docker test double implements the same stream with `docker exec -i`.

## Probe and protocol changes

`StreamRequest` already allows `pty: null` for "raw stdio, such as the pi-env daemon" (`src/protocol.ts:168-171`). Three changes make the raw pipe safe for the daemon.

1. **A raw pipe carries stdout only.** `ByteStream` is one byte sequence (`src/protocol.ts:179-184`). If the probe merged stderr into it, any daemon diagnostic written after the sync line would corrupt the frame stream. The pi-env protocol treats stderr as log text only (`pi-env/docs/protocol.md:3-4`). Document on `StreamRequest` that a pipe's stderr goes to the probe's pylon log and never into the stream.
2. **A raw pipe is not an attached client.** `attachedClients` counts open terminal streams as human presence (`src/protocol.ts:134`). The harness keeps a pipe open for as long as the pylon runs, so counting it would keep every pylon awake forever. Count only streams with a `pty`.
3. **A lost pipe is an error result.** Rewrite the `StreamEnd` comment (`src/protocol.ts:173-177`) to say what the section on lost pipes shows.

`ProbeClient.stream` and the probe route `/v1/pylons` are stubs today (`src/protocol.ts:279-280`, `src/probe/server.ts:214`). The harness needs only `stream`, so the pipe does not depend on how terminals frame resize messages.

### Agent activity comes from the conversation's live document

`ActivityFacts` has `agentTurnRunning` and `lastAgentActivityAt` (`src/reconcile.ts:22-27`), and `desiredPhase` keeps a pylon running while either one says so (`src/reconcile.ts:32-40`). The harness supplies both from `pi.live`. Its `run` field is "present exactly while busy" (`pi-durable/dist/harness/live.d.ts:76-80`), and `LiveDoc` is exported from the package root (`pi-durable/dist/index.d.ts:11`).

- At startup, read `harness.snapshot(LiveDoc, conversationId)` for each thread, then subscribe with `harness.watchDoc(LiveDoc, conversationId)` (`pi-durable/dist/session/session.d.ts:86`).
- `agentTurnRunning` is `run !== undefined`, except for a conversation that received a `task_parked` report and has not been retried since. Otherwise a parked run would keep its pylon awake indefinitely.
- `lastAgentActivityAt` is the time of the latest change to that conversation's `pi.live`. The planner takes the later of this value and the probe's `working` sessions.

No probe change is needed for activity.

## Integration plan

### Modules

All new code lives in `src/harness/`, beside the control plane.

- `host.ts` opens storage and the harness, installs the registry, and exposes `startThread(thread)`, `send(threadId, text, requestId, mode)`, `abort(threadId)` and `watch(threadId)`. It is the only importer of pi-durable.
- `pylon-env.ts` holds the `env` factory and the per-pylon `Connection` cache, and waits for a running pylon inside the `command` function.
- `bridge.ts` is a process entry point. It parses `node pylonId serve --token <hex>`, connects with `connectProbe`, opens the raw pipe, and pumps bytes. It exits when either side ends.
- `activity.ts` keeps `Map<threadId, { running, lastActivityAt, parked }>` fed by `LiveDoc` watches and `onReport`, and the tick reads it into `ActivityFacts`.
- `credentials.ts` holds the file-backed `CredentialStore` and the device ID.
- `thread-doc.ts` defines the `nexus.thread` document with `defineDoc` (`pi-durable/README.md:726-746`).

The contracts these modules depend on:

```ts
// pylon-env.ts
export interface PylonLocator {
  /** Resolves once the probe reports the pylon running. Rejects at the deadline. */
  awaitRunning(pylonId: PylonId, deadline: number): Promise<{ node: NodeName }>;
}
export function pylonEnv(locator: PylonLocator): NonNullable<HarnessOptions["env"]>;

// activity.ts
export interface HarnessActivity {
  facts(threadId: string): Pick<ActivityFacts, "agentTurnRunning" | "lastAgentActivityAt">;
}
```

### Order

Each step ends in a check that runs without a node, except the last.

1. Edit the three protocol comments and the `attachedClients` rule. Tests in `src/reconcile.test.ts` stay green.
2. Implement the probe's stream route and `Guest.stream` for the Docker backend with `docker exec -i`. Bake the arm64 or x64 daemon into the test image. The check is a probe test that runs `printf` through a raw pipe and gets stdout with no stderr bytes.
3. Implement `bridge.ts` and `pylon-env.ts`. Extend `src/slice.test.ts` to run Durable's env conformance suite against `RemoteExecutionEnv` through the probe and the Docker backend.
4. Implement `host.ts`, `thread-doc.ts` and `activity.ts`. Add a slice test with a scripted model, following S3's `Object.assign(createModels(), overrides)` fixture: submit, run `bash` in the container, assert the tool result entry, then kill and reopen the harness mid-tool and assert the `interrupted` result.
5. Implement `credentials.ts` and the dashboard login flow. Check it by hand once on `rj-firebat`, because it needs a real ChatGPT account.
6. Implement `Guest.stream` for pylon-vm over the `shell` action's SSH, the route S13 confirmed. Bake the daemon into the pylon image.

## The riskiest unknown and spike S13

Everything above the guest is ordinary Node code that runs against Docker. The part no test has touched is the daemon inside a Gondolin guest: its native watcher on the guest's file systems, its frames through Gondolin's SSH forwarder or exec channel, and the cost of each round trip. S3 used a minimal adapter over `vm.exec` and `vm.fs` and did not test the daemon (`spikes/RESULTS.md:309`).

`spikes/s13-pi-env.mjs` settles it. It resumes the S2 Debian checkpoint, copies the packaged linux-x64 daemon into the guest and checks its SHA-256, then runs one transport:

- `gondolin-exec` puts the daemon on `vm.exec` stdio behind a Unix-socket bridge, which has the same process shape as the Nexus bridge.
- `gondolin-ssh` uses `ssh` to the `vm.enableSsh` port as the `Connection` command.

In each mode it runs the 29 conformance cases, times 200 `exec(["true"])` calls, 200 `fileInfo` calls, and 8 MiB writes and reads, then cuts the stream under a running `sleep` and checks that the command died and the next request reconnects. It closes the VM without a checkpoint, because `state/s2-debian.qcow2` holds the user's pi ChatGPT login (`spikes/RESULTS.md:480`).

Run it from the Mac through Astra, because the sandbox cannot reach the node:

```sh
P='ProxyCommand=nc -X 5 -x localhost:1055 %h %p'
scp -o "$P" spikes/s13-pi-env.mjs spikes/s13-bridge.mjs infra-testbench:nexus-spikes/
ssh -o BatchMode=yes -o ConnectTimeout=15 -o "$P" infra-testbench '
  export XDG_CACHE_HOME=$HOME/nexus-spikes/cache PI_SANDBOX_HOME=$HOME/nexus-spikes/state \
    npm_config_cache=$HOME/nexus-spikes/npm-cache TMPDIR=$HOME/nexus-spikes/tmp
  cd ~/nexus-spikes && mkdir -p tmp
  stat -c "%y %s" state/s2-debian.qcow2
  for m in gondolin-ssh gondolin-exec; do node s13-pi-env.mjs $m > tmp/s13-$m.txt 2>&1; tail -12 tmp/s13-$m.txt; done
  stat -c "%y %s" state/s2-debian.qcow2'
```

The expected result for each mode:

- `GUEST_DAEMON_SHA256=46dde0e25b5cf1a327a10ddcb25f746f85b783492f5b225dfaa1a0d84cf5b56a`, which is the packaged x64 binary.
- `HELLO_MS` under a second, with `os=linux arch=x86_64 version=1.4.0 features=["listFiles"]`.
- `CONFORMANCE passed=29/29` with the native watcher. If watch cases fail, rerun with `S13_WATCH_MODE=polling` to separate inotify from transport.
- `LOST_RESULT ok=false code=unknown`, `CUT_COMMAND=gone`, `SESSION_AFTER=2`, then `S13_PASS`.
- The two `stat` lines are identical, so the checkpoint was not rewritten. That is the assumption behind closing without a checkpoint, and this check verifies it.

Use these results to decide:

- If `gondolin-ssh` passes, implement step 6 over SSH.
- If SSH fails conformance or its `EXEC_TRUE` median is more than double the exec route's, use `vm.exec` and add the streaming endpoint to the controller.
- If both fail the same watch cases, the guest file system lacks inotify coverage. Configure `RemoteExecutionEnv` with `watch: { mode: "polling" }` and record that in the design.

### S13 result on infra-testbench

S13 ran on 2026-10-22 against a copy of the S2 checkpoint, so the original disk and its login were never resumed. The original's size, time and SHA-256 were identical before and after.

The `gondolin-ssh` mode passed (measured):

- The guest daemon's SHA-256 matched the packaged x64 binary, and `hello` arrived in 281 ms with `os=linux arch=x86_64 version=1.4.0`.
- The conformance suite passed 29 of 29 with the native watcher, so inotify works on the guest's file systems and no polling fallback is needed.
- `exec(["true"])` had a median of 5.6 ms and a p95 of 6.0 ms over 200 calls. `fileInfo` had a median of 2.4 ms.
- An 8 MiB write took a median of 273 ms and an 8 MiB read 258 ms, about 30 MiB/s through the SSH forwarder.
- Cutting the stream under a running `sleep` failed that call with "pi-env connection lost" 34 ms later. The guest command was gone, and the next request opened a second daemon session.

The `gondolin-exec` mode failed before `hello`. The guest command exited 127, which means a command was not found. The likely cause is that the spike's exec passes a `PATH` without `/usr/sbin`, where Debian keeps `runuser`. That is inferred and not checked. It does not change the decision, because the SSH route needs no controller change and its numbers are well inside what a tool call can afford.

Nexus therefore implements step 6 over SSH, and the exec route stays unexplored.

## Open questions

- **The bridge's memory.** About 54 MB per busy pylon (measured for a bare Node process on the Mac). It is acceptable at the planned scale. A `socat` relay or an upstream transport option would remove it.
- **Waits that ignore abort.** A tool call waiting for a pylon to wake waits inside `Connection`'s start, which the call's abort signal does not reach. An Esc during a wake therefore takes effect only once the pylon runs or the 5-minute deadline passes.
- **Parked runs.** The rule above treats a parked run as idle. A human then sees a thread whose run is stuck. The dashboard needs a retry button that calls `retryTask`.
- **pi-durable is experimental.** The README says its API changes without notice (`pi-durable/README.md:3`). Pin exact versions of pi-durable, pi-env, pi-ai and chord together, and pin the daemon in the image to the same pi-env version.
