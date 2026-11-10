/**
 * The Mac nexus CLI's entry. Static imports load before a module's own code runs, so it turns on Node's compile
 * cache and takes stdout's EPIPE before importing the CLI, which is main.ts.
 */
import { enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

// Not Node's default, the temp directory's node-compile-cache, which another user may own on a shared machine.
enableCompileCache(process.env.NODE_COMPILE_CACHE || join(homedir(), ".cache", "nexus", "compile-cache"));
// A reader that closed early, such as `head` or a quit `less`, took all it wanted.
process.stdout.on("error", (err: NodeJS.ErrnoException) => { if (err.code === "EPIPE") process.exit(0); else throw err; });
await import("./main.ts");
