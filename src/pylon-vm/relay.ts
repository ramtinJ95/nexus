/**
 * Gondolin's preview ingress always dials the guest's 127.0.0.1 (its guest tcp_forwarder offers no other address), so a
 * server bound to `::1` alone, as Node 17 and later bind `localhost`, could not be previewed. Instead of the app's port,
 * each ingress route points at a relay port of Nexus's own (relayPorts in src/services-file.ts), and the relay carries each
 * connection on to the app's port on 127.0.0.1, or on `::1` when nothing listens there. The relay never binds an
 * app's port, so an app is free to bind it, rebind it, or move it between addresses.
 *
 * The relay is one process per boot. Every 200 ms it reads relayMap, which GuestServices rewrites whenever its routes
 * change, listens on exactly the relay ports it names, and writes relayStatus: the generation of the map it applied,
 * the relay ports it listens on with the app port each carries to, and why it cannot listen on the others. A relay port
 * something else holds, which only root can, is one it cannot listen on. GuestServices routes a preview only once the
 * status shows its relay port carrying to its app port, so the ingress never reaches a listener that is not the relay's
 * for that app. Each port the relay starts or stops relaying, each it cannot bind, and each restart is a line in
 * relayLog.
 */
import { z } from "zod";
import type { VM } from "@earendil-works/gondolin";
import { checked } from "./guest.ts";
import { shellQuote as q } from "../shell.ts";

export const relayMap = "/var/lib/pi-sandbox/relays.json";
export const relayStatus = "/var/lib/pi-sandbox/relay-status.json";
export const relayLog = "/var/lib/pi-sandbox/relay.log";

export const relayStatusSchema = z.strictObject({
	generation: z.number().int(),
	/** Relay port to the app port it carries to. */
	bound: z.record(z.string(), z.number().int()),
	/** Relay port to why the relay cannot listen on it. */
	failed: z.record(z.string(), z.string()),
});
export type RelayStatus = z.infer<typeof relayStatusSchema>;
export const noRelayStatus: RelayStatus = { generation: 0, bound: {}, failed: {} };

/**
 * argv: the map's path, the status's, and the log's, which it moves aside to `.previous` once it passes 1 MiB. The map
 * is `{"generation": n, "relays": {"<relay port>": <app port>}}`.
 */
export const relayScript = [
	"import asyncio,json,os,sys",
	"mapPath,statusPath,logPath=sys.argv[1:4]",
	"def log(line):",
	" if os.path.exists(logPath) and os.path.getsize(logPath)>1048576: os.replace(logPath,logPath+'.previous')",
	" with open(logPath,'a') as f: print(line,file=f)",
	"def publish(status):",
	" with open(statusPath+'.new','w') as f: json.dump(status,f)",
	" os.replace(statusPath+'.new',statusPath)",
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
	" log('relay started'); servers={}; failed={}; published=None",
	" while True:",
	"  with open(mapPath) as f: m=json.load(f)",
	"  wanted={int(k):v for k,v in m['relays'].items()}",
	"  for listen in [l for l,(port,_) in servers.items() if wanted.get(l)!=port]:",
	"   port,server=servers.pop(listen); log(f'stopped relaying 127.0.0.1:{listen} to port {port}'); server.close()",
	"  for listen in [l for l in failed if l not in wanted]: failed.pop(listen)",
	"  for listen,port in wanted.items():",
	"   if listen in servers: continue",
	"   try: server=await asyncio.start_server(lambda r,w,port=port: relay(r,w,port),'127.0.0.1',listen)",
	"   except OSError as e:",
	"    if failed.get(listen)!=str(e): log(f'cannot relay 127.0.0.1:{listen}: {e}')",
	"    failed[listen]=str(e); continue",
	"   failed.pop(listen,None); servers[listen]=(port,server); log(f'relaying 127.0.0.1:{listen} to port {port}')",
	"  status={'generation':m['generation'],'bound':{str(l):p for l,(p,_) in servers.items()},'failed':{str(l):e for l,e in failed.items()}}",
	"  if status!=published: publish(status); published=status",
	"  await asyncio.sleep(0.2)",
	"asyncio.run(main())",
].join("\n");

/**
 * Starts the relay on an empty map, in its own session so it outlives the exec, under a loop that restarts it if it
 * dies. A boot starts it once, before any service. A crash's traceback goes to the log too, which the relay rotates, so
 * a relay that keeps crashing cannot fill the disk.
 */
export async function startRelay(vm: VM): Promise<void> {
	const loop = 'while :; do python3 -c "$0" "$1" "$2" "$3" 2>>"$3"; echo "relay exited $?, restarting in 1s" >>"$3"; sleep 1; done';
	await checked(vm, `rm -f ${q(relayLog)} ${q(relayStatus)}`);
	await writeRelayMap(vm, 0, new Map());
	await checked(vm, `setsid /bin/sh -c ${q(loop)} ${q(relayScript)} ${q(relayMap)} ${q(relayStatus)} ${q(relayLog)} </dev/null >/dev/null 2>&1 &`);
}

/** Replaces the map, from app port to relay port, in one rename, so the relay never reads half of it. */
export async function writeRelayMap(vm: VM, generation: number, relays: ReadonlyMap<number, number>): Promise<void> {
	const json = JSON.stringify({ generation, relays: Object.fromEntries([...relays].map(([port, relay]) => [relay, port])) });
	await checked(vm, `mkdir -p ${q("/var/lib/pi-sandbox")} && printf '%s' ${q(json)} > ${q(`${relayMap}.new`)} && mv ${q(`${relayMap}.new`)} ${q(relayMap)}`);
}

/** The relay's last status, or none before its first. */
export async function readRelayStatus(vm: VM): Promise<RelayStatus> {
	const text = (await checked(vm, `cat ${q(relayStatus)} 2>/dev/null || true`)).trim();
	return text === "" ? noRelayStatus : relayStatusSchema.parse(JSON.parse(text));
}
