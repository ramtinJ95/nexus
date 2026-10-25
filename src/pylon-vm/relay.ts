/**
 * Gondolin's preview ingress always dials the guest's 127.0.0.1 (its guest tcp_forwarder offers no other address), so a
 * server bound to `::1` alone, as Node 17 and later bind `localhost`, could not be previewed. Instead of the app's port,
 * each ingress route points at a relay port of Nexus's own (relayPorts in src/project.ts), and the relay carries each
 * connection on to the app's port on 127.0.0.1, or on `::1` when nothing listens there. The relay never binds an
 * app's port, so an app is free to bind it, rebind it, or move it between addresses.
 *
 * The relay is one process per boot. It reads relayMap, a JSON object from relay port to app port that GuestServices
 * rewrites whenever its routes change, every 200 ms, and listens on exactly the relay ports it names. Each port it
 * starts or stops relaying, each it cannot bind, and each restart is a line in relayLog.
 */
import type { VM } from "@earendil-works/gondolin";
import { checked } from "./guest.ts";
import { shellQuote as q } from "./storage.ts";

export const relayMap = "/var/lib/pi-sandbox/relays.json";
export const relayLog = "/var/lib/pi-sandbox/relay.log";

/** argv: the relay map's path. */
export const relayScript = [
	"import asyncio,json,sys",
	"async def pipe(r,w,other):",
	" try:",
	"  while data:=await r.read(65536):",
	"   w.write(data); await w.drain()",
	"  w.write_eof()",
	" except OSError:",
	"  w.close(); other.close()",
	"async def relay(r,w,port):",
	" for host in ('127.0.0.1','::1'):",
	"  try:",
	"   ur,uw=await asyncio.open_connection(host,port); break",
	"  except OSError: pass",
	" else:",
	"  w.close(); return",
	" await asyncio.gather(pipe(r,uw,w),pipe(ur,w,uw))",
	" w.close(); uw.close()",
	"async def main():",
	" servers={}; failed={}",
	" while True:",
	"  with open(sys.argv[1]) as f: wanted={int(k):v for k,v in json.load(f).items()}",
	"  for listen in [l for l,(port,_) in servers.items() if wanted.get(l)!=port]:",
	"   port,server=servers.pop(listen); print(f'stopped relaying 127.0.0.1:{listen} to port {port}',flush=True); server.close()",
	"  for listen,port in wanted.items():",
	"   if listen in servers: continue",
	"   try: server=await asyncio.start_server(lambda r,w,port=port: relay(r,w,port),'127.0.0.1',listen)",
	"   except OSError as e:",
	"    if failed.get(listen)!=str(e): print(f'cannot relay 127.0.0.1:{listen}: {e}',flush=True)",
	"    failed[listen]=str(e); continue",
	"   failed.pop(listen,None); servers[listen]=(port,server); print(f'relaying 127.0.0.1:{listen} to port {port}',flush=True)",
	"  await asyncio.sleep(0.2)",
	"asyncio.run(main())",
].join("\n");

/**
 * Starts the relay on an empty map, in its own session so it outlives the exec, under a loop that restarts it if it
 * dies and rotates its log as the service supervisor does (guest.ts). A boot starts it once, before any service.
 */
export async function startRelay(vm: VM): Promise<void> {
	const loop = [
		"while :; do",
		'  python3 -c "$0" "$1"',
		'  echo "relay exited $?, restarting in 1s"',
		`  if test "$(wc -c < ${q(relayLog)})" -gt 1048576; then mv ${q(relayLog)} ${q(`${relayLog}.previous`)}; exec >>${q(relayLog)} 2>&1; fi`,
		"  sleep 1",
		"done",
	].join("\n");
	await writeRelayMap(vm, new Map());
	await checked(vm, `setsid /bin/sh -c ${q(loop)} ${q(relayScript)} ${q(relayMap)} </dev/null >${q(relayLog)} 2>&1 &`);
}

/** Replaces the map, from app port to relay port, in one rename, so the relay never reads half of it. */
export async function writeRelayMap(vm: VM, relays: ReadonlyMap<number, number>): Promise<void> {
	const json = JSON.stringify(Object.fromEntries([...relays].map(([port, relay]) => [relay, port])));
	await checked(vm, `mkdir -p ${q("/var/lib/pi-sandbox")} && printf '%s' ${q(json)} > ${q(`${relayMap}.new`)} && mv ${q(`${relayMap}.new`)} ${q(relayMap)}`);
}
