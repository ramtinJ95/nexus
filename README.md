# Nexus

Nexus runs coding agents in microVMs on your own Linux machines. The control plane owns conversations and the registry; each thread has a pylon holding its checkout and tools.

## Quickstart

You need:

- a Linux machine that boots with systemd, such as Debian 12 or Ubuntu 24.04, with hardware virtualization (`/dev/kvm`), at least 8 GiB of memory, and SSH as a sudoer;
- [Tailscale](https://tailscale.com) on that machine and on your Mac, in one tailnet, with MagicDNS and HTTPS certificates turned on in its admin console;
- git and Node 26 on the Mac, and a dotfiles repository every pylon pulls on boot;
- the agents' credentials: a ChatGPT subscription or an OpenAI API key, a Claude token from `claude setup-token` or an Anthropic API key, and a GitHub token.

On the Linux machine, over SSH:

```sh
sudo apt-get install -y git
git clone https://github.com/ramtinJ95/nexus.git && cd nexus
sudo deploy/install.sh --admit <your Mac's tailnet name> --dotfiles <dotfiles git URL>
```

The first run checks every prerequisite, prints the command that fixes each one it misses, and changes nothing. Run those, then run the installer again. It installs the control plane, asks for each credential, and ends with a list of what is left. Do the Linux machine's part of that list, Docker for image builds among it, before you build the first image below.

On the Mac:

```sh
git clone https://github.com/ramtinJ95/nexus.git && nexus/deploy/mac/install
export PATH="$HOME/.local/bin:$PATH"   # and add this line to ~/.zprofile
nexus connect <the Linux machine's full MagicDNS name>
nexus image build --wait && nexus image rollout <the image ID it printed> --wait
```

To check it works, `nexus connect` should say this Mac may start and message threads. Then start a thread and read its answer, or open the dashboard at `https://<the Linux machine's full MagicDNS name>:7443/`:

```sh
nexus project add hello --scratch
nexus start --project hello --message "Say hello"
nexus conversation <the thread ID it printed>
```

[Install on a new machine](deploy/README.md#install-on-a-new-machine) has the detail, adding more machines among it. [The CLI's contract](docs/cli.md) lists every command. [docs/verification/fresh-install](docs/verification/fresh-install) runs this install on two fresh Debian machines with Tailscale faked. A run in a real tailnet is still a step done by hand.

## Documentation

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

The unit suite must pass on a loaded machine, as the review loop's checks run it. A test does not race a fixed sleep or a short deadline. It steps the code's timers with `node:test`'s mock timers, or waits for a signal that the work happened, and a wait for a real condition gives up only after 60 s, to end a hang. `npm test` fails any test still running after 10 minutes, so a hang names its test instead of stalling the suite.

Live slice checks need a suitable VM host and are separate from the unit suite.
