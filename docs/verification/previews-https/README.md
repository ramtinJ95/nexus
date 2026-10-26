# Previews over HTTPS

Verified in this task's pylon on `rj-firebat` on 2026-10-26, from main `a9a356c`. Nothing here touched the live control plane, another thread or a node's serve config, apart from previewing this thread's own Vite port with `nexus preview`.

## Where HTTP showed

Every URL Nexus hands out is already HTTPS. `live-pylon.txt` shows `nexus preview`, `nexus services list` and PYLON.md in this pylon, all printing `https://rj-firebat.tailc817d3.ts.net:10201/`. The control plane builds `Preview.url` as `https://<tailnet host>:<port>/` in `src/control/registry.ts`, and the dashboard, `nexus show`, `nexus ports` and `nexus preview` print that field. A port without a preview has no URL. Its **Open** button publishes it first.

HTTP came from the apps. A pylon cannot reach its own tailnet URL (the last line of `live-pylon.txt` is the pylon's `403 blocked by policy`), so `browser.ts` rebuilds the path a tailnet browser takes, inside the pylon:

1. `serve-entry.ts` stands in for one `tailscale serve --https=<port>` entry. It terminates TLS and passes the bytes on to the gateway, keeping the public `Host`. Plain HTTP to the port gets the reply Go's TLS server gives, `400 Client sent an HTTP request to an HTTPS server.` That reply is inferred from Go's `net/http`, which tailscale serve uses. It was not captured from a real serve port.
2. The gateway is `src/probe/gateway.ts`, the probe's real code, given as the first argument.
3. A TCP relay stands in for the pylon's preview relay, and carries each connection to the app on `127.0.0.1` or `::1`.
4. Headless Chrome 138 opens `https://rj-firebat.example.ts.net:7443/`, an HTTPS page with links to the previews, as the dashboard has. It follows each link.

The three apps are:

- `vite`, a Vite 6.3.5 dev server bound to `localhost` (`::1`), with live reload. The capture edits `main.js` and reads the page again.
- `wsgi`, `wsgi_app.py`, a stdlib WSGI app that builds absolute URLs from its WSGI environ, as Flask and Django do without proxy settings. It redirects `/` to `/login`, and `/login` links a stylesheet.
- `naive`, a Node server in `browser.ts` that redirects to `http://<Host>/dashboard`, loads `http://<Host>/app.js`, and opens a live-reload socket on `ws://` + `location.host`.

`browser-before.txt` runs the gateway from main. Vite works. Its client derives `wss://` from the page's own URL. The other two break:

- The redirect sends the browser to `http://...:10202/login`, and the page shows `Client sent an HTTP request to an HTTPS server.`
- Opened directly over HTTPS, `/login` loads, but Chrome blocks its stylesheet as mixed content.

`browser-after.txt` runs this branch's gateway. Both redirects land on `https://`, the stylesheet and `app.js` load over HTTPS, and the `ws://` socket opens as `wss://` with a 101. Vite is unchanged.

## Vite refuses the tailnet name by default

`vite-host-check.txt` shows Vite 6.3.5 answering 403 to the preview's `Host` until `server.allowedHosts` allows it. HTTPS does not cause this, and Nexus cannot fix it without lying about `Host`, so PYLON.md now tells the agent to allow the name. The browser captures used `vite.config.js` from this folder.

## Run it again

```sh
S=$(mktemp -d)
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=rj-firebat.example.ts.net -addext subjectAltName=DNS:rj-firebat.example.ts.net -keyout $S/key.pem -out $S/cert.pem
echo "127.0.0.1 rj-firebat.example.ts.net" | sudo tee -a /etc/hosts
(cd $S && mkdir browser && cd browser && npm init -y && npm i @sparticuz/chromium@138.0.2 puppeteer-core@24.15.0)
mkdir $S/browser/al2023 && node -e 'process.stdout.write(require("zlib").brotliDecompressSync(require("fs").readFileSync(process.argv[1])))' $S/browser/node_modules/@sparticuz/chromium/bin/al2023.tar.br | tar x -C $S/browser/al2023
mkdir $S/vite-app && cp docs/verification/previews-https/{index.html,vite.config.js} $S/vite-app && (cd $S/vite-app && npm init -y && npm i -D vite@6.3.5 && npx vite --port 5173 &)
git show main:src/probe/gateway.ts > $S/gateway-before.ts
for g in $S/gateway-before.ts $PWD/src/probe/gateway.ts; do
	CERT_DIR=$S BROWSER_DIR=$S/browser VITE_APP=$S/vite-app LD_LIBRARY_PATH=$S/browser/al2023/lib node docs/verification/previews-https/browser.ts $g
done
```

## Tests

`tests.txt` and `typecheck.txt` hold `npm test` and `npm run typecheck` on this branch.
