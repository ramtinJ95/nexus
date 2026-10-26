# Nexus

Nexus runs coding agents in microVMs on your own Linux machines. The control plane owns conversations and the registry; each thread has a pylon holding its checkout and tools.

- [Design](docs/design.md)
- [Data model](docs/data-model.md)
- [Mac CLI and client JSON contract](docs/cli.md)
- [Deployment](deploy/README.md)

## Attention and notifications

Thread lists and `nexus show --json` share the control plane's `attention`, `lastReplyAt` and `seenAt`. Mark a reply read from any client with `nexus seen <thread>`, or unread with `nexus seen <thread> --unread`; neither wakes its pylon.

The dashboard marks only rendered replies seen, shows attention in its sidebar and table, and counts threads needing attention in its title and favicon. New failures and parked tasks notify immediately; replies wait two seconds in case work resumes. A focused dashboard offers an Open toast for another thread. Background system notifications need HTTPS and permission enabled by a click. Use the [HTTPS dashboard setup](deploy/README.md#https-dashboard) for system notifications on the tailnet. The plain HTTP listener remains available to existing clients.

## Pull request watch

When a thread pushes an origin branch on its project's GitHub repository, the control plane links its open PRs automatically. `nexus show` and the dashboard's Pylon outputs show the title, URL, state, checks and review state. GitHub reads never wake a pylon.

About every two minutes, Nexus checks for failed checks, recovery, new reviews/comments and merge conflicts. It batches feedback into an explicitly automated conversation message and deliberately wakes the agent, without recording human activity. Watching pauses for archived threads and ends for deleted threads, terminal PRs or ten consecutive comment-only wakes. Cursors survive restart and archive, and a closed PR rediscovered as open resumes without replaying old feedback or resetting the wake cap. Reviews and comments are forwarded only from GitHub owners, members and collaborators (`author_association`); PR authors must meet the same rule. Other feedback is ignored and cannot exhaust the wake cap.

Configure the optional control-plane `github.tokenFile` as described in the deploy guide. Without it, the UI and CLI show that PR watching is off. The token remains on the control plane and is never sent to a pylon.

## Checks

With Node 26 or newer:

```sh
npm ci
npm run typecheck
npm test
```

The control plane serves the dashboard's client from `dist/dashboard`, bundled from `src/control/dashboard`, and does not start without it. `npm test` builds it first. To run the control plane from a checkout, run `npm run build` after `npm ci` and after each change to the client.

The unit suite must pass on a loaded machine, as the review loop's checks run it. A test does not race a fixed sleep or a short deadline. It steps the code's timers with `node:test`'s mock timers, or waits for a signal that the work happened, and a wait for a real condition gives up only after 60 s, to end a hang.

Live slice checks need a suitable VM host and are separate from the unit suite.
