// Narrows what uploads.mjs showed: which upload shapes pass Gondolin's HTTP path, with and without a request hook.
// CASES is a ;-separated list of "<MiB>:<cl|chunked>:<http|https>[:noexpect]" (noexpect: curl sends no Expect: 100-continue). HOOK=0 leaves the onRequest hook out.
import { VM, createHttpHooks } from "@earendil-works/gondolin";
import { readFileSync } from "node:fs";

const host = "bench.test";
const rssMiB = (pid) => Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1]) / 1024);
const hook = process.env.HOOK !== "0";
const { httpHooks } = createHttpHooks({
  allowedHosts: [host], allowedInternalHosts: [host],
  ...(hook ? { onRequest: (request) => new URL(request.url).hostname === "nexus.pylon" ? new Response("bridge") : undefined } : {}),
});
const debug = [];
const vm = await VM.create({ memory: "2G", cpus: 2, httpHooks, ...(process.env.MAX_BODY ? { maxHttpBodyBytes: Number(process.env.MAX_BODY) } : {}), debugLog: (component, message) => { if (/error|fail|blocked|reject/i.test(message)) debug.push(`${component}: ${message}`); } });
await vm.exec("true");
console.log(`onRequest hook: ${hook ? "present, passes other hosts through (as Nexus's host bridge hook)" : "absent"}; maxHttpBodyBytes: ${process.env.MAX_BODY ?? "default"}`);
for (const spec of (process.env.CASES ?? "1:cl:https").split(";")) {
  const [mib, mode, scheme, expect] = spec.split(":");
  const url = scheme === "http" ? `http://${host}:8080/echo` : `https://${host}:8443/echo`;
  const before = rssMiB(process.pid);
  let peak = before;
  const sampler = setInterval(() => { peak = Math.max(peak, rssMiB(process.pid)); }, 50);
  const t = performance.now();
  const r = await vm.exec(["/bin/sh", "-c", `head -c ${Number(mib) << 20} /dev/zero | curl -sS -m 900 -X POST -H 'content-type: application/octet-stream' ${mode === "chunked" ? "-H 'transfer-encoding: chunked'" : ""} ${expect === "noexpect" ? "-H 'Expect:'" : ""} --data-binary @- -w ' http=%{http_code}' ${url} 2>&1 | tail -1`]);
  clearInterval(sampler);
  const secs = (performance.now() - t) / 1000;
  console.log(`${`POST ${mib} MiB ${mode === "cl" ? "Content-Length" : "chunked"} ${scheme}${expect === "noexpect" ? " no-Expect" : ""}`.padEnd(46)} ${(r.stdout + r.stderr).trim().replace(/\n/g, " | ").slice(0, 150)}  [${secs.toFixed(1)} s = ${(Number(mib) / secs).toFixed(1)} MiB/s; controller RSS ${before} -> peak ${peak} MiB]`);
  for (const line of debug.splice(0)) console.log(`    debug ${line.slice(0, 220)}`);
}
await vm.close();
process.exit(0);
