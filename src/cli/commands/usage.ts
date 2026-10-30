/** `nexus usage` and `usage backfill`: the tokens the agents spent, and the read of archived threads' transcripts. */
import type { BackfillView } from "../../control/wire.ts";
import { breakdownLook, breakdowns, tokenColumns, tokenCount, utc, type BackfillPlanRow, type UsageBackfill, type UsageReport, type UsageTotals } from "../../control/usage.ts";
import { CliError } from "../transport.ts";
import { type Command, str, table } from "../kit.ts";

function backfillText(b: UsageBackfill): string {
  if (b.state === "never") return "Backfill: not run. A deployer runs `nexus usage backfill` to read archived threads' pylons.";
  const threads = `${b.read} of ${b.of} thread${b.of === 1 ? "" : "s"} read`;
  const recovered = `recovered ${b.recovered.calls} call${b.recovered.calls === 1 ? "" : "s"} and ${tokenCount(b.recovered.tokens)} tokens`;
  const doing = b.current === null ? b.waiting === null ? "" : ` It waits: ${b.waiting}.`
    : b.current.phase === "reading" ? ` It reads the pylon of ${b.current.thread}.` : ` It waits for the pylon of ${b.current.thread} to pause.`;
  const line = b.state === "running" ? `Backfill: running, ${threads}, ${recovered}.${doing}`
    : b.state === "stopped" ? `Backfill: stopped at ${threads}, ${recovered}.`
    : `Backfill: done at ${utc(b.finishedAt!)}, ${threads}, ${b.skipped.length} skipped, ${recovered}.`;
  if (b.state === "running" || b.skipped.length === 0) return line;
  return `${line}\nSkipped:\n${table(b.skipped.map((t) => [t.thread, t.title, t.reason ?? ""]))}`;
}

function backfillPlanText(plan: readonly BackfillPlanRow[]): string {
  if (plan.length === 0) return "No archived thread is left to read.";
  const lines = table(plan.map((r) => [r.thread, r.project, r.node, r.title])).split("\n");
  return [`A start reads ${plan.length} archived thread${plan.length === 1 ? "" : "s"}, one pylon at a time:`,
    ...lines.flatMap((line, i) => plan[i]!.reason === null ? [line] : [line, `  skipped before: ${plan[i]!.reason}`])].join("\n");
}

function usageText(r: UsageReport): string {
  const rows = (keyHead: string, of: readonly (UsageTotals & { key: string })[]) =>
    table([[keyHead, ...tokenColumns.map((col) => col.label), "Calls"], ...of.map((row) => [row.key, ...tokenColumns.map((col) => tokenCount(row[col.field])), String(row.calls)])]);
  const head = `Usage of ${r.project === null ? "all projects" : `project ${r.project}`} ${r.since === null ? "for all time" : `since ${utc(r.since)}`}. Counting started ${utc(r.countingSince)}.\n${backfillText(r.backfill)}`;
  if (r.total.calls === 0) return `${head}\nNo model calls were counted in this period.`;
  return [head, rows("", [{ key: "Total", ...r.total }]), ...breakdowns.flatMap((b) => {
    const { title, key } = breakdownLook[b];
    return r.by[b] === undefined ? [] : [`${title}\n${rows(key, r.by[b])}`];
  })].join("\n\n");
}

export const usageCommands: Readonly<Record<string, Command>> = {
  usage: {
    args: [0, 0],
    options: { since: { type: "string" }, project: { type: "string" }, by: { type: "string" } },
    async run(api, _, v) {
      const query = new URLSearchParams({ since: str(v, "since") ?? "7d" });
      for (const key of ["project", "by"]) if (str(v, key) !== undefined) query.set(key, str(v, key)!);
      const report = await api("GET", `/v1/usage?${query}`) as UsageReport;
      return { json: report, text: usageText(report) };
    },
  },
  "usage backfill": {
    args: [0, 0],
    options: { "dry-run": { type: "boolean" }, stop: { type: "boolean" } },
    async run(api, _, v) {
      if (v["dry-run"] === true && v.stop === true) throw new CliError("invalid", "--dry-run and --stop do not go together");
      if (v["dry-run"] === true) {
        const view = await api("GET", "/v1/usage/backfill") as BackfillView;
        return { json: view, text: backfillPlanText(view.plan) };
      }
      const state = await api(v.stop === true ? "DELETE" : "POST", "/v1/usage/backfill") as UsageBackfill;
      return { json: state, text: backfillText(state) };
    },
  },
};
