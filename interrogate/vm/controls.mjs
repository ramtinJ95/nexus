// Controls for the upload findings, with no VM in the path: the same uploads straight to the same test servers.
// curl over HTTP/1.1 with its default `Expect: 100-continue`, and undici's fetch (Gondolin's own HTTP client)
// streaming a body, both reach the server whole. So what fails in uploads-debug.mjs fails in Gondolin's bridge.
import { execFileSync } from "node:child_process";
import { fetch } from "undici";

for (const url of ["http://bench.test:8080/echo", "https://bench.test:8443/echo"]) {
  for (const [label, extra] of [["Content-Length", []], ["chunked", ["-H", "transfer-encoding: chunked"]]]) {
    const out = execFileSync("sh", ["-c", `head -c 10485760 /dev/zero | curl -sS --http1.1 -X POST ${extra.map((e) => `'${e}'`).join(" ")} --data-binary @- -w ' http=%{http_code}' ${url}`]).toString().replace(/\n/g, "");
    console.log(`no VM: curl --http1.1 POST 10 MiB ${label}, default Expect -> ${out}`);
  }
}
for (const [mib, url] of [[10, "http://bench.test:8080/echo"], [60, "https://bench.test:8443/echo"]]) {
  let left = mib;
  const body = new ReadableStream({ pull(c) { if (left-- > 0) c.enqueue(new Uint8Array(1 << 20)); else c.close(); } });
  try {
    const r = await fetch(url, { method: "POST", body, duplex: "half", headers: { "content-length": String(mib << 20) } });
    console.log(`no VM: undici fetch POST ${mib} MiB ${url} -> ${r.status} ${(await r.text()).trim()}`);
  } catch (e) { console.log(`no VM: undici fetch POST ${mib} MiB ${url} -> ${e.message}: ${e.cause?.code ?? e.cause?.message}`); }
}
process.exit(0);
