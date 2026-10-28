/** The server's ago() text for `at`: "just now" under 45 seconds, then such as "5 min ago", "3 h ago" or "2 d ago". */
export function agoText(at, now) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds < 45 ? "just now"
    : seconds < 45 * 60 ? `${Math.round(seconds / 60)} min ago`
    : seconds < 36 * 3600 ? `${Math.round(seconds / 3600)} h ago`
    : `${Math.round(seconds / 86_400)} d ago`;
}
