// A local Nexus control plane for the diff captures: the real registry, API and dashboard on 127.0.0.1:7470, with one
// running thread whose checkout is a fixture repository made here. The probe is a fake whose raw pipe runs the real
// checkout helper on this machine against that repository, so the Changes view and its diffs read real git output and
// nothing reaches a pylon or the live control plane.
//
//   node docs/verification/pierre-diffs/stack.ts
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { openRegistry } from "../../../src/control/registry.ts";
import { processStream } from "../../../src/process-stream.ts";
import type { NodeName, PylonObservation, TailnetNodeId } from "../../../src/protocol.ts";

const scratch = mkdtempSync(join(tmpdir(), "nexus-diffs-"));
const repo = join(scratch, "repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
const write = (path: string, text: string | Buffer) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), text);
};

mkdirSync(repo);
git("init", "-q", "-b", "main");
write("src/server.ts", `import { createServer, type IncomingMessage } from "node:http";

/** The routes the server answers, by method and path. */
const routes = new Map<string, (req: IncomingMessage) => Promise<string>>([
  ["GET /health", async () => "ok"],
  ["GET /version", async () => process.env.VERSION ?? "dev"],
]);

export function serve(port: number) {
  return createServer(async (req, res) => {
    const route = routes.get(\`\${req.method} \${req.url}\`);
    if (route === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.end(await route(req));
  }).listen(port);
}
`);
write("app.py", `import json
import sys


def load(path):
    with open(path) as f:
        return json.load(f)


def main():
    config = load(sys.argv[1])
    print(config["name"])


if __name__ == "__main__":
    main()
`);
write("old.go", "package old\n\n// Answer is kept for the old clients.\nfunc Answer() int {\n\treturn 42\n}\n");
write("docs/guide.md", "# Guide\n\nRun `npm ci`, then `npm test`.\n");
write("lib/util.js", "export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\nexport const mean = (xs) => sum(xs) / xs.length;\n");
write("run.sh", "#!/bin/sh\nnode src/server.ts\n");
write("config.txt", "port=8080\nhost=127.0.0.1\n");
git("add", "-A");
git("commit", "-q", "-m", "base");
git("update-ref", "refs/nexus/base", "HEAD");

write("src/server.ts", `import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** The routes the server answers, by method and path. */
const routes = new Map<string, (req: IncomingMessage) => Promise<string>>([
  ["GET /health", async () => "ok"],
  ["GET /version", async () => process.env.VERSION ?? "dev"],
  ["GET /time", async () => new Date().toISOString()],
]);

function notFound(res: ServerResponse) {
  res.writeHead(404, { "content-type": "text/plain" }).end("not found\\n");
}

export function serve(port: number, host = "127.0.0.1") {
  return createServer(async (req, res) => {
    const route = routes.get(\`\${req.method} \${req.url}\`);
    if (route === undefined) return notFound(res);
    res.end(await route(req));
  }).listen(port, host);
}
`);
rmSync(join(repo, "old.go"));
renameSync(join(repo, "docs/guide.md"), join(repo, "docs/handbook.md"));
write("logo.png", Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex"));
git("add", "-A");
git("commit", "-q", "-m", "serve the time");
// A latest-turn snapshot as the harness takes it: the working tree before the reply, as a commit on HEAD. The fake
// harness has no turns, so the API asks for the snapshot of turn "missing".
write("app.py", `import json
import sys
from pathlib import Path


def load(path: Path) -> dict:
    return json.loads(path.read_text())


def main():
    config = load(Path(sys.argv[1]))
    print(f"{config['name']} v{config.get('version', '0')}")


if __name__ == "__main__":
    main()
`);
git("add", "-A");
git("update-ref", "refs/nexus/turn", git("commit-tree", git("write-tree"), "-p", "HEAD", "-m", "Nexus turn missing"));
git("reset", "-q");

write("app.py", `import json
import sys
from pathlib import Path


def load(path: Path) -> dict:
    """Reads a JSON config, failing on a missing name."""
    config = json.loads(path.read_text())
    if "name" not in config:
        raise SystemExit("config has no name")
    return config


def main():
    config = load(Path(sys.argv[1]))
    print(f"{config['name']} v{config.get('version', '0')}")


if __name__ == "__main__":
    main()
`);
write("style.css", ".card {\n  display: grid;\n  gap: 8px;\n  color: light-dark(#222, #eee);\n}\n");
chmodSync(join(repo, "run.sh"), 0o755);
rmSync(join(repo, "config.txt"));
symlinkSync("config/defaults.txt", join(repo, "config.txt"));
git("mv", "lib/util.js", "lib/helpers.js");
write("lib/helpers.js", "export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\nexport const mean = (xs) => (xs.length === 0 ? 0 : sum(xs) / xs.length);\n");
write("data/rows.csv", Array.from({ length: 25_000 }, (_, i) => `${i},row ${i},${(i * 7) % 100}`).join("\n") + "\n");

const node = "verify-node" as NodeName;
const laptop = "nVERIFY" as TailnetNodeId;
const registry = openRegistry(join(scratch, "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
const fake = fakeHarness();
const api = await startApi({
  registry, host: "127.0.0.1", port: 7470,
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  dotfiles: { repo: "git@example.com:dotfiles.git", ref: "main" },
  harness: fake.harness, wake: () => {}, previewPorts: { first: 10200, last: 10299 },
  probes: new Map([[node, {
    command: async () => { throw new Error("the verify stack runs no guest commands"); },
    // The helper reads its script from stdin and the checkout from its first argument, which is the fixture here.
    stream: async (_pylonId, argv) => processStream(argv[0]!, [argv[1]!, repo, ...argv.slice(3)], (text) => process.stderr.write(text)),
  }]]),
});
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text === "" ? null : JSON.parse(text);
};

const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};
await call("POST", "/v1/projects", {
  id: "nexus", repoUrl: "git@example.com:nexus.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
await call("POST", "/v1/images", image);
await call("PUT", "/v1/images/current", { image: image.id });
const thread = await call("POST", "/v1/threads", { project: "nexus", title: "Serve the time" });

const observe = () => {
  registry.apply({ record: "node", node, state: "online", capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 } });
  const pylon: PylonObservation = {
    pylonId: thread.pylonId, phase: "running", liveHash: registry.pylon(thread.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  };
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 }, artifacts: [], jobs: [], pylons: [pylon], previewRoutes: [] }, []);
};
observe();
setInterval(observe, 1000);
console.log(JSON.stringify({ thread: thread.id, repo }));
