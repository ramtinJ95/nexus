// The console's resizable panes: the sidebar, the inspector and, on a thread page, the pane beside the conversation.
// Each separator drags or steps with the arrow keys, and the widths the reader picked hold on every page.
const key = "nexus.panes";
const limits = { side: [180, 420], inspect: [260, 560], work: [320, 1100] };
const root = document.documentElement;
const widths = (() => {
  try { return JSON.parse(localStorage.getItem(key) ?? "{}"); } catch { return {}; }
})();

const clamp = (pane, px) => Math.round(Math.min(limits[pane][1], Math.max(limits[pane][0], px)));
function set(pane, px, save = true) {
  const width = clamp(pane, px);
  root.style.setProperty(`--${pane}-w`, `${width}px`);
  for (const sep of document.querySelectorAll(`[data-resize="${pane}"]`)) sep.setAttribute("aria-valuenow", String(width));
  if (!save) return;
  widths[pane] = width;
  localStorage.setItem(key, JSON.stringify(widths));
}
for (const [pane, px] of Object.entries(widths)) if (Object.hasOwn(limits, pane) && Number.isFinite(px)) set(pane, px, false);

/** The width a pane has now, read from the element it sizes. */
const current = (pane) => {
  const el = pane === "side" ? document.querySelector(".side") : pane === "inspect" ? document.querySelector(".inspect") : document.querySelector(".main > :is(#file-view, #term-view):not([hidden])");
  return el?.getBoundingClientRect().width ?? limits[pane][0];
};
// The sidebar grows to the right of its edge, and the inspector and the open pane to the left of theirs.
const grows = { side: 1, inspect: -1, work: -1 };

for (const sep of document.querySelectorAll("[data-resize]")) {
  const pane = sep.dataset.resize;
  sep.setAttribute("aria-valuemin", String(limits[pane][0]));
  sep.setAttribute("aria-valuemax", String(limits[pane][1]));
  sep.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    sep.setPointerCapture(event.pointerId);
    const start = event.clientX;
    const from = current(pane);
    root.dataset.resizing = "";
    const move = (e) => set(pane, from + (e.clientX - start) * grows[pane], false);
    const up = (e) => {
      set(pane, from + (e.clientX - start) * grows[pane]);
      delete root.dataset.resizing;
      sep.removeEventListener("pointermove", move);
      sep.removeEventListener("pointerup", up);
      sep.removeEventListener("pointercancel", up);
    };
    sep.addEventListener("pointermove", move);
    sep.addEventListener("pointerup", up);
    sep.addEventListener("pointercancel", up);
  });
  sep.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 64 : 16;
    const by = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
    if (by === 0) return;
    event.preventDefault();
    set(pane, current(pane) + by * grows[pane]);
  });
  // A double click gives the pane back its default width.
  sep.addEventListener("dblclick", () => {
    root.style.removeProperty(`--${pane}-w`);
    delete widths[pane];
    localStorage.setItem(key, JSON.stringify(widths));
  });
}
