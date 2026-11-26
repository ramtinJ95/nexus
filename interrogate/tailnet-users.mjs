// Reads this machine's own `tailscale status --json` (local tailscaled only, nothing is sent to any peer) and
// says, without printing names, whether the Nexus nodes are owned by the same tailnet user as the person's devices.
import { execFileSync } from "node:child_process";

const status = JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8", maxBuffer: 64 << 20 }));
const devices = [status.Self, ...Object.values(status.Peer ?? {})];
const short = (d) => (d.DNSName ?? "").split(".")[0];
const nodes = devices.filter((d) => ["rj-firebat", "infra-testbench"].includes(short(d)));
const byUser = new Map();
for (const d of devices) byUser.set(d.UserID, (byUser.get(d.UserID) ?? 0) + 1);
console.log("devices:", devices.length, "distinct UserIDs:", byUser.size, "tagged devices:", devices.filter((d) => d.Tags?.length).length);
console.log("devices per user:", [...byUser.values()].sort((a, b) => b - a).join(", "));
for (const n of nodes) {
  console.log(`node ${short(n)}: tagged=${Boolean(n.Tags?.length)} sameUserAsThisWorkstation=${n.UserID === status.Self.UserID}`);
}
