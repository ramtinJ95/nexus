// Boots one real Gondolin VM (QEMU + KVM, 2 vCPUs, 2 GiB) with the same network mediator Nexus uses
// (createHttpHooks, as src/pylon-vm/network.ts does) and measures it. One VM at a time; it is closed at the end.
import { VM, createHttpHooks } from "@earendil-works/gondolin";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";

const host = "bench.test";
const out = (label, value) => console.log(`${label.padEnd(46)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
const rssMiB = (pid) => Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1]) / 1024);
const cpuSec = (pid) => { const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); return (Number(f[11]) + Number(f[12])) / 100; };
const sh = async (vm, script) => { const r = await vm.exec(["/bin/sh", "-c", script]); return { code: r.exitCode, out: (r.stdout + r.stderr).trim() }; };

const seen = [];
const { httpHooks } = createHttpHooks({
  allowedHosts: [host], allowedInternalHosts: [host],
  // Records what a request hook is handed, body included, as an egress guard would need.
  onRequest: async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/graphql") return undefined;
    const body = await request.text();
    seen.push({ method: request.method, path: url.pathname, body });
    if (/\bmutation\b/.test(body)) return new Response("refused by the hook\n", { status: 403 });
    return new Request(request.url, { method: request.method, headers: request.headers, body });
  },
});

const t0 = performance.now();
const vm = await VM.create({ memory: "2G", cpus: 2, httpHooks, tcp: process.env.TCP_MAP ? { hosts: { [`${host}:5432`]: "127.0.0.1:5432" } } : undefined });
await vm.exec("true");
out("boot: VM.create to first exec answered", `${Math.round(performance.now() - t0)} ms`);
const qemu = vm.getHostPid();
out("host processes for this VM", `controller node pid ${process.pid}, qemu pid ${qemu}`);
out("host RSS just after boot (guest RAM 2048 MiB)", `controller ${rssMiB(process.pid)} MiB, qemu ${rssMiB(qemu)} MiB`);
out("guest", (await sh(vm, "uname -r; nproc; free -m | sed -n 2p")).out.replace(/\n/g, " | "));

// Protocols.
out("HTTP/1.1 GET over TLS", (await sh(vm, `curl -sS -o /dev/null -w '%{http_code} http/%{http_version}' https://${host}:8443/blob?mb=1`)).out);
out("HTTP/2 asked for over TLS (curl --http2)", (await sh(vm, `curl -sS --http2 -o /dev/null -w '%{http_code} http/%{http_version}' https://${host}:8443/blob?mb=1`)).out);
out("HTTP/2 only (curl --http2-prior-knowledge)", (await sh(vm, `curl -sS -m 10 --http2-prior-knowledge -o /dev/null -w '%{http_code} http/%{http_version}' http://${host}:8080/blob?mb=1 2>&1 | tail -1`)).out);
out("plain TCP to an allowed host, port 5432", (await sh(vm, `echo ping | timeout 5 nc -w 3 ${host} 5432; echo "exit=$?"`)).out.replace(/\n/g, " "));
out("UDP to an allowed host, port 9999", (await sh(vm, `echo ping | timeout 5 nc -u -w 3 ${host} 9999; echo "exit=$?"`)).out.replace(/\n/g, " "));
out("HTTP/3 (QUIC, UDP 443) support in guest curl", (await sh(vm, `curl -sS -m 5 --http3-only -o /dev/null -w '%{http_code}' https://${host}:8443/blob?mb=1 2>&1 | tail -1`)).out);
out("host not on the allowlist", (await sh(vm, `curl -sS -m 10 -o /dev/null -w '%{http_code}' http://not-allowed.test:8080/ 2>&1 | tail -1`)).out);

// What a request hook sees: method, path and body, and a refusal by body.
out("hook: GraphQL query passes", (await sh(vm, `curl -sS -X POST -H 'content-type: application/json' -d '{"query":"query { viewer { login } }"}' https://${host}:8443/graphql`)).out);
out("hook: GraphQL mutation refused", (await sh(vm, `curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"query":"mutation { x }"}' https://${host}:8443/graphql`)).out);
out("hook saw", seen);

// Throughput and its cost. The upstream is on the same machine, so the path, not a link, is the limit.
const direct = (url) => {
  const t = performance.now();
  execFileSync("curl", ["-sS", "-o", "/dev/null", url]);
  return (performance.now() - t) / 1000;
};
for (const [label, url, mb] of [["HTTP", `http://${host}:8080/blob?mb=1024`, 1024], ["HTTPS", `https://${host}:8443/blob?mb=1024`, 1024]]) {
  const base = direct(url);
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const [c0, q0, t] = [process.cpuUsage(), cpuSec(qemu), performance.now()];
  const run = sh(vm, `curl -sS -o /dev/null -w '%{size_download}' ${url}`);
  // How long an unrelated exec waits on the same controller while the download runs.
  const execs = [];
  const probe = (async () => { for (let i = 0; i < 8; i++) { const s = performance.now(); await vm.exec("true"); execs.push(Math.round(performance.now() - s)); await new Promise((r) => setTimeout(r, 250)); } })();
  const result = await run;
  const secs = (performance.now() - t) / 1000;
  await probe;
  loop.disable();
  const c = process.cpuUsage(c0);
  out(`${label} download of ${mb} MiB into the guest`, `${result.out} bytes in ${secs.toFixed(1)} s = ${(mb / secs).toFixed(0)} MiB/s (${(mb * 8 / secs / 1000).toFixed(2)} Gbit/s); the same curl outside the VM: ${(mb / base).toFixed(0)} MiB/s`);
  out(`${label} host CPU spent on it`, `controller ${((c.user + c.system) / 1e6).toFixed(1)} CPU-s, qemu ${(cpuSec(qemu) - q0).toFixed(1)} CPU-s, over ${secs.toFixed(1)} s wall`);
  out(`${label} controller event loop delay meanwhile`, `p50 ${(loop.percentile(50) / 1e6).toFixed(0)} ms, p99 ${(loop.percentile(99) / 1e6).toFixed(0)} ms, max ${(loop.max / 1e6).toFixed(0)} ms; exec("true") took ${execs.join(", ")} ms`);
}
out("host RSS after the downloads", `controller ${rssMiB(process.pid)} MiB, qemu ${rssMiB(qemu)} MiB`);
// An upload, as an artifact or a registry push is.
{
  const t = performance.now();
  const r = await sh(vm, `head -c 268435456 /dev/zero | curl -sS -m 300 -X POST -H 'content-type: application/octet-stream' --data-binary @- https://${host}:8443/echo 2>&1 | tail -1`);
  out("HTTPS upload of 256 MiB (Content-Length)", `${r.out} in ${((performance.now() - t) / 1000).toFixed(1)} s`);
}
await vm.close();
out("closed", "the VM is stopped and removed");
process.exit(0);
