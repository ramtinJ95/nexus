# Nexus

Nexus runs coding agents in microVMs on your own Linux machines. The control plane owns conversations and the registry; each thread has a pylon holding its checkout and tools.

- [Design](docs/design.md)
- [Data model](docs/data-model.md)
- [Mac CLI and client JSON contract](docs/cli.md)
- [Deployment](deploy/README.md)

## Attention and notifications

Thread lists and `nexus show --json` share the control plane's `attention`, `lastReplyAt` and `seenAt`. Mark a reply read from any client with `nexus seen <thread>`, or unread with `nexus seen <thread> --unread`; neither wakes its pylon.

The dashboard marks only rendered replies seen, shows attention in its sidebar and table, and counts threads needing attention in its title and favicon. New failures and parked tasks notify immediately; replies wait two seconds in case work resumes. A focused dashboard offers an Open toast for another thread. Background system notifications need HTTPS and permission enabled by a click. The current plain-HTTP tailnet dashboard still supports toasts and badges, but cannot send system notifications. Serving is unchanged.

## Pull request watch

When a thread pushes an origin branch on its project's GitHub repository, the control plane links its open PRs automatically. `nexus show` and the dashboard's Pylon outputs show the title, URL, state, checks and review state. GitHub reads never wake a pylon.

About every two minutes, Nexus checks for failed checks, recovery, new reviews/comments and merge conflicts. It batches feedback into an explicitly automated conversation message and deliberately wakes the agent, without recording human activity. Watching pauses for archived threads and ends for deleted threads, terminal PRs or ten consecutive comment-only wakes. Cursors survive restart and archive. Reviews and comments are forwarded only from GitHub owners, members and collaborators (`author_association`); PR authors must meet the same rule. Other feedback is ignored and cannot exhaust the wake cap.

Configure the optional control-plane `github.tokenFile` as described in the deploy guide. Without it, the UI and CLI show that PR watching is off. The token remains on the control plane and is never sent to a pylon.

## Checks

With Node 26 or newer:

```sh
npm ci
npm run typecheck
npm test
```

Live slice checks need a suitable VM host and are separate from the unit suite.
