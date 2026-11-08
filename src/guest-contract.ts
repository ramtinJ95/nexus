/**
 * How the probe and the control plane drive the pylon guest: the `services` actions and log limit, the user every
 * command runs as, the call timeout, and how a command reaches Herdr. It imports nothing, so every side reads this one
 * copy. The guest's layout and the in-pylon API, which the image defines, are in images/pylon/nexus-contract.ts.
 */

export const servicesActions = ["ensure", "list", "restart", "stop"] as const;
/** The fork returns at most this many lines of a service's log. */
export const maxServiceLogLines = 500;

/** How long one ordinary guest exec may take. */
export const callTimeoutMs = 10_000;

/** The argv that runs `script` in a login shell as user. */
export const asUser = (script: string): readonly string[] => ["runuser", "-l", "user", "-c", script];

/**
 * Runs `body` on "$f", the Claude Code session $0's transcript under whichever project in $1 holds it, whatever slug
 * Claude gave the cwd. Exits `none` when no project does.
 */
export const onClaudeTranscript = (body: string, none: number) => `for f in "$1"/*/"$0".jsonl; do [ -e "$f" ] || continue; ${body}; exit 0; done; exit ${none}`;

/** The named Herdr session every pane of a pylon runs in, and every terminal attaches to. */
export const herdrSession = "nexus";
/** The whole command line of each attached client, which the probe counts as presence and a human runs to attach. */
export const herdrClient = `herdr --session ${herdrSession}`;
export const herdrServerStartMs = 5_000;
/** A Herdr pane's ID, such as w1:p1. */
export const herdrPanePattern = /^w[0-9]{1,9}:p[0-9]{1,9}$/;

/**
 * setsid detaches the server from the exec, and the redirects let the exec return without waiting on its output.
 * In an image built before rootfs-init-extra.sh made tini PID 1, PID 1 is Gondolin's sandboxd, which never
 * reaps the orphans it adopts, so an agent whose pane shell exits first would stay a zombie. tini -s is the
 * subreaper for everything under Herdr there. It is unconditional because the base image guarantees /usr/bin/tini.
 */
export const startHerdrServer = `setsid -f tini -s -- ${herdrClient} server </dev/null >/dev/null 2>&1`;

/**
 * The shell command that focuses the pane its first argument names, and exits 1 when no such pane is open. Herdr's
 * focus is the server's, so every attached client shows the pane. A pane Herdr runs no agent in is focused by its tab.
 */
export const focusScript = `${herdrClient} agent focus "$1" >/dev/null 2>&1 || { tab=$(${herdrClient} pane get "$1" 2>/dev/null | sed -n 's/.*"tab_id":"\\([^"]*\\)".*/\\1/p'); [ -n "$tab" ] && ${herdrClient} tab focus "$tab" >/dev/null 2>&1; }`;

/**
 * The shell command a human's terminal runs in the pylon to attach to its Herdr session. With no server yet, it
 * starts one as a session open does, so the server outlives the terminal and runs under tini, and waits for it.
 *
 * Its first argument, when not empty, is the pane the terminal lands in, such as a Claude worker's, which it focuses
 * as focusScript does. A pane that has closed focuses nothing, and the terminal lands where Herdr was.
 */
export const attachScript = `${herdrClient} workspace list >/dev/null 2>&1 || { ${startHerdrServer}; i=0; until ${herdrClient} workspace list >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt ${herdrServerStartMs / 100} ] || break; sleep 0.1; done; }; [ -z "$1" ] || { ${focusScript}; }; exec ${herdrClient}`;
