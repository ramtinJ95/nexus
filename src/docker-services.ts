/**
 * The Docker test double's services supervisor, a small stand-in for the pylon VM's (src/pylon-vm/services.ts).
 * It reads the checkout's .nexus/services.yaml with the contract's parser and runs each declared service in
 * the container, as root like every Docker exec, under a restart loop in its own process group. A service
 * gets PORT and, once a preview is assigned, its PUBLIC_URL. A container's ports reach the host only where
 * `docker run` published them, so every service must fix its port in `publishedPorts`, and only those ports can
 * be linked. Ad hoc services are not supported.
 *
 * Which services run, which were stopped on purpose, the env each started with and the linked ports are in the container.
 * The last URLs, start failures and published ports are in the probe's memory, so a probe restart forgets
 * them until the next spawn, which the planner sends after one.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { linkedName, parseServicesFile, type ServiceDecl, type ServiceName } from "./project.ts";
import type { ServiceFact } from "./protocol.ts";
import { checkoutDir } from "./sessions.ts";

const execFileAsync = promisify(execFile);

/** Published on loopback by every `docker run` of the double. */
export const publishedPorts = { first: 8000, last: 8007 } as const;

const servicesFile = `${checkoutDir}/.nexus/services.yaml`;
const root = "/run/nexus-services";
const reference = /\$\{services\.([a-z0-9][a-z0-9-]{0,31})\.publicURL\}/g;
const pollMs = 200;

interface Known {
  declared: Record<ServiceName, ServiceDecl & { port: number }>;
  urls: Record<ServiceName, string>;
  failures: Map<ServiceName, string>;
  /** Container port to the loopback port Docker published it on. */
  hostPorts: Map<number, number>;
  linked: Set<number>;
}

/** Runs a script in the container. A nonzero exit is a result, not an error. */
async function inContainer(container: string, script: string, args: readonly string[] = []): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", ["exec", container, "sh", "-c", script, "sh", ...args], { maxBuffer: 16 << 20 });
    return { code: 0, output: stdout + stderr };
  } catch (err) {
    const { code, stdout = "", stderr = "" } = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof code !== "number") throw err;
    return { code, output: stdout + stderr };
  }
}

async function checked(container: string, script: string, args: readonly string[] = []): Promise<string> {
  const { code, output } = await inContainer(container, script, args);
  if (code !== 0) throw new Error(`in ${container}, ${script.split("\n")[0]} exited ${code}: ${output.trim()}`);
  return output;
}

export function dockerServices() {
  const known = new Map<string, Known>();

  function state(container: string): Known {
    const k = known.get(container);
    if (k === undefined) throw new Error(`${container} is not running, or no spawn has reached it since the probe started`);
    return k;
  }

  async function declarations(container: string): Promise<Known["declared"]> {
    const { code, output } = await inContainer(container, 'test -e "$1" || exit 3; exec cat -- "$1"', [servicesFile]);
    if (code === 3) return {};
    if (code !== 0) throw new Error(`reading ${servicesFile} in ${container} exited ${code}: ${output}`);
    const declared: Known["declared"] = {};
    for (const [name, decl] of Object.entries(parseServicesFile(output).services)) {
      const { port } = decl;
      if (port === undefined || port < publishedPorts.first || port > publishedPorts.last) {
        throw new Error(`the Docker backend runs only services with a fixed port from ${publishedPorts.first} to ${publishedPorts.last}, and ${name} has ${port ?? "none"}`);
      }
      declared[name] = { ...decl, port };
    }
    return declared;
  }

  /** One port per line, so a checkpoint keeps them. */
  const linkedFile = `${root}/linked`;
  async function linked(container: string): Promise<Set<number>> {
    const { output } = await inContainer(container, `cat ${linkedFile} 2>/dev/null || true`);
    return new Set(output.split("\n").filter((line) => line !== "").map(Number));
  }

  const listening = async (container: string, port: number) =>
    (await inContainer(container, `exec bash -c 'exec 3<>"/dev/tcp/127.0.0.1/$0"' "$1"`, [String(port)])).code === 0;

  const running = async (container: string, name: string) =>
    (await inContainer(container, `p=$(cat ${root}/"$1".pid 2>/dev/null) && kill -0 "$p" 2>/dev/null`, [name])).code === 0;

  async function healthy(container: string, k: Known, name: string): Promise<boolean> {
    const decl = k.declared[name]!;
    if (decl.health === "process") return running(container, name);
    if (!await listening(container, decl.port)) return false;
    if (decl.health === undefined) return true;
    try {
      const res = await fetch(`http://127.0.0.1:${k.hostPorts.get(decl.port)}${decl.health}`, { signal: AbortSignal.timeout(2000), redirect: "manual" });
      await res.body?.cancel();
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }

  function environment(k: Known, name: string): { env: Record<string, string>; key: string } {
    const decl = k.declared[name]!;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(decl.env ?? {})) {
      env[key] = value.replace(reference, (_match, dependency: string) => {
        const url = k.urls[dependency];
        if (url === undefined) throw new Error(`Service ${name} needs the public URL of ${dependency}, which has no preview assigned yet`);
        return url;
      });
    }
    env.PORT = String(decl.port);
    const url = k.urls[name];
    if (url !== undefined) env.PUBLIC_URL = url;
    return { env, key: JSON.stringify(env) };
  }

  const stoppedOnPurpose = async (container: string, name: string) =>
    (await inContainer(container, `test -e ${root}/"$1".stopped`, [name])).code === 0;

  /** A failure is recorded, not thrown, as in the pylon VM's supervisor. */
  async function start(container: string, k: Known, name: string): Promise<void> {
    const decl = k.declared[name]!;
    try {
      await checked(container, `rm -f ${root}/"$1".stopped`, [name]);
      if (!await running(container, name)) {
        const { env, key } = environment(k, name);
        const loop = [
          `mkdir -p ${root} && cd "$1" || exit 1`,
          `echo $$ > ${root}/"$2".pid && printf %s "$3" > ${root}/"$2".key`,
          `exec >> ${root}/"$2".log 2>&1`,
          "trap 'exit 0' TERM INT",
          'while :; do sh -lc "$4"; echo "Service exited $?, restarting in 1s"; sleep 1; done',
        ].join("\n");
        const cwd = decl.cwd === undefined ? checkoutDir : `${checkoutDir}/${decl.cwd}`;
        await execFileAsync("docker", ["exec", "--detach", ...Object.entries(env).flatMap(([n, v]) => ["--env", `${n}=${v}`]), container, "setsid", "sh", "-c", loop, "sh", cwd, name, key, decl.command]);
      }
      const deadline = Date.now() + (decl.timeoutMs ?? 30_000);
      while (!await healthy(container, k, name)) {
        if (Date.now() >= deadline) throw new Error(`Service ${name} started but is not responding. Read logs, then restart or stop it`);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      k.failures.delete(name);
    } catch (err) {
      k.failures.set(name, (err as Error).message);
    }
  }

  async function stop(container: string, k: Known, name: string): Promise<void> {
    await checked(container, [
      `p=$(cat ${root}/"$1".pid 2>/dev/null) || exit 0`,
      'kill -TERM -"$p" 2>/dev/null || true',
      'i=0; while kill -0 -"$p" 2>/dev/null; do i=$((i + 1)); if [ "$i" -ge 20 ]; then kill -KILL -"$p" 2>/dev/null; break; fi; sleep 0.1; done',
      `rm -f ${root}/"$1".pid`,
    ].join("\n"), [name]);
    k.failures.delete(name);
  }

  async function facts(container: string, k: Known, names: readonly string[]): Promise<ServiceFact[]> {
    return Promise.all(names.map(async (name): Promise<ServiceFact> => {
      const decl = k.declared[name]!;
      const up = await running(container, name);
      const state = up && await healthy(container, k, name) ? "ready" : k.failures.has(name) ? "failed" : up ? "starting" : "stopped";
      return { name, state, port: decl.port, declared: true, wantsPreview: wantsPreview(decl) };
    }));
  }

  function selection(k: Known, name: string | undefined): string[] {
    if (name === undefined) return Object.keys(k.declared);
    if (k.declared[name] === undefined) throw new Error(`Unknown service ${name}. Edit ${servicesFile}`);
    return [name];
  }

  return {
    /**
     * After every spawn. A boot clears the pid and stop files its disk carried and starts every declared
     * service. A running container restarts each service whose env the new URLs change, and starts each one
     * that is down without having been stopped, such as one that waited for a URL.
     */
    async apply(container: string, urls: Record<ServiceName, string>, booted: boolean): Promise<void> {
      const hostPorts = new Map<number, number>();
      for (const line of (await execFileAsync("docker", ["port", container])).stdout.split("\n")) {
        const m = /^(\d+)\/tcp -> 127\.0\.0\.1:(\d+)$/.exec(line.trim());
        if (m) hostPorts.set(Number(m[1]), Number(m[2]));
      }
      const previous = known.get(container);
      const k: Known = { declared: await declarations(container), urls, failures: previous?.failures ?? new Map(), hostPorts, linked: await linked(container) };
      known.set(container, k);
      if (booted) {
        await checked(container, `rm -f ${root}/*.pid ${root}/*.stopped`);
        for (const name of Object.keys(k.declared)) await start(container, k, name);
        return;
      }
      for (const name of Object.keys(k.declared)) {
        if (!await running(container, name)) {
          if (!await stoppedOnPurpose(container, name)) await start(container, k, name);
          continue;
        }
        const startedWith = (await inContainer(container, `cat ${root}/"$1".key`, [name])).output;
        let wanted: string | null;
        try {
          wanted = environment(k, name).key;
        } catch {
          wanted = null; // start records why
        }
        if (startedWith === wanted) continue;
        await stop(container, k, name);
        await start(container, k, name);
      }
    },

    async operate(container: string, op: "ensure" | "list" | "restart" | "stop", name?: string): Promise<ServiceFact[]> {
      const k = state(container);
      k.declared = await declarations(container);
      const names = selection(k, name);
      for (const n of op === "list" ? [] : names) {
        if (op !== "ensure") await stop(container, k, n);
        if (op === "stop") await checked(container, `mkdir -p ${root} && touch ${root}/"$1".stopped`, [n]);
        else await start(container, k, n);
      }
      const linkedFacts = name !== undefined ? [] : await Promise.all([...k.linked].map(async (port): Promise<ServiceFact> => ({
        name: linkedName(port), state: await listening(container, port) ? "ready" : "stopped", port, declared: false, wantsPreview: true,
      })));
      return [...await facts(container, k, names), ...linkedFacts];
    },

    /** As the pylon VM's attach: a port a declared service owns is previewed under that service. */
    async link(container: string, port: number): Promise<ServiceName> {
      const k = state(container);
      const owner = Object.entries(k.declared).find(([, decl]) => decl.port === port);
      if (owner !== undefined) {
        if (!wantsPreview(owner[1])) throw new Error(`Port ${port} belongs to service ${owner[0]}, which has no preview. Declare one in ${servicesFile}`);
        return owner[0];
      }
      if (!k.hostPorts.has(port)) throw new Error(`the Docker backend links only the ports docker run published, ${publishedPorts.first} to ${publishedPorts.last}, and ${port} is not one`);
      if (!k.linked.has(port)) {
        await checked(container, `mkdir -p ${root} && echo "$1" >> ${linkedFile}`, [String(port)]);
        k.linked.add(port);
      }
      return linkedName(port);
    },

    /** As the pylon VM's detach: a port that is not linked is left as it is, and a declared service's preview or name is refused, with why. */
    async unlink(container: string, port: number): Promise<string | null> {
      const k = state(container);
      if (!k.linked.has(port)) {
        const owner = Object.entries(k.declared).find(([, decl]) => decl.port === port && wantsPreview(decl));
        if (owner !== undefined) return `Port ${port} is the preview of service ${owner[0]}, not a linked port. Remove the preview from ${servicesFile} to unpublish it`;
        return k.declared[linkedName(port)] === undefined ? null : `Service ${linkedName(port)} is not a linked port, so port ${port} has no linked preview to unpublish. Rename the service`;
      }
      // printf with no ports writes one empty line, which `linked` skips.
      await checked(container, `mkdir -p ${root} && printf '%s\\n' "$@" > ${linkedFile}`, [...k.linked].filter((p) => p !== port).map(String));
      k.linked.delete(port);
      return null;
    },

    async logs(container: string, name: string, lines = 100): Promise<{ services: ServiceFact[]; logs: string }> {
      const k = state(container);
      const names = selection(k, name);
      return { services: await facts(container, k, names), logs: await checked(container, `tail -n "$2" ${root}/"$1".log 2>/dev/null || true`, [name, String(lines)]) };
    },

    origin(container: string, service: string): `http://127.0.0.1:${number}` {
      const k = state(container);
      const decl = k.declared[service];
      const port = decl !== undefined && wantsPreview(decl) ? decl.port : [...k.linked].find((p) => linkedName(p) === service);
      if (port === undefined) throw new Error(`${container} has no preview of ${service}`);
      const hostPort = k.hostPorts.get(port);
      if (hostPort === undefined) throw new Error(`Docker published no loopback port for ${service}'s port ${port} in ${container}`);
      return `http://127.0.0.1:${hostPort}`;
    },

    forget(container: string): void {
      known.delete(container);
    },
  };
}

const wantsPreview = (decl: ServiceDecl) => !!decl.preview || (decl.previews?.length ?? 0) > 0;
