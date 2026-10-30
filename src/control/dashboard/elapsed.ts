/** How the dashboard reads elapsed time. The server renders it, and client.js ticks it with the same functions. */

/** A run's length as a clock reads it, such as 1m 03s. */
// After t3code's formatElapsedSeconds. Copyright (c) 2026 T3 Tools Inc., MIT licence; see THIRD_PARTY_NOTICES.md.
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "5 min", or null under 45 seconds. */
export function span(at: number, now: number): string | null {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds < 45 ? null
    : seconds < 45 * 60 ? `${Math.round(seconds / 60)} min`
    : seconds < 36 * 3600 ? `${Math.round(seconds / 3600)} h`
    : `${Math.round(seconds / 86_400)} d`;
}

/** "5 min ago", or "just now" under 45 seconds. */
export function agoText(at: number, now: number): string {
  const label = span(at, now);
  return label === null ? "just now" : `${label} ago`;
}
