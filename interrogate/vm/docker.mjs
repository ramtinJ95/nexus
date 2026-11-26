// Design point 6 and 8: a runner pylon pulls container images, runs Docker, and builds images inside the job.
// This runs Docker inside a real Gondolin VM, behind the same HTTP mediator Nexus configures (createHttpHooks: every
// TLS connection is terminated by Gondolin with its own CA, which Gondolin's init installs in the guest's trust store).
// Every host is allowed here, so the allowlist is not what is measured. One VM, 2 vCPUs, 2 GiB, closed at the end.
import { VM, createHttpHooks } from "@earendil-works/gondolin";
import { readFileSync } from "node:fs";

const rssMiB = (pid) => Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1]) / 1024);
const cpuSec = (pid) => { const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); return (Number(f[11]) + Number(f[12])) / 100; };
const { httpHooks } = createHttpHooks({ allowedInternalHosts: ["bench.test"] });
const vm = await VM.create({ memory: "2G", cpus: 2, httpHooks, rootfs: { mode: "cow", size: "8G" } });
await vm.exec("true");
const qemu = vm.getHostPid();
async function step(label, script) {
  const [c0, q0, t] = [process.cpuUsage(), cpuSec(qemu), performance.now()];
  const r = await vm.exec(["/bin/sh", "-c", `{ ${script}\n} 2>&1 | tail -6`]);
  const c = process.cpuUsage(c0);
  const secs = (performance.now() - t) / 1000;
  console.log(`\n## ${label}  [${secs.toFixed(1)} s; host CPU: controller ${((c.user + c.system) / 1e6).toFixed(1)} s, qemu ${(cpuSec(qemu) - q0).toFixed(1)} s; controller RSS ${rssMiB(process.pid)} MiB]`);
  console.log((r.stdout + r.stderr).trim().split("\n").map((l) => `   ${l.slice(0, 230)}`).join("\n"));
}

await step("install Docker in the guest", "apk add --no-cache docker iptables > /tmp/apk.log 2>&1; echo \"apk exit=$?\"; df -h / | tail -1");
await step("start dockerd with its defaults (bridge network, iptables NAT)", `
  mount -t cgroup2 none /sys/fs/cgroup 2>/dev/null
  (dockerd > /var/log/dockerd.log 2>&1 &)
  i=0; until docker info > /dev/null 2>&1; do i=$((i+1)); [ $i -gt 30 ] && break; sleep 1; done
  if docker info > /dev/null 2>&1; then docker info --format 'dockerd up: storage={{.Driver}} cgroup={{.CgroupVersion}} kernel={{.KernelVersion}}'; else echo 'dockerd did not start:'; tail -4 /var/log/dockerd.log; fi`);
await step("docker pull of a small image", "docker pull -q alpine:3.20; echo \"pull exit=$?\"");
await step("docker pull of a larger image (golang:alpine)", "docker pull -q golang:alpine; echo \"pull exit=$?\"; docker image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}'");
await step("a container reaches a plain-HTTP host", "docker run --rm alpine:3.20 wget -q -O- http://bench.test:8080/echo; echo \"exit=$?\"");
await step("the guest itself fetches an HTTPS URL", "curl -sS -o /dev/null -w 'http=%{http_code}\\n' https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz; echo \"exit=$?\"");
await step("a container fetches the same HTTPS URL", "docker run --rm alpine:3.20 wget -q -O /dev/null https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz; echo \"exit=$?\"");
await step("a container runs `go mod download`, as the stack's backend image build does", `
  docker run --rm golang:alpine sh -c 'mkdir /m && cd /m && go mod init example.test/m >/dev/null 2>&1 && printf "package m\\nimport _ \\"golang.org/x/text/language\\"\\n" > m.go && go mod tidy'; echo "exit=$?"`);
await step("docker build with a RUN step that installs a package", `
  mkdir -p /tmp/b && printf 'FROM alpine:3.20\\nRUN apk add --no-cache curl\\n' > /tmp/b/Dockerfile
  docker build -q -t t /tmp/b; echo "build exit=$?"`);
await vm.close();
console.log("\nclosed: the VM is stopped and removed");
process.exit(0);
