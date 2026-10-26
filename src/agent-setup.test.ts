import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  agentSetupManifest, formatAgentSetup, installedLayout, parseAgentSetup, type AgentSetup, type InstalledAgentSetup,
} from "../images/pylon/agent-setup/manifest.ts";
import { claudeHooks, installedPackage, installMismatches, pylonProfile } from "../images/pylon/agent-setup/install.ts";
import { httpsRemote, leaveOuts, parseLeaveOut, planAgentSetup, readPiSetup, type Capture, type LeaveOut, type MacSetup, type PluginFiles } from "./agent-setup.ts";
import { pylonRecipeDir } from "./image-build.ts";

const checkedIn = await readFile(join(pylonRecipeDir, agentSetupManifest), "utf8");

const commit = (c: string) => c.repeat(40);
const small = {
  dotfiles: { url: "https://github.com/me/dotfiles", commit: commit("a") },
  claude: {
    marketplaces: [{ name: "mods", url: "https://github.com/me/mods", commit: commit("b") }],
    plugins: [{ id: "notes@mods", version: "0.2.11" }],
  },
  pi: {
    packages: [{ kind: "npm", name: "@me/pi-ask", version: "0.0.16" }, { kind: "local", path: "pi/extensions/pi-viz" }],
    extensions: ["pi/extensions/pi-vim", "pi/extensions/silly.ts"],
    shepherdrProfiles: ["pi/shepherdr/reviewer", "pi/shepherdr/general"],
  },
  skills: [{ path: "skills/grok", for: ["pi"] }, { path: "claude/skills/show-me", for: ["claude", "pi"] }],
};
const json = (value: unknown) => JSON.stringify(value);

test("the checked-in manifest parses, and formatting it gives back the file byte for byte", () => {
  assert.equal(formatAgentSetup(parseAgentSetup(checkedIn)), checkedIn);
});

test("formatting is canonical: arrays sorted, except pi packages, which keep the order pi loads them in", () => {
  const shuffled = {
    ...small,
    claude: { ...small.claude, marketplaces: [{ name: "z", url: "https://github.com/me/z", commit: commit("c") }, ...small.claude.marketplaces] },
    pi: { packages: [...small.pi.packages].reverse(), extensions: [...small.pi.extensions].reverse(), shepherdrProfiles: small.pi.shepherdrProfiles },
    skills: [...small.skills].reverse().map((s) => ({ ...s, for: [...s.for].reverse() })),
  };
  const formatted = parseAgentSetup(formatAgentSetup(parseAgentSetup(json(shuffled))));
  assert.deepEqual(formatted.claude.marketplaces.map((m) => m.name), ["mods", "z"]);
  assert.deepEqual(formatted.pi.extensions, ["pi/extensions/pi-vim", "pi/extensions/silly.ts"]);
  assert.deepEqual(formatted.pi.shepherdrProfiles, ["pi/shepherdr/general", "pi/shepherdr/reviewer"]);
  assert.deepEqual(formatted.pi.packages, [...small.pi.packages].reverse());
  assert.deepEqual(formatted.skills, [{ path: "claude/skills/show-me", for: ["claude", "pi"] }, { path: "skills/grok", for: ["pi"] }]);
  const twice = formatAgentSetup(formatted);
  assert.equal(formatAgentSetup(parseAgentSetup(twice)), twice);
});

test("the parser refuses what the build cannot fetch exactly or install unambiguously, naming the field", () => {
  const refusals: [unknown, RegExp][] = [
    [{ ...small, dotfiles: { ...small.dotfiles, commit: "aaaaaaa" } }, /dotfiles\.commit/],
    [{ ...small, dotfiles: { ...small.dotfiles, url: "http://github.com/me/dotfiles" } }, /dotfiles\.url/],
    [{ ...small, skills: [{ path: "skills/../etc", for: ["pi"] }] }, /skills\[0\]\.path/],
    [{ ...small, skills: [{ path: "/skills/grok", for: ["pi"] }] }, /skills\[0\]\.path/],
    [{ ...small, skills: [{ path: "skills/grok", for: [] }] }, /skills\[0\]\.for/],
    [{ ...small, skills: [{ path: "skills/grok", for: ["pi", "pi"] }] }, /skills\[0\]\.for/],
    [{ ...small, skills: [{ path: "skills/grok", for: ["codex"] }] }, /skills\[0\]\.for\[0\]/],
    [{ ...small, skills: [{ path: "a/grok", for: ["pi"] }, { path: "b/grok", for: ["claude"] }] }, /skills: two entries with skill name grok/],
    [{ ...small, pi: { ...small.pi, extensions: ["a/x.ts", "b/x.ts"] } }, /pi\.extensions: two entries/],
    [{ ...small, pi: { ...small.pi, shepherdrProfiles: ["a/reviewer", "b/reviewer"] } }, /pi\.shepherdrProfiles: two entries with profile name reviewer/],
    [{ ...small, pi: { packages: [], extensions: [] } }, /pi: missing shepherdrProfiles/],
    [{ ...small, pi: { ...small.pi, packages: [{ kind: "local", path: "a/viz" }, { kind: "local", path: "b/viz" }] } }, /pi\.packages: two entries/],
    [{ ...small, pi: { ...small.pi, packages: [{ kind: "git", url: "https://github.com/me/x" }] } }, /pi\.packages\[0\]\.kind/],
    [{ ...small, pi: { ...small.pi, packages: [{ kind: "npm", name: "@me/x", version: "^1.0.0" }] } }, /pi\.packages\[0\]\.version/],
    [{ ...small, claude: { ...small.claude, plugins: [{ id: "notes@elsewhere", version: "1.0.0" }] } }, /claude\.plugins\[0\]\.id: marketplace elsewhere/],
    [{ ...small, extra: true }, /manifest: unknown extra/],
    [{ ...small, claude: { plugins: [] } }, /claude: missing marketplaces/],
  ];
  for (const [value, message] of refusals) assert.throws(() => parseAgentSetup(json(value)), message, json(value));
});

test("the installed layout names each plugin, skill directory, extension, pi settings entry and shepherdr profile a correct install leaves", () => {
  assert.deepEqual(installedLayout(parseAgentSetup(json(small))), {
    plugins: ["notes@mods 0.2.11 enabled"],
    claudeSkills: ["show-me"],
    piSkills: ["grok", "show-me"],
    piExtensions: ["herdr-agent-state.ts", "pi-vim", "silly.ts"],
    piPackages: ["npm:@me/pi-ask@0.0.16", "packages/pi-viz"],
    shepherdrProfiles: ["general", "reviewer"],
  });
});

test("Claude's notifications count as waiting only for a permission or input prompt, not its idle prompt", () => {
  const [, , matcher] = claudeHooks.find(([hook]) => hook === "Notification")!;
  const waits = ["permission_prompt", "idle_prompt", "elicitation_dialog", "auth_success"].filter((type) => new RegExp(matcher).test(type));
  assert.deepEqual(waits, ["permission_prompt", "elicitation_dialog"]);
});

test("a profile installed in a pylon names the openai provider for a model the Mac reaches through openai-codex, and is otherwise unchanged", () => {
  const astra = JSON.stringify({ description: "Read-only review", blocking: true, model: "openai-codex/gpt-6-astra", thinking: "high", prompt: "prompt.md" }, null, "\t");
  assert.deepEqual(JSON.parse(pylonProfile(astra)), { description: "Read-only review", blocking: true, model: "openai/gpt-6-astra", thinking: "high", prompt: "prompt.md" });
  const other = '{"model": "anthropic/claude-opus-5-5", "thinking": "high"}';
  assert.equal(pylonProfile(other), other);
  assert.equal(pylonProfile('{"model":"openai/gpt-6-sol"}'), '{"model":"openai/gpt-6-sol"}');
});

test("an install that differs from its layout is named item by item, and pi packages out of order are caught", () => {
  const expected = installedLayout(parseAgentSetup(json(small)));
  assert.deepEqual(installMismatches(expected, expected), []);
  const actual: InstalledAgentSetup = {
    ...expected,
    plugins: ["notes@mods 0.2.10 enabled"],
    claudeSkills: [],
    piSkills: ["grok", "show-me (no SKILL.md)"],
    piPackages: ["npm:@me/pi-ask@0.0.16 (installed 0.0.17)", "packages/pi-viz"],
    shepherdrProfiles: ["explorer", "reviewer"],
  };
  assert.deepEqual(installMismatches(expected, actual), [
    "missing Claude plugin notes@mods 0.2.11 enabled",
    "unexpected Claude plugin notes@mods 0.2.10 enabled",
    "missing Claude Code skill show-me",
    "missing pi skill show-me",
    "unexpected pi skill show-me (no SKILL.md)",
    "missing pi package npm:@me/pi-ask@0.0.16",
    "unexpected pi package npm:@me/pi-ask@0.0.16 (installed 0.0.17)",
    "missing shepherdr profile general",
    "unexpected shepherdr profile explorer",
  ]);
  assert.deepEqual(installMismatches(expected, { ...expected, piPackages: [...expected.piPackages].reverse() }), [
    "pi packages are out of order: expected npm:@me/pi-ask@0.0.16, packages/pi-viz, got packages/pi-viz, npm:@me/pi-ask@0.0.16",
  ]);
});

// A miniature of this Mac: the same layout of links into one dotfiles repo, and one case of each rule.
const root = "/Users/me/dotfiles";
const agentSkills = "common-config/common-dotfiles/agents/.agents/skills";
const extensions = "common-config/common-dotfiles/pi/.pi/agent/extensions";
const claudeSkills = "mac-config/mac-dotfiles/claude/.claude/skills";
const profiles = "common-config/common-dotfiles/pi/.pi/agent/shepherdr/profiles";
const reviewer = new Map([
  ["profile.json", JSON.stringify({ description: "Read-only review", blocking: true, model: "openai-codex/gpt-6-astra", thinking: "high", prompt: "prompt.md", prepare: "prepare.mjs", accepts: ["base"], pi_args: [] })],
  ["prompt.md", "You are a read-only reviewer."],
  ["prepare.mjs", 'import { spawnSync } from "node:child_process";\nexport default () => spawnSync("git", ["diff"]);\n'],
]);
const blobs = (entries: Record<string, string>): PluginFiles => new Map(Object.entries(entries).map(([path, c]) => [path, c.repeat(40)]));
const notesAtHead = blobs({ ".claude-plugin/plugin.json": "1", "hooks/hooks.json": "2", "register.ts": "3" });
const nexusAtHead = blobs({ ".claude-plugin/plugin.json": "4" });
const pstackAtHead = blobs({ "plugin.json": "5", "skills/how/SKILL.md": "6" });
const skill = (dir: string, name: string) => ({ name, realPath: `${root}/${dir}/${name}` });
const extension = (name: string, loads: boolean) => ({ name, realPath: `${root}/${extensions}/${name}`, loads });
const shown = { shown: true, by: "git ls-remote" } as const;

function thisMac(): MacSetup {
  return {
    dotfiles: {
      root,
      url: "https://github.com/me/dotfiles",
      commit: commit("a") as MacSetup["dotfiles"]["commit"],
      onOrigin: shown,
      tracked: new Set([
        `${agentSkills}/anki-cards/SKILL.md`, `${agentSkills}/grok/SKILL.md`, `${agentSkills}/herdr/SKILL.md`, `${agentSkills}/teach/SKILL.md`,
        `${claudeSkills}/show-me/SKILL.md`, `${extensions}/atuin.ts`, `${extensions}/herdr-agent-state.ts`, `${extensions}/pi-vim/index.ts`,
        `${extensions}/silly-messages.ts`, `${extensions}/pi-visualize-code-changes/package.json`,
        `${extensions}/pi-visualize-code-changes/skills/visualize-code-changes/SKILL.md`,
        ...[...reviewer.keys()].map((file) => `${profiles}/reviewer/${file}`),
      ]),
      changed: new Set([`${claudeSkills}/ramtin-mode/SKILL.md`, "unrelated/settings.json"]),
    },
    claude: {
      plugins: [
        { id: "nexus@claude-mods", version: "0.6.0", enabled: true, files: nexusAtHead },
        { id: "notes-compaction@claude-mods", version: "0.2.11", enabled: true, files: new Map([...notesAtHead, ...blobs({ ".in_use/4242": "9", ".orphaned_at": "8" })]) },
        { id: "old@claude-mods", version: "1.0.0", enabled: false, files: blobs({ "x": "7" }) },
        { id: "pstack@cursor-plugins", version: "0.15.32", enabled: true, files: pstackAtHead },
      ],
      marketplaces: [
        {
          name: "claude-mods", github: "me/claude-mods", head: commit("b") as MacSetup["dotfiles"]["commit"], onOrigin: shown,
          plugins: new Map([["notes-compaction", notesAtHead], ["nexus", nexusAtHead], ["old", null]]),
        },
        { name: "cursor-plugins", github: "cursor/plugins", head: commit("c") as MacSetup["dotfiles"]["commit"], onOrigin: shown, plugins: new Map([["pstack", pstackAtHead]]) },
      ],
      skills: [
        skill(agentSkills, "anki-cards"), skill(agentSkills, "grok"), skill(agentSkills, "herdr"), skill(claudeSkills, "ramtin-mode"),
        skill(claudeSkills, "show-me"), skill(agentSkills, "teach"),
        { name: "visualize-code-changes", realPath: `${root}/${extensions}/pi-visualize-code-changes/skills/visualize-code-changes` },
      ],
      skillsOff: new Set(["grok", "visualize-code-changes"]),
    },
    pi: {
      packages: ["npm:@howaboua/pi-ask", "extensions/pi-visualize-code-changes", "npm:@ramtinj95/pi-nexus"],
      npmVersions: new Map([["@howaboua/pi-ask", "0.0.16"], ["@ramtinj95/pi-nexus", "0.5.0"]]),
      localPackages: new Map([["extensions/pi-visualize-code-changes", `${root}/${extensions}/pi-visualize-code-changes`]]),
      extensions: [
        extension("atuin.ts", true), extension("herdr-agent-state.ts", true), extension("pi-better-openai-lite", false),
        extension("pi-vim", true), extension("pi-visualize-code-changes", false), extension("silly-messages.ts", true),
      ],
      skills: [
        { ...skill(agentSkills, "anki-cards"), loads: true }, { ...skill(agentSkills, "grok"), loads: true },
        { ...skill(agentSkills, "herdr"), loads: true }, { ...skill(agentSkills, "teach"), loads: false },
      ],
      skillSettings: ["-skills/teach/SKILL.md"],
      shepherdrProfiles: [{ name: "reviewer", realPath: `${root}/${profiles}/reviewer`, files: reviewer, links: new Map() }],
    },
    versions: { claudeCode: "2.1.310", pi: "1.4.0" },
  };
}

const ramtinMode = parseLeaveOut("skill:ramtin-mode");
const plan = (mac: MacSetup, extra: readonly LeaveOut[] = [ramtinMode]): Capture => planAgentSetup(mac, [...leaveOuts, ...extra]);
const captured = (capture: Capture) => {
  assert.equal(capture.kind, "captured", capture.kind === "refused" ? capture.problems.join("\n") : "");
  return capture as Extract<Capture, { kind: "captured" }>;
};
const problemsOf = (capture: Capture) => {
  assert.equal(capture.kind, "refused");
  return (capture as Extract<Capture, { kind: "refused" }>).problems;
};

test("the plan ships what the Mac runs and reports each settled leave-out, and a leave-out that matches nothing is a note", () => {
  const { setup, leftOut, notes } = captured(plan(thisMac()));
  const expected: AgentSetup = parseAgentSetup(json({
    dotfiles: { url: "https://github.com/me/dotfiles", commit: commit("a") },
    claude: {
      marketplaces: [
        { name: "claude-mods", url: "https://github.com/me/claude-mods", commit: commit("b") },
        { name: "cursor-plugins", url: "https://github.com/cursor/plugins", commit: commit("c") },
      ],
      plugins: [{ id: "notes-compaction@claude-mods", version: "0.2.11" }, { id: "pstack@cursor-plugins", version: "0.15.32" }],
    },
    pi: {
      packages: [
        { kind: "npm", name: "@howaboua/pi-ask", version: "0.0.16" },
        { kind: "local", path: `${extensions}/pi-visualize-code-changes` },
      ],
      extensions: [`${extensions}/pi-vim`, `${extensions}/silly-messages.ts`],
      shepherdrProfiles: [`${profiles}/reviewer`],
    },
    skills: [
      { path: `${agentSkills}/grok`, for: ["pi"] },
      { path: `${agentSkills}/herdr`, for: ["claude", "pi"] },
      { path: `${agentSkills}/teach`, for: ["claude"] },
      { path: `${claudeSkills}/show-me`, for: ["claude"] },
    ],
  }));
  assert.deepEqual(setup, expected);
  assert.deepEqual(leftOut.map((rule) => `${rule.kind}:${rule.name}`), [
    "claude-plugin:nexus@claude-mods", "pi-package:npm:@ramtinj95/pi-nexus", "skill:anki-cards", "pi-extension:atuin.ts",
    "pi-extension:herdr-agent-state.ts", "skill:ramtin-mode", "pi-extension:pi-better-openai-lite",
  ]);
  assert.deepEqual(notes, [
    "leave-out skill:voxcraft-remote matches nothing on this Mac",
    "leave-out skill:macmini-handoff matches nothing on this Mac",
  ]);
});

test("uncommitted skills and an unpushed dotfiles HEAD are refused together, and --leave-out lets the rest ship", () => {
  const mac = thisMac();
  const unpushed: MacSetup = {
    ...mac,
    dotfiles: { ...mac.dotfiles, onOrigin: { shown: false, why: "origin moved" }, changed: new Set([...mac.dotfiles.changed, `${claudeSkills}/readable-log/SKILL.md`]) },
    claude: { ...mac.claude, skills: [...mac.claude.skills, skill(claudeSkills, "readable-log")] },
  };
  const problems = problemsOf(plan(unpushed, []));
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.match(problems.join("\n"), /skill ramtin-mode: mac-config\/.*\/ramtin-mode is not committed/);
  assert.match(problems.join("\n"), /skill readable-log: mac-config\/.*\/readable-log is not committed/);
  assert.match(problems.join("\n"), /dotfiles: HEAD aaaaaaa is not shown to be on https:\/\/github\.com\/me\/dotfiles \(origin moved\)/);

  const pushed = { ...unpushed, dotfiles: { ...unpushed.dotfiles, onOrigin: shown } };
  const flags = ["skill:ramtin-mode", "skill:readable-log"].map(parseLeaveOut);
  const { leftOut } = captured(plan(pushed, flags));
  assert.deepEqual(leftOut.filter((rule) => rule.why === "left out on the command line").map((rule) => rule.name), ["ramtin-mode", "readable-log"]);
});

test("a committed skill with uncommitted changes, or one outside the dotfiles, is refused", () => {
  const mac = thisMac();
  const changed = { ...mac, dotfiles: { ...mac.dotfiles, changed: new Set([`${agentSkills}/herdr/SKILL.md`]) } };
  assert.deepEqual(problemsOf(plan(changed)), [`skill herdr: ${agentSkills}/herdr has uncommitted changes in ${root}`]);
  const outside = { ...mac, claude: { ...mac.claude, skills: [...mac.claude.skills, { name: "loose", realPath: "/Users/me/loose" }] } };
  assert.deepEqual(problemsOf(plan(outside)), [`skill loose: /Users/me/loose is outside ${root}`]);
});

const withProfile = (mac: MacSetup, name: string, files: Record<string, string>, dir = `${root}/${profiles}/${name}`, links: Record<string, string> = {}): MacSetup => ({
  ...mac,
  dotfiles: { ...mac.dotfiles, tracked: new Set([...mac.dotfiles.tracked, ...[...Object.keys(files), ...Object.keys(links)].map((file) => `${profiles}/${name}/${file}`)]) },
  pi: { ...mac.pi, shepherdrProfiles: [...mac.pi.shepherdrProfiles, { name, realPath: dir, files: new Map(Object.entries(files)), links: new Map(Object.entries(links)) }] },
});

test("a shepherdr profile that names something that cannot ship is refused, every defect named", () => {
  const broken = withProfile(thisMac(), "broken", {
    "profile.json": JSON.stringify({
      description: "d", model: "m", thinking: "high", tools: ["read"], prompt: "../reviewer/prompt.md", prepare: "lib/prepare.mjs",
      pi_args: ["--no-session", "~/notes.md", "/Users/me/x"],
    }),
    "lib/prepare.mjs": [
      'import { x } from "./util.mjs";', 'import "node:fs";', 'import lodash from "lodash";', 'const y = await import("../outside.mjs");',
      'const z = require("./missing.cjs");',
    ].join("\n"),
    "lib/util.mjs": "export const x = 1;",
  });
  const unparsable = withProfile(thisMac(), "unparsable", { "profile.json": "{" });
  const bare = withProfile(thisMac(), "bare", { "prompt.md": "" });
  const list = withProfile(thisMac(), "list", { "profile.json": "[]" });
  const absolute = withProfile(thisMac(), "absolute", { "profile.json": JSON.stringify({ prompt: "/Users/me/prompt.md", prepare: "~/prepare.mjs" }) });
  assert.deepEqual(problemsOf(plan(broken)), [
    "shepherdr profile broken: pi-shepherdr does not know its field tools",
    'shepherdr profile broken: prompt "../reviewer/prompt.md" is not a file in the profile',
    'shepherdr profile broken: pi_args entry "~/notes.md" is a path on this Mac',
    'shepherdr profile broken: pi_args entry "/Users/me/x" is a path on this Mac',
    'shepherdr profile broken: lib/prepare.mjs imports "lodash", which is neither node: nor a file in the profile',
    'shepherdr profile broken: lib/prepare.mjs imports "../outside.mjs", which is neither node: nor a file in the profile',
    'shepherdr profile broken: lib/prepare.mjs imports "./missing.cjs", which is neither node: nor a file in the profile',
  ]);
  assert.match(problemsOf(plan(unparsable)).join("\n"), /^shepherdr profile unparsable: profile\.json is not JSON/);
  assert.deepEqual(problemsOf(plan(bare)), ["shepherdr profile bare: it has no profile.json"]);
  assert.deepEqual(problemsOf(plan(list)), ["shepherdr profile list: profile.json is not an object"]);
  assert.deepEqual(problemsOf(plan(absolute)), [
    'shepherdr profile absolute: prompt "/Users/me/prompt.md" is not a file in the profile',
    'shepherdr profile absolute: prepare "~/prepare.mjs" is not a file in the profile',
  ]);
});

test("a shepherdr profile's prepare file is checked through every local module it imports, cycles included", () => {
  const profile = (name: string, helper: string) => withProfile(thisMac(), name, {
    "profile.json": JSON.stringify({ description: "d", model: "m", thinking: "high", prepare: "prepare.mjs" }),
    "prepare.mjs": 'import { git } from "./lib/git.mjs";\nexport const prepare = (input) => git(input);\n',
    "lib/git.mjs": helper,
    "lib/util.mjs": 'import { git } from "./git.mjs";\nimport { spawnSync } from "node:child_process";\nexport const run = spawnSync;\n',
  });
  const reaching = profile("reaching", 'import { run } from "./util.mjs";\nimport mac from "../../mac-only.mjs";\nimport lodash from "lodash";\nexport const git = run;\n');
  assert.deepEqual(problemsOf(plan(reaching)), [
    'shepherdr profile reaching: lib/git.mjs imports "../../mac-only.mjs", which is neither node: nor a file in the profile',
    'shepherdr profile reaching: lib/git.mjs imports "lodash", which is neither node: nor a file in the profile',
  ]);
  const cyclic = profile("cyclic", 'import { run } from "./util.mjs";\nexport const git = run;\n');
  assert.deepEqual(captured(plan(cyclic)).setup.pi.shepherdrProfiles, [`${profiles}/cyclic`, `${profiles}/reviewer`]);
});

test("a committed link in a shepherdr profile ships only when it leads to a file in the profile, since the build copies the link, not what it reaches on the Mac", () => {
  const linked = withProfile(thisMac(), "linked", {
    "profile.json": JSON.stringify({ description: "d", model: "m", thinking: "high", prompt: "prompt.md" }),
    "prompts/review.md": "Review.",
  }, undefined, {
    "prompt.md": "prompts/review.md",
    "private.md": "/Users/me/private/prompt.md",
    "notes.md": "../../../notes.md",
    "lib": "prompts",
    "self": ".",
    "gone.md": "prompts/gone.md",
  });
  assert.deepEqual(problemsOf(plan(linked)), [
    "shepherdr profile linked: private.md links to /Users/me/private/prompt.md, outside the profile",
    "shepherdr profile linked: notes.md links to ../../../notes.md, outside the profile",
    "shepherdr profile linked: lib links to prompts, which is not a file in the profile",
    "shepherdr profile linked: self links to ., which is not a file in the profile",
    "shepherdr profile linked: gone.md links to prompts/gone.md, which is not a file in the profile",
  ]);
  const inside = withProfile(thisMac(), "inside", {
    "profile.json": JSON.stringify({ description: "d", model: "m", thinking: "high", prompt: "prompt.md" }),
    "prompts/review.md": "Review.",
  }, undefined, { "prompt.md": "prompts/review.md" });
  assert.deepEqual(captured(plan(inside)).setup.pi.shepherdrProfiles, [`${profiles}/inside`, `${profiles}/reviewer`]);
});

test("a shepherdr profile outside the dotfiles is refused, and --leave-out shepherdr-profile lets the rest ship", () => {
  const outside = withProfile(thisMac(), "loose", { "profile.json": "{}" }, "/Users/me/loose");
  assert.deepEqual(problemsOf(plan(outside)), [`shepherdr profile loose: /Users/me/loose is outside ${root}`]);
  const { setup, leftOut } = captured(plan(outside, [ramtinMode, parseLeaveOut("shepherdr-profile:loose")]));
  assert.deepEqual(setup.pi.shepherdrProfiles, [`${profiles}/reviewer`]);
  assert.ok(leftOut.some((rule) => rule.kind === "shepherdr-profile" && rule.name === "loose"));
});

test("a plugin ships only when its installed copy is byte for byte its directory at the marketplace's HEAD", () => {
  const mac = thisMac();
  const withNotes = (files: PluginFiles): MacSetup => ({
    ...mac,
    claude: { ...mac.claude, plugins: mac.claude.plugins.map((p) => (p.id === "notes-compaction@claude-mods" ? { ...p, files } : p)) },
  });
  const update = /claude plugin notes-compaction@claude-mods: the installed copy differs from marketplace claude-mods at bbbbbbb\. Run `claude plugin update notes-compaction@claude-mods`/;
  const edited = new Map([...notesAtHead, ["register.ts", "f".repeat(40)]]);
  const extra = new Map([...notesAtHead, ["scratch.md", "f".repeat(40)]]);
  const missing = new Map([...notesAtHead].filter(([path]) => path !== "register.ts"));
  for (const files of [edited, extra, missing]) {
    const problems = problemsOf(plan(withNotes(files)));
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, update);
  }
  assert.equal(captured(plan(withNotes(new Map([...notesAtHead, ...blobs({ ".in_use/1": "9", ".orphaned_at": "8" })])))).setup.claude.plugins.length, 2);
});

test("a plugin whose marketplace cannot be fetched from GitHub at its HEAD is refused", () => {
  const mac = thisMac();
  const withMods = (mods: MacSetup["claude"]["marketplaces"][number]): MacSetup => ({
    ...mac, claude: { ...mac.claude, marketplaces: [mods, ...mac.claude.marketplaces.slice(1)] },
  });
  assert.match(problemsOf(plan(withMods({ name: "claude-mods", github: null }))).join("\n"), /notes-compaction@claude-mods: its marketplace claude-mods is not a GitHub repo/);
  const mods = mac.claude.marketplaces[0] as Extract<MacSetup["claude"]["marketplaces"][number], { github: string }>;
  assert.match(problemsOf(plan(withMods({ ...mods, onOrigin: { shown: false, why: "no tip" } }))).join("\n"), /marketplace claude-mods: HEAD bbbbbbb is not shown to be on GitHub \(no tip\)\. Run `claude plugin marketplace update claude-mods`/);
  const moved = { ...mac, claude: { ...mac.claude, plugins: [...mac.claude.plugins, { id: "gone@claude-mods", version: "1.0.0", enabled: true, files: new Map() }] } };
  assert.match(problemsOf(plan(moved)).join("\n"), /claude plugin gone@claude-mods: marketplace claude-mods at bbbbbbb does not list it/);
});

test("pi skills: a skill pi does not load goes to Claude Code only, and any skills setting but a -path one is refused", () => {
  const mac = thisMac();
  assert.deepEqual(captured(plan(mac)).setup.skills.find((s) => s.path.endsWith("/teach"))?.for, ["claude"]);
  const glob = { ...mac, pi: { ...mac.pi, skillSettings: ["!skills/**"] } };
  assert.deepEqual(problemsOf(plan(glob)), ['pi skills setting "!skills/**": only -path exclusions are captured']);
});

test("a skill turned off in skillOverrides goes to pi only, and nowhere when pi does not have it", () => {
  const { setup } = captured(plan(thisMac()));
  assert.deepEqual(setup.skills.find((s) => s.path.endsWith("/grok"))?.for, ["pi"]);
  assert.ok(!setup.skills.some((s) => s.path.endsWith("/visualize-code-changes")), "an off skill pi lacks ships nowhere");
});

test("pi packages: only npm with an installed version or a local path in the dotfiles ship, and a local package is not also an extension", () => {
  const mac = thisMac();
  const { setup } = captured(plan(mac));
  assert.equal(setup.pi.packages.filter((p) => p.kind === "local").length, 1);
  assert.ok(!setup.pi.extensions.some((path) => path.endsWith("/pi-visualize-code-changes")));
  const sources = { ...mac, pi: { ...mac.pi, packages: [...mac.pi.packages, "git:github.com/me/pi-x", "npm:@me/never-installed"] } };
  assert.deepEqual(problemsOf(plan(sources)), [
    "pi package git:github.com/me/pi-x: only npm: packages and local paths that exist are captured",
    "pi package npm:@me/never-installed: no version of @me/never-installed is installed under ~/.pi/agent/npm",
  ]);
});

test("a pi package leave-out names the npm package, so a settings entry that pins a version is left out too", () => {
  const mac = thisMac();
  const pinned = { ...mac, pi: { ...mac.pi, packages: mac.pi.packages.map((p) => (p === "npm:@ramtinj95/pi-nexus" ? "npm:@ramtinj95/pi-nexus@0.5.0" : p)) } };
  const { setup, leftOut, notes } = captured(plan(pinned));
  assert.ok(!setup.pi.packages.some((p) => p.kind === "npm" && p.name === "@ramtinj95/pi-nexus"), "pi-nexus is not shipped");
  assert.ok(leftOut.some((rule) => rule.kind === "pi-package" && rule.name === "npm:@ramtinj95/pi-nexus"));
  assert.ok(!notes.some((note) => note.includes("pi-nexus")), notes.join("\n"));
});

test("two shipped skills with one name are refused, since the image installs each under its name", () => {
  const mac = thisMac();
  const twin = { ...mac, pi: { ...mac.pi, skills: [...mac.pi.skills, { ...skill(claudeSkills, "grok"), loads: true }] } };
  const withTwin = { ...twin, dotfiles: { ...twin.dotfiles, tracked: new Set([...mac.dotfiles.tracked, `${claudeSkills}/grok/SKILL.md`]) } };
  assert.match(problemsOf(plan(withTwin)).join("\n"), /skills: two entries with skill name grok/);
  const renamed = { ...mac, claude: { ...mac.claude, skills: [...mac.claude.skills, { name: "teacher", realPath: `${root}/${agentSkills}/teach` }] } };
  assert.match(problemsOf(plan(renamed)).join("\n"), /skill teacher: it is .*\/teach, which the image would install as teach/);
});

test("the plan is deterministic: the same Mac in any listing order formats to the same bytes", () => {
  const mac = thisMac();
  const reversed: MacSetup = {
    ...mac,
    claude: { ...mac.claude, plugins: [...mac.claude.plugins].reverse(), marketplaces: [...mac.claude.marketplaces].reverse(), skills: [...mac.claude.skills].reverse() },
    pi: { ...mac.pi, extensions: [...mac.pi.extensions].reverse(), skills: [...mac.pi.skills].reverse() },
  };
  const bytes = formatAgentSetup(captured(plan(mac)).setup);
  assert.equal(formatAgentSetup(captured(plan(thisMac())).setup), bytes);
  assert.equal(formatAgentSetup(captured(plan(reversed)).setup), bytes);
});

test("--leave-out takes <kind>:<name>, splitting at the first colon", () => {
  assert.deepEqual(parseLeaveOut("pi-package:npm:@me/pi-x"), { kind: "pi-package", name: "npm:@me/pi-x", why: "left out on the command line" });
  for (const bad of ["ramtin-mode", "skills:ramtin-mode", "skill:", ":ramtin-mode"]) assert.throws(() => parseLeaveOut(bad), /--leave-out takes <kind>:<name>/);
});

test("git remotes read as the https URL the image build fetches", () => {
  assert.equal(httpsRemote("git@github.com:ramtinJ95/dotfiles.git"), "https://github.com/ramtinJ95/dotfiles");
  assert.equal(httpsRemote("ssh://git@github.com/ramtinJ95/dotfiles.git"), "https://github.com/ramtinJ95/dotfiles");
  assert.equal(httpsRemote("https://github.com/ramtinJ95/dotfiles.git"), "https://github.com/ramtinJ95/dotfiles");
  assert.throws(() => httpsRemote("/srv/git/dotfiles"));
});

/**
 * A scratch home for the pi reader: a path ending in / is a directory, a { link } value a symlink, anything else a
 * file. Its dotfiles/ directory stands in for the dotfiles repo, with every file in it committed.
 */
async function piCapture(files: Record<string, string | { link: string }>): Promise<Capture> {
  const home = await scratchHome(files);
  const tracked = Object.keys(files).filter((path) => path.startsWith("dotfiles/") && !path.endsWith("/")).map((path) => path.slice("dotfiles/".length));
  const mac = thisMac();
  return planAgentSetup({
    ...mac,
    dotfiles: { ...mac.dotfiles, root: join(home, "dotfiles"), tracked: new Set(tracked), changed: new Set() },
    claude: { plugins: [], marketplaces: [], skills: [], skillsOff: new Set() },
    pi: await readPiSetup(home),
  }, leaveOuts);
}
async function scratchHome(files: Record<string, string | { link: string }>): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "agent-setup-home-")));
  for (const [path, content] of Object.entries(files)) {
    const full = join(home, path);
    await mkdir(path.endsWith("/") ? full : dirname(full), { recursive: true });
    if (typeof content === "object") await symlink(content.link, full);
    else if (!path.endsWith("/")) await writeFile(full, content);
  }
  return home;
}
const piSettings = (settings: object) => JSON.stringify(settings);

test("pi reads each shepherdr profile directory's files and, unfollowed, its links, and none without the directory", async () => {
  const home = await scratchHome({
    ".pi/agent/settings.json": piSettings({}),
    ".pi/agent/shepherdr/profiles/reviewer": { link: "../../../../dotfiles/reviewer" },
    ".pi/agent/shepherdr/profiles/general/profile.json": "{}",
    ".pi/agent/shepherdr/profiles/.general-x1/general/profile.json": "{}",
    ".pi/agent/shepherdr/profiles/notes.md": "",
    "dotfiles/reviewer/profile.json": '{"prompt":"prompt.md"}',
    "dotfiles/reviewer/prompt.md": "Review.",
    "dotfiles/reviewer/lib/util.mjs": "export {};",
    "dotfiles/reviewer/private.md": { link: "/Users/me/private/prompt.md" },
    "dotfiles/reviewer/loop": { link: "." },
  });
  assert.deepEqual((await readPiSetup(home)).shepherdrProfiles, [
    { name: "general", realPath: join(home, ".pi/agent/shepherdr/profiles/general"), files: new Map([["profile.json", "{}"]]), links: new Map() },
    {
      name: "reviewer", realPath: join(home, "dotfiles/reviewer"),
      files: new Map([["lib/util.mjs", "export {};"], ["profile.json", '{"prompt":"prompt.md"}'], ["prompt.md", "Review."]]),
      links: new Map([["loop", "."], ["private.md", "/Users/me/private/prompt.md"]]),
    },
  ]);
  assert.deepEqual((await readPiSetup(await scratchHome({ ".pi/agent/settings.json": piSettings({}) }))).shepherdrProfiles, []);
});

test("a local pi package written with ~ is read from the home, as pi resolves it", async () => {
  const { setup } = captured(await piCapture({
    ".pi/agent/settings.json": piSettings({ packages: ["~/dotfiles/pkgs/viz"] }),
    "dotfiles/pkgs/viz/package.json": JSON.stringify({ pi: { skills: ["./skills"] } }),
    "dotfiles/pkgs/viz/skills/viz/SKILL.md": "viz",
  }));
  assert.deepEqual(setup.pi.packages, [{ kind: "local", path: "pkgs/viz" }]);
});

test("pi extensions: an entry ships when pi loads it, and every other entry is listed as left out with the reason", async () => {
  const { setup, leftOut } = captured(await piCapture({
    ".pi/agent/settings.json": piSettings({ packages: ["extensions/viz"] }),
    ".pi/agent/extensions": { link: "../../dotfiles/ext" },
    "dotfiles/ext/one.ts": "",
    "dotfiles/ext/by-index/index.ts": "",
    "dotfiles/ext/by-manifest/package.json": JSON.stringify({ pi: { extensions: ["./main.ts"] } }),
    "dotfiles/ext/by-manifest/main.ts": "",
    "dotfiles/ext/viz/package.json": JSON.stringify({ pi: { skills: ["./skills"] } }),
    "dotfiles/ext/viz/skills/viz/SKILL.md": "viz",
    "dotfiles/ext/empty/": "",
    "dotfiles/ext/unbuilt/package.json": JSON.stringify({ pi: { extensions: ["./dist/index.js"] } }),
    "dotfiles/ext/notes.md": "",
    "dotfiles/ext/.cache/": "",
  }));
  assert.deepEqual(setup.pi.extensions, ["ext/by-index", "ext/by-manifest", "ext/one.ts"]);
  assert.deepEqual(setup.pi.packages, [{ kind: "local", path: "ext/viz" }]);
  const nothing = leftOut.filter((rule) => rule.kind === "pi-extension");
  assert.deepEqual(nothing.map((rule) => rule.name), ["empty", "notes.md", "unbuilt"]);
  for (const rule of nothing) assert.match(rule.why, /pi loads nothing from it/);
});

test("an extension directory with a package.json pi cannot read loads only through its index", async () => {
  const { setup, leftOut } = captured(await piCapture({
    ".pi/agent/settings.json": piSettings({}),
    ".pi/agent/extensions": { link: "../../dotfiles/ext" },
    "dotfiles/ext/broken/package.json": "{",
    "dotfiles/ext/broken-indexed/package.json": "{",
    "dotfiles/ext/broken-indexed/index.js": "",
  }));
  assert.deepEqual(setup.pi.extensions, ["ext/broken-indexed"]);
  assert.deepEqual(leftOut.filter((rule) => rule.kind === "pi-extension").map((rule) => rule.name), ["broken"]);
});

test("pi skills: a -path entry is matched as pi matches it, from the root pi found the skill in, links unresolved", async () => {
  const { setup } = captured(await piCapture({
    ".pi/agent/settings.json": piSettings({ skills: ["-skills/teach/SKILL.md", "-~/.pi/agent/skills/linked", "-~/.agents/skills/both"] }),
    ".agents/skills/teach": { link: "../../dotfiles/skills/teach" },
    ".agents/skills/herdr": { link: "../../dotfiles/skills/herdr" },
    ".agents/skills/linked": { link: "../../dotfiles/skills/linked" },
    ".agents/skills/both": { link: "../../dotfiles/skills/both" },
    ".pi/agent/skills/linked": { link: "../../../dotfiles/skills/linked" },
    ".pi/agent/skills/both": { link: "../../../dotfiles/skills/both" },
    "dotfiles/skills/teach/SKILL.md": "teach",
    "dotfiles/skills/herdr/SKILL.md": "herdr",
    "dotfiles/skills/linked/SKILL.md": "linked",
    "dotfiles/skills/both/SKILL.md": "both",
  }));
  // pi 1.4.0's own resolver, run on this home, loads herdr and both: teach is excluded relative to ~/.agents, and a
  // skill linked into both roots is decided by its ~/.pi/agent/skills link, which pi finds first.
  assert.deepEqual(setup.skills, [{ path: "skills/both", for: ["pi"] }, { path: "skills/herdr", for: ["pi"] }]);
});

test("the install check names a local pi package whose directory, declared resources or skills' SKILL.md files are missing", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-setup-pi-"));
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(agentDir, path)), { recursive: true });
    await writeFile(join(agentDir, path), content);
  };
  await write("packages/viz/package.json", JSON.stringify({ pi: { skills: ["./skills"] } }));
  await write("packages/viz/skills/viz/SKILL.md", "viz");
  await write("packages/bare/package.json", JSON.stringify({ pi: { skills: ["./skills"] } }));
  await write("packages/bare/skills/viz/README.md", "no SKILL.md");
  await write("packages/unbuilt/package.json", JSON.stringify({ pi: { extensions: ["./dist/index.js"] } }));
  const expected = installedLayout(parseAgentSetup(json({
    ...small,
    pi: { ...small.pi, packages: ["viz", "gone", "bare", "unbuilt"].map((name) => ({ kind: "local", path: `pi/${name}` })) },
  })));
  const actual = { ...expected, piPackages: await Promise.all(expected.piPackages.map((entry) => installedPackage(entry, agentDir))) };
  assert.deepEqual(installMismatches(expected, actual).filter((line) => line.startsWith("missing")), [
    "missing pi package packages/gone",
    "missing pi package packages/bare",
    "missing pi package packages/unbuilt",
  ]);
});
