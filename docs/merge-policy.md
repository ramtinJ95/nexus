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

## How Nexus checks each condition

| Condition | What the landing checks |
|---|---|
| A reviewer on another model approved | The review's reviewer model differs from the builder's, and its latest round's verdict is an approval with no P0 to P2 finding open. A failed `.nexus/check` counts as a P0 finding. The approval must come from a harness reviewer, whose verdict the control plane's own agent loop produces. A Claude reviewer's verdict is read from its transcript in its pylon, where code it runs, such as the pull request's tests, could write a forged one, so a landing it approved goes to the person. |
| Every P0 to P2 finding fixed or rejected with a reason | Every P0 to P2 finding of every round has the builder's answer: fixed, or rejected with a non-empty reason. A P3 finding needs no answer. |
| Typecheck and full test suite | The control plane ran the repository's `.nexus/check` at the approved head in a fresh check thread, a pylon with no agent cloned at that commit, in the environment the pylon's image gives its agents, and the pipe the probe carried reported the check's process exiting 0. Nothing the check writes in the pylon decides it, and the thread is deleted afterwards, so nothing it leaves running reaches a later round or any reviewer. Any GitHub check on the pull request must not be failing or pending either. |
| Live check, or a statement of what couldn't be checked live | No verify stack exists yet ([open questions](design.md#open-questions)), so every landing takes the second branch. The reviewer quotes the passage of the pull request's description that says what couldn't be checked live, at least 20 characters, which must appear in the description, and counts what it names among the reserved cases it lists. |
| Nothing reserved for the person | The reviewer lists every reserved case the change touches, which must be none. For Nexus's own pull requests, the changed paths must also touch none, as the table below says. In any repository, a change to `.nexus/check` holds the landing. |
| Deploy healthy, else roll back | Nexus's own pull requests deploy their merge commit and wait up to 30 minutes, as `nexus deploy --wait` does. A failed, rolled-back or late deploy sets the desired release back to the previous one and waits, up to 30 minutes again, for every service to report it healthy. Only then does the person hear that it rolled back; a rollback that fails too is reported as failed. Another repository's pull request is merged with nothing to deploy. |

The landing also refuses a pull request that is not open, whose head moved after the approval, or whose branch conflicts with its base. It checks every condition again, with what GitHub says at that moment, right before each merge attempt, including one retried after a restart, since checks can fail after an approval and branch protection may not enforce them. It merges with GitHub's head check, so it merges only the commit the reviewer approved. A pull request someone merged outside the review, at the approved commit, is deployed only if every condition here holds for it, and otherwise goes to the person.

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

A registry migration counts as irreversible even when it only adds a table: a control plane refuses a registry newer than its code, so a rollback past a migration could not start the control plane. A pi-durable upgrade may migrate the harness's storage in the same way. A change to `.nexus/check` also holds the landing, since it is the check this policy relies on.

## Known limits

- The check's exit status is what the pylon reports for the pipe's process. Code in the check runs as the pylon's `user`, who has sudo, so a check written to attack its own VM's process reporting could still lie about it. That is a deliberate attack on Nexus rather than a test that writes the wrong file, and the reviewer reads the change for it.
- The typecheck and the tests are whatever the pull request's `.nexus/check` and its scripts run. A change to `.nexus/check` holds the landing, but a change to what it calls, such as `package.json`'s scripts, is for the reviewer to catch.

## What the person does with a held landing

`nexus show <thread>` and the dashboard list every condition that failed and every reserved case that applies, and the thread's attention is `decision` until the person acts. The person can merge and deploy the pull request themselves, fix what held it and run `nexus land <thread>` to check again, or start a new review with `nexus review <thread>`.
