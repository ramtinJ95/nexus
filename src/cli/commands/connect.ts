import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Whoami } from "../../contract/threads.ts";
import { saveJson } from "../../node-base/json-file.ts";
import { version } from "../../version.ts";
import { call, CliError, UsageError } from "../transport.ts";
import { type Command, type Io, noteTo, str } from "../kit.ts";
import { controlPorts, configFile, readConfig, socksOf, controlUrl, skewNote, versionsOf, versionsText, type Versions } from "../config.ts";

function candidatesOf(host: string): URL[] {
  if (host.includes("://")) return [controlUrl(host)];
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new UsageError(`${host} is neither a tailnet name, such as rj-firebat or rj-firebat.example.ts.net, nor a URL`);
  return controlPorts.map((url) => controlUrl(url.replace("{host}", host)));
}

/** `versions` is null when the control plane refuses this device its health. */
function connectText(url: string, file: string, caller: Whoami, versions: Versions | null, env: Io["env"]): string {
  const head = `Connected to ${url}, saved in ${file}.`;
  const overridden = env.NEXUS_URL ? [`NEXUS_URL is set, so it overrides ${file} until you unset it.`] : [];
  const may = (yes: boolean, what: string) => `  ${yes ? "may" : "may not"} ${what}`;
  const admit = (why: string) => `To let it ${why}, run this on the control plane's machine, in its nexus checkout after git pull. It changes the config and keeps the release that runs: sudo deploy/install.sh --admit ${caller.node}`;
  return [
    head,
    versions === null ? "The control plane does not tell this device its version until it admits it." : versionsText(versions),
    `This device is tailnet node ${caller.node}. It`,
    may(caller.allowed, "read threads, projects and nodes"),
    may(caller.person, "start and message threads"),
    may(caller.deployer, "deploy, land reviews and build images"),
    ...!caller.allowed ? [admit("use Nexus and deploy")]
      : !caller.person ? ["It is the control plane's own node or one of its nodes, which never act as a person. Connect from your own device."]
      : !caller.deployer ? [admit("deploy")] : [],
    ...overridden,
  ].join("\n");
}

export const connectCommands: Readonly<Record<string, Command>> = {
  connect: {
    help: ["  nexus connect <host>                         find the control plane on a tailnet name or URL, save it, and say what this device may do"],
    args: [1, 1],
    async run(_, [host], v, _follow, { io }) {
      const file = configFile(io.env);
      const config = await readConfig(file);
      const socks = socksOf(v, config, io.env);
      const tried: string[] = [];
      for (const url of candidatesOf(host!)) {
        const endpoint = { url, socks };
        let health: unknown;
        try {
          health = await call(endpoint, "GET", "/v1/health");
        } catch (err) {
          if (!(err instanceof CliError)) throw err;
          // A control plane refuses health to a caller it does not allow, which whoami then names. The first command it
          // admits reads its version.
          if (err.status !== 403) {
            tried.push(`${url.origin}: ${(err as Error).message}`);
            continue;
          }
        }
        const versions = health === undefined ? null : versionsOf(health);
        let caller: Whoami;
        try {
          caller = await call(endpoint, "GET", "/v1/whoami") as Whoami;
        } catch (err) {
          if (!(err instanceof CliError) || err.status !== 403) throw err;
          throw new CliError("refused", `the control plane at ${url.origin} answers, but ${err.message}. Connect with the name the control plane lists in listen.hostnames, such as its full MagicDNS name`, 403);
        }
        const saved = { ...config, url: url.origin, ...str(v, "socks") === undefined ? {} : { socks: str(v, "socks") } };
        await mkdir(dirname(file), { recursive: true });
        await saveJson(file, saved);
        const skew = versions === null ? undefined : skewNote(url, versions);
        if (skew !== undefined) noteTo(io.stderr)(skew);
        return { json: { url: url.origin, socks: saved.socks ?? null, config: file, caller, versions: versions ?? { cli: version, control: null } }, text: connectText(url.origin, file, caller, versions, io.env) };
      }
      throw new CliError("unreachable", [`no Nexus control plane answers at ${host}${socks === null ? "" : ` through the SOCKS proxy at ${socks.host}:${socks.port}`}:`,
        ...tried.map((line) => `  ${line}`),
        socks === null ? "If this device reaches the tailnet only through a SOCKS5 proxy, such as a userspace tailscaled, give it with --socks HOST:PORT" : ""].join("\n").trimEnd());
    },
  },
};
