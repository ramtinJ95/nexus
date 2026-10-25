/** Runs in the guest before Claude starts, preserving credentials and unrelated user state. */
export const seedClaudeState = `
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HOME;
const cwd = fs.realpathSync(process.argv[1]);
function merge(file, update) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  update(state);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
merge(path.join(home, '.claude.json'), state => {
  state.hasCompletedOnboarding = true;
  state.projects ??= {};
  state.projects[cwd] ??= {};
  state.projects[cwd].hasTrustDialogAccepted = true;
});
merge(path.join(home, '.claude/settings.json'), state => {
  state.theme ??= 'dark';
  state.skipDangerousModePermissionPrompt = true;
});
`;
