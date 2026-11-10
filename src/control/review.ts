/**
 * The review loop: once a builder thread's pull request is open, a reviewer thread on another model reviews it, the
 * builder fixes or rejects each finding and pushes, and the reviewer reviews the new commits, until it approves or the
 * rounds run out. The control plane runs the repository's checks at each round's head while the reviewer reads it, and
 * once both the approval and the checks are in, its live check when the head has a `.nexus/verify`, and, when the person
 * asked for it, lands the PR under the merge policy (policy.ts): merge, then deploy and roll back if the fleet is not
 * healthy (landing.ts).
 *
 * The loop runs on the control plane, one pass every few seconds, from the record the registry keeps per builder. Each
 * phase's step reads what the world says now (the agents' replies, the PR, the release) and moves on only from that,
 * so a pass after a crash or a restart, including the one the landing's own deploy causes, picks up where it was.
 * Every message goes out through the inbox under a request ID made from the review and a count of its messages, and it
 * is saved before it is sent, so a retried pass sends it again under the same ID, which the inbox never delivers twice.
 *
 * The agents answer in fenced JSON blocks that echo the token of the request they answer, which this module parses
 * from their replies. Each request gets a fresh random token that only its recipient is told, so an old answer, or
 * the other agent, cannot answer it.
 * A reply that lacks the block gets a reminder, at most twice in a row, before the loop asks the person. A turn that
 * ended because the agent's model failed gets the same request again, after a wait that grows with each failure in a row.
 */
import { createHash, randomBytes } from "node:crypto";
import { checkCaller, mint, reviewerCaller, tokenBlocks, verifyCaller } from "./agent-protocol.ts";
import { scopedFlight } from "../single-flight.ts";
import type { SecretGrant } from "../protocol/secret-grants.ts";
import { agentKinds } from "../protocol/agent-kinds.ts";
import { defaultClaudeModel } from "../protocol/models.ts";
import type { ChangedFile, GitHub, PrSnapshot, PullRequest } from "./github.ts";
import { Refusal } from "./refusal.ts";
import type { Inbox } from "./inbox.ts";
import { logOnce, type Log } from "./log-once.ts";
import { caseOf, remedyOf, waivable, waivedName, type Hold } from "./holds.ts";
import { carryWaiver, headHolds, holdsAt, landPress, secondReviewRule, staleQuote, unwaived } from "./policy.ts";
import type { CheckRuns } from "./gate.ts";
import type { AgentState } from "./agent-conversation.ts";
import { prWatchMs, reviewedPr, watchedPrs, watchStopped } from "./pr-watch-model.ts";
import type { Registry } from "./registry.ts";
import type { Thread } from "./thread-store.ts";
import { newThreadId, type NodeName, type ProjectId, type TailnetNodeId, type ThreadId } from "../ids.ts";
import { holdOptions, landOption } from "../contract/reviews.ts";
import { askingHolds, isOpen, type HeldQuestion, type HoldsQuestion, type Unanswered } from "./questions.ts";
import {
  answered, approves, behindOf, blocks, cancellable, cannotLand, changedPaths, changeOf, checkOutput, checkThread, descriptionDigest, ended, type EndedKind, findingsOf, gateAhead, gateFailure, gateRun, heldForGate, humanLabel,
  inLanding, landable, landingVerb, liveOutput, maxRounds, personPhase, pushedHead, reviewerApproved, reviewersFindings, roundsSpent, sameBehind, secondReads, seatsFor, settled, seatsOf, verdictAt, verdictsFor,
  type Behind, type GateRun, type HoldCause, type Refused, type ModelFailure, type Phase, type PhaseKind, type Review, type Round, type Seat, type SecondReviewer, type Talk, type Waiver,
} from "./review-model.ts";
import { landsOnItsOwn, type Project } from "./project.ts";
import { landing } from "./landing.ts";
import { deliverDurable } from "./durable-message.ts";
import type { Start } from "./start-request.ts";
import { servesReview, threadRole } from "./work-model.ts";
import { builderFindings, builderNotes, fencedAnswers, nextRound, quoteRequest, reminder, reviewerRequest, type FencedAnswer } from "./prompts.ts";
import { isOpenStatus, openStatuses } from "./reconcile.ts";

type ReviewRegistry = Pick<Registry, "threads" | "questions" | "releases" | "reviews" | "nodes" | "now" | "planning" | "prWatches" | "projects">;

/** How long a turn's end may run ahead of its transcript before a reply without the block counts as missing it. */
const replyGraceMs = 60_000;
/** How long an agent may take to answer, or the builder to push what it says it fixed, before the loop asks the person. */
const answerMs = 3 * 60 * 60_000;
const pushGraceMs = 10 * 60_000;
/** How long GitHub may take to push the update of a branch it accepted before the loop asks for it again. */
const updateGraceMs = 60_000;
const maxNudges = 2;
/** How long the loop waits before it sends a request again after each model failure in a row. The next failure goes to the person. */
const retryMs = [2, 5, 10, 20].map((minutes) => minutes * 60_000);
const checkMs = 60 * 60_000;
/** How long a second reviewer's start is tried, once a minute, before the review goes on without it. */
const secondStartMs = 30 * 60_000;
const secondRetryMs = 60_000;

export interface ReviewDeps {
  registry: ReviewRegistry;
  github: GitHub;
  inbox: Inbox;
  /** What the agent did since the loop's last message to it, read once per step (agent-conversation.ts). */
  agentState(t: Thread, since: number): Promise<AgentState>;
  /** The builder's brief, its first message, or null when it has none (agent-conversation.ts). */
  brief(t: Thread): Promise<string | null>;
  /** Whether the person wrote to the thread after `since` (agent-conversation.ts). */
  personWrote(t: Thread, since: number): Promise<boolean>;
  /** The check runs, and the live check's in verify pylons. Each tells `ended` of a run that ended, so the review waiting on it steps at once. */
  runs(ended: (thread: ThreadId) => void): { checks: CheckRuns; live: CheckRuns };
  startThread(start: Start): Promise<Thread>;
  /** The model the harness runs every thread on. */
  harnessModel: string;
  /** The control plane's own node, for the release view, and the repository its releases come from. */
  release: { self: string | undefined; repo: string };
  /** Whether `caller` may land, which takes the right to deploy. A landing asks again before every merge. */
  mayLand(caller: string): boolean;
  /** Tells the planner a thread's status changed, so an archived thread's pylon pauses at once. */
  wake(t: Thread): void;
  log: Log;
  now?: () => number;
}

/**
 * Whom the loop awaits answers from, each in its conversation: the builder and the reviewer in the review's own, and
 * the second reviewer, once its thread runs, in its own.
 */
type Party = "builder" | "reviewer" | "second";
/** The party each reviewer seat's verdict comes from. */
const partyAt = { first: "reviewer", second: "second" } as const satisfies Record<Seat, Party>;
const talking = (r: Review, party: Party) => party !== "second" || r.second?.kind === "claude";
type Awaiting = Extract<Phase, { kind: keyof typeof fencedAnswers }>;
const awaits = (phase: Phase): phase is Awaiting => phase.kind in fencedAnswers;
type Conversing = Talk & { failing: ModelFailure | undefined };
interface Conversation { who: string; thread: ThreadId; talk: Conversing; with(talk: Conversing): Review }
/**
 * `party`'s conversation in `r`, and `r` with it changed. The builder's and the reviewer's model failures are kept on
 * the phase that awaits their answer, and the review's one outbox is the message for whichever its `to` names.
 */
function conversation(r: Review, party: Party): Conversation {
  if (party === "second") {
    if (r.second?.kind !== "claude") throw new Error(`review ${r.id} has no second reviewer's conversation`);
    const { failing: _, ...second } = r.second;
    return {
      who: "second reviewer", thread: second.thread, talk: { ...second, failing: r.second.failing },
      with: ({ expect, asked, since, nudges, outbox, failing }) => ({ ...r, second: { ...second, expect, asked, since, nudges, outbox, ...failing && { failing } } }),
    };
  }
  const { phase } = r;
  const awaited = awaits(phase) && (phase.kind === "fixing" ? "builder" : "reviewer") === party ? phase : null;
  return {
    who: party, thread: r[party],
    talk: { expect: r.expect, asked: r.asked, since: r.since, nudges: r.nudges, outbox: r.outbox?.to === party ? r.outbox : null, failing: awaited?.failing },
    with({ expect, asked, since, nudges, outbox, failing }) {
      const next: Review = { ...r, expect, asked, since, nudges, outbox: outbox !== null ? { to: party, id: outbox.id, text: outbox.text, attempted: outbox.attempted } : r.outbox?.to === party ? null : r.outbox };
      if (awaited === null || awaited.failing === failing) return next;
      const { failing: _, ...kept } = awaited;
      return { ...next, phase: { ...kept, ...failing && { failing } } };
    },
  };
}

/** Every question about a review's holds has an ID that starts so, and a builder has at most one open. */
const holdsPrefix = "holds-";
const listed = (names: readonly string[]) => names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The question that asks the person to waive `holds` at the review's latest head, with `why` an earlier waiver did not
 * carry to it. Its ID is made from the head, the base and the holds in any order, so the same holds ask nothing new,
 * and holds that change ask again.
 */
function holdsQuestion(r: Review, holds: readonly Hold[], why: Hold | null, deploys: boolean, askedAt: number): Unanswered<HoldsQuestion> {
  const { head, base } = r.rounds.at(-1)!;
  const at = head.slice(0, 12);
  const asked: HeldQuestion = { review: r.id, head, base: base ?? null, holds };
  const sorted = [...holds].sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
  const id = `${holdsPrefix}${r.id}-${createHash("sha256").update(JSON.stringify([head, base ?? null, sorted])).digest("hex").slice(0, 16)}`;
  const text = `Land pull request #${r.pr.number}, "${r.pr.title}", at ${at}, waiving ${listed([...new Set(holds.map((h) => waivedName(h.code)))])}?
${holds.map((h) => `- ${h.text}`).join("\n")}
${why === null ? "" : `${why.text}\n`}Land waives these at ${at}, and at a rebase of it that leaves the change as it is. Nexus still lands it only once the reviewer approves it and its checks pass${deploys ? ", then deploys it" : ""}. Leave it, and nothing is waived.`;
  return { kind: "holds", id, thread: r.builder, text, options: holdOptions, reserved: holds.map((h) => caseOf(h.code)).find((c) => c !== null) ?? null, answerer: "deployer", askedAt, holds: asked };
}

// A Claude worker logs in from a granted token. Interactive /login needs a person, so it cannot serve a reviewer.
const grantsClaude = (secrets: readonly SecretGrant[]) =>
  agentKinds["claude-code"].signIn.grants.some((grant) => secrets.some((s) => s.name === grant.name && grant.hosts.every((host) => s.hosts.includes(host))));

/** The reviewer's kind and model: another model family than the builder's where one can run, or why none can. */
export function reviewerFor(builder: { claude: boolean; model: string }, secrets: readonly SecretGrant[], harnessModel: string): { claude: boolean; model: string } | { why: string } {
  if (builder.claude) return { claude: false, model: harnessModel };
  if (grantsClaude(secrets)) return { claude: true, model: defaultClaudeModel };
  return { why: `no reviewer on another model can run for this thread: its agent runs ${builder.model} in the harness, and its project grants no Claude token. Grant CLAUDE_CODE_OAUTH_TOKEN for api.anthropic.com to the project (\`nexus project edit\`), or start the builder as a Claude worker` };
}

/**
 * The second reviewer is an independent Claude read on the default model, even when another participant runs it.
 * `taken` serves only the no-token refusal message.
 */
export function secondReviewerFor(taken: readonly string[], secrets: readonly SecretGrant[]): { model: string } | { why: string } {
  if (!grantsClaude(secrets)) return { why: `the harness runs only ${taken.join(" and ")}, and the project grants no Claude token for a Claude worker. Grant CLAUDE_CODE_OAUTH_TOKEN for api.anthropic.com to the project (\`nexus project edit\`)` };
  return { model: defaultClaudeModel };
}

export function reviewLoop(deps: ReviewDeps) {
  const { registry, github, inbox, agentState, release, log } = deps;
  const now = deps.now ?? Date.now;
  // The failures each pass retries. Never log transport errors' text: a fetch implementation may put authorization headers in them.
  const retried = logOnce(log);
  const passes = scopedFlight(pass);
  let closed = false;
  // A check's stream can end after close, and its wake then finds the registry closed.
  const wake = (id: ThreadId) => closed ? Promise.resolve() : passes.wake(id);
  const { checks, live } = deps.runs((id) => void wake(id));
  const poll = passes.poll;

  /**
   * What holds a start of `r`'s new reviewer, second reviewer or gate pylon: another review's gate pylon that waits for
   * room and began before any wait of `r`'s own, so the room that frees goes to the oldest wait. Read before each start,
   * since a step earlier in the pass may have saved a wait or ended one.
   */
  const heldBehind = (r: Review): Behind | null => {
    const ahead = gateAhead(registry.reviews.reviewsToStep(), r);
    return ahead === null ? null : behindOf(ahead);
  };

  /** Each PR as GitHub said it in this pass, which a step reads rather than GitHub again. A landing reads it afresh. */
  let reads = new Map<string, Promise<PrSnapshot>>();
  const prKey = (r: Pick<Review, "pr">) => `${r.pr.repo}:${r.pr.number}`;
  const read = (r: Pick<Review, "pr">) => {
    if (!reads.has(prKey(r))) reads.set(prKey(r), github.poll(r.pr.repo, r.pr.number));
    return reads.get(prKey(r))!;
  };
  /** When the loop last read each capped held review's PR itself, in place of the PR watch. A restart reads it again. */
  const cappedReads = new Map<string, number>();
  /** When the loop last read the holds of each approved review's head that had none recorded. */
  const holdReads = new Map<string, number>();
  /** Whether a PR watch interval passed since the loop last read GitHub for `r` in `reads`. */
  const due = (reads: Map<string, number>, r: Review) => now() - (reads.get(r.id) ?? -Infinity) >= prWatchMs;
  /** The check thread or verify pylon `phase` holds, and the runs it is one of. */
  const gateThread = (phase: Phase): { thread: ThreadId; runs: CheckRuns } | null => {
    const thread = gateRun(phase)?.thread ?? null;
    return thread === null ? null : { thread, runs: phase.kind === "verifying" ? live : checks };
  };
  const end = (r: Review, phase: Extract<Phase, { kind: EndedKind }>): Review => {
    const gate = gateThread(r.phase);
    if (gate !== null) gate.runs.discard(gate.thread);
    return { ...r, phase, outbox: null, ...r.second?.kind === "claude" && { second: { ...r.second, outbox: null } } };
  };
  const toPerson = (r: Review, cause: HoldCause, ...items: (Hold | string)[]): Review => end(r, personPhase(cause, ...items));
  const landings = landing({ registry, release, mayLand: deps.mayLand, now, toPerson });
  const { deploys } = landings;
  /** A review that lands still decides whether a merge made outside it deploys. */
  const outside = (r: Review, state: PullRequest["state"] | undefined): Review | null =>
    state === "closed" || (state === "merged" && r.land === null) ? end(r, { kind: state }) : null;
  /** The PR watch reads GitHub only every two minutes, so the loop asks GitHub itself before it acts on an open PR. */
  const endedOnGitHub = async (r: Review) => outside(r, (await read(r)).pr.state);
  /** The rounds ran out without an approval the checks passed, so the PR gets the label that asks for the person. */
  const ranOut = (r: Review, ...items: (Hold | string)[]): Review => end(r, { ...personPhase("rounds", ...items), label: { state: "adding" } });
  const checking = (): Phase => ({ kind: "checking", startedAt: now(), thread: null });
  /**
   * `r` with the holds its latest round's head decides against the PR's base recorded, or null when the PR is at
   * another head, which gets a round of its own. A retargeted PR's files change at the same head, so they are read
   * again. They are read before the head and base are confirmed, so files of a push or a retarget meanwhile are not
   * recorded as this head's.
   */
  const recordHolds = async (r: Review): Promise<Review | null> => {
    const round = r.rounds.at(-1)!;
    const { base } = (await read(r)).detail;
    if (round.heldAt?.base === base) return r;
    const files = await github.files(r.pr.repo, r.pr.number);
    reads.delete(prKey(r));
    const { detail } = await read(r);
    if (detail.head !== round.head || detail.base !== base) return null;
    return withRound(r, { heldAt: { base, holds: headHolds({ review: r, files, deploys: deploys(r) }) } });
  };
  /** Past every check, a review records what holds its head, then stops at approval, or lands when asked to. */
  const checked = async (r: Review): Promise<Review> => {
    const next = await recordHolds(r) ?? r;
    return { ...next, phase: r.land === null ? { kind: "approved" } : { kind: "merging", authorized: null } };
  };
  /** Past the check at the round's head: the live check runs where the head has a `.nexus/verify` and none ran there yet. */
  const checkPassed = async (r: Review, verifies: boolean): Promise<Review> => {
    if (verifies) return { ...r, phase: { kind: "verifying", startedAt: now(), thread: null } };
    return await checked(r.rounds.at(-1)!.live === undefined ? withRound(r, { live: { kind: "absent" } }) : r);
  };
  /**
   * The failed check or live check of `next`'s round goes back to the builder as a P0 finding, unless no round is left,
   * or it failed at a head where it had failed before, which a fix the reviewer approved did not change.
   */
  const gateFailed = (r: Review, next: Review): Review => {
    const head = r.rounds.at(-1)!.head;
    const gate = gateFailure(next.rounds.at(-1)!)!;
    const output = gate.output === null ? [] : [gate.output];
    const again = r.rounds.slice(0, -1).some((earlier) => earlier.head === head && gateFailure(earlier)?.kind === gate.kind) ? [{ code: gate.code, text: `${gate.failed} again at ${head}, where it failed before.` }] : [];
    if (roundsSpent(r) >= r.maxRounds) return ranOut(next, { code: gate.code, text: `${gate.failed} at ${head} after the last round this review allows.` }, ...again, ...output);
    if (again.length) return toPerson(next, "gate", ...again, ...output);
    return toBuilder(next);
  };
  /** The check's result at `head` from any round of `r`, which every round there keeps, since the check clones that commit alone. */
  const checkedAt = (r: Review, head: string) => r.rounds.findLast((round) => round.head === head && round.check !== null)?.check ?? null;
  /**
   * The check or live check could not run at the round's head, which a fresh pylon would not change, so the person gets
   * its output. A PR at another head by then, such as after a force-push that took the round's commit off the remote,
   * gets a round of its own instead.
   */
  const unrunnable = async (r: Review, hold: Hold, output: string): Promise<Review> => {
    const { pr, detail } = await read(r);
    if (pr.state !== "open" || detail.head === r.rounds.at(-1)!.head) return outside(r, pr.state) ?? toPerson(r, "no-verdict", hold, output);
    const next = await newHead(r, detail.head, detail.base, `The pull request's head moved to ${detail.head}`);
    const gate = gateThread(r.phase);
    if (gate !== null) gate.runs.discard(gate.thread);
    return next;
  };
  const checkUnrunnable = (r: Review, output: string) =>
    unrunnable(r, { code: "check-failed", text: `.nexus/check could not run at ${r.rounds.at(-1)!.head}.` }, checkOutput(output));
  /** The last message to `party` again, under the review's next request ID, so it keeps its token. */
  const resend = (r: Review, party: Party): Review => {
    const c = conversation(r, party);
    return { ...c.with({ ...c.talk, outbox: { id: `${r.id}:${r.sent + 1}`, text: c.talk.asked, attempted: null } }), sent: r.sent + 1 };
  };
  const say = (r: Review, party: Party, expect: string, nudges: number, text: (token: string) => string): Review => {
    const c = conversation(r, party);
    return resend(c.with({ ...c.talk, expect, nudges, asked: text(expect), failing: undefined }), party);
  };
  /** A new request to `party`, with a new token and no reminders yet. */
  const send = (r: Review, party: Party, text: (token: string) => string): Review => say(r, party, mint(r.id), 0, text);
  /** A reminder to `party`, which keeps the token its answer must echo. */
  const remind = (r: Review, party: Party, text: (token: string) => string): Review => {
    const { expect, nudges } = conversation(r, party).talk;
    return say(r, party, expect, nudges + 1, text);
  };
  /** The round's findings go to the builder, who owes an answer to each. */
  const toBuilder = (r: Review): Review => send({ ...r, phase: { kind: "fixing" } }, "builder", (token) => builderFindings(r, token));
  /** What `party` did since the loop's last message to it, and its `answer` blocks with its token merged, or null. */
  const hear = async <T extends { token: string }>(r: Review, party: Party, answer: FencedAnswer<T>) => {
    const c = conversation(r, party);
    const state = await agentState(registry.threads.thread(c.thread)!, c.talk.since);
    const blocks = state.mayAnswer ? tokenBlocks(state.replies, answer.fence, answer.schema, c.talk.expect) : [];
    return { state, answer: blocks.length === 0 ? null : answer.merge(blocks) };
  };
  /**
   * The next round's request to each reviewer, which hears only of its own findings' answers. A second reviewer that
   * joins at this round, or starts again after the loop archived it at an approval, gets its first request instead.
   */
  const toReviewers = async (r: Review, head: string, base: string): Promise<Review> => {
    const previous = r.rounds.at(-1)!;
    const slot = reviewRound(await joinSecond(r), head, base);
    return seatsFor(slot).filter((seat) => talking(slot, partyAt[seat]))
      .reduce((next, seat) => send(next, partyAt[seat], (token) => nextRound(slot, previous, token, base, seat)), { ...slot, phase: { kind: "reviewing" } } as Review);
  };
  /** A second reviewer the round's start may need: the project's rule's first at the round's head, or the review's again. */
  const joinSecond = async (r: Review): Promise<Review> => {
    const { second } = r;
    if (second?.kind === "none" || second?.kind === "starting") return r;
    if (second?.kind === "claude") return registry.threads.thread(second.thread)?.status === "active" ? r : { ...r, second: starting(second.rule, second.model) };
    const project = registry.projects.project(registry.threads.thread(r.builder)!.project)!;
    const rule = project.secondReview == null ? null : secondReviewRule(project.secondReview, await github.files(r.pr.repo, r.pr.number), deploys(r));
    return rule === null ? r : { ...r, second: secondFor(rule, r.models, project.secrets) };
  };
  const withRound = (r: Review, round: Partial<Round>): Review => ({ ...r, rounds: [...r.rounds.slice(0, -1), { ...r.rounds.at(-1)!, ...round }] });
  /** The PR's change at commit `head`, as GitHub shows it against `base`. */
  const changeAt = async (r: Review, base: string, head: string) => changeOf(base, await github.change(r.pr.repo, base, head));
  /**
   * `r` with the latest round's verdict carried to `head`, pushed after it, when the change at both is the same on the
   * same base, or null when the change differs or cannot be compared, and `head` needs a round of its own.
   */
  const carryRound = async (r: Review, head: string, base: string, held?: true): Promise<Review | null> => {
    const round = r.rounds.at(-1)!;
    if (round.base !== base) return null;
    const [before, after] = [await changeAt(r, base, round.head), await changeAt(r, base, head)];
    if (before.kind !== "known" || after.kind !== "known" || changedPaths(before, after).length) return null;
    return { ...r, rounds: [...r.rounds, { head, base, ...verdictsFor(seatsOf(round), round), check: checkedAt(r, head), answers: null, carried: { from: round.head, ...held && { held } } }] };
  };
  /**
   * The reviewer's approval of the latest round carried to `head`, so the checks run at `head` with no reviewer round.
   * Null when the reviewer did not approve it, or the change differs.
   */
  const carryApproval = async (r: Review, head: string, base: string): Promise<Review | null> => {
    if (!reviewerApproved(r.rounds.at(-1)!)) return null;
    const carried = await carryRound(r, head, base);
    return carried === null ? null : { ...carried, phase: checking(), outbox: null, nudges: 0 };
  };
  /**
   * The next round reviews `head`, a head the reviewer has not seen, or the person gets it once no round is left. The
   * same change as the approved head's only runs the checks again.
   */
  const newHead = async (r: Review, head: string, base: string, why: string): Promise<Review> => {
    const carried = await carryApproval(r, head, base);
    if (carried !== null) return carried;
    const n = roundsSpent(r);
    if (n >= r.maxRounds) return end(r, { ...personPhase("rounds", `${why} after round ${n}, the last this review allows, so ${head} is unreviewed.`), label: { state: "adding" }, unreviewed: head });
    return await toReviewers(r, head, base);
  };
  /** `r` with a round for the reviewer at `head`. The person's waiver was of the change against the latest round's base. */
  const reviewRound = (r: Review, head: string, base: string): Review =>
    ({ ...r, rounds: [...r.rounds, { head, base, ...verdictsFor(seatsFor(r)), check: checkedAt(r, head), answers: null }], waiver: r.rounds.at(-1)!.base === base ? r.waiver : null });
  /**
   * The round's check beside its reviewer, started at the round's head unless the round has its result, which is
   * recorded once the run gives one. A run that cannot give one starts again in a fresh thread, and one the pylon
   * cannot run is left for `checking` to report once the reviewer approves.
   */
  const checkWhileReading = async (r: Review, phase: Extract<Phase, { kind: "reviewing" }>, builder: Thread): Promise<Review> => {
    const check = phase.check ?? { startedAt: now(), thread: null };
    if (r.rounds.at(-1)!.check !== null || check.unrunnable !== undefined || (check.refused !== undefined && check.room === undefined)) return r;
    const step = await stepGate(r, "beside", check, builder);
    if (step.kind === "ended") return step.review;
    if (step.kind === "run") return step.run === check ? r : { ...r, phase: { ...phase, check: step.run } };
    checks.discard(step.thread);
    if (step.kind === "unrunnable") return { ...r, phase: { ...phase, check: { ...check, thread: null, unrunnable: step.output } } };
    const { check: _, ...reading } = phase;
    return withRound({ ...r, phase: reading }, { check: { passed: step.passed, output: step.output } });
  };
  /**
   * One step of a gate run at the latest round's head: the run beside the reviewer, the check, or the live check. A run
   * that can give no verdict is thrown away, and the next step starts a fresh one. A run that ended is the caller's to
   * discard. The check beside the reviewer never overcommits a node. One no node has room for starts once room frees,
   * and one no node could take for another reason waits for the verdict. A live check refused waits for a node that
   * nests KVM with room. Only those two wait, so a refused check fails the step, which the next pass tries again. A
   * wait for room alone has no deadline, so the gate's deadline counts from the start that ends it. Nor has a start
   * another review's wait holds (`heldBehind`), whose deadline counts from when the hold ends.
   */
  const stepGate = async <Run extends GateRun & Refused>(r: Review, kind: "beside" | "check" | "live", run: Run, builder: Thread): Promise<
    { kind: "ended"; review: Review } | { kind: "run"; run: Run | GateRun } | { kind: "unrunnable"; thread: ThreadId; output: string } | { kind: "done"; thread: ThreadId; passed: boolean; output: string }
  > => {
    const runs = kind === "live" ? live : checks;
    const { head } = r.rounds.at(-1)!;
    if (run.thread === null) {
      // A held run keeps its `startedAt`, and with it its place in the line `gateAhead` reads, until the start it waits
      // for, which a refusal for room alone leaves in line.
      const behind = heldBehind(r);
      if (behind !== null) return { kind: "run", run: sameBehind(run.behind, behind) ? run : { ...run, behind } };
      const gone = await endedOnGitHub(r);
      if (gone !== null) return { kind: "ended", review: gone };
      // A run in line, held or waiting for room, has no deadline until a start ends that.
      const held = run.behind !== undefined || run.room === true;
      let started: Awaited<ReturnType<CheckRuns["start"]>>;
      try {
        started = await runs.start(builder, r.pr.branch, head, kind === "beside" || undefined);
      } catch (err) {
        // A held run's failed start takes it out of line, or it would hold every other start with no deadline of its
        // own. A wait for room keeps its place, as its next start may still be refused for room alone.
        if (run.behind === undefined) throw err;
        log(`review ${r.id} of ${r.builder}: a ${kind === "live" ? "live check" : "check"} that waited in line did not start and will be tried again (${(err as Error).name})`);
        return { kind: "run", run: { startedAt: now(), thread: null } };
      }
      const startedAt = held && !("room" in started && started.room) ? now() : run.startedAt;
      if ("thread" in started) return { kind: "run", run: { startedAt, thread: started.thread } };
      // Saved rather than thrown once, so the check's deadline counts from when it left the line.
      if (kind === "check") {
        if (held) return { kind: "run", run: { startedAt, thread: null } };
        throw new Error(started.refused);
      }
      if (run.behind === undefined && run.refused === started.refused && (run.room === true) === started.room) return { kind: "run", run };
      const { room: _, behind: __, ...kept } = run;
      return { kind: "run", run: { ...kept, startedAt, refused: started.refused, ...started.room && { room: true as const } } };
    }
    const state = runs.step(run.thread, head);
    if (state.kind === "void") {
      runs.discard(run.thread);
      return { kind: "run", run: { startedAt: run.startedAt, thread: null } };
    }
    if (state.kind === "unrunnable" || state.kind === "done") return { ...state, thread: run.thread };
    return { kind: "run", run };
  };
  /**
   * The builder rebases a branch that conflicts with its base, even after the last round: a rebase that keeps the
   * approved change needs no round, and one that changes it runs out of rounds when the builder pushes it.
   */
  const rebase = (r: Review, base: string): Review => {
    return toBuilder(withRound(r, { conflict: { base } }));
  };

  /** Each review's latest head's change against its base, read once to ask about its holds before the loop records them. */
  const early = new Map<string, { at: string; files: readonly ChangedFile[] | null }>();
  /** The holds question each builder was last left with, so a pass that changes nothing writes nothing. */
  const asked = new Map<ThreadId, string | null>();
  const ask = (builder: ThreadId, question: Unanswered<HoldsQuestion> | null) => {
    if (asked.get(builder) === (question?.id ?? null)) return;
    registry.questions.replaceQuestions(builder, holdsPrefix, question);
    asked.set(builder, question?.id ?? null);
  };
  /**
   * Asks the person about the holds a Land press at the review's latest head would waive, as soon as they are known:
   * those the head's change decides from the round's start, and the reviewer's once it answers. A review that cannot
   * land, or whose holds the person's waiver covers, asks nothing. Answers `r` with the change its waiver is for read,
   * or with the waiver carried to a rebase of that change, so the person is not asked again for it.
   */
  async function askHolds(r: Review): Promise<Review> {
    const round = r.rounds.at(-1)!;
    // A Land given early lands the change the person saw: a round carried from its head on its base keeps it, and any
    // other round at another head or base drops it.
    if (r.land?.head !== undefined && (r.land.head !== round.head || r.land.base !== (round.base ?? null))) {
      const same = round.carried?.from === r.land.head && r.land.base === (round.base ?? null);
      return { ...r, land: same ? { ...r.land, head: round.head } : null };
    }
    // A save since `r` was read, such as the person's cancel while GitHub answered, decides the question instead.
    const askFor = (question: Unanswered<HoldsQuestion> | null) => {
      if (registry.reviews.isCurrentReview(r)) ask(r.builder, question);
    };
    const askable = r.merged === null && (ended(r) ? landable(r) : landingVerb(r) === null);
    if (!askable) {
      early.delete(r.id);
      askFor(null);
      return r;
    }
    let files: readonly ChangedFile[] | null = null;
    if (round.heldAt === undefined && round.base !== undefined) {
      const at = `${round.head}:${round.base}`;
      if (early.get(r.id)?.at !== at) early.set(r.id, { at, files: await github.change(r.pr.repo, round.base, round.head) });
      files = early.get(r.id)!.files;
    }
    const press = landPress(r, files === null ? null : headHolds({ review: r, files, deploys: deploys(r) }));
    const holds = press.kind === "lands" ? press.waives : [];
    const base = async () => round.base ?? (await read(r)).detail.base;
    // As the landing does, the change a waiver is for is read once the person gave it, so a rebase can be compared with it.
    if (r.waiver !== null && r.waiver.change === null && r.waiver.head === round.head) return { ...r, waiver: { ...r.waiver, change: await changeAt(r, await base(), round.head) } };
    if (holds.length === 0 || unwaived(r, holds).length === 0) {
      askFor(null);
      return r;
    }
    let question = holdsQuestion(r, holds, null, deploys(r), now());
    if (registry.questions.question(question.id) === null && r.waiver !== null && r.waiver.head !== round.head) {
      const { review, why } = carryWaiver(r, await changeAt(r, await base(), round.head), holds);
      if (review !== r) return review;
      question = holdsQuestion(r, holds, why, deploys(r), now());
    }
    askFor(question);
    return r;
  }
  /**
   * `r`'s holds question answered Land by whoever turned on the project's yolo setting, as their own press would, when
   * the setting is on and they may land. Its waiver names the project, and the landing still meets every hold the
   * policy lets no one waive. A refusal leaves the question to the person. It runs once the pass saved its steps, so
   * its save never races theirs.
   */
  function yolo(r: Review): void {
    const project = registry.threads.thread(r.builder)?.project;
    const setting = project === undefined ? undefined : registry.projects.project(project)?.autoReview;
    // Only a review asked to land is landed: one the person started without --land stops at approval, as they asked.
    if (r.land === null || setting?.mode !== "yolo" || !deps.mayLand(setting.enabledBy) || !registry.reviews.isCurrentReview(r)) return;
    const question = askingHolds(registry.questions.questions(r.builder), r.id, r.rounds.at(-1));
    if (question === undefined) return;
    try {
      landHolds(question, setting.enabledBy as TailnetNodeId, project);
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      log(`review ${r.id} of ${r.builder}: project ${project}'s yolo setting did not land it (${err.message})`);
    }
  }

  /** What a Land press on `r` does, refused when no press lands it. */
  const pressOn = (r: Review) => {
    const press = landPress(r);
    if (press.kind === "stuck") throw new Refusal("conflict", `review ${r.id} of ${r.builder} is held by what meets every landing of ${r.rounds.at(-1)!.head} again, so no Land press lands it: ${press.holds.map((h) => h.text).join(" ")}`);
    return press;
  };
  const waiverOf = (r: Review, by: string, texts: readonly string[], codes: Waiver["codes"]): Waiver => ({ head: r.rounds.at(-1)!.head, holds: [...texts], codes, by, at: now(), change: null });
  /** A Land press on `r`, which `landableAt` took, past the holds the person `waive`s, each one the review has now and the policy lets them waive. */
  const pressed = (r: Review, requestedBy: string, waive: readonly string[] | undefined): Review => {
    if (waive?.length === 0) throw new Refusal("invalid", "a waiver names at least one hold");
    // The person names each hold by the text they saw, which must be one of the review's holds now.
    const waived = (text: string) => {
      const hold = holdsAt(r).find((h) => h.text === text);
      if (hold === undefined) throw new Refusal("conflict", `review ${r.id} is not held by "${text}", so there is nothing to waive. Look at it again`);
      if (!waivable(hold.code)) throw new Refusal("conflict", `"${text}" cannot be waived: only the holds the merge policy reserves for the person`);
      return hold.code;
    };
    return pressWith(r, requestedBy, waive === undefined ? null : waiverOf(r, requestedBy, waive, waive.map(waived)));
  };
  const pressWith = (r: Review, requestedBy: string, waiver: Waiver | null): Review => {
    const press = pressOn(r);
    return { ...r, land: { requestedBy }, waiver, phase: press.quotes ? { kind: "quoting", asked: null } : checking(), outbox: null, nudges: 0 };
  };
  /** The holds question of `r` that is open at its latest head and names exactly the holds `texts` name. */
  const openQuestion = (r: Review, texts: readonly string[]): HoldsQuestion | undefined => {
    const q = askingHolds(registry.questions.questions(r.builder), r.id, r.rounds.at(-1));
    return q !== undefined && JSON.stringify(q.holds.holds.map((h) => h.text).sort()) === JSON.stringify([...texts].sort()) ? q : undefined;
  };
  /**
   * Saves `next`, the Land press by `by` on `r`, and answers Land to `question`, the holds question it waives, in the
   * same transaction. A save of the review since `r` was read refuses it as `moved`.
   */
  function savePress(r: Review, next: Review, by: string, question: HoldsQuestion | undefined, moved: Refusal): HoldsQuestion | undefined {
    const save = () => {
      if (!registry.reviews.saveReview(next, [], r)) throw moved;
    };
    let answered: HoldsQuestion | undefined;
    if (question === undefined) save();
    else answered = registry.questions.answerQuestion(question, { option: landOption, by: by as TailnetNodeId, at: now() }, save);
    void poll();
    return answered;
  }

  /**
   * Waits on `party`. Once a turn of it ended after the loop's last message without the answer the loop needs, it gets
   * a reminder saying what is `missing`, or that the block is, and after the last reminder, or hours of silence, the
   * loop asks the person. A turn that ended because its model failed is no reminder: the same message goes again once
   * the failure's wait is over, and after the last wait the loop asks the person.
   */
  function wait(r: Review, phase: Awaiting, party: Party, state: AgentState, missing: string | null): Review {
    const c = conversation(r, party);
    const { since, nudges, failing } = c.talk;
    if (now() - since > answerMs) return toPerson(r, "agent", `The ${c.who} gave no answer Nexus could read within ${answerMs / 3_600_000} hours in round ${r.rounds.length}.`);
    // Until the request goes again, `since` is before `retryAt`, and the turn that ended is the failure already counted,
    // whose end a Claude worker's transcript and its hook may each report at another time.
    if (failing !== undefined && since < failing.retryAt) return now() < failing.retryAt ? r : resend(r, party);
    const { over, failure: failed } = state;
    if (over === null || now() - over <= replyGraceMs) return r;
    if (failed !== null) {
      const count = (failing?.count ?? 0) + 1;
      if (count > retryMs.length) return toPerson(r, "agent", `The ${c.who}'s model failed ${count} times in a row (last: ${failed}), in round ${r.rounds.length}. Run nexus review again once the provider recovers.`);
      return c.with({ ...c.talk, failing: { count, last: failed, retryAt: now() + retryMs[count - 1]! } });
    }
    if (nudges >= maxNudges) return toPerson(r, "agent", `The ${c.who} ended ${maxNudges + 1} turns in a row without an answer Nexus could read, in round ${r.rounds.length}.`);
    return remind(r, party, (token) => reminder(phase.kind, missing, token));
  }

  const steps: { [K in Exclude<PhaseKind, EndedKind>]: (r: Review, phase: Extract<Phase, { kind: K }>, builder: Thread) => Promise<Review> } = {
    async reviewing(r, phase, builder) {
      const reading = r.rounds.at(-1)!;
      // Each reviewer's verdict is recorded as it comes, and the round goes on once both are in.
      const heard: { seat: Seat; state: AgentState }[] = [];
      let next = r;
      for (const seat of seatsOf(reading).filter((seat) => verdictAt(reading, seat) === null && talking(r, partyAt[seat]))) {
        const { state, answer } = await hear(r, partyAt[seat], fencedAnswers.reviewing);
        heard.push({ seat, state });
        if (answer === null) continue;
        const c = conversation(next, partyAt[seat]);
        next = withRound(c.with({ ...c.talk, nudges: 0, failing: undefined }), seat === "first" ? { verdict: answer } : { secondVerdict: answer });
      }
      const round = next.rounds.at(-1)!;
      if (seatsOf(round).some((seat) => verdictAt(round, seat) === null)) {
        if (next !== r) return next;
        // A check that cannot start yet must not keep the reviewer's reminders, retries and deadline from running.
        const checked = await checkWhileReading(r, phase, builder).then((checked) => {
          retried.ok(`${r.id} check`);
          return checked;
        }, (err: unknown) => {
          retried.failed(`${r.id} check`, `review ${r.id} of ${r.builder}: the check beside the reviewer did not start and will be tried again (${(err as Error).name})`);
          return r;
        });
        if (checked !== r) return checked;
        for (const { seat, state } of heard) {
          const waited = wait(r, phase, partyAt[seat], state, null);
          if (waited !== r) return waited;
        }
        return r;
      }
      const n = roundsSpent(next);
      if (reviewerApproved(round)) {
        if (phase.check?.unrunnable !== undefined) return await checkUnrunnable(next, phase.check.unrunnable);
        // A held check, or one that waited for room, keeps its place in line.
        const { check } = phase;
        const after: Phase = check === undefined || (check.refused !== undefined && check.room === undefined) ? checking()
          : { kind: "checking", startedAt: check.startedAt, thread: check.thread, ...check.behind && { behind: check.behind }, ...check.room && { room: true, refused: check.refused! } };
        return reviewersFindings(round).length ? send({ ...next, phase: after }, "builder", () => builderNotes(next)) : { ...next, phase: after, nudges: 0 };
      }
      const asks = seatsOf(round).filter((seat) => verdictAt(round, seat)!.verdict === "changes");
      const asking = asks.length === 2 ? "Both reviewers still request" : asks[0] === "second" ? "The second reviewer still requests" : "The reviewer still requests";
      if (n >= r.maxRounds) return ranOut(next, `${asking} changes after ${n} rounds, the most this review allows.`);
      // A fix round almost always moves the head, so the check stops rather than hold a pylon through it. A result it
      // gave meanwhile is kept for a round at the same head.
      const check = checkThread(phase);
      const run = check === null ? null : checks.result(check);
      if (check !== null) checks.discard(check);
      return toBuilder(run !== null ? withRound(next, { check: { passed: run.passed, output: run.output } }) : next);
    },
    async fixing(r, phase) {
      const n = roundsSpent(r);
      const round = r.rounds.at(-1)!;
      const gate = gateFailure(round);
      const { state, answer: found } = await hear(r, "builder", fencedAnswers.fixing);
      if (found === null) return wait(r, phase, "builder", state, null);
      // A turn after the request went again that did not fail ends the model's failures in a row, though the loop may
      // still wait for the push its answer promises. An answer from before, or from the failed turn itself, does not.
      if (phase.failing !== undefined && r.since >= phase.failing.retryAt && state.ended !== null && state.failure === null) return { ...r, phase: { kind: "fixing" } };
      // Merged blocks keep an answer to an ID the builder corrected since, which answers no finding of the round.
      const answers = found.answers.filter((a) => findingsOf(round).some((f) => f.id === a.id));
      const unanswered = findingsOf(round).filter(blocks).filter((f) => !answered(f, answers));
      if (unanswered.length) return wait(r, phase, "builder", state, `Your answers leave ${unanswered.map((f) => f.id).join(", ")} without a fix or a reason to reject. Every finding needs an answer.`);
      const withAnswers = withRound(r, { answers });
      const fixed = answers.some((a) => a.action === "fixed");
      const snapshot = await read(r);
      if (snapshot.pr.state !== "open") return outside(withAnswers, snapshot.pr.state) ?? toPerson(withAnswers, "outside", `Pull request #${r.pr.number} was ${snapshot.pr.state} during the review.`);
      if (fixed && snapshot.detail.head === round.head) {
        // A push can land on GitHub a little after the turn that made it ends.
        if (state.over === null) return wait(r, phase, "builder", state, null);
        if (now() - state.over < pushGraceMs) return r;
        if (gate === null || gate.kind === "conflict") return wait(r, phase, "builder", state, `You answered that you fixed findings, but the pull request's head is still ${round.head}. Push the fixes.`);
      }
      // The reviewer cannot change a gate's result, so a failed gate at an unmoved head is the person's.
      if (gate !== null && snapshot.detail.head === round.head) {
        const answer = answers.find((a) => a.id === gate.finding.id);
        return toPerson(withAnswers, "gate", { code: gate.code, text: `${gate.pushedNothing}${answer === undefined ? "." : `: ${answer.reason}`}` }, ...gate.output === null ? [] : [gate.output]);
      }
      // Commits pushed with answers that fixed nothing are still unreviewed, so only an unmoved head skips a round.
      if (snapshot.detail.head === round.head && approves(round)) return { ...withAnswers, phase: checking(), nudges: 0 };
      // A rebase for a conflict or a failed gate that left the approved change as it was needs no reviewer.
      if (snapshot.detail.head !== round.head) {
        const carried = await carryApproval(withAnswers, snapshot.detail.head, snapshot.detail.base);
        if (carried !== null) return carried;
      }
      if (n >= r.maxRounds) return ranOut(withAnswers, `The builder pushed fixes after round ${n}, the last this review allows, so they are unreviewed.`);
      return await toReviewers(withAnswers, snapshot.detail.head, snapshot.detail.base);
    },
    async quoting(r, phase) {
      if (phase.asked === null) {
        const { detail } = await read(r);
        return send({ ...r, phase: { kind: "quoting", asked: descriptionDigest(detail.body) } }, "reviewer", (token) => quoteRequest(r, detail, token));
      }
      const { state, answer: quote } = await hear(r, "reviewer", fencedAnswers.quoting);
      if (quote === null) return wait(r, phase, "reviewer", state, null);
      const { verdict } = r.rounds.at(-1)!;
      return { ...withRound(r, { verdict: { ...verdict!, notCheckedLive: quote.notCheckedLive }, quotedFrom: phase.asked }), phase: checking(), nudges: 0 };
    },
    async checking(r, phase, builder) {
      const round = r.rounds.at(-1)!;
      // The check clones the head commit alone, so a result there, such as one from beside the reviewer, is kept, as the live check is.
      if (phase.thread === null && round.check !== null) return round.check.passed ? await checkPassed(r, round.live === undefined && await github.has(r.pr.repo, round.head, ".nexus/verify")) : gateFailed(r, r);
      if (phase.room === undefined && phase.behind === undefined && now() - phase.startedAt > checkMs) return toPerson(r, "no-verdict", { code: "check-failed", text: `.nexus/check gave no verdict within ${checkMs / 60_000} minutes at ${round.head}.` });
      const step = await stepGate(r, "check", phase, builder);
      if (step.kind === "ended") return step.review;
      if (step.kind === "run") return step.run === phase ? r : { ...r, phase: { kind: "checking", ...step.run } };
      if (step.kind === "unrunnable") return await checkUnrunnable(r, step.output);
      // Read while the check thread is held, so a read that fails is retried with the check's result. A landing tried
      // again keeps the round's live check, which ran at the same head.
      const verifies = step.passed && round.live === undefined && await github.has(r.pr.repo, round.head, ".nexus/verify");
      const next = withRound({ ...r, phase: { ...phase, thread: null } }, { check: { passed: step.passed, output: step.output } });
      const after = step.passed ? await checkPassed(next, verifies) : gateFailed(r, next);
      checks.discard(step.thread);
      return after;
    },
    async verifying(r, phase, builder) {
      const round = r.rounds.at(-1)!;
      const refused = phase.refused === undefined ? [] : [`No node could take its verify pylon: ${phase.refused}`];
      if (phase.room === undefined && phase.behind === undefined && now() - phase.startedAt > checkMs) return toPerson(r, "no-verdict", { code: "live-failed", text: `The live check gave no verdict within ${checkMs / 60_000} minutes at ${round.head}.` }, ...refused);
      const step = await stepGate(r, "live", phase, builder);
      if (step.kind === "ended") return step.review;
      if (step.kind === "run") return step.run === phase ? r : { ...r, phase: { kind: "verifying", ...step.run } };
      if (step.kind === "unrunnable") return await unrunnable(r, { code: "live-failed", text: `The live check could not run at ${round.head}.` }, liveOutput(step.output));
      const next = withRound({ ...r, phase: { kind: "verifying", startedAt: phase.startedAt, thread: null } }, { live: { kind: "ran", thread: step.thread, passed: step.passed, output: step.output } });
      // Read while the verify pylon is held, as the check's result is.
      const after = step.passed ? await checked(next) : gateFailed(r, next);
      live.discard(step.thread);
      return after;
    },
    async merging(r, phase, builder) {
      const head = r.rounds.at(-1)!.head;
      // The policy is checked again with what GitHub says now, before every attempt, so the step that merges does not
      // act on the read of the step that authorized it.
      reads.delete(prKey(r));
      const snapshot = await read(r);
      if (snapshot.pr.state === "closed") return end(r, { kind: "closed" });
      // The change the person pressed Land for is read at once, so a rebase after it can still be compared with it.
      if (r.waiver !== null && r.waiver.change === null && r.waiver.head === head) return { ...r, waiver: { ...r.waiver, change: await changeAt(r, snapshot.detail.base, head) } };
      // A landing that has authorized its merge holds the turn, which every other waits for.
      if (phase.authorized !== head) {
        const waiting = landings.ahead(r);
        if (waiting !== null) return phase.waiting === waiting ? r : { ...r, phase: { ...phase, waiting } };
      }
      // `left` is what the person's waiver does not get past, once carried to this head if its change is the one they
      // waived, and `why` why it did not carry. A landing that holds goes to the person with every hold, those it
      // waived too, so the person's next confirmation can name them all.
      const holds = async () => {
        if (snapshot.checksUnread) throw new Error("GitHub's checks for the head could not be read");
        // A landing that began before Nexus recorded what holds its head, or whose PR was retargeted since, reads them here.
        const held = await recordHolds(r);
        if (held === null) throw new Error("the pull request's head moved while its files were read");
        const all = [...landings.unauthorized(held, builder), ...holdsAt(held, { pr: snapshot })];
        const left = unwaived(held, all);
        const { review, why } = left.length && held.waiver !== null && held.waiver.head !== head ? carryWaiver(held, await changeAt(held, snapshot.detail.base, head), all) : { review: held, why: null };
        return { all, left: unwaived(review, all), review, why: why === null ? [] : [why] };
      };
      let commit: string;
      let toLand = r;
      // A retargeted PR merges another change at the same head than the one the reviewer read against its round's base.
      const { base } = r.rounds.at(-1)!;
      const retargeted = base !== undefined && snapshot.detail.base !== base;
      if (snapshot.detail.mergeCommit !== null) {
        if (snapshot.detail.head !== head) return toPerson(r, "outside", { code: "not-approved-head", text: `Pull request #${r.pr.number} merged at ${snapshot.detail.head}, not the approved ${head}, so it is not deployed.` });
        // A merge authorized into the old base does not authorize one into the new.
        if (retargeted) return toPerson(r, "outside", `Pull request #${r.pr.number} was merged outside this review into ${snapshot.detail.base}, not ${base}, the base its approval was of, so it is not deployed.`);
        // A merge this review did not authorize is someone else's, so it deploys only if the policy would have let this review merge it.
        if (phase.authorized !== head) {
          const { all, left, review, why } = await holds();
          if (left.length) return toPerson(review, "outside", `Pull request #${r.pr.number} was merged outside this review, so it is not deployed.`, ...why, ...all);
          toLand = review;
        }
        commit = snapshot.detail.mergeCommit;
      } else {
        // A head pushed after the approval, such as a rebase on the PR watch's news of a conflict, gets its own round.
        if (snapshot.detail.head !== head) return await newHead(r, snapshot.detail.head, snapshot.detail.base, `The pull request's head moved to ${snapshot.detail.head}`);
        if (retargeted) return await newHead(r, head, snapshot.detail.base, `The pull request's base changed from ${base} to ${snapshot.detail.base}`);
        // Every attempt checks the whole policy again with what GitHub says now, since checks and the PR can change
        // between attempts and branch protection may not enforce them.
        const { all, left, review, why } = await holds();
        const remedy = left.length === 1 ? remedyOf(left[0]!.code) : null;
        if (remedy === "rebase") return rebase(review, snapshot.detail.base);
        // A quote the description lost since the reviewer gave it is asked for again, once per description.
        if (remedy === "quote" && staleQuote(r.rounds.at(-1)!, snapshot.detail.body)) return { ...review, phase: { kind: "quoting", asked: null } };
        if (left.length) return toPerson(review, "policy", ...why, ...all);
        // A squash merge lands `head` on the base as it is now, so a base that moved since `head`'s check lands a
        // combination no check ran. GitHub pushes the updated head a little later, and it gets a round of its own,
        // which runs the check. An update GitHub took but never pushed is asked for again after a minute. Until then
        // nothing is authorized, so a merge of the stale head outside this review is judged as someone else's.
        if (await github.behind(r.pr.repo, snapshot.detail.base, head)) {
          if (phase.updated !== undefined && now() - phase.updated < updateGraceMs) return r;
          if (!(await github.update(r.pr.repo, r.pr.number, head))) return rebase(review, snapshot.detail.base);
          reads.delete(prKey(r));
          return { ...review, phase: { kind: "merging", authorized: null, updated: now() } };
        }
        if (phase.authorized !== head) return { ...review, phase: { kind: "merging", authorized: head } };
        const merged = await github.merge(r.pr.repo, r.pr.number, head);
        reads.delete(prKey(r));
        if (merged.kind !== "merged") {
          // GitHub may learn of a conflict only when asked to merge.
          if (merged.kind === "refused" && (await read(r)).pr.conflict === true) return rebase(r, snapshot.detail.base);
          return toPerson(review, "policy", merged.kind === "denied"
            ? `The control plane's GitHub token cannot merge (${merged.message}). Merging needs a token with write access to ${r.pr.repo}'s contents and pull requests, which only the person can grant.`
            : `GitHub refused the merge: ${merged.message}`);
        }
        commit = merged.commit;
      }
      return landings.merged(toLand, commit);
    },
    ...landings.steps,
  };

  const watchedPr = (r: Review) => {
    const watch = registry.prWatches.prWatch(r.builder);
    return reviewedPr(r, watchedPrs(watch), watchStopped(watch));
  };

  /**
   * A head pushed after the review approved its last round or held it for the person. A review that would land gets a
   * new round, as a landing does, and so does one held only for a failed check, live check or conflict after an
   * approval, which the push may answer. One the loop gave up on otherwise stays the person's, and its reasons name the
   * new head, unless its rounds ran out and the push keeps the change they judged, which keeps the hold at that head.
   */
  async function pushedAfter(r: Review, snapshot: PrSnapshot): Promise<Review | null> {
    const head = pushedHead(r, { ...snapshot.pr, head: snapshot.detail.head });
    if (head === null) return null;
    const phase = r.phase;
    if (phase.kind !== "needs-person" || landable(r) || heldForGate(r)) return await newHead(r, head, snapshot.detail.base, `The pull request's head moved to ${head}`);
    // Its reviewer is archived, so the carried round goes to no one, and its reasons stay true of the same change.
    const carried = phase.cause === "rounds" && phase.unreviewed === undefined ? await carryRound(r, head, snapshot.detail.base, true) : null;
    if (carried !== null) return carried;
    const stale: Hold = { code: "stale-head", text: `The pull request's head moved to ${head} after this review was held, so none of its rounds reviewed that commit. Run nexus review ${r.builder} to review it.` };
    return { ...r, phase: { ...phase, ...personPhase(phase.cause, ...phase.holds.filter((h) => h.code !== "stale-head"), stale), unreviewed: head } };
  }

  async function step(r: Review): Promise<Review> {
    // The person is asked once the holds are known, whatever the phase waits on, and a failed read only delays it.
    const ready = await askHolds(r).then((ready) => {
      retried.ok(`${r.id} holds`);
      return ready;
    }, (err: unknown) => {
      retried.failed(`${r.id} holds`, `review ${r.id} of ${r.builder}: its holds were not asked about and will be tried again (${(err as Error).name})`);
      return r;
    });
    if (ready !== r) return ready;
    // A review that waits on the person ends as a running one does once the person closes its PR or archives its
    // builder, before its label, which the person no longer needs, and one stopped at approval once its PR merged
    // outside it too. One that merged is held over its deploy, which neither settles.
    const held = r.phase.kind === "needs-person" && r.merged === null;
    if (held || r.phase.kind === "approved") {
      const status = registry.threads.thread(r.builder)?.status;
      if (status !== undefined && !isOpenStatus(status)) return end(r, { kind: "cancelled", who: "builder", status });
      // A watch stopped by its comment cap reads GitHub no more, so the loop asks GitHub itself whether the PR is still
      // open, as often as the watch would, and about a held review's head. One that stopped at approval leaves its head
      // to the landing, which reads GitHub before it merges.
      const capped = watchStopped(registry.prWatches.prWatch(r.builder));
      const fresh = capped && due(cappedReads, r) ? await read(r) : null;
      if (fresh !== null) cappedReads.set(r.id, now());
      const watched = watchedPr(r);
      const state = fresh?.pr.state ?? (capped ? undefined : watched?.state);
      const gone = r.phase.kind === "approved" ? outside(r, state) : state === "closed" ? end(r, { kind: "closed" }) : null;
      if (gone !== null) return gone;
      const pr = fresh !== null && held ? { ...fresh.pr, head: fresh.detail.head } : watched;
      // The PR watch reads GitHub only every two minutes, so the loop acts on what GitHub says now.
      const moved = pushedHead(r, pr) === null ? null : await pushedAfter(r, fresh ?? await read(r));
      if (moved !== null) return moved;
      // A review approved before Nexus recorded what holds its head reads them, as its checks passing would. A head
      // GitHub shows moved meanwhile is a push after the approval, whatever the PR watch read.
      if (r.phase.kind === "approved" && r.rounds.at(-1)!.heldAt === undefined && due(holdReads, r)) {
        holdReads.set(r.id, now());
        const recorded = await recordHolds(r);
        if (recorded !== null) return recorded;
        const snapshot = await read(r);
        const gone = outside(r, snapshot.pr.state) ?? await pushedAfter(r, snapshot);
        if (gone !== null) return gone;
      }
    }
    // A failed call throws, so the pass retries it. GitHub adds a label the PR has already as a no-op.
    if (r.phase.kind === "needs-person" && r.phase.label?.state === "adding") {
      const result = await github.label(r.pr.repo, r.pr.number, humanLabel);
      if (result.kind === "labelled") return { ...r, phase: { ...r.phase, label: { state: "added" } } };
      return { ...r, phase: { ...r.phase, label: { state: "failed", why: result.message }, ...personPhase(r.phase.cause, ...r.phase.holds,
        `Nexus could not add the label "${humanLabel}" to pull request #${r.pr.number} (${result.message}). Labelling needs a token that may write issues or pull requests, which only the person can grant.`) } };
    }
    if (ended(r) && r.outbox === null) return r;
    const builder = registry.threads.thread(r.builder);
    const reviewer = registry.threads.thread(r.reviewer);
    // Once merging, the landing must see its deploy through, rollback included, whatever happens to the threads.
    const landing = inLanding(r);
    const live = !landing && !ended(r);
    if (live) {
      const gone = outside(r, watchedPr(r)?.state);
      if (gone !== null) return gone;
    }
    for (const [who, t] of [["builder", builder], ...r.reviewerStarted ? [["reviewer", reviewer] as const] : []] as const) {
      if (landing || t?.status === "active") continue;
      // The loop archives a review's threads only once it can no longer use them, so here the person did.
      if (t !== undefined && !isOpenStatus(t.status)) return end(r, { kind: "cancelled", who, status: t.status });
      return toPerson(r, "thread", `The ${who} thread ${t?.id ?? ""} is ${t?.status ?? "gone"}, so the review stopped.`);
    }
    if (!r.reviewerStarted) return await startFirst(r, builder!);
    // A second reviewer gone is no approval, so the review waits on the person, who can start it again.
    const second = r.second?.kind === "claude" ? r.second : null;
    const secondThread = second === null ? undefined : registry.threads.thread(second.thread);
    // The loop archives a second reviewer once a round of both approved, and a new round starts it again.
    if (second !== null && r.phase.kind === "reviewing" && secondThread?.status !== "active") {
      return toPerson(r, "thread", `The second reviewer thread ${second.thread} is ${secondThread?.status ?? "gone"}, so the review stopped.`);
    }
    if (r.second?.kind === "starting" && r.phase.kind === "reviewing") {
      // A held start leaves the rest of the step to run, and its deadline counts from when the hold ends.
      const second = r.second;
      const behind = heldBehind(r);
      if (behind !== null) {
        if (!sameBehind(second.behind, behind)) return { ...r, second: { ...second, behind } };
      } else if (second.behind !== undefined) {
        const { behind: _, ...freed } = second;
        return { ...r, second: { ...freed, since: now(), tried: null } };
      } else if (second.tried === null || now() - second.tried >= secondRetryMs) {
        return await startSecond(r, (await read(r)).detail);
      }
    }
    // The builder's or the first reviewer's message goes before the second reviewer's.
    const to = (["builder", "reviewer", "second"] as const).find((party) => talking(r, party) && conversation(r, party).talk.outbox != null);
    if (to !== undefined) {
      const c = conversation(r, to);
      const { id, text, attempted } = c.talk.outbox!;
      if (attempted === null) return c.with({ ...c.talk, outbox: { id, text, attempted: now() } });
      const gone = live ? await endedOnGitHub(r) : null;
      if (gone !== null) return gone;
      // The save would refuse a step over a land or cancel made while GitHub answered, but the message would be gone.
      if (!registry.reviews.isCurrentReview(r)) return r;
      return await deliverDurable({ id, text }, (m) => inbox(registry.threads.thread(c.thread)!, { ...m, sender: "review" }), () => c.with({ ...c.talk, outbox: null, since: attempted })) ?? r;
    }
    const phase = r.phase;
    if (ended(r)) return r;
    const next = await (steps[phase.kind as keyof typeof steps] as (r: Review, p: Phase, b: Thread) => Promise<Review>)(r, phase, builder!);
    return live && ended(next) ? await endedOnGitHub(next) ?? next : next;
  }

  /**
   * A landed PR leaves its builder and reviewer nothing to do, and a cancelled review its reviewer, so they are
   * archived in the transaction that saves it. A thread in a turn, such as a builder answering the approval's notes,
   * stays open for a later pass.
   */
  const finished = (...ids: ThreadId[]): Thread[] => ids.map((id) => registry.threads.thread(id))
    .filter((t): t is Thread => t !== undefined && !t.working && isOpenStatus(t.status));

  /**
   * Whether `r` may still use its reviewer: while it runs, or while it waits at approval or for the person, unmerged, in
   * a way a land or a new head takes back to its rounds. Every step from there needs the reviewer open.
   */
  const usesReviewer = (r: Review) => !ended(r) || (r.merged === null && (landable(r) || heldForGate(r)));
  const reviewersOf = (r: Review): ThreadId[] => [r.reviewer, ...r.second?.kind === "claude" ? [r.second.thread] : []];

  /** A pass over the reviews whose builder, reviewer or gate thread `only` names, or over every review and the sweeps. */
  async function pass(only: ReadonlySet<ThreadId> | null) {
    reads = new Map();
    const reviews = registry.reviews.reviewsToStep();
    if (only !== null) return await stepEach(reviews.filter((r) => [r.builder, ...reviewersOf(r), gateThread(r.phase)?.thread].some((id) => id !== undefined && only.has(id))));
    // A check thread no review holds, such as one started just before a crash, has nothing left to give. So has such a
    // verify pylon, unless the person has been to it since it started, as by unarchiving it to look at what it left.
    const held = new Set(reviews.flatMap((r) => gateThread(r.phase)?.thread ?? []));
    for (const t of registry.threads.storedThreads({ status: ["active", "idle", "archived"], startedBy: checkCaller })) if (!held.has(t.id)) checks.discard(t.id);
    for (const t of registry.threads.storedThreads({ status: ["active"], startedBy: verifyCaller })) if (t.lastHumanActivityAt === t.createdAt && !held.has(t.id)) live.discard(t.id);
    // So has a reviewer its builder's current review can no longer use, as one whose review ended other than by landing
    // or was replaced, one in a turn as its review landed, or one a crash left before its review saved. A reviewer the
    // person has been to since it started is theirs. Reviewers start only in a pass, and passes run one at a time.
    // A second reviewer is never asked to quote, so a review that waits at an approval does not use it.
    const using = new Set(reviews.filter(usesReviewer).flatMap((r) => ended(r) ? [r.reviewer] : reviewersOf(r)));
    const left = registry.threads.storedThreads({ status: openStatuses, startedBy: reviewerCaller }).filter((t) => !using.has(t.id) && t.lastHumanActivityAt === t.createdAt);
    for (const t of finished(...left.map((t) => t.id))) {
      registry.threads.setThreadStatus(t.id, "archived");
      deps.wake(t);
    }
    // So has a builder whose turn ran on past its review's landing, once the turn ends, unless the person wrote to it
    // since the landing, which makes it theirs.
    for (const r of registry.reviews.landedInTurn()) {
      try {
        if (r.phase.kind !== "landed" || r.phase.inTurn === undefined) continue;
        const builder = registry.threads.thread(r.builder);
        if (builder?.working === true && isOpenStatus(builder.status)) continue;
        const { inTurn, ...phase } = r.phase;
        // A Claude worker's transcript is read apart from its turn's end, so it holds what the person wrote in that turn
        // only once a read since then ended, and since the landing for a turn whose end was never reported.
        const transcript = registry.threads.claudeWorker(r.builder) === undefined ? null : registry.threads.claudeTranscript(r.builder);
        if (builder !== undefined && isOpenStatus(builder.status) && transcript !== null && (transcript?.readAt ?? -Infinity) < Math.max(inTurn, builder.lastReplyAt ?? -Infinity)) continue;
        const theirs = builder === undefined || !isOpenStatus(builder.status) || await deps.personWrote(builder, inTurn);
        // The read yields, so a turn, an archive or a delete meanwhile decides instead.
        const fresh = registry.threads.thread(r.builder);
        if (fresh?.working === true && isOpenStatus(fresh.status)) continue;
        const archive = !theirs && fresh !== undefined && isOpenStatus(fresh.status) ? [fresh] : [];
        if (registry.reviews.saveReview({ ...r, phase }, archive.map((t) => t.id), r)) for (const t of archive) deps.wake(t);
        retried.ok(`${r.id} builder`);
      } catch (err) {
        retried.failed(`${r.id} builder`, `review ${r.id} of ${r.builder}: its landed builder was not archived and will be tried again (${(err as Error).name})`);
      }
    }
    await stepEach(reviews);
    // A review no pass steps any more, such as one saved settled outside the loop's steps, asks nothing.
    const stepped = new Set(reviews.map((r) => r.builder));
    try {
      for (const builder of registry.questions.threadsAsking(holdsPrefix)) {
        if (stepped.has(builder)) continue;
        registry.questions.replaceQuestions(builder, holdsPrefix, null);
        asked.set(builder, null);
      }
      retried.ok("drop questions");
    } catch (err) {
      retried.failed("drop questions", `the questions of reviews no pass steps were not dropped and will be tried again (${(err as Error).name})`);
    }
  }

  async function stepEach(reviews: readonly Review[]) {
    for (const stored of reviews) {
      let r = stored;
      try {
        // A step that sent a message or changed phase saves before the next one acts on it.
        for (let i = 0; i < 8; i++) {
          let next = await step(r);
          if (next === r) break;
          let archive: Thread[] = [];
          if (next.phase.kind === "landed" && r.phase.kind !== "landed") {
            archive = finished(next.builder, ...reviewersOf(next));
            const builder = registry.threads.thread(next.builder);
            if (builder?.working === true && isOpenStatus(builder.status)) next = { ...next, phase: { ...next.phase, inTurn: now() } };
          }
          // A save made while this step ran, such as the person's land or cancel, wins, and the next pass steps from it.
          // A gate thread the step started is then no review's, so it goes now rather than at the next pass's sweep.
          if (!registry.reviews.saveReview(next, archive.map((t) => t.id), r)) {
            const started = gateThread(next.phase);
            if (started !== null && started.thread !== gateThread(r.phase)?.thread) started.runs.discard(started.thread);
            break;
          }
          for (const t of archive) deps.wake(t);
          r = next;
        }
        yolo(r);
        retried.ok(`${r.id} step`);
      } catch (err) {
        retried.failed(`${r.id} step`, `review ${r.id} of ${r.builder}: a step failed and will be retried (${(err as Error).name})`);
      }
    }
  }

  function refuseIfRunning(builder: ThreadId): void {
    const existing = registry.reviews.review(builder);
    if (existing !== null && !ended(existing)) throw new Refusal("conflict", `review ${existing.id} of ${builder} is ${existing.phase.kind}${cancellable(existing) ? `. Cancel it with nexus review --cancel ${builder} to start another` : ""}`);
  }
  /**
   * One review of a PR at a time, so the rounds its reviews spend stay within the one budget each later review reads.
   * Another builder's review that ended may still take a new head back to its rounds, unless it settled.
   */
  function refuseIfReviewed(builder: ThreadId, repo: string, number: number): void {
    const other = registry.reviews.reviews().find((r) => r.builder !== builder && r.pr.repo === repo && r.pr.number === number && !settled(r));
    if (other === undefined) return;
    const next = cancellable(other) ? `. Cancel it with nexus review --cancel ${other.builder} to start another`
      : other.phase.kind === "approved" ? `. Land it with nexus land ${other.builder}, or start the review again from ${other.builder}`
      : ", and a merge or deploy that has begun is seen through. It ends landed or with the person";
    throw new Refusal("conflict", `pull request #${number} is under review ${other.id} of ${other.builder}, which is ${other.phase.kind}${next}`);
  }

  /**
   * Records a review of `pr`, a PR of the builder's, with its first request. The loop's next pass starts its reviewer
   * threads, whose starts read the remote and may take longer than the person's request waits.
   */
  async function begin(builder: Thread, { repo, number }: Pick<PullRequest, "repo" | "number">, request: { rounds?: number | undefined; land: Review["land"]; auto: boolean }): Promise<Review> {
    refuseIfReviewed(builder.id, repo, number);
    // A later review of a PR spends what the earlier ones left, unless the person grants rounds.
    const earlierRounds = registry.reviews.roundsSpentOn(repo, number);
    const rounds = request.rounds ?? maxRounds - earlierRounds;
    if (rounds < 1) throw new Refusal("conflict", `pull request #${number} has had ${earlierRounds} rounds over its reviews, and Nexus gives one ${maxRounds} without the person's word. Run nexus review ${builder.id} --rounds N to grant it N more`);
    const snapshot = await github.poll(repo, number);
    if (snapshot.pr.state !== "open") throw new Refusal("conflict", `pull request #${number} is ${snapshot.pr.state}`);
    const agent = registry.threads.agent(builder);
    const builderModel = agent.kind === "claude" ? agent.worker.model ?? defaultClaudeModel : deps.harnessModel;
    const project = registry.projects.project(builder.project)!;
    const kind = reviewerFor({ claude: agent.kind === "claude", model: builderModel }, project.secrets, deps.harnessModel);
    if ("why" in kind) throw new Refusal("conflict", kind.why);
    const models = { builder: builderModel, reviewer: kind.model };
    // A later round whose head the rule names gets a second reviewer then, which stays for every round after it.
    const rule = project.secondReview == null ? null : secondReviewRule(project.secondReview, await github.files(repo, number), deploys({ pr: { repo } }));
    const brief = await deps.brief(builder).then((text) => text?.slice(0, 8_000) ?? null, (err: unknown) => {
      log(`${builder.id}: the review of pull request #${number} starts without the builder's brief, which could not be read (${(err as Error).name})`);
      return null;
    });
    const id = `rv-${randomBytes(4).toString("hex")}`;
    const expect = mint(id);
    const second = rule === null ? {} : { second: secondFor(rule, models, project.secrets) };
    const pr = { repo, number, url: snapshot.pr.url, title: snapshot.pr.title, branch: snapshot.detail.branch };
    const asked = reviewerRequest({ pr, models, brief }, snapshot.detail, expect, kind.model);
    const at = now();
    const started: Review = {
      id, expect, sent: 0, builder: builder.id, reviewer: newThreadId(), reviewerStarted: false, pr, models, reviewerKind: kind.claude ? "claude" : "harness",
      maxRounds: rounds, earlierRounds, land: request.land, auto: request.auto, brief, ...second,
      rounds: [{ head: snapshot.detail.head, base: snapshot.detail.base, ...verdictsFor(seatsFor(second)), check: null, answers: null }], merged: null, waiver: null, phase: { kind: "reviewing" }, outbox: null,
      since: at, nudges: 0, startedAt: at, asked,
    };
    // A Claude reviewer's first request is its first prompt, which still takes the first message's number.
    const review = kind.claude ? { ...started, sent: 1 } : resend(started, "reviewer");
    // Again, since another start of the PR may have recorded its review while this one read GitHub.
    refuseIfReviewed(builder.id, repo, number);
    refuseIfRunning(builder.id);
    registry.reviews.saveReview(review);
    void poll();
    return review;
  }

  /**
   * A reviewer's thread on `model`, started near the builder with its first request: a Claude worker's first prompt,
   * or else the harness reviewer's first message, which its review sends.
   */
  const startReviewer = (builder: Thread, title: string, branch: string, model: string, claude: boolean, request: string, id?: ThreadId) => deps.startThread({
    request: { project: builder.project, title: title.slice(0, 200), near: registry.threads.pylon(builder.pylonId)!.node, branch, ...(claude ? { claude: request, model } : {}) },
    caller: reviewerCaller, role: "reviewer", id,
  });
  /**
   * The first reviewer's thread, under the ID its review was recorded with, unless a start that went through before a
   * crash made it. A refused start, such as of a branch the remote no longer has, holds the review for the person, and
   * one that fails otherwise, as while the harness is down, is tried each pass until `secondStartMs` after its request,
   * `since`. A review that started on its own waits while another review's gate pylon waits for room, and its request
   * dates from when that ends. One the person started never waits.
   */
  async function startFirst(r: Review, builder: Thread): Promise<Review> {
    if (registry.threads.thread(r.reviewer) === undefined) {
      const behind = r.auto ? heldBehind(r) : null;
      if (behind !== null) return sameBehind(r.behind, behind) ? r : { ...r, behind };
      // The second reviewer's 30 minutes, which start with the review, count from the end of the hold too.
      if (r.behind !== undefined) {
        const { behind: _, ...freed } = r;
        return { ...freed, since: now(), ...freed.second?.kind === "starting" && { second: { ...freed.second, since: now() } } };
      }
      try {
        await startReviewer(builder, `Review of #${r.pr.number}: ${r.pr.title}`, r.pr.branch, r.models.reviewer, r.reviewerKind === "claude", r.asked, r.reviewer);
      } catch (err) {
        if (err instanceof Refusal) return toPerson(r, "thread", `The reviewer thread ${r.reviewer} did not start: ${err.message}.`);
        if (now() - r.since < secondStartMs) throw err;
        return toPerson(r, "thread", `The reviewer thread ${r.reviewer} did not start within ${secondStartMs / 60_000} minutes: ${(err as Error).message}.`);
      }
    }
    const { behind: _, ...started } = r;
    return { ...started, reviewerStarted: true };
  }
  /** An independent second reviewer for `rule` on the default Claude model, to start, or why none can run. */
  const secondFor = (rule: string, models: Review["models"], secrets: Project["secrets"]): SecondReviewer => {
    const model = secondReviewerFor([models.builder, models.reviewer], secrets);
    return "why" in model ? { kind: "none", rule, why: model.why } : starting(rule, model.model);
  };
  const starting = (rule: string, model: string): SecondReviewer => ({ kind: "starting", rule, model, since: now(), tried: null, why: null });
  /**
   * The starting second reviewer's thread, with the first request at the round's head. A start refused, as when no
   * node has room, or that failed otherwise, is tried again a minute later, and one that has not started within `secondStartMs` gives up, so
   * the round goes on with the first reviewer alone and the landing holds for the person.
   */
  async function startSecond(r: Review, detail: Pick<PrSnapshot["detail"], "head" | "base" | "body">): Promise<Review> {
    const second = r.second as Extract<SecondReviewer, { kind: "starting" }>;
    const round = r.rounds.at(-1)!;
    const expect = mint(r.id);
    const asked = reviewerRequest(r, { ...detail, head: round.head, base: round.base ?? detail.base }, expect, second.model);
    const builder = registry.threads.thread(r.builder)!;
    try {
      const thread = await startReviewer(builder, `Second review of #${r.pr.number}: ${r.pr.title}`, r.pr.branch, second.model, true, asked);
      return { ...r, second: { kind: "claude", rule: second.rule, thread: thread.id, model: second.model, expect, asked, since: now(), nudges: 0, outbox: null } };
    } catch (err) {
      // A start fails before it records the thread, so trying again later starts none twice.
      const why = (err as Error).message;
      if (now() - second.since < secondStartMs) return { ...r, second: { ...second, tried: now(), why } };
      const { secondVerdict: _, ...alone } = round;
      return { ...r, second: { kind: "none", rule: second.rule, why: `its thread did not start within ${secondStartMs / 60_000} minutes: ${why}` }, rounds: [...r.rounds.slice(0, -1), alone] };
    }
  }

  return {
    poll,
    /** Steps the reviews thread `id` takes part in now rather than at the next poll, as after its turn or its check ended. */
    wake,
    deploys,
    async close() {
      closed = true;
      await passes.settled();
    },

    async start(builderId: ThreadId, request: { pr?: number | undefined; rounds?: number | undefined; land: string | null }): Promise<Review> {
      const builder = registry.threads.thread(builderId);
      if (builder === undefined) throw new Refusal("missing", `no thread ${builderId}`);
      if (builder.status !== "active") throw new Refusal("conflict", `thread ${builder.id} is ${builder.status}`);
      if (registry.reviews.isReviewer(builder.id)) throw new Refusal("conflict", `thread ${builder.id} is a reviewer`);
      refuseIfRunning(builder.id);
      const open = (registry.prWatches.prWatch(builder.id)?.links ?? []).filter((l) => l.pr.state === "open" && (request.pr === undefined || l.pr.number === request.pr));
      if (open.length === 0) throw new Refusal("conflict", `thread ${builder.id} has no open pull request${request.pr === undefined ? "" : ` #${request.pr}`} that the PR watch linked`);
      if (open.length > 1) throw new Refusal("conflict", `thread ${builder.id} has ${open.length} open pull requests, so name one: ${open.map((l) => `#${l.pr.number}`).join(", ")}`);
      return await begin(builder, open[0]!.pr, { rounds: request.rounds, land: request.land === null ? null : { requestedBy: request.land }, auto: false });
    },

    /**
     * Starts a review of a PR the PR watch has just linked, when the builder's project asks for it, and lands it when
     * the project says so. It never starts for a thread the loop started, nor twice for one PR, so a review that ended
     * stays ended until the person starts one. A refusal, such as no reviewer on another model, is logged and final.
     */
    async auto(t: Thread, pr: Pick<PullRequest, "repo" | "number">): Promise<void> {
      const setting = registry.projects.project(t.project)?.autoReview;
      if (setting == null || servesReview(threadRole(registry, t))) return;
      // Another thread on the same branch links the same PR, which has had its review, even one its builder's next replaced.
      if (registry.reviews.prReviewed(pr.repo, pr.number)) return;
      try {
        refuseIfRunning(t.id);
        await begin(t, pr, { land: landsOnItsOwn(setting) ? { requestedBy: setting.enabledBy, fromProject: true } : null, auto: true });
      } catch (err) {
        if (!(err instanceof Refusal)) throw err;
        log(`${t.id}: no review started on its own for pull request #${pr.number}: ${err.message}`);
      }
    },

    /**
     * Lands an approved review, or tries again one the policy held, such as after the PR's description changed or the
     * person granted the merge token. A check that passed at the head is kept, and one that did not runs again first.
     * A PR that already merged is held by the policy, so a land never deploys twice. `head`, when given, is the commit
     * the person confirmed, so a review that moved on meanwhile is not landed in its place. The holds the person
     * `waive`s, each one the review has now and the policy lets them waive, no longer hold the landing at that head, and
     * the event log records the waiver. A press the policy's rule says no landing takes is refused, and one that needs
     * the reviewer's quote of what could not be checked live asks the reviewer for it first, at the same head.
     */
    land(builderId: ThreadId, requestedBy: string, head?: string, waive?: readonly string[]): Review {
      const r = landableAt(builderId);
      if (head !== undefined && r.rounds.at(-1)!.head !== head) throw new Refusal("conflict", `review ${r.id} of ${builderId} is at ${r.rounds.at(-1)!.head}, not ${head}, so it was not landed. Look at it again before landing it`);
      const next = pressed(r, requestedBy, waive);
      // A press that waives the holds the review's question names answers it, as its Land does.
      savePress(r, next, requestedBy, waive === undefined ? undefined : openQuestion(r, waive),
        new Refusal("conflict", `review ${r.id} of ${builderId} moved on while it was landed. Look at it again`));
      return next;
    },

    /**
     * Records the person's answer to a question about a review's holds. Land is a Land press waiving the holds the
     * question names, so the review lands once the reviewer approves and its checks pass. Leave it waives nothing.
     */
    answerHolds(question: HoldsQuestion, option: string, by: TailnetNodeId): HoldsQuestion {
      if (!isOpen(question) || option !== landOption) return registry.questions.answerQuestion(question, { option, by, at: now() });
      return landHolds(question, by);
    },

    /**
     * Ends a running review, or one that waits on the person, for the person, and archives its reviewer. The builder is
     * the person's, and stays as it is.
     */
    cancel(builderId: ThreadId, by: string): Review {
      const r = registry.reviews.review(builderId);
      if (r === null) throw new Refusal("conflict", `thread ${builderId} has no review`);
      if (ended(r) && r.phase.kind !== "needs-person") throw new Refusal("conflict", `review ${r.id} of ${builderId} already ended ${r.phase.kind}, so there is nothing to cancel`);
      if (!cancellable(r)) throw new Refusal("conflict", `review ${r.id} of ${builderId} is ${r.phase.kind}, and a merge or deploy that has begun is seen through, so it cannot be cancelled. It ends landed or with the person`);
      const next = end(r, { kind: "cancelled", who: "person", by });
      const archive = finished(...reviewersOf(r));
      registry.reviews.saveReview(next, archive.map((t) => t.id));
      ask(r.builder, null);
      for (const t of archive) deps.wake(t);
      return next;
    },
  };

  /**
   * The Land answer to a question about a review's holds, by `by`: on a review the land route takes, the press itself,
   * and on one still under review at the question's head, the waiver and the landing request alone. `yolo` is the
   * project whose setting answered it in the person's place.
   */
  function landHolds(question: HoldsQuestion, by: TailnetNodeId, yolo?: ProjectId): HoldsQuestion {
    const { holds } = question;
    const r = registry.reviews.review(question.thread);
    const moved = new Refusal("conflict", `the review of ${question.thread} moved on since question ${question.id} asked about its holds at ${holds.head}, so nothing was waived. Look at it again`);
    if (r === null || askingHolds([question], r.id, r.rounds.at(-1)) === undefined) throw moved;
    // The loop asked about these holds at this head and base, which may come from the change before the round
    // recorded them, so the waiver is the question's, and the landing reads the head's holds again before it merges.
    const waiver = { ...waiverOf(r, by, holds.holds.map((h) => h.text), holds.holds.map((h) => h.code)), ...yolo !== undefined && { yolo } };
    let next: Review;
    // A landing the project asked for stays the project's when its setting answers, so switching the setting off holds it again.
    if (landable(r)) next = { ...pressWith(landableAt(question.thread), by, waiver), ...yolo !== undefined && r.land?.fromProject && { land: r.land } };
    else {
      const builder = registry.threads.thread(r.builder)!;
      if (builder.status !== "active") throw new Refusal("conflict", `thread ${r.builder} is ${builder.status}`);
      if (ended(r) || landingVerb(r) !== null) throw new Refusal("conflict", cannotLand(r, builder, watchedPr(r))!);
      pressOn(r);
      next = { ...r, land: r.land ?? { requestedBy: by, head: holds.head, base: holds.base }, waiver };
    }
    return savePress(r, next, by, question, moved)!;
  }

  function landableAt(builderId: ThreadId): Review {
    const r = registry.reviews.review(builderId);
    if (r === null) throw new Refusal("conflict", `thread ${builderId} has no review. Start one with \`nexus review ${builderId} --land\``);
    const refusal = cannotLand(r, registry.threads.thread(builderId)!, watchedPr(r));
    if (refusal !== null) throw new Refusal("conflict", refusal);
    return r;
  }
}
export type ReviewLoop = ReturnType<typeof reviewLoop>;
