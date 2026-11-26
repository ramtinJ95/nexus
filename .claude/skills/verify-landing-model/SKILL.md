---
name: verify-landing-model
description: Model-check the order in which Nexus reviews merge, deploy and roll back, with a TLA+ model of the landing turn. Use before and after any change to how a review takes its turn to merge, to what a landing deploys or rolls back to, to `releaseOutcome`, or to who may set the desired release, in `src/control/review.ts`, `src/control/landing.ts`, `src/protocol/deploy.ts`, `src/control/api/release-routes.ts` or the deployer's plan. Tests cover the cases someone wrote. This checks every order of steps.
---

# Verify the landing model

A landing is a review that merges its pull request and, for Nexus's own repository, deploys the merge and rolls back if the deploy fails. Several landings, the person, GitHub and the fleet's deployer all act between two steps of the review loop. The unit tests in `src/control/review.test.ts` each walk one order of those steps. This skill checks every order, in a small TLA+ model, against five rules.

The model is hand-written. It proves the rules for what it describes, so a pass means something only while the model describes the code. Keeping it in step is part of every change to the covered code.

## The rules

| Rule | In plain words | Harm when it breaks |
|---|---|---|
| `OneLandingAtATime` | Landings that deploy merge and deploy one at a time. | Two undeployed merges reach the release branch together, and a failed deploy cannot say which one caused it. |
| `RollbackTargetWasHealthy` | A deploy rolls back only to a release that every service once reported healthy. | A failed deploy "rolls back" to a release that never ran, and the fleet may end on a second broken release. |
| `DeploysOnlyApprovedHead` | A review deploys only a merge of the commit its last round approved. | Code that no reviewer read and no check ran reaches the fleet. |
| `ReleaseIsOnTheReleaseBranch` | The desired release is always a commit of the branch the deployer releases from. | The deployer refuses the release, the deploy fails, and every other landing waits behind it. |
| `BlockedLandingIsSomeonesToFix` | When a landing waits on a release the fleet gave up on, a review is with the person or the person requested that release. | Landings wait without end and nobody was told. |

`TypeOK` and the absence of a state with no step out are checked too.

## Run the check

```sh
node .claude/skills/verify-landing-model/scripts/check.mjs
```

It needs Java 11 or later on the path, or `JAVA` set to a java binary. The first run downloads TLC 1.7.4 to `~/.cache/nexus-verify-landing-model/` and compares its SHA-256 with the one pinned in `coverage.json`. Set `TLA2TOOLS` to a copy of that jar to skip the download. A full run takes about 10 seconds.

A pylon has no Java and reaches only the hosts its project allows, so the check does not run in a pylon as it is built today. Run it on a developer machine. If you are in a pylon and cannot run it, say so in the pull request. Do not claim the check.

The script runs the four configs in `model/` and compares each with what `coverage.json` expects. It first says whether a covered file differs from the content the model was last confirmed against.

| Exit code | Meaning |
|---|---|
| 0 | Every check gave the expected result, and the covered files are as confirmed. |
| 1 | A check differs. |
| 2 | The checks could not run. |
| 3 | Every check gave the expected result, but a covered file changed since the model was confirmed. The pass does not yet count. |

A config may be expected to break a rule. It is a finding, kept failing so that a fix shows up as a change. None is open now.

## What the model covers

All of it is `model/Landing.tla`. Each action there has a comment that names the code it stands for. One action is one step of the review loop, which saves before the next step, or one thing done between two steps by the person, GitHub or the deployer.

| Code | In the model |
|---|---|
| `merge()` in `src/control/review.ts` | `Wait`, `Authorize`, `BaseMoved`, `GiveTurnBack`, `Merge`, `MergeThenCrash`, `OwnMergeSeen`, `OthersMergeSeen`, `MergedAtOtherHead`, `NewRound`, `Held` |
| `checked()`, `newHead()`, `pushedAfter()`, `landableAt()` and `pressWith()` in `src/control/review.ts` | `Approve`, `NewRound`, `HeldNewHead`, `PersonLand` |
| `stepEach()` and `pass()` in `src/control/review.ts`: passes run one at a time and each step is saved before the next | every review action is one indivisible step |
| `deploys`, `ahead()`, `rollbackTarget()`, `turnLost()`, `merged()`, `requestRelease()` and `steps` in `src/control/landing.ts` | `Deploys`, `Ahead`, the rollback target that `Authorize` and `OthersMergeSeen` save, `TurnLost`, `MergedEffects`, `RequestDeploy`, `DeployHealthy`, `DeploySuperseded`, `DeployFails`, `RequestRollback`, `RolledBack`, `RollbackFails` |
| the `phases` table and `landingVerb()` in `src/control/review-model.ts` | `InLanding` |
| `releaseOutcome()` in `src/protocol/deploy.ts` | `Outcome` |
| `setDesiredRelease()` in `src/control/release-store.ts` | `SetDesired` |
| the deploy route in `src/control/api/release-routes.ts` | `PersonDeploy` |
| `planDeploy()` and `quarantined()` in `src/deploy/plan.ts`, `reconcileRole()` in `src/deploy/worker.ts`, `checkoutMerged()` in `src/deploy/install.ts` | `InstallOk`, `InstallFails`, `InstallFailsStuck` |

`coverage.json` records the covered files, each with the SHA-256 of the content the model was last confirmed to describe, and `syncCommit`, the commit of `main` that content builds on. The digests survive a squash merge, which gives a change a commit hash it could not have known.

### Bounds and assumptions

- Two reviews, each asked to land a pull request of Nexus's own repository. Each pull request has at most two heads. The person runs `nexus deploy` at most once.
- The fleet is one unit. It installs the desired release, fails and stays on what it ran, or fails and is left on the new release, unhealthy. It tries a failed request again only when the release is requested again.
- A deadline that passes is a step that may happen at any time while a deploy is pending.
- A report from the fleet counts for the request that is desired when it arrives.

### Left out

- The rounds of a review: reviewers, findings, the checks, the live check and the quote. `Approve` stands for all of them.
- Which holds apply and what a waiver covers. `Held` stands for any hold or refusal that sends a landing to the person.
- The drain of the control plane during a deploy, more than one node, and the order of the control and probe roles.
- A report that goes stale after 90 seconds, and a failure report made for an earlier request of the same commit that arrives after a new request.
- Whether a waiting landing is served in the end. The model checks no liveness rule.
- A pull request of another repository, which merges without a deploy.
- A turn saved before Nexus recorded the release it was taken at, which rolls back to the desired release as before.
- A round saved before Nexus recorded its base, which deploys, as every landing of Nexus's repository did then.

A pass says nothing about any of these.

## Findings in the confirmed code

None is open. Each was replayed against the real review loop with a temporary test in `src/control/review.test.ts`, then fixed and retired.

- **F1.** A manual deploy became a landing's rollback target.
- **F2.** A landing into another branch of Nexus's repository set the desired release, which `checkoutMerged()` refuses. `deploys` now also compares the base, and `BaseChecked` is `TRUE` in every config.

## Each rule was seen to fail

A rule that never failed proves nothing. When the model was written, each rule broke on a model changed the way the named code could be broken.

| Change | Rule that broke |
|---|---|
| `Ahead` ignores other landings | `OneLandingAtATime`, `RollbackTargetWasHealthy` |
| `Ahead` ignores an unhealthy desired release | `RollbackTargetWasHealthy` |
| `OthersMergeSeen` accepts a merge at any head | `DeploysOnlyApprovedHead` |
| `Merge` saves the desired release after the merge as the rollback target, as `merged()` did before finding F1 was fixed, with one manual deploy | `RollbackTargetWasHealthy` |
| `BaseChecked = FALSE` with a pull request off the release branch, as `deploys` did before finding F2 was fixed | `ReleaseIsOnTheReleaseBranch` |
| `RollbackFails` ends the review as landed | `BlockedLandingIsSomeonesToFix` |

## When you change covered code

1. Run the check before you change anything. Note the result.
2. Find each action whose comment names the code you change. Read the action beside the code.
3. Change the model to say what the code now does. Write it from the code, before you run anything. One step that is saved in the code is one action in the model. If your change makes one saved step into two, or puts an `await` between a read and the write that depends on it where another caller can act, split the action.
4. Run the check.
5. When every check gives the expected result, read the diff of every covered file that the script lists as changed, and confirm that the model describes it. Only then run the script with `--confirm`, which records the new digests and the commit of `main` that your branch builds on. Run the check once more. It must exit 0. Add a file to `covers` when your change makes new code part of the protocol.

Change a rule only when the code's promise changed on purpose, and say in the pull request what the old and the new promise are. Never weaken a rule, drop an action, or shrink a bound to make a check pass.

## When a check differs

Read the result with the pstack `/statechart` skill. Give it `model/Landing.tla`, the config that differs, and the view `model/view.mjs`. It reports the shortest path to each broken rule in plain words. TLC's raw output for each config is in the folder that the script prints.

Then replay the path against the real code, one step for each action, as a test in `src/control/review.test.ts`. The fixture there has what the path needs: `released()` and `healthy()` set the release, `approved()` runs a review to its landing, `f.mergeAnswer` runs code during the merge call, `f.snapshot` is the pull request as GitHub shows it, and `secondBuilder()` adds a second landing.

- **A step cannot happen in the code.** The model is wrong. Fix the model, and say what was wrong.
- **Every step happens and the rule is broken in the code.** It is a bug. Report the path in the code's words and the harm. Do not change the rule. Fix the code only if that is your task.
- **A finding config now holds.** If the code was fixed and the model updated to describe the fix, retire the finding. Set the model to describe the fix in every config, add the broken rule to every config that left it out, delete the finding's config and its entry in `coverage.json`, and list it as fixed under the findings. F1 and F2 were retired that way. If the model changed for another reason, the model lost the path. Find out why before you accept it.

## The chart

`model/Chart.cfg` is a small config for one landing with one manual deploy. With the view `model/view.mjs`, the pstack `/statechart` skill draws it as a chart of a landing's life, from approval to deployed or held. `chart.md` holds the chart as last drawn. Draw it again after a change to the model, replace `chart.md`, and show it to the person who decides whether the behavior is right.

## Upkeep

After merges or refactors that touched the covered files without this skill, the check exits 3. Run the pstack `/maintain-formal-verification-skill` skill. It reads every commit since `syncCommit` and says for each check whether the model drifted or the code broke the rule.
