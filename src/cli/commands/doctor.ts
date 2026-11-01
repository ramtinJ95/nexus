/** `nexus doctor`: every check of each node and the control plane, run now. */
import type { DoctorReport } from "../../control/doctor-model.ts";
import { type Command, table } from "../kit.ts";

/** One line per check under its node, or under the control plane, with the statuses in one column. */
export function doctorText(report: DoctorReport): string {
  const rows = report.checks.map((c) => [`  ${c.status}`, c.name, c.text]);
  const widths = table(rows).split("\n");
  const lines: string[] = [];
  let group: string | undefined;
  report.checks.forEach((c, i) => {
    const name = c.node ?? "control plane";
    if (name !== group) lines.push(group = name);
    lines.push(widths[i]!);
  });
  const count = (status: string) => report.checks.filter((c) => c.status === status).length;
  return [...lines, `${count("fail")} failed, ${count("warn")} warned, ${count("ok")} ok`].join("\n");
}

export const doctorCommands: Readonly<Record<string, Command>> = {
  doctor: {
    args: [0, 0],
    async run(api) {
      const report = await api("GET", "/v1/doctor") as DoctorReport;
      return { json: report, text: doctorText(report), ...report.status === "fail" ? { exit: "failed" as const } : {} };
    },
  },
};
