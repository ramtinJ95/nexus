// A local Nexus control plane for the diff panel's captures: the real registry, API and dashboard on 127.0.0.1:7470,
// with one running thread whose checkout is a fixture repository holding every kind of change the diff panel draws:
// long lines, a wide file, renames, binary files, added and deleted files, a mode change, a type change, many files,
// a very long file, CRLF line endings, tabs, unicode and a file with no newline at its end. Stand-ins replace only what
// this pylon cannot host: whois answers the laptop, the model is the test harness, and the probe runs the real
// checkout helper against the fixture. Nothing reaches a pylon or the live control plane.
//
// The same file runs on main and on the branch.
//
//   EVIDENCE=<dir> node docs/verification/diff-panel-rendering/stack.ts
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { openRegistry, type Thread } from "../../../src/control/registry.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import { processStream } from "../../../src/process-stream.ts";
import type { NodeName, PylonObservation, TailnetNodeId } from "../../../src/protocol.ts";

const evidence = process.env.EVIDENCE ?? mkdtempSync(join(tmpdir(), "nexus-diff-evidence-"));
mkdirSync(evidence, { recursive: true });
const log = (line: string) => appendFileSync(join(evidence, "stack.log"), `${new Date().toISOString()} ${line}\n`);
const scratch = mkdtempSync(join(tmpdir(), "nexus-diff-"));

const repo = join(scratch, "repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" }).trim();
const write = (path: string, text: string | Buffer) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const lines = (n: number, line: (i: number) => string, eol = "\n") => Array.from({ length: n }, (_, i) => line(i)).join(eol) + eol;
const png = (seed: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, ...Array.from({ length: 400 }, (_, i) => (i * seed) % 256)]);
const longLine = (i: number) => `export const rule${i} = { id: "rule-${i}", message: "${"a deliberately long line that no screen is wide enough for ".repeat(5)}", severity: ${i % 3} };`;
const unicode = [
  "# Grüße, 你好, こんにちは, 안녕하세요, Привет, مرحبا, שלום",
  "emoji: 🎉 👩‍👩‍👧‍👦 🇸🇪 ✅ ❌ 🔥",
  "combining: é ä ñ, zero-width: a​b, non-breaking: a b",
  "box: ┌──┐ │ok│ └──┘ arrows: → ← ⇒, maths: ∑ ∫ √ ≠ ≤",
  "wide: 全角文字の行はラテン文字の二倍の幅を取る",
];

mkdirSync(repo);
git("init", "-q", "-b", "main");
write("src/rules.ts", lines(40, longLine));
write("data/table.csv", lines(30, (r) => Array.from({ length: 40 }, (_, c) => `r${r}c${c}`).join(",")));
write("lib/old-name.js", lines(30, (i) => `export const step${i} = (x) => x + ${i};`));
write("docs/moved.md", "# Moved\n\nThis file moves and does not change.\n");
write("assets/logo.png", png(7));
write("src/gone.ts", lines(25, (i) => `export const gone${i} = ${i};`));
for (let f = 0; f < 80; f++) write(`pkg/module-${String(f).padStart(2, "0")}/index.ts`, lines(8, (i) => `export const value${i} = ${f * i};`));
write("src/generated.ts", lines(30_000, (i) => `export const g${i} = ${i};`));
write("win/notes.txt", lines(12, (i) => `Line ${i} of a file written on Windows.`, "\r\n"));
write("win/endings.txt", lines(10, (i) => `This line's ending becomes CRLF, ${i}.`));
write("Makefile", "build:\n\tnode build.ts\n\ttsc -p .\n\ntest: build\n\tnode --test\n");
write("go/main.go", "package main\n\nfunc main() {\n\tfor i := 0; i < 3; i++ {\n\t\tprintln(i)\n\t}\n}\n");
write("i18n/greetings.md", unicode.join("\n") + "\n");
write("scripts/run.sh", "#!/bin/sh\necho run\n");
write("config/no-eol.json", '{\n  "a": 1\n}\n');
write("link-target.txt", "a file that becomes a symlink\n");
write("src/very/deeply/nested/directory/structure/that/goes/on/and/on/with-a-long-file-name-too.component.tsx", lines(6, (i) => `export const part${i} = ${i};`));
git("add", "-A");
git("commit", "-q", "-m", "base");
git("update-ref", "refs/nexus/base", "HEAD");

write("src/rules.ts", lines(40, (i) => i % 4 === 0 ? longLine(i).replace("severity", "level") : longLine(i)));
write("data/table.csv", lines(30, (r) => Array.from({ length: 40 }, (_, c) => r % 6 === 0 && c === 37 ? `R${r}C${c}` : `r${r}c${c}`).join(",")));
rmSync(join(repo, "lib/old-name.js"));
write("lib/new-name.js", lines(30, (i) => i === 3 ? `export const step${i} = (x) => x * ${i};` : `export const step${i} = (x) => x + ${i};`));
rmSync(join(repo, "docs/moved.md"));
write("docs/renamed.md", "# Moved\n\nThis file moves and does not change.\n");
write("assets/logo.png", png(11));
write("assets/new-icon.png", png(3));
write("src/added.ts", lines(25, (i) => `export const added${i} = "${i}";`));
rmSync(join(repo, "src/gone.ts"));
for (let f = 0; f < 80; f++) write(`pkg/module-${String(f).padStart(2, "0")}/index.ts`, lines(8, (i) => `export const value${i} = ${f * i + (i === 2 ? 1 : 0)};`));
write("src/generated.ts", lines(30_000, (i) => `export const g${i} = ${i + 1};`));
write("win/notes.txt", lines(12, (i) => i === 5 ? "Line 5 changed, still with CRLF." : `Line ${i} of a file written on Windows.`, "\r\n"));
write("win/endings.txt", lines(10, (i) => `This line's ending becomes CRLF, ${i}.`, "\r\n"));
write("Makefile", "build:\n\tnode build.ts\n\ttsc -p . --noEmit\n\ntest: build\n\tnode --test\n\tnode --test --experimental-test-coverage\n");
write("go/main.go", "package main\n\nfunc main() {\n\tfor i := 0; i < 5; i++ {\n\t\tif i%2 == 0 {\n\t\t\tprintln(i)\n\t\t}\n\t}\n}\n");
write("i18n/greetings.md", [...unicode.slice(0, 2), "emoji: 🎉 👩‍👩‍👧‍👦 🇸🇪 ✅ ❌ 🔥 🚀", ...unicode.slice(2), "added: Ελληνικά, हिन्दी, ไทย"].join("\n") + "\n");
chmodSync(join(repo, "scripts/run.sh"), 0o755);
write("config/no-eol.json", '{\n  "a": 2\n}');
rmSync(join(repo, "link-target.txt"));
symlinkSync("src/added.ts", join(repo, "link-target.txt"));
write("src/very/deeply/nested/directory/structure/that/goes/on/and/on/with-a-long-file-name-too.component.tsx", lines(6, (i) => `export const part${i} = ${i * 2};`));

const node = "verify-node" as NodeName;
const laptop = "nVERIFYLAPTOP" as TailnetNodeId;
const registry = openRegistry(join(scratch, "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
const fake = fakeHarness();
const startThread = threadStarter({ registry, harness: fake.harness, wake: () => {}, dotfiles: { repo: "git@example.com:dotfiles.git", ref: "main" }, mirror: { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote")) } });
const api = await startApi({
  registry, host: "127.0.0.1", port: 7470,
  deployment: { self: "nNODE" as TailnetNodeId, deployers: new Set([laptop]), keys: {} },
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  dotfiles: { repo: "git@example.com:dotfiles.git", ref: "main" },
  harness: fake.harness, startThread, wake: () => {}, previewPorts: { first: 10200, last: 10299 },
  probes: new Map([[node, {
    command: async () => { throw new Error("the verify stack runs no guest commands"); },
    // The checkout helper reads its script from stdin and the checkout from its first argument, which is the fixture.
    stream: async (_pylonId: unknown, argv: string[]) => {
      if (argv[0] !== "python3" || argv[1] !== "-") throw new Error("the verify stack reads only the checkout");
      return processStream(argv[0], [argv[1], repo, ...argv.slice(3)], (text) => process.stderr.write(text));
    },
  }]]),
} as unknown as Parameters<typeof startApi>[0]);
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
  id: "nexus", repoUrl: "https://github.com/example/nexus.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
registry.saveImage(image as never, null);
registry.setCurrentImage(image.id as never);

const thread: Thread = await call("POST", "/v1/threads", { project: "nexus", title: "Every kind of diff" });
fake.transcript(thread.id).messages.push({ role: "user", content: "Change every kind of file.", timestamp: Date.now() });
fake.commit(thread.id);

const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
const observe = () => {
  registry.apply({ record: "node", node, state: "online", capacity });
  const pylon: PylonObservation = {
    pylonId: thread.pylonId, phase: "running", liveHash: registry.pylon(thread.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  };
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [pylon], previewRoutes: [] } as never, []);
};
observe();
setInterval(observe, 1000);

log(`fixture at ${repo}`);
console.log(JSON.stringify({ thread: thread.id }));
