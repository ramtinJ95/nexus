/** A thread's title when none is given: its brief's first line that is not blank, cut to 80 characters with "..." after. */
export function titleOf(message: string): string {
  const line = message.split("\n").find((l) => l.trim() !== "")?.trim() ?? message;
  return line.length <= 80 ? line : `${line.slice(0, 80)}...`;
}
