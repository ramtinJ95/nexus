/** Renders a conversation's runs and blocks, the state bar, the composer and a Claude worker's questions. */
import type { LiveState } from "@earendil-works/pi-durable";
import type { ThreadDetail } from "../wire.ts";
import type { Thread, ThreadAgent } from "../registry.ts";
import type { ClaudeConversation } from "../../claude-transcript.ts";
import type { AgentView } from "../conversation-view.ts";
import { clock } from "./elapsed.ts";
import { Html, html, dot, icon, unseen, limitText, ago, grows, type Tone } from "./view.ts";
import { prose } from "./markdown.ts";
import { promptLabel, type Item, type ToolItem, type AskItem, type UserItem } from "./items.ts";
import { shotsView, stepsView } from "./tools.ts";

/**
 * What the agent's run is doing. Busy comes from the view rather than agentTurnRunning, which a parked run
 * reports as false, so a stuck run can still be aborted. A parked run is stuck, not working. A Claude worker works
 * while a turn of its session runs, which Interrupt stops as Esc does. An agent waits on the person while a question it
 * asked is open, a Claude worker's dialog waits in its terminal, or a usage limit stopped it. A dialog stops the turn
 * it is in, so it outranks working. A question that does not stop the run, as a planning thread's proposal, does not.
 */
type Run =
  | { kind: "idle"; paused: boolean; repliedAt: number | null }
  | { kind: "working"; since: number | null; tools: number; claude: boolean }
  | { kind: "waiting"; why: string; inTerminal: boolean }
  | { kind: "parked"; tasks: number; busy: boolean };
export function runOf(d: ThreadDetail, view: AgentView | null, items: readonly Item[], now: number): Run {
  const claude = view?.kind === "claude";
  const busy = claude ? view.view.working : (view?.view.docs["pi.live"] as LiveState | undefined)?.run !== undefined;
  const parked = d.agent?.parkedTasks ?? 0;
  if (parked > 0) return { kind: "parked", tasks: parked, busy };
  const open = (d.questions ?? []).filter((q) => q.answer === null);
  // Attention ranks a reply above a wait, so the session's own state says whether a dialog waits in the terminal.
  const terminal = d.thread.sessionWaiting === true;
  if (terminal || open.some((q) => q.ask !== undefined) || (!busy && (open.length > 0 || d.thread.usageLimit !== undefined))) {
    const why = terminal ? `${d.thread.sessionWaitingMessage ?? "It waits for input"}, in the pylon's terminal.`
      : open.length > 0 ? `${open.length === 1 ? "A question waits" : `${open.length} questions wait`} for your answer, above.`
      : `${limitText(d.thread, now)}.`;
    return { kind: "waiting", why, inTerminal: terminal };
  }
  if (!busy) return { kind: "idle", paused: d.pylon.actualState === "paused", repliedAt: d.lastReplyAt };
  return working(d, items, claude ? (item) => item.from !== "command" && item.from !== "other" : () => true, claude);
}

/** A turn's calls are those after the message it answers. Its start is the registry's, so the bar and the rows agree. */
function working(d: ThreadDetail, items: readonly Item[], asks: (item: UserItem) => boolean, claude: boolean): Run {
  const turn = items.slice(items.findLastIndex((item) => item.kind === "user" && item.queued === null && asks(item)) + 1);
  return { kind: "working", since: d.thread.workingSince ?? null, tools: turn.filter((item) => item.kind === "tool").length, claude };
}

/**
 * The agent's state, always in view above the composer, beside the `nexus attach` line to copy. A thread that can
 * attach has a terminal one click away, which a dialog waiting in the terminal offers too.
 */
export function stateBar(t: Thread, run: Run, now: number): Html {
  const open = t.status === "active" || t.status === "idle";
  const abort = html`<button type="button" class="btn btn-xs btn-abort" id="abort" data-action="abort" data-thread="${t.id}">Abort</button>`;
  // The abort route presses Esc in a Claude worker's pane, as a person at its terminal interrupts a turn.
  const interrupt = html`<button type="button" class="btn btn-xs btn-abort" id="abort" data-action="abort" data-thread="${t.id}" title="Presses Esc in Claude's terminal">Interrupt</button>`;
  const terminal = html`<button type="button" class="btn btn-xs" data-terminal>${icon("terminal")}Open terminal</button>`;
  const attach = open && html`<span class="attach-line"><code id="attach-line">nexus attach ${t.id}</code><button type="button" class="btn btn-xs btn-ghost" data-copy="attach-line" aria-label="Copy nexus attach ${t.id}">Copy</button></span>`;
  const [label, detail, end] = (() => {
    switch (run.kind) {
      case "idle": return [html`Idle`, html`${run.repliedAt !== null && html`replied ${ago(run.repliedAt, now)}`}${run.paused && html`${run.repliedAt !== null && " · "}the pylon is paused, and a message wakes it`}`, html``];
      case "working": return [html`${run.claude ? "Claude is working" : "Working"}`, html`${run.since !== null && html`<time data-since="${run.since}">${clock(now - run.since)}</time> · `}${run.tools} ${run.tools === 1 ? "tool" : "tools"} this turn`, run.claude ? interrupt : abort];
      case "waiting": return [html`Waiting for you`, html`${run.why}`, open && run.inTerminal && terminal];
      case "parked": return [html`Stuck`, html`${run.tasks} ${run.tasks === 1 ? "task" : "tasks"} hit the restart limit and hold the run. ${t.status === "archived" ? "Unarchive the thread to retry them." : "Retry runs them again."}`, html`${t.status !== "archived" && html`<button type="button" class="btn btn-xs" id="retry" data-action="retry" data-thread="${t.id}">Retry</button>`}${run.busy && abort}`];
    }
  })();
  return html`<div class="state-bar state-${run.kind}" id="agent-state" data-state="${run.kind}" role="status">${run.kind === "working" ? html`<span class="spin" aria-hidden="true"></span>` : dot(runTone[run.kind])}<span class="state-label">${label}</span><span class="state-detail">${detail}</span>${end}${attach}</div>`;
}
const runTone: Record<Run["kind"], Tone> = { idle: "idle", working: "work", waiting: "busy", parked: "bad" };

/**
 * What the composer's buttons send in each state of the run, the same for both agents: ⌘↵ sends, or steers a run
 * that works, and ⌥↵ queues a message after the run. A Claude worker takes a message at its next step whatever the
 * mode, so only a Nexus agent's run can be queued after.
 */
function sends(run: Run, claude: boolean): { primary: "send" | "steer"; queue: boolean } {
  const steers = run.kind === "working";
  return { primary: steers ? "steer" : "send", queue: steers && !claude };
}
const sendLooks = {
  send: { mode: "followUp", label: "Send", placeholder: "Message the agent…", hint: null },
  steer: { mode: "steer", label: "Steer", placeholder: "Steer the run…", hint: "Steer joins the run after its current tool round." },
} as const;

/**
 * Why a thread takes no messages, or the prompt box. A Claude worker's box is marked for client.js, which tries a
 * send again while the pylon wakes, and says how old the transcript is while the pylon does not run.
 */
export function composer(d: ThreadDetail, agent: ThreadAgent["kind"], run: Run, model: string | null, claude: ClaudeConversation | null, now: number): Html {
  const { thread: t } = d;
  if (t.status === "deleted" || (agent !== "harness" && claude === null)) return html``;
  const asOf = claude === null || d.pylon.actualState === "running" ? null
    : claude.readAt === null ? html`The pylon is not running, and Claude's transcript has not been read yet.`
    : html`The pylon is not running, so the transcript is as of its last read, ${ago(claude.readAt, now)}.`;
  // Only the planner giving up holds the pylon until a human acts. A pylon the probe reports broken may still be paused and resumed.
  if (d.pylon.failed !== null) {
    const refused = d.pylon.retryRefused !== null;
    return html`<div class="note-box failed-box" role="alert"><p>The planner gave up on this thread's pylon, so its agent cannot run tools and the thread takes no messages. ${refused
      ? `${d.pylon.retryRefused}.`
      : "Fix the cause, such as the project's git access, and retry, or start again from the same project. A retry runs setup again on a new pylon whose setup failed, and resumes a broken pylon from its newest disk."}</p>
<pre class="diag">${d.pylon.failed}</pre>
<div class="failed-actions">${!refused && html`<button type="button" class="btn" id="retry-pylon" data-action="retry-pylon" data-thread="${t.id}">Retry</button>`}<button type="button" class="btn" data-start="${t.project}" data-title="${t.title}">Start again</button></div></div>`;
  }
  if (t.status === "archived") return html`<p class="note-box">An archived thread takes no messages, because its pylon stays paused. Unarchive the thread to send one.${asOf !== null && html` ${asOf}`}</p>`;
  const { primary, queue } = sends(run, claude !== null);
  const look = sendLooks[primary];
  const placeholder = claude !== null && primary === "send" ? "Message Claude…" : look.placeholder;
  const hint = claude !== null && primary === "steer" ? "Claude takes it at its next step." : look.hint;
  return html`<form id="prompt" class="composer composer-${primary}" data-thread="${t.id}"${claude !== null && " data-claude"}>
${asOf !== null && html`<p class="comp-note">${asOf} Sending a message wakes it and resumes Claude.</p>`}
<div class="comp-box">
<textarea id="prompt-text" name="text" rows="2" required aria-label="${claude === null ? "Message the agent" : "Message Claude"}" placeholder="${placeholder}"></textarea>
<div class="comp-foot">${model !== null && html`<span class="chip chip-model">${model}</span>`}${hint !== null && html`<span class="dim small comp-hint">${hint}</span>`}<span class="comp-sends">${queue && html`<button type="submit" class="btn btn-ghost send-alt" id="queue" name="mode" value="followUp" title="Queue after this run (⌥↵)">Queue <kbd>⌥↵</kbd></button>`}<button type="submit" class="send send-${primary}" id="send" name="mode" value="${look.mode}" title="${look.label} (⌘↵)">${icon("up")}<span class="send-label">${look.label}</span> <kbd>⌘↵</kbd></button></span></div>
</div>
</form>`;
}

type Block = Exclude<Item, ToolItem> | { kind: "tools"; tools: ToolItem[] };
export function blocks(items: readonly Item[]): Block[] {
  const out: Block[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.kind !== "tool") out.push(item);
    else if (last?.kind === "tools") last.tools.push(item);
    else out.push({ kind: "tools", tools: [item] });
  }
  return out;
}

export function blockView(block: Block, now: number): Html {
  switch (block.kind) {
    case "user": {
      const { from } = block;
      const named = from === "command" || from === "other";
      return html`<div class="msg user${block.queued !== null && " queued"}">${!named && unseen(promptLabel[from])}${(named || block.queued !== null) && html`<div class="msg-who">${named && html`<span class="chip chip-from">${promptLabel[from]}</span>`}${block.queued !== null && html`<span class="chip chip-queued">queued, ${block.queued}</span>`}</div>`}<div class="text">${prose(block.text)}</div>${shotsView(block.images)}</div>`;
    }
    case "agent": return block.streaming
      ? html`<div class="msg agent streaming"><div class="text" data-grow>${grows(prose(block.text, html`<span class="caret" aria-hidden="true"></span>`))}</div></div>`
      : html`<div class="msg agent"><div class="text">${prose(block.text)}</div>${shotsView(block.images)}</div>`;
    case "notice": return html`<p class="notice notice-${block.tone}"><span class="notice-mark" aria-hidden="true">!</span>${block.text}</p>`;
    case "note": return html`<p class="note">${block.text}</p>`;
    case "link": return html`<p class="note"><a class="link" href="${block.url}" target="_blank" rel="noopener">${block.text} ↗</a></p>`;
    case "tools": return stepsView(block.tools);
    case "ask": return askView(block, now);
  }
}

/**
 * A Claude worker's AskUserQuestion in the conversation: its questions and options, with what the person picked on
 * the dashboard, their own answer and notes, and from which device, or what Claude got when the terminal answered.
 */
function askView(item: AskItem, now: number): Html {
  const answer = item.question?.answer ?? null;
  const choices = answer?.choices;
  const status = answer !== null ? html`Answered from ${answer.by}, ${ago(answer.at, now)}.`
    : item.result.state === "done" ? (item.result.isError ? "Not answered." : "Answered in the terminal.")
    : item.question !== null ? "Waits for your answer below." : "Not answered.";
  return html`<section class="ask-card" id="ask-${item.id}" aria-label="Claude asked">
<p class="ask-head">Claude asked</p>
${item.questions.map((q, i) => {
  const choice = choices?.[i];
  return html`<div class="ask-q"><p class="ask-question"><span class="tag">${q.header}</span> ${q.question}</p>
<ul class="ask-picks">${q.options.map((o) => {
  const picked = choice?.picked.includes(o.label) === true;
  return html`<li${picked && html` class="picked"`}>${picked && html`<span class="ask-mark">✓ </span>`}<span class="ask-label">${o.label}</span>${o.description !== "" && html` <span class="ask-desc">${o.description}</span>`}${picked && o.preview !== undefined && html`<pre class="ask-preview">${o.preview}</pre>`}</li>`;
})}</ul>
${choice?.own !== undefined && html`<p class="ask-said">Own answer: ${choice.own}</p>`}${choice?.notes !== undefined && html`<p class="ask-said">Notes: ${choice.notes}</p>`}</div>`;
})}
${choices === undefined && item.result.state === "done" && html`<pre class="t-out">${item.result.output}</pre>`}
<p class="land-meta">${status}</p>
</section>`;
}
