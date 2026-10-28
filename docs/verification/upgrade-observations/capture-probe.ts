/**
 * Runs the checkout's real probe entrypoint, src/probe/main.ts, on loopback for a pylon-vm node with no pylons, and
 * writes the first snapshot it sends on the observe stream, as the frame the control plane parses. stub-tailnet.ts lets
 * it listen without tailscaled. Run from the root of the checkout.
 *
 *   node docs/verification/upgrade-observations/capture-probe.ts <out-file>
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2]!;
const controlPlane = "nCONTROL";
const dir = await mkdtemp(join(tmpdir(), "upgrade-probe-"));
const secretsFile = join(dir, "secrets.env");
await writeFile(secretsFile, "GH_TOKEN=abc\n");
await chmod(secretsFile, 0o600);
const config = join(dir, "probe.json");
await writeFile(config, JSON.stringify({
  node: "rj-firebat", listen: { host: "100.64.0.1" }, auth: { controlPlane, peers: [] }, secretsFile,
  backend: { kind: "pylon-vm", stateRoot: join(dir, "state"), artifacts: join(dir, "artifacts") },
}));
const child = spawn(process.execPath, ["--no-warnings", "--import", "./docs/verification/upgrade-observations/stub-tailnet.ts", "src/probe/main.ts", config], {
  env: { ...process.env, STUB_CALLER: controlPlane }, stdio: ["ignore", "pipe", "inherit"],
});
let stdout = "";
child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
const exited = once(child, "exit");
while (!/listening on 127\.0\.0\.1:\d+/.test(stdout) && child.exitCode === null) await new Promise((done) => setTimeout(done, 50));
const port = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(stdout)?.[1]);
const frame = await new Promise<string>((done, fail) => {
  request({ host: "127.0.0.1", port, path: "/v1/observe" }, (res) => {
    let text = "";
    res.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("\n")) {
        done(text.split("\n")[0]!);
        res.destroy();
      }
    });
  }).on("error", fail).end();
});
child.kill("SIGTERM");
await exited;
await rm(dir, { recursive: true, force: true });
await writeFile(out, frame + "\n");
