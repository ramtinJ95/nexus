// The composer's draft, kept per thread until it is sent, so a page load does not lose it. The page passes its own
// pieces and a test its fakes, with the browser globals last.
import { storageKeys } from "./contract.ts";

export function composerDraft({ kept }, { document } = globalThis) {
  const box = () => document.getElementById("prompt-text");
  const save = (prompt) => kept.write(storageKeys.draft(prompt.form.dataset.thread), prompt.value === "" ? null : prompt.value);

  /** Fills an empty composer with its thread's draft. */
  function restore() {
    const prompt = box();
    if (prompt !== null && prompt.value === "") prompt.value = kept.read(storageKeys.draft(prompt.form.dataset.thread)) ?? "";
  }
  /**
   * After a send of `text` went out, empties the composer if it still holds just that, and drops the stored draft if
   * it is that text. Text typed since the send is the next message, so it stays the draft, as does one another tab of
   * the thread wrote meanwhile. A thread archived meanwhile has no composer.
   */
  function sent(thread, text) {
    const prompt = box();
    if (prompt !== null && prompt.value !== text) return;
    if (prompt !== null) prompt.value = "";
    if (kept.read(storageKeys.draft(thread)) === text) kept.write(storageKeys.draft(thread), null);
  }
  return { restore, save, sent };
}
