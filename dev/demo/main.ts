/**
 * The dashboard with made-up data, for design work: `npm run demo` serves the control plane's API and dashboard on
 * 127.0.0.1 over a fresh registry in a temp directory, seeded from fixtures.ts. It wires the fakes the API
 * tests use, from outside: a fake harness, a whois that names the person for every caller, probes that answer from
 * memory, and no GitHub, deployer key or tailnet. A timer keeps the running threads working and a reply arriving.
 */
import type { TailnetNodeId } from "../../src/ids.ts";
import type { DoctorReport } from "../../src/control/doctor-model.ts";
import { laptop, testApi } from "../../src/test-support/api-kit.ts";
import { demoCheckout, demoProbes, demoReviews, seedDemo } from "./fixtures.ts";

const port = Number(process.env.PORT ?? 8080);
const closers: (() => unknown)[] = [];
const context = { after: (close: () => unknown) => { closers.push(close); } } as never as import("node:test").TestContext;
let report: () => DoctorReport | null = () => null;

/** Loopback, and any tailnet name, since a Nexus preview reaches the demo with its public address in Host. */
const hostnames: ReadonlySet<string> = { has: (host: string) => host === "127.0.0.1" || host === "localhost" || host.endsWith(".ts.net") } as ReadonlySet<string>;

const s = await testApi(context, {
  port, pipeline: true, planning: true, hostnames, probes: demoProbes(() => s.registry, await demoCheckout()),
  // The person may read node health, as a deployer may. Nothing here can deploy: there is no key and no release to resolve.
  deployment: { self: "nFIREBAT" as TailnetNodeId, deployers: new Set([laptop]), keys: {} },
  health: () => report(),
  reviews: demoReviews(() => s.registry),
});
const demo = await seedDemo(s);
report = demo.health;
console.log(`nexus demo: dashboard on http://127.0.0.1:${s.port}/`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    demo.stop();
    for (const close of closers.reverse()) await close();
    process.exit(0);
  });
}
