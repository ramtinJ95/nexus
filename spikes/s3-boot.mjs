import { VM } from '@earendil-works/gondolin';
const t = performance.now();
let vm;
try {
  vm = await VM.create({ sessionLabel: 'nexus-s3-smoke', startTimeoutMs: 60000 });
  const result = await vm.exec('uname -a; cat /etc/os-release; command -v python3 bash curl');
  console.log(`FIRST_EXEC_MS=${Math.round(performance.now() - t)}`);
  console.log(result.stdout, result.stderr, 'exitCode', result.exitCode);
} finally {
  await vm?.close();
}
