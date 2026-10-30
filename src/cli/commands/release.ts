/** Landing and releasing: `release`, `review`, `land`, `deploy` and the image commands. */
import { fullCommit, releaseOutcome, type ReleaseView } from "../../deploy/model.ts";
import type { ImagesCurrent } from "../../control/wire.ts";
import type { ImageEntry, ImagesView } from "../../control/image-rollout.ts";
import type { ImageOperation } from "../../control/image-store.ts";
import type { Review } from "../../control/review-model.ts";
import { CliError } from "../transport.ts";
import { type Api, type Result, type Command, str, thread, int, table, pollUntil } from "../kit.ts";
import { reviewText } from "../thread-text.ts";

function releaseText(view: ReleaseView): string {
  return [`Desired: ${view.desired === null ? "none" : `${view.desired.commit} by ${view.desired.requestedBy} at ${new Date(view.desired.requestedAt).toISOString()}`}`,
    ...view.nodes.map((r) => `${r.node} ${r.role}: ${r.commit ?? "unknown"} ${r.state}${r.reason === null ? "" : `: ${r.reason}`}`)].join("\n");
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
  return view.operation === null ? images : `${images}\n${operationText(view.operation)}`;
}

/**
 * Polls the images every 2 s until the operation ends, through restarts of the control plane, as deploy --wait does. Each
 * change of a running step goes to stderr, so a build of minutes shows where it is and stdout stays one value for --json.
 */
async function imageWait(api: Api, started: ImageOperation): Promise<Result> {
  let operation = started;
  let view: ImagesView | null = null;
  const settled = async (): Promise<Result | undefined> => {
    if (operation.state === "failed") throw new CliError("failed", operationText(operation));
    if (operation.state !== "done") return undefined;
    view ??= await api("GET", "/v1/images") as ImagesView;
    return { json: view, text: imagesText(view) };
  };
  return await settled() ?? pollUntil({
    deadlineMs: 45 * 60_000, everyMs: 2_000, timedOut: () => new CliError("failed", `image wait timed out\n${operationText(operation)}`),
  }, async () => {
    view = await api("GET", "/v1/images") as ImagesView;
    const now = view.operation;
    if (now === null || now.kind !== started.kind || now.image !== started.image || now.requestedAt !== started.requestedAt) {
      throw new CliError("conflict", `another image operation replaced the ${started.kind} of ${started.image}${now === null ? "" : `\n${operationText(now)}`}`);
    }
    if (now.state === "running" && operationText(now) !== operationText(operation)) process.stderr.write(`${operationText(now)}\n`);
    operation = now;
    return settled();
  });
}

/** Starts an image operation, and with --wait follows it until it ends. */
const imageCommand = (path: string, args: Command["args"], body: (positionals: readonly string[]) => unknown): Command => ({
  args, options: { wait: { type: "boolean" } },
  async run(api, positionals, v) {
    const operation = await api("POST", path, body(positionals)) as ImageOperation;
    return v.wait === true ? imageWait(api, operation) : { json: operation, text: operationText(operation) };
  },
});

export const releaseCommands: Readonly<Record<string, Command>> = {
  release: {
    args: [0, 0],
    async run(api) {
      const view = await api("GET", "/v1/release") as ReleaseView;
      return { json: view, text: releaseText(view) };
    },
  },
  review: {
    args: [1, 1], options: { pr: { type: "string" }, rounds: { type: "string" }, land: { type: "boolean" }, cancel: { type: "boolean" } },
    async run(api, [id], v) {
      if (v.cancel === true) {
        if (v.pr !== undefined || v.rounds !== undefined || v.land !== undefined) throw new CliError("invalid", "--cancel takes no --pr, --rounds or --land");
        const r = await api("POST", `${thread(id!)}/review/cancel`, {}) as Review;
        return { json: r, text: `Cancelled ${reviewText(r)}` };
      }
      const pr = str(v, "pr");
      const rounds = str(v, "rounds");
      const body = { ...pr === undefined ? {} : { pr: int(pr, "--pr", 0) }, ...rounds === undefined ? {} : { rounds: int(rounds, "--rounds", 0) }, ...v.land === true ? { land: true } : {} };
      const r = await api("POST", `${thread(id!)}/review`, body) as Review;
      return { json: r, text: `Started ${reviewText(r)}` };
    },
  },
  land: {
    args: [1, 1],
    async run(api, [id]) {
      const r = await api("POST", `${thread(id!)}/land`, {}) as Review;
      return { json: r, text: `Landing ${reviewText(r)}` };
    },
  },
  deploy: {
    args: [1, 1], options: { wait: { type: "boolean" } },
    async run(api, [commit], values) {
      if (commit !== "main" && !fullCommit.test(commit!)) throw new CliError("invalid", "deploy takes main or a full lower-case commit hash");
      let view = await api("PUT", "/v1/release", { commit }) as ReleaseView;
      const target = view.desired!.commit;
      const settled = (): ReleaseView | undefined => {
        const outcome = releaseOutcome(view, target);
        if (outcome === "failed") throw new CliError("failed", releaseText(view));
        if (outcome === "superseded") throw new CliError("conflict", `deployment superseded\n${releaseText(view)}`);
        return outcome === "healthy" ? view : undefined;
      };
      if (values.wait === true) {
        view = settled() ?? await pollUntil({ deadlineMs: 30 * 60_000, everyMs: 1_000, timedOut: () => new CliError("failed", `deployment wait timed out\n${releaseText(view)}`) }, async () => {
          view = await api("GET", "/v1/release") as ReleaseView;
          return settled();
        });
      }
      return { json: view, text: releaseText(view) };
    },
  },
  "image build": imageCommand("/v1/images/build", [0, 0], () => ({})),
  "image rollout": imageCommand("/v1/images/rollout", [1, 1], ([image]) => ({ image })),
  "image rollback": imageCommand("/v1/images/rollback", [0, 0], () => ({})),
  "image list": {
    args: [0, 0],
    async run(api) {
      const view = await api("GET", "/v1/images") as ImagesView;
      return { json: view, text: imagesText(view) };
    },
  },
  "image current": {
    args: [0, 0],
    async run(api) {
      const images = await api("GET", "/v1/images/current") as ImagesCurrent;
      const rows = (["current", "previous"] as const).flatMap((role) => images[role] === null ? [] : [imageRow(images[role], role)]);
      return { json: images, text: rows.length === 0 ? "No image is current." : table(rows) };
    },
  },
};
