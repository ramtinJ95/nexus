// node verify-settings.ts <out dir> <~/.claude.json>: the verify user's settings.json, with a logger on every hook and the
// branch's hook table from install.ts, and a .claude.json that skips onboarding and trusts /home/verify/repo.
import { readFileSync, writeFileSync } from "node:fs";
import { claudeHooks } from "../../../images/pylon/agent-setup/install.ts";
const [out, claudeJson] = process.argv.slice(2);
const log = (hook: string) => ({ type: "command", command: `node /home/verify/bin/log-hook.cjs /home/verify/hooks.jsonl ${hook}`, timeout: 5 });
const hooks: Record<string, unknown[]> = {};
for (const hook of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStart", "SubagentStop", "Notification", "SessionEnd"]) hooks[hook] = [{ matcher: "", hooks: [log(hook)] }];
for (const [hook, kind, matcher] of claudeHooks) hooks[hook]!.push({ matcher, hooks: [{ type: "command", command: `/home/verify/bin/nexus-claude-hook ${kind}`, timeout: 2 }] });
writeFileSync(`${out}/settings.json`, JSON.stringify({ theme: "dark", skipDangerousModePermissionPrompt: true, hooks }, null, 1));
const src = JSON.parse(readFileSync(claudeJson, "utf8"));
writeFileSync(`${out}/claude.json`, JSON.stringify({ hasCompletedOnboarding: true, firstStartTime: src.firstStartTime, userID: src.userID, migrationVersion: src.migrationVersion, lastReleaseNotesSeen: src.lastReleaseNotesSeen, projects: { "/home/verify/repo": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));
