# Nexus

Nexus runs coding agents in microVMs on your own Linux machines. The control plane owns conversations and the registry; each thread has a pylon holding its checkout and tools.

- [Design](docs/design.md)
- [Data model](docs/data-model.md)
- [Mac CLI and client JSON contract](docs/cli.md)
- [Deployment](deploy/README.md)

## Attention and notifications

Thread lists and `nexus show --json` share the control plane's `attention`, `lastReplyAt` and `seenAt`. Mark a reply read from any client with `nexus seen <thread>`, or unread with `nexus seen <thread> --unread`; neither wakes its pylon.

The dashboard marks only rendered replies seen, shows attention in its sidebar and table, and counts threads needing attention in its title and favicon. New failures and parked tasks notify immediately; replies wait two seconds in case work resumes. A focused dashboard offers an Open toast for another thread. Background system notifications need HTTPS and permission enabled by a click. The current plain-HTTP tailnet dashboard still supports toasts and badges, but cannot send system notifications. Serving is unchanged.

## Checks

With Node 26 or newer:

```sh
npm ci
npm run typecheck
npm test
```

Live slice checks need a suitable VM host and are separate from the unit suite.
