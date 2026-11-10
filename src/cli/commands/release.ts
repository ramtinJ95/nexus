import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ImageId } from "../../ids.ts";
import { fullCommit, releaseOutcome, type ReleaseView } from "../../protocol/deploy.ts";
import { CliError, UsageError } from "../transport.ts";
import { type Api, type Io, type Result, type Command, str, request, int, table, pollUntil } from "../kit.ts";
import { threadRoutes } from "../../contract/threads.ts";
import { deployWaitMs, imageRoutes, releaseRoutes, type ImageEntry, type ImageOperation, type ImagesView } from "../../contract/release.ts";
import { landOption, questionRoutes, reviewRoutes, type ReviewView } from "../../contract/reviews.ts";

function releaseText(view: ReleaseView): string {
  return [`Desired: ${view.desired === null ? "none" : `${view.desired.commit} by ${view.desired.requestedBy} at ${new Date(view.desired.requestedAt).toISOString()}`}`,
    ...view.nodes.map((r) => `${r.node} ${r.role}: ${r.commit ?? "unknown"} ${r.state}${r.worker === undefined ? "" : ` (worker ${r.worker})`}${r.reason === null ? "" : `: ${r.reason}`}`)].join("\n");
}

const imageRow = (image: ImageEntry, role: string): string[] => [
  image.id, role, `built ${image.builtAt} on ${image.builtOn}`, `release ${image.release?.slice(0, 12) ?? "unknown"}`,
  `on ${image.nodes.length === 0 ? "none" : image.nodes.join(", ")}`,
];

function operationText(o: ImageOperation): string {
  return [`${o.kind} ${o.image}: ${o.state}${o.state === "failed" ? `: ${o.reason}` : ""}`, ...o.steps.map((s) => `  ${s.node}: ${s.state}${s.reason === null ? "" : `: ${s.reason}`}`)].join("\n");
}

function imagesText(view: ImagesView): string {
  const role = (id: string) => id === view.current ? "current" : id === view.previous ? "previous" : "-";
  const images = view.images.length === 0 ? "No images." : table(view.images.map((image) => imageRow(image, role(image.id))));
  // A control plane older than 0.79.0 sends no fetches.
  const fetches = view.fetches ?? [];
  return [
    images,
    ...fetches.length === 0 ? [] : [`Fetches of the current image ${view.current}:`, ...fetches.map((f) => `  ${f.node}: ${f.state}${f.failures > 0 ? `, ${f.failures} failed` : ""}${f.reason === null ? "" : `: ${f.reason}`}`)],
    ...view.operation === null ? [] : [operationText(view.operation)],
  ].join("\n");
}

/**
 * A terminal sees each change of a running step, so a build of minutes shows where it is, and stdout stays one value
 * for --json. A build's text ends with the rollout to run next, which stays a command of its own.
 */
async function imageWait(api: Api, started: ImageOperation, progress: Io["stderr"]): Promise<Result> {
  let operation = started;
  let view: ImagesView | null = null;
  const settled = async (): Promise<Result | undefined> => {
    if (operation.state === "failed") throw new CliError("failed", operationText(operation));
    if (operation.state !== "done") return undefined;
    view ??= await request(api, imageRoutes.list, {});
    const next = started.kind === "build" ? `\nRoll it out to every online node with: nexus image rollout ${started.image} --wait` : "";
    return { json: view, text: `${imagesText(view)}${next}` };
  };
  return await settled() ?? pollUntil({
    deadlineMs: 45 * 60_000, everyMs: 2_000, timedOut: () => new CliError("failed", `image wait timed out\n${operationText(operation)}`),
    shown: {
      to: progress,
      state: () => operation.state === "running" ? operationText(operation) : undefined,
      stopped: () => `Stopped waiting. The ${started.kind} of ${started.image} carries on, and \`nexus image list\` shows where it is`,
    },
  }, async () => {
    view = await request(api, imageRoutes.list, {});
    const now = view.operation;
    if (now === null || now.kind !== started.kind || now.image !== started.image || now.requestedAt !== started.requestedAt) {
      throw new CliError("conflict", `another image operation replaced the ${started.kind} of ${started.image}${now === null ? "" : `\n${operationText(now)}`}`);
    }
    operation = now;
    return settled();
  });
}

const imageCommand = (help: Command["help"], args: Command["args"], start: (api: Api, positionals: readonly string[]) => Promise<ImageOperation>): Command => ({
  help, args, options: { wait: { type: "boolean" } },
  async run(api, positionals, v, _follow, { io }) {
    const operation = await start(api, positionals);
    return v.wait === true ? imageWait(api, operation, io.stderr) : { json: operation, text: operationText(operation) };
  },
});

export interface Terminal { input: Readable & { readonly isTTY?: boolean }; output: Writable & { readonly isTTY?: boolean } }

function needsTerminal(terminal: Terminal): void {
  if (terminal.input.isTTY !== true || terminal.output.isTTY !== true) throw new CliError("invalid", "land --waive shows you the holds it waives and asks you to confirm them, and stdin or stderr is not a terminal. Run it in a terminal, or press Land on the dashboard");
}

/**
 * An agent on the person's Mac calls as the same tailnet node, so the terminal is what tells the person apart: with
 * no terminal it refuses.
 */
export async function confirmWaiver(terminal: Terminal, pr: number, head: string, holds: readonly string[]): Promise<boolean> {
  needsTerminal(terminal);
  terminal.output.write(`Land pull request #${pr} at ${head}, waiving the holds the merge policy reserves for you:\n${holds.map((h) => `  ${h}\n`).join("")}Type yes to waive them and land: `);
  const lines = createInterface({ input: terminal.input, terminal: false });
  const answer = await new Promise<string | null>((resolve) => {
    lines.once("line", resolve);
    lines.once("close", () => resolve(null));
  });
  lines.close();
  return answer?.trim() === "yes";
}

/**
 * What the dashboard's Land press sends for the thread's review as the API's `reviewView` says it is now: its head,
 * and the holds the press waives, once the person confirmed them on `terminal`. While the review asks about its
 * holds, the `question` to answer Land instead, once the person confirmed the holds it names, and whether the review
 * is still `running`, so the answer waives them for its landing later rather than starts it.
 */
export async function pressOf(api: Api, id: string, terminal: Terminal): Promise<{ head?: string; waive?: string[]; question?: string; running?: boolean }> {
  needsTerminal(terminal);
  const { reviewView: view } = await request(api, threadRoutes.show, { thread: id });
  if (view === null) return {};
  if (view.question !== null) {
    if (!await confirmWaiver(terminal, view.pr, view.question.head, view.question.holds.map((h) => h.text))) throw new CliError("failed", "nothing landed, as you did not confirm the holds it waives");
    return { question: view.question.id, running: !view.ended };
  }
  if (view.press.kind !== "lands" || view.press.waives.length === 0) return { head: view.head };
  const waive = view.press.waives.map((h) => h.text);
  if (!await confirmWaiver(terminal, view.pr, view.head, waive)) throw new CliError("failed", "nothing landed, as you did not confirm the holds it waives");
  return { head: view.head, waive };
}

export const answeredText = (view: ReviewView, said: readonly string[], running: boolean) => running
  ? `Waived the holds at ${view.head.slice(0, 12)}. It lands once the reviewer approves and its checks pass.\n${said.join("\n")}`
  : `Landing ${said.join("\n")}`;

export const releaseCommands: Readonly<Record<string, Command>> = {
  release: {
    help: ["  nexus release"],
    args: [0, 0],
    async run(api) {
      const view = await request(api, releaseRoutes.release, {});
      return { json: view, text: releaseText(view) };
    },
  },
  review: {
    help: [
      "  nexus review <thread> [--pr N] [--rounds N] [--land]",
      "    a reviewer on another model for the thread's open PR, round after round until it approves; --land merges and deploys under the merge policy",
      "  nexus review --cancel <thread>               end the thread's running review and archive its reviewer, unless it began merging or deploying",
    ],
    args: [1, 1], thread: true, options: { pr: { type: "string" }, rounds: { type: "string" }, land: { type: "boolean" }, cancel: { type: "boolean" } },
    async run(api, [id], v) {
      if (v.cancel === true) {
        if (v.pr !== undefined || v.rounds !== undefined || v.land !== undefined) throw new UsageError("--cancel takes no --pr, --rounds or --land");
        const r = await request(api, reviewRoutes.cancel, { thread: id! });
        return { json: r, text: `Cancelled ${r.said.join("\n")}` };
      }
      const pr = str(v, "pr");
      const rounds = str(v, "rounds");
      const body = { ...pr === undefined ? {} : { pr: int(pr, "--pr", 0) }, ...rounds === undefined ? {} : { rounds: int(rounds, "--rounds", 0) }, ...v.land === true ? { land: true } : {} };
      const r = await request(api, reviewRoutes.start, { thread: id!, body });
      return { json: r, text: `Started ${r.said.join("\n")}` };
    },
  },
  land: {
    help: [
      "  nexus land <thread> [--waive]",
      "    land an approved review under the merge policy, or try a held landing again; --waive answers Land to the review's question about the holds reserved for you",
    ],
    args: [1, 1], thread: true, options: { waive: { type: "boolean" } },
    async run(api, [id], v, _follow, { io }) {
      const { question, running, ...press } = v.waive === true ? await pressOf(api, id!, { input: io.stdin, output: io.stderr }) : {};
      if (question !== undefined) {
        await request(api, questionRoutes.answer, { question, body: { option: landOption } });
        const { reviewView: view, said } = await request(api, threadRoutes.show, { thread: id! });
        return { json: view, text: answeredText(view!, said.review!, running === true) };
      }
      const r = await request(api, reviewRoutes.land, { thread: id!, body: press });
      return { json: r, text: `Landing ${r.said.join("\n")}` };
    },
  },
  deploy: {
    help: ["  nexus deploy <commit|main> [--wait]"],
    args: [1, 1], options: { wait: { type: "boolean" } },
    async run(api, [commit], values, _follow, { io }) {
      if (commit !== "main" && !fullCommit.test(commit!)) throw new UsageError("deploy takes main or a full lower-case commit hash");
      let view = await request(api, releaseRoutes.deploy, { body: { commit: commit! } });
      const target = view.desired!.commit;
      const settled = (): ReleaseView | undefined => {
        const outcome = releaseOutcome(view, target);
        if (outcome === "failed") throw new CliError("failed", releaseText(view));
        if (outcome === "superseded") throw new CliError("conflict", `deployment superseded\n${releaseText(view)}`);
        return outcome === "healthy" ? view : undefined;
      };
      if (values.wait === true) {
        view = settled() ?? await pollUntil({
          deadlineMs: deployWaitMs, everyMs: 1_000, timedOut: () => new CliError("failed", `deployment wait timed out\n${releaseText(view)}`),
          shown: { to: io.stderr, state: () => releaseText(view), stopped: () => "Stopped waiting. The deployment carries on, and `nexus release` shows where it is" },
        }, async () => {
          view = await request(api, releaseRoutes.release, {});
          return settled();
        });
      }
      return { json: view, text: releaseText(view) };
    },
  },
  "image build": imageCommand(["  nexus image build [--wait]                   build the recipe of the control plane's release, and record the image"], [0, 0], (api) => request(api, imageRoutes.build, {})),
  "image rollout": imageCommand(["  nexus image rollout <image> [--wait]         copy an image to every online node, then make it current"], [1, 1], (api, [image]) => request(api, imageRoutes.rollout, { body: { image: image as ImageId } })),
  "image rollback": imageCommand(["  nexus image rollback [--wait]                roll out again the image that was current before this one"], [0, 0], (api) => request(api, imageRoutes.rollback, {})),
  "image list": {
    help: ["  nexus image list                             recorded images, the nodes that hold each, and the last image operation"],
    args: [0, 0],
    async run(api) {
      const view = await request(api, imageRoutes.list, {});
      return { json: view, text: imagesText(view) };
    },
  },
  "image current": {
    help: ["  nexus image current                          the current image and the one before it"],
    args: [0, 0],
    async run(api) {
      const images = await request(api, imageRoutes.current, {});
      const rows = (["current", "previous"] as const).flatMap((role) => images[role] === null ? [] : [imageRow(images[role], role)]);
      return { json: images, text: rows.length === 0 ? "No image is current." : table(rows) };
    },
  },
};
