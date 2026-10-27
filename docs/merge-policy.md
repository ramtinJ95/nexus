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

The person decided on 2026-10-27 that their passkey confirms it: a landing the person approves with a passkey on the dashboard satisfies "always needs the person" for the holds a passkey may waive, which [What a passkey may waive](#what-a-passkey-may-waive) lists. Every other condition above still holds.

## How Nexus checks each condition

| Condition | What the landing checks |
|---|---|
| A reviewer on another model approved | The review's reviewer model differs from the builder's, and its latest round's verdict is an approval with no P0 to P2 finding open. A failed `.nexus/check` counts as a P0 finding. The approval must come from a harness reviewer, whose verdict the control plane's own agent loop produces. A Claude reviewer's verdict is read from its transcript in its pylon, where code it runs, such as the pull request's tests, could write a forged one, so a landing it approved goes to the person. |
| Every P0 to P2 finding fixed or rejected with a reason | Every P0 to P2 finding of every round has the builder's answer: fixed, or rejected with a non-empty reason. A P3 finding needs no answer. |
| Typecheck and full test suite | The control plane ran the repository's `.nexus/check` at the approved head in a fresh check thread, a pylon with no agent cloned at that commit, in the environment the pylon's image gives its agents, and the pipe the probe carried reported the check's process exiting 0. Nothing the check writes in the pylon decides it, and the thread is deleted afterwards, so nothing it leaves running reaches a later round or any reviewer. Any GitHub check on the pull request must not be failing or pending either. |
| Live check, or a statement of what couldn't be checked live | No verify stack exists yet ([open questions](design.md#open-questions)), so every landing takes the second branch. The reviewer quotes the passage of the pull request's description that says what couldn't be checked live, at least 20 characters, which must appear in the description, and counts what it names among the reserved cases it lists. |
| Nothing reserved for the person | The reviewer lists every reserved case the change touches, which must be none. For Nexus's own pull requests, the changed paths must also touch none, as the table below says. In any repository, a change to `.nexus/check` holds the landing. Each of these holds is met instead when the person waived it with a passkey for the approved head, as [What a passkey may waive](#what-a-passkey-may-waive) says. |
| Deploy healthy, else roll back | Nexus's own pull requests deploy their merge commit and wait up to 30 minutes, as `nexus deploy --wait` does. A failed, rolled-back or late deploy sets the desired release back to the previous one and waits, up to 30 minutes again, for every service to report it healthy. Only then does the person hear that it rolled back; a rollback that fails too is reported as failed. Another repository's pull request is merged with nothing to deploy. |

The landing also refuses a pull request that is not open, whose head moved after the approval, or whose branch conflicts with its base. A moved head is not merged but reviewed again, in a new round. A branch that only conflicts goes back to the builder to rebase, and the rebased head gets a new round, a check and every condition here again before it can merge. A builder that cannot rebase, or a conflict with no round left, goes to the person. A landing merges and deploys for a deployer: the one who asked for it, or, for a project that lands on its own, the one who turned that on, and it is held for the person if they are no longer a deployer or the project no longer asks. It checks every condition again, with what GitHub says at that moment, right before each merge attempt, including one retried after a restart, since checks can fail after an approval and branch protection may not enforce them. It merges with GitHub's head check, so it merges only the commit the reviewer approved. A pull request someone merged outside the review, at the approved commit, is deployed only if every condition here holds for it, and otherwise goes to the person.

## Paths that hold a Nexus pull request

Text in the pull request can mislead the reviewer but cannot change which files it touches, so for Nexus's own pull requests the changed paths are checked too, both a file's path and the path it was renamed from. The list is drawn wide: a path that might touch a reserved case holds the landing, and the person decides. It is still a list, so a reserved change in a file it does not name rests on the reviewer alone.

| Reserved case | Paths |
|---|---|
| Secrets | any path naming a secret or a credential, and everything under `deploy/` |
| The egress allowlist | `src/project.ts`, `src/control/threads.ts`, `src/control/live.ts`, every path starting `src/pylon-vm`, and any path naming a network, egress or an allowlist |
| Login or auth | `src/control/api.ts`, `src/control/main.ts`, `src/control/login.ts`, `src/control/releases.ts`, `src/control/attach.ts`, `src/control/policy.ts`, everything under `src/probe/` and `src/deploy/`, and any path naming auth, login, whois, a passkey or WebAuthn |
| The tailnets | any path naming tailscale or a tailnet |
| Pylon image rebuilds | everything under `images/`, and `src/agent-setup.ts` |
| Anything irreversible | a registry migration in `src/control/registry.ts`, and a change to the `@earendil-works/pi-durable` version in `package.json` |

A registry migration counts as irreversible even when it only adds a table: a control plane refuses a registry newer than its code, so a rollback past a migration could not start the control plane. A pi-durable upgrade may migrate the harness's storage in the same way. A change to `.nexus/check` also holds the landing, since it is the check this policy relies on.

## Known limits

- The check's exit status is what the pylon reports for the pipe's process. Code in the check runs as the pylon's `user`, who has sudo, so a check written to attack its own VM's process reporting could still lie about it. That is a deliberate attack on Nexus rather than a test that writes the wrong file, and the reviewer reads the change for it.
- The typecheck and the tests are whatever the pull request's `.nexus/check` and its scripts run. A change to `.nexus/check` holds the landing, but a change to what it calls, such as `package.json`'s scripts, is for the reviewer to catch.

## What the person does with a held landing

`nexus show <thread>` and the dashboard list every condition that failed and every reserved case that applies, and the thread's attention is `decision` until the person acts. The person can land it from the dashboard, with a passkey where a hold needs one, merge and deploy the pull request themselves, fix what held it and land it again, or start a new review with `nexus review <thread>`. Deciding not to land needs nothing new: closing the pull request or archiving the builder takes the dashboard's Land button away. The review record stays held, and the builder's attention stays `decision`, because the review loop does not step a review that has ended.

Landing again is `nexus land <thread>`, or the Land button on the builder's page of the dashboard, which calls the same route and so needs a deployer's device too. The button sends the commit its confirmation named, and the route lands nothing if the review has moved to another commit since. It checks every condition again, so without a passkey it helps only when what held the landing has changed, such as checks that have passed since or a description that now says what could not be checked live.

## What a passkey may waive

The control plane identifies callers by their tailnet node, and an agent on the person's Mac is the same node as the person, so a deployer's device alone does not show that the person pressed Land. A passkey does: its authenticator verifies the person with biometrics or a PIN before it signs, and an agent cannot press it. Enrolling a passkey takes a code that only root on the control plane's host makes, so an agent cannot enrol an authenticator of its own. [The design](design.md#the-review-loop-and-landing) says how both work.

| Hold | A passkey waives it | Why |
|---|---|---|
| A reserved case the reviewer named | Yes | The policy reserves it for the person, and the passkey shows the person confirmed it. |
| A reserved path of a Nexus pull request | Yes | The same, for the paths that might touch a reserved case. |
| A change to `.nexus/check` | Yes | Accepting a new check is the person's call. |
| A Claude reviewer's approval | No | A Claude reviewer's verdict is read from its pylon, where code the pull request runs could write a forged one. The findings and reserved cases the person would be waiving come from that same verdict, so a passkey would confirm what a forger chose to show. Only a harness reviewer's approval lands, or the person merges on GitHub. |
| An open P0 to P2 finding, or one the builder left unanswered | No | Findings block until they are fixed or rejected with a reason. |
| `.nexus/check` failed or did not run at the head | No | Only a passing check at the approved head lands. |
| Failing or pending GitHub checks | No | They hold every landing until they pass. |
| A head that moved after the approval, or a merge at another head | No | Only the approved commit lands. |
| A branch that conflicts, or a pull request that is not open | No | Neither can merge. |
| A reviewer on the builder's own model, or no statement of what was not checked live | No | These are the policy's other conditions, which an agent can meet. |

The Land card on the dashboard marks each hold "you may waive" or not, with the reason. When every hold that would meet the landing again is one a passkey may waive, the button becomes Land with a passkey. Its confirmation names the pull request, the commit and the holds, and the passkey signs a challenge that the control plane made for exactly that review, pull request, commit and list of holds. The challenge expires after two minutes and works once. The control plane checks that the assertion comes from the dashboard's HTTPS origin, for its host, with the person verified, and with a signature counter that moved past the stored one when the authenticator keeps one. The caller must still be a deployer. The landing then checks every condition again, as `nexus land` does, with the named holds met at that commit and nothing else. The review records the waiver, who confirmed it, with which passkey and at which commit, `nexus show` prints it, and the event stream gets a `review.waived` event.

A waiver lasts for the landing it starts. If that landing holds again for anything else, such as checks that turned pending, the person confirms again.

## Known limits of passkeys

- The trust rests on root on the control plane's host, who makes enrolment codes, and on the person's authenticator. Whoever is root there can enrol a passkey of their own.
- Registration asks for no attestation, so the control plane does not check what kind of authenticator a passkey is. The code is what makes it the person's.
- The control plane's own code decides what a passkey waives. A change to it is a change to auth, which holds the landing for the person.
