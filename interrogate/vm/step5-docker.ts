// Step 5: dockerd in a Gondolin guest booted by pylon-vm, and a container's HTTPS through Gondolin's TLS interception.
// Image: Gondolin's Alpine build (same linux-virt kernel the Nexus pylon image boots) plus docker, docker-cli,
// containerd, iptables (interrogate/vm/docker-image.json -> docker-assets). Nexus's own image is Debian + docker.io.
import { resolve } from "node:path";
import { bootWith, controllerLog, destroy, sh } from "./kit.ts";

const name = "dock";
const hosts = ["registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com", "production.cloudfront.docker.com", "example.com"];
const step = async (label: string, cmd: string, ms = 300_000) => {
  const r = await sh(name, cmd, ms);
  console.log(`--- ${label} (exit ${r.exitCode}, ${r.ms} ms)\n${r.output.trim().split("\n").slice(-12).join("\n")}`);
  return r;
};
try {
  // 1 GiB: this build pulled Alpine linux-virt 6.18.65, which hung at ACPI at 2 GiB under QEMU 11.1.2 in 3 of 3 boots (see report).
  await bootWith(name, 1, resolve("docker-assets"), hosts);
  await step("guest", "uname -r; df -h / | tail -1; ls /usr/local/share/ca-certificates/ 2>&1; grep -c BEGIN /etc/ssl/certs/ca-certificates.crt");
  await step("cgroups as Gondolin's init leaves them", "mount | grep -i cgroup || echo no-cgroup-mounted; cat /proc/filesystems | grep cgroup");
  await step("dockerd as is", "timeout 20 dockerd >/var/log/dockerd0.log 2>&1; tail -1 /var/log/dockerd0.log");
  await step("mount cgroup2", "mount -t cgroup2 none /sys/fs/cgroup && cat /sys/fs/cgroup/cgroup.controllers");
  await step("start dockerd", "(dockerd >/var/log/dockerd.log 2>&1 &); for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done; docker info --format 'server {{.ServerVersion}} storage {{.Driver}} cgroup {{.CgroupVersion}}' 2>&1; tail -3 /var/log/dockerd.log");
  await step("pull through interception", "docker pull -q alpine:3.20 2>&1");
  await step("container HTTPS, image's own CA store", "docker run --rm alpine:3.20 wget -S -O /dev/null https://registry-1.docker.io/v2/ 2>&1 | head -3");
  await step("container HTTPS, guest's CA bundle mounted", "docker run --rm -v /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro alpine:3.20 wget -S -O /dev/null https://registry-1.docker.io/v2/ 2>&1 | head -3");
  await step("container HTTPS to a host off the allowlist", "docker run --rm -v /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro alpine:3.20 wget -S -O /dev/null https://github.com/ 2>&1 | head -2");
  await step("compose-style user network between two containers", "docker network create t >/dev/null && docker run -d --name web --network t alpine:3.20 sh -c 'while true; do printf \"HTTP/1.0 200 OK\\r\\n\\r\\nhi-from-web\\n\" | nc -l -p 8080; done' >/dev/null && sleep 2 && docker ps --format '{{.Names}} {{.Status}}' && docker run --rm --network t alpine:3.20 wget -qO- http://web:8080/ 2>&1");
  await step("a service name that no container has, on the same network", "docker run --rm --network t alpine:3.20 sh -c 'nslookup db 2>&1 | tail -3; wget -qO- http://db:5432/ 2>&1 | head -2'");
  await step("cleanup", "docker rm -f web >/dev/null; docker network rm t");
} catch (e) {
  console.log("FAILED", String(e)); console.log(controllerLog(name));
} finally {
  console.log("destroy", JSON.stringify(await destroy(name).catch((e) => String(e))));
}
