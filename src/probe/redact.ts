/**
 * Redacts what looks like a secret from text that leaves the node, such as a controller log's last lines. It catches the
 * values the probe holds, wherever they appear, and the shapes of common credentials. It cannot catch a value it does
 * not hold and that has no known shape, a value shorter than `minValueLength`, the words after the first of an unquoted
 * value with spaces, or a value that was encoded, split across lines or cut off at the start of the text.
 */
const minValueLength = 8;

const name = String.raw`[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*`;

/** Each pattern with its replacement, which keeps what names the value, so the reader still sees what was redacted. */
const patterns: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted]"],
  // Gondolin's placeholders for a secret in the guest: its default, a marker shared by the boot's secrets and the
  // secret's name, and the random one of its other mode.
  [/\b[0-9a-f]{48}(?=\.[a-z0-9_-]+)/g, "[redacted]"],
  [/(GONDOLIN_SECRET_)[0-9a-f]{16,}/g, "$1[redacted]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,})/g, "[redacted]"],
  [/\b(?:sk-ant-|sk-proj-|sk-|xox[abposr]-)[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)[^\s"',]+(?: [^\s"',]+)?/gi, "$1[redacted]"],
  [/\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1[redacted]"],
  // Userinfo in a URL, as git prints for a remote with a token in it.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1[redacted]@"],
  // A quoted value whole, escapes and spaces included. An unquoted one ends at a space, as a shell's would.
  [new RegExp(String.raw`\b(${name}["']?\s*[:=]\s*)(?:(["'])(?:\\.|(?!\2)[^\\\n])*\2|[^\s"',;]+)`, "gi"), "$1$2[redacted]$2"],
];

export function redact(text: string, values: readonly string[]): string {
  let out = text;
  // Longest first, so a value that contains another is replaced whole.
  for (const value of [...values].filter((v) => v.length >= minValueLength).sort((a, b) => b.length - a.length)) out = out.replaceAll(value, "[redacted]");
  for (const [pattern, replacement] of patterns) out = out.replace(pattern, replacement);
  return out;
}
