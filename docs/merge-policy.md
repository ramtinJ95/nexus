# Merge policy

The person approved this policy on 2026-10-26. It says when an agent may merge and deploy a pull request without the person, and which changes always go to the person. [The review loop](design.md#the-review-loop-and-landing) applies it on the control plane, and `src/control/policy.ts` holds its checks.

## An agent may merge and deploy without the person

An agent may merge and deploy a pull request without the person when all of these hold:

1. A reviewer on a different model from the builder approved it with no P0, P1 or P2 finding open, and the builder fixed or rejected, with a reason, every P0 to P2 finding. P3 findings never block a merge and need no fix.
2. The typecheck and the full test suite pass.
3. A live check passed on a verify stack, or the pull request says what couldn't be checked live and none of it is on the always-needs-the-person list below.
4. After merging, `nexus deploy --wait` reports every service healthy. If it doesn't, the agent rolls back to the previous release and tells the person.

The reviewer gives each finding a priority. The person decided on 2026-10-26 that only P0 to P2 findings block a merge into main:

| Priority | Means | Blocks |
|---|---|---|
| P0 | It breaks main or loses data. | Yes |
| P1 | A real bug or security problem that users hit. | Yes |
| P2 | A bug in a less common path, a missing test for new behaviour, or docs the change makes wrong. | Yes |
| P3 | Style, naming, small cleanups and nitpicks. | No. The builder gets them as notes it may take up in a later pull request. |

## Always needs the person

- Changes to secrets, the egress allowlist, login or auth, or the tailnets.
- Database migrations that delete or rewrite existing data.
- Pylon image rebuilds.
- Breaking changes to the CLI's contract.
- Anything irreversible.

The person decided on 2026-10-27 that pressing Land on the dashboard confirms it: a landing the person starts with the dashboard's Land button satisfies "always needs the person" for the holds the person may waive, which [What the person may waive](#what-the-person-may-waive) lists. Every other condition above still holds.

## How Nexus checks each condition

| Condition | What the landing checks |
|---|---|
| A reviewer on another model approved | The review's reviewer model differs from the builder's, and its latest round's verdict is an approval with no P0 to P2 finding open. A failed `.nexus/check` counts as a P0 finding. The approval must come from a harness reviewer, whose verdict the control plane's own agent loop produces. A Claude reviewer's verdict is read from its transcript in its pylon, where code it runs, such as the pull request's tests, could write a forged one, so a landing it approved goes to the person. |
| Every P0 to P2 finding fixed or rejected with a reason | Every P0 to P2 finding of every round has the builder's answer: fixed, or rejected with a non-empty reason. A P3 finding needs no answer. |
| Typecheck and full test suite | The control plane ran the repository's `.nexus/check` at the approved head in a fresh check thread, a pylon with no agent cloned at that commit, in the environment the pylon's image gives its agents, and the pipe the probe carried reported the check's process exiting 0. Nothing the check writes in the pylon decides it, and the thread is deleted afterwards, so nothing it leaves running reaches a later round or any reviewer. Any GitHub check on the pull request must not be failing or pending either. |
| Live check, or a statement of what couldn't be checked live | When the approved head has a `.nexus/verify`, the control plane ran it after `.nexus/check` passed, in a fresh verify pylon: a pylon with no agent cloned at that commit, whose boot asks for nested virtualization, on a node whose probe reports that its KVM nests. The pipe the probe carried reported the script exiting 0, which is a live check that passed, and the statement is not needed. A live check that failed holds the landing as a failed check does: the builder gets it as a `LIVE` finding (P0), and only a new head whose live check passes lands. The verify pylon is archived afterwards, and nothing in it decides the verdict. A head with no `.nexus/verify` takes the second branch, as Nexus's own pull requests still do ([open questions](design.md#open-questions)). The reviewer quotes the passage of the pull request's description that says what couldn't be checked live, at least 20 characters, which must appear in the description, and counts what it names among the reserved cases it lists. |
| Nothing reserved for the person | The reviewer lists every reserved case the change touches, which must be none. For Nexus's own pull requests, the changed paths must also touch none, as the table below says. In any repository, a change to `.nexus/check` or `.nexus/verify` holds the landing. Each of these holds is met instead when the person waived it for the approved head by pressing Land on the dashboard, as [What the person may waive](#what-the-person-may-waive) says. |
| Deploy healthy, else roll back | Nexus's own pull requests deploy their merge commit and wait up to 30 minutes, as `nexus deploy --wait` does. A failed, rolled-back or late deploy sets the desired release back to the previous one and waits, up to 30 minutes again, for every service to report it healthy. Only then does the person hear that it rolled back; a rollback that fails too is reported as failed. Another repository's pull request is merged with nothing to deploy. |

The landing also refuses a pull request that is not open, whose head moved after the approval, or whose branch conflicts with its base. A moved head is not merged but reviewed again, in a new round. A branch that only conflicts goes back to the builder to rebase, and the rebased head gets a new round, a check and every condition here again before it can merge. A builder that cannot rebase, or a conflict with no round left, goes to the person. A landing merges and deploys for a deployer: the one who asked for it, or, for a project that lands on its own, the one who turned that on, and it is held for the person if they are no longer a deployer or the project no longer asks. It checks every condition again, with what GitHub says at that moment, right before each merge attempt, including one retried after a restart, since checks can fail after an approval and branch protection may not enforce them. It merges with GitHub's head check, so it merges only the commit the reviewer approved. A pull request someone merged outside the review, at the approved commit, is deployed only if every condition here holds for it, and otherwise goes to the person.

## Paths that hold a Nexus pull request

Text in the pull request can mislead the reviewer but cannot change which files it touches, so for Nexus's own pull requests the changed paths are checked too, both a file's path and the path it was renamed from. The list is drawn wide: a path that might touch a reserved case holds the landing, and the person decides. It is still a list, so a reserved change in a file it does not name rests on the reviewer alone.

| Reserved case | Paths |
|---|---|
| Secrets | any path naming a secret or a credential, and everything under `deploy/` |
| The egress allowlist | `src/project.ts`, `src/control/threads.ts`, `src/control/live.ts`, every path starting `src/pylon-vm`, and any path naming a network, egress or an allowlist |
| Login or auth | `src/control/api.ts`, `src/control/main.ts`, `src/control/login.ts`, `src/control/releases.ts`, `src/control/attach.ts`, `src/control/policy.ts`, everything under `src/probe/` and `src/deploy/`, and any path naming auth, login or whois |
| The tailnets | any path naming tailscale or a tailnet |
| Pylon image rebuilds | everything under `images/`, and `src/agent-setup.ts` |
| Anything irreversible | a registry migration in `src/control/registry.ts`, and a change to the `@earendil-works/pi-durable` version in `package.json` |

A registry migration counts as irreversible even when it only adds a table: a control plane refuses a registry newer than its code, so a rollback past a migration could not start the control plane. A pi-durable upgrade may migrate the harness's storage in the same way. A change to `.nexus/check` also holds the landing, since it is the check this policy relies on, and so does a change to `.nexus/verify`, the live check it relies on.

## Known limits

- The check's exit status, and the live check's, is what the pylon reports for the pipe's process. Code in the check runs as the pylon's `user`, who has sudo, so a check written to attack its own VM's process reporting could still lie about it. That is a deliberate attack on Nexus rather than a test that writes the wrong file, and the reviewer reads the change for it.
- The typecheck and the tests are whatever the pull request's `.nexus/check` and its scripts run, and the live check whatever its `.nexus/verify` runs. A change to either file holds the landing, but a change to what they call, such as `package.json`'s scripts, is for the reviewer to catch. A pull request that deletes `.nexus/verify` runs no live check, and lands on its statement of what it could not check live once the person accepts the change.

## What the person does with a held landing

`nexus show <thread>` and the dashboard list every condition that failed and every reserved case that applies, and the thread's attention is `decision` until the person acts. The person can land it from the dashboard, waiving the holds reserved for them, merge and deploy the pull request themselves, fix what held it and land it again, or start a new review with `nexus review <thread>`. Deciding not to land needs nothing new: for a landing that has not merged, closing the pull request ends the review `closed`, and archiving the builder ends it `cancelled`, which takes the dashboard's Land button away and clears the builder's `decision`. A held landing archives nothing on its own. Only a review that lands archives its builder and its reviewer.

Landing again is `nexus land <thread>`, or the Land button on the builder's page of the dashboard, which calls the same route and so needs a deployer's device too. The button sends the commit its confirmation named, and the route lands nothing if the review has moved to another commit since. It checks every condition again, so without a waiver it helps only when what held the landing has changed, such as checks that have passed since or a description that now says what could not be checked live. `nexus land` never waives, so a hold reserved for the person holds it again.

## What the person may waive

Pressing Land on the dashboard is how the person waives a hold. `nexus land` never waives one, so an agent that drives the CLI does not waive a hold by accident.

| Hold | The person may waive it | Why |
|---|---|---|
| A reserved case the reviewer named | Yes | The policy reserves it for the person, and pressing Land is the person confirming it. |
| A reserved path of a Nexus pull request | Yes | The same, for the paths that might touch a reserved case. |
| A change to `.nexus/check` | Yes | Accepting a new check is the person's call. |
| A change to `.nexus/verify` | Yes | Accepting a new live check is the person's call. |
| A Claude reviewer's approval | No | A Claude reviewer's verdict is read from its pylon, where code the pull request runs could write a forged one. The findings and reserved cases the person would be waiving come from that same verdict, so a waiver would accept what a forger chose to show. Only a harness reviewer's approval lands, or the person merges on GitHub. |
| A deployer no longer asking for the landing, or a project that no longer lands on its own | No | The landing needs a deployer who asked for it. |
| An open P0 to P2 finding, or one the builder left unanswered | No | Findings block until they are fixed or rejected with a reason. |
| `.nexus/check` failed or did not run at the head | No | Only a passing check at the approved head lands. |
| The live check failed at the head | No | A repository with a `.nexus/verify` lands only once its live check passed at the approved head. |
| Failing or pending GitHub checks | No | They hold every landing until they pass. |
| A head that moved after the approval, or a merge at another head | No | Only the approved commit lands. |
| A branch that conflicts | No | It cannot merge. When it is the only hold the waiver does not cover, the builder rebases, and the rebased head needs a new review and a new waiver. |
| A pull request that is not open | No | It cannot merge. |
| A reviewer on the builder's own model, or no statement of what was not checked live | No | These are the policy's other conditions, which an agent can meet. |

The Land card on the dashboard marks each hold "you may waive" or not, with the reason. When every hold that would meet the landing again is one the person may waive, its Land button waives them. Its confirmation names the pull request, the commit and that it waives the holds the policy reserves for the person, and the button sends that commit and those holds. The caller must still be a deployer, and each named hold must be one the review has at that commit. The landing then checks every condition again, as `nexus land` does, with the named holds met at that commit and nothing else. The review records the waiver, who waived which holds at which commit, `nexus show` prints it, and the event stream gets a `review.waived` event.

A waiver lasts for the landing it starts. If that landing holds again for anything else, such as checks that turned pending or a reserved path the reviewer did not name, the review lists every hold it met, those the person waived too, and the person confirms them all again.

## Known limits of waivers

- A waiver is not a security boundary. The control plane identifies callers by their tailnet node, and an agent on the person's Mac is the same node as the person, so an agent with the person's deployer identity could post the same request the Land button does.
- The control plane's own code decides what the person may waive. A change to it is a change to auth, which holds the landing for the person.
