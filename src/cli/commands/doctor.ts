import { type Command, request, table } from "../kit.ts";
import { versionsText } from "../config.ts";
import { doctorRoutes, type DoctorReport } from "../../contract/reports.ts";

export function doctorText(report: DoctorReport): string {
  const rows = report.checks.map((c) => [`  ${c.status}`, c.name, c.text]);
  const [head, ...widths] = table(["  Status", "Check", "Result"], rows).split("\n");
  const lines: string[] = [head!];
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
    help: ["  nexus doctor                                 check each node and the control plane now: release, disk, pylons, backup, login, certificate"],
    args: [0, 0], anyVersion: true,
    async run(api, _args, _v, _follow, { versions }) {
      const report = await request(api, doctorRoutes.doctor, {});
      return { json: report, text: `${versionsText(await versions())}\n${doctorText(report)}`, ...report.status === "fail" ? { exit: "failed" as const } : {} };
    },
  },
};
