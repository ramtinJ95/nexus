import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import * as contract from "../../images/pylon/nexus-contract.ts";

const image = (file: string) => readFileSync(new URL(`../../images/pylon/${file}`, import.meta.url), "utf8");

test("each guest path, name and limit equals the literal it replaced", () => {
  const { eventIdPattern, claudeTurn, answerExits, answerDelivered, maxAsksBytes, unpasted, typedPrompt, ...values } = contract;
  assert.deepEqual(values, {
    home: "/home/user",
    workspaceDir: "/home/user/workspace",
    checkoutDir: "/home/user/workspace/repo",
    servicesFile: "/home/user/workspace/repo/.nexus/services.yaml",
    pylonInfoFile: "/home/user/.nexus/pylon.json",
    pylonGuideFile: "/home/user/.nexus/PYLON.md",
    sessionsFile: "/home/user/.nexus/sessions.json",
    claudeLaunchesDir: "/home/user/.nexus/claude-launches",
    outputsDir: "/home/user/.nexus/outputs",
    dotfilesDir: "/home/user/.nexus/dotfiles",
    claudeProjects: "/home/user/.claude/projects",
    piSessions: "/home/user/.pi/agent/sessions",
    bakedDotfilesDir: "/opt/nexus/dotfiles",
    agentSetupInstaller: "/opt/nexus/agent-setup/install.ts",
    piEnv: "/usr/local/libexec/nexus/pi-env",
    nexusKvm: "/usr/local/libexec/nexus/nexus-kvm",
    helpersDir: "/usr/local/bin",
    nexusCli: "/usr/local/bin/nexus",
    claudeHook: "/usr/local/bin/nexus-claude-hook",
    nexusOutbox: "/usr/local/bin/nexus-outbox.ts",
    nexusTurn: "/usr/local/bin/nexus-turn.ts",
    checkoutHelper: "/usr/local/lib/nexus/checkout-files.py",
    bridgeHost: "nexus.pylon",
    nexusApi: "http://nexus.pylon",
    bridgeRequestPath: "/v1/request",
    sessionKinds: ["session.turn-started", "session.heartbeat", "session.turn-ended", "session.waiting", "session.ended"],
    maxSessionLength: 200,
    maxEventMessageLength: 2048,
  });
  assert.equal(eventIdPattern.source, "^[0-9a-z-]{1,64}$");
  assert.equal(eventIdPattern.flags, "");
});

test("the Dockerfile copies each image file to where the contract says, and nothing else", () => {
  const copies = Object.fromEntries([...image("Dockerfile").matchAll(/^COPY (?:--chown=\S+ )?(\S+) (\S+)$/gm)].map((m) => [m[1]!, m[2]!]));
  const helper = (name: string) => `${contract.helpersDir}/${name}`;
  assert.deepEqual(copies, {
    "nexus": contract.nexusCli,
    "nexus-claude-hook": contract.claudeHook,
    "nexus-claude-hook.mjs": helper("nexus-claude-hook.mjs"),
    "nexus-ask.ts": helper("nexus-ask.ts"),
    "nexus-contract.ts": helper("nexus-contract.ts"),
    "nexus-heartbeat.ts": helper("nexus-heartbeat.ts"),
    "nexus-outbox.ts": contract.nexusOutbox,
    "nexus-turn.ts": contract.nexusTurn,
    "nexus-kvm": contract.nexusKvm,
    "checkout-files.py": contract.checkoutHelper,
    "dotfiles/": `${contract.bakedDotfilesDir}/`,
    "agent-setup/": `${dirname(contract.agentSetupInstaller)}/`,
  });
});

test("the image installs and links what the contract names, since its Dockerfile cannot import it", () => {
  const dockerfile = image("Dockerfile");
  for (const line of [
    `install -d -o user -g user ${contract.workspaceDir}`,
    `node ${contract.agentSetupInstaller}`,
    `-m 0755 package/bin/pi-env-linux-x64/pi-env ${contract.piEnv}`,
    `printf '@~${contract.pylonGuideFile.slice(contract.home.length)}\\n' > ${contract.home}/.claude/CLAUDE.md`,
    `ln -s ${contract.pylonGuideFile} ${contract.home}/.pi/agent/AGENTS.md`,
  ]) assert.ok(dockerfile.includes(line), `the Dockerfile has ${line}`);
});

test("every boot starts the outbox the contract names", () => {
  assert.ok(image("rootfs-init-extra.sh").includes(`/usr/local/bin/node ${contract.nexusOutbox} `));
});

test("the guest PATH reaches the helpers, and the agent setup runs with the flags every guest command gets", () => {
  const { env } = JSON.parse(image("gondolin.json")) as { env: Record<string, string> };
  const path = env.PATH ?? "";
  assert.ok(path.split(":").includes(contract.helpersDir), path);
  const installer = image("agent-setup/install.ts");
  const flags = /const env = \{ \.\.\.process\.env, ([^}]*) \};/.exec(installer)?.[1] ?? "";
  const pairs = [...flags.matchAll(/(\w+): "([^"]*)"/g)].map((m) => [m[1]!, m[2]!] as const);
  assert.deepEqual(pairs.map(([name]) => name).sort(), ["CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL", "DISABLE_AUTOUPDATER"]);
  for (const [name, value] of pairs) assert.equal(env[name], value, `gondolin.json sets ${name} as install.ts does`);
  assert.ok(installer.includes(`command: \`${contract.claudeHook} \${kind}\``), "install.ts registers the hook the contract names");
});

test("the Claude hook snapshots turns of the checkout the contract names", () => {
  assert.ok(image("nexus-claude-hook.mjs").includes("snapshotTurn(checkoutDir, "));
});
