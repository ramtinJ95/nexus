/**
 * The merge policy, docs/merge-policy.md, as the checks a landing runs before it merges. Each condition answers the
 * reasons it fails, so a held landing tells the person exactly which ones, all at once.
 *
 * Most conditions read what the review loop recorded. The reserved cases come from two places that must both be
 * clear: the reviewer's classification, and, for Nexus's own pull requests, the changed paths. Text in the PR can
 * mislead the reviewer but cannot change its paths or its patch, so the path rules are drawn wide: a file, or a
 * patch's words, that might touch a reserved case holds the landing for the person, who can merge it themselves. They
 * are a list, so a reserved change in a file they do not name still rests on the reviewer alone.
 *
 * The holds that always need the person are theirs to waive, by answering Land to the question the review asks about
 * them. Every other condition is one no person can waive: it clears only when what failed changes.
 */
import type { ChangedFile, PrSnapshot } from "./github.ts";
import type { SecondReview } from "./project.ts";
import { holdRule, personOnly, reservedNames, waivable, type Hold, type HoldCode, type ReservedCase } from "./holds.ts";
import { answered, blocks, changedPaths, descriptionDigest, findingsOf, secondReads, type Change, type HeldAt, type Review, type Round } from "./review-model.ts";

export interface LandingFacts {
  review: Review;
  pr: PrSnapshot;
  /** The holds the latest round's head decides, as the loop recorded them against the PR's base now. */
  heldAt: HeldAt;
}

/** What the approved head alone decides its holds from: the review's record and the PR's files at that head. */
export interface HeadFacts {
  review: Review;
  files: readonly ChangedFile[];
  /** Whether the PR is Nexus's own, whose paths this module knows. */
  nexus: boolean;
}

/** Whether `path` names `pattern`. Nothing under docs/ deploys, so its names reserve nothing. */
const names = (path: string, pattern: RegExp) => !path.startsWith("docs/") && pattern.test(path);

/**
 * Whether a hunk of `patch` names `words` in any line of code it shows, its context and header included, since a line
 * added beside a guard can get around it without naming it. A line that is only a comment changes nothing. GitHub shows no patch for a file
 * too large to diff, which may change anything.
 */
const changes = (patch: string, words: RegExp) => patch === "" || patch.split("\n").some((line) => !/^[-+ ]\s*(\/\/.*|\/\*.*\*\/\s*)$/.test(line) && words.test(line));

/** Code that ships from a folder, as a test or a note there does not. */
const shipsFrom = (path: string, ...folders: string[]) => folders.some((f) => path.startsWith(f)) && !/\.test\.ts$|\.md$/.test(path);

/** Words a change to the allowlist, its hosts or the guest's network names, and a quoted host name, such as an entry in loginHosts, but not a file's. */
const egressWords = /host|allow|egress|network|\bnet\b|dns|proxy|firewall|tls|\bip|socks|ssh|secret|grant|login|bridge|hook|intercept|portal|publicUrl|\bport|["'`][a-z0-9.-]+\.(?!(json|[cm]?[jt]s|md|log|sock|sh|txt|ya?ml|html|css|py|pid|conf|service|timer|env|lock|gz|img|qcow2)["'`])[a-z]{2,}["'`]/i;
const modeWords = /chmod|chown|umask|0o[0-7]{3}/;
const authWords = new RegExp(`whois|caller|allowed|person|deployer|mayLand|canDeploy|isPerson|isReporter|admit|access|trust|peer|identity|auth|token|bearer|40[13]|control.?(plane|node)|tailnet|login|join|refuse|secret|redact|\\bopen:|${modeWords.source}`, "i");

/**
 * Nexus paths that may touch a reserved case, each a file whose every change might, or code whose patch names what the
 * case guards. A registry migration counts as irreversible even when it only adds a table: a control plane refuses a
 * registry newer than its code, so a rollback past one cannot start.
 */
const reservedPaths: readonly { case: ReservedCase; matches(path: string, patch: string): boolean }[] = [
  { case: "secrets", matches: (p) => names(p, /secret|credential/i) || p === "src/probe/redact.ts" || shipsFrom(p, "deploy/") },
  { case: "egress", matches: (p, patch) => ["src/pylon-vm/host-bridge.ts", "src/pylon-vm/runtime.ts"].includes(p) || names(p, /network|egress|allowlist/i)
    || ((["src/control/project.ts", "src/control/overlay.ts", "src/control/threads.ts", "src/control/live.ts"].includes(p) || shipsFrom(p, "src/pylon-vm")) && changes(patch, egressWords)) },
  { case: "auth", matches: (p, patch) => ["src/control/api.ts", "src/control/login.ts", "src/control/attach.ts", "src/control/policy.ts", "src/control/holds.ts", "src/protocol/routes.ts", "src/control/api/access.ts", "src/control/api/kit.ts", "src/control/api/pylon-access.ts", "src/probe/config.ts", "src/probe/server.ts", "src/deploy/control-plane.ts", "src/deploy/http.ts"].includes(p) || names(p, /auth|login|whois/i)
    || ((["src/control/main.ts", "src/control/releases.ts"].includes(p) || shipsFrom(p, "src/control/api/", "src/probe/", "src/deploy/")) && changes(patch, authWords))
    || (shipsFrom(p, "src/pylon-vm") && changes(patch, modeWords)) },
  { case: "tailnet", matches: (p) => names(p, /tailnet|tailscale/i) },
  { case: "image-rebuild", matches: (p) => p.startsWith("images/") || p === "src/agent-setup.ts" },
  { case: "irreversible", matches: (p, patch) => p === "src/control/schema.ts" && (patch === "" || /^@@.*\bmigrations\b|^\+.*\b(CREATE|ALTER|DROP) (TABLE|INDEX)\b/im.test(patch)) },
  { case: "irreversible", matches: (p, patch) => p === "package.json" && (patch === "" || /^[+-].*@earendil-works\/pi-durable/m.test(patch)) },
];

const hold = (code: HoldCode, text: string): Hold => ({ code, text });

const sameModel = (review: Review): Hold[] => review.models.reviewer === review.models.builder ? [hold("same-model", `The reviewer ran the builder's own model, ${review.models.builder}.`)] : [];

/**
 * The holds the review's record alone decides: they hold every landing of its approved head, whatever GitHub says. A
 * second reviewer only adds holds, so a Claude second reviewer's approval, which its pylon could write, stands in for
 * no approval the first reviewer did not give.
 */
export const recordedHolds = (review: Review): Hold[] => [
  ...review.reviewerKind === "claude" ? [hold("claude-approved", "A Claude reviewer approved it. Its verdict is read from its transcript in its pylon, where code it runs could write, so only the person can land what it approved.")] : [],
  ...review.second?.kind === "none" ? [hold("no-second-reviewer", `The project asks for a second reviewer on another model, since ${review.second.rule}, and none could run: ${review.second.why}.`)] : [],
  ...(review.rounds.at(-1)!.verdict?.reserved ?? []).map((r) => hold(`reserved:${r.case}`, `${personOnly}${reservedNames[r.case]}, by the reviewer's reading (${r.why}).`)),
  ...(review.rounds.at(-1)!.secondVerdict?.reserved ?? []).map((r) => hold(`reserved:${r.case}`, `${personOnly}${reservedNames[r.case]}, by the second reviewer's reading (${r.why}).`)),
];

/** The holds of the paths a change touches that need the person, which a second reviewer's rule reads. */
const reservedPathHolds = (files: readonly ChangedFile[], nexus: boolean): Hold[] => [...changedChecks(files), ...nexus ? pathHolds(files) : []];

/**
 * Why `rule`, a project's setting, gives the pull request whose change is `files` a second reviewer, or null when it
 * does not. Every added and deleted line counts, tests and docs too, and a file GitHub shows no patch for may change
 * any number of them.
 */
export function secondReviewRule(rule: SecondReview, files: readonly ChangedFile[], nexus: boolean): string | null {
  if (rule.always) return "the project gives every pull request one";
  if (rule.lines !== null) {
    const unshown = files.find((f) => f.patch === "");
    if (unshown !== undefined) return `GitHub shows no patch for ${unshown.path}, so the change may be any size`;
    const lines = files.reduce((n, f) => n + f.patch.split("\n").filter((line) => /^[+-]/.test(line)).length, 0);
    if (lines >= rule.lines) return `the change has ${lines} changed lines, at least the ${rule.lines} the project sets`;
  }
  const held = rule.reserved ? reservedPathHolds(files, nexus) : [];
  return held.length ? `the change has holds for the person on its paths: ${held.map((h) => h.code).join(", ")}` : null;
}

/**
 * The holds the head alone decides, which meet every landing of it whatever GitHub says: the record's, and the
 * changed files'. The loop records them on the round once its checks pass, as `heldAt`.
 */
export function headHolds({ review, files, nexus }: HeadFacts): Hold[] {
  return [
    ...sameModel(review),
    ...recordedHolds(review),
    ...reservedPathHolds(files, nexus),
  ];
}

const changedChecks = (files: readonly ChangedFile[]): Hold[] => [
  ...files.some((f) => f.path === ".nexus/check" || f.previous === ".nexus/check") ? [hold("check-changed", "The pull request changes .nexus/check, the check this policy relies on.")] : [],
  ...files.some((f) => f.path === ".nexus/verify" || f.previous === ".nexus/verify") ? [hold("verify-changed", "The pull request changes .nexus/verify, the live check this policy relies on.")] : [],
];

function pathHolds(files: readonly ChangedFile[]): Hold[] {
  const hits = new Map<ReservedCase, string[]>();
  for (const file of files) {
    // A file moved here, from a test, a note or anywhere else nothing held, brings a body its patch does not show.
    const patch = file.previous === null ? file.patch : "";
    for (const path of [file.path, ...file.previous === null ? [] : [file.previous]]) {
      for (const rule of reservedPaths) if (rule.matches(path, patch)) hits.set(rule.case, [...new Set([...hits.get(rule.case) ?? [], path])]);
    }
  }
  return [...hits].map(([c, paths]) => hold(`reserved-path:${c}`, `${personOnly}${reservedNames[c]}, as it changes ${paths.join(", ")}.`));
}

/** The holds the latest round's head decides, as recorded, or the record's alone for a round approved before Nexus recorded them, until the loop reads them. */
const headHeld = (review: Review): Hold[] => review.rounds.at(-1)!.heldAt?.holds ?? [...sameModel(review), ...recordedHolds(review)];

/**
 * What the holds currently on a review are: those its head decides, and for one held for the person, those its
 * landing met, or what held it first.
 */
export const heldBy = (review: Review): Hold[] => {
  if (review.phase.kind !== "needs-person") return headHeld(review);
  const codes = new Set(review.phase.holds.map((h) => h.code));
  return [...review.phase.holds, ...(review.rounds.at(-1)!.heldAt?.holds ?? []).filter((h) => !codes.has(h.code))];
};

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
/** The reviewer's quote of what could not be checked live at the round, or null when it quoted nothing long enough to count. */
const quoteOf = (round: Round) => {
  const quoted = round.verdict?.notCheckedLive ?? null;
  return quoted === null || squash(quoted).length < 20 ? null : quoted;
};

/** Whether the round has a quote that a landing should ask the reviewer for again, as the description changed since the reviewer last quoted from it. */
export const staleQuote = (round: Round, body: string) => quoteOf(round) !== null && round.quotedFrom !== descriptionDigest(body);

/**
 * What the person's Land press does now, the one rule the land route and the dashboard both follow. It is `stuck` on
 * the holds that meet every landing of the approved head again and that the person may not waive, which no press gets
 * past. Otherwise it lands past the holds it `waives`, and `quotes` first when no live check ran and the landing needs
 * the reviewer's quote of what could not be checked live, which only a description the reviewer reads again can give.
 */
export type LandPress = { kind: "stuck"; holds: Hold[] } | { kind: "lands"; waives: Hold[]; quotes: boolean };
export function landPress(review: Review): LandPress {
  const holds = heldBy(review);
  const stuck = holds.filter((h) => holdRule(h.code).holdsAgain && !holdRule(h.code).waivable);
  if (stuck.length) return { kind: "stuck", holds: stuck };
  const round = review.rounds.at(-1)!;
  const quotes = round.live?.kind === "absent" && (quoteOf(round) === null || holds.some((h) => h.code === "not-checked-live"));
  return { kind: "lands", waives: holds.filter((h) => waivable(h.code)), quotes };
}

/**
 * The holds a Land press at the review's latest head would waive, which the person is asked about, or none when no
 * press there lands. `early` is what the head alone decides, read from its change before the loop recorded it, so the
 * person can answer while the reviewer and the check run.
 */
export function askedHolds(review: Review, early: readonly Hold[] | null): Hold[] {
  const round = review.rounds.at(-1)!;
  const read = round.heldAt !== undefined || early === null ? review : { ...review, rounds: [...review.rounds.slice(0, -1), { ...round, heldAt: { base: round.base ?? "", holds: [...early] } }] };
  const press = landPress(read);
  return press.kind === "lands" ? press.waives : [];
}

const conditions: readonly ((facts: LandingFacts) => Hold[])[] = [
  ({ review }) => {
    const round = review.rounds.at(-1)!;
    if (round.verdict?.verdict !== "approve") return [hold("not-approved", "The reviewer has not approved the latest commits.")];
    // A second reviewer that never answered, or whose round lost its verdict, has not approved.
    if (secondReads(review) && round.secondVerdict?.verdict !== "approve") return [hold("not-approved", "The second reviewer has not approved the latest commits.")];
    const open = findingsOf(round).filter(blocks);
    return open.length ? [hold("open-findings", `Findings P0 to P2 are open: ${open.map((f) => f.id).join(", ")}.`)] : [];
  },
  ({ review }) => review.rounds.flatMap((round, i) => findingsOf(round).filter(blocks)
    .filter((f) => !answered(f, round.answers ?? []))
    .map((f) => hold("unanswered", `The builder neither fixed nor rejected with a reason finding ${f.id} of round ${i + 1}.`))),
  ({ review }) => {
    const round = review.rounds.at(-1)!;
    if (round.check === null) return [hold("check-failed", `.nexus/check has not run at ${round.head}.`)];
    return round.check.passed ? [] : [hold("check-failed", `.nexus/check failed at ${round.head}.`)];
  },
  ({ review, pr }) => {
    const head = review.rounds.at(-1)!.head;
    // A PR merged outside the review is held on what can still be judged: which head merged.
    if (pr.pr.state === "merged") return pr.detail.head === head ? [] : [hold("not-approved-head", `Pull request #${pr.pr.number} merged at ${pr.detail.head}, not the approved ${head}.`)];
    if (pr.pr.state !== "open") return [hold("pr-not-open", `Pull request #${pr.pr.number} is ${pr.pr.state}.`)];
    return [
      ...pr.detail.head === head ? [] : [hold("not-approved-head", `The pull request's head is ${pr.detail.head}, not the approved ${head}.`)],
      ...pr.pr.conflict === true ? [hold("conflict", "The branch conflicts with its base.")] : [],
      ...pr.pr.checks === "failed" || pr.pr.checks === "pending" ? [hold("github-checks", `The pull request's GitHub checks are ${pr.pr.checks}.`)] : [],
    ];
  },
  // A live check that ran decides. A head with no .nexus/verify ran none, and lands on the statement of what it could not check live.
  ({ review, pr }) => {
    const round = review.rounds.at(-1)!;
    if (round.live === undefined) return [hold("live-failed", `The live check has not run at ${round.head}.`)];
    if (round.live.kind === "ran") return round.live.passed ? [] : [hold("live-failed", `The live check failed at ${round.head}.`)];
    const quoted = quoteOf(round);
    if (quoted === null) return [hold("not-checked-live", "No live check ran, and the pull request does not say what could not be checked live.")];
    return squash(pr.detail.body).includes(squash(quoted)) ? [] : [hold("not-checked-live", "The reviewer's quote of what could not be checked live is not in the pull request's description.")];
  },
  ({ heldAt }) => heldAt.holds,
];

/** Why the policy holds this landing for the person, or nothing when an agent may merge and deploy it. */
export function landingHolds(facts: LandingFacts): Hold[] {
  return conditions.flatMap((condition) => condition(facts));
}

/** The holds that still hold the review's landing once the person's waiver at the approved head lets it past those it names. */
export function unwaived(review: Review, holds: readonly Hold[]): Hold[] {
  const { waiver } = review;
  return holds.filter((h) => !(waiver !== null && waiver.head === review.rounds.at(-1)!.head && waiver.codes.includes(h.code) && waivable(h.code)));
}

/**
 * The person's waiver, made at an earlier head, carried to the latest round's head when `change`, the change there, is
 * the one they waived and it then gets the landing past every hold in `holds`. Otherwise the review as it is and, when
 * the change differs or cannot be compared, why the waiver stays at its head. A new hold the person never waived holds
 * the landing whatever the change, and needs no why: it is one of the holds.
 */
export function carryWaiver(review: Review, change: Change, holds: readonly Hold[]): { review: Review; why: Hold | null } {
  const { waiver } = review;
  const head = review.rounds.at(-1)!.head;
  if (waiver === null || waiver.head === head) return { review, why: null };
  const [at, to] = [waiver.head.slice(0, 12), head.slice(0, 12)];
  const unknown = (why: string) => ({ review, why: hold("waiver-not-carried", `Nexus cannot tell whether the change at ${to} is the one ${waiver.by} pressed Land for at ${at}, as ${why}, so that waiver does not carry over. Look at the change again, and press Land to waive the holds at ${to}.`) });
  if (waiver.change === undefined) return unknown("the waiver was saved before Nexus recorded the change it waives");
  if (waiver.change === null) return unknown("Nexus never read the change the waiver was for");
  if (waiver.change.kind === "unknown") return unknown(waiver.change.why);
  if (change.kind === "unknown") return unknown(change.why);
  if (change.base !== waiver.change.base) return unknown(`the pull request's base moved from ${waiver.change.base} to ${change.base}`);
  const paths = changedPaths(waiver.change, change);
  if (paths.length) return { review, why: hold("waiver-not-carried", `The change at ${to} differs from the one ${waiver.by} pressed Land for at ${at}, in ${paths.join(", ")}, so that waiver does not carry over. Look at ${paths.length === 1 ? "that file" : "those files"} again, and press Land to waive the holds at ${to}.`) };
  const carried: Review = { ...review, waiver: { ...waiver, head, from: waiver.from ?? waiver.head } };
  return unwaived(carried, holds).length ? { review, why: null } : { review: carried, why: null };
}
