// Boots an image directory with Gondolin's own API (no pylon-vm), runs one command, closes. Debug output to stderr.
import { VM } from "@earendil-works/gondolin";
const imagePath = process.argv[2];
const t0 = performance.now();
const vm = await VM.create({ cpus: 2, memory: process.env.MEM ?? "1G", ...(process.env.DISK ? { rootfs: { mode: "cow", size: process.env.DISK } } : {}), sandbox: { vmm: "qemu", accel: "kvm", ...(imagePath ? { imagePath } : {}), debug: ["protocol"] }, debugLog: (l) => process.stderr.write(`dbg ${typeof l === "string" ? l : JSON.stringify(l)}\n`) });
try {
  const r = await vm.exec(["sh", "-c", "uname -r; which dockerd"]);
  console.log("ms", Math.round(performance.now() - t0), "exit", r.exitCode, r.stdout, r.stderr);
} finally {
  await vm.close();
}
