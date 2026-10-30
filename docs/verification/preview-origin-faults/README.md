# Preview origin faults

`run.sh` runs the real probe entrypoint on main and on this branch, with the pylon-vm backend and a preview gateway,
through `stub-tailnet.ts`. Each pylon is an instance directory holding only the `status.json` a controller would
write, by rename. It writes `main.txt`, `branch.txt` and `diff.txt`:

- A paused pylon, a pylon with no preview of the service and a pylon not on the node still get 503 with the reason.
- A `status.json` that is not JSON, and one that names an origin off loopback, got the same 503 on main, as if the
  pylon were waking. On this branch each gets 502 with the reason, and the probe logs it.
- A `status.json` replaced by rename is read on the next request on both.

No VM runs here: this pylon has neither Docker nor KVM, so the controller that writes `status.json` is not running.
