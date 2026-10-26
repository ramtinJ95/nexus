# Merge policy

The person approved this policy on 2026-10-26. It says when an agent may merge and deploy a pull request without the person, and which changes always go to the person. [The review loop](design.md#the-review-loop-and-landing) applies it on the control plane, and `src/control/policy.ts` holds its checks.

## An agent may merge and deploy without the person

An agent may merge and deploy a pull request without the person when all of these hold:

1. A reviewer on a different model from the builder approved it with no serious findings open, and the builder fixed or rejected, with a reason, every finding.
2. The typecheck and the full test suite pass.
3. A live check passed on a verify stack, or the pull request says what couldn't be checked live and none of it is on the always-needs-the-person list below.
4. After merging, `nexus deploy --wait` reports every service healthy. If it doesn't, the agent rolls back to the previous release and tells the person.

## Always needs the person

- Changes to secrets, the egress allowlist, login or auth, or the tailnets.
- Database migrations that delete or rewrite existing data.
- Pylon image rebuilds.
- Breaking changes to the CLI's contract.
- Anything irreversible.

## How Nexus checks each condition

| Condition | What the landing checks |
|---|---|
| A reviewer on another model approved | The review's reviewer model differs from the builder's, and its latest round's verdict is an approval with no serious finding open, a failed check included. |
| Every finding fixed or rejected with a reason | Every finding of every round has the builder's answer: fixed, or rejected with a non-empty reason. |
| Typecheck and full test suite | The control plane ran the repository's `.nexus/check` at the approved head, in the reviewer's pylon, and it exited 0. Any GitHub check on the pull request must not be failing or pending either. |
| Live check, or a statement of what couldn't be checked live | No verify stack exists yet ([open questions](design.md#open-questions)), so every landing takes the second branch. The reviewer quotes what the pull request says couldn't be checked live, and the quote must appear in the pull request's description. |
| Nothing reserved for the person | The reviewer lists every reserved case the change touches, which must be none. For Nexus's own pull requests, the changed paths must also touch none, as the table below says. |
| Deploy healthy, else roll back | Nexus's own pull requests deploy their merge commit and wait up to 30 minutes, as `nexus deploy --wait` does. A failed, rolled-back or late deploy sets the desired release back to the previous one. Another repository's pull request is merged with nothing to deploy. |

The landing also refuses a pull request that is not open, whose head moved after the approval, or whose branch conflicts with its base. It merges with GitHub's head check, so it merges only the commit the reviewer approved.

## Paths that hold a Nexus pull request

The reviewer's reading can be talked round by text in the pull request it reviews, so for Nexus's own pull requests the changed paths are checked too. The check fails closed: a path that might touch a reserved case holds the landing, and the person decides.

| Reserved case | Paths |
|---|---|
| Secrets | any path naming a secret, `src/harness/credentials.ts`, and everything under `deploy/` |
| The egress allowlist | `src/pylon-vm/network.ts`, `src/project.ts` |
| Login or auth | `src/control/login.ts`, `src/control/releases.ts`, `src/probe/config.ts` |
| The tailnets | any path naming tailscale or a tailnet |
| Pylon image rebuilds | everything under `images/` |
| Anything irreversible | a registry migration in `src/control/registry.ts`, and a change to the `@earendil-works/pi-durable` version in `package.json` |

A registry migration counts as irreversible even when it only adds a table: a control plane refuses a registry newer than its code, so a rollback past a migration could not start the control plane. A pi-durable upgrade may migrate the harness's storage in the same way. A change to `.nexus/check` also holds the landing, since it is the check this policy relies on.

## What the person does with a held landing

`nexus show <thread>` and the dashboard list every condition that failed and every reserved case that applies, and the thread's attention is `decision` until the person acts. The person can merge and deploy the pull request themselves, fix what held it and run `nexus land <thread>` to check again, or start a new review with `nexus review <thread>`.
