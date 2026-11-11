/**
 * How the probe and the control plane drive the pylon guest: the `services` actions and log limit, the exec output
 * cap, the user every command runs as, the call timeout, and how a command reaches Herdr Core. It imports nothing, so
 * every side reads this one copy. The guest's layout and the in-pylon API, which the image defines, are in
 * images/pylon/nexus-contract.ts.
 */

export const servicesActions = ["ensure", "list", "restart", "stop"] as const;
/** The fork returns at most this many lines of a service's log. */
export const maxServiceLogLines = 500;

/** The fork keeps at most this much of a guest exec's output, and reports `truncated` past it. */
export const execOutputMaxBytes = 64 * 1024;

/** How long one ordinary guest exec may take. */
export const callTimeoutMs = 10_000;

/** The argv that runs `script` in a login shell as user. */
export const asUser = (script: string): readonly string[] => ["runuser", "-l", "user", "-c", script];

/**
 * Runs `body` on "$f", the Claude Code session $0's transcript under whichever project in $1 holds it, whatever slug
 * Claude gave the cwd. Exits `none` when no project does.
 */
export const onClaudeTranscript = (body: string, none: number) => `for f in "$1"/*/"$0".jsonl; do [ -e "$f" ] || continue; ${body}; exit 0; done; exit ${none}`;

/**
 * Sets $s to the socket of the user's Herdr Core, which the core keeps in its state folder's core.lock, and exits 0
 * while a process listens on a socket `match` accepts, from the kernel's table of Unix sockets. `connect` follows the
 * same HC_SESSION, so it reaches that core and no other of the user's.
 */
const listensAt = (match: string) => `{ s=$(cat "\${XDG_STATE_HOME:-$HOME/.local/state}/herdr-core/\${HC_SESSION:-default}/core.lock" 2>/dev/null); awk -v s="$s" '$4=="00010000"&&${match}{f=1}END{exit !f}' /proc/net/unix; }`;
/**
 * Exits 0 while the user's Herdr Core runs. It checks that the core listens, because every Core command, a read
 * included, starts a core when none does (spikes/herdr-core/README.md, core-autostart).
 */
export const coreRunning = listensAt("$NF==s");
/**
 * Exits 0 while the holder of the core's programs listens. A core that crashed leaves its holder and every program
 * in it running, and the next core takes them back, live at their addresses (spikes/herdr-core/README.md, core-crash).
 */
export const coreHeld = listensAt('index($NF,substr(s,1,length(s)-5)".holder.")==1');
export const coreStartMs = 5_000;
/**
 * setsid detaches the core from the exec, and the redirects let the exec return without waiting on its output. In an
 * image built before rootfs-init-extra.sh made tini PID 1, PID 1 is Gondolin's sandboxd, which never reaps the orphans
 * it adopts, so an agent whose terminal ends first would stay a zombie. tini -s is the subreaper for everything under
 * the core there. It is unconditional because the base image guarantees /usr/bin/tini.
 */
export const startCore = "setsid -f tini -s -- herdr-core serve </dev/null >/dev/null 2>&1";
/**
 * Starts the core unless one runs, and waits until it does. Its status says whether a core runs. Every boot runs it,
 * so the core gets the login environment rather than that of whatever reaches it first, such as a Claude whose
 * session variables would pass to every terminal.
 */
export const ensureCore = `{ up() ${coreRunning}; up || { ${startCore}; i=${coreStartMs / 100}; while [ $((i-=1)) -gt 0 ] && ! up; do sleep 0.1; done; up; }; }`;

/** A Core terminal's address on its own machine, such as t7. */
export const terminalPattern = /^t[0-9a-z]{1,12}$/;
/** What a person runs in a shell in the pylon to attach: Core's picker of the pylon's terminals. */
export const coreAttach = "hc";
/**
 * The whole command line of a terminal viewing the core, which the probe counts as a human's presence: Core's picker
 * or an attach to one terminal, whether named herdr-core or hc. The core itself, a held terminal, and `connect` and
 * `events`, as an app or the probe runs them, are not people.
 */
export const coreViewer = "([^ ]*/)?(herdr-core|hc)( attach( .*)?)?";

/**
 * Prints the terminal of this machine to attach to, from a `terminal.list` reply, which lists live ones: `$1` when
 * listed, else the first a Nexus session runs in, else the first. It prints nothing when none is listed, and fails
 * when the reply cannot be read.
 */
const attachTarget = `jq -rn --arg t "$1" 'input|[.result.terminals[]|select(.address|test("/")|not)]|(map(select(.address==$t))+map(select(.parent==null and .labels."nexus.harness"))+.)[0].address//empty'`;
/**
 * The shell command a human's terminal runs in the pylon to attach to its core, which it starts first as a boot does
 * when none runs, and fails without. Its first argument, when not empty, is the terminal it attaches to, such as a
 * Claude worker's. When that one is not live, as after a wake moved its session, or none is named, it attaches to a
 * session Nexus opened, or else any live terminal. Core's picker opens only when no terminal is live. Its Enter starts
 * a new shell, since its first entry is "new", so the picker starts in the home folder, where that shell opens.
 */
export const attachScript = `${ensureCore} || { echo 'nexus attach: Herdr Core did not start' >&2; exit 1; }; `
  + `t=$(echo '{"id":1,"method":"terminal.list"}' | herdr-core connect | grep '^{' | ${attachTarget}) `
  + `|| echo 'nexus attach: no terminal list, so the picker opens' >&2; `
  + `[ -n "$t" ] && exec herdr-core attach "$t"; cd && exec herdr-core`;
