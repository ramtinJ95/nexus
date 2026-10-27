export const defaultClaudeModel = "claude-opus-5-5";

/** Runs in the guest before Claude starts, preserving credentials and unrelated user state. */
export const seedClaudeState = `
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HOME;
const cwd = fs.realpathSync(process.argv[1]);
if (cwd === path.parse(cwd).root || cwd === fs.realpathSync(home)) {
  throw new Error('refusing to grant Claude trust to root or HOME');
}
function snapshot(file) {
  try { return { text: fs.readFileSync(file, 'utf8'), mode: fs.statSync(file).mode & 0o7777 }; }
  catch (err) { if (err.code !== 'ENOENT') throw err; return { text: null, mode: 0o600 }; }
}
function merge(file, update) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = snapshot(file);
    const state = before.text === null ? {} : JSON.parse(before.text);
    const original = JSON.stringify(state);
    update(state);
    if (JSON.stringify(state) === original) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\\n', { mode: before.mode });
      fs.chmodSync(tmp, before.mode);
      const current = snapshot(file);
      if (current.text !== before.text || current.mode !== before.mode) continue;
      fs.renameSync(tmp, file);
      return;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  throw new Error('Claude state kept changing while seeding ' + file);
}
merge(path.join(home, '.claude.json'), state => {
  state.hasCompletedOnboarding = true;
  state.projects ??= {};
  state.projects[cwd] ??= {};
  state.projects[cwd].hasTrustDialogAccepted = true;
});
merge(path.join(home, '.claude/settings.json'), state => {
  state.theme ??= 'dark';
  state.model = '${defaultClaudeModel}';
  state.attribution = { ...state.attribution, commit: '', pr: '' };
  state.skipDangerousModePermissionPrompt = true;
});
`;
