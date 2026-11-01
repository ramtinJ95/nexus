// The node page's graphs, which client.js loads when the page has them: a uPlot chart in each figure node-page.ts
// renders, drawn from the metrics API for the picked range and moved along by each poll's sample, with one crosshair
// across them all and a legend that reads the values under it.
import uPlot from "uplot";
import css from "uplot/dist/uPlot.min.css";
import { afterSwap, el } from "./page.js";
import { api } from "./request.js";
import { onThemeChange, themeValue } from "./theme.js";
import { appended, bucketed, charts, columns, gapMs, historyOf, missed, rangeMs, rangeOf, reading, regroupMs, regroups, slotter, yRange } from "./graph-data.ts";

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

const section = document.getElementById("node-graphs");
const grid = section.querySelector(".graph-grid");
const errorNote = document.getElementById("graphs-error");
const rangeKey = "nexus.node-graphs.range";
const hiddenKey = "nexus.node-graphs.hidden";
const stored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key, value) => { try { localStorage.setItem(key, value); } catch {} };

let range = rangeOf(stored(rangeKey));
const hidden = new Set((() => { try { return JSON.parse(stored(hiddenKey) ?? "[]"); } catch { return []; } })());
const slots = slotter();
/** The range's history, null until a fetch answers and after one fails, so the next poll fetches again. */
let history = null;
const plotHeight = 188;
const axisWidth = 46;
const empty = "No readings in this range. Nexus records one each time something reads this node's health, such as this page while it is open.";

/** The shown theme's chart colours, read again on each theme change. */
let ink;
const readInk = () => {
  const series = themeValue("--chart-series").split(/\s+/);
  ink = { series, text: themeValue("--text-3"), grid: themeValue("--line-soft"), ref: themeValue("--text-3"), surface: themeValue("--card"), font: `11px ${themeValue("--sans")}` };
};
readInk();
const colourOf = (look) => "ref" in look ? ink.ref : ink.series[look.slot % ink.series.length];
/** From the ninth line on a colour repeats, so the line is dashed as well. */
const dashOf = (look) => "ref" in look ? [5, 4] : look.slot >= 8 ? [8, 3] : undefined;
const translucent = (colour, alpha) => `color-mix(in srgb, ${colour} ${alpha * 100}%, transparent)`;

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n) => String(n).padStart(2, "0");
const clockOf = (d, seconds) => `${two(d.getHours())}:${two(d.getMinutes())}${seconds ? `:${two(d.getSeconds())}` : ""}`;
/** A time as the legend shows it, in the person's own zone, such as Sun 1 Nov 14:05:20. */
const timeText = (t, seconds) => {
  const d = new Date(t);
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${clockOf(d, seconds)}`;
};
/** The x-axis's ticks: the time of day, and the date where a day starts or the ticks are days apart. */
function timeTicks(u, splits, axisIdx, space, incr) {
  return splits.map((t) => {
    const d = new Date(t);
    if (incr >= 86_400_000) return `${d.getDate()} ${months[d.getMonth()]}`;
    if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return `${days[d.getDay()]} ${d.getDate()}`;
    return clockOf(d, incr < 60_000);
  });
}

/** The point of `points` nearest `x`, if one is within the gap at which its line breaks. */
function nearest(points, x, gap) {
  const { t } = points;
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  const best = [lo - 1, lo].filter((i) => i >= 0 && i < t.length).sort((a, b) => Math.abs(t[a] - x) - Math.abs(t[b] - x))[0];
  return best !== undefined && Math.abs(t[best] - x) <= gap / 2 ? best : null;
}

/** One figure's chart, built again only when its lines change, as when a pylon starts. */
function view(chart, figure) {
  const plot = figure.querySelector(".graph-plot");
  const note = figure.querySelector(".graph-empty");
  const legend = figure.querySelector(".graph-legend");
  const v = { u: null, shape: "", lines: [], banded: false, y: null };
  const id = (line) => `${chart.id}:${line.id}`;
  const at = el("time", { className: "graph-at" });
  figure.querySelector("figcaption").append(at);

  /** The uPlot series of each line: its average, then its max and min when the history is bucketed. */
  const stride = () => v.banded ? 3 : 1;
  const seriesIndex = (i) => 1 + i * stride();
  const lineOf = (s) => v.lines[Math.floor((s - 1) / stride())];

  function build() {
    v.u?.destroy();
    const series = [{}];
    const bands = [];
    v.lines.forEach((line, i) => {
      const show = !hidden.has(id(line));
      series.push({
        label: line.label, show, width: 2, spanGaps: false,
        stroke: () => colourOf(line.look), dash: dashOf(line.look),
        ...line.step ? { paths: uPlot.paths.stepped({ align: 1 }) } : {},
        points: { show: false },
      });
      if (!v.banded) return;
      series.push({ label: `${line.label} max`, show, width: 0, stroke: "transparent", points: { show: false }, spanGaps: false }, { label: `${line.label} min`, show, width: 0, stroke: "transparent", points: { show: false }, spanGaps: false });
      bands.push({ series: [seriesIndex(i) + 1, seriesIndex(i) + 2], fill: () => translucent(colourOf(line.look), "ref" in line.look ? 0.08 : 0.16) });
    });
    const axis = { stroke: () => ink.text, font: ink.font, ticks: { show: false }, grid: { stroke: () => ink.grid, width: 1 } };
    v.u = new uPlot({
      width: Math.max(plot.clientWidth, 100), height: plotHeight, ms: 1, series, bands, legend: { show: false },
      padding: [8, 16, 0, 0],
      scales: { x: { time: true, range: () => [history?.from ?? Date.now() - rangeMs(range), history?.to ?? Date.now()] }, y: { range: () => v.y ?? [0, 1] } },
      axes: [
        { ...axis, space: 70, values: timeTicks, size: 26, gap: 6 },
        { ...axis, size: axisWidth, gap: 6, space: 28, values: (u, splits) => splits.map(chart.tick) },
      ],
      cursor: {
        sync: { key: "nexus-node-graphs" },
        y: false, drag: { x: false, y: false, setScale: false },
        // A dot on each line, ringed in the surface's colour, and none on a band's edges.
        points: { size: (u, i) => (i - 1) % stride() === 0 ? 8 : 0, width: 2, fill: (u, i) => colourOf(lineOf(i).look), stroke: () => ink.surface },
        dataIdx: (u, i, closest) => {
          const ys = u.data[i];
          for (let d = 0; d < ys.length; d++) for (const j of [closest - d, closest + d]) if (ys[j] != null) return j;
          return closest;
        },
      },
      hooks: {
        setCursor: [readout],
        draw: [(u) => {
          if (chart.guide === undefined) return;
          const { ctx, bbox } = u;
          const y = Math.round(u.valToPos(chart.guide, "y", true)) + 0.5;
          ctx.save();
          ctx.strokeStyle = ink.ref;
          ctx.globalAlpha = 0.6;
          ctx.lineWidth = devicePixelRatio;
          ctx.setLineDash([2 * devicePixelRatio, 3 * devicePixelRatio]);
          ctx.beginPath();
          ctx.moveTo(bbox.left, y);
          ctx.lineTo(bbox.left + bbox.width, y);
          ctx.stroke();
          ctx.restore();
        }],
      },
    }, [[]], plot);
    legend.replaceChildren(...v.lines.map((line, i) => {
      const swatch = el("i", { className: "graph-swatch" });
      swatch.style.borderTopColor = colourOf(line.look);
      if (dashOf(line.look) !== undefined) swatch.classList.add("dashed");
      const key = el("button", { type: "button", className: "graph-key", title: `Show or hide ${line.label}` },
        swatch, el("span", { className: "graph-label", textContent: line.label }), el("span", { className: "graph-value" }));
      key.setAttribute("aria-pressed", String(!hidden.has(id(line))));
      key.addEventListener("click", () => toggle(i, key));
      return key;
    }));
  }

  function toggle(i, key) {
    const line = v.lines[i];
    const show = hidden.has(id(line));
    if (show) hidden.delete(id(line));
    else hidden.add(id(line));
    store(hiddenKey, JSON.stringify([...hidden]));
    key.setAttribute("aria-pressed", String(show));
    for (let s = seriesIndex(i); s < seriesIndex(i + 1); s++) v.u.setSeries(s, { show });
  }

  /** The legend reads each line at the crosshair, or its latest point while the pointer is elsewhere. */
  function readout() {
    if (history === null || v.u === null) return;
    const u = v.u;
    const hovering = u.cursor.left !== undefined && u.cursor.left >= 0;
    const x = hovering ? u.posToVal(u.cursor.left, "x") : Math.max(-Infinity, ...v.lines.map((l) => l.points.t.at(-1) ?? -Infinity));
    const gap = gapMs(history.bucketMs);
    const seconds = history.bucketMs < 60_000;
    at.textContent = Number.isFinite(x) ? timeText(x, seconds) : "";
    let shown = null;
    legend.querySelectorAll(".graph-value").forEach((out, i) => {
      const { points } = v.lines[i];
      const j = nearest(points, x, hovering ? gap : Infinity);
      if (j === null) return void (out.textContent = "–");
      shown ??= points.t[j];
      out.textContent = reading(chart, points.avg[j], points.min[j], points.max[j]);
    });
    if (hovering && shown !== null) at.textContent = timeText(shown, seconds);
  }

  function draw() {
    v.lines = chart.lines(history, slots);
    v.banded = bucketed(history);
    const shape = JSON.stringify([v.banded, v.lines.map((l) => [l.id, l.label, l.look])]);
    if (shape !== v.shape) {
      v.shape = shape;
      build();
    }
    v.y = yRange(chart, history, v.lines, v.y);
    const cols = columns(v.lines.map((l) => l.points), gapMs(history.bucketMs));
    v.u.setData([cols.x, ...cols.lines.flatMap((c) => v.banded ? [c.avg, c.max, c.min] : [c.avg])]);
    const why = chart.note?.(history) ?? (v.lines.every((l) => l.points.t.length === 0) ? empty : null);
    note.textContent = why ?? "";
    note.hidden = why === null;
    readout();
  }

  build();
  return {
    draw,
    reset() { v.y = null; },
    resize() { v.u.setSize({ width: Math.max(plot.clientWidth, 100), height: plotHeight }); },
    repaint() {
      v.shape = "";
      if (history !== null) draw();
      else build();
    },
  };
}

const views = [...grid.querySelectorAll("figure[data-chart]")].map((figure) => view(charts.find((c) => c.id === figure.dataset.chart), figure));
const drawAll = () => { for (const v of views) v.draw(); };

let asked = 0;
let loading = false;
let loadedAt = 0;
async function load() {
  const ask = ++asked;
  loading = true;
  loadedAt = Date.now();
  section.classList.add("graphs-loading");
  const to = Date.now();
  try {
    const metrics = await api("GET", `/v1/nodes/${encodeURIComponent(section.dataset.node)}/metrics?from=${to - rangeMs(range)}&to=${to}`);
    if (ask !== asked) return;
    history = historyOf(metrics, rangeMs(range));
    for (const v of views) v.reset();
    drawAll();
    errorNote.hidden = true;
  } catch (err) {
    if (ask !== asked) return;
    history = null;
    errorNote.textContent = `The graphs could not load: ${err.message}`;
    errorNote.hidden = false;
  } finally {
    if (ask === asked) {
      section.classList.remove("graphs-loading");
      loading = false;
    }
  }
}

const buttons = [...section.querySelectorAll("button[data-range]")];
const pick = () => { for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.range === range)); };
for (const b of buttons) {
  b.addEventListener("click", () => {
    if (b.dataset.range === range) return;
    range = rangeOf(b.dataset.range);
    store(rangeKey, range);
    pick();
    void load();
  });
}
pick();
void load();

afterSwap(() => {
  const sample = document.querySelector("#node-health [data-sample]")?.dataset.sample;
  if (loading || sample === undefined) return;
  const read = JSON.parse(sample);
  // A load that failed, or samples this page may have missed, read the range again rather than leave a hole. While
  // pylons are summed, who is summed changes as pylons start, stop and leave the range, which only the API tells.
  const stale = () => (regroups(history, read) || history.otherPylons.size > 0) && Date.now() - loadedAt >= regroupMs;
  if (history === null || missed(history, read) || stale()) void load();
  else if (appended(history, read)) drawAll();
});
onThemeChange(() => {
  readInk();
  for (const v of views) v.repaint();
});
new ResizeObserver(() => { for (const v of views) v.resize(); }).observe(grid);
