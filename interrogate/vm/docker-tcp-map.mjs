// Follow-up to docker.mjs: whether Gondolin's own `tcp.hosts` mapping, which Nexus does not use, lets a container's
// HTTPS through. It maps a guest host:port straight to an upstream host:port, with no TLS interception, so no HTTP
// hook, allowlist check on the request, or secret swap sees that traffic. One VM, 2 vCPUs, 2 GiB, closed at the end.
import { VM, createHttpHooks } from "@earendil-works/gondolin";

const seen = [];
const { httpHooks } = createHttpHooks({ onRequest: (request) => { seen.push(new URL(request.url).hostname); return undefined; } });
const vm = await VM.create({
  memory: "2G", cpus: 2, httpHooks, rootfs: { mode: "cow", size: "8G" },
  tcp: { hosts: { "proxy.golang.org:443": "proxy.golang.org:443", "sum.golang.org:443": "sum.golang.org:443" } },
});
const sh = async (script) => { const r = await vm.exec(["/bin/sh", "-c", `{ ${script}\n} 2>&1 | tail -4`]); return (r.stdout + r.stderr).trim().replace(/\n/g, "\n   "); };
await sh("apk add --no-cache docker iptables > /dev/null 2>&1; mount -t cgroup2 none /sys/fs/cgroup 2>/dev/null; (dockerd > /var/log/dockerd.log 2>&1 &); i=0; until docker info > /dev/null 2>&1; do i=$((i+1)); [ $i -gt 30 ] && break; sleep 1; done; docker pull -q golang:alpine");
seen.length = 0;
console.log("with proxy.golang.org:443 and sum.golang.org:443 mapped as raw TCP, a container runs go mod tidy:");
console.log("   " + await sh(`docker run --rm golang:alpine sh -c 'mkdir /m && cd /m && go mod init example.test/m >/dev/null 2>&1 && printf "package m\\nimport _ \\"golang.org/x/text/language\\"\\n" > m.go && go mod tidy && grep text go.mod'; echo "exit=$?"`));
console.log(`hosts the HTTP hook saw meanwhile: ${JSON.stringify([...new Set(seen)])}`);
await vm.close();
console.log("closed: the VM is stopped and removed");
process.exit(0);
