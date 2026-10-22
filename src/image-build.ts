/**
 * The base pylon image build. The control plane reads images/pylon/ with loadImageRecipe and sends the recipe
 * inline in a build-image job. buildImage runs that job on the image build node: Docker builds the root
 * filesystem, Gondolin turns it into guest assets, and a smoke boot gates publishing.
 *
 * An image artifact directory is a Gondolin asset directory (Gondolin's own manifest.json, kernel, initramfs,
 * rootfs.ext4), so the pylon VM backend boots it as is, plus image.json, the ImageManifest.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHttpHooks, parseBuildConfig, verifyAssets, VM, type AlpineConfig, type BuildConfig } from "@earendil-works/gondolin";
import { z } from "zod";
import { JobFailure } from "./backend.ts";
import { imageIdOf, type ImageId, type ImageManifest, type ImageRecipe } from "./images.ts";
import type { NodeName } from "./protocol.ts";

export const pylonRecipeDir = fileURLToPath(new URL("../images/pylon/", import.meta.url));
const gondolinBuild = fileURLToPath(new URL("./gondolin-build.ts", import.meta.url));
export const imageManifestFile = "image.json";

/** build.sh only runs a build. pins.json becomes ImageRecipe.pins. */
const notRecipeFiles = new Set(["build.sh", "pins.json"]);

const pinsSchema = z.strictObject({
  debianDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  node: z.string().regex(/^\d+\.\d+\.\d+$/),
  nodeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  claudeCode: z.string().min(1),
  pi: z.string().min(1),
  herdr: z.string().min(1),
  piEnv: z.string().min(1),
  piEnvSha256: z.string().regex(/^[0-9a-f]{64}$/),
  gondolin: z.string().min(1),
  alpineKernel: z.string().min(1),
  dotfilesCommon: z.string().min(1),
}) satisfies z.ZodType<ImageRecipe["pins"]>;

/** Every file under `dir` except build.sh, sorted by path, and pins.json parsed. */
export async function loadImageRecipe(dir: string = pylonRecipeDir): Promise<ImageRecipe> {
  const files: { path: string; content: string }[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (!entry.isFile()) throw new Error(`${path} in ${dir} is not a regular file`);
    if (!notRecipeFiles.has(path)) files.push({ path, content: await readFile(join(dir, path), "utf8") });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, pins: pinsSchema.parse(JSON.parse(await readFile(join(dir, "pins.json"), "utf8"))) };
}

/** The recipe arrives in a job, so its paths and pins are checked again before anything touches the disk. */
function parseRecipe(recipe: ImageRecipe): ImageRecipe {
  const pins = pinsSchema.safeParse(recipe.pins);
  if (!pins.success) throw new JobFailure("invalid", `recipe pins: ${z.prettifyError(pins.error)}`);
  for (const { path } of recipe.files) {
    if (path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new JobFailure("invalid", `recipe file path ${JSON.stringify(path)} is not a plain relative path`);
    }
  }
  return { files: recipe.files, pins: pins.data };
}

function recipeFile(recipe: ImageRecipe, path: string): string {
  const file = recipe.files.find((f) => f.path === path);
  if (file === undefined) throw new JobFailure("invalid", `the recipe has no ${path}`);
  return file.content;
}

/** Dockerfile ARG name for each pin the Dockerfile uses. */
function dockerBuildArgs(pins: ImageRecipe["pins"]): Record<string, string> {
  return {
    DEBIAN_DIGEST: pins.debianDigest,
    NODE_VERSION: pins.node,
    NODE_SHA256: pins.nodeSha256,
    CLAUDE_CODE_VERSION: pins.claudeCode,
    PI_VERSION: pins.pi,
    HERDR_VERSION: pins.herdr,
    PI_ENV_VERSION: pins.piEnv,
    PI_ENV_SHA256: pins.piEnvSha256,
    DOTFILES_COMMIT: pins.dotfilesCommon,
  };
}

/**
 * The sparse archive peers fetch: every file of the image directory except image.json, which holds its
 * sha256, as a byte-stable GNU tar. ImageManifest.sha256 is the digest of this stream, so ArtifactStore.export
 * must reuse it byte for byte. The stream errors if tar fails.
 */
export function imageArchive(dir: string, signal?: AbortSignal): Readable {
  const args = ["--create", "--file=-", "--sparse", "--format=gnu", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", `--exclude=./${imageManifestFile}`, "-C", dir, "."];
  const tar = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"], ...(signal === undefined ? {} : { signal }) });
  const archive = new PassThrough();
  let stderr = "";
  tar.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  tar.stdout.pipe(archive, { end: false });
  tar.on("error", (err) => archive.destroy(err));
  tar.on("close", (code) => code === 0 ? archive.end() : archive.destroy(new Error(`tar exited ${code} archiving ${dir}: ${stderr.trim()}`)));
  return archive;
}

/**
 * Runs on the image build node inside a build-image job. The build user needs Docker access and KVM.
 * 1. docker build the Dockerfile, tagged nexus-pylon:<image ID>, with the pins as build args.
 * 2. Seed: the Alpine module tree for pins.alpineKernel, absolute vmlinuz link included. A kernel that
 *    differs from the pin fails the job, because the workaround breaks silently otherwise.
 * 3. Gondolin's build into outDir.partial, then the Docker tag is removed.
 * 3a. Modes: Gondolin 0.13.0 extracts the OCI rootfs with a non-root `tar -xf`, which drops setuid, setgid
 *    and sticky bits and applies the umask, and it restores only owners. The modes of every file and
 *    directory with one of those bits are listed from the Docker image, written into rootfs.ext4 with
 *    debugfs, read back, and Gondolin's manifest is updated for the changed rootfs. Delete this step, like
 *    the seed, once the Gondolin pin moves to a release that keeps modes.
 * 4. Smoke boot at 4 GiB (2 GiB hangs): plain exec PATH and CA, `user` with a setuid sudo that prints no
 *    warning and the hostname pylon, which resolves through /etc/hosts, the pinned versions of
 *    node, claude, pi and herdr as user, sshd and sandboxssh, Herdr's pi integration, curl and Node fetch
 *    to an allowed host through TLS interception, and a Herdr server as user. Any failure is setup-failed
 *    and publishes nothing.
 * 5. Write image.json, then rename outDir.partial to outDir.
 * A crash leaves only outDir.partial, which the next attempt removes. An existing outDir is the finished
 * image, because its ID names its inputs.
 */
export async function buildImage(input: ImageRecipe, node: NodeName, out: string, signal: AbortSignal): Promise<ImageManifest> {
  const outDir = resolve(out);
  const recipe = parseRecipe(input);
  const id = imageIdOf(recipe);
  const done = join(outDir, imageManifestFile);
  if (existsSync(done)) {
    const built = JSON.parse(await readFile(done, "utf8")) as ImageManifest;
    if (built.id !== id) throw new JobFailure("invalid", `${outDir} holds ${built.id}, not ${id}`);
    return built;
  }
  const gondolin = gondolinVersion();
  if (gondolin !== recipe.pins.gondolin) {
    throw new JobFailure("invalid", `this node runs Gondolin ${gondolin}, but the recipe pins ${recipe.pins.gondolin}, which the kernel module seed workaround is tied to`);
  }
  const partial = `${outDir}.partial`;
  const scratch = join(partial, ".scratch");
  await rm(partial, { recursive: true, force: true });
  const context = join(scratch, "context");
  for (const file of recipe.files) {
    await mkdir(dirname(join(context, file.path)), { recursive: true });
    await writeFile(join(context, file.path), file.content);
  }
  // The tag only lives until Gondolin has exported it.
  const tag = `nexus-pylon:${id}`;
  const seed = join(scratch, "kernel-module-seed");
  const { config, alpine } = gondolinConfig(recipe, tag, seed, context);
  const configFile = join(scratch, "gondolin.json");
  await writeFile(configFile, JSON.stringify(config, null, 2));

  const args = Object.entries(dockerBuildArgs(recipe.pins)).flatMap(([name, value]) => ["--build-arg", `${name}=${value}`]);
  await run("docker", ["build", "--platform", "linux/amd64", "--label", `nexus.image=${id}`, "--tag", tag, ...args, context], signal);
  let modes: readonly ModeFix[];
  try {
    const listing = await run("docker", ["run", "--rm", "--network", "none", "--label", `nexus.image=${id}`, "--user", "0:0", "--entrypoint", "find", tag, ...modeListingArgs], signal);
    modes = parseOrFail(() => parseModeListing(listing.stdout));
    // The S1 workaround. Delete this step once Gondolin's kernel-modules copy sets verbatimSymlinks
    // (spikes/UPSTREAM-ISSUE-DRAFT.md).
    await seedKernelModules(config.arch, alpine, recipe.pins.alpineKernel, scratch, seed, signal);
    await run(process.execPath, [gondolinBuild, configFile, partial, join(scratch, "gondolin-work")], signal);
  } finally {
    await run("docker", ["image", "rm", tag], AbortSignal.timeout(60_000))
      .catch((err: Error) => process.stderr.write(`buildImage could not remove ${tag}, so it stays in Docker: ${err.message}\n`));
  }
  await restoreModes(partial, modes, scratch, signal);
  await rm(scratch, { recursive: true });

  // Nothing is published unless a pylon booted from these assets works.
  await smokeBoot(partial, recipe.pins, id, signal);

  const gondolinManifest = JSON.parse(await readFile(join(partial, "manifest.json"), "utf8")) as { buildId?: string };
  if (gondolinManifest.buildId === undefined) throw new JobFailure("backend", `Gondolin wrote no buildId into ${partial}/manifest.json`);
  const manifest: ImageManifest = {
    id,
    gondolinBuildId: gondolinManifest.buildId,
    pins: recipe.pins,
    builtOn: node,
    builtAt: new Date().toISOString(),
    sha256: await sha256Of(partial, signal),
  };
  await writeFile(join(partial, imageManifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(partial, outDir);
  return manifest;
}

type SeedAlpine = AlpineConfig & { kernelPackage: string };

/**
 * The gondolin.json fields a recipe may set. The others name host paths (init scripts, sandbox helpers) that
 * Gondolin would read from the build node into the image, or belong to buildImage (postBuild, and init, which
 * buildImage points at the recipe's rootfs-init-extra.sh).
 */
const recipeConfigKeys = new Set(["arch", "distro", "alpine", "oci", "rootfs", "env", "runtimeDefaults"]);

/** The recipe's snippet that Gondolin's /init runs as root before sandboxd. */
const rootfsInitExtra = "rootfs-init-extra.sh";

/**
 * gondolin.json plus what buildImage adds, checked by Gondolin's own parser: oci.image, the seed copy, and
 * init.rootfsInitExtra as the recipe's copy of rootfs-init-extra.sh in `context`.
 */
function gondolinConfig(recipe: ImageRecipe, image: string, seed: string, context: string): { config: BuildConfig; alpine: SeedAlpine } {
  recipeFile(recipe, rootfsInitExtra);
  try {
    const config = JSON.parse(recipeFile(recipe, "gondolin.json")) as Partial<BuildConfig>;
    const refused = Object.keys(config).filter((key) => !recipeConfigKeys.has(key));
    if (refused.length > 0) throw new Error(`it may not set ${refused.join(", ")}`);
    const alpine = config.alpine;
    if (alpine?.kernelPackage === undefined) throw new Error("it needs alpine.kernelPackage, which the module seed installs");
    const full = parseBuildConfig(JSON.stringify({
      ...config,
      oci: { ...config.oci, image },
      postBuild: { copy: [{ src: seed, dest: "/lib/modules" }] },
      init: { rootfsInitExtra: join(context, rootfsInitExtra) },
    }));
    return { config: full, alpine: { ...alpine, kernelPackage: alpine.kernelPackage } };
  } catch (err) {
    if (err instanceof JobFailure) throw err;
    throw new JobFailure("invalid", `the recipe's gondolin.json: ${(err as Error).message}`);
  }
}

/**
 * Leaves the Alpine module tree for `kernel`, absolute vmlinuz link included, at `seed`/<kernel>. It comes
 * from a plain Alpine build of the same kernel package with Gondolin's own cache and package index, so it is
 * the tree the OCI build is about to install. A Debian rootfs that already holds that version skips the copy
 * that crashes. A different kernel version would skip nothing, so it fails here instead.
 */
async function seedKernelModules(arch: BuildConfig["arch"], alpine: SeedAlpine, kernel: string, scratch: string, seed: string, signal: AbortSignal): Promise<void> {
  const work = join(scratch, "seed-work");
  const configFile = join(scratch, "seed-gondolin.json");
  const config: BuildConfig = { arch, distro: "alpine", alpine: { ...alpine, rootfsPackages: [alpine.kernelPackage], initramfsPackages: [] } };
  await writeFile(configFile, JSON.stringify(config, null, 2));
  await run(process.execPath, [gondolinBuild, configFile, join(scratch, "seed-assets"), work], signal);
  const modules = join(work, "rootfs", "lib", "modules");
  const versions = await readdir(modules);
  if (versions.length !== 1 || versions[0] !== kernel) {
    throw new JobFailure("invalid", `Gondolin's Alpine ${alpine.version} now installs kernel ${versions.join(", ")}, but pins.json pins ${kernel}. The module seed must match the kernel exactly: update alpineKernel`);
  }
  await mkdir(seed, { recursive: true });
  await rename(join(modules, kernel), join(seed, kernel));
  await rm(work, { recursive: true });
  await rm(join(scratch, "seed-assets"), { recursive: true });
  await rm(configFile);
}

const gondolinPackageJson = createRequire(import.meta.url).resolve("@earendil-works/gondolin/package.json");

function gondolinVersion(): string {
  return (JSON.parse(readFileSync(gondolinPackageJson, "utf8")) as { version: string }).version;
}

/** A file or directory whose full permission bits the rootfs must get back. */
export interface ModeFix {
  path: string;
  type: "f" | "d";
  mode: number; // permission bits, at most 0o7777
}

/**
 * find arguments that list, inside the Docker image and as root, since the image ends as user, every file and directory with a bit the non-root
 * extraction loses: setuid, setgid, sticky, and group or other write, which gondolin-build.ts's 022 umask
 * strips. Each line is `<f|d> <octal mode> <path>`.
 */
export const modeListingArgs = ["/", "-xdev", "(", "-type", "f", "-o", "-type", "d", ")", "-perm", "/7022", "-printf", "%y %m %p\\n"];

/**
 * Sorted by path. Debian with sudo always has setuid files, so a listing without one means the listing
 * broke, and it throws rather than publish an image whose sudo cannot work.
 */
export function parseModeListing(listing: string): readonly ModeFix[] {
  const fixes = listing.split("\n").filter((line) => line !== "").map((line): ModeFix => {
    const match = /^([fd]) ([0-7]{1,4}) (\/[^\x00-\x1f\x7f]*)$/.exec(line);
    if (match === null) throw new Error(`unexpected mode listing line ${JSON.stringify(line)}`);
    return { type: match[1] as ModeFix["type"], mode: parseInt(match[2]!, 8), path: match[3]! };
  });
  if (!fixes.some((fix) => fix.type === "f" && (fix.mode & 0o6000) !== 0)) {
    throw new Error("the image lists no setuid or setgid file, so the mode listing is broken");
  }
  return fixes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** debugfs's command parser takes `""` inside quotes as a quote and has no other escapes. */
const debugfsPath = (path: string): string => `"${path.replaceAll('"', '""')}"`;

/** `sif <path> mode` takes the whole i_mode, so the file type bits go in too. */
export function debugfsModeCommands(fixes: readonly ModeFix[]): string {
  const typeBits = { f: 0o100000, d: 0o040000 } as const;
  return fixes.map((fix) => `sif ${debugfsPath(fix.path)} mode 0${(typeBits[fix.type] | fix.mode).toString(8)}\n`).join("");
}

export function debugfsStatCommands(fixes: readonly ModeFix[]): string {
  return fixes.map((fix) => `stat ${debugfsPath(fix.path)}\n`).join("");
}

/** debugfs -f echoes each command as `debugfs: <command>`, and stat prints `Mode:  04755` (permission bits). */
export function parseDebugfsModes(output: string): ReadonlyMap<string, number> {
  const modes = new Map<string, number>();
  let path: string | null = null;
  for (const line of output.split("\n")) {
    const command = /^debugfs: stat "((?:[^"]|"")*)"$/.exec(line);
    if (command !== null) {
      path = command[1]!.replaceAll('""', '"');
      continue;
    }
    const mode = /\bMode:\s+([0-7]+)/.exec(line);
    if (path !== null && mode !== null) {
      modes.set(path, parseInt(mode[1]!, 8));
      path = null;
    }
  }
  return modes;
}

/** One line per fix whose read-back mode differs or is missing. */
export function modeMismatches(fixes: readonly ModeFix[], modes: ReadonlyMap<string, number>): readonly string[] {
  return fixes.flatMap((fix) => {
    const got = modes.get(fix.path);
    return got === fix.mode ? [] : [`${fix.path}: want ${fix.mode.toString(8)}, got ${got === undefined ? "nothing" : got.toString(8)}`];
  });
}

/** debugfs exits 0 on most errors and reports them on stderr, after its version banner. */
export function debugfsErrors(stderr: string): readonly string[] {
  return stderr.split("\n").filter((line) => line.trim() !== "" && !/^debugfs \d/.test(line));
}

function parseOrFail<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    throw new JobFailure("backend", (err as Error).message);
  }
}

async function restoreModes(assets: string, fixes: readonly ModeFix[], scratch: string, signal: AbortSignal): Promise<void> {
  const manifestFile = join(assets, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as GondolinManifest;
  const rootfs = join(assets, manifest.assets.rootfs);
  const writes = join(scratch, "debugfs-modes.txt");
  const reads = join(scratch, "debugfs-stat.txt");
  await writeFile(writes, debugfsModeCommands(fixes));
  await writeFile(reads, debugfsStatCommands(fixes));
  const written = await run("debugfs", ["-w", "-f", writes, rootfs], signal);
  const errors = debugfsErrors(written.stderr);
  if (errors.length > 0) throw new JobFailure("backend", `debugfs could not restore modes in ${rootfs}`, errors.join("\n"));
  const mismatches = modeMismatches(fixes, parseDebugfsModes((await run("debugfs", ["-f", reads, rootfs], signal)).stdout));
  if (mismatches.length > 0) throw new JobFailure("backend", `${mismatches.length} modes did not stick in ${rootfs}`, mismatches.join("\n"));

  // The rootfs changed, so Gondolin's checksum and its content-derived build ID are recomputed with its own function.
  const { computeAssetBuildId } = (await import(pathToFileURL(join(dirname(gondolinPackageJson), "dist", "src", "assets.js")).href)) as {
    computeAssetBuildId(input: { checksums: GondolinManifest["checksums"]; arch?: string }): string;
  };
  manifest.checksums.rootfs = await sha256File(rootfs);
  manifest.buildId = computeAssetBuildId({ checksums: manifest.checksums, arch: manifest.config.arch });
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  if (!verifyAssets(assets)) throw new JobFailure("backend", `Gondolin's manifest in ${assets} does not verify after the mode fix`);
}

interface GondolinManifest {
  buildId?: string;
  config: { arch: string };
  assets: { rootfs: string };
  checksums: { kernel: string; initramfs: string; rootfs: string; krunKernel?: string; krunInitrd?: string };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const smokeHost = "api.anthropic.com";
const smokeSession = "nexus-smoke";

interface SmokeCheck {
  name: string;
  argv: readonly string[];
  /** Matched against stdout and stderr together, after a zero exit. */
  expect: RegExp;
}

const asUser = (script: string): readonly string[] => ["runuser", "-l", "user", "-c", `exec 2>&1; ${script}`];
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Plain execs run with sandboxd's environment, and `runuser -l` gives the login shell that SSH and Herdr panes get. */
function smokeChecks(pins: ImageRecipe["pins"]): readonly SmokeCheck[] {
  return [
    { name: "exec environment", argv: ["node", "-p", "`${process.version} ${process.env.NODE_EXTRA_CA_CERTS}`"], expect: new RegExp(`^v${literal(pins.node)} /run/gondolin/ca-certificates\\.crt\\n$`) },
    {
      name: "user",
      argv: asUser("id; stat -c '%a %U' /usr/bin/sudo; sudo -n true && echo sudo ok; stat -c '%U %a' workspace; cat /proc/sys/kernel/hostname; getent hosts pylon; getent ahostsv4 pylon | head -n 1"),
      expect: /^uid=1000\(user\) gid=1000\(user\) [^\n]*\n4755 root\nsudo ok\nuser 755\npylon\n::1\s+pylon\n127\.0\.[01]\.1\s+STREAM pylon\n$/,
    },
    {
      name: "versions",
      argv: asUser("node --version; claude --version; pi --version; herdr --version; nexus --version"),
      expect: new RegExp(`^v${literal(pins.node)}\\n${literal(pins.claudeCode)} \\(Claude Code\\)\\n${literal(pins.pi)}\\nherdr ${literal(pins.herdr)}\\nnexus \\S+\\n$`),
    },
    {
      name: "guest tools",
      argv: asUser("command -v ssh sshd sandboxssh rg fd; grep -c '^Include /etc/ssh/ssh_config.d/\\*.conf' /etc/ssh/ssh_config; herdr integration status | grep -E '^(pi|claude):'"),
      expect: /^\/usr\/bin\/ssh\n\/usr\/sbin\/sshd\n\/usr\/bin\/sandboxssh\n\/usr\/bin\/rg\n\/usr\/local\/bin\/fd\n1\npi: current[^\n]*\nclaude: current/,
    },
    {
      name: "baked dotfiles",
      argv: asUser("stat -c %U /opt/nexus/dotfiles && git clone -q /opt/nexus/dotfiles \"$(mktemp -d)/dotfiles\" && echo cloned && git -C /opt/nexus/dotfiles log -1 --format=%s"),
      expect: new RegExp(`^user\\ncloned\\ndotfiles common layer at ${literal(pins.dotfilesCommon)}\\n$`),
    },
    {
      // The harness starts the daemon this way, through a login shell, and reads its sync line.
      name: "pi-env daemon",
      argv: asUser("/usr/local/libexec/nexus/pi-env --version && bash -lc 'exec /usr/local/libexec/nexus/pi-env \"$@\"' pi-env serve --token 00ff </dev/null"),
      expect: new RegExp(`^pi-env ${literal(pins.piEnv)}\\nPI-ENV 00ff\\n`),
    },
    {
      name: "TLS through Gondolin's interception",
      argv: asUser(`curl -sS -o /dev/null -w '%{http_code}\\n' https://${smokeHost}/v1/models && node -e "fetch('https://${smokeHost}/v1/models').then((r) => console.log(r.status))"`),
      expect: /^401\n401\n$/,
    },
  ];
}

async function smokeBoot(assets: string, pins: ImageRecipe["pins"], id: ImageId, signal: AbortSignal): Promise<void> {
  const fail = (check: string, message: string, log = ""): never => {
    throw new JobFailure("setup-failed", `smoke boot of ${id}: ${check}: ${message}`, log);
  };
  const vm = await VM.create({
    sandbox: { vmm: "qemu", accel: "kvm", imagePath: assets },
    rootfs: { mode: "memory" },
    // A 2 GiB Gondolin 0.13.0 guest hangs at boot on infra-testbench (pylon-vm-backend.ts).
    memory: "4G",
    cpus: 2,
    httpHooks: createHttpHooks({ allowedHosts: [smokeHost] }).httpHooks,
    sessionLabel: `nexus-image-smoke:${id}`,
  }).catch((err: Error) => fail("boot", err.message));
  const stopServer = new AbortController();
  try {
    const exec = async (argv: readonly string[]) => {
      const result = await vm.exec([...argv], { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
      return { exitCode: result.exitCode, output: result.stdout + result.stderr };
    };
    for (const check of smokeChecks(pins)) {
      const { exitCode, output } = await exec(check.argv);
      if (exitCode !== 0) fail(check.name, `exited ${exitCode}`, output);
      if (!check.expect.test(output)) fail(check.name, `output does not match ${check.expect}`, output);
    }

    const server = vm.exec([...asUser(`exec herdr --session ${smokeSession} server`)], { signal: AbortSignal.any([signal, stopServer.signal]) });
    server.catch(() => {});
    let status = { exitCode: -1, output: "" };
    for (let attempt = 0; attempt < 50 && status.exitCode !== 0; attempt++) {
      await delay(200);
      status = await exec(asUser(`herdr --session ${smokeSession} status server`));
    }
    if (status.exitCode !== 0) fail("Herdr server as user", "not running after 10 s", status.output);
    const stop = await exec(asUser(`herdr --session ${smokeSession} server stop`));
    if (stop.exitCode !== 0) fail("Herdr server as user", `stop exited ${stop.exitCode}`, stop.output);
  } finally {
    stopServer.abort();
    await vm.close();
  }
}

const logTailBytes = 16_384;
const killGraceMs = 10_000;

/**
 * Tees the command's output to this process's stderr for the build log, and keeps its tail for the JobFailure. An abort signals the whole process group, because Gondolin's build runs docker, mke2fs
 * and others as its own children, and rejects only once every process in the group is gone.
 */
async function run(command: string, args: readonly string[], signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  signal.throwIfAborted();
  const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const terminate = () => {
    if (child.pid !== undefined) signalGroup(child.pid, "SIGTERM");
  };
  signal.addEventListener("abort", terminate, { once: true });
  let tail = "";
  const output = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream].setEncoding("utf8");
    child[stream].on("data", (chunk: string) => {
      process.stderr.write(chunk);
      tail = (tail + chunk).slice(-logTailBytes);
      output[stream] += chunk;
    });
  }
  let code: number | null;
  let killedBy: NodeJS.Signals | null;
  try {
    [code, killedBy] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  } finally {
    signal.removeEventListener("abort", terminate);
  }
  if (signal.aborted) {
    await reapGroup(child.pid!, command);
    throw signal.reason;
  }
  if (code !== 0) throw new JobFailure("backend", `${command} ${args[0]} ${killedBy === null ? `exited ${code}` : `was killed by ${killedBy}`}`, tail);
  return output;
}

/** False once no process is left in the group. */
function signalGroup(pid: number, name: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, name);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

/** Waits out the SIGTERM grace, then SIGKILLs what is left of the group and waits for that too. */
async function reapGroup(pid: number, command: string): Promise<void> {
  const gone = async () => {
    for (const end = Date.now() + killGraceMs; Date.now() < end; await delay(100)) {
      if (!signalGroup(pid, 0)) return true;
    }
    return false;
  };
  if (await gone()) return;
  signalGroup(pid, "SIGKILL");
  if (!(await gone())) throw new JobFailure("backend", `processes that ${command} started outlived SIGKILL`);
}

async function sha256Of(dir: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of imageArchive(dir, signal)) hash.update(chunk as Buffer);
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    throw new JobFailure("backend", (err as Error).message);
  }
  return hash.digest("hex");
}

if (import.meta.main) {
  const [node, artifacts] = process.argv.slice(2);
  if (node === undefined || artifacts === undefined) {
    console.error("usage: node src/image-build.ts <node name> <artifacts directory>");
    process.exit(64);
  }
  const recipe = await loadImageRecipe();
  const manifest = await buildImage(recipe, node as NodeName, join(artifacts, imageIdOf(recipe)), AbortSignal.timeout(30 * 60_000));
  console.log(JSON.stringify(manifest, null, 2));
}
