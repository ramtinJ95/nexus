---------------------------- MODULE Landing ----------------------------
(* The landing turn and the deploy and rollback path of Nexus reviews.     *)
(* Each action is one step of the review loop, saved before the next one,  *)
(* or one thing a person, GitHub or the deployer does between two steps.   *)
(* The comment on each action names the code it stands for.                *)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Reviews,        \* reviews that were asked to land, each of one pull request of Nexus's own repository
  OffBranch,      \* the reviews whose pull request's base is not the branch the deployer releases from
  BaseChecked,    \* TRUE when `deploys` in src/control/landing.ts also requires the release branch as the base
  MaxHead,        \* how many heads a pull request can have
  PersonDeploys   \* how many times the person runs `nexus deploy` by hand

VARIABLES
  phase,          \* Review.phase.kind, with the rounds, checks and quote folded into "review"
  auth,           \* phase.authorized is the round's head (a merging review holds the turn)
  waiting,        \* phase.waiting is set (the review said why it has no turn)
  round,          \* the head of the review's latest round
  requested,      \* phase.requested of a deploying or rolling-back review
  previous,       \* phase.previous, the release a failed deploy rolls back to, saved with the turn
  merged,         \* Review.merged is set
  prHead, prOpen, prMergedHead,   \* the pull request on GitHub: its head, open or not, and the head it merged at (0: not merged)
  desired, desiredBy, result,     \* the desired release, who requested it, and what the fleet reported for that request
  running, healthy,               \* the release the fleet runs and whether it is healthy
  everHealthy,    \* history: the releases every service once reported healthy
  deploysLeft

reviewVars == <<phase, auth, waiting, round, requested, previous, merged>>
prVars == <<prHead, prOpen, prMergedHead>>
relVars == <<desired, desiredBy, result>>
unitVars == <<running, healthy, everHealthy>>
vars == <<reviewVars, prVars, relVars, unitVars, deploysLeft>>

None == "none"
C0 == "c0"        \* the release that runs at the start
X == "x"          \* a commit on the release branch that the person deploys by hand
\* The merge commit of review r's pull request is named r.
Commits == {C0, X} \cup Reviews
OnBranch(c) == c \notin OffBranch

\* landing.ts `deploys`: only a pull request of the repository releases come from, into the release branch, deploys once it merges.
Deploys(r) == IF BaseChecked THEN r \notin OffBranch ELSE TRUE

\* review-model.ts `landingVerb`: a landing that can no longer be stopped.
InLanding(r) == (phase[r] = "merging" /\ auth[r]) \/ phase[r] \in {"deploying", "rollingBack"}

\* protocol/deploy.ts `releaseOutcome`, with one fleet unit.
Outcome(c) == IF desired # c THEN "superseded"
              ELSE IF result = "failed" THEN "failed"
              ELSE IF result = "healthy" THEN "healthy" ELSE "pending"

\* landing.ts `ahead`: why r may not merge yet. The drain is left out.
Ahead(r) == /\ Deploys(r)
            /\ \/ \E o \in Reviews \ {r} : Deploys(o) /\ InLanding(o)
               \/ desired # None /\ Outcome(desired) # "healthy"

\* release-store.ts `setDesiredRelease`. A report made before the request counts only when it says healthy.
SetDesired(c, by) == /\ desired' = c
                     /\ desiredBy' = by
                     /\ result' = IF desired = c /\ result = "healthy" THEN "healthy" ELSE "none"

To(r, p) == phase' = [phase EXCEPT ![r] = p]
Drop(r) == auth' = [auth EXCEPT ![r] = FALSE] /\ waiting' = [waiting EXCEPT ![r] = FALSE]
\* A merging phase without the turn carries no rollback target.
Forget(r) == previous' = [previous EXCEPT ![r] = None]

\* landing.ts `turnLost`: the desired release is no longer the one r took its turn at.
TurnLost(r) == Deploys(r) /\ desired # previous[r]

Init ==
  /\ phase = [r \in Reviews |-> "review"]
  /\ auth = [r \in Reviews |-> FALSE]
  /\ waiting = [r \in Reviews |-> FALSE]
  /\ round = [r \in Reviews |-> 1]
  /\ requested = [r \in Reviews |-> FALSE]
  /\ previous = [r \in Reviews |-> None]
  /\ merged = [r \in Reviews |-> FALSE]
  /\ prHead = [r \in Reviews |-> 1]
  /\ prOpen = [r \in Reviews |-> TRUE]
  /\ prMergedHead = [r \in Reviews |-> 0]
  /\ desired \in {None, C0}
  /\ desiredBy = "start"
  /\ result = IF desired = C0 THEN "healthy" ELSE "none"
  /\ running = C0
  /\ healthy = TRUE
  /\ everHealthy = {C0}
  /\ deploysLeft = PersonDeploys

(* ------------------------- the review loop ------------------------- *)

\* review.ts `checked`: the round's reviewers approved and its checks passed, so the landing begins.
Approve(r) ==
  /\ phase[r] = "review"
  /\ To(r, "merging") /\ Drop(r)
  /\ UNCHANGED <<round, requested, previous, merged, prVars, relVars, unitVars, deploysLeft>>

\* review.ts `merge` lines 769-773: without the turn, the step only records why it waits.
Wait(r) ==
  /\ phase[r] = "merging" /\ ~auth[r] /\ Ahead(r)
  /\ waiting' = [waiting EXCEPT ![r] = TRUE]
  /\ UNCHANGED <<phase, auth, round, requested, previous, merged, prVars, relVars, unitVars, deploysLeft>>

\* A merging step gets past the turn check when it holds the turn or nothing is ahead of it.
PastTurn(r) == phase[r] = "merging" /\ (auth[r] \/ ~Ahead(r))

\* review.ts `merge` line 796: the pull request merged at a head no round approved.
MergedAtOtherHead(r) ==
  /\ PastTurn(r) /\ prMergedHead[r] \notin {0, round[r]}
  /\ To(r, "person") /\ Drop(r) /\ Forget(r)
  /\ UNCHANGED <<round, requested, merged, prVars, relVars, unitVars, deploysLeft>>

\* landing.ts `merged`: landed, or deploying with `target`, the release the turn was taken at, as the rollback target.
MergedEffects(r, target) ==
  /\ merged' = [merged EXCEPT ![r] = TRUE]
  /\ Drop(r)
  /\ IF Deploys(r)
       THEN /\ To(r, "deploying")
            /\ previous' = [previous EXCEPT ![r] = target]
            /\ requested' = [requested EXCEPT ![r] = FALSE]
       ELSE /\ To(r, "landed")
            /\ UNCHANGED <<previous, requested>>

\* review.ts `merge` lines 795-805 with `authorized` at the head: after a crash, a merge at the authorized head is the review's own.
OwnMergeSeen(r) ==
  /\ phase[r] = "merging" /\ auth[r] /\ prMergedHead[r] = round[r]
  /\ MergedEffects(r, previous[r])
  /\ UNCHANGED <<round, prVars, relVars, unitVars, deploysLeft>>

\* review.ts `merge` lines 800-804: someone else merged the approved head, and the policy would have let the review merge it.
\* landing.ts `rollbackTarget` is read in the tick in which `ahead` found the desired release healthy.
OthersMergeSeen(r) ==
  /\ phase[r] = "merging" /\ ~auth[r] /\ ~Ahead(r) /\ prMergedHead[r] = round[r]
  /\ MergedEffects(r, desired)
  /\ UNCHANGED <<round, prVars, relVars, unitVars, deploysLeft>>

\* review.ts `merge` lines 808-809 and `newHead`: a head pushed after the approval gets a round of its own.
NewRound(r) ==
  /\ PastTurn(r) /\ prOpen[r] /\ prHead[r] # round[r]
  /\ To(r, "review") /\ Drop(r) /\ Forget(r)
  /\ round' = [round EXCEPT ![r] = prHead[r]]
  /\ UNCHANGED <<requested, merged, prVars, relVars, unitVars, deploysLeft>>

\* review.ts `merge` lines 802, 826, 828, 847: a hold the waiver does not cover, or GitHub's refusal, goes to the person.
Held(r) ==
  /\ PastTurn(r)
  /\ \/ prOpen[r] /\ prHead[r] = round[r]
     \/ ~auth[r] /\ prMergedHead[r] = round[r]
  /\ To(r, "person") /\ Drop(r) /\ Forget(r)
  /\ UNCHANGED <<round, requested, merged, prVars, relVars, unitVars, deploysLeft>>

\* review.ts `merge` lines 833-837: the base moved since the head's check, so nothing stays authorized.
BaseMoved(r) ==
  /\ phase[r] = "merging" /\ auth[r] /\ prOpen[r] /\ prHead[r] = round[r]
  /\ auth' = [auth EXCEPT ![r] = FALSE] /\ Forget(r)
  /\ UNCHANGED <<phase, waiting, round, requested, merged, prVars, relVars, unitVars, deploysLeft>>

\* review.ts `merge`, before the merge call: a release requested since the turn was taken has not run yet, so the turn goes back.
GiveTurnBack(r) ==
  /\ phase[r] = "merging" /\ auth[r] /\ prOpen[r] /\ prHead[r] = round[r] /\ TurnLost(r)
  /\ auth' = [auth EXCEPT ![r] = FALSE] /\ Forget(r)
  /\ UNCHANGED <<phase, waiting, round, requested, merged, prVars, relVars, unitVars, deploysLeft>>

\* review.ts `merge`: the review takes the turn, saved before the merge call with the release the turn was taken at.
\* landing.ts `rollbackTarget` is read in the tick in which `ahead` found that release healthy.
Authorize(r) ==
  /\ phase[r] = "merging" /\ ~auth[r] /\ ~Ahead(r) /\ prOpen[r] /\ prHead[r] = round[r]
  /\ auth' = [auth EXCEPT ![r] = TRUE]
  /\ waiting' = [waiting EXCEPT ![r] = FALSE]
  /\ previous' = [previous EXCEPT ![r] = IF Deploys(r) THEN desired ELSE None]
  /\ UNCHANGED <<phase, round, requested, merged, prVars, relVars, unitVars, deploysLeft>>

\* review.ts `merge`, the merge call and after: GitHub merges the authorized head, which it compares with the pull request's own.
\* The step does not need `~TurnLost(r)`: the code checks `turnLost` and then waits for GitHub, and a release may be requested meanwhile.
Merge(r) ==
  /\ phase[r] = "merging" /\ auth[r] /\ prOpen[r] /\ prHead[r] = round[r]
  /\ prOpen' = [prOpen EXCEPT ![r] = FALSE]
  /\ prMergedHead' = [prMergedHead EXCEPT ![r] = round[r]]
  /\ MergedEffects(r, previous[r])
  /\ UNCHANGED <<round, prHead, relVars, unitVars, deploysLeft>>

\* The same merge call, with the control plane stopped before the step was saved.
MergeThenCrash(r) ==
  /\ phase[r] = "merging" /\ auth[r] /\ prOpen[r] /\ prHead[r] = round[r]
  /\ prOpen' = [prOpen EXCEPT ![r] = FALSE]
  /\ prMergedHead' = [prMergedHead EXCEPT ![r] = round[r]]
  /\ UNCHANGED <<reviewVars, prHead, relVars, unitVars, deploysLeft>>

\* landing.ts `steps.deploying` and `requestRelease`: the merge commit becomes the desired release.
RequestDeploy(r) ==
  /\ phase[r] = "deploying" /\ ~requested[r]
  /\ requested' = [requested EXCEPT ![r] = TRUE]
  /\ IF desired # r THEN SetDesired(r, r) ELSE UNCHANGED relVars
  /\ UNCHANGED <<phase, auth, waiting, round, previous, merged, prVars, unitVars, deploysLeft>>

\* landing.ts `steps.deploying`: every service reports the commit healthy.
DeployHealthy(r) ==
  /\ phase[r] = "deploying" /\ requested[r] /\ Outcome(r) = "healthy"
  /\ To(r, "landed")
  /\ UNCHANGED <<auth, waiting, round, requested, previous, merged, prVars, relVars, unitVars, deploysLeft>>

\* landing.ts `steps.deploying`: another release replaced the commit.
DeploySuperseded(r) ==
  /\ phase[r] = "deploying" /\ requested[r] /\ Outcome(r) = "superseded"
  /\ To(r, "person")
  /\ UNCHANGED <<auth, waiting, round, requested, previous, merged, prVars, relVars, unitVars, deploysLeft>>

\* landing.ts `steps.deploying`: the deploy failed, or its deadline passed while it was pending.
DeployFails(r) ==
  /\ phase[r] = "deploying" /\ requested[r] /\ Outcome(r) \in {"failed", "pending"}
  /\ IF previous[r] = None
       THEN To(r, "person") /\ UNCHANGED requested
       ELSE To(r, "rollingBack") /\ requested' = [requested EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<auth, waiting, round, previous, merged, prVars, relVars, unitVars, deploysLeft>>

\* landing.ts `steps["rolling-back"]` and `requestRelease`: the previous release becomes the desired one.
RequestRollback(r) ==
  /\ phase[r] = "rollingBack" /\ ~requested[r]
  /\ requested' = [requested EXCEPT ![r] = TRUE]
  /\ IF desired # previous[r] THEN SetDesired(previous[r], r) ELSE UNCHANGED relVars
  /\ UNCHANGED <<phase, auth, waiting, round, previous, merged, prVars, unitVars, deploysLeft>>

\* landing.ts `steps["rolling-back"]`: the rollback is healthy, and the person hears of the failed deploy.
RolledBack(r) ==
  /\ phase[r] = "rollingBack" /\ requested[r] /\ Outcome(previous[r]) = "healthy"
  /\ To(r, "person")
  /\ UNCHANGED <<auth, waiting, round, requested, previous, merged, prVars, relVars, unitVars, deploysLeft>>

\* landing.ts `steps["rolling-back"]`: the rollback was replaced, failed, or ran out of time.
RollbackFails(r) ==
  /\ phase[r] = "rollingBack" /\ requested[r] /\ Outcome(previous[r]) # "healthy"
  /\ To(r, "person")
  /\ UNCHANGED <<auth, waiting, round, requested, previous, merged, prVars, relVars, unitVars, deploysLeft>>

\* review.ts `pushedAfter`: a head pushed while the review waits on the person, unmerged, gets a round.
HeldNewHead(r) ==
  /\ phase[r] = "person" /\ ~merged[r] /\ prOpen[r] /\ prHead[r] # round[r]
  /\ To(r, "review")
  /\ round' = [round EXCEPT ![r] = prHead[r]]
  /\ UNCHANGED <<auth, waiting, requested, previous, merged, prVars, relVars, unitVars, deploysLeft>>

(* ------------------- people, GitHub and the fleet ------------------- *)

\* The builder, or GitHub after an update of the branch, pushes a head.
Push(r) ==
  /\ prOpen[r] /\ prHead[r] < MaxHead
  /\ prHead' = [prHead EXCEPT ![r] = prHead[r] + 1]
  /\ UNCHANGED <<reviewVars, prOpen, prMergedHead, relVars, unitVars, deploysLeft>>

\* Someone merges the pull request on GitHub.
OutsideMerge(r) ==
  /\ prOpen[r]
  /\ prOpen' = [prOpen EXCEPT ![r] = FALSE]
  /\ prMergedHead' = [prMergedHead EXCEPT ![r] = prHead[r]]
  /\ UNCHANGED <<reviewVars, prHead, relVars, unitVars, deploysLeft>>

\* review.ts `landableAt` and `pressWith`: the person presses Land on a held review that never merged, and its checks run again.
PersonLand(r) ==
  /\ phase[r] = "person" /\ ~merged[r] /\ prOpen[r] /\ prHead[r] = round[r]
  /\ To(r, "review")
  /\ UNCHANGED <<auth, waiting, round, requested, previous, merged, prVars, relVars, unitVars, deploysLeft>>

\* api/release-routes.ts, the deploy route: the person's `nexus deploy`, which only a drain refuses.
PersonDeploy(c) ==
  /\ deploysLeft > 0
  /\ deploysLeft' = deploysLeft - 1
  /\ SetDesired(c, "person")
  /\ UNCHANGED <<reviewVars, prVars, unitVars>>

\* deploy/worker.ts `reconcileRole` with plan.ts `planDeploy`: the fleet installs the desired release, or reports the one it runs.
InstallOk ==
  /\ desired # None /\ result = "none" /\ OnBranch(desired)
  /\ running' = desired /\ healthy' = TRUE /\ result' = "healthy"
  /\ everHealthy' = everHealthy \cup {desired}
  /\ UNCHANGED <<reviewVars, prVars, desired, desiredBy, deploysLeft>>

\* The install fails before the link switch, or after it with a rollback on the node, so the fleet runs what it ran.
\* install.ts `checkoutMerged` refuses a commit that is not on the release branch, so such a release always ends here.
InstallFails ==
  /\ desired # None /\ result = "none" /\ ~(running = desired /\ healthy)
  /\ result' = "failed"
  /\ UNCHANGED <<reviewVars, prVars, desired, desiredBy, unitVars, deploysLeft>>

\* The install fails after the link switch and the node cannot go back, so the fleet runs the new release, unhealthy.
InstallFailsStuck ==
  /\ desired # None /\ result = "none" /\ OnBranch(desired) /\ running # desired
  /\ running' = desired /\ healthy' = FALSE /\ result' = "failed"
  /\ UNCHANGED <<reviewVars, prVars, desired, desiredBy, everHealthy, deploysLeft>>

\* Every review ended. Nothing changes.
Done ==
  /\ \A r \in Reviews : phase[r] \in {"landed", "person"}
  /\ UNCHANGED vars

Next ==
  \/ \E r \in Reviews :
       \/ Approve(r) \/ Wait(r) \/ MergedAtOtherHead(r) \/ OwnMergeSeen(r) \/ OthersMergeSeen(r)
       \/ NewRound(r) \/ Held(r) \/ BaseMoved(r) \/ GiveTurnBack(r) \/ Authorize(r) \/ Merge(r) \/ MergeThenCrash(r)
       \/ RequestDeploy(r) \/ DeployHealthy(r) \/ DeploySuperseded(r) \/ DeployFails(r)
       \/ RequestRollback(r) \/ RolledBack(r) \/ RollbackFails(r) \/ HeldNewHead(r)
       \/ Push(r) \/ OutsideMerge(r) \/ PersonLand(r)
  \/ \E c \in {C0, X} : PersonDeploy(c)
  \/ InstallOk \/ InstallFails \/ InstallFailsStuck
  \/ Done

Spec == Init /\ [][Next]_vars

(* ------------------------------ rules ------------------------------ *)

TypeOK ==
  /\ phase \in [Reviews -> {"review", "merging", "deploying", "rollingBack", "landed", "person"}]
  /\ auth \in [Reviews -> BOOLEAN] /\ waiting \in [Reviews -> BOOLEAN]
  /\ round \in [Reviews -> 1..MaxHead] /\ prHead \in [Reviews -> 1..MaxHead]
  /\ requested \in [Reviews -> BOOLEAN] /\ merged \in [Reviews -> BOOLEAN]
  /\ previous \in [Reviews -> Commits \cup {None}]
  /\ prOpen \in [Reviews -> BOOLEAN] /\ prMergedHead \in [Reviews -> 0..MaxHead]
  /\ desired \in Commits \cup {None} /\ desiredBy \in Reviews \cup {"start", "person"}
  /\ result \in {"none", "healthy", "failed"}
  /\ running \in Commits /\ healthy \in BOOLEAN /\ everHealthy \subseteq Commits
  /\ deploysLeft \in 0..PersonDeploys

\* Landings that deploy merge and deploy one at a time.
OneLandingAtATime == Cardinality({r \in Reviews : Deploys(r) /\ InLanding(r)}) <= 1

\* A deploy rolls back only to a release that every service once reported healthy.
RollbackTargetWasHealthy ==
  \A r \in Reviews : phase[r] \in {"deploying", "rollingBack"} => previous[r] \in everHealthy \cup {None}

\* A review deploys only a merge of the head its last round approved.
DeploysOnlyApprovedHead ==
  \A r \in Reviews : phase[r] \in {"deploying", "rollingBack", "landed"} => prMergedHead[r] = round[r]

\* The desired release is always a commit of the branch the deployer releases from.
ReleaseIsOnTheReleaseBranch == desired = None \/ OnBranch(desired)

\* When a landing waits on a release the fleet gave up on, and no landing is under way, the person was told:
\* a review is with them, or they requested that release themselves.
BlockedLandingIsSomeonesToFix ==
  \A r \in Reviews :
    (phase[r] = "merging" /\ ~auth[r] /\ Deploys(r) /\ desired # None /\ result = "failed"
       /\ ~\E o \in Reviews \ {r} : Deploys(o) /\ InLanding(o))
    => (desiredBy = "person" \/ \E o \in Reviews : phase[o] = "person" /\ merged[o])
=============================================================================
