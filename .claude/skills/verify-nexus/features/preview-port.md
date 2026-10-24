# Preview a listening port

A thread lists the TCP ports that something in its pylon listens on, whether or not the agent declared them. Opening one publishes it as a preview with its own https URL, which stays the thread's across pauses until someone unpublishes it. A process the agent started by hand does not survive a pause, so after a wake the URL answers again once the agent starts it again. Unpublishing closes the URL, lists the port again without a preview, and holds across a wake. Only a published port can be unpublished: a declared service's preview is refused.

## Sub-features

- `ports-cli` lists a port the agent's process listens on, with no service and no preview.
- `preview-cli` publishes the port with `nexus preview`, names the URL at once, and with `--wait` prints it once it is served.
- `preview-serve` fetches the URL through the probe's preview gateway and gets the process's answer.
- `preview-wake` keeps the URL across an archive and unarchive, and serves it again once the process runs again.
- `ports-ui` lists the port in the thread page's Ports section and publishes it with its `Open` button, which moves it under Previews.
- `unpreview-cli` unpublishes the port with `nexus unpreview`, which prints `null`, lists the port again with `preview` null, and succeeds again when repeated.
- `unpreview-closed` gets the gateway's own 404 instead of the process's answer once `unpreview` returns. On a real node the serve entry goes a few seconds later and new connections are refused, which this stack cannot show.
- `unpreview-refused` refuses the port of a declared service's preview with exit code 1, naming the service.
- `preview-refused` refuses a port the pylon does not publish with exit code 1, and the reserved port 22 with exit code 64.
- `unpreview-wake` keeps the port unpublished across an archive and unarchive, and `preview --wait` publishes it again.
- `unpreview-ui` unpublishes a published port with its `Unpublish` button under Previews, which moves it back under Ports.

## How to get to it (user POV)

- Run `nexus ports <thread>`, `nexus preview <thread> <port> [--wait]` and `nexus unpreview <thread> <port>` in a terminal.
- Open the thread page, `/threads/<id>`, and find the port under Ports in the inspector, or under Previews with its `Unpublish` button once it is published. On a narrow window, open the inspector with the pylon button in the strip.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds.
- Thread `T` was started with `$V cli ports-start -- start --project spoon --title "ports: proof" --json`, and its pylon is `running`.
- `SERVER` is a server on a published port, detached so it outlives the tool call: `setsid nohup node -e "require('http').createServer((q, r) => r.end('ports-proof')).listen(8001)" </dev/null >/tmp/ports-proof.log 2>&1 & sleep 1; echo started`.

- **Start the process.** Run `$V cli ports-serve -- send $T "bash: $SERVER" --json`, then poll `conversation $T --json` until a `pi.tool-result` holds `started`.
- **Listed.** Repeat `$V cli ports-cli -- ports $T --json` every 5 s, for up to 1 minute, until it holds `{"port": 8001, "service": null, "preview": null}`.
- **Publish.** Run `$V cli preview-cli -- preview $T 8001 --json`. Exit 0. The `Preview` has `service` `port-8001`, an `httpsPort` from 10200, and `url` `https://127.0.0.1:<httpsPort>/`. Then run `$V cli preview-wait -- preview $T 8001 --wait --json`, which exits 0 with the same preview and `ready` true.
- **Served.** Fetch it through the gateway, as tailscale serve would: `curl -sS -H "Host: 127.0.0.1:<httpsPort>" http://127.0.0.1:7481/ > "$($V evidence)/preview-serve.txt"`. The file reads `ports-proof`.
- **Across a wake.** Run `archive $T --json`, poll `show` until `.pylon.actualState` is `paused`, then `unarchive $T --json` and poll until it is `running`. `show $T --json` still lists the preview with the same `url`. Send `bash: $SERVER` again, then repeat the curl into `preview-wake.txt`, which reads `ports-proof`.
- **Dashboard.** Start a second server on 8002 the same way, with `8001` replaced by `8002` in `SERVER`.
  - Run `$V browser ports-ui-open -- goto http://127.0.0.1:7470/threads/$T`. Within two polls the Ports section lists `8002` with an `Open` button. Capture `snapshot --filename ports-ui-before.md`.
  - Run `$V browser ports-ui-click -- click 'role=button[name="Open port 8002"]'`.
  - Within a few polls 8002 leaves Ports, and Previews lists `port-8002` with a link named `Open port-8002`, whose `href` is the `url` that `ports $T --json` reports for 8002. Each port shows once in the inspector: 8001 and 8002 only under Previews, and neither under Outputs. Capture `snapshot --filename ports-ui-after.md` and `screenshot --filename ports-ui-after.png`.
- **Unpublish.** With the process on 8001 running again after the wake, run `$V cli unpreview-cli -- unpreview $T 8001 --json`. Exit 0, and stdout is `null`. At once, `show $T --json` lists no preview of `port-8001`, and `ports $T --json` has 8001 with `preview` null. Its `service` can still read `port-8001` until the node's next report, so don't assert it.
- **Closed.** Repeat the curl with `-w '%{http_code}'` into `unpreview-closed.txt` right after: the answer is 404 `no preview is published on ...`, the gateway's own, never `ports-proof`.
- **Again.** Run `$V cli unpreview-again -- unpreview $T 8001 --json`. Exit 0, and stdout is `null`.
- **Dashboard unpublish.** Within two polls of the thread page, Previews lists `port-8002` with a button named `Unpublish port-8002`, and `port-8001` is gone. Capture `snapshot --filename unpreview-ui-before.md`, run `$V browser unpreview-ui-click -- click 'role=button[name="Unpublish port-8002"]'`, and within a few polls 8002 leaves Previews and Ports lists it again with its `Open` button. Capture `snapshot --filename unpreview-ui-after.md` and `screenshot --filename unpreview-ui-after.png`. Then `ports $T --json` has 8002 with `preview` null.
- **Across a wake.** Archive and unarchive `T` as above, then send `bash: $SERVER` again. `ports $T --json` has 8001 with `preview` null, `show $T --json` lists no `port-8001`, and the curl from **Closed** still gets 404, into `unpreview-wake.txt`.
- **Publish again.** Run `$V cli unpreview-republish -- preview $T 8001 --wait --json`. Exit 0 with `ready` true. Curl its `httpsPort` into `unpreview-republish.txt`, which reads `ports-proof`.
- **Refused edges.** `$V cli ports-bad -- preview $T 3000 --json` exits 1, because the Docker pylon publishes only 8000 to 8007. `$V cli ports-reserved -- preview $T 22 --json` exits 64 with `kind` `invalid` and `status` 400.
- **Refused.** Last, because the declared `web` takes the lowest free https port, which is the one the dashboard's unpublish of 8002 freed. Declare a service with a preview on 8003: `DECLARE='mkdir -p .nexus && printf "services:\n  web:\n    command: sleep infinity\n    port: 8003\n    preview: true\n" > .nexus/services.yaml && cat .nexus/services.yaml'`, then `send $T "bash: $DECLARE" --json`. Poll `show $T --json` until `previews` has `web`. The node reads the service file on its next report, which took 17 s here and can take up to a minute. Run `$V cli unpreview-refused -- unpreview $T 8003 --json`. Exit 1, and stderr's `error` is the pylon's reason alone, `Port 8003 is the preview of service web, not a linked port. ...`, with `status` 422 and no probe URL or HTTP 500 in it. `show` still lists the preview of `web`. `web` runs `sleep infinity` and never listens, so the pylon soon marks the service failed and its URL answers 502. Repeat `$V cli preview-failed -- show $T --json` every 5 s, for up to 2 minutes, until the preview of `web` has `ready` false and `failed` `the service web failed. ...`, and the thread page's Previews shows `web` as `failed` with that reason and no `Open` link.
- **Proof.** The recorded `ports-cli`, `preview-cli`, `preview-wait`, `preview-serve.txt`, the `show` after the wake, `preview-wake.txt`, the two dashboard snapshots with the screenshot, then `unpreview-cli`, `unpreview-closed.txt`, `unpreview-again`, the unpublish snapshots and screenshot, `unpreview-wake.txt`, `unpreview-republish`, `unpreview-republish.txt`, `ports-bad`, `ports-reserved`, `unpreview-refused` and the last `preview-failed`.

## Gotchas

- The Docker double links only the ports its `docker run` published, 8000 to 8007. Any other port is refused with exit code 1, so a recipe on port 3000 fails here but works in a real pylon.
- Ports are read every 10 s, so a fresh server shows up to about 10 s later. Poll, don't sleep.
- The stack's `tailscale serve` is a fake, and the node's tailnet name is `127.0.0.1`. A URL here proves the gateway's routing, not a real MagicDNS certificate or the tailnet.
- The curl goes straight to the gateway on port 7481, with no tailscale listener in front, and the fake `tailscale serve` edits only its own config file. So a closed preview here answers the gateway's 404 for good. On a real node, the gateway answers 404 until the loop's next pass removes the serve entry, and a new connection is refused after that.
- The pause loses the process with the container's memory, as on a real pylon. Before the agent starts it again, the gateway reaches the published port but nothing answers behind it, so the URL gives an error rather than `ports-proof`.
