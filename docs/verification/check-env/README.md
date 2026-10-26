# The check in the image's environment

`ssh-check.ts` ran gate.ts's `checkScript` in this thread's Gondolin pylon on 2026-10-26. It used the pylon's own sshd, with the ssh arguments and the remote command that `pylonGuest.stream` gives a check thread. The checkout was a fresh clone of this branch's base, and its `.npmrc` pointed npm at an empty cache, so `npm ci` downloaded every package through the egress proxy.

- `before.log` is the script on `main`. The ssh session has no `NODE_EXTRA_CA_CERTS`, and npm warns `EBADENGINE`, then fails with `SELF_SIGNED_CERT_IN_CHAIN`. The pipe exits 1. This is the failure from #97, #98 and #99.
- `after.log` is the script on this branch. It reads the image's environment from PID 1 with `sudo -n cat /proc/1/environ`. `npm ci` installs, the typecheck passes, and the suite runs on Node 24.22.1: 966 tests pass and 1 fails. The failure is `api.test.ts`'s stall-limit test, which waits for a stream event on a timer. It also fails on `main` when `api.test.ts` runs as a whole file in this pylon, and it does not touch the check or the review loop.

To run it again, add a key to the pylon user's `~/.ssh/authorized_keys`, then run:

```sh
node docs/verification/check-env/ssh-check.ts <identity file> <checkout>
```

Remove the key afterwards.
