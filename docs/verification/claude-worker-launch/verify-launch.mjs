import { openSession } from '/home/user/workspace/repo/src/sessions.ts';
import { execFile } from 'node:child_process';
const guest = {
 async exec(argv, options) {
  argv = argv.map(a => a.replaceAll('/home/user/workspace/repo', '/tmp/nexus-launch-repo').replaceAll('/home/user', '/tmp/nexus-launch-home'));
  if (argv[0] === 'herdr') argv[2] = 'launch-verification';
  const result = await new Promise((resolve, reject) => execFile(argv[0], argv.slice(1), {cwd:'/tmp/nexus-launch-repo', env:{...process.env, HOME:argv[0] === 'herdr' ? process.env.HOME : '/tmp/nexus-launch-home'}, timeout:options.timeoutMs}, (err, stdout, stderr) => {
   if (argv[0] === 'herdr' && argv[3] === 'agent') console.log('Herdr start reply:', stdout.trim(), stderr.trim());
   if (err && typeof err.code !== 'number') reject(err); else resolve({exitCode:err?.code ?? 0, output:stdout+stderr});
  }));
  if (argv[3] === 'workspace' && argv[4] === 'create') {
    const pane = JSON.parse(result.output).result.root_pane.pane_id;
    await this.exec(['herdr','--session','nexus','pane','run',pane,'export HOME=/tmp/nexus-launch-home'], {timeoutMs:10000});
    await new Promise(r => setTimeout(r,500));
  }
  return result;
 },
};
console.log('started at',new Date().toISOString());
const pane = await openSession(guest, {harness:'claude-code',title:'fixed-launch',cwd:'/tmp/nexus-launch-repo',prompt:'Perform exactly 15 sequential Bash tool calls. In each run sleep 4; echo step-N with the appropriate N. Do not combine calls, do not background them. After all 15 say done.'});
console.log('openSession succeeded',pane,new Date().toISOString());
console.log(await guest.exec(['herdr','--session','nexus','pane','read',pane,'--source','recent-unwrapped','--lines','35'],{timeoutMs:10000}));
