# Probe previews and planner failures

`run.sh` runs the real probe entrypoint on main and on this branch, through `stub-tailnet.ts`, and writes `main.txt`,
`branch.txt` and `diff.txt`. It shows what a guest and the control plane see change:

- NEXUS_API's refusals of a body it does not take are still 400, now in parse.ts's one-line form.
- A refused upgrade gets the same status, headers and body from `rawResponse`, with `content-length` after `connection`.
- A probe.json that is not JSON still stops the probe, now with `config:` before the JSON error.

No pylon runs here: this pylon has neither Docker nor KVM. The preview, link and planner changes are pinned by the unit
and loop tests the PR names.
