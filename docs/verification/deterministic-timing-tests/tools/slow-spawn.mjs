// Preloaded with NODE_OPTIONS="--import <this file>": every child_process.spawn starts its program SPAWN_MS later,
// 3000 by default, as a process start can take on a machine busy with a parallel suite. The event loop stays free.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const seconds = Number(process.env.SPAWN_MS ?? 3000) / 1000;
const spawn = childProcess.spawn;
childProcess.spawn = function (file, args, options) {
  if (!Array.isArray(args)) return spawn.call(this, file, args, options);
  return spawn.call(this, "sh", ["-c", `sleep ${seconds}; exec "$0" "$@"`, file, ...args], options);
};
syncBuiltinESMExports();
