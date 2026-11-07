import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as contract from "./guest-contract.ts";

const image = (file: string) => readFileSync(new URL(`../images/pylon/${file}`, import.meta.url), "utf8");

test("each guest path, name and limit equals the literal it replaced", () => {
  const { asUser, onClaudeTranscript, herdrPanePattern, startHerdrServer, focusScript, attachScript, ...values } = contract;
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
    nexusTurn: "/usr/local/bin/nexus-turn.ts",
    callTimeoutMs: 10_000,
    herdrSession: "nexus",
    herdrServerStartMs: 5_000,
  });
  assert.equal(herdrPanePattern.source, "^w[0-9]{1,9}:p[0-9]{1,9}$");
  assert.equal(herdrPanePattern.flags, "");
  assert.deepEqual(asUser("id"), ["runuser", "-l", "user", "-c", "id"]);
  assert.equal(onClaudeTranscript("cat \"$f\"", 3), 'for f in "$1"/*/"$0".jsonl; do [ -e "$f" ] || continue; cat "$f"; exit 0; done; exit 3');
  assert.equal(startHerdrServer, "setsid -f tini -s -- herdr --session nexus server </dev/null >/dev/null 2>&1");
  assert.equal(focusScript, `herdr --session nexus agent focus "$1" >/dev/null 2>&1 || { tab=$(herdr --session nexus pane get "$1" 2>/dev/null | sed -n 's/.*"tab_id":"\\([^"]*\\)".*/\\1/p'); [ -n "$tab" ] && herdr --session nexus tab focus "$tab" >/dev/null 2>&1; }`);
  assert.equal(attachScript, `herdr --session nexus workspace list >/dev/null 2>&1 || { ${startHerdrServer}; i=0; until herdr --session nexus workspace list >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 50 ] || break; sleep 0.1; done; }; [ -z "$1" ] || { ${focusScript}; }; exec herdr --session nexus`);
});

test("the image installs each tool where the contract says, since its Dockerfile cannot import it", () => {
  const dockerfile = image("Dockerfile");
  for (const line of [
    `COPY nexus-kvm ${contract.nexusKvm}`,
    `COPY nexus-turn.ts ${contract.nexusTurn}`,
    `COPY --chown=user:user dotfiles/ ${contract.bakedDotfilesDir}/`,
    `COPY --chown=user:user agent-setup/ ${contract.agentSetupInstaller.replace(/install\.ts$/, "")}`,
    `node ${contract.agentSetupInstaller}`,
    `-m 0755 package/bin/pi-env-linux-x64/pi-env ${contract.piEnv}`,
    `printf '@~${contract.pylonGuideFile.slice(contract.home.length)}\\n' > ${contract.home}/.claude/CLAUDE.md`,
    `ln -s ${contract.pylonGuideFile} ${contract.home}/.pi/agent/AGENTS.md`,
  ]) assert.ok(dockerfile.includes(line), `the Dockerfile has ${line}`);
});

test("the Claude hook snapshots turns of the checkout the contract names", () => {
  assert.ok(image("nexus-claude-hook").includes(`snapshotTurn(${JSON.stringify(contract.checkoutDir)}, `));
});
