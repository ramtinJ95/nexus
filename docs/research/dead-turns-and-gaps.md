# Dead turns and link gaps

The detail behind [PR 672](https://github.com/ramtinJ95/nexus/pull/672): what each requirement became, what a gap between a node and the control plane does, what is left, and what proves it. The rules themselves live in [Turns that died](../cli.md#turns-that-died) and [Resuming a turn that died](../design.md#resuming-a-turn-that-died).

## The rules, by requirement

1. **Who answers a death.** Only the person's message written after a death answers it. That record becomes `answered`, and Nexus sends no resume. A message written before the death answers nothing, so a conductor who steers builders keeps their resumes. `left-alone` is gone, and a stored one reads as no record. The waits of 1, 10 and 30 minutes stay, and the fourth death in a row still goes to the person.
2. **A death Nexus does not resume is told.** It gets a `person` record whose `why` starts `Its turn died (<reason>).`, and a new `died` attention while that death stands. `died` ranks after `decision` and before `parked`, `limited` and `reply`. It covers every reason: four deaths in a row, a death more than an hour old (skipped silently before), a resume that could not be typed in, and a resume or a person's message that started no turn within 10 minutes. `nexus threads` shows `died`. `nexus show` prints `turn died, and Nexus does not resume it: <why>`. `nexus watch --until-idle` exits 12 with the why. The dashboard row and Needs you card read "Its turn died".
3. **The idle rule and a waiting resume.** Before this PR the pylon paused at 5 minutes. The resume's inbox send woke it at 10 or 30, and the resumed turn found its background jobs gone. Now a resume in `waiting`, `sending`, `resumed` or `answered` holds its pylon up from when the wait began until 10 minutes past its due time. It uses the same hold a review's wait uses, so placement can still take that room under pressure.
4. **A gap.** See below.
5. **An accepted message is delivered, or the thread says so.** The root cause is that a turn its pylon stopped under was never a death. A pause or a reboot ends the Claude session without its `SessionEnd` hook, so the turn just went quiet. Now an open turn (no end reported, transcript shows no end) dies when its pylon is seen stopped. A pylon running on a boot more than a minute after the turn started counts too. That turn no longer counts as working. The resumer then resumes it, or it shows as `died`. A Claude launch the probe answers records its turn, stamped one minute before the launch was sent, so the turn's own hooks replace that stamp. A pause before those hooks arrive (the PR 670 case) still cuts a turn Nexus knows of. Two new columns, `turn_ended_at` and `turn_beat_at`, hold the pylon-clock time a turn ended and when it last reported running. The migration leaves a turn open only if its session's latest report is a turn start or a heartbeat.

## What a gap does, before and after

The control plane drops the link after 90 s of silence and marks the node offline 30 s later. Being offline fails or pauses nothing. Reports wait in the probe journal (20 per pylon, 100 per node) and are applied in order on reconnect. The event log stamps them with their receipt time, which is why tonight's six `turn-ended` events read 00:37.

| Gap | Before | After |
|---|---|---|
| 1 min | Late, in order. Nothing lost. | Same. |
| 15 min | A resume due in the gap that could not be typed for 10 minutes, or a typed resume whose turn start was held in the journal, went to the person. | The 10-minute deadlines start again while the node is offline. |
| 60 min | The 30-minute TTL pruned a running turn's row, and the replayed heartbeats were dropped. The turn read idle and the pylon could be paused mid-turn. A death over an hour old by the pylon's clock was skipped silently. A busy pylon's heartbeats could evict its turn ends from the journal. | A heartbeat of a turn the session order still has open revives its row. A death over an hour old is told as `died`. The probe journal keeps only the newest heartbeat per session. |
| Internet down, link up | Resumes at +1, +10 and +30 min, then the person. | Same. That limit stops a resume loop in a provider outage, and it stays. The pylon is now held through the waits. |

Left as findings, too large or out of scope here:
- **Journal overflow.** A pylon that sends more than 20 non-heartbeat reports during a gap still loses its oldest ones. The control plane's receipt jumps past them unnoticed. Trigger: a long gap with many turns.
- **Lost job results.** The probe keeps job results for 10 minutes, so a job that finished more than 10 minutes before reconnect comes back `expired`, without its failure text (`src/probe/jobs.ts`).
- **Docker sequence reset.** The Docker probe's in-memory journal starts again at sequence 1 after a restart, and the stored receipt is never reset, so reports are dropped until the sequence passes it. Docker backend only.
- **Freshness clock.** Freshness still runs from the pylon's clock. A death reported more than an hour after it happened is now told, not resumed.
- **Nudger.** `nudge.ts` still has its own `left-alone` for good. A steered builder that stops short of a PR reads as `reply`, which is true, but it is never nudged. Same fix shape. Not done here.

## Decisions that are the owner's

- **A new `died` attention value**, rather than reusing `decision`. The brief asked for the attention to say the turn died. This is a contract change, so `version` goes to 0.89.0 with a changelog entry. An older CLI prints `died` as is.
- **Hold the pylon up while a resume waits**, rather than letting it pause and wake. A waiting builder keeps its background jobs. The cost is up to 40 minutes of a VM's memory per waiting builder, and placement can still take that room.
- **A death the person answered** gets 10 minutes for their message to start a turn. Then it is told as `died`.
- **60 seconds of clock skew** is allowed between a pylon and its host before a boot cuts a turn.
- **After deploy**, a builder paused today with a turn still open shows `died`, as more than an hour old. That is true. It is also new noise on the first day.

## Evidence

Each test below fails on `main` and passes here. I ran this branch's test files against a clean `main` worktree.
- `resume.test.ts`: a builder the person wrote to before its death is resumed. A death the person answered, whose message starts no turn, is told as died. A stored left-alone thread is resumed. A death over an hour old is told. A first prompt a pause cut before its hook arrived is resumed after the wake. A batch of reports a 60-minute gap held back keeps a turn working and resumes the deaths in it. The 10-minute deadlines count only online time. A death seen while stopped survives a quick boot. The hold survives offline time and an old waiting record.
- `loop.test.ts`: through the real planner loop, a builder whose resume waits 10 minutes is not paused at 9 minutes, and pauses once the hold is over.
- `events.test.ts`: the journal keeps one heartbeat per session.
- `nexus-threads.test.ts` and `nexus-watch.test.ts`: `threads` and `show` say `died`, and `watch` exits 12 with the why.

Rewritten tests that pinned the old behaviour: "the person writing to the thread after its first reply leaves it alone", "a person's message seen while the turn it started runs keeps the thread theirs", "a death more than an hour old is left alone", the `decision` assertions of the count and no-turn tests, the watch exit-11 test, and the dashboard card test. The journal cap test now fills the journal with turn ends instead of heartbeats, which still exercises the cap. The test fixture's default `bootedAt` moved from 2027 to 1970, because a pylon cannot boot after its own turns. Three seal tests that used the old literal now use the constant.

**Repository checks.** `npm run typecheck` passes. `npm test` gives 3086 of 3086 on the rebased head, run beside the typecheck as `.nexus/check` runs them.

**Real pylon.** None. The verify-nexus stack's first image build pulls `node:24-bookworm-slim` and Herdr Core from hosts this pylon's network policy blocks, and its scripted model drives pi threads, not Claude workers. Everything above is proven in unit and loop tests with a fake probe.

## Review

A shepherdr `reviewer` (pi) found four issues. I accepted all four and added a test for each that fails without its fix.
1. The launch's turn was stamped at the control plane's receipt time, so earlier real hooks could not replace it and a finished turn read as cut. It is now stamped a minute before the launch is sent.
2. A boot within the 60-second margin forgot a death seen while the pylon was stopped. Seeing a pylon stopped now writes `died_at` and drops its turn rows.
3. Restarting a deadline while offline also moved the hold's start, which dropped the hold. Every record now carries a fixed `from`.
4. A `waiting` record from the old release had no hold start. It is now held from its death.

I rejected none.


## Upgrade

The migration that adds `turn_ended_at` and `turn_beat_at` fills them from each worker's `session_order`. It leaves a turn open, so that it can still die, in two cases: its session's latest report is a turn start or a heartbeat, or a `session.ended` during the turn was recorded as its death (`died_at >= turn_at`). Every other turn counts as ended. The second review found that the first version of the migration closed a recorded death, which hid it after the deploy. `resume.test.ts` now upgrades a registry from the version before the migration, with one unrecorded death and one waiting resume, and both are resumed.
