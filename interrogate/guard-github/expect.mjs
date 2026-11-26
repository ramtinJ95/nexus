// Is the 502 on "Expect: 100-continue" the guard's doing or Gondolin's? Sends a harmless GraphQL query with Expect
// from the guest through three mediators in turn: no onRequest hook, a hook that returns undefined, and a hook that
// reads the body and rebuilds the Request as guard.mjs does. Also a 2 MiB body with no explicit header, where curl
// adds Expect itself. One VM at a time.
import { VM, createHttpHooks } from "@earendil-works/gondolin";
import { readFileSync } from "node:fs";

const token = readFileSync(0, "utf8").trim();
const hooks = {
  "no onRequest": undefined,
  "onRequest returns undefined": async () => undefined,
  "onRequest rebuilds Request": async (r) => { const raw = Buffer.from(await r.arrayBuffer()); return new Request(r.url, { method: r.method, headers: r.headers, body: raw.length ? raw : undefined }); },
  "rebuild without expect header": async (r) => { const raw = Buffer.from(await r.arrayBuffer()); const h = new Headers(r.headers); h.delete("expect"); return new Request(r.url, { method: r.method, headers: h, body: raw.length ? raw : undefined }); },
};
const q = (pad) => `{"query":"query { viewer { login } }${" ".repeat(pad)}"}`;
for (const [label, onRequest] of Object.entries(hooks)) {
  const { httpHooks, env } = createHttpHooks({ allowedHosts: ["api.github.com"], secrets: { GH_TOKEN: { hosts: ["api.github.com"], value: token } }, ...(onRequest ? { onRequest } : {}) });
  const vm = await VM.create({ memory: "1G", cpus: 1, httpHooks, env: { GH_TOKEN: env.GH_TOKEN } });
  const c = async (body, hdr) => { const r = await vm.exec(["/bin/sh", "-c", `curl -sS -o /tmp/b -w '%{http_code}' -X POST -H "Authorization: Bearer $GH_TOKEN" ${hdr} --data-binary @- https://api.github.com/graphql; printf ' '; head -c 60 /tmp/b`], { stdin: body }); return (r.stdout + r.stderr).trim(); };
  console.log(`${label.padEnd(32)} | 4 KiB + Expect header: ${await c(q(4096), "-H 'Expect: 100-continue'")} | 4 KiB no header: ${await c(q(4096), "")} | 2 MiB no header: ${await c(q(2 << 20), "")}`);
  await vm.close();
}
process.exit(0);
