/**
 * Design point 1: "a human user identified from the company tailnet through tailscaled's whois". Asks this machine's
 * own tailscaled, over its LocalAPI socket and nothing else, what whois says of every peer it knows, and prints only
 * the shape: whether the answer names a human login, a tagged device, or another tailnet's user. Names are not printed.
 * Then it shows what Nexus's own whois client (src/node-base/tailscaled.ts) keeps of the same answer.
 *
 *   node interrogate/whois-shape.ts
 */
import { request } from "node:http";
import { linuxTailscaledSocket, localApiWhoisNode } from "../src/node-base/tailscaled.ts";

const get = (path: string) => new Promise<string>((resolve, reject) => {
  const req = request({ socketPath: linuxTailscaledSocket, method: "GET", path, headers: { host: "local-tailscaled.sock" } }, (res) => {
    let body = "";
    res.setEncoding("utf8").on("data", (part) => { body += part; }).on("end", () => resolve(body));
  });
  req.on("error", reject).end();
});

const status = JSON.parse(await get("/localapi/v0/status")) as { Self: { TailscaleIPs?: string[] }; Peer?: Record<string, { TailscaleIPs?: string[] }> };
const devices = [status.Self, ...Object.values(status.Peer ?? {})];
const shapes = new Map<string, number>();
let sample: { address: string; kept: unknown } | null = null;
for (const device of devices) {
  const address = device.TailscaleIPs?.find((ip) => !ip.includes(":"));
  if (address === undefined) continue;
  const raw = await get(`/localapi/v0/whois?addr=${encodeURIComponent(`${address}:1`)}`);
  let answer: { Node?: { Tags?: string[]; User?: number }; UserProfile?: { LoginName?: string; ID?: number }; CapMap?: Record<string, unknown> | null };
  try { answer = JSON.parse(raw); } catch { shapes.set("no answer", (shapes.get("no answer") ?? 0) + 1); continue; }
  const login = answer.UserProfile?.LoginName ?? "";
  const shape = (answer.Node?.Tags?.length ?? 0) > 0
    ? `tagged device: UserProfile.LoginName is ${JSON.stringify(login === "tagged-devices" ? login : "<other>")}, Node.Tags has ${answer.Node!.Tags!.length}`
    : `user device: UserProfile.LoginName is a ${login.includes("@") ? "login with an @" : "login without an @"}`;
  const key = `${shape}; CapMap ${answer.CapMap == null ? "absent" : `has ${Object.keys(answer.CapMap).length} keys`}`;
  shapes.set(key, (shapes.get(key) ?? 0) + 1);
  if (sample === null && (answer.Node?.Tags?.length ?? 0) > 0) sample = { address, kept: null };
}
for (const [shape, count] of shapes) console.log(`${count} device(s): ${shape}`);
const kept = await localApiWhoisNode()(status.Self.TailscaleIPs!.find((ip) => !ip.includes(":"))!, 1);
console.log(`Nexus's whois client keeps of an answer: ${JSON.stringify(Object.keys(kept ?? {}))}`);
