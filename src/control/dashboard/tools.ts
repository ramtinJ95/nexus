/** Renders an agent's tool calls: each tool's look and diff, a run of steps, and screenshots. */
import { checkoutDir } from "../../session-harness.ts";
import { clock } from "./elapsed.ts";
import { Html, html, icon, grows, type Part } from "./view.ts";
import { prose } from "./markdown.ts";
import type { ToolItem, Shot } from "./items.ts";

/** Each image links to its full size in a new tab. A broken one becomes a note, which client.js writes. */
export const shotsView = (images: readonly Shot[] = []) => images.length > 0 && html`<div class="shots">${images.map((shot) =>
  html`<a class="shot" href="${shot.src}" target="_blank" rel="noopener"><img src="${shot.src}" alt="${shot.label}" loading="lazy">${shot.caption !== null && html`<span class="shot-cap">${shot.caption}</span>`}</a>`)}</div>`;

type DiffLine = readonly ["+" | "-", string];
type Args = ToolItem["call"]["arguments"];
/** What a call changes, and the arguments that hold it. */
type Diff = { keys: readonly string[]; lines: DiffLine[] };
const linesOf = (sign: "+" | "-", text: string) => text.split("\n").map((line): DiffLine => [sign, line]);
const replaced = (old: string, now: string) => [...linesOf("-", old), ...linesOf("+", now)];
/** A list of edits under `edits`, each a pair of strings under these keys, as pi's edit and Claude Code's MultiEdit take. */
const editsDiff = (oldKey: string, newKey: string) => ({ edits }: Args): Diff | null => {
  const pairs = Array.isArray(edits) ? edits.flatMap((e: Record<string, unknown> | null) => typeof e?.[oldKey] === "string" && typeof e[newKey] === "string" ? [[e[oldKey], e[newKey]] as const] : []) : [];
  return pairs.length === 0 || pairs.length !== (edits as unknown[]).length ? null : { keys: ["edits"], lines: pairs.flatMap(([old, now]) => replaced(old, now)) };
};
const contentDiff = ({ content }: Args): Diff | null => typeof content === "string" ? { keys: ["content"], lines: linesOf("+", content.replace(/\n$/, "")) } : null;
const stringDiff = ({ old_string: old, new_string: now }: Args): Diff | null => typeof old === "string" && typeof now === "string" ? { keys: ["old_string", "new_string"], lines: replaced(old, now) } : null;

/**
 * How a fold says what calls did, by what they do rather than which tool did them, so an edit and a write are both
 * a change. A fold says its weightiest actions first: commands, changes and subagents, then reads and searches, then
 * tools it does not know.
 */
// After t3code's summarizeToolGroup. Copyright (c) 2026 T3 Tools Inc., MIT licence; see THIRD_PARTY_NOTICES.md.
type Action = "command" | "change" | "subagent" | "read" | "search" | "web" | "fetch" | "todo";
interface Phrase { priority: number; one: string; many: (n: number) => string }
const actions: Record<Action, Phrase> = {
  command: { priority: 0, one: "ran a command", many: (n) => `ran ${n} commands` },
  change: { priority: 0, one: "changed a file", many: (n) => `changed ${n} files` },
  subagent: { priority: 0, one: "ran a subagent", many: (n) => `ran ${n} subagents` },
  read: { priority: 1, one: "read a file", many: (n) => `read ${n} files` },
  search: { priority: 1, one: "searched the code", many: (n) => `searched the code ${n} times` },
  web: { priority: 1, one: "searched the web", many: (n) => `searched the web ${n} times` },
  fetch: { priority: 1, one: "fetched a page", many: (n) => `fetched ${n} pages` },
  todo: { priority: 1, one: "updated the to-do list", many: (n) => `updated the to-do list ${n} times` },
};
const unknownTool = (name: string): Phrase => ({ priority: 2, one: `used ${name}`, many: (n) => `used ${name} ${n} times` });

/**
 * How a tool's calls read, by its name, pi's in lower case and Claude Code's capitalized: the name its row shows, one
 * for both agents, the argument that says what a call did, shown in its row, one shown whole as text, what it
 * changes, the argument naming the file it acts on, so a fold counts a file once, and the action a fold counts it under.
 */
interface ToolLook {
  label: string;
  subject?: string;
  text?: string;
  diff?: (args: Args) => Diff | null;
  file?: string;
  action?: Action;
}
const toolLooks: Readonly<Record<string, ToolLook>> = {
  read: { label: "Read", subject: "path", file: "path", action: "read" },
  bash: { label: "Bash", subject: "command", action: "command" },
  edit: { label: "Edit", subject: "path", file: "path", diff: editsDiff("oldText", "newText"), action: "change" },
  write: { label: "Write", subject: "path", file: "path", diff: contentDiff, action: "change" },
  grep: { label: "Grep", subject: "pattern", action: "search" },
  find: { label: "Find", subject: "pattern", action: "search" },
  ls: { label: "List", subject: "path", action: "search" },
  Read: { label: "Read", subject: "file_path", file: "file_path", action: "read" },
  Bash: { label: "Bash", subject: "command", action: "command" },
  Edit: { label: "Edit", subject: "file_path", file: "file_path", diff: stringDiff, action: "change" },
  MultiEdit: { label: "MultiEdit", subject: "file_path", file: "file_path", diff: editsDiff("old_string", "new_string"), action: "change" },
  Write: { label: "Write", subject: "file_path", file: "file_path", diff: contentDiff, action: "change" },
  Grep: { label: "Grep", subject: "pattern", action: "search" },
  Glob: { label: "Glob", subject: "pattern", action: "search" },
  Agent: { label: "Agent", subject: "description", text: "prompt", action: "subagent" },
  WebFetch: { label: "Fetch", subject: "url", action: "fetch" },
  WebSearch: { label: "Search", subject: "query", action: "web" },
  TodoWrite: { label: "Todos", action: "todo" },
  shell: { label: "Shell", subject: "command", action: "command" },
};
/** The arguments that say what a call of a tool without a look did, the first one it has. */
const subjectKeys = ["command", "pattern", "path", "url"];
/** A tool without a look shows its name, and an MCP server's tool, named mcp__server__tool, its own part of it. */
const lookOfTool = (name: string): ToolLook => Object.hasOwn(toolLooks, name) ? toolLooks[name]! : { label: /^mcp__.+?__(.+)$/.exec(name)?.[1] ?? name };
const textArg = (args: Args, key: string | undefined) => key !== undefined && typeof args[key] === "string" ? { key, value: args[key] as string } : undefined;
const subjectOf = (call: ToolItem["call"]) => {
  const { subject } = lookOfTool(call.name);
  return textArg(call.arguments, subject ?? subjectKeys.find((k) => typeof call.arguments[k] === "string"));
};
/**
 * A subject as its row shows it. Claude Code passes paths in the checkout whole and pi relative to it, so both read
 * relative. A value of many lines, as a heredoc command, shows its first.
 */
const shortSubject = (value: string) => {
  const [first, ...more] = value.split(`${checkoutDir}/`).join("").trim().split("\n");
  return more.length === 0 ? first : `${first} …`;
};
/** How long a call took: 840 ms, 2.4 s, then as a clock reads it. */
const took = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : clock(ms);

const failed = ({ result }: ToolItem) => result.state === "done" && result.isError;
/** pi's bash tool ends a failed command's output with its exit code, and Claude Code's starts with it. */
const exitCode = (output: string) => /exited with code (\d+)|^Exit code (\d+)/.exec(output)?.slice(1).find((code) => code !== undefined);

/** How a row's mark says how its call went, to the eye and to a screen reader. */
const toolMarks = {
  ok: { mark: icon("check"), said: "succeeded" },
  bad: { mark: icon("cross"), said: "failed" },
  run: { mark: html`<span class="spin"></span>`, said: "running" },
  none: { mark: icon("dash"), said: "no result" },
} as const;
/** A finished call's output of more than clipOver lines shows its first clipTo, with the rest one click away. */
const clipOver = 30;
const clipTo = 12;
function clipped<T>(id: string, lines: readonly T[], pre: (lines: readonly T[], part: string) => Html): Html {
  if (lines.length <= clipOver) return pre(lines, "");
  return html`${pre(lines.slice(0, clipTo), " t-head")}<details class="t-more" id="${id}"><summary data-more>Show all ${lines.length} lines</summary>${pre(lines.slice(clipTo), " t-rest")}</details>`;
}

/**
 * One line per call: how it went, its tool, its subject, its size and how long it took. Its body holds the whole
 * subject, the other arguments, the change and the output.
 */
function toolView(tool: ToolItem): Html {
  const { call, result, task, ms } = tool;
  const look = lookOfTool(call.name);
  const subject = subjectOf(call);
  const text = textArg(call.arguments, look.text);
  const diff = look.diff?.(call.arguments) ?? null;
  const rest = Object.fromEntries(Object.entries(call.arguments).filter(([key]) => key !== subject?.key && key !== text?.key && !diff?.keys.includes(key)));
  const output = result.state === "none" ? "" : result.output;
  const outLines = output === "" ? [] : output.trimEnd().split("\n");
  const bad = failed(tool);
  const running = result.state === "running";
  const state = running ? "run" : result.state === "none" ? "none" : result.isError ? "bad" : "ok";
  // Only what needs a look starts open: a failure, an edit's diff, an image and a call still running.
  const open = bad || diff !== null || running || (tool.images?.length ?? 0) > 0;
  const added = diff?.lines.filter(([sign]) => sign === "+").length ?? 0;
  // A running call's line count and output grow in place, so a reader scrolled in its output keeps their place.
  const grow = (inside: Part) => running ? grows(inside) : inside;
  const size = diff !== null ? html`<span class="add">+${added}</span> <span class="del">−${diff.lines.length - added}</span>` : outLines.length > 0 && `${outLines.length} ${outLines.length === 1 ? "line" : "lines"}`;
  const exit = bad && (exitCode(output) === undefined ? "failed" : `exit ${exitCode(output)}`);
  const { mark, said } = toolMarks[state];
  return html`<details class="tool${bad && " failed"}${running && " running"}" id="tool-${call.id}"${open && " open"}>
<summary><span class="t-mark ${state}" role="img" aria-label="${said}" title="${said}">${mark}</span><span class="t-name"${look.label.toLowerCase() !== call.name.toLowerCase() && html` title="${call.name}"`}>${look.label}</span><span class="t-subj">${subject !== undefined && shortSubject(subject.value)}</span><span class="t-meta"><span class="t-size"${running && " data-grow"}>${grow(size)}</span>${exit && html`<span class="t-exit">${exit}</span>`}</span>${ms !== null && html`<span class="t-time">${took(ms)}</span>`}<span class="chev" aria-hidden="true">›</span></summary>
${subject !== undefined && html`<pre class="t-full">${subject.value}</pre>`}
${text !== undefined && html`<div class="t-text">${prose(text.value)}</div>`}
${Object.keys(rest).length > 0 && html`<pre class="t-args">${JSON.stringify(rest, null, 2)}</pre>`}
${diff !== null && clipped(`more-${call.id}-diff`, diff.lines, (lines, part) => html`<pre class="t-out diff${part}">${lines.map(([sign, line]) => html`<span class="d d-${sign === "+" ? "add" : "del"}">${sign === "+" ? "+" : "−"} ${line}</span>`)}</pre>`)}
${(diff === null || bad) && (output === "" ? (tool.images?.length ?? 0) === 0 && html`<p class="t-empty">${running ? "No output yet." : "No output."}</p>`
    : running ? html`<pre class="t-out" data-grow>${grows(output)}</pre>`
    : clipped(`more-${call.id}`, outLines, (lines, part) => html`<pre class="t-out${part}">${lines.join("\n")}</pre>`))}
${shotsView(tool.images)}
${task !== undefined && html`<p class="t-task">Background task ${task.status}: ${task.summary}</p>${task.result !== null && html`<div class="t-text">${prose(task.result)}</div>`}`}
</details>`;
}

/** How many actions a fold names before it counts the tools of the rest. */
const phrasesShown = 3;

/**
 * What a run of calls did: Ran 3 commands, changed 2 files. Calls on the same path count once, so an edit and a
 * write to one file are one changed file. Each tool without a look is its own action, named as its row names it.
 */
function stepsSummary(tools: readonly ToolItem[]): string {
  const done = new Map<string, { phrase: Phrase; seen: Set<string>; names: Set<string> }>();
  for (const { call } of tools) {
    const look = lookOfTool(call.name);
    const key = look.action === undefined ? `tool ${call.name}` : look.action;
    const action = done.get(key) ?? { phrase: look.action === undefined ? unknownTool(look.label) : actions[look.action], seen: new Set(), names: new Set() };
    action.seen.add(textArg(call.arguments, look.file)?.value ?? call.id);
    action.names.add(call.name);
    done.set(key, action);
  }
  // The sort is stable, so actions of one priority keep the order they first appear in.
  const ranked = [...done.values()].sort((a, b) => a.phrase.priority - b.phrase.priority);
  const others = new Set(ranked.slice(phrasesShown).flatMap((a) => [...a.names])).size;
  const said = [
    ...ranked.slice(0, phrasesShown).map(({ phrase, seen }) => seen.size === 1 ? phrase.one : phrase.many(seen.size)),
    ...others === 0 ? [] : [others === 1 ? "used another tool" : `used ${others} other tools`],
  ].join(", ");
  return said.charAt(0).toUpperCase() + said.slice(1);
}

/** A fold of more calls than this starts closed, unless one failed or still runs. */
const foldOver = 5;

/**
 * A lone call is its own line. A run of calls folds under a line that says what they did, so a busy turn does not
 * bury the answer around it. A long fold starts closed, and opens itself when a call failed or is still running,
 * which is when the reader needs to see it.
 */
export function stepsView(tools: readonly ToolItem[]): Html {
  if (tools.length === 1) return html`<div class="tools">${toolView(tools[0]!)}</div>`;
  const bad = tools.filter(failed).length;
  const running = tools.filter((t) => t.result.state === "running").length;
  return html`<details class="steps${bad > 0 && " has-bad"}" id="steps-${tools[0]!.call.id}"${(tools.length <= foldOver || bad > 0 || running > 0) && " open"}>
<summary><span class="s-names">${stepsSummary(tools)}</span>${bad > 0 && html`<span class="s-bad">${bad} failed</span>`}${running > 0 && html`<span class="s-run"><span class="spin" aria-hidden="true"></span>${running} running</span>`}<span class="s-count">${tools.length} calls</span><span class="chev" aria-hidden="true">›</span></summary>
<div class="tools">${tools.map(toolView)}</div>
</details>`;
}
