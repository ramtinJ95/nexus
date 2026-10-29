// A copy of docs/verification/dispatch-tables/stub-tailnet.ts. Loaded with --import before src/probe/main.ts, so the real entrypoint runs on loopback with no tailscaled. The
// config is parsed as written, then listens on 127.0.0.1 in place of its tailnet address, and whois names every
// caller as the config's control plane. Everything else in main.ts, the backends and the probe is the checkout's own.
import { registerHooks } from "node:module";

const stubs: Record<string, (real: string) => string> = {
  "/src/probe/config.ts": (real) => `
    export * from ${JSON.stringify(real)};
    import { readProbeConfig as read } from ${JSON.stringify(real)};
    export async function readProbeConfig(path) {
      const config = await read(path);
      return { ...config, listen: { ...config.listen, host: "127.0.0.1", port: 0 } };
    }`,
  "/src/tailscale.ts": (real) => `
    export * from ${JSON.stringify(real)};
    export const localApiWhois = () => async () => process.env.STUB_CALLER;`,
};

registerHooks({
  load(url, context, nextLoad) {
    const path = new URL(url).pathname;
    const stub = Object.entries(stubs).find(([suffix]) => path.endsWith(suffix) && !url.includes("?real"));
    if (stub === undefined) return nextLoad(url, context);
    return { format: "module", source: stub[1](`${url}?real`), shortCircuit: true };
  },
});
