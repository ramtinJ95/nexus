// Design point 3: "Pushes go over HTTPS with the owner's token." Today a pylon pushes over SSH, which Gondolin
// tunnels. This pushes with the real git client over HTTPS from inside a real Gondolin VM, through the same HTTP
// mediator Nexus configures (createHttpHooks, no maxHttpBodyBytes), to git's own http-backend.
// SIZES is a ;-separated list of pack sizes in MiB (random, so incompressible). One VM, 2 vCPUs, 2 GiB, closed at the end.
import { VM, createHttpHooks } from "@earendil-works/gondolin";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const host = "bench.test";
const rssMiB = (pid) => Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1]) / 1024);
execFileSync("git", ["init", "--quiet", "--bare", "/tmp/git/repo.git"]);
const remote = spawn("node", ["git-server.mjs", "/tmp/git", "/tmp/tls/leaf.key", "/tmp/tls/leaf.pem"], { stdio: ["ignore", "pipe", "inherit"] });
const remoteLog = [];
remote.stdout.on("data", (d) => remoteLog.push(...String(d).trim().split("\n")));
await new Promise((r) => setTimeout(r, 500));

const { httpHooks } = createHttpHooks({
  allowedHosts: [host, "dl-cdn.alpinelinux.org"], allowedInternalHosts: [host],
  onRequest: (request) => new URL(request.url).hostname === "nexus.pylon" ? new Response("bridge") : undefined,
});
const vm = await VM.create({ memory: "2G", cpus: 2, httpHooks, ...(process.env.MAX_BODY ? { maxHttpBodyBytes: Number(process.env.MAX_BODY) } : {}) });
const sh = async (script) => { const r = await vm.exec(["/bin/sh", "-c", script]); return { code: r.exitCode, out: (r.stdout + r.stderr).trim() }; };
const install = await sh("apk add --no-cache git >/dev/null 2>&1; git --version");
console.log(`guest: ${install.out}; maxHttpBodyBytes: ${process.env.MAX_BODY ?? "Gondolin's default, as Nexus leaves it"}`);
await sh("git config --global user.email a@b.c && git config --global user.name a && git init -q /root/w && cd /root/w && git commit -q --allow-empty -m base");
console.log(`fetch over HTTPS: ${(await sh(`cd /root/w && git push -q https://${host}:8444/repo.git HEAD:refs/heads/main 2>&1; git ls-remote https://${host}:8444/repo.git 2>&1 | head -2`)).out.replace(/\n/g, " | ")}`);
for (const mib of (process.env.SIZES ?? "5;30;70").split(";").map(Number)) {
  await sh(`cd /root/w && head -c ${mib << 20} /dev/urandom > blob-${mib}.bin && git add . && git commit -q -m 'add ${mib} MiB'`);
  const before = rssMiB(process.pid);
  let peak = before;
  const sampler = setInterval(() => { peak = Math.max(peak, rssMiB(process.pid)); }, 50);
  const t = performance.now();
  const r = await sh(`cd /root/w && git push https://${host}:8444/repo.git HEAD:refs/heads/push-${mib} > /tmp/push.out 2>&1; code=$?; tail -4 /tmp/push.out; echo "git exit=$code"`);
  clearInterval(sampler);
  const secs = (performance.now() - t) / 1000;
  await new Promise((res) => setTimeout(res, 300));
  console.log(`\ngit push of a ${mib} MiB commit over HTTPS: ${secs.toFixed(1)} s (${(mib / secs).toFixed(1)} MiB/s); controller RSS ${before} -> peak ${peak} MiB`);
  console.log(`  git said: ${r.out.replace(/\n/g, "\n            ")}`);
  for (const line of remoteLog.splice(0)) console.log(`  ${line}`);
  console.log(`  remote has the branch: ${execFileSync("git", ["-C", "/tmp/git/repo.git", "branch", "--list", `push-${mib}`]).toString().trim() !== ""}`);
}
await vm.close();
remote.kill();
console.log("\nclosed: the VM is stopped and removed");
process.exit(0);
