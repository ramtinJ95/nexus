/**
 * The grammar of a node's secrets.env (/etc/nexus/secrets.env), which the probe reads and the credentials step writes.
 * The installers load this before npm ci, so it imports only Node's builtins and modules that do too.
 */
import type { SecretSource } from "../backends/backend.ts";

/**
 * `NAME=value` lines, blank lines and `#` comments. Values are taken verbatim to the end of the line, so
 * quoting is refused rather than guessed at. A `held` name is refused, as the control plane provides it. Errors
 * name the line, never the value.
 */
export function parseSecretsEnv(text: string, held: readonly string[]): SecretSource {
  const values = new Map<string, string>();
  text.split(/\r?\n/).forEach((line, i) => {
    const at = `line ${i + 1}`;
    if (/^\s*(#|$)/.test(line)) return;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match === null) throw new Error(`${at} is not NAME=value`);
    const [, name, value] = match as unknown as [string, string, string];
    if (values.has(name)) throw new Error(`${at} sets ${name} a second time`);
    if (held.includes(name)) throw new Error(`${at} sets ${name}, which the control plane hands to this probe. Remove the line`);
    if (value === "") throw new Error(`${at} gives ${name} no value`);
    if (/^(["']).*\1$/.test(value)) throw new Error(`${at} quotes the value of ${name}. Values are taken verbatim, so remove the quotes`);
    values.set(name, value);
  });
  return { value: (name) => values.get(name), names: () => [...values.keys()] };
}

/** parseSecretsEnv, with errors that name the file at `path`. */
export function parseSecretsFile(path: string, text: string, held: readonly string[]): SecretSource {
  try {
    return parseSecretsEnv(text, held);
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`);
  }
}

/**
 * What to append to the secrets.env at `path`, holding `text`, so that it sets `name` to `value`. Refused where
 * parseSecretsEnv would refuse the file it makes or read the line back as anything else.
 */
export function appendSecret(path: string, text: string, name: string, value: string, held: readonly string[]): string {
  const line = `${text === "" || text.endsWith("\n") ? "" : "\n"}${name}=${value}\n`;
  if (/[\r\n]/.test(value) || parseSecretsFile(path, text + line, held).value(name) !== value) throw new Error(`${path}: ${name} cannot be one NAME=value line`);
  return line;
}

/**
 * The secrets.env at `path`, holding `text`, with the line that sets `name` setting it to `value` instead and every
 * other byte as it was. Refused where `text` sets no `name`, or the result would not read back so.
 */
export function replaceSecret(path: string, text: string, name: string, value: string, held: readonly string[]): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (at === -1) throw new Error(`${path} sets no ${name}`);
  lines[at] = `${name}=${value}${lines[at]!.endsWith("\r") ? "\r" : ""}`;
  const result = lines.join("\n");
  if (/[\r\n]/.test(value) || parseSecretsFile(path, result, held).value(name) !== value) throw new Error(`${path}: ${name} cannot be one NAME=value line`);
  return result;
}
