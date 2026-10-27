import { execFile, type ExecFileOptions } from "node:child_process";

export interface Exit {
  /** Null when `options.timeout` killed the program. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a program to its exit. A nonzero exit is a result. Rejects when it did not run to an exit, as on an abort. */
export function exit(file: string, args: readonly string[], options: ExecFileOptions = {}): Promise<Exit> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err === null) return resolve({ code: 0, stdout, stderr });
      if (err.killed) return resolve({ code: null, stdout, stderr });
      if (typeof err.code === "number") return resolve({ code: err.code, stdout, stderr });
      reject(err);
    });
  });
}

/** Runs a program and resolves to its stdout. Rejects naming the command and its stderr, or Node's reason without one. */
export function output(file: string, args: readonly string[], options: ExecFileOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err === null) return resolve(stdout);
      reject(new Error(`${file} ${args.join(" ")}: ${stderr.trim() || err.message}`));
    });
  });
}
